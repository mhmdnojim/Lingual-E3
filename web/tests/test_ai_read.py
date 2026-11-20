"""An area read again when the OCR finds nothing: the crop is made bigger and clearer; the AI reads the printed text of
a picture (the answer is a list of lines; errors are told plainly, never with the key)."""
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import layout_ai
import library
from PIL import Image


class Reply:
    def __init__(self, data):
        self.data = json.dumps(data).encode('utf-8')

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def read(self, n=-1):
        return self.data


def answer(lines):
    return {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps({'lines': lines})}]}]}


class AiRead(unittest.TestCase):
    def test_enlarged_crop(self):
        img = Image.new('RGB', (110, 50), (200, 200, 200))
        big, scale, pad = library.enlarged(img)
        self.assertGreaterEqual(scale, 2)
        self.assertLessEqual(scale, 4)
        self.assertEqual(big.size, (round(110 * scale) + 2 * pad, round(50 * scale) + 2 * pad))
        # a word at (x, y) of the big picture is at ((x - pad) / scale) of the crop
        self.assertAlmostEqual((pad + 20 * scale - pad) / scale, 20)

    def test_lines_come_back_cleaned(self):
        with mock.patch('urllib.request.urlopen', return_value=Reply(answer(['C.  大', '', 'D. 办法']))) as call:
            lines = layout_ai.read_text(b'png', 'sk-test', 'gpt-4.1', 'Chinese (Simplified)')
        self.assertEqual(lines, ['C. 大', 'D. 办法'])
        sent = json.loads(call.call_args[0][0].data)
        self.assertIn('Chinese (Simplified)', sent['instructions'])
        self.assertEqual(sent['input'][0]['content'][1]['type'], 'input_image')

    def test_errors_do_not_show_the_key(self):
        err = urllib.error.HTTPError('u', 401, 'bad', {}, io.BytesIO(b'Incorrect API key provided: sk-secret'))
        with mock.patch('urllib.request.urlopen', side_effect=err):
            with self.assertRaises(layout_ai.LayoutError) as caught:
                layout_ai.read_text(b'png', 'sk-secret', 'gpt-4.1')
        self.assertNotIn('sk-secret', str(caught.exception))
        self.assertIn('Admin', str(caught.exception))
        with self.assertRaises(layout_ai.LayoutError):
            layout_ai.read_text(b'png', '', 'gpt-4.1')
        with self.assertRaises(layout_ai.LayoutError):
            layout_ai.read_text(b'png', 'sk-x', 'bad model!')


if __name__ == '__main__':
    unittest.main()
