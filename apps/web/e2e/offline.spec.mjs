// Text recognition with no connection, which the FAQ promises and which did
// not happen.
//
// The four engine files were fetched the first time OCR actually ran, not when
// the service worker installed. So someone who opened the page, lost their
// connection and then scanned got a PDF that opened correctly, looked right,
// and could not be searched — the only sign was a console warning. The scan
// itself worked, which is what made it invisible.
//
// Run with: node apps/web/e2e/offline.spec.mjs   (BASE_URL to point elsewhere)

import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://opendocscan.com';
const OCR_FILES = [
  'vendor/tesseract/tesseract.esm.min.js',
  'vendor/tesseract/worker.min.js',
  'vendor/tesseract/core/tesseract-core-simd-lstm.wasm.js',
  'vendor/tesseract/lang/eng.traineddata.gz',
];

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// The worker warms these after it activates, so a fresh profile needs a moment.
// Polling rather than a fixed sleep: six megabytes takes as long as it takes.
async function cachedOcrFiles(page, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let present = [];
  while (Date.now() < deadline) {
    present = await page.evaluate(async (files) => {
      const names = await caches.keys();
      const assets = names.find((n) => n.includes('assets'));
      if (!assets) return [];
      const cache = await caches.open(assets);
      const found = [];
      for (const f of files) if (await cache.match(f)) found.push(f);
      return found;
    }, OCR_FILES);
    if (present.length === OCR_FILES.length) return present;
    await page.waitForTimeout(2000);
  }
  return present;
}

test('the engine is in the cache before anyone asks for it', async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  const present = await cachedOcrFiles(page);
  const missing = OCR_FILES.filter((f) => !present.includes(f));
  if (missing.length) {
    throw new Error(`not cached after the page loaded: ${missing.join(', ')}`);
  }
});

test('a scan made with no connection still comes out searchable', async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.evaluate(() => navigator.serviceWorker.ready);
  await cachedOcrFiles(page);

  // Everything from here happens with the network switched off, which is the
  // condition the FAQ describes: "once the page has loaded".
  await page.context().setOffline(true);
  try {
    const png = await page.evaluate(async () => {
      // A page with real words on it, drawn in the tab so no file is needed.
      const c = document.createElement('canvas');
      c.width = 1200; c.height = 1600;
      const x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
      x.fillStyle = '#000'; x.font = 'bold 90px Georgia';
      for (const [i, line] of ['INVOICE', 'Received with', 'thanks'].entries()) {
        x.fillText(line, 120, 300 + i * 150);
      }
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });

    await page.setInputFiles('#file-input', {
      name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png),
    });
    await page.waitForTimeout(3000);
    if (await page.isVisible('#btn-crop-confirm')) {
      await page.click('#btn-crop-confirm');
      await page.waitForTimeout(2500);
    }
    if (await page.isVisible('#btn-filter-confirm')) {
      await page.click('#btn-filter-confirm');
      await page.waitForTimeout(2500);
    }
    // Wait for recognition to report one way or the other.
    const flag = await page.waitForFunction(() => {
      const el = document.querySelector('.tray-flag, [class*="flag"]');
      return el && el.textContent.trim() ? el.textContent.trim() : null;
    }, { timeout: 120_000 }).then((h) => h.jsonValue()).catch(() => null);

    if (flag === null) throw new Error('recognition never reported a result');
    if (/no text/i.test(flag)) {
      throw new Error(`offline recognition failed: the page reads "${flag}"`);
    }
    if (!/\d/.test(flag)) throw new Error(`unexpected result: "${flag}"`);
  } finally {
    await page.context().setOffline(false);
  }
});

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
for (const { name, fn } of tests) {
  // A fresh context per test: the point is what a first-time visitor gets, and
  // a warmed cache from the previous test would answer a different question.
  const context = await browser.newContext({ viewport: { width: 430, height: 900 } });
  const page = await context.newPage();
  try {
    await fn(page);
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  } finally {
    await context.close();
  }
}
await browser.close();
console.log(failures === 0 ? '\nall green' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
