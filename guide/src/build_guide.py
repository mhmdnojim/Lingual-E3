"""Build the interactive rebuild guide and the rebuild kit.

    python guide/src/build_guide.py

Writes (in guide/):
  AEF3 Rebuild Guide.html          one self-contained file: real source code, screenshots, examples, demos
  AEF3 rebuild kit.zip             the guide + all source code (no book content; rebuild that from the disc)
  Lingua Books React kit.zip       for rebuilding the browser app in React (Lovable or another AI): the
                                   brief, the current code, screenshots and a sample book
  Lingua Books React brief.md      the brief alone (guide/src/react-brief.md), to paste

The screenshots come from web/tests/capture-screenshots.mjs, the figures from make_figures.py and the
sample book from make_fixtures.py.
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
OUT_REACT_ZIP = os.path.join(GUIDE, 'Lingua Books React kit.zip')
OUT_BRIEF = os.path.join(GUIDE, 'Lingua Books React brief.md')
FIXTURES = os.path.join(SRC, 'fixtures')

SB_SLUG, P25 = 'BO-ff57d1a56e6bf', 'PA-74f1d4f6f1dd3'

# Code shown in the guide (path relative to the main folder, description).
CODE_FILES = [
    ('README.md', 'Lingua Books in short (the front page of the GitHub repository).'),
    ('Start Lingua Books.bat', 'Double-click launcher: checks for Python, installs the tools once, starts the server.'),
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
    ('web/js/follow.js', 'Following the reading: the sentence being read stays in view, unless the person scrolls away.'),
    ('web/js/device.js', 'Phone, tablet or computer: found by itself or chosen (Settings → Screen), set on the page before it is drawn; what older browsers lack; a message for a browser too old.'),
    ('web/js/library.js', 'The library (home screen): its branches (a tree on the left, folders and files on the right: rename, cut, copy, paste, drag and drop), books, adding a book, settings and sharing, reports, accounts, the admin page.'),
    ('web/js/words.js', 'New words: collecting words, clauses and sentences in categories, the marks on the page, the flashcards.'),
    ('web/js/transcription.js', 'The Transcribe button of a recording without a script (speech recognition on the server).'),
    ('web/js/offline-audio.js', 'The browser store (IndexedDB) of the offline voice files.'),
    ('web/js/voice-options.js', 'Windows voices and online Natural voices kept apart; the server voice that matches a browser voice.'),
    ('web/js/migration.js', 'Guided old-app import: ZIP/folder uploads, numbered progress, sample approval and results.'),
    ('web/migration.py', 'Safe content adapters, private resumable import jobs, tile stitching, PDF/OCR and export.'),
    ('web/tests/test_migration.py', 'Isolated migration tests: supported formats, security, sample review and resume.'),
    ('web/tests/migration-test.mjs', 'Browser migration smoke test: upload, preview, convert, export and reader.'),
    ('web/js/util.js', 'Helpers: element creation, saved settings, JSON loading, downloads, messages.'),
    ('web/server.py', 'The web server (this computer, home Wi-Fi or a website): files with HTTP Range support, and the API of the library, accounts, corrections, translations and My audio.'),
    ('web/library.py', 'Lingua Books: the library — books from a text, a PDF or photos of pages; who may see and change them; reports.'),
    ('web/accounts.py', 'Accounts on a website: sign up, log in, scrypt password hashes, the signed login cookie, admins.'),
    ('web/db.py', 'The library database (SQLite): users, books, reports, branches.'),
    ('web/branches.py', "The branches of the library: folders in folders that admins make; the disc's levels put in theirs."),
    ('web/ocr.py', 'Reading the words of page images: Tesseract (Linux) or the OCR built into Windows.'),
    ('web/ids.py', 'The ids of books and pages (the disc and the library).'),
    ('web/requirements.txt', 'The Python packages of the server.'),
    ('web/terms.html', 'Terms and privacy of the public website.'),
    ('web/auth.py', 'The PIN for phones on the home Wi-Fi.'),
    ('web/login.html', 'The login page.'),
    ('web/manifest.webmanifest', 'Lets phones add the app to the home screen (name, icons, full screen).'),
    ('web/tts.py', 'My audio on the server: natural voices (edge-tts) or Windows voices, joining sentences into one MP3 (ffmpeg), word timings, the library.'),
    ('web/windows_speech.ps1', 'The installed Windows voices (System.Speech): the list, and speaking a text to WAV with the time of every word.'),
    ('web/translate.py', 'Translation on the server: Google Translate (free), from the book’s language, matching the result to the sentences, words in their sentence, saving it per page.'),
    ('web/pinyin.py', 'The pinyin of Chinese sentences broken down (pypinyin, on this computer): each character read by the words around it.'),
    ('web/words.py', 'New words on the server: categories, items, flashcard answers (one file per person).'),
    ('web/lessons.json', 'The lessons of the Student Books and Workbooks of every level, with their pages (flashcards by lesson or File).'),
    ('web/levels.json', 'The levels whose books the app shows (Level 1, 2, 3): the folder of each, where its disc is unpacked and its books are built.'),
    ('web/transcription.py', 'Speech recognition (faster-whisper) of the recordings without a script: one line per sentence.'),
    ('web/transcription-requirements.txt', 'The Python packages of speech recognition (installed by Setup transcription.bat).'),
    ('Setup transcription.bat', 'Installs speech recognition once: faster-whisper and the English model (about 420 MB).'),
    ('web/README.md', 'Short user guide.'),
    ('web/tools/common.py', 'Shared paths and the page geometry.'),
    ('web/tools/stitch_pages.py', 'Step 1: joins the 16x16 tiles of each page into one image and a thumbnail.'),
    ('web/tools/ocr_windows.ps1', 'Step 2: Windows built-in OCR; writes words with their boxes.'),
    ('web/tools/segment_text.py', 'Step 3: groups words into blocks, sentences and clauses (a bullet item on its own; Chinese and English a sentence each); writes the search files.'),
    ('web/tools/convert_videos.py', 'Step 4: converts the FLV (VP6) videos to MP4 (H.264).'),
    ('web/tools/build_data.py', 'Step 5: books.json (pages, hotspots in pixels, blank pages, resources) and transcripts.'),
    ('web/tools/transcribe_all.py', 'Speech recognition of every recording and video without a script, once; the results become ordinary scripts.'),
    ('web/tools/build_all.ps1', 'Runs all build steps in order (and downloads Ruffle); -Root builds another level in its own folder.'),
    ('web/tools/validate_data.py', 'Checks a built level: every page, text, recording, script and document it links to.'),
    ('web/tools/make_icons.py', 'Makes the app icons (home screen of phones, browser tab).'),
    ('web/tests/harness.mjs', 'Test setup: starts the server, finds Edge/Chrome, helpers.'),
    ('web/tests/ui-test.mjs', 'End-to-end test of every feature, at desktop and phone size, and the login (170 checks).'),
    ('web/tests/capture-screenshots.mjs', 'Takes the screenshots used in this guide.'),
    ('web/tests/load-test.py', 'How many readers the server can serve at once (one core, like the smallest VPS).'),
    ('web/tests/test_words.py', 'New words: adding once, categories, flashcard answers, deleting; bad items refused.'),
    ('web/tests/test_word_translation_cache.py', 'Words translated in their sentence: preparing and reading offline share one saved file.'),
    ('web/tests/test_tts_generation.py', 'Making audio: a refused voice service, and a complete sentence timeline (a fake speech service).'),
    ('web/tests/test_offline_deletion.py', 'Deleting recordings: ownership folders, metadata and races.'),
    ('web/tests/voice-options-test.mjs', 'Windows and Natural voices kept apart, matching voices (Node).'),
    ('web/tests/offline-page-test.mjs', 'The OFFLINE/ONLINE badge of a page and deleting its voice file (browser).'),
    ('web/tests/audio-create-recovery-test.mjs', 'The Create audio dialog after a failure (Node, a stand-in for the page).'),
    ('web/tests/translation-offline-test.mjs', 'Prepare and offline-only translations in a browser, with mocked answers.'),
    ('web/tests/translation-offline-logic-test.mjs', 'The same logic in Node, with an in-memory API.'),
    ('web/tests/package.json', 'Test dependencies (puppeteer-core).'),
    ('deploy/README.md', 'Putting Lingua Books online: a VPS, books.dolingual.com, HTTPS, updates, backups.'),
    ('deploy/setup-server.sh', 'Sets up a new Ubuntu server: Python, Tesseract, Caddy (HTTPS), the code from GitHub, the admin, the service.'),
    ('deploy/update.sh', 'On the server: the newest code from GitHub, then a restart.'),
    ('deploy/backup.sh', 'On the server: everything people added, in one file.'),
    ('.gitignore', 'What goes into the git repository: only code (not the book content, not your data).'),
    ('guide/src/make_figures.py', 'Makes the explanatory figures of this guide.'),
    ('guide/src/react-brief.md', 'The React rebuild brief: project knowledge, specification, prompts, pitfalls (chapter 12).'),
    ('guide/src/make_fixtures.py', 'Makes the sample book of the React kit, from an original text, in the app\'s real formats.'),
    ('guide/src/build_guide.py', 'Builds this guide, the rebuild kit zip and the React kit.'),
]

TREE = [
    {'name': 'README.md', 'kind': 'code', 'path': 'README.md', 'desc': 'Lingua Books in short'},
    {'name': 'Start Lingua Books.bat', 'kind': 'code', 'path': 'Start Lingua Books.bat', 'desc': 'double-click to start'},
    {'name': 'Start for phones (home Wi-Fi).bat', 'kind': 'code', 'path': 'Start for phones (home Wi-Fi).bat', 'desc': 'also for phones on the home Wi-Fi'},
    {'name': 'Setup transcription.bat', 'kind': 'code', 'path': 'Setup transcription.bat', 'desc': 'speech recognition, once (optional)'},
    {'name': '.gitignore', 'kind': 'code', 'path': '.gitignore', 'desc': 'git: only code goes into the repository'},
    {'name': 'deploy', 'kind': 'dir', 'desc': 'your own website (VPS + domain)', 'children': [
        {'name': n, 'kind': 'code', 'path': f'deploy/{n}', 'desc': d} for n, d in [
            ('README.md', 'the steps'), ('setup-server.sh', 'set up the server once'),
            ('update.sh', 'newest code from GitHub'), ('backup.sh', 'a copy of everything')]]},
    {'name': '.shared', 'kind': 'orig', 'desc': 'original disc content (not changed)', 'children': [
        {'name': 'books', 'kind': 'orig', 'desc': '3 books → pages → tiles at zoom 2/3/4, thumb, index.json (hotspots)', 'children': []},
        {'name': 'assets', 'kind': 'orig', 'desc': 'audio (MP3 + XML scripts), swf (answer keys), video (FLV), document (PDF/PPT), covers', 'children': []},
        {'name': 'content', 'kind': 'orig', 'desc': 'old app UI (shell.html, OpenLayers, page.map.js) and index.json (book index)', 'children': []},
    ]},
    {'name': 'windows', 'kind': 'orig', 'desc': 'the old XULRunner program (oup.exe)', 'children': []},
    {'name': 'web', 'kind': 'dir', 'desc': 'the new browser version', 'children': [
        {'name': 'index.html', 'kind': 'code', 'path': 'web/index.html', 'desc': 'the app page'},
        {'name': 'server.py', 'kind': 'code', 'path': 'web/server.py', 'desc': 'local server with Range support and the app API'},
        {'name': 'tts.py', 'kind': 'code', 'path': 'web/tts.py', 'desc': 'natural-voice and Windows-voice MP3s (My audio)'},
        {'name': 'windows_speech.ps1', 'kind': 'code', 'path': 'web/windows_speech.ps1', 'desc': 'the installed Windows voices'},
        {'name': 'translate.py', 'kind': 'code', 'path': 'web/translate.py', 'desc': 'translations (Google Translate, saved per page)'},
        {'name': 'words.py', 'kind': 'code', 'path': 'web/words.py', 'desc': 'new words and flashcard answers'},
        {'name': 'lessons.json', 'kind': 'code', 'path': 'web/lessons.json', 'desc': 'the lessons of the books (flashcards)'},
        {'name': 'levels.json', 'kind': 'code', 'path': 'web/levels.json', 'desc': 'the levels and their folders'},
        {'name': 'transcription.py', 'kind': 'code', 'path': 'web/transcription.py', 'desc': 'speech recognition (faster-whisper)'},
        {'name': 'transcription-requirements.txt', 'kind': 'code', 'path': 'web/transcription-requirements.txt', 'desc': 'its packages'},
        {'name': 'migration.py', 'kind': 'code', 'path': 'web/migration.py', 'desc': 'importing old apps'},
        {'name': 'library.py', 'kind': 'code', 'path': 'web/library.py', 'desc': 'the library: books from text, PDF, photos'},
        {'name': 'accounts.py', 'kind': 'code', 'path': 'web/accounts.py', 'desc': 'accounts, login cookie, admins'},
        {'name': 'db.py', 'kind': 'code', 'path': 'web/db.py', 'desc': 'the database (SQLite)'},
        {'name': 'branches.py', 'kind': 'code', 'path': 'web/branches.py', 'desc': 'the branches of the library'},
        {'name': 'ocr.py', 'kind': 'code', 'path': 'web/ocr.py', 'desc': 'OCR: Tesseract or Windows'},
        {'name': 'auth.py', 'kind': 'code', 'path': 'web/auth.py', 'desc': 'the PIN (home Wi-Fi)'},
        {'name': 'terms.html', 'kind': 'code', 'path': 'web/terms.html', 'desc': 'terms and privacy'},
        {'name': 'fonts', 'kind': 'gen', 'desc': 'Atkinson Hyperlegible (text lessons; open font licence)', 'children': []},
        {'name': 'library', 'kind': 'gen', 'desc': 'the library on this computer: database, books (never in git)', 'children': []},
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
                ('recordings.js', 'My audio (natural-voice MP3s)'), ('translation.js', 'translations'),
                ('library.js', 'the library, adding books, accounts, admin'), ('follow.js', 'following the reading'),
                ('words.js', 'new words and flashcards'), ('transcription.js', 'the Transcribe button'),
                ('offline-audio.js', 'offline voice files (IndexedDB)'), ('voice-options.js', 'matching voices'),
                ('migration.js', 'importing old apps'), ('util.js', 'helpers')]]},
        {'name': 'tools', 'kind': 'dir', 'desc': 'build scripts (run once)', 'children': [
            {'name': n, 'kind': 'code', 'path': f'web/tools/{n}', 'desc': d} for n, d in [
                ('build_all.ps1', 'runs every step'), ('common.py', 'shared paths'), ('stitch_pages.py', 'step 1: tiles → page images'),
                ('ocr_windows.ps1', 'step 2: OCR'), ('segment_text.py', 'step 3: sentences and clauses'),
                ('convert_videos.py', 'step 4: FLV → MP4'), ('build_data.py', 'step 5: books.json + transcripts'),
                ('transcribe_all.py', 'scripts by speech recognition'), ('validate_data.py', 'checks a built level'),
                ('make_icons.py', 'app icons')]]},
        {'name': 'tests', 'kind': 'dir', 'desc': 'browser tests (Puppeteer) and Python tests', 'children': [
            {'name': n, 'kind': 'code', 'path': f'web/tests/{n}', 'desc': d} for n, d in [
                ('ui-test.mjs', '170 feature checks'), ('capture-screenshots.mjs', 'guide screenshots'),
                ('harness.mjs', 'shared test setup'), ('load-test.py', 'readers at once'), ('package.json', 'dependencies'),
                ('migration-test.mjs', 'importing an old app'), ('offline-page-test.mjs', 'offline voice files of a page'),
                ('translation-offline-test.mjs', 'Prepare, offline translations'), ('translation-offline-logic-test.mjs', 'the same, in Node'),
                ('voice-options-test.mjs', 'matching voices'), ('audio-create-recovery-test.mjs', 'Create audio after a failure'),
                ('test_migration.py', 'importer (Python)'), ('test_words.py', 'new words (Python)'),
                ('test_word_translation_cache.py', 'words in context (Python)'), ('test_tts_generation.py', 'making audio (Python)'),
                ('test_offline_deletion.py', 'deleting recordings (Python)')]]},
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
        {'name': 'words', 'kind': 'gen', 'desc': 'your new words: words.json (never touched by the build)', 'children': []},
        {'name': 'transcripts', 'kind': 'gen', 'desc': 'speech recognition of the recordings without a script: <id>.json', 'children': []},
        {'name': 'vendor/python, vendor/models', 'kind': 'gen', 'desc': 'faster-whisper and its model (Setup transcription.bat)', 'children': []},
        {'name': 'server-config.json', 'kind': 'gen', 'desc': 'the PIN for phones on the home Wi-Fi (made on first use)'},
        {'name': 'vendor/ruffle', 'kind': 'gen', 'desc': 'Ruffle Flash emulator (downloaded from npm)', 'children': []},
        {'name': '_build/ocr_raw', 'kind': 'gen', 'desc': 'raw OCR results (kept so step 3 can be re-run quickly)', 'children': []},
    ]},
    {'name': 'guide', 'kind': 'dir', 'desc': 'this guide', 'children': [
        {'name': 'AEF3 Rebuild Guide.html', 'kind': 'gen', 'desc': 'this file'},
        {'name': 'AEF3 rebuild kit.zip', 'kind': 'gen', 'desc': 'guide + all source code'},
        {'name': 'Lingua Books React kit.zip', 'kind': 'gen', 'desc': 'brief, code, screenshots, sample book: for a React rebuild'},
        {'name': 'Lingua Books React brief.md', 'kind': 'gen', 'desc': 'the brief alone'},
        {'name': 'src', 'kind': 'dir', 'desc': 'guide sources', 'children': [
            {'name': 'build_guide.py', 'kind': 'code', 'path': 'guide/src/build_guide.py', 'desc': 'builds the guide and the zips'},
            {'name': 'make_figures.py', 'kind': 'code', 'path': 'guide/src/make_figures.py', 'desc': 'explanatory figures'},
            {'name': 'react-brief.md', 'kind': 'code', 'path': 'guide/src/react-brief.md', 'desc': 'the React rebuild brief'},
            {'name': 'make_fixtures.py', 'kind': 'code', 'path': 'guide/src/make_fixtures.py', 'desc': 'the sample book'},
            {'name': 'template.html, guide.css, guide.js', 'kind': 'doc', 'desc': 'guide page, styles, demos'},
            {'name': 'images', 'kind': 'doc', 'desc': 'screenshots and figures', 'children': []},
            {'name': 'fixtures', 'kind': 'gen', 'desc': 'the sample book (made by make_fixtures.py)', 'children': []},
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
  4. Start: double-click "Start Lingua Books.bat"

Contents
  AEF3 Rebuild Guide.html            the interactive guide (one file)
  Start Lingua Books.bat             launcher (this computer)
  Start for phones (home Wi-Fi).bat  launcher (phones on the home Wi-Fi too, with a PIN)
  Setup transcription.bat            speech recognition for recordings without a script (optional)
  web/                               the app, build tools and tests
  deploy/                            your own website (VPS + domain, e.g. books.dolingual.com)
  guide/src/                         sources of the guide (to rebuild it), and react-brief.md:
                                     the brief for rebuilding the app in React (chapter 12)

Code on GitHub: https://github.com/mhmdnojim/Lingual-E3
"""


def build_zip():
    include = ['README.md', 'Start Lingua Books.bat', 'Start for phones (home Wi-Fi).bat', 'Setup transcription.bat',
               '.gitignore', '.gitattributes',
               'web/index.html', 'web/login.html', 'web/terms.html', 'web/manifest.webmanifest', 'web/README.md',
               'web/requirements.txt', 'web/transcription-requirements.txt', 'web/lessons.json', 'web/windows_speech.ps1',
               'web/css/app.css']
    include += [p.replace(os.sep, '/') for p in glob.glob('web/fonts/*', root_dir=ROOT)]
    include += [p.replace(os.sep, '/') for p in glob.glob('deploy/*', root_dir=ROOT) + glob.glob('web/icons/*', root_dir=ROOT)]
    include += [p.replace(os.sep, '/') for p in
                glob.glob('web/*.py', root_dir=ROOT) + glob.glob('web/js/*.js', root_dir=ROOT) + glob.glob('web/tools/*.py', root_dir=ROOT) +
                glob.glob('web/tools/*.ps1', root_dir=ROOT) + glob.glob('web/tests/*.mjs', root_dir=ROOT) +
                glob.glob('web/tests/*.py', root_dir=ROOT) + ['web/tests/package.json'] +
                glob.glob('guide/src/*.*', root_dir=ROOT) + glob.glob('guide/src/images/*.png', root_dir=ROOT)]
    with zipfile.ZipFile(OUT_ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.write(OUT_HTML, os.path.basename(OUT_HTML))
        z.writestr('READ ME FIRST.txt', KIT_README.replace('\n', '\r\n'))
        for rel in sorted(set(include)):
            z.write(os.path.join(ROOT, rel), rel)
    print(f'{os.path.basename(OUT_ZIP)}: {os.path.getsize(OUT_ZIP) / 1024 / 1024:.1f} MB, {len(set(include)) + 2} files')


REACT_README = """# Lingua Books: React kit

For rebuilding the Lingua Books reader as a React app with Lovable (or another AI app builder, or
a developer). Everything is explained in docs/BRIEF.md; the steps in short:

1. Make a new Lovable project and connect it to GitHub.
2. Copy the folders `docs` and `public/fixtures` of this kit into that repository and push them.
3. Paste Part A of docs/BRIEF.md into Lovable's project knowledge (Project settings -> Knowledge).
4. Send the prompts of Part C one at a time, in order. Check each "Done when" in the preview first.
5. When it is done: build it and let the Lingua Books server serve it (BRIEF B2.3, prompt C15).

| Folder | What |
|---|---|
| docs/BRIEF.md | the brief: project knowledge, specification, prompts, pitfalls |
| docs/reference/web | the current browser app (plain JavaScript): the behaviour to port |
| docs/reference/server | the current Python server: the truth about the API |
| docs/screenshots | the current app; the book pages in them belong to Oxford University Press: for layout only, never publish them |
| public/fixtures | a sample book from an original text, in the app's real formats, so the app runs without the server |
"""


def build_react_kit():
    """The kit for rebuilding the browser app in React: the brief, the code, screenshots, the sample book."""
    if not os.path.isdir(os.path.join(FIXTURES, 'api')):
        raise SystemExit('The sample book is missing: run python guide/src/make_fixtures.py first.')
    brief = read('guide/src/react-brief.md').replace('\r\n', '\n')
    with open(OUT_BRIEF, 'w', encoding='utf-8', newline='\n') as f:
        f.write(brief)
    files = {'READ ME FIRST.md': None, 'docs/BRIEF.md': None}
    web = ['index.html', 'manifest.webmanifest', 'css/app.css'] + [f'js/{os.path.basename(p)}' for p in glob.glob(os.path.join(WEB, 'js', '*.js'))]
    for rel in web:
        files[f'docs/reference/web/{rel}'] = os.path.join(WEB, rel)
    server = [os.path.basename(p) for p in glob.glob(os.path.join(WEB, '*.py'))] + ['windows_speech.ps1', 'lessons.json', 'requirements.txt']
    for name in server:
        files[f'docs/reference/server/{name}'] = os.path.join(WEB, name)
    files['docs/reference/server/tools/segment_text.py'] = os.path.join(WEB, 'tools', 'segment_text.py')
    for path in sorted(glob.glob(os.path.join(SRC, 'images', '*.png'))):
        if not os.path.basename(path).startswith('fig-'):  # (the figures explain the old disc, not the app)
            files[f'docs/screenshots/{os.path.basename(path)}'] = path
    for folder, _, names in os.walk(FIXTURES):
        for name in names:
            path = os.path.join(folder, name)
            files['public/fixtures/' + os.path.relpath(path, FIXTURES).replace(os.sep, '/')] = path
    with zipfile.ZipFile(OUT_REACT_ZIP, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr('READ ME FIRST.md', REACT_README)
        z.writestr('docs/BRIEF.md', brief)
        for arc, path in sorted(files.items()):
            if path:
                z.write(path, arc)
    print(f'{os.path.basename(OUT_REACT_ZIP)}: {os.path.getsize(OUT_REACT_ZIP) / 1024 / 1024:.1f} MB, {len(files)} files; '
          f'{os.path.basename(OUT_BRIEF)}: {len(brief) // 1024} KB')


if __name__ == '__main__':
    build_html()
    build_zip()
    build_react_kit()
