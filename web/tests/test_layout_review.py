"""Independent source-page layouts and conservative column/drop-cap normalization."""
from pathlib import Path
import copy
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import designs
import library


def line(text, x, y, h=20):
    words = []
    for token in text.split():
        words.append({'t': token, 'x': x, 'y': y, 'w': len(token) * 9, 'h': h})
        x += len(token) * 9 + 8
    return {'words': words}


class PageLayoutTest(unittest.TestCase):
    def test_independent_pages_do_not_require_one_template_per_page(self):
        areas = {'x': .05, 'y': .05, 'w': .4, 'h': .8, 'kind': 'paragraph'}
        overrides = designs.clean_page_areas({str(i): [areas] for i in range(1, 170)}, list(range(1, 170)))
        overrides['14'] = []
        plan = designs.plan({'checked': True, 'designs': [{'pages': [1, 2], 'areas': [areas]}], 'pageAreas': overrides})
        self.assertEqual(len(plan), 169)
        self.assertEqual(plan[14], [])
        self.assertTrue(plan[1][0]['strict'])
        self.assertEqual(plan[2][0]['kind'], 'paragraph')
        with self.assertRaises(ValueError):
            designs.clean_page_areas({'170': [areas]}, [1, 2])

    def test_deleted_paragraph_is_not_added_to_its_neighbour(self):
        raw = {'w': 1000, 'h': 1000, 'lines': [line('Keep this paragraph.', 50, 100), line('Excluded paragraph.', 600, 100)]}
        area = {'x': 0, 'y': 0, 'w': .45, 'h': 1, 'kind': 'paragraph', 'strict': True}
        options = library._clean_options({'language': 'en'})
        doc, _ = library._doc_in_areas(raw, options, None, False, [area])
        self.assertEqual(library.page_text(doc), 'Keep this paragraph.')
        empty, _ = library._doc_in_areas(raw, options, None, False, [])
        self.assertEqual(empty['words'], [])
        self.assertEqual(empty['sent'], [])

    def test_heading_and_exercise_rows_have_explicit_reading_units(self):
        raw = {'w': 1000, 'h': 1000, 'lines': [line('OMG! Where is my passport?', 50, 100)]}
        options = library._clean_options({'language': 'en'})
        doc, _ = library._doc(raw, options, kind='heading')
        self.assertEqual(len(doc['sent']), 1)
        raw['lines'] = [line('take', 50, 100), line('give', 50, 130), line('say', 50, 160)]
        doc, _ = library._doc(raw, options, kind='rows')
        self.assertEqual(len(doc['sent']), 3)

    def test_repeated_column_gap_is_split_before_sentence_grouping(self):
        lines = []
        for i in range(5):
            left, right = line(f'Left sentence {i}.', 50, 80 + i * 40), line(f'Right sentence {i}.', 600, 80 + i * 40)
            lines.append({'words': left['words'] + right['words']})
        raw = {'w': 1000, 'h': 1000, 'lines': lines}
        before = copy.deepcopy(raw)
        result = designs.layout_lines(raw)
        self.assertEqual(raw, before, 'raw OCR is preserved for later review')
        self.assertEqual(len(result['lines']), 10)
        texts = [' '.join(w['t'] for w in ln['words']) for ln in result['lines']]
        self.assertTrue(all(t.startswith('Left') for t in texts[:5]))
        self.assertTrue(all(t.startswith('Right') for t in texts[5:]))
        self.assertEqual(sum(len(l['words']) for l in raw['lines']), sum(len(l['words']) for l in result['lines']))

    def test_large_initial_is_part_of_first_word(self):
        raw = {'w': 1000, 'h': 1000, 'lines': [line('I', 50, 100, 64), line('n 1972, I lived here.', 70, 100), line('A normal next line.', 70, 130)]}
        result = designs.layout_lines(raw)
        self.assertEqual(result['lines'][0]['words'][0]['t'], 'In')
        self.assertFalse(any(len(l['words']) == 1 and l['words'][0]['t'] == 'I' for l in result['lines']))

    def test_ocr_number_column_is_not_a_sentence(self):
        labels = {'words': [line(str(i + 1), 30, 100 + i * 40)['words'][0] for i in range(4)]}
        raw = {'w': 1000, 'h': 1000, 'lines': [labels, line('This is room 613.', 90, 100), line('In 1972, we moved.', 90, 180)]}
        prepared = designs.layout_lines(raw)
        doc, _ = library._doc(prepared, library._clean_options({'language': 'en'}))
        text = library.page_text(doc)
        self.assertNotIn('1 2 3 4', text)
        self.assertIn('room 613', text)
        self.assertIn('1972', text)


if __name__ == '__main__':
    unittest.main()
