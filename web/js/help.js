// Help on every button. Point at an icon (a mouse or pen), or hold a finger on it (a phone), and a card
// follows the pointer and says what it does, how it works and how to use it, with its shortcut.
// The text comes from the table below (found by the button's id, its data-help, its name or its label);
// a button not in the table gets its own title as the text, so every button explains itself. The "?"
// button in the top bar switches the cards on and off (kept). Nothing else is changed: with the cards
// off, the browser's own small tips show as before.
import { el, store } from './util.js';

/**
 * key → {d: how it works (one or two sentences), use: [steps], note: something to watch for}.
 * The key is an id, a data-help, or the lower-case name/label of the button.
 */
export const HELP = {
  // ---- The top bar
  'btn-pages': { d: 'Opens the list of everything in this book: all its pages as small pictures, its contents (units and lessons) and its resources (audio, video).', use: ['Click it to open or close the list.', 'Click a page, a lesson or a resource to go there.'] },
  'btn-back': { d: 'Returns to the page you were on before you jumped (from the contents, a search result or a link).', use: ['Click once to go back one jump.'] },
  'btn-prev': { d: 'Goes to the page before this one. In a two-page view it goes back by two pages.', use: ['Click it, or press the left arrow key.'] },
  'btn-next': { d: 'Goes to the next page. In a two-page view it goes on by two pages.', use: ['Click it, or press the right arrow key.'] },
  'page-input': { d: 'Shows the number of the page you are on. Type another number to go straight to that page.', use: ['Click the number, type the page, press Enter.'] },
  'btn-zoom-out': { d: 'Makes the page smaller so more of it fits on the screen.', use: ['Click it, or press −.', 'With a mouse: hold Ctrl and turn the wheel; the page zooms around the pointer.'] },
  'btn-zoom-in': { d: 'Makes the page bigger.', use: ['Click it, or press +.', 'With a mouse: hold Ctrl and turn the wheel up; the page zooms around the pointer.'] },
  'btn-fit': { d: 'Zooms step by step to what you read: whole page → page width → paragraph → sentence → word. Each click goes one step in; at the word it comes back out the same way.', use: ['Click again and again to go in, and then out.', 'Press 0 to see the whole page.'] },
  'btn-spread': { d: 'Shows two pages side by side, like an open book. Reading goes on from the left page to the right page.', use: ['Click to switch it on; click again to go back to one page.'] },
  'btn-layout': { d: 'Opens the Page layout window: the page with boxes round its paragraphs. There you draw, move, merge and number the boxes, read a page again, make audio and replace pictures.', use: ['Click it.', 'Choose a tab (Read, Order, Merge, Audio, Pictures, Text) and use its buttons.', 'Press “Apply changes” to save, and “Finished” to come back here.'], note: 'Only the owner of a book (or an admin) has it.' },
  'btn-voice': { d: 'Settings for the voice that reads aloud, its speed, the language of the translations, offline audio and the screen layout.', use: ['Click it, choose a tab, change what you want. It is kept for next time.'] },
  'btn-assistant': { d: 'A spoken conversation with a tutor about the book. You talk, it answers by voice.', use: ['Click it, press “Start conversation”, speak, and listen.', 'Press “End conversation” when you finish.'], note: 'Needs a microphone and the AI service switched on by the admin.' },
  'btn-translate': { d: 'Shows the translation of a sentence when you point at it (in the language chosen under Settings → Translation).', use: ['Click to switch it on, then point at any sentence.', 'Click again to switch it off.'] },
  'btn-repeat': { d: 'Says each sentence again and again while the page is read: once, 2, 3, 4 or 5 times, or for ever (∞).', use: ['Click to go to the next number; after 5 it goes to ∞, then back to once.', 'The number shows on the button. Press R for the same.'] },
  'btn-collect': { d: 'Collects new words. While it is on, a click on a word, a clause or a whole sentence of the page adds it to your word list, with its meaning.', use: ['Switch it on (or press N).', 'Choose Word, Clause or Sentence for what one click picks.', 'Click on the page. Choose the category at the bottom.', 'Practise them with the Flashcards button.'] },
  'btn-cards': { d: 'Flashcards of the words you collected: a word on one side, its meaning on the other.', use: ['Click it (or press C), turn a card, say if you knew it.'] },
  'btn-panel': { d: 'Shows or hides the side panel (Voice, Translation, Follow, Screen; Text, Listen, Search, Audio).', use: ['Click it, or press T. Hide it to give the page more room.'] },
  'btn-help': { d: 'Switches these help cards on or off. With them on, pointing at any button explains it.', use: ['Click to switch them off if you know the buttons; click again to bring them back.'] },
  'brand': { d: 'The name of the app. Clicking it takes you to the library, the home page with all the books.', use: ['Click it to go home.'] },
  'book-title': { d: 'The book you are reading. Clicking it goes back to the library, where you can open another book.', use: ['Click it to leave this book (your page is remembered).'] },
  // ---- How a click reads (the four choices beside the page number) and the language
  'data-mode:sentence': { d: 'A click on the page reads the whole sentence you click, then the sentences after it to the end of the page.', use: ['Choose it (or press 1), then click any sentence.'] },
  'data-mode:clause': { d: 'A click reads only the part of the sentence between commas and other breaks: a short piece to practise.', use: ['Choose it (or press 2), then click a part of a sentence.'] },
  'data-mode:word': { d: 'A click reads only the word you click. Double-click a sentence to break it down word by word.', use: ['Choose it (or press 3), then click a word.'] },
  'data-mode:off': { d: 'Turns clicking off, so a click does nothing: handy for drawing boxes, zooming and scrolling on the page without reading.', use: ['Choose it (or press 4).'] },
  'data-lang:both': { d: 'Reads both languages of a bilingual page: the Chinese and the English.', use: ['Choose it, then click a sentence or press Play.'] },
  'data-lang:zh': { d: 'Reads only the Chinese sentences; the English ones are skipped.', use: ['Choose it before you start reading.'] },
  'data-lang:en': { d: 'Reads only the English sentences; the Chinese ones are skipped.', use: ['Choose it before you start reading.'] },
  // ---- Tabs
  'data-ptab:voice': { d: 'Choose the voice that reads, its speed, the pauses between sentences and offline audio.', use: ['Open it, choose a voice from the list, press Test voice.'] },
  'data-ptab:translation': { d: 'Choose the language of the translations, and whether they are read aloud, shown under the sentences, or kept for offline use.', use: ['Open it, choose your language.', 'Then press the translation button in the top bar.'] },
  'data-ptab:follow': { d: 'How the page follows the sentence being read: in the middle, near the top, or only when it leaves the screen.', use: ['Open it, choose a place.'] },
  'data-ptab:screen': { d: 'The size of the letters, the theme (light or dark) and the layout for this device: automatic, phone, tablet or computer.', use: ['Open it and choose.'] },
  'data-dtab:pages': { d: 'All the pages of the book as small pictures. Click one to go to it.', use: ['Click a picture.'] },
  'data-dtab:contents': { d: 'The books of this level and the units or lessons of each. Click a lesson to open the page where it starts. The owner can correct the list.', use: ['Click a book to see its lessons, then a lesson.', 'The owner presses Edit to fix a wrong page.'] },
  'data-dtab:resources': { d: 'The audio, video and extra files that belong to this book.', use: ['Click one to play or open it.'] },
  'data-tab:text': { d: 'The text of the page as a list of sentences. Click one to hear it. The pencil button corrects the text.', use: ['Open it and click a sentence.'] },
  'data-tab:listen': { d: 'The script of an audio track: its lines, in step with the sound, and their translation.', use: ['Open it, press play on a track, and follow the lines.'] },
  'data-tab:search': { d: 'Finds a word or a phrase in the whole book and shows every page that has it.', use: ['Type the word, press Enter, click a result.'] },
  'data-tab:audio': { d: 'The MP3 recordings you made with a natural voice from sentences of the book. Play, rename, download or delete them, or make a new one.', use: ['Press “New audio”, click the sentences (on one page or several), press Create audio.'] },
  'data-scope:public': { d: 'The books everyone can see, shared by their owners and the admins.', use: ['Click a book to open it.'] },
  'data-scope:mine': { d: 'Your own books, private ones too. Only you (and the site admins) can see a private book.', use: ['Open one, or press “Add a book”.'] },
  'data-scope:admin': { d: 'The admin page: users, books and reports, giving books to users, plans, statistics and API keys.', use: ['Choose a part at the top.'] },
  // ---- The reading bar and the panel
  'reading-follow': { d: 'Makes the page scroll by itself to the sentence being read, so you do not have to look for it.', use: ['Click to switch it on or off (or press F).'] },
  'read-area': { d: 'Reads only a part of the page: you draw a box and the sentences in it are read aloud.', use: ['Click it, drag a box on the page, let go.', 'Press Esc to stop.'] },
  'tr-toggle': { d: 'Shows the translation of every sentence of the page under the sentence.', use: ['Click (or press L) to show, again to hide.'] },
  'lib-tree-btn': { d: 'Hides or shows the tree of branches (the folders of the library) on the left.', use: ['Click it to give the books more room.'] },
  // ---- The text editor
  'edit-text': { d: 'Opens the text of this page as a list of sentences you can correct: change words, split, merge, move, delete and add.', use: ['Click it (or press E).', 'Click a sentence in the list and use the buttons under it.', 'Undo takes the last change back.'], note: 'Your corrections are saved for this book.' },
  'copy-text': { d: 'Copies all the text of this page, so you can paste it elsewhere.', use: ['Click it, then paste with Ctrl+V.'] },
  'save-text': { d: 'Saves the text of this page as a .txt file on your computer.', use: ['Click it and choose where to keep the file.'] },
  'edit-undo': { d: 'Takes back the last change you made to the text of this page. You can press it again for the one before.', use: ['Click it, or press Ctrl+Z.'] },
  'edit-reset': { d: 'Throws away all your corrections of this page and brings back the text the app first read.', use: ['Click it and confirm. It cannot be undone.'] },
  'change the text': { d: 'Edits the words of the chosen sentence.', use: ['Click a sentence, then this button (or press Enter, or double-click the sentence).', 'Type, then press Enter to keep it.'] },
  'split into sentences': { d: 'Cuts a long sentence into several. You click the word where each new sentence begins.', use: ['Choose the sentence, press this button.', 'Click each word that starts a new sentence (those after 。？！ are marked already).', 'Press Split (or Enter).'] },
  'merge with the sentence before': { d: 'Joins the chosen sentence to the one before it, into one sentence.', use: ['Choose the sentence and press it.'] },
  'merge with the sentence after': { d: 'Joins the chosen sentence to the one after it.', use: ['Choose the sentence and press it.'] },
  'move up': { d: 'Moves the chosen sentence before the sentence above it. This changes the reading order.', use: ['Choose the sentence and press it.'] },
  'move down': { d: 'Moves the chosen sentence after the sentence below it.', use: ['Choose the sentence and press it.'] },
  'start ordered sentence moves': { d: 'Puts sentences in order with a reference. Choose the sentence to start from; each sentence you click next goes right after the one before. A sentence already next keeps its place.', use: ['Choose the first sentence.', 'Press this button (it stays pressed).', 'Click the sentences in the order you want.', 'Press the button again to stop.'] },
  'new paragraph': { d: 'Starts a new paragraph at the chosen sentence. Paragraphs are read as one piece with a pause between.', use: ['Choose the sentence and press it.'] },
  'mark on page': { d: 'Shows where a sentence is on the page picture: you drag a box round it.', use: ['Press it, then drag a box on the page picture round the sentence.'] },
  're-read an area': { d: 'Reads part of the page again with OCR (text recognition) when the text is wrong or missing.', use: ['Press it, draw one box or several on the page.', 'Press Read; check what was found; keep it or not.'] },
  'add a sentence after': { d: 'Adds a new, empty sentence after the chosen one, for text that is missing.', use: ['Press it, type the text, press Enter.'] },
  'delete': { d: 'Deletes the chosen sentence. Undo brings it back.', use: ['Choose it and press this button (or the Delete key).'] },
  'edit-tools-toggle': { d: 'Folds the editing buttons away (and shows them again) so the text list has more room. They fold by themselves while a re-read is being reviewed.', use: ['Click it to fold or show them. It is kept.'] },
  'panel-resize': { d: 'The width of this side panel. A wider panel gives the text more room.', use: ['Drag the edge left or right, or use the arrow keys.', 'Double-click: wide / normal. It is kept.'] },
  'data-op:ocr-ai': { d: 'The AI looks at the picture inside this box and writes the printed text it sees: for faint or small print the OCR could not read. Its text goes into the boxes below, for you to check and correct.', use: ['Press it and wait a few seconds.', 'Check the lines, fix any mistake, untick any you do not want.', 'Press “Add selected sentences”.'], note: 'Needs the OpenAI key (Admin → API) and AI left on your account.' },
  'data-op:ocr-ai-all': { d: 'The AI reads every area that has no text yet, one after the other. You check what it wrote.', use: ['Press it, wait, then check each area.'] },
  // ---- The player and dialogs
  'pl-play': { d: 'Plays or pauses the audio or video.', use: ['Click it, or press the space bar.'] },
  'pl-rate': { d: 'Changes the speed of the audio: slower for learning, faster for review.', use: ['Choose a speed from the list.'] },
  'pl-close': { d: 'Closes the player and stops the sound.', use: ['Click it.'] },
  'md-close': { d: 'Closes this window. Nothing you typed is saved unless it has its own Save button.', use: ['Click it, or press Esc.'] },
  'drawer-close': { d: 'Closes the list of pages, contents and resources.', use: ['Click it, or press P.'] },
  // ---- The library
  'lib-add': { d: 'Adds your own book: a PDF, photos or typed text. You choose its language and who may see it. New books are private until you share them.', use: ['Click it, choose the file, give a title, press Add.', 'Then open the book and press “Page layout” to check how it was read.'] },
  'lib-translator': { d: 'A two-way voice translator. Speak or write in one language and get the translation, in writing and by voice, in the other.', use: ['Choose the two languages at the top.', 'Press a 🎤 button and speak, or write and press an arrow button.'] },
  'lib-migrate': { d: 'Brings the books and audio of the old app into your library.', use: ['Click it and follow the steps.'] },
  // ---- The Page layout window (its buttons have text; the text is the key)
  'read this page again': { d: 'Reads the page from the PDF text, or with OCR if it has none, and draws the boxes again. This replaces the boxes of the page (until you press Apply, nothing is saved).', use: ['Click it; wait; check the boxes; press Apply.'] },
  'read the selected area again': { d: 'Reads only the chosen box again with OCR and replaces its text.', use: ['Choose a box (its number in the list, or the box on the page).', 'Click this button, check, keep.'] },
  'draw boxes to read': { d: 'You draw boxes round writing the app missed or got wrong; OCR reads them all.', use: ['Press it, drag boxes on the page.', 'Press “Read boxes (OCR)”. Check, then use them.'] },
  'find text the page is missing': { d: 'Looks at the picture for writing with no text (a table the scan’s text layer left out) and draws a box round each. Nothing is read until you press Read boxes.', use: ['Press it.', 'Take back any box that is only a picture.', 'Press “Read boxes (OCR)”, check, then Apply.'] },
  'take back the last box': { d: 'Removes the box you drew last.', use: ['Click it as often as needed.'] },
  'play this page aloud': { d: 'Reads every sentence of the page in the order of the boxes, with the voice chosen in Settings, and marks the sentence being read. Use it to check the order.', use: ['Click it; click again to stop.'] },
  'analyze this page with ai': { d: 'Asks the AI to draw the boxes. You can tell it what to do in your own words. The result is a draft: look at it, then apply it.', use: ['Write what you want in the box (optional).', 'Press the button; wait about a minute.', 'Check the suggestion, then Apply.'], note: 'Needs the OpenAI key (Admin → API) and AI pages left on your account.' },
  'analyze again': { d: 'Asks the AI again for this page, for a new suggestion.', use: ['Press it after changing your instruction.'] },
  'add a text area': { d: 'Draws a new box where the app found no text, so you can add text to it.', use: ['Press it, drag a box on the page.'] },
  'order boxes automatically': { d: 'Numbers the boxes in reading order (top to bottom, columns left to right). A new box you draw gets its place by itself while this is on.', use: ['Click it to switch on or off.'] },
  'draw an area in reading order': { d: 'You drag a rectangle over some boxes. The boxes inside it are numbered one after the other: top to bottom, then left to right (right to left for Arabic and the like). The first one keeps the smallest number the boxes had; the other boxes keep their order around them.', use: ['Press it, drag a rectangle over the boxes.', 'Drag again for another part of the page.', 'Press Finish when done.'] },
  'reference, then click areas': { d: 'Puts boxes in order with a reference box: choose the first, then click the others in order.', use: ['Press it, click the starting box, click the rest in order.', 'Press it again to stop.'] },
  'merge with next area': { d: 'Joins the chosen box and the next one into one box.', use: ['Choose a box and press it.'] },
  'merge with previous area': { d: 'Joins the chosen box and the one before it.', use: ['Choose a box and press it.'] },
  'merge areas inside a selection': { d: 'Joins all the boxes inside a rectangle you draw into one.', use: ['Press it, drag a rectangle round the boxes.'] },
  'make new audio (natural voice)…': { d: 'Makes an MP3 with a natural voice from sentences you choose, on this page or on several pages (choose, go to the next page, choose again). The audio is kept in My audio.', use: ['Press it, click the sentences, press Create audio.', 'For many pages use “Pages from … to …”.'] },
  'play mode': { d: 'Lets you hear the audio and video buttons of the page as readers will, to check them.', use: ['Press it and click a play button on the page.'] },
  'select a picture area': { d: 'Draws a box round a picture to replace it with yours or an AI picture.', use: ['Press it, drag a box round the picture.', 'Give the new picture.'] },
  'apply changes': { d: 'Saves what you changed on the pages in the scope (This page only, a range, or All pages).', use: ['Choose the Scope first.', 'Press it and wait for the pages to be rebuilt.'] },
  'finished: go to the app': { d: 'Closes this window and returns to the book. Changes not applied are lost (it asks).', use: ['Click it when you have pressed Apply.'] },
  // ---- Break down a sentence
  'a−': { d: 'Makes the letters in this window smaller.', use: ['Click as often as needed. It is kept.'] },
  'a+': { d: 'Makes the letters in this window bigger.', use: ['Click as often as needed. It is kept.'] },
  'bd-repeat': { d: 'How many times the sentence, its translation or Play all are said: once, 2, 3, or for ever (∞).', use: ['Click to change the number.', 'Press Stop (or another sound) to end ∞.'] },
  // ---- The Translator
  'swap the two languages': { d: 'Exchanges the first and the second language.', use: ['Click it.'] },
  'listen to the translation': { d: 'Reads the translation aloud with the voice of its language.', use: ['Click it. If the device has no voice for the language, it says so.'] },
  'copy the translation': { d: 'Copies the translation to paste elsewhere.', use: ['Click, then Ctrl+V.'] },
  'remove this message': { d: 'Removes this message from the conversation on this device.', use: ['Click it.'] },
  // ---- Admin
  'give…': { d: 'Gives a copy of this book to other accounts (each gets a private copy), or makes it public.', use: ['Click it, choose accounts, press Give.'] },
};

const KEY = 'helpTips';
const DELAY = 380;
let on = store.get(KEY, true) !== false;
let tip = null, current = null, timer = 0, shownOnce = false, held = '', touchTimer = 0, swallow = null;

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\d+\)\s*$/, '').replace(/[.…]+$/, (m) => (m === '…' ? '…' : '')).trim();
const CANDIDATE = 'button, [role=tab], [role=radio], [role=button], summary, a[title], select[title], label[title], input[title], [data-help]';

/** What a control is called: its label, else its title up to the first colon/dash, else its text. */
function nameOf(node) {
  const label = node.getAttribute('aria-label') || '';
  const title = node.getAttribute('title') ?? node.dataset.helpTitle ?? '';
  return (label || title.split(/\s[—-]\s|: /)[0] || node.textContent || '').trim().replace(/\s+/g, ' ');
}

function entryOf(node) {
  const data = ['mode', 'lang', 'ptab', 'dtab', 'tab', 'scope', 'op'].map((a) => (node.dataset[a] ? `data-${a}:${node.dataset[a]}` : ''));
  const keys = [node.dataset.help, node.id, ...data, ...[...node.classList].filter((c) => HELP[c]), norm(node.getAttribute('aria-label')), norm(node.textContent), norm(node.dataset.helpTitle ?? node.getAttribute('title'))];
  for (const k of keys) if (k && HELP[k]) return HELP[k];
  return null;
}

/** "(P)", "(Ctrl+Z)", "(←)" at the end of a title: the shortcut. */
function shortcutOf(text) {
  const m = /\(([^()]{1,14})\)\s*$/.exec(text || '');
  return m && !/^[\d,\s∞]+$/.test(m[1]) ? m[1] : '';
}

function build(node) {
  const title = node.dataset.helpTitle ?? node.getAttribute('title') ?? '';
  const e = entryOf(node);
  const name = nameOf(node);
  const card = el('div', { class: 'help-card' }, el('b', { class: 'help-name' }, name || 'Button'));
  const key = shortcutOf(title);
  if (key) card.append(el('kbd', { class: 'help-key' }, key));
  const text = e?.d || title.replace(/\s*\([^()]{1,14}\)\s*$/, '');
  if (text && text !== name) card.append(el('p', { class: 'help-d' }, text));
  if (e?.use?.length) card.append(el('p', { class: 'help-h' }, 'How to use it'), el('ol', { class: 'help-use' }, ...e.use.map((s) => el('li', {}, s))));
  if (e?.note) card.append(el('p', { class: 'help-note' }, e.note));
  if (node.disabled || node.getAttribute('aria-disabled') === 'true') card.append(el('p', { class: 'help-note' }, 'It is grey now: it needs something first (read what it says above, or choose a page, a sentence or a box).'));
  return card;
}

function place(x, y) {
  if (!tip || tip.hidden) return;
  const pad = 14, w = tip.offsetWidth, h = tip.offsetHeight, W = window.innerWidth, H = window.innerHeight;
  let left = x + pad, top = y + pad + 6;
  if (left + w > W - 8) left = Math.max(8, x - w - pad);
  if (top + h > H - 8) top = Math.max(8, y - h - pad);
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}

function hide() {
  clearTimeout(timer); clearTimeout(touchTimer);
  if (tip) tip.hidden = true;
  if (current) {
    current.removeAttribute('aria-describedby');
    if (current.dataset.helpTitle != null) { current.setAttribute('title', current.dataset.helpTitle); delete current.dataset.helpTitle; }
  }
  current = null;
}

function show(node, x, y) {
  if (!tip) { tip = el('div', { class: 'help-tip', role: 'tooltip', id: 'help-tip', hidden: true }); document.body.append(tip); }
  tip.replaceChildren(build(node));
  tip.hidden = false;
  node.setAttribute('aria-describedby', 'help-tip');
  shownOnce = true;
  place(x, y);
}

/** Point at a control: the browser's own tip is set aside (its title is put back when the pointer leaves). */
function enter(e) {
  if (!on || e.pointerType === 'touch') return;
  const node = e.target.closest?.(CANDIDATE);
  if (!node || node === current || node.closest('.help-tip, .tr-tip, .page, .text-view')) return;
  if (!(node.getAttribute('title') || node.dataset.help || node.getAttribute('aria-label') || entryOf(node))) return;
  if (node === swallow) return; // (pressed: no card until the pointer has left and come back)
  hide();
  current = node;
  const title = node.getAttribute('title');
  if (title != null) { node.dataset.helpTitle = title; node.removeAttribute('title'); }
  const { clientX: x, clientY: y } = e;
  clearTimeout(timer);
  timer = setTimeout(() => { if (current === node && node.isConnected) show(node, x, y); }, shownOnce ? 120 : DELAY);
}

function leave(e) {
  if (!current) { swallow = null; return; }
  if (e.relatedTarget && current.contains(e.relatedTarget)) return;
  if (swallow === current) swallow = null;
  hide();
}

function setOn(value, button) {
  on = value; store.set(KEY, on);
  if (!on) hide();
  button?.setAttribute('aria-pressed', String(on));
}

/** Start the help: the cards, and the "?" button (#btn-help) that switches them. */
export function startHelp() {
  document.addEventListener('pointerover', enter, true);
  document.addEventListener('pointerout', leave, true);
  document.addEventListener('pointermove', (e) => { if (tip && !tip.hidden) place(e.clientX, e.clientY); }, { passive: true });
  document.addEventListener('pointerdown', (e) => { if (current) { swallow = current; hide(); swallow = e.target.closest?.(CANDIDATE); } }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
  // A finger held on a control (about half a second): its card shows; the tap that follows does nothing.
  document.addEventListener('touchstart', (e) => {
    if (!on) return;
    const node = e.target.closest?.(CANDIDATE);
    if (!node || node.closest('.help-tip, .page, .text-view') || !(node.getAttribute('title') || node.getAttribute('aria-label') || entryOf(node))) return;
    const t = e.touches[0];
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      held = node; current = node; show(node, t.clientX, Math.max(20, t.clientY - 140));
      setTimeout(() => { if (current === node) hide(); }, 6000);
    }, 550);
  }, { passive: true });
  const cancelTouch = () => clearTimeout(touchTimer);
  document.addEventListener('touchmove', cancelTouch, { passive: true });
  document.addEventListener('touchend', cancelTouch, { passive: true });
  document.addEventListener('click', (e) => { if (held && e.target.closest?.(CANDIDATE) === held) { e.preventDefault(); e.stopPropagation(); } held = ''; }, true);
  const button = document.getElementById('btn-help');
  if (button) {
    button.setAttribute('aria-pressed', String(on));
    button.addEventListener('click', () => {
      setOn(!on, button);
      if (on) { const r = button.getBoundingClientRect(); show(button, r.left, r.bottom); setTimeout(() => { if (current === null) hide(); }, 3500); }
    });
  }
}
