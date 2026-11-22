// A word with a box far wider than its letters (it runs on over blank page) is cut back for the highlight.
// Run: node web/tests/word-width-test.mjs
import assert from 'node:assert/strict';
import { PageText, visibleWidth } from '../js/pagetext.js';

// [x, y, w, h, text, line, space]
assert.equal(visibleWidth([0, 0, 40, 20, 'up.', 0, 1]) <= 40, true);
assert.ok(visibleWidth([100, 0, 300, 20, 'up.', 0, 1]) < 60, 'a 3-letter word 300 wide is cut back');
assert.equal(visibleWidth([0, 0, 120, 20, 'coffee', 0, 1]), 120, 'a normal word is kept');
assert.equal(visibleWidth([0, 0, 300, 20, '________', 0, 1]), 300, 'a blank to fill in keeps its width');
assert.equal(visibleWidth([0, 0, 0, 0, 'x', 0, 1]), 0);
const doc = { words: [[10, 0, 40, 20, 'Most', 0, 1], [60, 0, 300, 20, 'up.', 0, 1]], sent: [[0, 2]], clause: [[0, 2]], blocks: [[0, 1]] };
const [r] = new PageText(doc).rects(0, 2);
assert.ok(r.x + r.w < 160, `the highlight ends near the text (${Math.round(r.x + r.w)}), not at 360`);
console.log('PASS: words with too wide a box are cut back to their letters');
