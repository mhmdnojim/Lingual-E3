"""Pinyin of Chinese text: in the breakdown of a sentence, every character with its pinyin.

Made here, without the internet, by pypinyin (python -m pip install -r web/requirements.txt). The
reading of a character that has several is chosen by the words around it (行 xíng in 行李, háng
in 银行; 长 zhǎng in 长大), and 一 and 不 change their tone as textbooks write it (不是 bú shì,
一个 yí gè). 儿 after 哪 这 那 点 会 玩 块 is the r of the word before (哪儿 nǎr), as textbooks write it.
"""
try:
    import pypinyin
except ImportError:  # (not installed yet: the start file installs it)
    pypinyin = None

MAX_CHARS = 5000  # in one request
ERHUA_AFTER = set('哪这那点会玩块')


class Missing(Exception):
    def __init__(self):
        super().__init__('Pinyin needs the pypinyin package: close the app (its black window) and start it again '
                         'with Start Lingua Books.bat, which installs it (or: python -m pip install -r web/requirements.txt).')


def of_texts(texts):
    """For each text, one entry per character (code point): its pinyin with tone marks, or ''
    (not a Chinese character: punctuation, Latin letters, digits, spaces)."""
    if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts) or sum(len(t) for t in texts) > MAX_CHARS:
        raise ValueError('bad text')
    if pypinyin is None:
        raise Missing()
    out = []
    for text in texts:
        syllables = [x[0] for x in pypinyin.pinyin(text, style=pypinyin.Style.TONE, errors=lambda run: [''] * len(run))]
        if len(syllables) != len(text):  # (never seen: then rather none than wrong ones)
            syllables = [''] * len(text)
        for i, ch in enumerate(text):
            if ch == '儿' and i and text[i - 1] in ERHUA_AFTER and syllables[i - 1]:
                syllables[i] = 'r'
        out.append(syllables)
    return out
