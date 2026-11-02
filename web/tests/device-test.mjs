// Phones, tablets and computers (js/device.js): the layout found by itself on each (emulated:
// iPhone, Android, iPad upright and sideways, a phone sideways, a computer and its narrow window),
// what each layout looks like, a layout chosen by hand (kept after a reload; a computer's on a
// phone draws the page wider), a photo of another kind made a JPEG, and the message of a browser
// that cannot run the app.
// Run: node web/tests/device-test.mjs
import assert from 'node:assert/strict';

process.env.PORT ||= '8819';
const { startServer, stopServer, openBrowser, BASE, sleep } = await import('./harness.mjs');
const { KnownDevices } = await import('puppeteer-core');

const server = await startServer();
const { browser } = await openBrowser({ width: 1366, height: 800 });
const errors = [];
const open = async (device, hash = '#/') => {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  if (device.userAgent) await page.emulate(device);
  else await page.setViewport(device.viewport);
  await page.goto(BASE + hash, { waitUntil: 'networkidle0' });
  await sleep(500);
  return page;
};
const state = (page) => page.evaluate(() => {
  const css = (q, p) => { const n = document.querySelector(q); return n ? getComputedStyle(n)[p] : null; };
  return { device: document.documentElement.dataset.device, touch: document.documentElement.hasAttribute('data-touch'), width: innerWidth,
    sheet: css('.panel', 'gridRowStart') === '2', panel: css('.panel', 'position'), button: css('.topbar .icon-btn', 'width'),
    select: document.querySelector('#lib-device').selectedOptions[0]?.textContent };
});

try {
  const books = await (await fetch(`${BASE}../api/books?scope=local`)).json();
  const reader = `#/${books[0].id}/${books[0].firstPage || 1}`;
  const expect = [
    ['iPhone 13', KnownDevices['iPhone 13'], { device: 'phone', touch: true, sheet: true, select: 'Automatic (phone)' }],
    ['Android (Pixel 5)', KnownDevices['Pixel 5'], { device: 'phone', touch: true, sheet: true }],
    ['iPad upright', KnownDevices['iPad Pro 11'], { device: 'tablet', touch: true, sheet: false, panel: 'static', button: '38px', select: 'Automatic (tablet)' }],
    ['iPad sideways', KnownDevices['iPad Pro 11 landscape'], { device: 'tablet', touch: true, panel: 'static' }],
    ['a phone sideways', KnownDevices['iPhone 13 landscape'], { device: 'tablet', touch: true, sheet: false }],
    ['a computer', { viewport: { width: 1366, height: 800 } }, { device: 'computer', touch: false, sheet: false, panel: 'static', button: '34px', select: 'Automatic (computer)' }],
    ['a narrow window', { viewport: { width: 600, height: 800 } }, { device: 'phone', touch: false, sheet: true }],
  ];
  for (const [name, device, want] of expect) {
    const page = await open(device, reader);
    const got = await state(page);
    for (const [k, v] of Object.entries(want)) assert.equal(got[k], v, `${name}: ${k} (${JSON.stringify(got)})`);
    await page.close();
  }
  console.log('PASS: found by itself: phones (iPhone, Android, a narrow window), tablets (iPad, a phone sideways), computers; each its layout');

  // Chosen by hand, in the library's foot: the phone's layout on a computer, kept after a reload; Automatic again.
  let page = await open({ viewport: { width: 1366, height: 800 } });
  const choose = (value) => page.evaluate((v) => {
    const s = document.querySelector('#lib-device');
    s.value = v;
    s.dispatchEvent(new Event('change'));
  }, value).then(() => sleep(500));
  await choose('phone');
  assert.equal((await state(page)).device, 'phone');
  await page.reload({ waitUntil: 'networkidle0' });
  await sleep(500);
  const kept = await state(page);
  assert.deepEqual([kept.device, kept.touch, kept.select], ['phone', true, 'Phone'], 'kept after a reload');
  assert.equal(await page.$eval('#device-select', (s) => s.value), 'phone', 'the same choice in Settings → Screen');
  await choose('auto');
  assert.equal((await state(page)).device, 'computer');
  await page.close();
  // A computer's layout on a phone: the page drawn 1200 px wide, as a "desktop site"; Automatic: its own width.
  page = await open(KnownDevices['iPhone 13']);
  await choose('computer');
  assert.deepEqual([(await state(page)).device, (await state(page)).width], ['computer', 1200]);
  await choose('tablet');
  assert.deepEqual([(await state(page)).device, (await state(page)).width], ['tablet', 820]);
  await choose('auto');
  assert.deepEqual([(await state(page)).device, (await state(page)).width], ['phone', 390]);
  await page.close();
  console.log('PASS: chosen by hand (library or settings): kept after a reload; on a phone the page drawn wider; Automatic again');

  // A photo of a kind the server does not take (here a BMP; on an iPhone a HEIC): sent as a JPEG.
  page = await open({ viewport: { width: 1366, height: 800 } });
  const photo = await page.evaluate(async () => {
    const { serverPhoto } = await import('./js/library.js');
    const c = document.createElement('canvas');
    c.width = 5000; c.height = 300;
    c.getContext('2d').fillRect(0, 0, 50, 50);
    const png = await new Promise((ok) => c.toBlob(ok, 'image/png'));
    const bmp = new File([png], 'IMG_0001.HEIC', { type: 'image/heic' }); // (Chrome shows this PNG; Safari shows real HEIC)
    const out = await serverPhoto(bmp);
    const img = await createImageBitmap(out);
    const same = new File([png], 'page.png', { type: 'image/png' });
    return { name: out.name, type: out.type, width: img.width, kept: (await serverPhoto(same)) === same };
  });
  assert.deepEqual(photo, { name: 'IMG_0001.jpg', type: 'image/jpeg', width: 4000, kept: true });
  await page.close();
  console.log('PASS: a photo of another kind (an iPhone\'s HEIC) is sent as a JPEG, at most 4000 px; JPEG, PNG, WebP as they are');

  // A browser that cannot run the app (here: its code does not arrive): it says so, instead of an empty page.
  page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().endsWith('/js/main.js') ? r.abort() : r.continue()));
  await page.goto(BASE + '#/', { waitUntil: 'load' });
  await page.waitForSelector('#too-old', { timeout: 20000 });
  assert.match(await page.$eval('#too-old', (b) => b.textContent), /cannot start in this browser.*iOS 15\.4/s);
  await page.close();
  assert.deepEqual(errors, []);
  console.log('PASS: a browser too old for the app: a message what to do (not an empty page)');
} finally {
  await browser.close();
  stopServer(server);
}
