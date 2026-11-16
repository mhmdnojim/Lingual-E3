"""translate.translate_text: a free text, line by line, through the engines (here a stand-in)."""
import os, sys, unittest
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
import translate


class TranslateText(unittest.TestCase):
    def setUp(self):
        self.calls = []
        def engine(lang, paragraphs, src='en'):
            self.calls.append((lang, src, paragraphs))
            return {s: f'[{lang}] {s}' for p in paragraphs for s in p}
        self.saved = translate.ENGINES
        translate.ENGINES = (('chrome', engine),)

    def tearDown(self):
        translate.ENGINES = self.saved

    def test_lines_keep_their_places(self):
        out = translate.translate_text('Hello\n\nHow are you?', 'ar', 'en')
        self.assertEqual(out, '[ar] Hello\n\n[ar] How are you?')
        self.assertEqual(self.calls[0][:2], ('ar', 'en'))

    def test_same_language_is_returned(self):
        self.assertEqual(translate.translate_text('  Hi  there ', 'en', 'en'), 'Hi there')
        self.assertEqual(self.calls, [])

    def test_bad_input(self):
        for args in (('', 'ar', 'en'), ('x' * 2001, 'ar', 'en'), ('hi', 'xx', 'en'), ('hi', 'ar', 'xx')):
            with self.assertRaises(ValueError):
                translate.translate_text(*args)


if __name__ == '__main__':
    unittest.main()
