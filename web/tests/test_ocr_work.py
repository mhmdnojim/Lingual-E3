"""Windows OCR's work folder (web/ocr.py): only the pictures of this reading are in it. The script
reads every picture in the folder; the pages of a book read before, left there, made each area
read again (Re-read text by area) take a minute and a half (168 pages read each time).

Run: python -m unittest web/tests/test_ocr_work.py
"""
from pathlib import Path
import json
import os
import sys
import tempfile
import unittest
from unittest import mock

WEB = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WEB))
import ocr  # noqa: E402


class WorkFolderTest(unittest.TestCase):
    def test_only_this_reading(self):
        with tempfile.TemporaryDirectory() as data:
            work = os.path.join(data, 'ocr-work')
            for sub in ('in', 'out'):
                os.makedirs(os.path.join(work, sub))
                for i in range(5):  # (a book read before)
                    Path(work, sub, f'{i:04d}.{"png" if sub == "in" else "json"}').write_bytes(b'old')
            png = os.path.join(data, 'area.png')
            Path(png).write_bytes(b'new')
            seen = []

            def script(args, **kw):
                src, out = args[args.index('-InputDir') + 1], args[args.index('-OutputDir') + 1]
                seen.append(sorted(os.listdir(src)))
                for name in os.listdir(src):
                    Path(out, name.replace('.png', '.json')).write_text(json.dumps({'w': 1, 'h': 1, 'lines': []}))
                return mock.Mock(returncode=0)
            with mock.patch.object(ocr.db, 'DATA', data), mock.patch.object(ocr.subprocess, 'run', script):
                pages = ocr._windows([png])
            self.assertEqual(seen, [['0000.png']])
            self.assertEqual(Path(work, 'in', '0000.png').read_bytes(), b'new')
            self.assertEqual(len(pages), 1)
            self.assertEqual(sorted(os.listdir(os.path.join(work, 'out'))), ['0000.json'])


if __name__ == '__main__':
    unittest.main()
