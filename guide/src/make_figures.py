"""Make the explanatory figures for the rebuild guide (Student Book page 25).

Writes guide/src/images/fig-*.png. Needs the built web/data and web/_build/ocr_raw.
"""
import json
import os
import sys

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'web', 'tools'))
from common import DATA, MAX_ZOOM, PAGE_H, PAGE_W, TILE_H, TILE_W, page_dir  # noqa: E402
from stitch_pages import stitch  # noqa: E402

OUT = os.path.join(HERE, 'images')
SLUG, PAGE = 'BO-ff57d1a56e6bf', 'PA-74f1d4f6f1dd3'  # Student Book page 25


def naive_stitch():
    """The first (buggy) version: transparent tiles were pasted without their alpha mask."""
    n = 2 ** MAX_ZOOM
    page = Image.new('RGB', (PAGE_W, PAGE_H), 'white')
    base = os.path.join(page_dir(SLUG, PAGE), str(MAX_ZOOM))
    for col in range(n):
        for row in range(n):
            with Image.open(os.path.join(base, str(col), f'{row}.png')) as im:
                page.paste(im.convert('RGB'), (col * TILE_W, (n - 1 - row) * TILE_H))
    return page


def fig_stitch():
    w, band, gap = 700, 64, 30
    h = w * PAGE_H // PAGE_W
    out = Image.new('RGB', (w * 2 + gap, h + band), 'white')
    d = ImageDraw.Draw(out)
    for i, (img, text) in enumerate([(naive_stitch(), 'Before: transparent tiles turned black'),
                                     (stitch(SLUG, PAGE), 'After: tiles flattened onto white')]):
        x = i * (w + gap)
        d.rectangle([x, 0, x + w, band], fill=(28, 31, 37))
        d.text((x + 24, 16), text, fill='white', font_size=30)
        out.paste(img.resize((w, h), Image.LANCZOS), (x, band))
    out.save(os.path.join(OUT, 'fig-stitch-fix.png'))


def fig_ocr_and_hotspots(page):
    raw = json.load(open(os.path.join(ROOT, 'web', '_build', 'ocr_raw', f'{SLUG}__{PAGE}.json'), encoding='utf-8'))
    img = page.copy()
    d = ImageDraw.Draw(img)
    for ln in raw['lines']:
        for w in ln['words']:
            d.rectangle([w['x'], w['y'], w['x'] + w['w'], w['y'] + w['h']], outline=(37, 99, 235), width=3)
    idx = json.load(open(os.path.join(page_dir(SLUG, PAGE), 'index.json'), encoding='utf-8'))
    for a in idx['page_assets']:
        x, y = float(a['lon']), PAGE_H - float(a['lat'])
        d.ellipse([x - 28, y - 28, x + 28, y + 28], outline=(196, 18, 47), width=8)
    img.resize((992, 1248), Image.LANCZOS).save(os.path.join(OUT, 'fig-ocr-hotspots.png'))


def fig_segmentation(page):
    doc = json.load(open(os.path.join(DATA, 'text', SLUG, f'{PAGE}.json'), encoding='utf-8'))
    words = doc['words']
    overlay = Image.new('RGBA', page.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    colors = [(255, 196, 0, 110), (56, 189, 248, 110)]

    def line_boxes(a, b, pad=6):
        boxes = {}
        for w in words[a:b]:
            x0, y0, x1, y1 = w[0], w[1], w[0] + w[2], w[1] + w[3]
            bx = boxes.get(w[5])
            boxes[w[5]] = [x0, y0, x1, y1] if not bx else [min(bx[0], x0), min(bx[1], y0), max(bx[2], x1), max(bx[3], y1)]
        return [[b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad] for b in boxes.values()]

    for i, (a, b) in enumerate(doc['sent']):
        for box in line_boxes(a, b):
            d.rectangle(box, fill=colors[i % 2])
    for a, b in doc['clause']:
        for box in line_boxes(a, b, 2):
            d.rectangle(box, outline=(196, 18, 47, 255), width=3)
    for sa, sb in doc['blocks']:
        a, b = doc['sent'][sa][0], doc['sent'][sb - 1][1]
        xs = [w[0] for w in words[a:b]] + [w[0] + w[2] for w in words[a:b]]
        ys = [w[1] for w in words[a:b]] + [w[1] + w[3] for w in words[a:b]]
        d.rectangle([min(xs) - 14, min(ys) - 14, max(xs) + 14, max(ys) + 14], outline=(90, 90, 100, 255), width=3)
    out = Image.alpha_composite(page.convert('RGBA'), overlay).convert('RGB')
    out.resize((992, 1248), Image.LANCZOS).save(os.path.join(OUT, 'fig-segmentation.png'))


def main():
    os.makedirs(OUT, exist_ok=True)
    page = stitch(SLUG, PAGE)
    fig_stitch()
    fig_ocr_and_hotspots(page)
    fig_segmentation(page)
    page.resize((600, 600 * PAGE_H // PAGE_W), Image.LANCZOS).save(os.path.join(OUT, 'fig-page25-small.png'))
    print('figures written to', OUT)


if __name__ == '__main__':
    main()
