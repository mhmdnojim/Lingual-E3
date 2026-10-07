"""Shared paths and helpers for the build scripts."""
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SHARED = os.path.join(ROOT, '.shared')
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(WEB, 'data')

# Page geometry used by the original OpenLayers viewer (page.map.js).
TILE_W, TILE_H = 124, 156
PAGE_W, PAGE_H = 1984, 2496
MAX_ZOOM = 4  # 16 x 16 tiles


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def save_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))


def page_dir(book_slug, page_path):
    return os.path.join(SHARED, 'books', book_slug, 'pages', page_path)
