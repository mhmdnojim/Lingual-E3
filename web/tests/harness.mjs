// Shared test setup: start the local server, find Edge/Chrome, open a page.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PORT = Number(process.env.PORT || 8799);
export const BASE = `http://127.0.0.1:${PORT}/web/`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].filter(Boolean);

/**
 * Start a test copy of web/server.py and wait until it answers. It keeps text corrections and
 * MP3s in an empty temporary folder, so tests never see or change the user's own (web/edits,
 * web/recordings). stopServer() removes it again.
 */
export async function startServer({ port = PORT, args = [] } = {}) {
  const data = mkdtempSync(path.join(os.tmpdir(), 'aef3-test-'));
  const env = { ...process.env, AEF_EDITS_DIR: path.join(data, 'edits'), AEF_RECORDINGS_DIR: path.join(data, 'recordings'),
    AEF_TRANSLATIONS_DIR: path.join(data, 'translations') };
  delete env.AEF_PASSWORD;
  // A test server left on this port is replaced (server.py stops older copies of the app).
  const proc = spawn('python', [path.resolve(here, '..', 'server.py'), '--no-browser', '--port', String(port), ...args], { stdio: 'ignore', env });
  proc.data = data;
  for (let i = 0; i < 75; i++) {
    if (await ping(`http://127.0.0.1:${port}/web/`) && proc.exitCode === null) return proc;
    await sleep(200);
  }
  stopServer(proc);
  throw new Error('The server did not start.');
}

export function stopServer(proc) {
  if (!proc) return;
  proc.kill();
  try { rmSync(proc.data, { recursive: true, force: true }); } catch { /* still in use */ }
}

async function ping(url = BASE) {
  try { return (await fetch(url)).ok; } catch { return false; } // (with a login: the login page answers)
}

export async function openBrowser({ width = 1500, height = 950, scheme = 'light' } = {}) {
  const executablePath = BROWSERS.find((p) => existsSync(p));
  if (!executablePath) throw new Error('Microsoft Edge or Google Chrome was not found. Set BROWSER=path\\to\\browser.exe');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    args: ['--autoplay-policy=no-user-gesture-required'],
    defaultViewport: { width, height },
  });
  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
  const problems = [];
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
  return { browser, page, problems };
}

/** Load an app route and wait for the page image and its text layer. */
export async function gotoPage(page, route) {
  await page.goto(BASE + route, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.querySelector('.page-img')?.complete, { timeout: 15000 });
  await sleep(300);
}

export async function wordCenter(page, i) {
  return page.$eval(`.hits rect[data-w="${i}"]`, (r) => {
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
}
