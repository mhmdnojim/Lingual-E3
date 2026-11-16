/**
 * Text the page's text layer left out. A scanned PDF's hidden text can miss a whole box (a table of
 * words in a dotted frame): the page shows it, the app does not read it. This finds the dark parts
 * of the picture that no known word covers, grouped into boxes (fractions of the page), so they can
 * be read with OCR and checked.
 * gray: W×H brightness (0 dark … 255 white); covers: boxes of the words already known, as fractions.
 */
export function missingTextBoxes(gray, W, H, covers = [], { dark = 150, minWidth = 0.18, minHeight = 0.035, margin = 0.035 } = {}) {
  const ink = new Uint8Array(W * H);
  for (let i = 0; i < ink.length; i++) ink[i] = gray[i] < dark ? 1 : 0;
  for (const c of covers) { // (what is read already is not missing)
    const pad = 0.004;
    const x0 = Math.max(0, Math.floor((c.x - pad) * W)), x1 = Math.min(W, Math.ceil((c.x + c.w + pad) * W));
    const y0 = Math.max(0, Math.floor((c.y - pad) * H)), y1 = Math.min(H, Math.ceil((c.y + c.h + pad) * H));
    for (let y = y0; y < y1; y++) ink.fill(0, y * W + x0, y * W + x1);
  }
  const cell = Math.max(3, Math.round(W / 110));
  const GW = Math.ceil(W / cell), GH = Math.ceil(H / cell);
  const on = new Uint8Array(GW * GH);
  for (let gy = 0; gy < GH; gy++) {
    for (let gx = 0; gx < GW; gx++) {
      let n = 0;
      for (let y = gy * cell; y < Math.min(H, (gy + 1) * cell); y++) for (let x = gx * cell; x < Math.min(W, (gx + 1) * cell); x++) n += ink[y * W + x];
      if (n >= Math.max(2, cell * cell * 0.04)) on[gy * GW + gx] = 1;
    }
  }
  // Neighbouring cells (two cells apart at most) belong together.
  const seen = new Uint8Array(GW * GH), R = 2, out = [];
  for (let start = 0; start < on.length; start++) {
    if (!on[start] || seen[start]) continue;
    const stack = [start];
    seen[start] = 1;
    let x0 = GW, y0 = GH, x1 = -1, y1 = -1, count = 0;
    while (stack.length) {
      const k = stack.pop(), gx = k % GW, gy = (k - gx) / GW;
      count += 1;
      x0 = Math.min(x0, gx); x1 = Math.max(x1, gx); y0 = Math.min(y0, gy); y1 = Math.max(y1, gy);
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const nx = gx + dx, ny = gy + dy;
          if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
          const j = ny * GW + nx;
          if (on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    const box = { x: (x0 * cell) / W, y: (y0 * cell) / H, w: ((x1 - x0 + 1) * cell) / W, h: ((y1 - y0 + 1) * cell) / H };
    if (count < 12 || box.w < minWidth || box.h < minHeight) continue;
    // (page numbers, running heads, the edge of the scan)
    if (box.y + box.h < margin || box.y > 1 - margin || box.x + box.w < margin || box.x > 1 - margin) continue;
    const pad = 0.008;
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    out.push({ x, y, w: Math.min(1 - x, box.w + 2 * pad), h: Math.min(1 - y, box.h + 2 * pad) });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/** The same from a page picture (its address) and the words known on it ({x, y, w, h} in the page's own size). */
export async function missingTextOnPicture(src, words, pageW, pageH) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('The page picture could not be loaded.')); img.src = src; });
  const W = 500, H = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * W));
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, W, H);
  const rgba = ctx.getImageData(0, 0, W, H).data;
  const gray = new Uint8ClampedArray(W * H);
  for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 0.3 + rgba[i * 4 + 1] * 0.59 + rgba[i * 4 + 2] * 0.11);
  const covers = words.filter((w) => w.w > 0 && w.h > 0).map((w) => ({ x: w.x / pageW, y: w.y / pageH, w: w.w / pageW, h: w.h / pageH }));
  return missingTextBoxes(gray, W, H, covers);
}
