"""Verify the complete converted edition and every linked local resource."""
from pathlib import Path
from collections import Counter
from common import APP, ROOT, DATA, load_json


def main():
    data = load_json(str(Path(DATA) / 'books.json'))
    errors = []
    counts = Counter()

    def exists(path):
        if not path.is_file():
            errors.append(f'Missing {path}')

    for book in data['books']:
        exists(Path(ROOT) / book['cover'].lstrip('/'))
        exists(Path(DATA) / 'search' / f"{book['slug']}.json")
        for page in book['pages']:
            counts['pages'] += 1
            counts['blank'] += bool(page.get('blank'))
            for kind in ('pages', 'thumbs'):
                exists(Path(DATA) / kind / book['slug'] / f"{page['path']}.webp")
            text = Path(DATA) / 'text' / book['slug'] / f"{page['path']}.json"
            exists(text)
            if text.is_file():
                doc = load_json(str(text))
                counts['words'] += len(doc['words'])
                counts['sentences'] += len(doc['sent'])
                for a, b in doc['sent'] + doc['clause']:
                    if not 0 <= a < b <= len(doc['words']):
                        errors.append(f'Invalid text range in {text}')
            for asset in page['a']:
                counts[asset['t']] += 1
                if asset['t'] == 'link':
                    target = next((b for b in data['books'] if b['id'] == asset['book']), None)
                    if not target or not any(p['n'] == asset['page'] for p in target['pages']):
                        errors.append(f'Invalid page link {asset}')
                else:
                    exists(Path(ROOT) / asset['src'].lstrip('/'))
                if asset.get('script'):
                    exists(Path(ROOT) / asset['script'].lstrip('/'))
    for resource in data['resources']:
        exists(Path(ROOT) / resource['src'].lstrip('/'))
    exists(Path(APP) / 'web/vendor/ruffle/ruffle.js')  # (the app's: it plays every level's answer keys)
    for error in errors:
        print(error)
    print(dict(counts))
    print(f'{len(errors)} errors')
    return bool(errors)


if __name__ == '__main__':
    raise SystemExit(main())
