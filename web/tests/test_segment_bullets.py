"""Bullet lists (tools/segment_text.py): every item a paragraph and sentence of its own, also when OCR
did not read its bullet (found on the page picture); the list ends at a line back at the margin.

The page is made up here, like the Teacher's Book page "Detailed lesson plans … including:".
"""
from pathlib import Path
import sys
import unittest

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import segment_text as S


def line(x, y, text, bullet=False):
    words, out = text.split(), []
    for t in words:
        out.append({'t': t, 'x': x, 'y': y, 'w': 14 * len(t), 'h': 30})
        x += 14 * len(t) + 9
    return {'words': ([{'t': '•', 'x': out[0]['x'] - 23, 'y': y + 9, 'w': 12, 'h': 12}] if bullet else []) + out}


# Bullets at x 250, the items' text at 273, the paragraphs at 238.
LINES = [
    line(239, 250, 'Detailed lesson plans for all the lessons including:'),
    line(273, 292, 'an optional books-closed lead-in for every lesson', bullet=True),
    line(273, 331, 'Extra idea suggestions for optional extra activities'),  # OCR missed its bullet
    line(273, 369, 'Extra challenge suggestions for exploiting the material in a', bullet=True),
    line(273, 403, 'more challenging way if you have a stronger class'),
    line(238, 445, 'Extra activities appear in red type so you can see at a glance'),
    line(239, 480, 'what is core material and what is extra.'),
]


def page(dots=()):
    img = Image.new('RGB', (1200, 600), 'white')
    draw = ImageDraw.Draw(img)
    for y in dots:  # a bullet: a round dot in the middle of the line
        draw.ellipse((251, y + 9, 262, y + 20), fill='black')
    return img


def paragraphs(doc):
    return [[S.unit_text(doc['words'], *doc['sent'][k]) for k in range(a, b)] for a, b in doc['blocks']]


class BulletTests(unittest.TestCase):
    def test_every_item_on_its_own(self):
        doc = S.segment({'lines': LINES}, image=page(dots=(292, 331, 369)))
        self.assertEqual(paragraphs(doc), [
            ['Detailed lesson plans for all the lessons including:'],
            ['an optional books-closed lead-in for every lesson'],
            ['Extra idea suggestions for optional extra activities'],
            ['Extra challenge suggestions for exploiting the material in a more challenging way if you have a stronger class'],
            ['Extra activities appear in red type so you can see at a glance what is core material and what is extra.'],
        ])
        self.assertNotIn('•', [w[4] for w in doc['words']])

    def test_without_the_picture_only_the_bullets_ocr_read(self):
        doc = S.segment({'lines': LINES})
        self.assertEqual(paragraphs(doc)[1], ['an optional books-closed lead-in for every lesson '
                                              'Extra idea suggestions for optional extra activities'])

    def test_a_letter_is_not_a_bullet(self):
        img = page(dots=(292, 369))
        ImageDraw.Draw(img).text((250, 334), 'a', fill='black', font_size=26)  # an exercise letter, not a dot
        doc = S.segment({'lines': LINES}, image=img)
        self.assertEqual(len(paragraphs(doc)), 4)

    def test_pdf_words(self):
        # Text from a PDF keeps its words as they are, but a bullet is not a word.
        doc = S.segment({'lines': LINES[:2]}, ocr=False)
        self.assertEqual(paragraphs(doc), [['Detailed lesson plans for all the lessons including:'],
                                           ['an optional books-closed lead-in for every lesson']])


if __name__ == '__main__':
    unittest.main()
