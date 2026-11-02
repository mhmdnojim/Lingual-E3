"""The pinyin of Chinese sentences broken down (web/pinyin.py): one per character, by the words around it.

Run: python -m unittest web/tests/test_pinyin.py
"""
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pinyin  # noqa: E402


@unittest.skipIf(pinyin.pypinyin is None, 'pypinyin is not installed (python -m pip install -r web/requirements.txt)')
class PinyinTests(unittest.TestCase):
    def test_every_character_has_its_pinyin_and_others_none(self):
        self.assertEqual(pinyin.of_texts(['我每天六点起床。'])[0], ['wǒ', 'měi', 'tiān', 'liù', 'diǎn', 'qǐ', 'chuáng', ''])
        self.assertEqual(pinyin.of_texts(['HSK 2 你好'])[0], ['', '', '', '', '', '', 'nǐ', 'hǎo'])

    def test_a_character_with_several_readings_is_read_by_its_word(self):
        self.assertEqual(pinyin.of_texts(['银行'])[0][1], 'háng')
        self.assertEqual(pinyin.of_texts(['行李'])[0][0], 'xíng')
        self.assertEqual(pinyin.of_texts(['他长大了'])[0][1], 'zhǎng')
        self.assertEqual(pinyin.of_texts(['睡觉', '觉得']), [['shuì', 'jiào'], ['jué', 'de']])

    def test_as_textbooks_write_it(self):
        self.assertEqual(pinyin.of_texts(['不是一个'])[0], ['bú', 'shì', 'yí', 'gè'])
        self.assertEqual(pinyin.of_texts(['你在哪儿？'])[0][2:4], ['nǎ', 'r'])
        self.assertEqual(pinyin.of_texts(['女儿'])[0], ['nǚ', 'ér'])

    def test_bad_requests(self):
        for bad in (None, 'text', [1], ['字' * 6000]):
            with self.assertRaises(ValueError):
                pinyin.of_texts(bad)


class WithoutThePackageTests(unittest.TestCase):
    def test_it_says_how_to_install_it(self):
        with mock.patch.object(pinyin, 'pypinyin', None):
            with self.assertRaises(pinyin.Missing) as e:
                pinyin.of_texts(['你好'])
        self.assertIn('requirements.txt', str(e.exception))


if __name__ == '__main__':
    unittest.main()
