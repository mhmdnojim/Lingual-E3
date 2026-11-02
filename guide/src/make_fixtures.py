"""Make the sample book of the React rebuild kit: two pages in the app's own formats, made from
an original text (no Oxford University Press content), so another AI or developer can build and
test the reader without the disc.

    python guide/src/make_fixtures.py

Writes guide/src/fixtures/ (build_guide.py puts it into "Lingua Books React kit.zip"):
  api/            the answers of the server's API for this book, as the app receives them
  lib/<id>/       the page images and thumbnails (/lib/<id>/pages/<n>.webp …)
  recordings/     a My audio MP3 of the dialogue with its timing (.json) and subtitles (made with
                  an installed Windows voice; skipped if there is none)
  media/          the same MP3 as the page's audio hotspot, with its script
The pages are made exactly as for a text book added in the library (library._text_pages), so the
word boxes, sentences, clauses and paragraphs are real.
"""
import json
import os
import shutil
import sys
import tempfile
import time

SRC = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(SRC))
WEB = os.path.join(ROOT, 'web')
OUT = os.path.join(SRC, 'fixtures')
TMP = tempfile.mkdtemp(prefix='lb-fixtures-')
# The server modules write only into this temporary folder, never into the user's data.
os.environ.update(LB_DATA_DIR=os.path.join(TMP, 'library'), AEF_RECORDINGS_DIR=os.path.join(TMP, 'rec'),
                  AEF_TRANSLATIONS_DIR=os.path.join(TMP, 'tr'), AEF_WORDS_DIR=os.path.join(TMP, 'words'))
sys.path[:0] = [WEB, os.path.join(WEB, 'tools')]
import library  # noqa: E402
import translate  # noqa: E402
import tts  # noqa: E402
import words  # noqa: E402

BOOK_ID = 'L5a4d1e0b7c'  # (the form of a library book id)
TITLE = 'The Night Market'
TEXT = """Every Friday evening, the car park behind the old train station changes. At six o'clock it is empty and grey. By seven, it is full of lights, music and the smell of food. This is the night market, and people come from all over the city to visit it.

Maya has a small stall near the entrance. She sells dumplings that she makes with her grandmother's recipe. "The secret is patience," she says. "You can't hurry good food." On a busy night she sells more than four hundred, and the queue is often longer than the one for the famous noodle stall next to her.

# At Maya's stall

A: Excuse me, how much are the dumplings?
B: Six for five dollars, or twelve for nine.
A: Twelve, please. Are they very spicy?
B: Not at all. The sauce is spicy, but you can choose the mild one.

Most visitors say that the food is only part of the fun. Students meet their friends there after class, families bring their children, and tourists take photos of everything. Although it is noisy and crowded, nobody seems to mind. When the market closes at midnight, the car park is quiet again, until next Friday.
"""
# Spanish translations of every sentence (written for this sample, not by a machine).
ES = {
    'The Night Market': 'El mercado nocturno',
    'Every Friday evening, the car park behind the old train station changes.': 'Cada viernes por la tarde, el aparcamiento detrás de la vieja estación de tren cambia.',
    "At six o'clock it is empty and grey.": 'A las seis está vacío y gris.',
    'By seven, it is full of lights, music and the smell of food.': 'A las siete, está lleno de luces, música y olor a comida.',
    'This is the night market, and people come from all over the city to visit it.': 'Es el mercado nocturno, y la gente viene de toda la ciudad para visitarlo.',
    'Maya has a small stall near the entrance.': 'Maya tiene un pequeño puesto cerca de la entrada.',
    "She sells dumplings that she makes with her grandmother's recipe.": 'Vende empanadillas que hace con la receta de su abuela.',
    '"The secret is patience," she says.': '«El secreto es la paciencia», dice.',
    '"You can\'t hurry good food."': '«No se puede apresurar la buena comida».',
    'On a busy night she sells more than four hundred, and the queue is often longer than the one for the famous noodle stall next to her.': 'En una noche concurrida vende más de cuatrocientas, y la cola suele ser más larga que la del famoso puesto de fideos de al lado.',
    "At Maya's stall": 'En el puesto de Maya',
    'A: Excuse me, how much are the dumplings?': 'A: Perdone, ¿cuánto cuestan las empanadillas?',
    'B: Six for five dollars, or twelve for nine.': 'B: Seis por cinco dólares, o doce por nueve.',
    'A: Twelve, please.': 'A: Doce, por favor.',
    'Are they very spicy?': '¿Pican mucho?',
    'B: Not at all.': 'B: Nada.',
    'The sauce is spicy, but you can choose the mild one.': 'La salsa pica, pero puede elegir la suave.',
    'Most visitors say that the food is only part of the fun.': 'La mayoría de los visitantes dicen que la comida es solo una parte de la diversión.',
    'Students meet their friends there after class, families bring their children, and tourists take photos of everything.': 'Los estudiantes quedan allí con sus amigos después de clase, las familias traen a sus hijos y los turistas hacen fotos de todo.',
    'Although it is noisy and crowded, nobody seems to mind.': 'Aunque hay ruido y mucha gente, a nadie parece importarle.',
    'When the market closes at midnight, the car park is quiet again, until next Friday.': 'Cuando el mercado cierra a medianoche, el aparcamiento vuelve a estar tranquilo, hasta el viernes siguiente.',
}


def save(rel, obj):
    path = os.path.join(OUT, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write('\n')


def sentence_text(doc, a, b):
    return ''.join(w[4] + (' ' if w[6] and k < b - 1 else '') for k, w in enumerate(doc['words'][a:b], a)).strip()


def make_pages():
    src = os.path.join(TMP, 'source')
    os.makedirs(src)
    with open(os.path.join(src, 'text.json'), 'w', encoding='utf-8') as f:
        json.dump({'text': TEXT}, f)
    pages = library._text_pages({'title': TITLE}, src)
    docs = []
    for n, (img, doc) in enumerate(pages, 1):
        for sub in ('pages', 'thumbs'):
            os.makedirs(os.path.join(OUT, 'lib', BOOK_ID, sub), exist_ok=True)
        img.save(os.path.join(OUT, 'lib', BOOK_ID, 'pages', f'{n}.webp'), 'WEBP', quality=80, method=4)
        th = img.copy()
        th.thumbnail((240, 2000))
        th.save(os.path.join(OUT, 'lib', BOOK_ID, 'thumbs', f'{n}.webp'), 'WEBP', quality=75)
        save(f'api/text/{BOOK_ID}/p{n}.json', doc)  # GET /api/text/<book>/p<n>
        docs.append((img.size, doc))
    return docs


def make_recording(doc):
    """A My audio MP3 of the dialogue (its four lines), made with an installed Windows voice."""
    voices = [v for v in tts.windows_voices() if v['locale'].startswith('en')]
    if not voices:
        print('No Windows voice: the sample recording is left out.')
        return None
    voice = voices[0]
    first = next(i for i, (a, b) in enumerate(doc['sent']) if sentence_text(doc, a, b).startswith('A: Excuse me'))
    sentences = []
    for a, b in doc['sent'][first:first + 6]:
        sentences.append({'path': 'p1', 'a': a, 'b': b, 'text': sentence_text(doc, a, b), 'words': [w[4] for w in doc['words'][a:b]]})
    req = {'voice': voice['id'], 'voiceName': voice['name'], 'rate': 0, 'gap': 0, 'sentences': sentences,
           'title': "At Maya's stall", 'book': BOOK_ID, 'bookId': BOOK_ID, 'bookType': TITLE, 'page': '1', 'path': 'p1'}
    rec_dir = os.environ['AEF_RECORDINGS_DIR']
    os.makedirs(rec_dir, exist_ok=True)
    jid = tts.start_job(req, rec_dir)
    for _ in range(600):
        job = tts.get_job(jid)
        if job['state'] != 'running':
            break
        time.sleep(0.2)
    if job['state'] != 'done':
        print('The sample recording could not be made:', job.get('error'))
        return None
    rec = job['recording']
    rid = rec['id']
    os.makedirs(os.path.join(OUT, 'recordings'), exist_ok=True)
    for ext in ('mp3', 'json', 'srt', 'vtt'):
        if os.path.isfile(os.path.join(rec_dir, f'{rid}.{ext}')):
            shutil.copy(os.path.join(rec_dir, f'{rid}.{ext}'), os.path.join(OUT, 'recordings', f'{rid}.{ext}'))
    full = tts.get_recording(rid, rec_dir)
    save(f'api/recordings/{rid}.json', full)              # GET /api/recordings/<id>
    save('api/recordings.json', tts.list_recordings(rec_dir))  # GET /api/recordings
    # The same sound as the page's audio hotspot, with a script (as a disc recording has).
    os.makedirs(os.path.join(OUT, 'media'), exist_ok=True)
    shutil.copy(os.path.join(rec_dir, f'{rid}.mp3'), os.path.join(OUT, 'media', 'at-mayas-stall.mp3'))
    save('media/at-mayas-stall.json', [{'t': round(s['start'] * 1000), 'x': s['text']} for s in full['sentences']])
    return full


def main():
    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    try:
        docs = make_pages()
        rec = make_recording(docs[0][1])
        (w1, h1), doc1 = docs[0]
        hotspots = []
        if rec:
            # Left of the heading "At Maya's stall" (hotspot x, y: page pixels, the centre of the button).
            heading = next(a for a, b in doc1['sent'] if sentence_text(doc1, a, b) == "At Maya's stall")
            x, y, _, h = doc1['words'][heading][:4]
            hotspots.append({'t': 'audio', 'x': max(40, x - 50), 'y': y + h // 2, 'title': "At Maya's stall (dialogue)",
                             'src': '/media/at-mayas-stall.mp3', 'script': '/media/at-mayas-stall.json'})
        v = 1760000000
        summary = {'id': BOOK_ID, 'title': TITLE, 'author': 'Lingua Books (sample)', 'about': 'A short original text for building and testing the reader.',
                   'kind': 'text', 'visibility': 'public', 'license': 'cc-by', 'licenseName': 'Creative Commons BY',
                   'source': '', 'hidden': False, 'status': 'ready', 'error': '', 'language': 'en', 'pageCount': len(docs),
                   'owner': 'Sample', 'mine': True, 'canEdit': True, 'created': v, 'updated': v,
                   'cover': f'/lib/{BOOK_ID}/thumbs/1.webp?v={v}', 'job': None}
        book = {**summary, 'slug': BOOK_ID, 'type': TITLE, 'library': True, 'lessons': [], 'resources': [],
                'pages': [{'n': n, 'path': f'p{n}', 'w': w, 'h': h, 'txt': True, 'a': hotspots if n == 1 else [],
                           'img': f'/lib/{BOOK_ID}/pages/{n}.webp?v={v}', 'thumb': f'/lib/{BOOK_ID}/thumbs/{n}.webp?v={v}'}
                          for n, ((w, h), _) in enumerate(docs, 1)]}
        save(f'api/books/{BOOK_ID}.json', book)          # GET /api/books/<id>
        save('api/books-public.json', [summary])          # GET /api/books?scope=public
        save('api/books-mine.json', [summary])            # GET /api/books?scope=mine
        save('api/me.json', {'mode': 'local', 'user': {'id': 1, 'name': 'You', 'email': '', 'admin': True}, 'disc': False,
                             'contact': '', 'licenses': library.LICENSES, 'reasons': library.REPORT_REASONS, 'limits': library.LIMITS})
        save('api/version.json', {'api': 17})
        # GET /api/search/<book>: one entry per page, its paragraphs on lines of their own.
        save(f'api/search/{BOOK_ID}.json',
             [{'p': str(n), 't': '\n'.join(' '.join(sentence_text(d, *d['sent'][i]) for i in range(sa, sb)) for sa, sb in d['blocks'])}
              for n, (_, d) in enumerate(docs, 1)])
        save('api/tr-languages.json', translate.languages())
        # POST /api/translate {lang: "es", book, page: "p<n>", paragraphs: [[sentence, …], …] (one list per block)}
        # answers the translations in the same shape.
        for n, (_, d) in enumerate(docs, 1):
            paragraphs = [[sentence_text(d, *d['sent'][i]) for i in range(sa, sb)] for sa, sb in d['blocks']]
            trs = [[ES.get(s, '') for s in p] for p in paragraphs]
            save(f'api/translate/es/{BOOK_ID}/p{n}.json', {'translations': trs, 'fetched': 0,
                 'missing': sum(1 for p in trs for t in p if not t), 'wordContext': False})
        # GET /api/words: the default categories and two items of page 1.
        wdir = os.environ['AEF_WORDS_DIR']
        stall = next(k for k, w in enumerate(doc1['words']) if w[4] == 'stall')
        sa, sb = next((a, b) for a, b in doc1['sent'] if a <= stall < b)
        context = sentence_text(doc1, sa, sb)
        patience = next(k for k, w in enumerate(doc1['words']) if w[4].startswith('patience'))
        pa, pb = next((a, b) for a, b in doc1['sent'] if a <= patience < b)
        words.add([{'book': BOOK_ID, 'bookId': BOOK_ID, 'page': '1', 'path': 'p1', 'mode': 'word', 'a': stall, 'b': stall + 1,
                    'text': 'stall', 'context': context, 'contextOffset': context.find('stall'), 'category': 'new'},
                   {'book': BOOK_ID, 'bookId': BOOK_ID, 'page': '1', 'path': 'p1', 'mode': 'sentence', 'a': pa, 'b': pb,
                    'text': sentence_text(doc1, pa, pb), 'context': sentence_text(doc1, pa, pb), 'contextOffset': 0, 'category': 'common'}], wdir)
        save('api/words.json', words.list_items(wdir))
        # GET /api/voices (the shape; the real list comes from Microsoft and the server's Windows voices)
        save('api/voices.json', [{'id': 'en-US-AriaNeural', 'name': 'Aria', 'gender': 'Female', 'locale': 'en-US'},
                                 {'id': 'en-GB-RyanNeural', 'name': 'Ryan', 'gender': 'Male', 'locale': 'en-GB'}]
             + tts.windows_voices()[:2])
        print(f'{OUT}: {len(docs)} pages, recording: {rec["id"] if rec else "none"}')
    finally:
        shutil.rmtree(TMP, ignore_errors=True)


if __name__ == '__main__':
    main()
