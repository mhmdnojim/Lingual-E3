"""How many readers can the server serve at once?

Starts its own copy of the server (port 8799, its own empty data folder: your books are not
touched), held to one processor core like the smallest VPS, makes a text book, then lets 10, 50
and 200 "readers" ask for pages at the same moment, again and again, for 8 seconds each.

    python web/tests/load-test.py            (CORES=2 for two cores; needs: pip install psutil)

A person reading turns a page every 30-60 seconds, so 1,000 people reading at the same time ask
for about 30-50 pages a second.
"""
import json, os, random, subprocess, sys, tempfile, threading, time
from urllib.request import Request, urlopen

import psutil

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8799
BASE = f'http://127.0.0.1:{PORT}'
CORES = int(os.environ.get('CORES', '1'))


def call(method, path, body=None, raw=False):
    req = Request(BASE + path, data=json.dumps(body).encode() if body is not None else None, method=method,
                  headers={'Content-Type': 'application/json'})
    with urlopen(req, timeout=30) as r:
        out = r.read()
    return out if raw else json.loads(out or b'null')


def make_book():
    para = ('Every morning Anna takes the bus to work. She reads a book on the way, and sometimes she '
            'listens to music. Yesterday the bus was late, so she walked. It was a beautiful day. ') * 6
    b = call('POST', '/api/books', {'kind': 'text', 'title': 'Load test'})
    bid = b.get('book', b)['id']
    call('PUT', f'/api/books/{bid}/source/text', {'text': '\n\n'.join([para] * 14)})
    call('POST', f'/api/books/{bid}/make', {})
    for _ in range(300):
        book = call('GET', f'/api/books/{bid}')
        book = book.get('book', book)
        if book.get('status') == 'ready':
            return book
        time.sleep(0.2)
    raise SystemExit('The book was not made.')


def run(server, urls, clients, seconds=8):
    times, errors, sent = [], [0], [0]
    stop = time.time() + seconds
    lock = threading.Lock()

    def reader():
        while time.time() < stop:
            t = time.perf_counter()
            try:
                with urlopen(BASE + random.choice(urls), timeout=30) as r:
                    n = len(r.read())
                with lock:
                    times.append(time.perf_counter() - t)
                    sent[0] += n
            except Exception:
                with lock:
                    errors[0] += 1

    server.cpu_percent(None)
    threads = [threading.Thread(target=reader) for _ in range(clients)]
    for t in threads:
        t.start()
    memory = 0
    while time.time() < stop:
        time.sleep(0.5)
        memory = max(memory, server.memory_info().rss)
    for t in threads:
        t.join()
    times.sort()
    at = lambda f: times[min(len(times) - 1, int(len(times) * f))] * 1000 if times else 0  # noqa: E731
    print(f'{clients:4d} at once: {len(times) / seconds:5.0f} requests a second, {sent[0] / seconds / 1e6:5.1f} MB/s, '
          f'usual wait {at(.5):4.0f} ms, slowest 5% {at(.95):5.0f} ms, errors {errors[0]}, '
          f'memory {memory / 1e6:.0f} MB')


def main():
    data = tempfile.mkdtemp(prefix='lb-load-')
    env = {**os.environ, 'LB_DATA_DIR': os.path.join(data, 'library'), 'AEF_EDITS_DIR': os.path.join(data, 'edits'),
           'AEF_RECORDINGS_DIR': os.path.join(data, 'recordings'), 'AEF_TRANSLATIONS_DIR': os.path.join(data, 'translations')}
    env.pop('AEF_PASSWORD', None)
    proc = subprocess.Popen([sys.executable, 'server.py', '--port', str(PORT), '--no-browser'], cwd=WEB, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        server = psutil.Process(proc.pid)
        server.cpu_affinity(list(range(CORES)))
        for _ in range(100):
            try:
                call('GET', '/api/version')
                break
            except Exception:
                time.sleep(0.1)
        book = make_book()
        pages = [p['img'] for p in book['pages']]
        size = sum(len(call('GET', u, raw=True)) for u in pages) / len(pages)
        print(f'A text book of {len(pages)} pages (a page picture is about {size / 1024:.0f} KB); '
              f'the server may use {CORES} core(s).')
        # What readers ask for: mostly page pictures, sometimes the book, the app's own files.
        urls = pages * 6 + [f'/api/books/{book["id"]}'] * 2 + ['/web/js/main.js', '/web/css/app.css']
        for clients in (10, 50, 200):
            run(server, urls, clients)
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == '__main__':
    main()
