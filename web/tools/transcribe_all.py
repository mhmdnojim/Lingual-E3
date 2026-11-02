"""Transcribe, once, every recording and video of the disc that has no script, with speech
recognition on this computer (web/transcription.py), and make the results ordinary scripts:
web/data/scripts/<id>.json, marked "auto" in web/data/books.json. Give web/data (and
web/transcripts, so a rebuild keeps them) to the others: they see the scripts without
installing anything.

    python web/tools/transcribe_all.py             all of them (those done before are skipped)
    python web/tools/transcribe_all.py --limit 3   only a few, to try

Needs Setup transcription.bat (once). Restart the app afterwards.
"""
import argparse
import os
import sys
import time

from common import APP, DATA, ROOT, TRANSCRIPTS, load_json, save_json
from build_data import machine_script

os.environ.setdefault('AEF_TRANSCRIPTS_DIR', TRANSCRIPTS)  # (where build_data.py finds them)
sys.path.insert(0, os.path.join(APP, 'web'))
import transcription  # noqa: E402


def recordings(books):
    """The disc's recordings and videos without a script of their own (each once): {src: title}."""
    return {a['src']: a.get('title', '') for a in assets(books)}


def assets(books):
    for b in books['books']:
        for p in b['pages']:
            for a in p['a']:
                if a.get('t') in ('audio', 'video') and (not a.get('script') or a.get('auto')):
                    yield a


def apply(books):
    """Every recording that has a transcript gets it as its script. Returns how many."""
    n = 0
    for a in assets(books):
        url = machine_script(a['src'])
        if url:
            a['script'], a['auto'] = url, True
            n += 1
    return n


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--limit', type=int, default=0, help='transcribe at most this many')
    ap.add_argument('--threads', type=int, default=max(1, (os.cpu_count() or 2) // 2))
    ap.add_argument('--no-speakers', action='store_true',
                    help='without telling the voices apart (when speaker detection is not set up)')
    args = ap.parse_args()
    books_path = os.path.join(DATA, 'books.json')
    books = load_json(books_path)
    todo = [(src, title) for src, title in recordings(books).items()
            if not transcription.saved(transcription.asset_id(src))]
    if args.limit:
        todo = todo[:args.limit]
    print(f'{len(todo)} recordings to transcribe (model {transcription.MODEL}, {args.threads} threads).')
    started, failed = time.time(), []
    for i, (src, title) in enumerate(todo, 1):
        aid = transcription.asset_id(src)
        path = os.path.join(ROOT, src.lstrip('/'))
        t = time.time()
        try:
            cues = transcription.transcribe(path, threads=args.threads, speakers=not args.no_speakers)
            transcription.save(aid, cues)
            left = (time.time() - started) / i * (len(todo) - i)
            print(f'[{i}/{len(todo)}] {title}: {len(cues)} lines in {time.time() - t:.0f} s'
                  f' (about {left / 60:.0f} min left)', flush=True)
        except Exception as error:  # e.g. music only: go on with the others
            failed.append(title)
            print(f'[{i}/{len(todo)}] {title}: not transcribed ({error})', flush=True)
    n = apply(books)
    save_json(books_path, books)
    print(f'Done in {(time.time() - started) / 60:.0f} min. {n} recordings now have a script made by speech recognition.')
    if failed:
        print(f'Not transcribed ({len(failed)}): ' + '; '.join(failed))
    print('Restart the app to see them.')


if __name__ == '__main__':
    sys.exit(main())
