// Text the page's text layer left out (js/missing-text.js): the dark box with no known word in it is
// found, the text already read is not, and page numbers in the margin are not.
// Run: node web/tests/missing-text-test.mjs
import assert from 'node:assert/strict';
import { missingTextBoxes } from '../js/missing-text.js';

const W = 500, H = 700;
const gray = new Uint8ClampedArray(W * H).fill(255);
const block = (x0, y0, x1, y1, step = 6) => { // dark strokes like rows of characters
  for (let y = y0; y < y1; y += 14) for (let x = x0; x < x1; x += step * 2) for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < step; dx++) gray[(y + dy) * W + x + dx] = 20;
};
block(40, 160, 460, 260);   // a table of words: nothing reads it
block(40, 60, 460, 110);    // a line of text that is read
block(230, 685, 270, 697);  // a page number in the margin
const covers = [{ x: 30 / W, y: 55 / H, w: 440 / W, h: 62 / H }];
const found = missingTextBoxes(gray, W, H, covers);
assert.equal(found.length, 1, JSON.stringify(found));
const [b] = found;
assert.ok(b.y > 150 / H && b.y < 175 / H && b.y + b.h > 255 / H && b.y + b.h < 280 / H, `the table: ${JSON.stringify(b)}`);
assert.ok(b.x < 50 / W && b.x + b.w > 450 / W, 'its width');
assert.equal(missingTextBoxes(gray, W, H, [...covers, { x: 0, y: 150 / H, w: 1, h: 120 / H }]).length, 0, 'read: nothing is missing');
console.log('PASS: the box with no known text is found; text read already and the margin are not');
