# Lingua Books

**Any text, PDF or photo of a book page becomes a book where every sentence is clickable** —
for learning languages:

- **Hear** any sentence, part of a sentence or word, read aloud (the device's voices); the
  sentence and the word being read are highlighted, on the page and in the text list.
- **Translate** every sentence into 43 languages (under each sentence, or in a popup on the page).
- **Repeat** each sentence 1–10 times or again and again, with a pause to say it after.
- **MP3s** of chosen sentences with natural voices, with subtitles; they play with highlighting.
- **Correct** the text (OCR is never perfect): change, split, merge, move sentences.
- **Your library**: add a text, a PDF or photos of pages; keep them private or share them with
  everyone (with a licence). Reports and an admin page for a public website.
- Works on computers, **Android and iPhone** (tap, swipe, pinch; add it to the home screen).

## Start

- **On your computer** (Windows): install Python, then double-click `Start Lingua Books.bat`.
  All about using it: [web/README.md](web/README.md).
- **As a public website** on your own server (Ubuntu, HTTPS): [deploy/README.md](deploy/README.md).

## How it is made

A small Python web server (`web/server.py`: accounts, the library, OCR, translations, MP3s) and a
browser app without frameworks (`web/js`). Tests drive a real browser at desktop and phone size
(`web/tests`). Only shared or own material belongs in the library: see the
[terms](web/terms.html).
