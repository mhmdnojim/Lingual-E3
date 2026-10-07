"""Build web/data/books.json and the audio/video transcripts from the original app data.

Hotspot coordinates are converted from the old OpenLayers map units
(lon = x from the left, lat = y from the BOTTOM) to image pixels (y from the top).
"""
import glob
import html
import os
import re
import sys

from common import DATA, PAGE_H, PAGE_W, SHARED, load_json, page_dir, save_json

CUE = re.compile(r'<Cue([^>]*)>(.*?)</Cue>', re.S)
VALUE = re.compile(r'value\s*=\s*[\'"](\d+)[\'"]')


def shared_url(path):
    return '/.shared/' + path.replace('\\', '/').lstrip('/')


def resource_to_path(link):
    """resource://audio/AU-x/f.mp3 -> assets/audio/AU-x/f.mp3"""
    return 'assets/' + link[len('resource://'):] if link.startswith('resource://') else link


def parse_script(xml_path):
    """Timed transcript -> [{"t": ms, "x": text}], or None if empty."""
    with open(xml_path, encoding='utf-8', errors='replace') as f:
        src = f.read()
    cues = []
    for attrs, body in CUE.findall(src):
        text = re.sub(r'<!\[CDATA\[(.*?)\]\]>', r'\1', body, flags=re.S)
        text = html.unescape(re.sub(r'<[^>]+>', '', text)).strip()
        if text == 'line_return':
            continue
        m = VALUE.search(attrs)
        if m:
            cues.append({'t': int(m.group(1)), 'x': text})
        elif cues and text:
            cues[-1]['x'] = (cues[-1]['x'] + ' ' + text).strip()
    cues = [c for c in cues if c['x'] and c['x'].lower() != 'audioscript']
    return cues or None


def build_script(link, kind):
    """Parse a transcript once; return its URL under /web/data/scripts or None."""
    if not link or not link.endswith('.xml'):
        return None
    xml = os.path.join(SHARED, resource_to_path(link))
    if not os.path.exists(xml):
        return None
    cues = parse_script(xml)
    if not cues:
        return None
    asset_id = os.path.basename(os.path.dirname(xml))
    save_json(os.path.join(DATA, 'scripts', f'{asset_id}.json'), cues)
    return f'/web/data/scripts/{asset_id}.json'


def convert_asset(a):
    kind = a.get('type')
    x = round(float(a['lon']))
    y = round(PAGE_H - float(a['lat']))
    out = {'t': kind, 'x': x, 'y': y, 'title': a.get('title', '')}
    if kind == 'audio':
        out['src'] = shared_url(resource_to_path(a['link']))
        out['script'] = build_script(a.get('script'), kind)
    elif kind == 'video':
        rel = a['link'].replace('\\', '/')  # assets/video/VI-x/name.flv
        vid, name = rel.split('/')[-2], os.path.splitext(rel.split('/')[-1])[0]
        out['src'] = f'/web/data/video/{vid}/{name}.mp4'
        out['script'] = build_script(a.get('script'), kind)
    elif kind == 'swf':
        out['src'] = shared_url(resource_to_path(a['link']))
        out['w'], out['h'] = a.get('width'), a.get('height')
        out['title'] = re.sub(r'^View AK_', 'Answer key ', out['title'])
    elif kind == 'page-link':
        out['t'] = 'link'
        out['page'], out['book'] = str(a['link'][0]), str(a['link'][1])
    else:
        return None
    return out


def is_blank(book_slug, page_path):
    """Some Teacher's Book pages are not on the disc: their tiles are plain white (~270 bytes each)."""
    tiles = os.path.join(page_dir(book_slug, page_path), '4')
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(tiles) for f in fs)
    return total < 100_000


def build_resources():
    files = sorted(glob.glob(os.path.join(SHARED, 'assets', 'document', '*', '*')))
    res = []
    for f in files:
        name, ext = os.path.splitext(os.path.basename(f))
        res.append({'title': name.replace('AEF2e_3_', '').replace('_', ' '),
                    'kind': ext.lstrip('.').lower(),
                    'src': shared_url(os.path.relpath(f, SHARED))})
    res.sort(key=lambda r: [int(s) if s.isdigit() else s.lower() for s in re.split(r'(\d+)', r['title'])])
    help_pdf = os.path.join(SHARED, 'assets', 'misc', 'help.pdf')
    if os.path.exists(help_pdf):
        res.append({'title': 'Original app help', 'kind': 'pdf', 'src': '/.shared/assets/misc/help.pdf'})
    return res


def main():
    index = load_json(os.path.join(SHARED, 'content', 'index.json'))
    order = {'Student Book': 0, 'Workbook': 1, "Teacher's Book": 2}
    books = []
    n_assets = 0
    for book_id, book in index['books'].items():
        pages = []
        for key, p in sorted(book['pages'].items(), key=lambda kv: (int(kv[0]) if kv[0].isdigit() else 10**6, kv[1]['id'])):
            idx_path = os.path.join(page_dir(book['slug'], p['page_path']), 'index.json')
            assets = []
            if os.path.exists(idx_path):
                for a in load_json(idx_path).get('page_assets', []):
                    c = convert_asset(a)
                    if c:
                        assets.append(c)
            n_assets += len(assets)
            has_text = os.path.exists(os.path.join(DATA, 'text', book['slug'], p['page_path'] + '.json'))
            entry = {'n': key, 'path': p['page_path'], 'a': assets, 'txt': has_text}
            if not assets and is_blank(book['slug'], p['page_path']):
                entry['blank'] = True
            pages.append(entry)
        books.append({
            'id': book_id, 'slug': book['slug'], 'title': book['title'], 'type': book['type'],
            'cover': f"/.shared/assets/covers/{book['slug']}/cover.png", 'pages': pages,
        })
    books.sort(key=lambda b: order.get(b['type'], 9))
    save_json(os.path.join(DATA, 'books.json'), {
        'page': {'w': PAGE_W, 'h': PAGE_H}, 'books': books, 'resources': build_resources(),
    })
    print(f"books.json: {len(books)} books, {sum(len(b['pages']) for b in books)} pages, {n_assets} hotspots")


if __name__ == '__main__':
    sys.exit(main())
