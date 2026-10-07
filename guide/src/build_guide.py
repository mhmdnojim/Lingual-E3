"""Build the interactive rebuild guide and the rebuild kit.

    python guide/src/build_guide.py

Writes (in guide/):
  AEF3 Rebuild Guide.html   one self-contained file: real source code, screenshots, examples, demos
  AEF3 rebuild kit.zip      the guide + all source code (no book content; rebuild that from the disc)

The screenshots come from web/tests/capture-screenshots.mjs and the figures from make_figures.py.
"""
import base64
import glob
import io
import json
import os
import re
import zipfile

from PIL import Image

SRC = os.path.dirname(os.path.abspath(__file__))
GUIDE = os.path.dirname(SRC)
ROOT = os.path.dirname(GUIDE)
WEB = os.path.join(ROOT, 'web')
DATA = os.path.join(WEB, 'data')
OUT_HTML = os.path.join(GUIDE, 'AEF3 Rebuild Guide.html')
OUT_ZIP = os.path.join(GUIDE, 'AEF3 rebuild kit.zip')

SB_SLUG, P25 = 'BO-ff57d1a56e6bf', 'PA-74f1d4f6f1dd3'

# Code shown in the guide (path relative to the main folder, description).
CODE_FILES = [
    ('Start American English File.bat', 'Double-click launcher: checks for Python and starts the server.'),
    ('Start for phones (home Wi-Fi).bat', 'The same, but phones and tablets on the home Wi-Fi can open the app too (with a PIN).'),
    ('web/index.html', 'The app page: toolbar, page area, side panel, player bar, dialog and the SVG icon set.'),
    ('web/css/app.css', 'All styles: colour tokens, light/dark theme, page layers, highlights, panels.'),
    ('web/js/main.js', 'App controller (navigation, zoom, two-page view, click modes, panel, page grid, voice settings, keyboard) and the Reader queue.'),
    ('web/js/pageview.js', 'Draws one page: image, SVG text layer with highlight groups and word targets, hotspot buttons.'),
    ('web/js/pagetext.js', 'Text model of a page: sentence/clause/word lookup, highlight rectangles, click targets, text to speak.'),
    ('web/js/speech.js', 'Text to speech with the Web Speech API: voice ranking, settings, offline fallback.'),
    ('web/js/media.js', 'Audio player, transcript that follows the time, video dialog, answer keys with Ruffle.'),
    ('web/js/search.js', 'Full-text search over one or all books.'),
    ('web/js/editor.js', 'Text corrections: editable model, every correction, word-box matching, undo, saving.'),
    ('web/js/segment.js', 'Clause splitting in the browser (same rules as segment_text.py).'),
    ('web/js/recordings.js', 'My audio: choosing sentences, creating natural-voice MP3s, the list, the page icons, highlighting while they play.'),
    ('web/js/translation.js', 'Translation: the language menu, translations under each sentence, the popup on the page, the whole book.'),
    ('web/js/util.js', 'Helpers: element creation, saved settings, JSON loading, downloads, messages.'),
    ('web/server.py', 'Local web server (127.0.0.1): files with HTTP Range support, and the API for text corrections and My audio.'),
    ('web/auth.py', 'The password login for phones on the home Wi-Fi and for a web host (signed cookie, limit on wrong tries).'),
    ('web/login.html', 'The login page.'),
    ('web/manifest.webmanifest', 'Lets phones add the app to the home screen (name, icons, full screen).'),
    ('web/tts.py', 'My audio on the server: natural voices (edge-tts), joining sentences into one MP3 (ffmpeg), word timings, the library.'),
    ('web/translate.py', 'Translation on the server: Google Translate (free), matching the result to the sentences, saving it per page.'),
    ('web/README.md', 'Short user guide.'),
    ('web/tools/common.py', 'Shared paths and the page geometry.'),
    ('web/tools/stitch_pages.py', 'Step 1: joins the 16x16 tiles of each page into one image and a thumbnail.'),
    ('web/tools/ocr_windows.ps1', 'Step 2: Windows built-in OCR; writes words with their boxes.'),
    ('web/tools/segment_text.py', 'Step 3: groups words into blocks, sentences and clauses; writes the search files.'),
    ('web/tools/convert_videos.py', 'Step 4: converts the FLV (VP6) videos to MP4 (H.264).'),
    ('web/tools/build_data.py', 'Step 5: books.json (pages, hotspots in pixels, blank pages, resources) and transcripts.'),
    ('web/tools/build_all.ps1', 'Runs all build steps in order (and downloads Ruffle).'),
    ('web/tools/make_icons.py', 'Makes the app icons (home screen of phones, browser tab).'),
    ('web/tests/harness.mjs', 'Test setup: starts the server, finds Edge/Chrome, helpers.'),
    ('web/tests/ui-test.mjs', 'End-to-end test of every feature, at desktop and phone size, and the login (125 checks).'),
    ('web/tests/capture-screenshots.mjs', 'Takes the screenshots used in this guide.'),
    ('web/tests/package.json', 'Test dependencies (puppeteer-core).'),
    ('deploy/README.md', 'Putting the app on your own website: GitHub, a VPS, HTTPS.'),
    ('deploy/setup-server.sh', 'Sets up a new Ubuntu server: Python, Caddy (HTTPS), the code from GitHub, the password, the service.'),
    ('deploy/upload-content.ps1', 'Copies the book content and your data from this computer to the server.'),
    ('deploy/update.sh', 'On the server: the newest code from GitHub, then a restart.'),
    ('.gitignore', 'What goes into the git repository: only code (not the book content, not your data).'),
    ('guide/src/make_figures.py', 'Makes the explanatory figures of this guide.'),
    ('guide/src/build_guide.py', 'Builds this guide and the rebuild kit zip.'),
]

TREE = [
    {'name': 'Start American English File.bat', 'kind': 'code', 'path': 'Start American English File.bat', 'desc': 'double-click to start'},
    {'name': 'Start for phones (home Wi-Fi).bat', 'kind': 'code', 'path': 'Start for phones (home Wi-Fi).bat', 'desc': 'also for phones on the home Wi-Fi'},
    {'name': '.gitignore', 'kind': 'code', 'path': '.gitignore', 'desc': 'git: only code goes into the repository'},
    {'name': 'deploy', 'kind': 'dir', 'desc': 'your own website (VPS + domain)', 'children': [
        {'name': n, 'kind': 'code', 'path': f'deploy/{n}', 'desc': d} for n, d in [
            ('README.md', 'the steps'), ('setup-server.sh', 'set up the server once'),
            ('upload-content.ps1', 'copy the content and your data'), ('update.sh', 'newest code from GitHub')]]},
    {'name': '.shared', 'kind': 'orig', 'desc': 'original disc content (not changed)', 'children': [
        {'name': 'books', 'kind': 'orig', 'desc': '3 books → pages → tiles at zoom 2/3/4, thumb, index.json (hotspots)', 'children': []},
        {'name': 'assets', 'kind': 'orig', 'desc': 'audio (MP3 + XML scripts), swf (answer keys), video (FLV), document (PDF/PPT), covers', 'children': []},
        {'name': 'content', 'kind': 'orig', 'desc': 'old app UI (shell.html, OpenLayers, page.map.js) and index.json (book index)', 'children': []},
    ]},
    {'name': 'windows', 'kind': 'orig', 'desc': 'the old XULRunner program (oup.exe)', 'children': []},
    {'name': 'web', 'kind': 'dir', 'desc': 'the new browser version', 'children': [
        {'name': 'index.html', 'kind': 'code', 'path': 'web/index.html', 'desc': 'the app page'},
        {'name': 'server.py', 'kind': 'code', 'path': 'web/server.py', 'desc': 'local server with Range support and the app API'},
        {'name': 'tts.py', 'kind': 'code', 'path': 'web/tts.py', 'desc': 'natural-voice MP3s (My audio)'},
        {'name': 'translate.py', 'kind': 'code', 'path': 'web/translate.py', 'desc': 'translations (Google Translate, saved per page)'},
        {'name': 'auth.py', 'kind': 'code', 'path': 'web/auth.py', 'desc': 'password login (home Wi-Fi, web host)'},
        {'name': 'login.html', 'kind': 'code', 'path': 'web/login.html', 'desc': 'the login page'},
        {'name': 'manifest.webmanifest', 'kind': 'code', 'path': 'web/manifest.webmanifest', 'desc': 'phone home-screen app'},
        {'name': 'icons', 'kind': 'gen', 'desc': 'app icons (made by tools/make_icons.py)', 'children': []},
        {'name': 'README.md', 'kind': 'code', 'path': 'web/README.md', 'desc': 'short user guide'},
        {'name': 'css', 'kind': 'dir', 'children': [
            {'name': 'app.css', 'kind': 'code', 'path': 'web/css/app.css', 'desc': 'styles, light/dark theme'}]},
        {'name': 'js', 'kind': 'dir', 'desc': 'browser modules', 'children': [
            {'name': n, 'kind': 'code', 'path': f'web/js/{n}', 'desc': d} for n, d in [
                ('main.js', 'app controller + read-aloud queue'), ('pageview.js', 'one page: image, text layer, hotspots'),
                ('pagetext.js', 'sentences/clauses/words of a page'), ('speech.js', 'text to speech'),
                ('media.js', 'audio, transcripts, video, answer keys'), ('search.js', 'search'),
                ('editor.js', 'text corrections'), ('segment.js', 'clause rules for corrections'),
                ('recordings.js', 'My audio (natural-voice MP3s)'), ('translation.js', 'translations'), ('util.js', 'helpers')]]},
        {'name': 'tools', 'kind': 'dir', 'desc': 'build scripts (run once)', 'children': [
            {'name': n, 'kind': 'code', 'path': f'web/tools/{n}', 'desc': d} for n, d in [
                ('build_all.ps1', 'runs every step'), ('common.py', 'shared paths'), ('stitch_pages.py', 'step 1: tiles → page images'),
                ('ocr_windows.ps1', 'step 2: OCR'), ('segment_text.py', 'step 3: sentences and clauses'),
                ('convert_videos.py', 'step 4: FLV → MP4'), ('build_data.py', 'step 5: books.json + transcripts'),
                ('make_icons.py', 'app icons')]]},
        {'name': 'tests', 'kind': 'dir', 'desc': 'browser tests (Puppeteer)', 'children': [
            {'name': n, 'kind': 'code', 'path': f'web/tests/{n}', 'desc': d} for n, d in [
                ('ui-test.mjs', '125 feature checks'), ('capture-screenshots.mjs', 'guide screenshots'),
                ('harness.mjs', 'shared test setup'), ('package.json', 'dependencies')]]},
        {'name': 'data', 'kind': 'gen', 'desc': 'everything the app reads (made by the build)', 'children': [
            {'name': 'books.json', 'kind': 'gen', 'desc': 'books, pages, hotspots, resources'},
            {'name': 'pages', 'kind': 'gen', 'desc': '472 page images (WebP, 1984×2496)', 'children': []},
            {'name': 'thumbs', 'kind': 'gen', 'desc': 'page thumbnails (240 px)', 'children': []},
            {'name': 'text', 'kind': 'gen', 'desc': 'words, sentences, clauses, blocks per page', 'children': []},
            {'name': 'search', 'kind': 'gen', 'desc': 'one search file per book', 'children': []},
            {'name': 'scripts', 'kind': 'gen', 'desc': 'audio/video transcripts', 'children': []},
            {'name': 'video', 'kind': 'gen', 'desc': '38 MP4 videos', 'children': []},
        ]},
        {'name': 'recordings', 'kind': 'gen', 'desc': 'your My audio MP3s (+ timing files), never touched by the build', 'children': []},
        {'name': 'edits', 'kind': 'gen', 'desc': 'your text corrections, one file per page (never touched by the build)', 'children': []},
        {'name': 'translations', 'kind': 'gen', 'desc': 'saved translations: <language>/<book>/<page>.json (never touched by the build)', 'children': []},
        {'name': 'server-config.json', 'kind': 'gen', 'desc': 'the PIN for phones on the home Wi-Fi (made on first use)'},
        {'name': 'vendor/ruffle', 'kind': 'gen', 'desc': 'Ruffle Flash emulator (downloaded from npm)', 'children': []},
        {'name': '_build/ocr_raw', 'kind': 'gen', 'desc': 'raw OCR results (kept so step 3 can be re-run quickly)', 'children': []},
    ]},
    {'name': 'guide', 'kind': 'dir', 'desc': 'this guide', 'children': [
        {'name': 'AEF3 Rebuild Guide.html', 'kind': 'gen', 'desc': 'this file'},
        {'name': 'AEF3 rebuild kit.zip', 'kind': 'gen', 'desc': 'guide + all source code'},
        {'name': 'src', 'kind': 'dir', 'desc': 'guide sources', 'children': [
            {'name': 'build_guide.py', 'kind': 'code', 'path': 'guide/src/build_guide.py', 'desc': 'builds the guide and the zip'},
            {'name': 'make_figures.py', 'kind': 'code', 'path': 'guide/src/make_figures.py', 'desc': 'explanatory figures'},
            {'name': 'template.html, guide.css, guide.js', 'kind': 'doc', 'desc': 'guide page, styles, demos'},
            {'name': 'images', 'kind': 'doc', 'desc': 'screenshots and figures', 'children': []},
        ]},
    ]},
]


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8', errors='replace') as f:
        return f.read()


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def dir_mb(path):
    total = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(path) for f in fs)
    mb = total / 1024 / 1024
    return round(mb, 1) if mb < 10 else round(mb)


def compact(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(', ', ': '))


def make_stats(books):
    s = {'pages': 0, 'words': 0, 'sentences': 0, 'clauses': 0, 'blank': 0,
         'audio': 0, 'video_hotspots': 0, 'swf': 0, 'links': 0}
    kinds = {'audio': 'audio', 'video': 'video_hotspots', 'swf': 'swf', 'link': 'links'}
    for b in books['books']:
        for p in b['pages']:
            s['pages'] += 1
            s['blank'] += 1 if p.get('blank') else 0
            for a in p['a']:
                s[kinds[a['t']]] += 1
            doc = load(os.path.join(DATA, 'text', b['slug'], p['path'] + '.json'))
            s['words'] += len(doc['words'])
            s['sentences'] += len(doc['sent'])
            s['clauses'] += len(doc['clause'])
    s['hotspots'] = s['audio'] + s['video_hotspots'] + s['swf'] + s['links']
    s['videos'] = len(glob.glob(os.path.join(DATA, 'video', '*', '*.mp4')))
    s['scripts'] = len(glob.glob(os.path.join(DATA, 'scripts', '*.json')))
    s['mb'] = {k: dir_mb(os.path.join(DATA, k)) for k in ('pages', 'thumbs', 'text', 'search', 'scripts', 'video')}
    s['mb']['ruffle'] = dir_mb(os.path.join(WEB, 'vendor', 'ruffle'))
    return s


def make_examples(books):
    ex = {}
    # Original book index, shortened.
    idx = load(os.path.join(ROOT, '.shared', 'content', 'index.json'))
    sb = idx['books']['1705']
    first = dict(list(sb['pages'].items())[:3])
    ex['orig_index'] = {'books': {
        '1705': {'slug': sb['slug'], 'title': sb['title'], 'type': sb['type'],
                 'pages': {**first, '…': f'({len(sb["pages"])} pages in total)'}},
        '1706': '… Workbook …', '1707': "… Teacher's Book …"}}
    ex['orig_page'] = load(os.path.join(ROOT, '.shared', 'books', SB_SLUG, 'pages', P25, 'index.json'))
    ex['orig_audio_xml'] = read('.shared/assets/audio/AU-9f3c76ea280c3/AEF_SB3_CD2_Track09.xml').strip()

    raw = load(os.path.join(WEB, '_build', 'ocr_raw', f'{SB_SLUG}__{P25}.json'))
    words = ',\n'.join('        ' + compact(w) for w in raw['lines'][0]['words'])
    ex['ocr_raw'] = (f'{{\n  "w": {raw["w"]}, "h": {raw["h"]}, "angle": {raw["angle"]},\n  "lines": [\n'
                     f'    {{"words": [\n{words}\n    ]}},\n    … {len(raw["lines"]) - 1} more lines\n  ]\n}}')

    doc = load(os.path.join(DATA, 'text', SB_SLUG, P25 + '.json'))
    w = ',\n'.join('    ' + compact(x) for x in doc['words'][:6])
    ex['text'] = (f'{{\n  "words": [   // [x, y, width, height, text, line, space after]\n{w},\n    … {len(doc["words"]) - 6} more words\n  ],\n'
                  f'  "sent":   {compact(doc["sent"][:4])[:-1]}, … {len(doc["sent"]) - 4} more],\n'
                  f'  "clause": {compact(doc["clause"][:5])[:-1]}, … {len(doc["clause"]) - 5} more],\n'
                  f'  "blocks": {compact(doc["blocks"][:4])[:-1]}, … {len(doc["blocks"]) - 4} more]\n}}')

    ex['script'] = load(os.path.join(DATA, 'scripts', 'AU-9f3c76ea280c3.json'))

    b = books['books'][0]
    p25 = next(p for p in b['pages'] if p['n'] == '25')
    ex['books'] = {'page': books['page'], 'books': [
        {**{k: b[k] for k in ('id', 'slug', 'title', 'type', 'cover')}, 'pages': ['… pages 1–24 …', p25, '… pages 26–168 …']},
        "… Workbook, Teacher's Book …"], 'resources': books['resources'][:2] + ['…']}

    search = load(os.path.join(DATA, 'search', f'{SB_SLUG}.json'))
    page = next(p for p in search if p['p'] == '25')
    ex['search'] = [{'p': page['p'], 't': page['t'][:260] + ' …'}, '… one entry per page …']

    ex['hotspots'] = [{'t': 'link' if a['type'] == 'page-link' else a['type'], 'lon': float(a['lon']),
                       'lat': float(a['lat']), 'title': a.get('title', '')} for a in ex['orig_page']['page_assets']]
    return ex


def image_uris():
    uris = {}
    for path in sorted(glob.glob(os.path.join(SRC, 'images', '*.png'))):
        name = os.path.splitext(os.path.basename(path))[0]
        with Image.open(path) as im:
            im = im.convert('RGB')
            if im.width > 1500:
                im = im.resize((1500, im.height * 1500 // im.width), Image.LANCZOS)
            buf = io.BytesIO()
            im.save(buf, 'WEBP', quality=80, method=5)
        uris[name] = 'data:image/webp;base64,' + base64.b64encode(buf.getvalue()).decode('ascii')
    return uris


def build_html():
    books = load(os.path.join(DATA, 'books.json'))
    files, info = {}, {}
    for rel, desc in CODE_FILES:
        files[rel] = read(rel).replace('\r\n', '\n')
        info[rel] = {'desc': desc}
    data = {'files': files, 'info': info, 'tree': TREE, 'examples': make_examples(books), 'stats': make_stats(books)}

    html = read('guide/src/template.html')
    css = read('guide/src/guide.css')
    js = read('guide/src/guide.js').replace('</script', '<\\/script').replace('<!--', '<\\!--')
    payload = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')

    uris = image_uris()
    missing = sorted(set(re.findall(r'img:([a-z0-9-]+)', html)) - set(uris))
    if missing:
        raise SystemExit(f'missing images: {missing}')
    html = re.sub(r'img:([a-z0-9-]+)', lambda m: uris[m.group(1)], html)
    html = html.replace('<!--STYLE-->', f'<style>\n{css}\n</style>')
    html = html.replace('<!--DATA-->', f'<script>window.GUIDE = {payload};</script>')
    html = html.replace('<!--SCRIPT-->', f'<script>\n{js}\n</script>')
    with open(OUT_HTML, 'w', encoding='utf-8', newline='\n') as f:
        f.write(html)
    print(f'{os.path.basename(OUT_HTML)}: {os.path.getsize(OUT_HTML) / 1024 / 1024:.1f} MB, '
          f'{len(files)} source files, {len(uris)} images')
    return data['stats']


KIT_README = """American English File 3 - browser version: rebuild kit
=======================================================

Open "AEF3 Rebuild Guide.html" first. It explains everything, step by step.

This zip has all the source code, but NO book content. The book pages, audio,
videos and answer keys come from the original disc folder (.shared) and are
rebuilt by the scripts:

  1. Unzip this kit into the original disc folder (next to the .shared folder).
  2. Install Python 3 and Node.js.
  3. Run:  powershell -ExecutionPolicy Bypass -File web\\tools\\build_all.ps1
  4. Start: double-click "Start American English File.bat"

Contents
  AEF3 Rebuild Guide.html            the interactive guide (one file)
  Start American English File.bat    launcher
  web/                               the app, build tools and tests
  guide/src/                         sources of the guide (to rebuild it)
"""


def build_zip():
    include = ['Start American English File.bat', 'Start for phones (home Wi-Fi).bat', '.gitignore', '.gitattributes',
               'web/index.html', 'web/login.html', 'web/manifest.webmanifest', 'web/README.md', 'web/css/app.css']
    include += [p.replace(os.sep, '/') for p in glob.glob('deploy/*', root_dir=ROOT) + glob.glob('web/icons/*', root_dir=ROOT)]
    include += [p.replace(os.sep, '/') for p in
                glob.glob('web/*.py', root_dir=ROOT) + glob.glob('web/js/*.js', root_dir=ROOT) + glob.glob('web/tools/*.py', root_dir=ROOT) +
                glob.glob('web/tools/*.ps1', root_dir=ROOT) + glob.glob('web/tests/*.mjs', root_dir=ROOT) +
                ['web/tests/package.json'] +
                glob.glob('guide/src/*.*', root_dir=ROOT) + glob.glob('guide/src/images/*.png', root_dir=ROOT)]
    with zipfile.ZipFile(OUT_ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(OUT_HTML, os.path.basename(OUT_HTML))
        z.writestr('READ ME FIRST.txt', KIT_README.replace('\n', '\r\n'))
        for rel in sorted(set(include)):
            z.write(os.path.join(ROOT, rel), rel)
    print(f'{os.path.basename(OUT_ZIP)}: {os.path.getsize(OUT_ZIP) / 1024 / 1024:.1f} MB, {len(set(include)) + 2} files')


if __name__ == '__main__':
    build_html()
    build_zip()
