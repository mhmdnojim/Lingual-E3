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
| **On this computer** | Only on your computer: the books of the American English File discs — **Level 1, Level 2 and Level 3** (see *Several levels* below). They are never on the website. |
| **Admin** | Only for admins of the website: reports, hiding and deleting books. |

**Branches.** The library is in branches, folders in folders: a main branch (for example
**Learning English Courses**), in it its sub-branches (**American English File 2e**), in those
theirs (**Level 1**, **Level 2** …), and in a branch its books. A book in no branch is at the top,
next to the main branches. The bar above the books shows where you are (click a name to go back
up); the browser's Back button goes up too, and the library opens again in the branch you were
in. **Find a book** looks in every branch, also by their names. A book is put in a branch when it
is added (**Branch**: the one that is open) or later in its settings.

**Admins make the branches** (on this computer you are the admin; on the website, the owner —
the account in `LB_ADMIN_EMAIL` — and the helper admins the owner makes in the Users tab). In the bar above the books: **New main branch** (at the top) or **New
sub-branch** (in the branch that is open). Admins also see the branches with nothing in them yet
(**Empty**), to fill them; the others see only the branches with books.

**Like folders and files.** Every branch and every book has a **⋮** button (or right-click it, or
press and hold on a phone) with:

| | |
|---|---|
| **Rename…** (F2) | A branch, a book — also the disc's books: only their name in the app changes. |
| **Cut** (Ctrl+X), then **Paste** | Open the branch to put it in, then **Paste** in the bar above the books (Ctrl+V). A branch takes its books and branches with it. |
| **Copy** (Ctrl+C), then **Paste** | A copy of a book is the same book in one more branch (a link): it takes no space, can have its own name (**Copy** on its card), and shares the corrections and audio of the book. A copy of a branch: the same branches, with copies of their books. |
| **Move to…** | Into a branch chosen from the list, without opening it. |
| **New sub-branch…**, **New parent branch…** | A branch in it, or a new branch around it (made where it is; it goes inside). |
| **Delete…** | A branch: what was in it goes into the branch above; no book is deleted. A copy: only the copy. A book: the book, with its copies. |

**This branch** in the bar above the books has the same menu for the branch that is open. Your own
books (not admins) can be renamed, cut, copied and pasted the same way, into the branches there are.

**The tree on the left.** All the branches as a tree, like the folders on the left of Windows
Explorer; the books of the open branch are on the right. Click a branch to open it (it is marked):
it also unfolds in the tree, to show the branches in it, and a click on it again folds it. **›** only
unfolds or folds it, without opening it (the tree remembers it). With the keys: ↑ ↓ to go, → to open,
← to close (or up), Enter to show it. Right-click a branch for its menu (also **Paste into it**).
**Drag** a book or a branch onto a branch of the tree (or onto a branch's card, or a name in the bar
above the books) to move it there; hold **Ctrl** while dropping for a copy. A branch does not go
into itself. The button left of the tabs hides or shows the tree; the line between the tree and the
books can be dragged to make it wider. On a phone the tree comes over the books with that button; it
stays while branches are unfolded or folded, and goes away when a branch with no branches in it is
chosen (or the books next to it are tapped).

**Add a book** (button at the top):

| Kind | What happens |
|---|---|
| **Text** | Paste or type a text (an empty line starts a paragraph; a line starting with `#` is a heading), add a picture if you like. It is set into pages. |
| **PDF** | Up to 300 pages are used (choose which ones: **Pages to use**, e.g. `3-120`). At most 500 MB on this computer (and for a website's admins: a whole textbook is often 80–220 MB), 60 MB for the other accounts of a website; a bigger file is refused before it is sent, with its size. Text in the PDF is used as it is; scanned pages, and pages whose text is broken, are read with OCR. |
| **Word** | A Word file (`.docx`, `.doc`, also `.rtf` and `.odt`; the same size as a PDF). The app makes it into a PDF first, with its pictures and tables (`web/office.py`: Microsoft Word on this computer, its macros never run; LibreOffice on a website's server), and then it is a PDF book: the same questions, sample and **Download the PDF**. The Word file is kept in the book's `source/` folder. Without Word or LibreOffice the Word tab says to save the file as a PDF in Word and add the PDF. |
| **Photos of pages** | One photo per page (in the order of the file names). The words are read with OCR. Photograph straight from above, in good light. |

For a PDF, a Word file or photos the app first asks about the pages: their **language** (OCR reads that
language; it warns when this computer cannot read it from pictures yet: add the language in the
Windows Settings, with “Optical character recognition”), for Chinese **is there pinyin** (none,
some, or over every line; the lines of pinyin can be left out of the text), and which pages to use.

**Then it makes a sample first:** 1 to 5 pages chosen at random from the whole book (1 of a very
short one, 5 of a long one), each shown next to the words read from it. **The app noticed** says
what it sees and what to change: for example *“There are lines of pinyin on page 12”*, *“The PDF’s
own text of page 40 was broken”*, *“This PDF is a scanned book: the text … is hidden under the picture
of the page, made by OCR when it was scanned”* (OCRmyPDF and the like: text you can select, but it
is OCR's, with its mistakes), *“Page numbers or headings … are read as text too”*; **Change it
and try again** does that. Under **Something to change?**:

| Choice | What it does |
|---|---|
| Language, pinyin, pages to use | As above. |
| Read every page with OCR | (PDF) When the PDF's own text shows strange letters, or is OCR's text hidden under a scan (the app's OCR may read it better: compare the sample both ways). A PDF made with its text (Word, InDesign …) is best with its own text: exact, no reading mistakes. |
| Leave out page numbers, headings and footers | Short lines at the very top and bottom of the pages. |
| Make the pictures clearer | For faint, dark or small print: grey, full contrast, sharper and bigger before OCR. |
| Fix the same mistake on every page | One per line, `what the app read → what it should be` (e.g. `IäoshT → lǎoshī`, `rn → m`). |

**Try again on these pages** shows the same pages made with the changes (to compare), **Show other
pages** others. When it looks right, **Make all … pages** makes the book the same way. **Finish
later** keeps it in **My books** (“Not finished”): click it to go on.

**Designs of the pages.** A textbook repeats a few designs of page: in every unit the same page of
dialogues with their new words beside them, the same page of grammar, of exercises … Before the
first sample the app looks at all the pages (drawn small: some seconds for 200 pages) and groups
those that look alike (web/designs.py): *“The app found 4 designs of page”*. Only pages much more
alike than two pages of the book usually are make a design: a book whose pages all look different
(magazine-like) has few designs, or none. The first sample is a page of each design (and others at
random up to its size). What is read on it becomes the design's suggested **areas** (frames), drawn
on the page and numbered in the order they are read; their colour says what is in them:

| Area | How it is read |
|---|---|
| Text (blue) | As the app finds it. |
| One paragraph (blue) | All text in this outline belongs to one paragraph; its sentences are split normally. |
| Heading (brown) | Read as one unit, including a title with punctuation such as “OMG! Where is my passport?”. |
| Separate exercise lines (teal) | Each line is a separate reading unit. Use separate outlines for table cells or columns. |
| Dialogue (green) | Also without the speakers' names at the start of the lines (“A:”, “王方：”, “Wang Fang:”). Found by itself when two lines start so. |
| New words (purple) | Each row: the word, then its meaning (number, pinyin, part of speech left out), also when the app cannot find the list's columns. Found by itself under a heading “生词”, “New Words”, “Vocabulary”. |
| Don't read (grey, dashed) | Left out (the speakers' pictures, the page headings, an English version …). |

Click **Review all pages and paragraph outlines** in the sample review. Every selected source
page is available through thumbnails, **Previous / Next**, and the page selector. A page's text
is read on demand, so a large scanned book does not need OCR of every page before review starts.

The default is **Edit this page only**. Each page gets its own paragraph outlines. Click an
outline or its number to select it and see its text. Drag it to move it, drag its corners to resize
it, or enter **Left, Top, Width, Height** percentages. Draw on an empty part of the page to add
an outline. Use **↑ / ↓** to change reading order, **✕ / Delete** to exclude a paragraph, and
**Undo** to take back a change. Changes stay while navigating between pages. Text outside an
individually reviewed page's outlines is excluded; the editor reports how many detected words
are outside. Saving a page with no outlines deliberately leaves that page without readable text.

**Edit all pages of this design** changes a shared template. Pages with individual saved layouts
keep their own changes. Shared templates retain their earlier behaviour: words outside the boxes
go with the nearest area. Use **Don't read** to exclude text through a shared template. **Its
design** moves a page to another template or a new one of its own.

**Save layouts and preview reading** saves the layouts and reads the sample again. Then
**Make all … pages** applies them to the finished book. The original PDF/Word file and page
pictures stay intact. Local review is always available: it adds conservative column-gap
separation and support for large opening capitals, but it cannot guarantee automatic
understanding of every textbook exercise. Word files use this same review after being converted
to PDF.

### Optional AI layout suggestions

An administrator can enable **Analyze layout with AI** in the page-layout editor. This is an
explicit, optional second opinion for difficult pages; it does not run automatically during
upload, and it never replaces the local OCR text. The server sends the selected page image and
the OCR word boxes to the configured OpenAI Responses API. The model returns only groups of the
existing word IDs, using structured JSON; the server turns those groups back into rectangles,
checks that every word is assigned once, rejects overlapping or invented groups, and preserves
the current outlines if the request fails. Results are staged as a preview, so the user must
choose **Preview AI outlines** and then **Save layouts** before anything changes.

To configure it, open the administrator settings and enter a dedicated OpenAI API key and a
compatible vision/structured-output model (the default is `gpt-4.1`). The key is kept on the
server and is never sent to the browser or included in an error message. A deployment may use
`OPENAI_API_KEY` as a server environment fallback; reusing the saved image-generation key is a
separate opt-in setting. Administrators may allow book owners to use the feature, with a small
server-side daily request limit. Requests are not stored by the API (`store: false`), but normal
provider usage and billing still apply. If the page is already cached, choosing **Analyze** again
uses the saved result; **Analyze again (new paid request)** explicitly refreshes it.

Pinyin in scans and photos can be read with wrong tone marks. When Chinese is the main language,
the app keeps Chinese and English and filters detected pinyin from the extracted text. Check the
sample: OCR and pinyin detection can make mistakes. Chinese text is clickable character by
character; the reader uses language-specific voices when available and provides translation.
Pinyin misread by OCR ("w6men shi ldi", "y6u shi jib zhGowd") is left out too, also when OCR put
it on one line with what is beside it on the page (a speaker's name, a box of new words); books
added before lose it once, when the app starts. English stays (also English that looks a little
like pinyin).

**Lists of new words** (生词 New Words: "⑧ 服务 fúwù v. serve"): each row is a paragraph of its
own, in the order of the list: the Chinese word, then its meaning (also a meaning on several lines,
above the middle of its row too). The row's number, pinyin and part of speech are left out (the
pinyin and part of speech stay when the lines of pinyin are kept). The app finds a list by its
parts of speech one under the other (n., v., adj., m., suf. …), and also the rows whose part of
speech OCR misread, by their word or pinyin; two lists side by side are two lists. Where OCR did
not read a row's word, its meaning is there alone: add the word to it. The text beside the list
(the dialogue) is not cut by the list's lines. Pages read before keep their sentences: to have a
list so, read its area again (or the whole page).

**Choices of an exercise** on one line ("A 换房子 B 买空调 C 去女儿的初中", "a went b was going c
had gone"): each choice is a sentence of its own, and so is each question ("(2) 王一雪为什么……",
also when it comes after the choices on their line). Letters in other text stay ("neither A nor
B"). Pages made before are cut so once, when the app starts (corrected pages too: only cut, their
words stay).

**Dialogues** in Chinese books: the names of the speakers under their pictures (small characters
on a line of their own: "刘明", "王一雪") and the pictures as OCR reads them ("(O", "(0)") are left
out of the text, so they are not read with the dialogue. Pages made before lose them once, when
the app starts.

**Full stops OCR did not read** (Chinese read with OCR: an area, the whole page, scans and photos;
OCR often leaves out the "。" of a larger print): each character takes a cell of the same width,
and so does a stop, so the app looks at the page picture where a cell is empty after a character
(between two characters, or at the end of a line). A small ring low in it is a "。": it is put
back, and the sentence ends there ("我觉得这个星期就能搬家。| 我明天去买一些纸箱，很快就能准备好。").
A "0" or "o" OCR read for one becomes "。" too. Commas are read by OCR; the **Clause** mode reads
from comma to comma. Corrected pages read before get their stops back once, when the app starts.

**Read which language** (中+EN · 中 · EN in the top bar, or Settings → Voice → *Read*): Chinese
books keep their own choice (中+EN at first), so EN chosen in an English book does not silence
them. With EN (English only) the Chinese is skipped, and with 中 the English: the app then says so
once, with what to choose. Without a Chinese voice on the device, it says how to get one.

**Chinese and English are never one sentence.** Where a line goes on in the other language (a
Chinese heading and its English: *主谓谓语句 | Sentences with a Subject-Predicate Phrase as the
Predicate*), each is a sentence of its own: heard, translated and broken down by itself. Chinese
in quotation marks stays in its English sentence (*Aspect Particle “着”*), and so do a few Chinese
characters in English (*In this case, 多 and 几 are interchangeable*) and a word or two of English
in Chinese (*我在用 iPhone 打电话*). Books added before are made so once, when the app starts (from
their words: nothing is read again; in pages you corrected, sentences are only cut, never joined).

When the pages are ready, the book opens. Every sentence can be clicked, as described below.

**Share a book with everyone:** in the library click the settings button of the book (or, in
the book, the page list → **About** → **Settings and sharing**), tick **Share with everyone**,
choose its **licence** and confirm that you may share it. Only share your own work, texts in the
public domain, or texts with a licence that allows sharing (for example Creative Commons).

**Report a problem** with a public book: page list → **About** → **Report a problem**.

Others' public books can be read, listened to and translated, but only their owner corrects them.

## Import books from an old app

In the library, click **Import old app** (next to **Add a book**). This runs inside Lingua
Books; you do not need VS Code, Codex, or an AI API key to use it. Restart the Python server
after installing this update, then refresh the browser.

1. **Upload files:** choose one ZIP or use **Choose folder** to select the old app folder.
   Keep its directory structure, including `.shared/content`, `.shared/books` and
   `.shared/assets` for an iTools app. A typed Windows path is not an upload: use the picker.
2. **Inspect the old app:** the app inventories formats and reports supported collections
   and limitations. Uploaded programs are never executed, and the original folder is unchanged.
3. **Choose what to convert:** select books, page language(s), page range, OCR settings and
   repeated text corrections. The range applies to the available pages of each selected
   collection. Leave it empty to import all available pages. Chinese extraction keeps Chinese
   and English and filters detected pinyin; check its accuracy in the sample.
4. **Review sample pages:** inspect 1–5 sample pages. Change settings and regenerate samples
   as needed. Tick the review confirmation before converting. Changing settings requires a
   fresh sample; the application does not silently approve it.
5. **Convert pages:** pages are saved individually. Cancel pauses processing after the current
   page; retry continues from valid saved pages. Close and reopen the importer to find previous
   jobs. If an upload was interrupted, select the same source again to resume it.
   **Remove import files** frees stored uploads, previews and export files after confirmation;
   it also removes unfinished imported books. Completed library books and the original folder
   are kept. Pause a running job before removing it. Removed import progress cannot be recovered.
6. **Validate and export:** open the converted private books, or download a content ZIP and
   import report. Each numbered step has counts and progress; 100% means packaging finished.

Supported inputs: recognized iTools page tiles, PDFs, and folders of page images. iTools imports
also preserve supported MP3/WAV/OGG/M4A audio, MP4/WebM video, XML cue transcripts and links
between imported pages. Missing pages/media and unsupported activities appear in the report.
Flash/SWF activities and FLV video are **not converted by this importer**. Unrecognized apps
need a format-specific adapter; this is not a universal executable-to-website converter.

Converted books use the current reader's sentence editing, translations and voice tools.
New voices/offline recordings are generated separately in the reader, not during import.
The export contains books, text, supported media and a report—not a standalone website or
the uploaded application's source code. Keep the original source and only import content
you are allowed to use. Do not upload passwords, keys or personal app data.

The engine uses built-in Python format adapters, Pillow tile stitching, PDF text extraction
and the app's existing OCR. It does not call an external AI service. Scans still require the
appropriate OCR languages on the computer/server. On a hosted website, processing runs on
that server, not on the visitor's laptop; see `deploy/README.md` for limits and storage.

## On phones, tablets and computers

The app works on Android phones and iPhones, on tablets (iPad, Android tablets) and on computers
(Windows, Mac, Linux), each with a layout of its own:

| Layout | For | What it is like |
|---|---|---|
| **Phone** | a touch screen up to 700 px wide (and a computer's window as narrow) | Top bar in two rows, the panel at the bottom, swipe and pinch (below). |
| **Tablet** | a wider touch screen: an iPad, an Android tablet, a phone turned sideways | The computer's layout made for fingers: bigger buttons and text; the top bar in two rows when it is upright (a phone sideways: one row, scrolled sideways); the Text panel beside the page. |
| **Computer** | a mouse or a touchpad | The top bar in one row (two in a window under 1280 px); the panel beside the page. |

**Automatic or chosen.** The app finds which it is by itself (**Automatic**), and changes when a
phone is turned or a window made narrower. To choose one yourself: **Settings → Screen**
(the sliders button), or **Screen** at the bottom of the library: Automatic, Phone, Tablet or
Computer. The choice stays on that device (each phone, tablet and computer keeps its own). A
computer's layout chosen on a phone draws the page wider, as a browser's "desktop site" (pinch to
zoom).

**Which browsers.** iPhone and iPad: Safari (iOS 15.4 or newer: an iPhone 6s or newer, updated);
Android: Chrome, Samsung Internet or Firefox; computers: Chrome, Edge, Firefox or Safari. A
browser too old for the app says so, with what to do, instead of an empty page. iPhone photos
(HEIC) are sent as JPEG by themselves. On iPhones with a notch, nothing is under it when the
phone is turned.

On a phone:

| On the phone | How |
|---|---|
| Hear a sentence | **Tap** it (with translations on the page, its translation shows too). |
| Turn the page | **Swipe** left or right on the page. |
| Zoom | **Pinch** with two fingers (back to the width of the screen: pinch in). |
| Text, Script, Search, My audio | The panel at the bottom: tap a tab to open it, the open tab to close it, drag the bar on top to make it taller. |
| Correct a sentence | **Double-tap** it in the Text list. Drag its **number** to move it. |
| Break a sentence down | **Hold your finger** on it (half a second), on the page or in the Text list: each word, its meaning (and pinyin). |
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
| Break a sentence down | **Double-click** the sentence on the page (on a phone or tablet: **hold your finger** on it, on the page or in the Text list). Or point at it (or click it): a small teal button appears beside it (and beside the sentence being read); it stays with that sentence while you cross the next one to reach it. Click it (or press **B**): the sentence and its translation, then every word with its meaning in that sentence (the language of the Translation tab); words translated together are one part (*You're going to read* → ستقرأون, *an article* → مقالاً), and **word by word** shows each of them with its own meaning. 🔊 hears the sentence, the translation, a part or its meaning, at the **Speed** chosen there; **Play all** reads each part, then its meaning. Pointing at a word marks it in the sentence and its meaning in the translation (each at its own place there, also when the same meaning is there twice). A **Chinese** sentence has its **pinyin** over every character and beside every word (*银行 yínháng → the bank*), made on this computer without the internet, as textbooks write it (行 háng in 银行, xíng in 行李; 不是 bú shì; 哪儿 nǎr). Also in the books you add to the library. |
| Hear a part of the page | The **area** button next to **Read page aloud**, then draw a box on the page: the sentences in it (in Clause mode: the clauses) are read one after the other, each highlighted while it is read. **Esc** cancels the box. |
| The Text list | Every sentence is numbered and on a line of its own, each translation under its sentence. |
| Fix a sentence quickly | **Double-click** it in the Text list, change it, press **Enter** (**Esc** cancels). |
| Move a sentence | In the Text list, drag it by the **dots** on its left (they appear when the mouse is over it). |
| Correct the text | Click the pencil button in the **Text** tab for all the tools (see below). |
| Choose the voice and speed | Click the sliders button next to **Off** (the settings), **Voice** tab. |
| Pause between sentences | In the same place, **Pause between sentences** adds silence after each sentence (from none up to 10 seconds) before the next one is read — time to repeat it aloud. The bar at the bottom counts down. |
| Follow the reading | The sentence being read stays **in the middle of the page** (and of the Text list) while the app reads or an MP3 plays. When you scroll, swipe or zoom the page yourself, it stays where you put it, and after a few seconds it follows again by itself. While the word being read is off the screen, it is shown **at the top middle of the page, word by word**, with an arrow up or down to where it is: tap it to go back to the reading. The button with the target in the reading bar (or **F**) switches following off and on. Settings → **Follow**: on/off, where on the page (middle, near the top, or only when the sentence leaves the screen), scrolling speed, how long to wait after you scroll, and the Text list. |
| Repeat each sentence | In the same place, **Repeat each sentence**: once, 2 … 10 times, or **∞** (again and again until you click another sentence, pause or stop). The bar at the bottom shows “2nd time of 3”. The pause between sentences is also made between the repeats. It works for your My audio MP3s, the recordings and the videos too (each line of their script; “2/3” under its time). Quicker: the **repeat** button at the top (next to the translate button), on the Script tab or next to a video — each click goes 2, 3, 4, 5 times, ∞, then back to once; the number shows on the button. **R** does the same. |
| Copy or save the page text | Use the copy and save buttons in the **Text** tab. You can also save a whole book's text. |
| Listen to recordings | Click a red **headphones** button on the page. The **Script** tab opens (also when the panel was closed) with the audio script, which follows the recording. Click a line to play it; click the line being played to **pause**, and again to **play**. Over the script: the two **translate** buttons (under every line, or when you point at a line), the **repeat** button and the language. Recordings that have no script on the disc have one made by **speech recognition** (it says so: it may have mistakes). A recording without any script has a **Transcribe** button (see *Speech recognition* below). |
| Make your own MP3 | **My audio** tab → **New audio** (see below). |
| Translate the text | Settings (sliders button) → **Translation** tab to choose the language. Then the **translate** button at the top shows or hides the translation on the page, and the one in the **Text** tab the translations in the list (see below). |
| Watch videos | Click a purple **video** button. The script is shown next to the video: click a line to play it, the line being played to pause and play. Over the script: two buttons translate it (**under every line**, or in a box **when you point at a line** — tap it on a phone), the **repeat** button, and the language. |
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
| + / − / 0 | Zoom in, zoom out, fit — step by step in and then out again: the whole page → the page width → the paragraph → the sentence → the word you are on → its sentence → its paragraph → the page width → the whole page → … (as wide as the screen, in the middle; while reading, the next paragraph or sentence when the reading gets there, and zoomed to the word, the page goes along with the word being read). Zooming in any way (also **Ctrl + mouse wheel**) keeps the sentence you are on — being read, or clicked last — in the middle of the screen (the whole page: all of it; the page width: in the middle up and down) |
| P | All pages |
| T | Show or hide the side panel |
| S | One page or two pages |
| / | Search |
| Space | Pause or continue reading (or the recording) |
| Esc | Stop reading |
| E | Start or finish correcting the text |
| L | Show or hide the translations in the Text list |
| R | Repeat each sentence: once → 2 → 3 → 4 → 5 → ∞ → once |
| F | Follow the reading (keep the sentence being read in view): on / off |
| N | Add new words: on / off (see *New words and flashcards*) |
| C | Flashcards |
| B | Break down the sentence pointed at (or being read, or clicked last) |
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
| Split a sentence into several | **Split** (the scissors), then click the word that starts each new sentence, in the list or on the page (click again: not any more). The words after 。？！ . ? ! are marked to begin with. Each new sentence is shown in its color, in the list and on the page, with the number it will have. **Split into N sentences** (or **Enter**) makes them all; one **Undo** joins them again. |
| Join a sentence that was cut in the middle | **Merge ↑** (with the sentence before) or **Merge ↓** (with the sentence after). This also joins paragraphs. |
| Change the order | **Drag** the sentence by the dots on its left (they appear when the mouse is over it) and drop it where the blue line shows: between two sentences, at the end of a paragraph or at the start of the next one. Or use **Move up** / **Move down** to swap it with the sentence before / after. |
| Start or join a paragraph | **New paragraph** / **Join paragraph**. |
| Add a missing sentence | **Add after**, type it, press **Enter**. Then **Mark on page** and drag a box around it on the page, so it can be clicked there too. |
| Remove a sentence | **Delete**. |
| Missing or badly read text in one place (or several) | **Re-read text by area**: drag a box around it on the page, then the next one, as many as you need, one after the other (they are numbered on the page; **Take back the last box** if one is wrong). Then **Read** them (or press **Enter**): check what was found in each, then add it or let it replace the words there (for each area). While you check, each sentence found is outlined on the page in its own color with its number, as in the list (unticked: grey), so you can see what the boxes missed: **+ Draw more areas** adds more boxes to the same review (your changes in it stay), and everything is added together. Either way it goes where it is on the page (replacing: where the old words were, in the middle of their paragraph), so the sentences stay numbered one after the other. One **Undo** takes back all the areas. Paragraphs read in an area (the rows of a list of new words) stay paragraphs. Each line is read across first: where OCR cut it in pieces — at a blank to fill in (“work for a ¹______ called…”: the blank's small number is left out), after a speaker's name or a number at the start of the line (“1 Jenny Don't forget the chocolates.”) — the pieces are put back together, and the lines are read column by column, each from the top (also with **Read the whole page again**). Two columns side by side stay apart. |
| Read the whole page again | **Read the whole page again**. The steps are shown one after the other with a bar (**Stop** or **Esc** stops it; nothing changes). The sentences you corrected (changed, split, joined, typed, re-read by area, placed on the page) stay as they are: what is read in their places is left out. Text you deleted before comes back unticked. Check what was found; it then takes the place of the rest of the page's text, in the order the page has now. |
| Replace a picture (your own books) | **Replace a picture**: drag a box around it on the page. Then give the new one: **A picture of yours** (a file, or a photo taken with the phone), or **Made by AI**: **Make a picture** — without a description the AI draws the old picture again, as a new one (with the page's text around it, to go with it). Each picture is shown first, nothing changes yet: not liked, **Make another**, as often as you like; or **Describe it** (what it should show; **Start from the old picture**: the AI changes that one as you say) and make another. Every try stays in a row under it: click one to see it again, and use the one you like. It **fills the box** (its edges cut) or shows **the whole picture** (white around it). **Replace the picture** puts it in the page and, for a PDF, in the book's PDF (**Download the PDF** in the book's Settings): a picture of the PDF inside the box is taken out, a scanned page gets the new one over that part. The words read from the old picture leave the page's text. Each one can be taken back (**Take it back**, in the same window over that page): the page and the PDF as they were. |
| Undo | The undo arrow, or **Ctrl+Z**. |
| Go back to the original text of the page | The restore button (circle arrow). |

**Audio and video of your own books** (the book's **Settings** → **Audio and video**): **Add a
folder…** (for example the folder of the Student's Book audio) or **Add files…**. The app copies the
audio and video into the book (MP3, M4A, WAV, OGG, MP4, WebM; other files are left out) and puts a
play button on every page where a recording's number is printed: `AEF3e_Level_3_SB_1.26.mp3` is
track 1.26, and goes where the page says "⊙1.26 Watch or listen…" (also in the audioscripts at the
back). It says how many have a button, and which ones were not found on a page (a number OCR
misread). **Take them all out** removes them and their buttons. They play like the disc's recordings;
a recording without a script can be transcribed in the **Script** tab, or all of them with **Transcribe
them all** (see *Speech recognition with ElevenLabs*). Add one book's folder to that
book: the Workbook's audio (1.1, 1.2 …) has the same numbers as the Student's Book's (1.01, 1.02 …).

**Changing the play buttons by hand** (correction mode, the pencil → **Play buttons**): the page's
audio and video buttons get a dashed outline and a ×; **Add a play button…** and **Done with play
buttons** show right under the tools at the top of the panel (they stay there while the sentences
scroll), with what to do under them.

| To | Do this |
|---|---|
| Move a button (it covers the number) | Drag it. |
| Take away a button in a wrong place | Click its **×** (the recording stays in the book). |
| Add a button (a recording on no page, e.g. 4.01 that OCR misread) | **Add a play button…**, choose the recording (those on no page are first; type to find one), then click on the page where it goes. **Another file…** adds a new audio or video file first. |

**Done with play buttons** ends it. What you change by hand stays when buttons are placed again (after **Add
files…**): a button you moved stays where you put it, and one you took away does not come back
on that page.

**Pictures made by AI** use OpenAI's image service: each picture costs a few cents, so only an admin
(on this computer: you) can make them. The first time, the window asks for its key
(platform.openai.com → API keys): it is kept in `web\server-config.json`, on this computer only,
never sent to the page again; **Change the key** (under **Made by AI**) replaces it. It must be a key
of OpenAI: keys of other AIs (Kimi, DeepSeek …) are refused, as they cannot make pictures. On a website, the key can also be set as `OPENAI_API_KEY` in the
server's settings (`/etc/lingua-books.env`); `imageModel` in `server-config.json` chooses another
model of the service (`gpt-image-1` to begin with).

In this mode you can also use **↑ / ↓** to select the next sentence, **Enter** to change it and
**Delete** to remove it.
Click **Done** (or press **E**) to finish: the text list stays on the same sentence,
highlighted in the middle, and a click on it reads from there. Changes are saved at once, and they are used by
reading aloud, copying, saving and search. They are kept in `web\edits`, one file per page —
back up that folder to keep your corrections. Rebuilding `web\data` does not touch it.

## My audio: MP3s with a natural or Windows offline voice

You can turn any paragraphs or sentences of a page into one MP3, read by a Microsoft
**Natural** voice (the same voices Edge uses) or an installed **Windows offline** voice.
These are different voices: Windows David or Zira will not sound like Natural Ana or Aria.

1. Open the **My audio** tab in the side panel and click **New audio**.
2. Choose what to read: click the **first** sentence, then the **last** one — everything in
   between is chosen. The box next to a paragraph chooses the whole paragraph, and
   **Ctrl+click** picks or drops a single sentence. This works in the list and on the page.
   The chosen sentences are marked in blue.
3. Click **Create audio…**, give it a title, choose a voice (**Try** plays a sample), the
   speed and the pause between sentences, then **Create MP3**. **Read the translation**
   puts each sentence's translation (the language of the Translation tab) after or before
   it in the MP3, with a voice of that language.
4. An orange **play icon** appears to the left of the paragraph. Click it to play: the
   sentence and the word being read are highlighted, like when the app reads aloud.

**Clicking a sentence that is in one of your MP3s plays that MP3 from that sentence** — no
internet needed. Click the sentence again to pause, another one to jump there. Sentences
without an MP3 are read with the live voice; without internet the app uses the computer's
own (offline) voice.

The **My audio** tab lists all your MP3s (**This page**, **This book** or **All**, with a
search box). From there you can play, **download** the MP3 file or its **subtitles**
(**CC**: an .srt file with the time of every sentence), rename or delete them.

Creating an MP3 with an **online Natural** voice needs the internet; playing it later does not.
**Windows offline** voices generate locally without internet. Available voices depend on what
is installed on the Windows computer running the app (for example David, Zira, or Huihui).
The files are kept in `web\recordings` — back up that folder to keep them.

**Offline audio on this browser:** open **Settings → Voice**. English voice choices show whether
they are offline on this device, online, or have generated audio imported. Choose **Whole current
page**, **Whole book**, **Selected sentences or audio**, or **All saved audio**, then click
**Generate … English**. Only uncached English sentences are generated for the chosen voice. The
rendered MP3s and sentence maps are stored in this browser; when a matching sentence is clicked,
the cached voice plays, while sentences without a cached MP3 continue using the live voice.
Imported packages can be managed under **Imported offline audio files**. **Export folder** copies
  packages into folders organized by book, language mode and voice (Microsoft Edge or Chrome).
  Whole-book generation creates a separate MP3 for each page; the exported voice folder includes
  `book-collection.json`, an ordered index of the page files and their sentence counts. Large pages
  may be split into numbered parts. This keeps page files individually usable while retaining one
  collection for whole-book playback or export workflows.
Choose **Settings → Voice → English voice → Device voices — offline**, then select
an installed Windows voice and click **Generate** for the required scope. The Generate button
appears when that browser voice has an exact counterpart on the app's Windows server.
The **Create audio** dialog also lists the server's installed Windows voices. Windows generation
does not need the online speech service; Natural-voice generation still does. If Microsoft
returns HTTP 403, the app cannot generate that Natural voice; choose Windows offline or retry
the Natural voice later. It never silently substitutes a different voice.
Imported files are local to this browser and may be cleared with browser storage.

The **OFFLINE / ONLINE** badge in the upper-left corner belongs to the current page, not the
whole book. A Windows device voice can speak offline, but it does not mean the page has a
downloaded voice file. Turn to an undownloaded page and its badge shows **ONLINE**.

To delete a downloaded page voice, open **My audio → Offline voice files on this page** and
click its trash button. This removes that browser copy and any remaining server MP3, metadata
and subtitles. If another downloaded voice remains on the page, the app switches to it; after
the last one is removed the badge returns to **ONLINE**. Other pages and voices are preserved.
Dedicated offline page voices use the corner badge, not paragraph audio icons or selection
outlines. Older generated files ending in “offline audio” are recognized too. Server-only
leftovers remain listed for cleanup but do not mark the page downloaded. If deletion fails,
the app reports the error instead of claiming the file was removed.

Deleting an ordinary saved recording also removes its browser offline copy. The separate
**Remove offline copy** action for ordinary recordings keeps their server recording.
Manually exported/downloaded copies outside the app are not deleted.

## Translation

1. Click the **settings** button (the sliders, next to **Off**) and open the **Translation**
   tab. (Clicking a translate button before a language is chosen opens it too.)
2. Choose your language (43 languages, for example English, Arabic, Persian, Turkish,
   Spanish, French, Chinese). Translations are switched on at once.

**Every book is translated from its own language** (the language of its pages, chosen when it
was added). A **Chinese** book (or one in Spanish, Japanese …) is translated into **English**,
the main language, without choosing anything: the translate buttons work at once. Another
language can be chosen for it in the Translation tab; it is kept for all the books in that
language, and the English books keep their own (English is not offered for a book in English,
nor Chinese for a Chinese one). Under the language, the tab says which language the open book is
translated from.

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

**Hear the translation too.** Settings → **Voice** tab → **Read the translation**: **After each
sentence** (the sentence, then its translation, then the next sentence …) or **Before each
sentence** (the translation first). Under it, choose the voice of your language (for Arabic, for
example Hamed or Zariyah; Microsoft Edge has Natural voices for almost all the languages). It
works for a click on a sentence, **Read page aloud**, clauses and words (the word's meaning).
**Repeat each sentence** repeats the sentence with its translation, and the pause between
sentences comes after the translation. **Create audio…** (My audio) and **Generate** (offline
audio) put the translations in the MP3 the same way; offline audio made with the translations
is used only while they are read the same way (and the other way round).

**Recordings and videos** have their own two buttons, over the script (on the **Script** tab, or
next to the video): the first shows the translation **under every line** of the script, the second
shows it in a box **when you point at a line** (on a phone: tap the line). The language list is
next to them (the same language as for the pages; choosing it there does not switch on the
translations of the page). Each script is translated once and saved, like a page.

The translations come from **Google Translate** (free, no account needed) and are saved in
`web\translations` for later use **without internet**. In **Settings → Translation**, choose
**Current page**, **Selected sentences**, or **Whole book**, check the levels you need
(**Sentence**, **Clause**, **Word in context**, **Breakdown (word by word)**), and click **Prepare**.
**Breakdown** saves everything breaking a sentence down shows — the sentence, each word in it, and
each word on its own (**word by word**) — so the breakdown panel works offline too. Preparing explicitly
downloads missing translations, even when **Read using saved translations only (offline)** is
checked; that checkbox controls reading, not preparation. The selected text is sent to the
translation service. No extra confirmation dialog is needed. With that checkbox on, what is not
saved yet shows *not saved offline yet*; the breakdown panel then says so, with **Translate
online**: it unticks the checkbox and gets the missing meanings with the internet.

**Prepare** first checks what is saved already (on this computer only; nothing is sent), then
downloads **only what is missing**. Under the button there is a bar for all of it and one for
every step — **Sentences**, **Clauses**, **Words in context**, **Breakdown: each word on its own** —
with how many are saved (e.g. *526 / 526 saved*); a step that is complete turns green with a ✓.
At the end it says **✓ Completed**. If everything was saved already, it says **✓ Already
prepared** (with the date, when it was prepared in this browser) and asks: **Prepare again**
(download all of it again, replacing the saved translations) or **No need**. Before you click,
the menu also says when the page or book was **prepared before**. While it works, the button
says **Stop**; what was downloaded is kept, and the next **Prepare** goes on from there.

Sometimes the translator gives nothing for a word or a sentence (some names, numbers, very short
pieces). It is asked once; after that it counts as done (*…, 1 without a translation*), so it
does not keep Prepare from being complete. **Prepare again** asks for those again too.

Sentence translations alone do not mean contextual words are saved. Word meanings use the
containing sentence and are stored in `web\translations\<language>\words-context.json` (the words
the translator gives nothing for: `words-none.json`).
In **Word** mode, pointing at a prepared word then works with offline reading enabled.
If preparation fails, completed translations remain saved. Click **Prepare** again to get the
missing items. Back up `web\translations` to keep saved translations. The upper-left
**ONLINE/OFFLINE** badge describes page audio, not translation availability.

If Google gets too many requests in a short time (for example while translating the whole
book), it asks the app to slow down for a few minutes. The app then **waits and goes on by
itself** (the menu shows a countdown); pages already done are saved. The Text list also
tries again by itself.

Machine translation is good for understanding, but it is not always perfect.

## New words and flashcards

**Collect** the words you want to learn, in categories:

1. Click the **bookmark** button at the top (next to the repeat button), or press **N**. A bar
   at the bottom shows **Add to** and the category the new words go to: **New words**,
   **Definitions** or **Common sentences** at first. Click it: a panel opens upwards from the bar
   (the page does not move) with the categories and how many new words each has — click one to
   choose it. At the bottom of the panel, type the name of a new category and press **Add** (or
   Enter): it is chosen at once. The bin next to a category deletes it (its words go back to New
   words; New words itself stays). A click elsewhere or **Esc** closes the panel.
2. Click words on the page (or in the Text list): each one is added to the chosen category at once
   and marked on the page in the colour of its category. **Word**, **Clause** or **Sentence** at the
   top chooses what a click adds — a word, a part of a sentence, or a whole sentence. A click on one
   already in the chosen category takes it out; on one of another category, moves it here. Nothing
   is read aloud meanwhile. The bar counts them (“This page: 3 in New words, 1 in Definitions”).
3. Click the bookmark button again (or **Done**, or **Esc**) to stop. To add more later, click it
   again.

**Practice** them: the **cards** button next to it, or **C**.

- Three lists choose the cards (each choice says how many cards it gives): **Category** (all, or
  one), **Show** (words, clauses and sentences, or only one kind) and **From**: this page, **this
  lesson** (for example 1A Mood food, with its Grammar Bank page), **this File** (1A, 1B and
  Practical English 1), the whole book — or any lesson, File or page that has cards. Lessons and
  Files are known for the Student Book and the Workbook; for the other books: pages or the whole
  book. The same three lists are above the card while practicing: another choice there starts again
  with its cards. The list shows the cards (the dots: how well you know each one); the bin deletes
  one.
- **Start**: a card shows the English (it is read aloud; **Show first: Translation** turns this
  around). **Click the card** (or press **Space**) to turn it over: the meaning in your language
  (the language of the Translation tab) and, for a word or a clause, its sentence with it marked
  and translated. Click again to turn it back. The **≡** icon (or **E**) shows or hides that example
  sentence, whatever the lists show.
- **◀ ▶** beside the card (or the **← →** keys) go to the card before or after.
- **I knew it** (**2**) or **Again** (**1**) answers the card and goes on; a card you did not know
  comes again a few cards later. At the end the app says how many of the cards you answered you knew
  the first time, and offers to practice the ones you missed. Cards you know less well come first
  next time.

The new words and categories are kept by the app's server in `web\words` — back up that folder to
keep them (on a website: in your account) — so the computer and the phones on the home Wi-Fi share
them. Prepared translations (Translation tab → **Prepare**) make the cards work without internet.

## Good to know

- The text was read from the page images automatically (OCR). It is very accurate
  for normal text, but small labels on pictures and maps can contain mistakes.
- Reading flows like normal speech: the app gives the voice up to 10 sentences at a time,
  so it does not stop and wait after every sentence. If you want time to repeat each
  sentence, choose a **Pause between sentences** in the voice settings.
- Voices named “Natural” need an internet connection. Without internet the app
  uses the Windows voices (David, Zira) automatically.
- This copy is for use on your own computer. The book content belongs to Oxford University Press.

## Several levels (Level 1, 2, 3) in one app

This app shows the books of every level listed in `web\levels.json` (in that order), named
**Level 1 Student Book**, **Level 2 Workbook**, and so on; in the library each level's books are
in its `branch` (**Learning English Courses › American English File 2e › Level 1**: made the first
time the app starts with the level; an admin can move or rename it in the app after, and it is put
back only when `branch` in `web\levels.json` changes). Each level stays in
its own folder next to this one, where its disc is unpacked (`.shared`) and its books are built
(`web\data`):

```
E:\en\American English File 2e Level 1   (.shared, web\data)
E:\en\American English File 2e Level 2   (.shared, web\data)
E:\en\American English File 2e Level 3   this app (.shared, web\data) + web\levels.json
```

Everything you add is kept in this app's folder for all levels: corrections (`web\edits`),
translations, My audio, new words, and the scripts made by speech recognition (`web\transcripts`).
Start only this folder's **Start Lingua Books.bat**; the other folders' own copies of the app are
no longer needed.

**Adding a level:** unpack its disc (e.g. the `.rar`: right-click → *Extract Here*) into its own
folder, build its books with this app's tools, then add it to `web\levels.json` and restart the app:

```
powershell -ExecutionPolicy Bypass -File web\tools\build_all.ps1 -Root "..\American English File 2e Level 2"
```

`build_all.ps1 -Root` checks the result at the end (`validate_data.py`). To give its recordings
without a script one made by speech recognition, run `transcribe_all.py` the same way
(`set AEF_LEVEL_ROOT=..\American English File 2e Level 2` first), then `build_data.py` again.
The lessons of its books (for flashcards by lesson or File) are in `web\lessons.json`.

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
| `segment_text.py` | Groups the words into blocks, sentences and clauses (each bullet item on its own, also when OCR missed the bullet: it looks at the page picture); builds the search index |
| `convert_videos.py` | Converts the Flash videos (FLV) to MP4 |
| `build_data.py` | Builds `books.json` (pages, hotspots) and the audio and video scripts |
| `transcribe_all.py` | Writes the scripts of the recordings that have none on the disc, with speech recognition (see below) |

The answer keys are the original Flash files, played by [Ruffle](https://ruffle.rs) (`web\vendor\ruffle`).

**Speech recognition.** About 200 of the disc's recordings have no script. Their scripts are made
on this computer by [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (`transcription.py`,
English model `base.en`), one line per sentence, and kept in `web\transcripts\<id>.json`;
`build_data.py` copies them to `web\data\scripts` like the disc's own, marked `"auto"` in
`books.json` (the app says they may have mistakes). To make them (again):

1. Double-click **`Setup transcription.bat`** once: it installs faster-whisper into
   `web\vendor\python` and the model into `web\vendor\models\base.en` (about 420 MB).
2. `python web\tools\transcribe_all.py` (a few seconds per recording; those done are skipped:
   delete a file in `web\transcripts` to make it again). Restart the app.

Others do **not** need step 1: give them `web\data` (and `web\transcripts`, so a rebuild keeps
the scripts). Step 1 is only needed for the **Transcribe** button on this computer, which a
recording without any script shows on the Script tab (or next to a video): it transcribes that one
in the background (`/api/transcribe`).

**Speech recognition with ElevenLabs** (better: it tells the speakers apart, knows 90+ languages,
needs no setup, and works on a website too). Make a key at elevenlabs.io → **Developers → API
keys** (with *Speech to Text* allowed). In the app: the **Script** tab → **Transcribe a file…**
(or the sliders button next to **Transcribe**) → **Add a key of ElevenLabs** → paste it → **Save
the key**. It is kept in `web\server-config.json` (`speechKey`; or the `ELEVENLABS_API_KEY`
environment variable), never sent back to a page. From then on ElevenLabs makes every
transcription (model `scribe_v2`); **This computer (Whisper)** in the same window goes back to
faster-whisper. Each hour of sound costs ElevenLabs credits, so on a website only an admin can
transcribe (readers see the scripts made). With it:

- **Transcribe** in the Script tab (the disc's recordings and videos without a script, and the
  recordings added to a book) writes that one down.
- A book's **Settings → Audio and video → Transcribe them all** does all its recordings not done
  yet (three at a time), and says how many are done.
- The books **On this computer** (Levels 1–3): the **⋮** menu of a book → **Scripts of its audio and
  video…** → **Transcribe them all** writes again, with ElevenLabs, the scripts of its recordings and
  videos that had none on the disc (those this computer wrote before; the disc's own scripts stay).
  Level 1: 325 of them (5.2 hours of sound), Level 2: 249 (3.9 hours), Level 3: 204 (3.0 hours). The
  new lines are shown instead of the old ones (kept in `web\transcripts`).
- **Transcribe a file…** takes any audio or video file of your computer (MP3, M4A, WAV, FLAC, MP4,
  MOV …, up to 1000 MB; of a video only its sound is sent when ffmpeg is installed by Setup
  transcription.bat). Its language is found by itself. Its lines are shown under it with the
  speakers, as a book's script: click one to hear it (again: pause), repeat, and the two
  translation buttons (under every line, or when pointing at a line) with **Translate into**.
  **Copy the text**, **Download the text** (`[0:03] Speaker A: …`) or **Download subtitles (SRT)**.
  The file is not kept (its lines' translations are, under its content).
- The recordings added to a book are translated in the Script tab like the disc's (the same two
  buttons).

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
