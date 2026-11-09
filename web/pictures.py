"""Lingua Books: replacing a picture on a page of a book (web/library.py uses it).

The owner draws a box around a picture on a page and gives a new one: a picture of their own, or
one an AI image service makes from what they write (and, if asked, from the old picture). The new
picture fills the box (cut at the edges to keep its shape: 'cover'; or whole, white around it:
'contain') in the page picture the reader shows, and in the book's PDF: there, pictures that are
inside the box (a picture of their own in the PDF) and the text in it (the words of the old picture)
are taken out, and the new picture is put in their place. A scanned page is one picture: the new
one goes over its part of it.

Each replacement is kept (pictures.json, pictures/<id>.jpg), with the page as it was (pictures/
page-<n>.webp) and the PDF as it was (source/book.original.pdf): a page and the PDF are made again
from them, so any replacement can be taken back.
"""
import base64
import io
import json
import os
import urllib.error
import urllib.request
import uuid

from PIL import Image, ImageOps

FITS = ('cover', 'contain')
MOST_PX = 2400        # a new picture is kept at most this big (its longer side)
AI_API = os.environ.get('LB_IMAGE_API', 'https://api.openai.com/v1')  # (tests: a stand-in)
AI_MODEL = 'gpt-image-1'


class PictureError(Exception):
    pass


# ---------------------------------------------------------------- The picture itself

def normalized(data):
    """A picture as uploaded (JPEG, PNG, WebP, …): upright, without transparency (on white), at
    most MOST_PX: JPEG bytes. PictureError if it is no picture."""
    try:
        with Image.open(io.BytesIO(data)) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ('RGBA', 'LA', 'P'):
                im = im.convert('RGBA')
                flat = Image.new('RGB', im.size, 'white')
                flat.paste(im, mask=im.getchannel('A'))
                im = flat
            im = im.convert('RGB')
    except Exception:
        raise PictureError('This is not a picture the app can open (use JPEG, PNG or WebP).')
    im.thumbnail((MOST_PX, MOST_PX), Image.LANCZOS)
    out = io.BytesIO()
    im.save(out, 'JPEG', quality=90)
    return out.getvalue()


def fitted(img, w, h, fit='cover'):
    """The picture made w × h: filling it, cut at the edges ('cover'), or whole with white around it ('contain')."""
    w, h = max(1, round(w)), max(1, round(h))
    if fit == 'contain':
        im = img.copy()
        im.thumbnail((w, h), Image.LANCZOS)
        out = Image.new('RGB', (w, h), 'white')
        out.paste(im, ((w - im.width) // 2, (h - im.height) // 2))
        return out
    return ImageOps.fit(img, (w, h), Image.LANCZOS)


def page_with(original, replacements, open_picture):
    """The page picture (original: as it was made) with these replacements in it, in order."""
    page = original.convert('RGB').copy()
    for r in replacements:
        x, y, w, h = r['box']
        with open_picture(r) as pic:
            page.paste(fitted(pic.convert('RGB'), w, h, r['fit']), (round(x), round(y)))
    return page


# ---------------------------------------------------------------- In the PDF

def pdf_with(original, out, changes):
    """The PDF original with pictures replaced, written to out. changes: [(page index, box in the
    page picture's pixels (x, y, w, h), its width and height, JPEG path of the new picture made to
    the box's shape)]. In the box: the PDF's pictures that are inside it and its text are taken out."""
    import pypdfium2 as pdfium
    import pypdfium2.raw as pdfium_c
    pdf = pdfium.PdfDocument(original)
    taken = []
    try:
        for index, (x, y, w, h), page_w, page_h, jpeg in changes:
            page = pdf[index]
            if page.get_rotation() % 360:
                raise PictureError('This page of the PDF is turned: its pictures cannot be replaced.')
            left, bottom, right, top = page.get_cropbox()
            sx, sy = (right - left) / page_w, (top - bottom) / page_h
            box = (left + x * sx, top - (y + h) * sy, left + (x + w) * sx, top - y * sy)  # (PDF: from the bottom)
            slack = 2  # (points)

            def inside(o):
                l, b, r, t = o.get_bounds()
                return l >= box[0] - slack and b >= box[1] - slack and r <= box[2] + slack and t <= box[3] + slack

            def middle_in(o):
                l, b, r, t = o.get_bounds()
                return box[0] <= (l + r) / 2 <= box[2] and box[1] <= (b + t) / 2 <= box[3]
            for o in list(page.get_objects(filter=[pdfium_c.FPDF_PAGEOBJ_IMAGE, pdfium_c.FPDF_PAGEOBJ_TEXT], max_depth=1)):
                if o.type == pdfium_c.FPDF_PAGEOBJ_IMAGE and inside(o) or o.type == pdfium_c.FPDF_PAGEOBJ_TEXT and middle_in(o):
                    page.remove_obj(o)
                    taken.append(o)
            pic = pdfium.PdfImage.new(pdf)
            pic.load_jpeg(jpeg, pages=[page], inline=False)
            pic.set_matrix(pdfium.PdfMatrix().scale(box[2] - box[0], box[3] - box[1]).translate(box[0], box[1]))
            page.insert_obj(pic)
            page.gen_content()
        pdf.save(out)
    finally:
        for o in taken:  # (taken out of their page: closed before the document)
            o.close()
        pdf.close()


# ---------------------------------------------------------------- Made by an AI image service

def ai_settings(config):
    """The AI image service's key and model: web/server-config.json ('imageKey', 'imageModel'),
    else the environment (OPENAI_API_KEY)."""
    return (config.get('imageKey') or os.environ.get('OPENAI_API_KEY', '')), (config.get('imageModel') or AI_MODEL)


AUTO = ('Draw this picture again as a new picture for a page of a school textbook: the same subject, people and scene, '
        'clear and friendly, with no words or letters in it.')


def ai_prompt(description, context='', like=False):
    """What the AI image service is asked: the owner's description; without one, the old picture
    made again (like: from it), with the text of the page around it (context) to go with."""
    description = ' '.join(str(description or '').split())[:2000]
    if description:
        return description
    if not like:
        raise PictureError('Describe the picture, or start from the old picture.')
    context = ' '.join(str(context or '').split())[:400]
    return AUTO + (f' It goes with this text on the page: “{context}”.' if context else '')


def ai_size(w, h):
    """The size the service makes closest to the box's shape."""
    return '1536x1024' if w > 1.2 * h else '1024x1536' if h > 1.2 * w else '1024x1024'


def ai_picture(prompt, key, model, size, like=None, timeout=180):
    """A picture made by the AI image service (OpenAI's images API) from what the owner wrote,
    and from the old picture if like (its JPEG bytes): the picture's bytes. PictureError if not."""
    prompt = ' '.join(str(prompt or '').split())[:2000]
    if not prompt:
        raise PictureError('Write what the picture should show.')
    if not key:
        raise PictureError('No key for the AI image service yet.')
    if like is None:
        body = json.dumps({'model': model, 'prompt': prompt, 'size': size, 'n': 1}).encode('utf-8')
        req = urllib.request.Request(f'{AI_API}/images/generations', body, {'Content-Type': 'application/json'})
    else:  # (from the old picture: an edit of it)
        boundary = uuid.uuid4().hex
        parts = [f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode('utf-8')
                 for k, v in (('model', model), ('prompt', prompt), ('size', size), ('n', '1'))]
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="old.jpg"\r\n'
                     'Content-Type: image/jpeg\r\n\r\n'.encode('utf-8') + like + b'\r\n')
        body = b''.join(parts) + f'--{boundary}--\r\n'.encode('utf-8')
        req = urllib.request.Request(f'{AI_API}/images/edits', body, {'Content-Type': f'multipart/form-data; boundary={boundary}'})
    req.add_header('Authorization', f'Bearer {key}')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            said = json.loads(e.read().decode('utf-8')).get('error', {}).get('message', '')
        except Exception:
            said = ''
        if e.code == 401:
            raise PictureError('OpenAI did not accept the key. It must be a key of OpenAI (platform.openai.com → API keys): '
                               'keys of other AIs (Kimi, DeepSeek …) cannot make pictures. Change it: “Change the key”, under Made by AI.')
        raise PictureError(f'The AI image service said no ({e.code}){": " + said[:300] if said else ""}.')
    except (urllib.error.URLError, TimeoutError, OSError):
        raise PictureError('The AI image service could not be reached (no internet?). Try again.')
    try:
        item = d['data'][0]
        if item.get('b64_json'):
            return base64.b64decode(item['b64_json'])
        with urllib.request.urlopen(item['url'], timeout=timeout) as r:  # (a service that gives an address)
            return r.read()
    except Exception:
        raise PictureError('The AI image service sent no picture. Try again, or say it differently.')
