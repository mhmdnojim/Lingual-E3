"""Tesseract uses the accurate models (web/vendor/tessdata_best) only when every language of the code is there."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ocr  # noqa: E402


class BestModels(unittest.TestCase):
    def test_only_when_all_languages_are_there(self):
        with tempfile.TemporaryDirectory() as d, mock.patch.object(ocr, 'BEST', d):
            self.assertEqual(ocr._best_args('chi_sim+eng'), [])
            (Path(d) / 'chi_sim.traineddata').write_bytes(b'x')
            self.assertEqual(ocr._best_args('chi_sim+eng'), [], 'eng is missing')
            (Path(d) / 'eng.traineddata').write_bytes(b'x')
            self.assertEqual(ocr._best_args('chi_sim+eng'), ['--tessdata-dir', d, '--oem', '1'])
            self.assertEqual(ocr._best_args('chi_sim+fra'), [])


if __name__ == '__main__':
    unittest.main()
