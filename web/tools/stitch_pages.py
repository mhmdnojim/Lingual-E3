"""Stitch each page's zoom-4 tiles into one image.

Tiles follow the TMS layout the original viewer used: <zoom>/<column>/<row>.png
with row 0 at the BOTTOM of the page.

Writes web/data/pages/<book>/<page>.webp for display, a small
web/data/thumbs/<book>/<page>.webp for the page grid and, with --ocr-dir,
a lossless PNG copy for the OCR step.
"""
import argparse
import os
import sys

from PIL import Image

from common import DATA, MAX_ZOOM, PAGE_H, PAGE_W, SHARED, TILE_H, TILE_W, load_json, page_dir

THUMB_W = 240


def stitch(book_slug, page_path):
    n = 2 ** MAX_ZOOM
    page = Image.new('RGB', (PAGE_W, PAGE_H), 'white')
    base = os.path.join(page_dir(book_slug, page_path), str(MAX_ZOOM))
    for col in range(n):
        for row in range(n):
            tile = os.path.join(base, str(col), f'{row}.png')
            if os.path.exists(tile):
                with Image.open(tile) as im:
                    # Some tiles are transparent (text on no background): flatten onto white.
                    im = im.convert('RGBA')
                    page.paste(im, (col * TILE_W, (n - 1 - row) * TILE_H), im)
    return page


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--ocr-dir', help='also write lossless PNGs here for OCR')
    ap.add_argument('--raw-dir', help='OCR output folder: pages already recognised there need no PNG')
    ap.add_argument('--only', help='book_slug/page_path to process a single page')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args()

    index = load_json(os.path.join(SHARED, 'content', 'index.json'))
    jobs = []
    for book in index['books'].values():
        for p in book['pages'].values():
            jobs.append((book['slug'], p['page_path']))
    if args.only:
        jobs = [tuple(args.only.split('/'))]

    done = 0
    for slug, path in jobs:
        out = os.path.join(DATA, 'pages', slug, f'{path}.webp')
        png = os.path.join(args.ocr_dir, f'{slug}__{path}.png') if args.ocr_dir else None
        if png and args.raw_dir and os.path.exists(os.path.join(args.raw_dir, f'{slug}__{path}.json')):
            png = None  # already recognised
        if not args.force and os.path.exists(out) and (not png or os.path.exists(png)):
            continue
        img = stitch(slug, path)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        img.save(out, 'WEBP', quality=88, method=4)
        thumb = os.path.join(DATA, 'thumbs', slug, f'{path}.webp')
        os.makedirs(os.path.dirname(thumb), exist_ok=True)
        img.resize((THUMB_W, THUMB_W * PAGE_H // PAGE_W), Image.LANCZOS).save(thumb, 'WEBP', quality=80)
        if png:
            os.makedirs(args.ocr_dir, exist_ok=True)
            img.save(png, 'PNG', compress_level=1)
        done += 1
        if done % 25 == 0:
            print(f'  stitched {done} pages', flush=True)
    print(f'stitched {done} pages ({len(jobs)} total)')


if __name__ == '__main__':
    sys.exit(main())
