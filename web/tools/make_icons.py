"""Makes the app icons (web/icons): the home-screen icon of phones and the browser tab icon.

    python web/tools/make_icons.py
"""
import os

from PIL import Image, ImageDraw, ImageFont

WEB = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(WEB, 'icons')
RED, WHITE = (196, 18, 47), (255, 255, 255)

SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
<rect width="64" height="64" rx="14" fill="#c4122f"/>
<text x="32" y="38" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="21" font-weight="800" fill="#fff" letter-spacing="0.5">AEF</text>
<text x="32" y="54" text-anchor="middle" font-family="Segoe UI, Arial, sans-serif" font-size="11" font-weight="700" fill="#fff" opacity=".85">3</text>
</svg>
"""


def font(size):
    for name in ('segoeuib.ttf', 'arialbd.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def icon(size, maskable=False):
    """Phones round or cut the corners themselves; a "maskable" icon keeps its text in the middle 80%."""
    img = Image.new('RGB', (size, size), RED)
    d = ImageDraw.Draw(img)
    scale = 0.8 if maskable else 1.0
    big, small = font(int(size * 0.33 * scale)), font(int(size * 0.17 * scale))
    d.text((size / 2, size * (0.5 - 0.06 * scale)), 'AEF', font=big, fill=WHITE, anchor='mm')
    d.text((size / 2, size * (0.5 + 0.24 * scale)), '3', font=small, fill=WHITE, anchor='mm')
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, 'icon.svg'), 'w', encoding='utf-8') as f:
        f.write(SVG)
    for size in (180, 192, 512):
        icon(size).save(os.path.join(OUT, f'icon-{size}.png'), optimize=True)
    icon(512, maskable=True).save(os.path.join(OUT, 'icon-maskable-512.png'), optimize=True)
    print('Icons written to', OUT)


if __name__ == '__main__':
    main()
