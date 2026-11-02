# Lingua Books: React rebuild brief

> **For:** Lovable (or another AI app builder, or a developer) rebuilding the Lingua Books reader as a
> React app, and for the person guiding it.
> **Made from:** the project's code on 16 October 2026 (server API version 17). The current app is
> plain JavaScript modules (`docs/reference/web/js`) and a Python server (`docs/reference/server`).
> **Source:** this file is `guide/src/react-brief.md` in the project; `guide/src/build_guide.py` puts it
> into *Lingua Books React kit.zip* together with the reference code, the screenshots and a sample book.

**Contents**

- [How to use this kit](#how-to-use-this-kit-for-the-person) (for the person)
- [Part A: Project knowledge](#part-a-project-knowledge) (paste into Lovable)
- [Part B: Specification](#part-b-specification)
- [Part C: Prompts, in order](#part-c-prompts-in-order)
- [Part D: Pitfalls](#part-d-pitfalls)
- [Appendix: where each feature lives now](#appendix-where-each-feature-lives-now)

---

## How to use this kit (for the person)

1. **Create a new Lovable project** and connect it to GitHub (Lovable makes a new repository and keeps
   it in sync both ways). Lovable cannot import an existing code base, so it builds the app from
   this brief.
2. **Put the kit into that repository:** copy the kit's `docs/` folder and `public/fixtures/` folder
   into the repository's root, and push. Now Lovable can read `docs/BRIEF.md`, the reference code
   and the sample book itself.
   *Without GitHub:* paste Part A as below, then paste the parts of Part B that each prompt names,
   and attach the screenshots that each prompt names. The sample book then has to be recreated from
   the JSON files pasted into chat.
3. **Paste Part A** into Lovable's project knowledge (Project settings → Knowledge). Lovable sends
   it with every message.
4. **Send the prompts of Part C one at a time**, in order. After each one, check its *Done when* list
   in the preview before you send the next. If something is wrong, say what you see and point to the
   section of the brief.
5. **Later, with the real server:** see B2.3. The React app is then built (`npm run build`) and served
   by the existing Python server, so the books of the disc, OCR, translations, natural-voice MP3s and
   speech recognition keep working.

What is in the kit:

| Path | What |
|---|---|
| `docs/BRIEF.md` | This brief |
| `docs/screenshots/*.png` | The current app (book pages are Oxford University Press content: for layout only, never publish them) |
| `docs/reference/web/` | The current browser app: `index.html`, `css/app.css`, `js/*.js` — the behaviour to port |
| `docs/reference/server/` | The current Python server — the truth about the API |
| `public/fixtures/` | A sample book (original text, no copyrighted content) in the app's real formats: page images, page text, a recording with a script, translations, new words |

---

## Part A: Project knowledge

*Paste everything in this part into Lovable's project knowledge.*

```text
PROJECT: Lingua Books — a reader for language learners. Any book page (an image) has an invisible layer
of its words, so every sentence, clause and word can be clicked: it is read aloud with highlighting,
translated, repeated, collected as a flashcard, corrected. Also: audio/video with scripts that follow,
own MP3s made with natural voices, a library of books (text, PDF, photos), phones.

THE BRIEF: docs/BRIEF.md is the specification. Read the section a task names before writing code.
docs/reference/ holds the current (plain JavaScript + Python) app: port its behaviour, do not copy its
structure. docs/screenshots/ shows the current look.

STACK: React 18 + TypeScript + Vite + Tailwind + shadcn/ui; TanStack Query for server data; a small
Zustand store per area for UI state; HashRouter (routes "#/" = library, "#/<bookId>/<page>" = reader,
same as the old app so bookmarks keep working).

BACKEND: the existing Python server and its JSON API (docs/BRIEF.md B4). Never call Google Translate,
Microsoft voices or OCR from the browser: always through the API. All calls go through src/api/client.ts.
VITE_API_MODE=mock (default in Lovable) answers from public/fixtures/ (B2.4); VITE_API_MODE=server
uses the real server on the same origin.

PAGE GEOMETRY: page text uses page-image pixels. Words are [x, y, w, h, text, line, spaceAfter]; sent,
clause and blocks are [first, end) index ranges (end not included). Draw the page as an <img> with an
<svg viewBox="0 0 W H"> on top in the same box, so boxes line up at any zoom without maths.

ENGINES OUTSIDE REACT: the reading queue (Reader), speech, the audio player, following the reading and
the text-correction model are plain TypeScript classes/modules with small event APIs. React components
subscribe to them; highlights change many times a second, so update them without re-rendering the page.

PORT EXACTLY (algorithms in BRIEF B7): PageText (unitAt, rects, hitRects, speech/wordAtChar),
speakable(), clauseRanges() + tokenize(), the editor model (toModel/toDoc/alignWords), search fold().

UI: plain, short English labels like the screenshots; light and dark theme from CSS variables (B5.6);
works at phone width (<700px: panel becomes a bottom sheet, touch gestures, B6.19); every icon button
has a title and aria-label; keyboard shortcuts as in B6.18.

DO NOT: invent API endpoints or fields; store user data only in localStorage (the server keeps it);
use HTML5 drag-and-drop (use pointer events); include any book content other than public/fixtures.
```

---

## Part B: Specification

### B1. The product

Lingua Books turns the pages of a book into something a language learner can click.

- **Pages** are images; the words on them were found by OCR (or by drawing the text), so each word
  has a box on the image. Words are grouped into **sentences**, **clauses** (parts of sentences)
  and **blocks** (paragraphs, headings, list items).
- **Click to hear.** A mode (Sentence, Clause, Word, Off) decides what a click on the page selects.
  A click reads from there to the end of the page, with the sentence and the current word highlighted;
  a click on the sentence being read pauses and continues.
- **Around that:** a side panel with the page text (Text), the script of the recording or video that
  plays (Script), search (Search) and the person's own MP3s (My audio); translation into 43 languages;
  repeating sentences; following the reading; text corrections; new words and flashcards; a library of
  books; phones and tablets.
- **Who:** learners on their own computer (Windows, Edge or Chrome), on phones at home (the same
  server on the home Wi-Fi with a PIN), or on a public website with accounts.
- **Books:** the three books of the *American English File 3* disc (only on the owner's computer, never
  on the website), and library books people add: a text, a PDF, photos of pages, or an old app
  imported.

### B2. Architecture

#### B2.1 Stack

| Concern | Choice |
|---|---|
| Framework | React 18, TypeScript (strict), Vite |
| Styling | Tailwind CSS with the colour tokens of B5.6 as CSS variables; shadcn/ui for dialogs, tabs, selects, sliders, toasts, popovers |
| Routing | `HashRouter`: `#/` library, `#/:book/:page` reader (`#/1705/25` = book 1705, page 25; `#/L5a4d1e0b7c/1`) |
| Server data | TanStack Query (books, page text, translations, recordings, words) |
| UI state | Zustand stores: `settings` (persisted, B6.17), `reader` (state of the reading), `view` (book, page, zoom, spread, mode, panel tab) |
| Engines | Plain TypeScript, no React inside: `Reader`, `speech`, `AudioPlayer`, `follow`, `editor model`, `offline audio store` |
| Offline voice files | IndexedDB (B6.12) |
| Answer keys (disc only) | Ruffle, loaded on first use from `/web/vendor/ruffle/ruffle.js` (served by the Python server) |

Suggested folders:

```text
src/
  api/          client.ts (fetch + errors), mock.ts (fixtures), types.ts (B3), endpoints per area
  lib/          pagetext.ts, segment.ts, speakable.ts, fold.ts, editorModel.ts  (B7, ported exactly)
  engines/      reader.ts, speech.ts, audioPlayer.ts, follow.ts, offlineAudio.ts
  stores/       settings.ts, view.ts, reader.ts
  features/
    library/    LibraryPage, BookCard, AddBookWizard, BookSettings, ReportDialog, AdminPage, Account, ImportWizard
    reader/     ReaderPage, TopBar, Stage, PageView, HotspotButton, ReadingPill, FollowBack, Drawer
    panel/      SidePanel, TextTab, ScriptTab, SearchTab, MyAudioTab, EditorBar
    settings/   SettingsPopover (Voice, Translation, Follow tabs)
    media/      PlayerBar, VideoDialog, AnswerKeyDialog, Transcript
    words/      CollectBar, CategoryPanel, FlashcardsDialog
  App.tsx, main.tsx
```

#### B2.2 What stays on the server

These cannot run in a browser (or need keys, or would be blocked by CORS), so they stay in the Python
server and the React app only calls the API:

| Server work | Why |
|---|---|
| Page text, corrections, search with corrections (`/api/text`, `/api/search`) | Shared by the computer and its phones; files on disk |
| Translations (Google's free page translator, saved per page) | No browser CORS; rate limits; saved for offline use |
| My audio MP3s (Microsoft Natural voices via edge-tts, Windows voices via System.Speech, ffmpeg) | Browsers can speak but cannot record what they say |
| OCR (Tesseract or Windows OCR), PDF pages (pypdfium2, pdfplumber), text pages (Pillow) | Heavy, native tools |
| Speech recognition (faster-whisper) | Native model, 420 MB |
| Accounts, the library database, reports, limits | Security |
| Import of old apps | Large uploads, unpacking, conversion |

#### B2.3 Running against the real server

The server checks that every change (`POST`, `PUT`, `DELETE`) comes from the same origin: the
`Origin` header's host must equal the `Host` header. It sends no CORS headers. So:

- **Production:** build with `base: '/web/app/'` and copy `dist/` to `web/app/` in the project.
  `python web/server.py` then serves the React app at `http://127.0.0.1:8765/web/app/` next to the
  old one, on the same origin as `/api`, `/lib`, `/web/data`, `/web/recordings` and `/.shared`.
- **Development on the computer:** `npm run dev` with a Vite proxy for `/api`, `/lib`, `/web` and
  `/.shared` to `http://127.0.0.1:8765`, with **`changeOrigin: false`** (so `Host` stays the dev
  server's, equal to `Origin`). Range requests (audio and video seeking) pass through the proxy.
- **In Lovable's preview** the real server is not reachable: use mock mode (B2.4).

#### B2.4 Mock mode (the sample book)

`VITE_API_MODE=mock` (the default while building in Lovable) answers API calls from
`public/fixtures/`, and rewrites file URLs to it. Changes (corrections, new words, created MP3s) are
kept in memory for the session.

| Request | Mock answer |
|---|---|
| `GET /api/version` | `fixtures/api/version.json` |
| `GET /api/me` | `fixtures/api/me.json` (mode `local`, an admin user) |
| `GET /api/books?scope=public` / `mine` | `fixtures/api/books-public.json` / `books-mine.json`; `local`, `all`: `[]` |
| `GET /api/books/L5a4d1e0b7c` | `fixtures/api/books/L5a4d1e0b7c.json` |
| `GET /api/branches` | `[]` (every book at the top); `POST`, `PUT`, `DELETE`: in memory |
| `GET /api/text/L5a4d1e0b7c/p1` (`p2`) | `fixtures/api/text/L5a4d1e0b7c/p1.json` (`p2`) |
| `PUT /api/text/…` / `DELETE` | keep / drop the corrected doc in memory, `{ok: true}` |
| `GET /api/search/L5a4d1e0b7c` | `fixtures/api/search/L5a4d1e0b7c.json` |
| `GET /api/tr-languages` | `fixtures/api/tr-languages.json` |
| `POST /api/translate` with `lang: "es"` | `fixtures/api/translate/es/<book>/<page>.json`; another language: the same shape with empty strings and `missing` = their count |
| `GET /api/words`, `POST`, `PUT`, `DELETE` | `fixtures/api/words.json`, then in memory |
| `GET /api/recordings`, `/api/recordings/<id>` | `fixtures/api/recordings.json`, `fixtures/api/recordings/<id>.json` |
| `GET /api/voices` | `fixtures/api/voices.json` |
| `POST /api/recordings` | a fake job that is `done` after 2 s and returns the fixture recording |
| File URLs | `/lib/…` → `/fixtures/lib/…` (drop `?v=`); `/web/recordings/…` → `/fixtures/recordings/…`; `/media/…` → `/fixtures/media/…` |

The sample book *The Night Market* (id `L5a4d1e0b7c`): 2 pages of 1200 × 1700 px. Page 1: 150 words,
17 sentences, 26 clauses, 5 blocks (title, two paragraphs, a heading, a four-line dialogue), and an
audio hotspot left of the heading *At Maya's stall* whose MP3 (a Windows voice) reads the dialogue,
with a 6-line script. Page 2: 54 words, 4 sentences, 10 clauses. Every sentence has a Spanish
translation. Two new words: *stall* (New words) and *"The secret is patience," she says.* (Common
sentences).

#### B2.5 Later: without the Python server (Lovable Cloud)

Possible, but a second project, not this one. Accounts, books, page texts, corrections, words and
recordings fit Supabase tables and storage; PDFs could be drawn in the browser (pdf.js) and photos read
with tesseract.js; translation and natural voices would need official paid APIs with keys (Google Cloud
Translation, Azure Speech) in edge functions; speech recognition would need a hosted model; the disc's
books can never be uploaded. Build the React app against the existing API first.

### B3. Data types

```ts
// ---- Page text (GET /api/text/<book>/<page>) — the heart of the app
/** [x, y, width, height, text, line number, space after (1/0)] in page-image pixels, in reading order.
 *  Width and height 0: the word has no place on the image (typed by hand, not marked yet). */
export type Word = [number, number, number, number, string, number, 0 | 1];
export type Range = [number, number]; // [first, end) — end not included
export interface PageTextDoc {
  words: Word[];
  sent: Range[];    // word ranges of sentences
  clause: Range[];  // word ranges of clauses; every clause is inside one sentence
  blocks: Range[];  // SENTENCE ranges of blocks (paragraphs, headings, list items)
  edited?: true;    // corrections exist for this page
}

// ---- Books
export type HotspotKind = 'audio' | 'video' | 'swf' | 'link';
export interface Hotspot {
  t: HotspotKind;
  x: number; y: number;   // page pixels: the centre of the button
  title?: string;
  src?: string;           // audio/video/swf file URL
  script?: string;        // URL of a Cue[] JSON
  auto?: true;            // the script was made by speech recognition (show a note)
  w?: number; h?: number; // answer key (swf) size
  page?: string; book?: string; // link target
}
export interface PageRef {
  n: string | number;     // printed page number
  path: string;           // page id in URLs: 'PA-74f1d4f6f1dd3' (disc) or 'p1' (library)
  w: number; h: number;   // image size (disc: 1984 × 2496)
  img: string; thumb: string;
  a?: Hotspot[];
  blank?: true;           // page not on the disc: show a message instead
  txt?: boolean;          // library: has words
}
export interface Lesson { id: string; title: string; unit: string; pages: string } // pages: "4-7, 132"
export interface Resource { title: string; kind: string; src: string }            // PDF/PPT of the disc
export interface Branch { id: number; parent: number | null; name: string; empty: boolean } // empty: nothing in it itself
export interface BookSummary {
  id: string; title: string; author: string; about: string;
  branch: number | null;  // the branch of the library it is in (Branch.id; null: at the top)
  link?: number;          // a copy of the book in another branch (the same id, its own title and branch)
  kind: 'disc' | 'text' | 'pdf' | 'images' | string;
  visibility: 'private' | 'public'; license?: string; licenseName?: string;
  status: 'new' | 'working' | 'ready' | 'error' | string; error?: string;
  language?: string; pageCount: number; owner?: string;
  mine: boolean; canEdit: boolean; hidden?: boolean; cover: string | null;
  disc?: true; firstPage?: string; slug?: string; type?: string;
  importOptions?: ImportOptions; sample?: boolean; job?: Job | null;
}
export interface Book extends BookSummary {
  slug: string;            // used in /api/text/<slug>/<path> and /api/search/<slug>
  type: string;            // short name shown in the top bar ("Student Book")
  pages: PageRef[];
  lessons?: Lesson[]; resources?: Resource[]; library?: true;
}

// ---- Scripts of recordings and videos
export interface Cue { t: number; x: string } // start in ms, the text of the line

// ---- Translations
export interface TrLanguage { code: string; name: string; native: string; rtl: boolean }

// ---- My audio
export interface Voice { id: string; name: string; gender: string; locale: string;
  provider?: 'windows'; offline?: true; nativeName?: string }   // id: 'en-US-AriaNeural' or 'windows:…'
export interface RecSentence { path: string; a: number; b: number; text: string;
  start: number; end: number; words: [number, number][] }        // seconds
export interface Recording {
  id: string; title: string; created: string; book: string; bookId: string; bookType: string;
  page: string; path: string; voice: string; voiceName: string; rate: number; gap: number;
  duration: number; file: string; srt?: string; vtt?: string;
  translation?: { order: 'after' | 'before'; lang: string; langName: string; voice: string; voiceName: string } | null;
  voiceB?: string; zhVoice?: string; languageMode?: 'en' | 'zh' | 'both'; twoSpeakers?: boolean;
  offlineVoiceOnly?: boolean; offlineCollection?: Record<string, string> | null;
  sentences?: RecSentence[];   // only in GET /api/recordings/<id>
  count?: number; text?: string; paths?: string[]; first?: { a: number; b: number; text: string }; // list only
}

// ---- New words
export interface Category { id: string; name: string; color: string } // 'new' | 'def' | 'common' | 'c<8 hex>'
export interface WordItem {
  id: string; book: string; bookId: string; page: string; path: string;
  mode: 'word' | 'clause' | 'sentence'; a: number; b: number;
  text: string; context: string; contextOffset: number; category: string;
  added: number; box: number; seen: number; right: number; last: number; // box 0..5
}

// ---- Accounts
export interface User { id: number; name: string; email: string; admin: boolean }
export interface Me { mode: 'local' | 'lan' | 'public'; user: User | null; disc: boolean; contact: string;
  licenses: Record<string, string>; reasons: Record<string, string>; limits: Record<string, number> }
```

### B4. The API

All JSON unless noted. Errors: a non-2xx status with `{error: "message for the person"}`; show the
message. `429` may carry `{busy: true, wait: seconds}` (translation) — wait and retry by itself, with a
countdown. Library book ids: `L` + 10 hex; disc book ids: `1705`, `1706`, `1707` in book URLs, slugs
`BO-…` in text URLs; page paths `PA-…` (disc) or `p<n>` (library).

**Session and library**

| Request | Body | Answer |
|---|---|---|
| `GET /api/version` | | `{api: 17}`; lower than needed: show "restart the app" notice |
| `GET /api/me` | | `Me` |
| `POST /api/signup` | `{email, name, password}` (and an empty hidden `website` field) | `{ok, user}` + cookie |
| `POST /api/login` | `{email, password}`; on the home Wi-Fi `{password: PIN}` | `{ok, user}` + cookie |
| `POST /api/logout` | | `{ok}` |
| `POST /api/password` | `{old, new}` | `{ok, user}` |
| `GET /api/books?scope=public\|mine\|local\|all&q=` | | `BookSummary[]` |
| `GET /api/books/<id>` | | `Book` |
| `POST /api/books` | `{kind: 'text'\|'pdf'\|'images', title, author, branch, importOptions}` | `BookSummary` |
| `PUT /api/books/<id>/source/<part>` | raw bytes: `pdf`, `image-<k>` (k from 0), `picture`; `text`: JSON `{text}` | `{ok}` |
| `GET /api/page-languages` | | `{engine, languages: [{code, name, ocr}]}` |
| `POST /api/books/<id>/preview` | `{options, same}` | starts a sample; then poll `GET` |
| `GET /api/books/<id>/preview` | | `{state: 'working'\|'ready'\|'error', done, total, stage, pages: [{n, img, how, text, words}], tips: [{text, set?}], options, chosen, total, token, error}` |
| `POST /api/books/<id>/make` | `ImportOptions` or `{}` | `{ok}`; then poll `GET /api/books/<id>/job` every 0.8 s |
| `GET /api/books/<id>/job` | | `{status, error, job: {done, total, stage}, book}` |
| `PUT /api/books/<id>` | any of `{title, author, branch, about, source, license, visibility}`; `visibility: 'public'` needs a licence and `rights: true` (the person confirmed they may share it) | `BookSummary` |
| `DELETE /api/books/<id>` | | `{ok}` |
| `POST /api/books/<id>/report` | `{reason: key of me.reasons, note}` | `{ok}` |
| `GET /api/admin/reports` | | open reports (admins) |
| `POST /api/admin/books/<id>` | `{action: 'hide'\|'show'\|'dismiss'\|'delete'}` | `{ok}` |
| `GET /api/branches` | | `Branch[]`: the branches of the library (folders in folders) |
| `POST /api/branches` | `{name, parent}` (admins; `parent` null: a main branch) | `Branch` |
| `PUT /api/branches/<id>` | any of `{name, parent}` (admins: rename, move with all that is in it) | `Branch` |
| `DELETE /api/branches/<id>` | (admins) what was in it goes into the branch it was in | `{ok}` |
| `POST /api/branches/<id>/copy` | `{parent}` (admins) the same branches, with copies (links) of their books | `Branch` |
| `POST /api/links` | `{book, branch, title}` (`title` '': the book's) a copy: the same book in one more branch | `{id, book, branch, title}` |
| `PUT /api/links/<id>` | any of `{title, branch}` | `{id, book, branch, title}` |
| `DELETE /api/links/<id>` | | `{ok}` |
| `PUT /api/books/<disc book id>` | any of `{title, branch}` (admins; `title` '': its own name again) | `BookSummary` |
| Files | `/lib/<id>/pages/<n>.webp`, `/lib/<id>/thumbs/<n>.webp`, `/lib/<id>/preview/<n>.webp?token=` | images |

`ImportOptions`: `{language, english, pinyin: 'none'|'some'|'all', dropPinyin, pages: "3-120", ocrAll,
margins, enhance, fixes: "wrong → right" lines}`.

**Page text and search**

| Request | Body | Answer |
|---|---|---|
| `GET /api/text/<book slug>/<page path>` | | `PageTextDoc` (with `edited: true` when corrected) |
| `PUT /api/text/<book>/<page>` | `PageTextDoc` (words, sent, clause, blocks) | `{ok}` |
| `DELETE /api/text/<book>/<page>` | | `{ok}`: back to the original text |
| `POST /api/ocr-region/<book>/<page>` | `{x, y, w, h, language, read: 'all'\|'main'\|'en'}` (page pixels) | a `PageTextDoc` of that area (not saved) |
| `GET /api/search/<book slug>` | | `[{p: page number, t: page text, paragraphs on new lines}]` |

**Translation**

| Request | Body | Answer |
|---|---|---|
| `GET /api/tr-languages` | | `TrLanguage[]` (43) |
| `POST /api/translate` | `{lang, from, book, page, paragraphs: string[][], words?: [{word, context, contextOffset}], cachedOnly}` — `from` is the book's `language` (`'zh-Hans'` …; `''`/missing = English); `paragraphs` is one list of sentence texts per block; `page` may also be a script id (`AU-…`, `VI-…`) | `{translations: string[][] (same shape, '' = none), fetched, missing, wordContext}` |
| `POST /api/translate-word` | `{lang, from, items: [{word, context, contextOffset}], cachedOnly}` or `{lang, from, word, context, contextOffset, cachedOnly}` | `{translations: string[], fetched, missing, wordContext: true}` or `{text, wordContext: true}` |

**My audio and voices**

| Request | Body | Answer |
|---|---|---|
| `GET /api/voices[?lang=ar]` | | `Voice[]` (Natural voices from Microsoft, then the server's Windows voices) |
| `GET /api/voice-sample?voice=&rate=` | | `audio/mpeg` |
| `POST /api/recordings` | `{voice, voiceName, rate (-50..50), gap (0..10 s), title, book, bookId, bookType, page, path, sentences: [{path, a, b, text, words: string[], tr?}], translation?, voiceB?, zhVoice?, languageMode?, twoSpeakers?, offlineVoiceOnly?, offlineCollection?}` (1–400 sentences) | `{job}` |
| `GET /api/jobs/<job>` | | `{state: 'running'\|'done'\|'error', done, total, recording?, error?}` (poll every ~0.5 s) |
| `GET /api/recordings` | | `Recording[]` (summaries) |
| `GET /api/recordings/<id>` | | `Recording` with `sentences` |
| `PUT /api/recordings/<id>` | `{title}` | `Recording` |
| `DELETE /api/recordings/<id>` | | `{ok}`; `409` if the file is busy |
| Files | `/web/recordings/<id>.mp3`, `.srt`, `.vtt` | |

**New words**

| Request | Body | Answer |
|---|---|---|
| `GET /api/words` | | `{categories: Category[], items: WordItem[]}` |
| `POST /api/words` | `{items: [{book, bookId, page, path, mode, a, b, text, context, contextOffset, category}]}` | `{items: WordItem[]}` (one already there is moved, not added twice) |
| `PUT /api/words/<id>` | `{known: boolean}` | `WordItem` (box +1 up to 5, or 0) |
| `DELETE /api/words/<id>` | | `{ok}` |
| `POST /api/words/categories` | `{name}` | `Category` |
| `DELETE /api/words/categories/<id>` | | `{moved}` (its items go to `new`) |

**Scripts by speech recognition (disc, on the computer only)**

| Request | Body | Answer |
|---|---|---|
| `POST /api/transcribe` | `{src}` (the recording's URL) | starts it: `{state: 'queued' \| 'running', message, …}`, or `{state: 'done', cues: Cue[], generated: true}` if made before |
| `GET /api/transcript?src=` | | the same, `{state: 'error', …}`, or `{state: 'idle'}`; poll until `done` |

**Import of an old app** (`/api/migrations…`): `GET` (list) and `POST {…}` (create), then per job
`<id>`: `GET`, `PUT source?name=<path>` (raw bytes, one file at a time), `GET source` (files received),
`POST analyze | sample {…} | convert {…} | cancel | discard`, `GET preview/<name>`, `GET export`,
`GET report`. See `docs/reference/server/migration.py` and `docs/reference/web/js/migration.js`.

### B5. Screens and layout

Screenshots: `docs/screenshots/`. The top bar, the panel and the settings in *app-main*,
*voice-settings*, *read-page-aloud*, *audio-transcript*, *video*, *search* and *library* are current;
the others are a few days older (the top bar has gained buttons since: follow the spec).

#### B5.1 Library (`#/`)

- Top bar: brand *Lingua Books*, account (log in / sign up / name, log out).
- Tabs: **Public library**, **My books**, **On this computer** (only when `me.disc`), **Admin**
  (only for admins). A search field *Find a book*. Buttons **Add a book** and **Import old app**.
- Book cards: cover (first page thumbnail), title, author, page count, *Not finished* / *Making
  pages…* states, a settings button for own books. Click: open the book at its first page
  (disc books: `firstPage`).
- Branches (`GET /api/branches`, folders in folders; address `#/@/<branch>/<sub-branch>`): on the
  left a **tree** of them like Windows Explorer (a click opens one and unfolds it, or folds it if it
  was unfolded; › only unfolds/folds it; keys ↑ ↓ → ←
  Enter, right-click: its menu; a book or branch dropped on it is moved there, with Ctrl copied; a
  button left of the tabs hides it; a phone: it slides over the books). On the right the open
  branch: a bar with the way up and **Paste**, its sub-branches as cards, then its books. Every card
  has a ⋮ menu: Rename (F2), Cut (Ctrl+X), Copy (Ctrl+C), Move to…, New sub-branch…, New parent
  branch…, Delete.
- Footer: *Terms and privacy*.

#### B5.2 Reader (`#/<book>/<page>`)

```text
┌─ top bar ────────────────────────────────────────────────────────────────────────────────────┐
│ ▦ pages  LB Lingua Books  [Student Book]  │ ← [ 25 / 168 ] →  │ − ⛶ + 📖 │ Click to hear       │
│ [Sentence|Clause|Word|Off] (中+EN|中|EN) ⚙ settings  文A translate  ⟳ repeat  🔖 collect  🂠 cards │
│                                                              🔍 Search text ( / )   ▯ panel   │
├─ stage (scrolls; the page or two pages, centred) ───────────────┬─ side panel (380 px) ───────┤
│ ONLINE/OFFLINE badge (top left)                                  │ Text | Script | Search |    │
│                                                                  │ My audio                    │
│            page image + svg text layer + hotspot buttons         │                             │
│                                                                  │ (tab content)               │
│   [follow-back word ↑] (top middle, when the read word is off)   │                             │
│   ( ● Reading page 25 · 3 of 52  [Pause] [Stop] [◎ follow] )     │                             │
│   ( 🔖 Add to [● New words ▾]  This page: 3 …  [Flashcards] [Done] )                           │
├─ player bar (when audio plays) ──────────────────────────────────────────────────────────────┤
│ ▶  title  ────────●──────────  0:15 / 1:02   [1×]   ✕                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Drawer** (grid button or `P`): tabs **Pages** (thumbnails, lazy-loaded) and **Resources**
  (disc PDFs/PPTs; for library books an *About* box with settings, sharing and *Report a problem*).
- **Settings popover** (sliders button) with tabs **Voice**, **Translation**, **Follow** (B6.3,
  B6.10, B6.5).
- **Dialogs** (one modal): video, answer key, Create audio, flashcards, add a book, import, report.
- **Toasts** at the bottom for short messages.

#### B5.3 Side panel tabs

- **Text:** actions row: **Read page aloud** (primary), *area* (read an area), *translate list* (L),
  *pencil* (correct, E), *copy*, *save .txt*; then the text (B6.7); footer link *Save the whole book's
  text (.txt)*. In correction mode the actions row becomes the editor bar (B6.13).
- **Script:** head with the title, the two translate buttons (under every line / when pointing), the
  language, the repeat button; then the numbered lines (B6.8).
- **Search:** results of the top search field; *Search all three books* (disc).
- **My audio:** **New audio**, filter *This page / This book / All*, sections *Sentences to include*
  (while picking), *Offline voice files on this page*, *Saved audio* with a search field (B6.11).

#### B5.4 Phone (< 700 px)

The top bar wraps into two rows; the panel becomes a **bottom sheet** (tabs always visible; a tab
opens it, the open tab closes it; drag its handle to resize); dialogs take the full width; inputs use
16 px text (no iOS zoom); respect `env(safe-area-inset-bottom)`. See *phone.png*, *phone-page.png*.

#### B5.5 Hotspot buttons

Round 34 px buttons centred on `(x, y)` (left: `x / W`, top: `y / H` in %), coloured by kind: audio
red (headphones), video purple, answer key teal (key), page link blue pill with the target
(`→ p.104`). The one playing pulses.

#### B5.6 Colour tokens

```css
:root {
  --bg:#e8eaee; --surface:#fff; --surface-2:#f4f5f7; --surface-3:#eceef2; --line:#d8dbe1;
  --text:#1c1f25; --muted:#60677a; --accent:#c4122f; --accent-hover:#a50e27; --accent-ink:#fff;
  --accent-soft:#fbe8eb; --focus:#2563eb;
  --hl-hover:rgba(37,99,235,.16); --hl-hover-edge:rgba(37,99,235,.65);
  --hl-active:rgba(255,200,0,.45); --hl-word:rgba(255,128,0,.55); --hl-flash:rgba(37,99,235,.28);
  --hs-audio:#c4122f; --hs-video:#7c3aed; --hs-key:#0f766e; --hs-link:#1d4ed8;
  --radius:10px; --radius-sm:7px; --topbar-h:56px; --panel-w:380px; --drawer-w:300px;
  --font:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;
}
/* dark (prefers-color-scheme: dark, unless data-theme="light") */
  --bg:#14161a; --surface:#1d2026; --surface-2:#23272e; --surface-3:#2b3038; --line:#353b46;
  --text:#e6e8ec; --muted:#9aa2b1; --accent:#ff5468; --accent-hover:#ff7385; --accent-ink:#1a0b0e;
  --accent-soft:rgba(255,84,104,.14); --focus:#6aa0ff;
  --hs-audio:#e11d48; --hs-video:#8b5cf6; --hs-key:#0d9488; --hs-link:#3b82f6;
```

The page image stays white in dark mode. Highlights on the page use `mix-blend-mode: multiply` so they
look like a highlighter on paper. Full styles: `docs/reference/web/css/app.css`.

### B6. Behaviour, feature by feature

#### B6.1 The page view

- One box per page with the page's aspect ratio. Inside: the `<img>`, then an `<svg viewBox="0 0 W H"
  preserveAspectRatio="none">` the same size, then the hotspot buttons.
- SVG groups, bottom to top: `hl-active` (the sentence being read, yellow), `hl-word` (the word being
  read, orange), `hl-flash` (a short blue flash, e.g. a search hit), `hl-hover` (outlined blue), then
  `hits`: one transparent `<rect data-w="i">` per word from `PageText.hitRects()`.
- A highlight of words `a..b` is one rounded rectangle per text line: `PageText.rects(a, b)`.
- A page without text shows only the image; a `blank` page shows *This page is not on the disc*.
- Mode **Off**: the hit layer ignores the pointer (`pointer-events: none`): the page is a picture.

#### B6.2 Click modes and hover

- `unitAt(word, mode)` gives the sentence, clause or word around a word. Pointing at a word outlines
  that unit on the page **and** in the Text list (and the reverse).
- **Click** (or tap): if My audio or an offline voice file has the unit, play it from there (B6.11,
  B6.12); else the Reader reads from this unit to the end of the shown page(s). A click on the unit
  being read: pause; again: continue. Another unit: start there.
- While collecting new words (B6.14) or picking sentences for My audio (B6.11), a click does that
  instead and nothing is read.
- *Sample book checks:* page 1, Sentence mode, point at *stall* (word 56) → *Maya has a small stall
  near the entrance.* (words 52–59); Clause mode, point at *queue* → *and the queue is often longer
  than the one for the famous noodle stall next to her.* (words 91–107); Word mode → *stall* only.

#### B6.3 Reading aloud (the Reader)

States `idle | playing | paused`, and a **queue** of units from the clicked one to the end of the
shown page(s) (both pages in two-page view).

- **Flow:** the voice is given up to **10 sentences or 1,500 characters at a time**, so there is no gap
  after each sentence; the `boundary` events (character positions) tell which word and sentence is
  being read, so the highlight moves on. One unit per request when: a pause between sentences is set,
  repeat is on, Word mode, the translation is read too, or the voice reports no word positions.
- **Pause / continue:** pausing cancels the speech but remembers the last word reported; continuing
  speaks the same unit again **from that word**. (Do not rely on `speechSynthesis.pause()`.)
- **Pause between sentences** (settings, 0–10 s): after each unit wait, with a countdown in the reading
  pill ("Next sentence in 3 s"); the finished unit stays highlighted.
- **Repeat each sentence** (1–10 or ∞; the slider, the repeat button in the top bar, and `R`: once →
  2 → 3 → 4 → 5 → ∞ → once; a badge shows the number): read the unit again until the count is reached
  (the pause is made between repeats too); the pill shows "2nd time of 3" or "6th time, ∞".
- **Read the translation** (settings: no / after / before each sentence): speak the sentence's
  translation with a voice of that language (`speakTranslation`) after or before it.
- **Reading pill:** "Reading page 25 · 3 of 52" (or "Paused · …"), Pause/Continue (`Space`), Stop
  (`Esc`), Follow toggle (`F`).
- **Read page aloud** = queue of all units of the page. **Read an area:** the area button, then a box
  drawn on the page (`Esc` cancels); a unit is in the box when at least half of its placed words have
  their centre inside; the queue is those units.
- Each new unit is centred in the Text list and kept in view on the page (B6.5).

#### B6.4 Speech

- **Voices:** `speechSynthesis.getVoices()` (wait for `voiceschanged`). Rank English voices:
  names with *Natural* first, then en-US, then en-GB. A Chinese voice (Mandarin) reads Chinese
  characters; a text is split into runs by script (`pieces()`), each run spoken by its voice;
  speaker letters next to Chinese (`A: 你好`) go with the Chinese run.
- **Word highlighting:** `PageText.speech(a, b)` gives the spoken text and where each word starts;
  on `boundary`, `wordAtChar` finds the word.
- **Generation counter:** every `speak()` increments a counter; events of cancelled utterances are
  ignored.
- **Offline fallback:** an online voice that fails (no internet) is replaced at once by an offline
  (local) voice of the same language, with a toast.
- **Read** setting for Chinese books: Chinese and English / English only / Chinese only (the
  `中+EN | 中 | EN` switch appears only for Chinese books).
- **Test voice** speaks a sample sentence.

#### B6.5 Following the reading

Settings → **Follow**: on/off (`F`, and the target button in the pill), where (*In the middle* / *Near
the top* / *When needed*), scrolling speed (0–2000 ms; 0 = jump), the wait after the person scrolls
(1–20 s), and whether the Text list follows too.

- The sentence being read stays at the chosen place in the visible part of the stage (above the pill;
  on phones above the sheet). A sentence taller than that is shown from its start.
- **Who scrolls?** A wheel, a finger moved > 10 px, two fingers (zoom), or a scroll right after the
  person pressed something there (scroll bar, keys) is the person: stop following for the chosen wait.
  Scrolls caused by layout changes and by the app's own scrolling do not count. A plain tap does not.
- Own smooth scrolling (eased, chosen duration), stopped at once by the person's wheel or finger.
- While the word being read is off screen, show it **at the top middle of the stage, word by word**,
  with an arrow (up, down, sideways) to where it is; a click on it brings the reading back.

#### B6.6 Navigation, zoom, two pages

- Page field `25 / 168`, previous/next (`←`/`→`), and on phones a swipe. Changing page changes the
  hash only; the router shows the page. Hotspot links (`→ p.104`) push the current page on a small back
  stack; a back button appears left of the arrows.
- **Two-page view** (`S`, open-book button): page 1 alone, then pairs 2–3, 4–5 …
- **Zoom:** one CSS variable `--page-w`. Buttons `−`/`+` and `Ctrl`+wheel multiply it, keeping the same
  point (the sentence you are on, if any) in the middle. **Fit** (`0`) steps in and then out again:
  whole page → page width → the paragraph → the sentence → the word you are on → its sentence → its
  paragraph → page width → whole page. Each step is as wide as the screen, centred; while reading,
  the fitted paragraph or sentence moves on with the reading. A `ResizeObserver` keeps fits fitting.
- Preload the next page's image and text.

#### B6.7 The Text list

- One block per paragraph; **every sentence numbered and on its own line**; each word a `<span>` with
  its trailing space (no gaps in highlights). Pointing and clicking work as on the page, in sync.
- **Single click** waits 0.28 s before reading, so a **double click** can open the quick edit instead
  (B6.13). Hovering a sentence turns its number into drag dots (move it, B6.13).
- Translations under each sentence when switched on (B6.10), `dir="rtl"` for ar, fa, ur, ku, he.
- Copy (Clipboard API, fallback `execCommand('copy')`), Save .txt (CRLF line ends), Save the whole
  book's text (from the search file). Copy and save include translations when shown.

#### B6.8 Audio, video, answer keys

- **Audio hotspot:** play in the player bar (HTML5 `<audio>`, seekable through Range requests), open
  the **Script** tab (also when the panel was closed), highlight the line whose start has passed and
  keep it in view; click a line: jump there; click the line playing: pause; again: play. Rate menu
  0.75–1.3×.
- **Repeat each line:** check every animation frame (`requestAnimationFrame`, not `timeupdate`)
  whether the next line is about to start; if the current one must be heard again, jump back to its
  start; the last line on `ended`. The line's time shows "2/3". A jump made by the person restarts
  the count.
- **Script translation:** two buttons over the script — under every line, or in a box while pointing
  at a line (a tap on phones) — and the language list. The script is sent to `/api/translate` six
  lines per paragraph, with the script id as `page`; lines without letters are not sent.
- **Auto scripts** (`auto: true`): a note *Made by speech recognition: it may have mistakes.* A
  recording with no script at all shows **Transcribe** (`POST /api/transcribe`, poll `GET
  /api/transcript`) — only when `me.mode` is not `public`.
- **Video hotspot:** a modal dialog with the MP4 and the same transcript, translation buttons and
  repeat; closing stops and unloads the video.
- **Answer key (`swf`, disc only):** a dialog with Ruffle (`window.RufflePlayer`), splash screen and
  context menu off, shown up to 2.2× larger.

#### B6.9 Search

Search field (`/`) → Search tab. Fold text and query **without changing the length** (lower case,
curly quotes and dashes made plain), so a match position is also right in the original for the
snippet. Results: page number and a snippet with the match marked; click → open that page and flash
the sentence. Disc: *Search all three books*.

#### B6.10 Translation

- Every book is translated **from its own language** (`from` = the book's `language`): a Chinese
  book into **English** by default (the main language), another language can be chosen; the choice
  is kept per book language (English books: their own), the book's own language is not offered,
  and a line under the language says what the open book is translated from.
- Settings → **Translation:** language (43, from `/api/tr-languages`); show *in the Text list under
  each sentence* (also the translate button in the Text tab, `L`); show *on the page* (the translate
  button in the top bar): pointing at a sentence (clause, word in Word mode) shows its translation in a
  small box **under the whole unit** (all its lines), above it when there is no room, never covering
  it, moving with the page when it scrolls; in Word mode the box adds "word → meaning".
- A translate button pressed before a language is chosen opens this tab.
- The page's translations are asked once per page version and language (`POST /api/translate`).
  `429 {busy, wait}`: wait with a countdown and go on by itself.
- **Prepare for offline use:** scope *Current page / Selected sentences on this page / Whole book*,
  levels *Sentence / Clause / Word in context / Breakdown (word by word)*. **Prepare** first checks
  what is saved (`cachedOnly: true`, all of a page's words in one request), then downloads only
  what is missing, page by page. Under the button: one bar for all, and one per step (*Sentences,
  Clauses, Words in context, Breakdown: each word on its own*) with "saved / total", green with ✓
  when complete; the button says **Stop** meanwhile. Ends with "✓ Completed". Nothing missing:
  "✓ Already prepared (on <date>)… No need to prepare again" with **Prepare again** (`refresh: true`:
  download everything again) and **No need**. The date is remembered per language/book/page in the
  browser (`trPrepared`), and shown before clicking ("Prepared before, on …"). Items the translator
  gives nothing for are listed by the server in `none` (indices; blank sentences in the page file,
  words in `words-none.json`) and count as done. Whole book: waits 1.5 s after a page that really
  needed the translator; busy (429): countdown, then the same page again. **Read using saved
  translations only (offline)** sends `cachedOnly: true` everywhere.
- Words are translated **in their sentence**: `{word, context, contextOffset}` (the character offset of
  the word in the sentence text).

#### B6.11 My audio

- **New audio:** picking mode. Click the **first** sentence, then the **last**: all between are
  chosen; the box of a paragraph chooses it all; `Ctrl`+click adds or drops one. Works on the page and
  in the list; chosen sentences are blue. **Create audio…** opens a dialog: title, voice
  (`/api/voices`: Natural voices and the server's Windows voices, labelled *online Natural* /
  *Windows offline*; **Try** plays `/api/voice-sample`), speed (−50…50 %), pause between sentences,
  read the translation (after/before, with a voice of that language), a second voice for speaker B in
  `A:`/`B:` dialogues, a Chinese voice for Chinese books. **Create MP3** → `POST /api/recordings`,
  poll the job with a progress bar.
- An orange **play icon** appears left of the paragraph; the new recording's paragraph is framed.
- **Playing:** the player bar plays the MP3; every frame, find the sentence and word at the current
  time (`sentences[].start/end`, `words[]`) and highlight them on the page and in the list, centred.
  If the text was corrected after the MP3 was made, find each sentence again by its text.
- **A click on a sentence that is in an MP3 of this page plays that MP3 from the sentence** (prefer the
  one in the player, then the newest). Click again: pause; another sentence: jump. Clause mode starts at
  the clause's first word; Word mode plays just that word. Repeat works by jumping back.
- The tab lists recordings (*This page / This book / All*, search): play, download MP3, **CC**
  (download `.srt`), rename, delete.

#### B6.12 Offline voice files

- Settings → Voice: the English voice list says per voice whether it is *offline on this device*,
  *online*, or has voice files. Choose **Generate for**: *Whole current page*, *Whole book*, *Selected
  sentences or audio*, *All saved audio*, then **Generate**. Only English sentences without a voice file
  for this voice (and the same translation reading) are made; one recording per page
  (`offlineVoiceOnly: true`, `offlineCollection` for a book), large pages in numbered parts.
- Each result is fetched and stored in IndexedDB `lingua-books-offline-audio`, store `recordings`,
  key `id`: `{id, summary, recording, blob, importedAt}`.
- A click on a sentence first tries the offline voice files of this page for the chosen voice, then My
  audio, then the live voice.
- **OFFLINE / ONLINE** badge (top left of the stage) is about **this page**: OFFLINE when it has a voice
  file for the chosen voice.
- My audio → **Offline voice files on this page**: delete one (browser copy and server copy).
  **Export folder** (File System Access API, Edge/Chrome): folders by book / language mode / voice with
  `book-collection.json` (the ordered page files and their sentence counts).
- A Windows voice never stands in for a Natural voice or the reverse: match the browser voice to the
  server voice by normalised name and locale (`docs/reference/web/js/voice-options.js`); no match → no
  Generate button.

#### B6.13 Text corrections

Corrections are edits of the page's `PageTextDoc`, saved whole with `PUT /api/text/…` 0.4 s after the
last change (one save at a time per page; the newest wins). Status: *Saved* / *Not saved* (server
unreachable).

- **Quick, in the Text list:** double-click (double-tap) a sentence → a text box; `Enter` saves, `Esc`
  cancels, empty deletes, **More tools** opens correction mode on it. Drag a sentence by its dots (on
  phones by its number) and drop where the blue line shows. `Ctrl+Z` undoes.
- **Correction mode** (pencil or `E`): every sentence listed, the current one selected and centred.
  Tools in a bar at the top, for the selected sentence (disabled when they do not fit): **Edit**
  (`Enter`), **Split** (click the word that starts the new sentence), **Merge ↑ / ↓** (also joins
  paragraphs), **Move up / down**, **Move by clicks**, **New paragraph / Join paragraph**, **Mark on
  page** (draw a box: its words are laid out inside it), **Re-read an area** (draw a box; the server
  reads it with OCR, `POST /api/ocr-region`; review, then add or replace the words there; the new sentences go where the old words were, or
  where they are on the page: after the sentence before them in their column), **Add
  after**, **Delete**. Bulk row: **Read the whole page again** (OCR with `"progress": true`: the server
  sends a line of JSON per step — `{plan}`, `{at}`, `{waiting}`, then `{doc}` or `{error}` — shown as a
  list of steps and a bar, with Stop; the sentences corrected since the text was made, compared with
  `GET /api/text/…?original=1`, are kept and what is read in their places left out; text deleted
  before comes back unticked; review, replace the rest in the page's order), **Put in order by
  areas** (draw boxes in reading order; each becomes a paragraph), **Choose by area**, **Choose all**,
  then **Delete / Merge / Move after selected / Clear**. Undo (80 steps), **Restore** (`DELETE
  /api/text/…`). **Done** (`E`) returns to reading on the same sentence. `↑`/`↓` select, `Delete`
  deletes.
- **Model:** paragraphs → sentences → words `{t, box | null, line, sp}` (`toModel`/`toDoc`, B7.4). After
  each change, clauses are recomputed with `clauseRanges`. When a sentence's text changes, new words get
  the old boxes with `alignWords` (B7.4). Corrections are used by reading, copying, search and
  translation (only changed paragraphs are translated again).
- Read-only books (others' public books): no pencil, no quick edit.

#### B6.14 New words and flashcards

- **Collect** (bookmark button or `N`): the collect pill shows **Add to [category]** and counts
  ("This page: 3 in New words, 1 in Definitions"). The category button opens a panel **upwards**: the
  categories with counts and colours (radio), a field + **Add** for a new one (chosen at once), a bin
  per category (its items go back to *New words*; *New words* cannot be deleted). Click elsewhere or
  `Esc` closes it.
- While collecting, a click on the page or the list adds the unit of the current mode to the chosen
  category (`POST /api/words`) and marks it on the page in the category colour; a click on one already
  in that category removes it, on one of another category moves it. Nothing is read. **Done**, `N` or
  `Esc` stops.
- **Flashcards** (cards button or `C`): three lists — **Category** (all or one), **Show** (words,
  clauses, sentences, or all), **From** (this page, this lesson, this File, the whole book, or any
  lesson/File/page that has cards; lessons from `book.lessons`: a lesson's `pages` are printed page
  numbers like `"4-7, 132"`; a File is all lessons with the same `unit`). Each option says how many
  cards it gives. A list of the cards (dots = box), with delete.
- **Practice:** shuffle, then lower boxes first. The card shows the English (spoken) — or the
  translation first if chosen; click or `Space` turns it over: the meaning (in the translation
  language) and, for a word or clause, its sentence with it marked and that sentence's translation
  (toggle with the ≡ button or `E`). `←`/`→` move; **Again** (`1`) / **I knew it** (`2`) answer
  (`PUT /api/words/<id> {known}`); a missed card comes again 4 cards later. End: "N of M known the first
  time", **Practice the K I missed**.

#### B6.15 Library, adding books, sharing, accounts

- **Add a book** dialog: kind **Text** (title, author, text: an empty line starts a paragraph, `#` a
  heading; optional picture), **PDF** (one file, up to 300 pages, *Pages to use*), **Photos of pages**
  (one per page, in file-name order). For PDF/photos first ask: page language (warn when OCR cannot
  read it on this server: `/api/page-languages`), for Chinese whether there is pinyin, pages to use.
- Flow: `POST /api/books` → upload parts with progress (`PUT …/source/<part>`) → text: `POST …/make`
  and poll `…/job`; PDF/photos: `POST …/preview`, poll every 0.7 s, then **review the sample**: 1–5 pages
  side by side with the words read, *The app noticed* tips (each with **Change it and try again**),
  *Something to change?* (language, pinyin, pages, read every page with OCR, leave out page numbers and
  headers, make pictures clearer, fix the same mistake on every page), buttons **Try again on these
  pages**, **Show other pages**, **Finish later**, **Make all N pages** → make and poll → open the book.
- **Settings and sharing** (own books): title, author, about; **Share with everyone** needs a licence
  (`me.licenses`) and a confirmation. **Report a problem** (public books of others): reason + note.
- **Accounts** (`me.mode === 'public'`): sign up, log in, change password, log out. Without an account
  people read public books; adding books, MP3s, corrections and words need one. Home Wi-Fi mode: a PIN
  login page.
- **Admin** tab: open reports and all books: hide, show, dismiss, delete.
- **Import old app** (B4, last table): a numbered six-step wizard — upload (ZIP or folder picker,
  resumable, byte and file progress), inspect, choose (books, languages, page range, OCR, fixes), review
  samples (must tick approval; changing settings needs a new sample), convert (pause, retry), validate
  and export (open books, download ZIP and report). Lowest priority.

#### B6.16 Remembered settings

Keep them in `localStorage` with the prefix `aef3.` (the old app's keys, so settings carry over), each
access in `try/catch`:
`voice`, `mandarinVoice`, `speechLanguageMode`, `rate`, `gap`, `repeat` (0 = ∞), `follow` (word
highlight), `trRead`, `trVoices`, `trLang`, `trOn`, `trPageOn`, `trOfflineOnly`, `trLevels`, `mode`,
`spread`, `zoomMode`, `zoomW`, `panel`, `settingsTab`, `recFilter`, `recVoice`, `recRate`, `recGap`,
`recZhVoice`, `libScope`, `addKind`, `addOptions`, `cueTrUnder`, `cueTrPoint`, `follow.on`,
`follow.where`, `follow.speed`, `follow.wait`, `follow.list`, `cards.front`, `cards.example`,
`cards.say`, `last` (book and page), and `page.<book id>` (the page last open in each book).

#### B6.17 Keyboard shortcuts

| Key | Action | Key | Action |
|---|---|---|---|
| `←` `→` | previous / next page | `P` | all pages |
| `1` `2` `3` `4` | Sentence, Clause, Word, Off | `T` | side panel |
| `+` `−` `0` | zoom in, out, fit steps | `S` | one or two pages |
| `/` | search | `Space` | pause / continue (or the recording) |
| `Esc` | stop reading, close | `E` | correction mode |
| `L` | translations in the list | `R` | repeat: once → 2 → … → ∞ |
| `F` | follow the reading | `N` | add new words |
| `C` | flashcards | `Ctrl+Z` | undo a correction |

No shortcut fires while typing in a field.

#### B6.18 Phones and touch

Tap = click (no hover; a tap shows the translation box too). Swipe left/right turns the page when the
page is not wider than the screen or is at its edge. Pinch zooms around the point between the fingers
(`touch-action: pan-x pan-y` on the stage; the app handles two-finger moves); near the screen width it
snaps to "fit width". Double tap opens the quick edit (time taps yourself; phones do not always send
`dblclick`). The bottom sheet: tap a tab to open, the open tab to close, drag the handle. *Add to Home
screen*: a web manifest and icons, full screen.

#### B6.19 Theme and accessibility

Light and dark from the tokens (B5.6), following the system. Every icon button has `title` and
`aria-label`; toggles use `aria-pressed`; segmented controls are `role="radiogroup"`; the reading pill
is `role="status"`; focus is visible (`--focus`).

### B7. Algorithms to port exactly

Port these to TypeScript **without changing behaviour** (names may become camelCase). The complete
originals are in `docs/reference/web/js/`.

#### B7.1 `PageText` (`pagetext.js`)

```js
const X = 0, Y = 1, W = 2, H = 3, T = 4, LINE = 5, SPACE = 6;
const hasBox = (w) => w[W] > 0 || w[H] > 0;

export class PageText {
  constructor(doc) {
    this.words = doc.words; this.sent = doc.sent; this.clause = doc.clause; this.blocks = doc.blocks;
    const n = this.words.length;
    this.w2s = new Int32Array(n).fill(-1);
    this.w2c = new Int32Array(n).fill(-1);
    this.sent.forEach(([a, b], i) => { for (let w = a; w < b; w++) this.w2s[w] = i; });
    this.clause.forEach(([a, b], i) => { for (let w = a; w < b; w++) this.w2c[w] = i; });
  }
  get empty() { return this.words.length === 0; }
  /** The sentence / clause / word that contains word index w. */
  unitAt(w, mode) {
    if (w < 0 || w >= this.words.length) return null;
    if (mode === 'word') return { mode, i: w, a: w, b: w + 1 };
    const table = mode === 'clause' ? this.clause : this.sent;
    const i = mode === 'clause' ? this.w2c[w] : this.w2s[w];
    if (i < 0) return null;
    return { mode, i, a: table[i][0], b: table[i][1] };
  }
  unit(mode, i) {
    const table = mode === 'clause' ? this.clause : this.sent;
    return table[i] ? { mode, i, a: table[i][0], b: table[i][1] } : null;
  }
  count(mode) { return (mode === 'clause' ? this.clause : this.sent).length; }
  text(a, b) {
    let s = '';
    for (let k = a; k < b; k++) s += this.words[k][T] + (this.words[k][SPACE] && k < b - 1 ? ' ' : '');
    return s.trim();
  }
  /** Text for the speech engine plus where each word starts, for word highlighting. */
  speech(a, b) {
    let text = '';
    const starts = [];
    for (let k = a; k < b; k++) {
      const spoken = speakable(this.words[k][T]);
      starts.push({ w: k, at: text.length });
      text += spoken;
      if (this.words[k][SPACE] && spoken) text += ' ';
    }
    return { text: text.replace(/\s+/g, ' ').trim(), starts };
  }
  wordAtChar(starts, charIndex) {
    let found = starts.length ? starts[0].w : -1;
    for (const s of starts) { if (s.at <= charIndex) found = s.w; else break; }
    return found;
  }
  /** One rectangle per text line covered by words a..b (page pixel units). */
  rects(a, b, pad = 0.18) {
    const out = []; let cur = null;
    for (let k = a; k < b; k++) {
      const w = this.words[k];
      if (!hasBox(w)) continue;
      if (!cur || cur.line !== w[LINE]) {
        cur = { line: w[LINE], x0: w[X], y0: w[Y], x1: w[X] + w[W], y1: w[Y] + w[H] }; out.push(cur);
      } else {
        cur.x0 = Math.min(cur.x0, w[X]); cur.y0 = Math.min(cur.y0, w[Y]);
        cur.x1 = Math.max(cur.x1, w[X] + w[W]); cur.y1 = Math.max(cur.y1, w[Y] + w[H]);
      }
    }
    return out.map((r) => {
      const p = Math.max(3, (r.y1 - r.y0) * pad);
      return { x: r.x0 - p, y: r.y0 - p, w: r.x1 - r.x0 + 2 * p, h: r.y1 - r.y0 + 2 * p };
    });
  }
  /** Click targets: each word's box widened to meet its neighbours on the same line. */
  hitRects() {
    const ws = this.words;
    return ws.map((w, k) => {
      if (!hasBox(w)) return { x: 0, y: 0, w: 0, h: 0 };
      const prev = ws[k - 1], next = ws[k + 1];
      const padY = Math.max(4, w[H] * 0.22);
      let x0 = w[X] - 4, x1 = w[X] + w[W] + 4;
      if (prev && hasBox(prev) && prev[LINE] === w[LINE]) x0 = Math.min(x0, (prev[X] + prev[W] + w[X]) / 2);
      if (next && hasBox(next) && next[LINE] === w[LINE]) x1 = Math.max(x1, (w[X] + w[W] + next[X]) / 2);
      return { x: x0, y: w[Y] - padY, w: x1 - x0, h: w[H] + 2 * padY };
    });
  }
}
```

#### B7.2 `speakable` — clean a word for the voice

```js
export function speakable(t) {
  // Pinyin with tone marks is not read (unmarked pinyin is ambiguous, so it stays).
  if (/[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜńňḿ]/i.test(t) || /[a-z][̀-ͯ]/i.test(t.normalize('NFD'))) return '';
  return t
    .replace(/[•·■●▪►]/g, '')
    .replace(/^\d{1,2}(?=[a-z]{2})(?!(?:st|nd|rd|th|am|pm)\b)/, '') // "2was" → "was", not "21st"
    .replace(/^p\.(\d)/i, 'page $1')
    .replace(/^pp\.(\d)/i, 'pages $1')
    .replace(/[—–]/g, ', ')
    .replace(/^=$/, 'equals')
    .replace(/^[+/]$/, '')
    .trim();
}
```

#### B7.3 Clauses and typed words (`segment.js`)

Port `clauseRanges(tokens)`, `tokenize(text)` and `hasCJK(text)` from
`docs/reference/web/js/segment.js` exactly (82 lines). The rules, for checking: a clause ends after a
token ending in `, ; :` (or their full-width forms, with closing quotes or brackets after them) or a
dash; a new clause starts before *because although though while whereas unless until if when whenever
where wherever since which who whom whose before after* when at least 2 words are on each side, and
before *and but or so yet* when at least 4 are on each side; one-word pieces join the next clause (a
last one-word piece joins the one before). Sample book page 2: *Students meet their friends there |
after class, | families bring their children, | and tourists take photos of everything.*

#### B7.4 The editor model (`editor.js`, top part)

Port `toModel`, `toDoc`, `alignWords` (with `fillGap`, `placeBetween`, `placeMissing`),
`layoutInBox`, `layoutTyped`, `readingOrder`, `lineHeight`, and the `OPS` object exactly from
`docs/reference/web/js/editor.js` (lines 1–465). They are pure functions on the model:

```js
// model = [block, ...], block = [sentence, ...], sentence = [word, ...]
// word  = {t: text, box: [x, y, w, h] or null (not on the page image), line, sp: space after}
export function toModel(doc) { /* blocks → sentences → words; a word with w = h = 0 gets box null */ }
export function toDoc(model) { /* back to words/sent/clause/blocks; clauses from clauseRanges();
                                  a word without box becomes [0, 0, 0, 0, t, -1, sp] */ }
export function alignWords(old, tokens) { /* LCS on normalised text: unchanged words keep their box;
   changed, split or joined words share the replaced boxes in proportion to their length */ }
```

Converting every page to the model and back must give the same document.

#### B7.5 Search `fold` (`search.js`)

Lower case, `’‘` → `'`, `“”` → `"`, `—–` → `-`, **one character for one character** (so positions
stay valid). Copy it from `docs/reference/web/js/search.js`.

#### B7.6 Two pages

```js
// idx: index into book.pages. Page 1 alone, then 2–3, 4–5 …
groupFor(book, idx) {
  if (!this.spreadOn) return [idx];
  const start = idx === 0 ? 0 : idx % 2 === 1 ? idx : idx - 1;
  return start === 0 ? [0] : [start, start + 1].filter((i) => i < book.pages.length);
}
```

### B8. Acceptance checks (with the sample book)

Use these as the *Done when* of the prompts; most come from the current app's test suite
(`docs/reference/web/tests` is not included; the checks are restated here).

1. `#/` shows *The Night Market* in *Public library* and *My books*; a click opens `#/L5a4d1e0b7c/1`.
2. Page 1 shows the image with **150** hit rectangles; page 2 **54**. The audio button sits left of
   *At Maya's stall*.
3. Sentence mode, pointing at *stall* outlines *Maya has a small stall near the entrance.* on the page
   (one rectangle, one line) and the same sentence in the Text list.
4. Clause mode, pointing at *queue* outlines *and the queue is often longer … next to her.* (3 lines,
   3 rectangles).
5. The Text list has 17 numbered sentences on page 1 in 5 blocks; with Spanish switched on, each has
   its translation under it.
6. A click on sentence 2 reads to the end of the page: the pill says *Reading page 1 · 1 of 16*; a
   click on the sentence being read pauses (*Paused*); again continues from the word where it stopped.
7. Repeat 3: the same sentence is read three times (*1st/2nd/3rd time of 3*), then the next.
8. The audio button plays the dialogue, opens the Script tab with **6** lines; a click on line 4
   (*Are they very spicy?*) jumps to 10.7 s; a click on it again pauses.
9. My audio lists *At Maya's stall*; clicking *B: Six for five dollars, or twelve for nine.* on the page
   plays that recording from 3.6 s with the sentence highlighted.
10. Search *dumplings* finds page 1 (twice); a click flashes the sentence.
11. Correction mode: split sentence 6 at *that*, merge it back, edit it, undo; after a reload (mock:
    same session) the correction is there; Restore brings the original back.
12. Collect: Word mode, click *patience,* → added to *New words* and marked green; flashcards *From:
    this page* gives 3 cards.
13. At 390 × 844 (phone): two-row top bar, nothing overlaps, the panel is a bottom sheet, a tap reads a
    sentence, a swipe turns the page.
14. No console errors, no failed requests.

---

## Part C: Prompts, in order

*Send one at a time. Each names the brief sections to read; Lovable can read `docs/BRIEF.md` in the
repository. If it cannot, paste those sections under the prompt.*

### C1. Skeleton, API client, mock data

> Read docs/BRIEF.md Part A, B2 (all), B3, B4 and B5.6. Set up the app: HashRouter with `#/`
> (LibraryPage) and `#/:book/:page` (ReaderPage); `src/api/types.ts` with the types of B3 exactly;
> `src/api/client.ts` (fetch JSON, errors as B4 says) with `VITE_API_MODE` = `mock` (default) or
> `server`; `src/api/mock.ts` answering from `public/fixtures/` as in the B2.4 table (including URL
> rewriting for `/lib`, `/web/recordings`, `/media`); the colour tokens of B5.6 as CSS variables
> with Tailwind using them, light and dark. LibraryPage: tabs Public library / My books, book cards
> from `/api/books`. ReaderPage: an empty shell with the top bar, the stage, the side panel with its
> four tabs, and the player bar hidden — no features yet. Attach: docs/screenshots/library.png,
> app-main.png.
>
> **Done when:** B8 check 1 passes; the reader shell looks like app-main.png without the page.

### C2. The page view, click modes, navigation

> Read B6.1, B6.2, B6.6, B7.1, B7.6, B5.2, B5.5. Port `PageText` exactly to `src/lib/pagetext.ts`.
> Build PageView (img + svg layers + hit rects + hotspot buttons), the mode switch (Sentence, Clause,
> Word, Off), hover highlights in sync with a placeholder text list, page navigation (field, arrows,
> keys), two-page view, zoom (−, +, Ctrl+wheel, the Fit steps), the Pages drawer with thumbnails.
> Highlights must update without re-rendering all hit rects.
>
> **Done when:** B8 checks 2–4 pass; zoom keeps the sentence you are on in place; in two-page view
> page 1 is alone and page 2 starts the pair 2–3 (the sample has no page 3, so page 2 shows alone too).

### C3. The Text list

> Read B6.7 and B5.3 (Text). Build the TextTab: blocks, numbered sentences on their own lines, word
> spans with trailing spaces, hover/click in sync with the page, the 0.28 s single-click delay, copy,
> save .txt, save the whole book's text.
>
> **Done when:** B8 check 5 (without translations) passes.

### C4. Speech and the Reader

> Read B6.3, B6.4, B7.2. Build `src/engines/speech.ts` (voices, ranking, speak with boundary events,
> generation counter, offline fallback, pieces by script) and `src/engines/reader.ts` (states, queue,
> chunks of up to 10 sentences / 1,500 characters, pause/continue from the last word, pause between
> sentences with countdown, repeat 1–10/∞, translation reading hook) outside React; the ReadingPill;
> word and sentence highlighting on page and list; Read page aloud; Read an area; the Voice tab of the
> settings popover (voice, speed, pause, repeat, highlight words, test voice) and the repeat button
> (R). Attach docs/screenshots/read-page-aloud.png and voice-settings.png.
>
> **Done when:** B8 checks 6 and 7 pass; Space pauses and continues; Esc stops.

### C5. Following the reading

> Read B6.5. Build `src/engines/follow.ts` and the Follow tab: keep the sentence being read at the
> chosen place, detect the person's own scrolling, own eased scrolling, the follow-back word at the
> top middle with its arrow.
>
> **Done when:** while reading, scrolling away keeps the page there; after the wait it follows again;
> the word shows at the top while off screen and a click brings it back.

### C6. Audio, scripts, video

> Read B6.8. Build the AudioPlayer engine and PlayerBar, the ScriptTab with the Transcript (sync,
> click to seek, click to pause/play, repeat per line with requestAnimationFrame), the auto-script
> note and the Transcribe button (hidden in mock mode), the VideoDialog with the same transcript, and
> the answer-key dialog with Ruffle (only when a hotspot is `swf`). Attach audio-transcript.png and
> video.png.
>
> **Done when:** B8 check 8 passes; repeat 2 on the script plays a line twice ("2/2").

### C7. Translation

> Read B6.10 and B4 (Translation). Build the Translation tab (language, show in list, show on page,
> offline only, Prepare with scope, levels and progress), translations under sentences (rtl for
> ar/fa/ur/ku/he), the page popup placed under the whole unit (above when no room, never covering
> it), word meanings in Word mode, script translation buttons (C6), the busy-wait countdown. Attach
> tr-panel.png and tr-menu.png.
>
> **Done when:** B8 check 5 with Spanish passes; pointing at a sentence on the page shows its Spanish in
> a box that does not cover it; L toggles the list.

### C8. Search

> Read B6.9 and B7.5. Build the search field, fold(), the Search tab with snippets, opening a result
> and flashing the sentence.
>
> **Done when:** B8 check 10 passes.

### C9. Text corrections

> Read B6.13 and B7.3, B7.4. Port segment.js and the editor model exactly (`src/lib/segment.ts`,
> `src/lib/editorModel.ts`). Build quick edits in the Text list (double-click, drag by dots, Ctrl+Z),
> correction mode with the tool bar and bulk row, Mark on page (draw a box), Re-read an area and Read
> the whole page again (with review; in mock mode answer `/api/ocr-region` with an error toast),
> Put in order by areas, saving with the 0.4 s debounce, Restore. Attach editor.png, list-edit.png,
> editor-drag.png, editor-split.png.
>
> **Done when:** B8 check 11 passes; toModel → toDoc gives back the same document for both sample
> pages.

### C10. My audio

> Read B6.11 and B4 (My audio). Build picking (first + last, paragraph box, Ctrl+click), the Create
> audio dialog with voices and Try, the job progress, the list (filter, search, play, download, CC,
> rename, delete), the paragraph play icons, highlighting while it plays, and the rule that a click on
> a sentence inside an MP3 plays the MP3 from there. Attach rec-pick.png, rec-dialog.png,
> rec-playing.png, rec-list.png.
>
> **Done when:** B8 check 9 passes.

### C11. Offline voice files

> Read B6.12. Build `src/engines/offlineAudio.ts` (IndexedDB), Generate in the Voice tab (scopes,
> only missing sentences, one package per page), the OFFLINE/ONLINE page badge, offline-first playback
> on click, the *Offline voice files on this page* list with delete, and Export folder.
>
> **Done when:** in mock mode, generating the page stores one package; the badge says OFFLINE on page 1
> and ONLINE on page 2; deleting it brings ONLINE back.

### C12. New words and flashcards

> Read B6.14 and B4 (New words). Build the collect mode with its pill and upward category panel,
> marks in category colours, and the Flashcards dialog (three filters with counts, card list,
> practice with flip, Again / I knew it, missed cards again, the end screen).
>
> **Done when:** B8 check 12 passes; "Again" brings the card back 4 cards later.

### C13. Library, adding books, accounts

> Read B6.15, B4 (Session and library). Build Add a book (text, PDF, photos) with uploads, the sample
> review and making the pages; settings and sharing; report; the Admin tab; sign up, log in, change
> password, log out (public mode); the PIN login (home Wi-Fi mode). In mock mode, adding a text book
> may simply show the progress and then open the sample book. Attach library.png and add-book.png.
>
> **Done when:** every dialog validates its fields and shows server errors; the flows follow B6.15.

### C14. Phones, shortcuts, finishing

> Read B5.4, B6.16, B6.17, B6.18, B6.19. Make the phone layout and touch gestures, all keyboard
> shortcuts, remembered settings with the `aef3.` keys, the web manifest, and an accessibility pass.
> Attach phone.png and phone-page.png.
>
> **Done when:** B8 checks 13 and 14 pass.

### C15. The real server

> Read B2.3. Add the Vite proxy (`changeOrigin: false`) for `/api`, `/lib`, `/web`, `/.shared`, and
> `base: '/web/app/'` for production builds. Write `docs/RUN.md`: `npm run build`, copy `dist/` to
> `web/app/` of the Lingua Books folder, start `Start Lingua Books.bat`, open
> `http://127.0.0.1:8765/web/app/`.
>
> **Done when:** (on the person's computer) the Student Book opens at page 25 with clickable text, and
> a correction is saved.

*Optional, later:* **Import old app** wizard (B6.15, last item).

---

## Part D: Pitfalls

- **Coordinates.** Never convert word boxes to screen pixels by hand: the SVG `viewBox` is the page
  size, so boxes line up at every zoom. Hotspots are positioned in percent of the page size.
- **Speech.** Voices arrive late (`voiceschanged`). Some voices report no `boundary` events: then read
  one unit per request and highlight the whole unit. `speechSynthesis.pause()` is unreliable: cancel
  and speak again from the last word. On iPhones the first `speak()` must come from a tap. Chrome stops
  very long utterances: keep pieces ≤ 1,500 characters.
- **Re-renders.** Boundary events and audio time arrive many times a second. Keep the engines outside
  React and update highlights through refs or a tiny store with selectors; never re-render the 150–600
  hit rectangles on each event.
- **Clicks vs double clicks.** The Text list waits 0.28 s before reading; time double taps yourself.
- **Drag and drop.** Use pointer events (mouse, pen and finger alike), start only from the handle after
  5 px, `Esc` cancels. HTML5 drag-and-drop sometimes ends without a drop.
- **Same origin.** The server refuses changes whose `Origin` host differs from `Host`. Do not add
  `credentials` tricks or a CORS proxy; serve the app from the server (B2.3).
- **Audio seeking** needs Range requests; the Python server supports them, and so does the dev proxy.
- **Translation and voices** go only through the server (keys, CORS, rate limits, saved files).
- **Offline.** Saved translations and offline voice files make pages work without internet; the badge
  is per page, not per book.
- **Content.** Only the sample book may be used in Lovable. The disc's books (Oxford University Press)
  stay on the owner's computer and are served by the local server; screenshots of them are for layout
  only.
- **Known quirk of the server (not for the React app):** the sentence splitter treats a lone `a`–`h` at
  the start of a line as a list marker, so a wrapped line that begins with the word *a* splits its
  sentence (`LIST_MARK` in `web/tools/segment_text.py`). The sample text avoids it.

---

## Appendix: where each feature lives now

| Feature | Current browser code | Current server code |
|---|---|---|
| App controller, reading queue (Reader), zoom, panel, keys, touch | `js/main.js` | |
| One page: image, svg layer, hotspots, drawing boxes | `js/pageview.js` | |
| Text model | `js/pagetext.js` | `tools/segment_text.py` (makes it) |
| Speech | `js/speech.js` | |
| Audio player, transcript, video, answer keys | `js/media.js` | |
| Search | `js/search.js` | `server.py` (`/api/search`) |
| Corrections | `js/editor.js`, `js/segment.js` | `server.py` (`/api/text`, `/api/ocr-region`) |
| My audio, offline voice files | `js/recordings.js`, `js/offline-audio.js`, `js/voice-options.js` | `tts.py`, `windows_speech.ps1` |
| Translation | `js/translation.js` | `translate.py` |
| Following the reading | `js/follow.js` | |
| New words, flashcards | `js/words.js` | `words.py`, `lessons.json` |
| Speech recognition | `js/transcription.js` | `transcription.py` |
| Library, accounts, admin | `js/library.js` | `library.py`, `accounts.py`, `db.py` |
| Import old app | `js/migration.js` | `migration.py` |
| Helpers, saved settings | `js/util.js` | |
| Page and styles | `index.html`, `css/app.css` | |
