# Lingua Books

Any text, PDF or photo of a book page becomes a book where **every sentence is clickable**:
hear it read aloud (sentence, part of a sentence, or word), translate it into 43 languages,
repeat it, make MP3s with natural voices, correct the text. On computers, Android and iPhone.

It runs in your web browser (Microsoft Edge or Google Chrome) from a small Python program:
on your own computer, or as a **public website** where people sign up, add their books and
share them (see `deploy\README.md`).

## How to start (on your computer)

1. Double-click **`Start Lingua Books.bat`** (in the main folder).
2. Your browser opens the app at `http://127.0.0.1:8765/web/`: the **library**.
3. Keep the black window open while you use the app. Close it to stop the app.

Python must be installed. The first start installs the app's tools (`web\requirements.txt`).
**Microsoft Edge** is recommended because it has the most natural voices.

## The library

| Tab | What is there |
|---|---|
| **Public library** | Books people shared with everyone. |
| **My books** | Your own books. They are private (only you see them) until you share one. |
| **On this computer** | Only on your computer: the books of the American English File disc, if its files are in this folder. They are never on the website. |
| **Admin** | Only for admins of the website: reports, hiding and deleting books. |

**Add a book** (button at the top):

| Kind | What happens |
|---|---|
| **Text** | Paste or type a text (an empty line starts a paragraph; a line starting with `#` is a heading), add a picture if you like. It is set into pages. |
| **PDF** | Up to 300 pages. Text in the PDF is used as it is; scanned pages are read with OCR. |
| **Photos of pages** | One photo per page (in the order of the file names). The words are read with OCR. Photograph straight from above, in good light. |

When the pages are ready, the book opens. Every sentence can be clicked, as described below.

**Share a book with everyone:** in the library click the settings button of the book (or, in
the book, the page list → **About** → **Settings and sharing**), tick **Share with everyone**,
choose its **licence** and confirm that you may share it. Only share your own work, texts in the
public domain, or texts with a licence that allows sharing (for example Creative Commons).

**Report a problem** with a public book: page list → **About** → **Report a problem**.

Others' public books can be read, listened to and translated, but only their owner corrects them.

## On phones and tablets

The app works on Android and iPhone (and tablets) the same as on the computer, laid out for
the small screen:

| On the phone | How |
|---|---|
| Hear a sentence | **Tap** it (with translations on the page, its translation shows too). |
| Turn the page | **Swipe** left or right on the page. |
| Zoom | **Pinch** with two fingers (back to the width of the screen: pinch in). |
| Text, Script, Search, My audio | The panel at the bottom: tap a tab to open it, the open tab to close it, drag the bar on top to make it taller. |
| Correct a sentence | **Double-tap** it in the Text list. Drag its **number** to move it. |
| An app icon | Browser menu → **Add to Home screen**: the app opens full screen. |

**At home, from your phone:** double-click **`Start for phones (home Wi-Fi).bat`**. The black
window shows the address to type on the phone (for example `http://192.168.1.5:8765/web/`)
and a **PIN** to log in. The phone must be on the same Wi-Fi. The first time, Windows asks
whether Python may use the network: allow it for **private networks**. (The PIN is kept in
`web\server-config.json`; delete that file to get a new one.)

**As a public website** (anyone can read the shared books; accounts to add books): see
`deploy\README.md`.

## What you can do

| Feature | How |
|---|---|
| Hear the text | Choose **Sentence** or **Clause** at the top, then click the text on the page (or in the Text list). Reading starts there and goes on to the end of the page. The sentence being read stays in the middle of the Text list. |
| Pause and continue | Click the sentence that is being read: the first click pauses, the next click continues. Or press **Space**, or use **Pause** / **Stop** at the bottom of the page. |
| Start from another sentence | Click any other sentence. |
| Hear one word | Choose **Word** and click a word. |
| Hear the whole page | Click **Read page aloud** in the Text tab. |
| The Text list | Every sentence is numbered and on a line of its own, each translation under its sentence. |
| Fix a sentence quickly | **Double-click** it in the Text list, change it, press **Enter** (**Esc** cancels). |
| Move a sentence | In the Text list, drag it by the **dots** on its left (they appear when the mouse is over it). |
| Correct the text | Click the pencil button in the **Text** tab for all the tools (see below). |
| Choose the voice and speed | Click the sliders button next to **Off** (the settings), **Voice** tab. |
| Pause between sentences | In the same place, **Pause between sentences** adds silence after each sentence (from none up to 10 seconds) before the next one is read — time to repeat it aloud. The bar at the bottom counts down. |
| Repeat each sentence | In the same place, **Repeat each sentence**: once, 2 … 10 times, or **∞** (again and again until you click another sentence, pause or stop). The bar at the bottom shows “2nd time of 3”. The pause between sentences is also made between the repeats. It works for your My audio MP3s too. Quicker: the **repeat** button at the top (next to the translate button) — each click goes 2, 3, 4, 5 times, ∞, then back to once; the number shows on the button. **R** does the same. |
| Copy or save the page text | Use the copy and save buttons in the **Text** tab. You can also save a whole book's text. |
| Listen to recordings | Click a red **headphones** button on the page. The audio script appears in the **Script** tab and follows the recording. Click a line to jump to it. |
| Make your own MP3 | **My audio** tab → **New audio** (see below). |
| Translate the text | Settings (sliders button) → **Translation** tab to choose the language. Then the **translate** button at the top shows or hides the translation on the page, and the one in the **Text** tab the translations in the list (see below). |
| Watch videos | Click a purple **video** button. The script is shown next to the video. |
| See answer keys | Click a green **key** button. |
| Go to another page | Blue **p.104** buttons jump to that page. Use the back arrow to return. |
| Search | Type in the search box (top right). Tick **Search all three books** to search everywhere. |
| See all pages | Click the grid button (top left). The **Resources** tab has the PDF and PowerPoint files. |
| Two pages side by side | Click the open-book button next to the zoom buttons. |

## Keyboard shortcuts

| Key | Action |
|---|---|
| ← / → | Previous / next page |
| 1 2 3 4 | Click mode: Sentence, Clause, Word, Off |
| + / − / 0 | Zoom in, zoom out, fit page or width |
| P | All pages |
| T | Show or hide the side panel |
| S | One page or two pages |
| / | Search |
| Space | Pause or continue reading (or the recording) |
| Esc | Stop reading |
| E | Start or finish correcting the text |
| L | Show or hide the translations in the Text list |
| R | Repeat each sentence: once → 2 → 3 → 4 → 5 → ∞ → once |
| Ctrl+Z | Undo the last correction |

## Correcting the text

The page text was read from the images automatically, so sometimes it needs fixing.

**Quick fixes, right in the Text list:**

- **Double-click** a sentence: it turns into a box. Change the text and press **Enter** (or
  **Save**); **Esc** (or **Cancel**) leaves it as it was. Emptying the box deletes the
  sentence. **More tools** opens all the tools below on that sentence.
- **Drag** a sentence by the dots on its left and drop it where the blue line shows.
- **Ctrl+Z** undoes the last change.

A single click still reads the sentence (a moment later, in case it is a double click).

**All the tools (correction mode):**
Click the **pencil** button in the **Text** tab (or press **E**). Every sentence of the page
is listed, and the sentence you were on (the one being read, or the last one you used) is
already selected in the middle of the list. Click another sentence in the list or on the
page to select it; it moves to the middle of the list. Every sentence is shown as it is —
the selected one is just highlighted. The **tools are in the bar at the top** of the Text
tab (point at a button to see its name); they work on the selected sentence, and a button
that does not fit it (for example **Merge ↑** on the first sentence) is greyed out.

| To… | Do this |
|---|---|
| Change a sentence (fix a word, a capital letter…) | Press **Enter**, double-click it, or use the **pencil** in the bar: it turns into a box. Type, then **Enter** saves (**Esc** leaves it as it was). |
| Split a sentence in two | **Split**, then click the word that starts the new sentence. |
| Join a sentence that was cut in the middle | **Merge ↑** (with the sentence before) or **Merge ↓** (with the sentence after). This also joins paragraphs. |
| Change the order | **Drag** the sentence by the dots on its left (they appear when the mouse is over it) and drop it where the blue line shows: between two sentences, at the end of a paragraph or at the start of the next one. Or use **Move up** / **Move down** to swap it with the sentence before / after. |
| Start or join a paragraph | **New paragraph** / **Join paragraph**. |
| Add a missing sentence | **Add after**, type it, press **Enter**. Then **Mark on page** and drag a box around it on the page, so it can be clicked there too. |
| Remove a sentence | **Delete**. |
| Undo | The undo arrow, or **Ctrl+Z**. |
| Go back to the original text of the page | The restore button (circle arrow). |

In this mode you can also use **↑ / ↓** to select the next sentence, **Enter** to change it and
**Delete** to remove it.
Click **Done** (or press **E**) to finish: the text list stays on the same sentence,
highlighted in the middle, and a click on it reads from there. Changes are saved at once, and they are used by
reading aloud, copying, saving and search. They are kept in `web\edits`, one file per page —
back up that folder to keep your corrections. Rebuilding `web\data` does not touch it.

## My audio: MP3s with a natural voice

You can turn any paragraphs or sentences of a page into one MP3, read by a Microsoft
**Natural** voice (the same voices Edge uses).

1. Open the **My audio** tab in the side panel and click **New audio**.
2. Choose what to read: click the **first** sentence, then the **last** one — everything in
   between is chosen. The box next to a paragraph chooses the whole paragraph, and
   **Ctrl+click** picks or drops a single sentence. This works in the list and on the page.
   The chosen sentences are marked in blue.
3. Click **Create audio…**, give it a title, choose a voice (**Try** plays a sample), the
   speed and the pause between sentences, then **Create MP3**.
4. An orange **play icon** appears to the left of the paragraph. Click it to play: the
   sentence and the word being read are highlighted, like when the app reads aloud.

**Clicking a sentence that is in one of your MP3s plays that MP3 from that sentence** — no
internet needed. Click the sentence again to pause, another one to jump there. Sentences
without an MP3 are read with the live voice; without internet the app uses the computer's
own (offline) voice.

The **My audio** tab lists all your MP3s (**This page**, **This book** or **All**, with a
search box). From there you can play, **download** the MP3 file or its **subtitles**
(**CC**: an .srt file with the time of every sentence), rename or delete them.

Creating an MP3 needs the internet (the voices are online); playing it later does not.
The files are kept in `web\recordings` — back up that folder to keep them.

## Translation

1. Click the **settings** button (the sliders, next to **Off**) and open the **Translation**
   tab. (Clicking a translate button before a language is chosen opens it too.)
2. Choose your language (43 languages, for example Arabic, Persian, Turkish, Spanish,
   French, Chinese). Translations are switched on at once.

The translation can be shown in two places, each switched on and off on its own:

| Where | Switch it on or off with |
|---|---|
| In the **Text** list, under each sentence | The translate button in the **Text** tab (next to the pencil), or **L** |
| On the **page**, in a popup when you point at a sentence | The translate button at the **top** (next to the settings button) |

Both are also in the **Translation** tab of the settings.

Then:

- In the **Text** tab, every sentence has its translation under it (right to left for
  Arabic, Persian, Urdu, Kurdish and Hebrew).
- On the page, **point at a sentence** to see its translation in a small box under the
  sentence (above it when there is no room), so it never covers the sentence. In **Word**
  mode the box also shows the translation of the word.
- While the app reads aloud, the translation of the sentence being read is highlighted too.
- **Copy** and **Save** in the Text tab include the translations, each under its sentence.

The translations come from **Google Translate** (free, no account needed) and are made one
page at a time. Each page is translated only once: it is saved in `web\translations` and
works **without internet** after that. To have the whole book offline, click
**Translate the whole book now** in the Translation tab (you can stop it and go on later; finished
pages are skipped). Back up `web\translations` to keep them.

If Google gets too many requests in a short time (for example while translating the whole
book), it asks the app to slow down for a few minutes. The app then **waits and goes on by
itself** (the menu shows a countdown); pages already done are saved. The Text list also
tries again by itself.

Machine translation is good for understanding, but it is not always perfect.

## Good to know

- The text was read from the page images automatically (OCR). It is very accurate
  for normal text, but small labels on pictures and maps can contain mistakes.
- Reading flows like normal speech: the app gives the voice up to 10 sentences at a time,
  so it does not stop and wait after every sentence. If you want time to repeat each
  sentence, choose a **Pause between sentences** in the voice settings.
- Voices named “Natural” need an internet connection. Without internet the app
  uses the Windows voices (David, Zira) automatically.
- This copy is for use on your own computer. The book content belongs to Oxford University Press.

## For maintenance

Everything in `web\data` was made from the original files in `.shared` by the scripts
in `web\tools`. To rebuild it:

```
powershell -ExecutionPolicy Bypass -File web\tools\build_all.ps1
```

| Script | What it does |
|---|---|
| `stitch_pages.py` | Joins each page's image tiles into one page image and a thumbnail |
| `ocr_windows.ps1` | Reads the text on each page with the Windows built-in OCR |
| `segment_text.py` | Groups the words into blocks, sentences and clauses; builds the search index |
| `convert_videos.py` | Converts the Flash videos (FLV) to MP4 |
| `build_data.py` | Builds `books.json` (pages, hotspots) and the audio and video scripts |

The answer keys are the original Flash files, played by [Ruffle](https://ruffle.rs) (`web\vendor\ruffle`).

Text corrections are stored separately in `web\edits\<book>\<page>.json` (same format as
`web\data\text`). The local server (`server.py`) reads and writes them through `/api/text/…`
and merges them into search through `/api/search/…`.

Translations are made by `translate.py` (through `/api/translate` and `/api/translate-word`), with
Google's page translator (the one Chrome uses) and, if that fails, Google's older free address,
and saved in `web\translations\<language>\<book>\<page>.json`, one entry per English
sentence. If a sentence is corrected, only its paragraph is sent to the translator again.

The login (`auth.py`, `login.html`) is used whenever the app can be reached from other devices:
`server.py --lan` (home Wi-Fi, with a PIN) or `server.py --proxy` on a web host (the password
in `AEF_PASSWORD`). On this computer alone there is none. The phone icons in `web\icons` are made
by `web\tools\make_icons.py`.

The code is kept with **git** (see `.gitignore`: only code; not the book content, not your data).
Tests: `cd web\tests`, `npm install` once, then `node ui-test.mjs` (`ONLY=phone` or `ONLY=login`
runs just those parts).
