// Exporting when the browser refuses to keep anything.
//
// A private window will not store a Blob in IndexedDB. The save flow put the
// library write *before* handing over the file, so that refusal threw, the
// catch ran, and a PDF that had already been built was dropped on the floor —
// "The export failed. Your pages are still here." The people most likely to be
// scanning something sensitive in a private window were the only ones who
// could not get their file out.
//
// The reproduction is the reporter's: make IndexedDB reject Blobs, which is
// what Safari does there, and run the ordinary flow.
//
//   node apps/web/e2e/private-mode.spec.mjs

import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://opendocscan.com';

// Exactly the failure Safari produces, injected before any of the app runs.
const REFUSE_BLOBS = () => {
  const reject = (original) =>
    function (value, ...rest) {
      const holdsBlob = (v) =>
        v instanceof Blob ||
        (v && typeof v === 'object' && Object.values(v).some((x) => x instanceof Blob));
      if (holdsBlob(value)) {
        throw new DOMException(
          'Error preparing Blob/File data to be stored in object store',
          'UnknownError',
        );
      }
      return original.call(this, value, ...rest);
    };
  IDBObjectStore.prototype.put = reject(IDBObjectStore.prototype.put);
  IDBObjectStore.prototype.add = reject(IDBObjectStore.prototype.add);
};

const page_png = async (page) =>
  page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 1000; c.height = 1400;
    const x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
    x.fillStyle = '#111'; x.font = 'bold 64px Georgia';
    for (let i = 0; i < 5; i++) x.fillText('Receipt — keep this one', 80, 220 + i * 130);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });

async function scanAndExport(page) {
  const png = await page_png(page);
  await page.setInputFiles('#file-input',
    { name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await page.waitForTimeout(3000);
  if (await page.isVisible('#btn-crop-confirm')) {
    await page.click('#btn-crop-confirm');
    await page.waitForTimeout(2500);
  }
  if (await page.isVisible('#btn-filter-confirm')) {
    await page.click('#btn-filter-confirm');
    await page.waitForTimeout(2500);
  }
  const download = page.waitForEvent('download', { timeout: 60_000 }).catch(() => null);
  if (await page.isVisible('#btn-save')) await page.click('#btn-save');
  return download;
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a PDF still arrives when the library refuses to keep it', async (context) => {
  const page = await context.newPage();
  await page.addInitScript(REFUSE_BLOBS);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const download = await scanAndExport(page);
  const file = await download;
  if (!file) throw new Error('no file was offered — the export was lost, as reported');
  const name = file.suggestedFilename();
  if (!name.endsWith('.pdf')) throw new Error(`offered ${name}, which is not a PDF`);
});

test('and it says the scan was not kept, in the page’s language', async (context) => {
  const page = await context.newPage();
  await page.addInitScript(REFUSE_BLOBS);
  await page.goto(`${BASE}/de`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  const seen = [];
  await page.exposeFunction('__toast', (t) => seen.push(t));
  await page.evaluate(() => {
    const el = document.getElementById('toast');
    new MutationObserver(() => {
      const t = el.textContent.trim();
      if (t && !el.hidden) window.__toast(t);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  });

  await scanAndExport(page);
  await page.waitForTimeout(3000);
  if (!seen.length) throw new Error('nothing was said about the scan not being kept');
  // The old behaviour said the export failed. It did not: the file was handed
  // over. Saying so would send someone looking for a problem they do not have.
  const wrong = seen.find((t) => /fehlgeschlagen|failed/i.test(t));
  if (wrong) throw new Error(`still reporting a failed export: ${JSON.stringify(wrong)}`);
  const told = seen.find((t) => /gespeichert|Kopie/i.test(t));
  if (!told) throw new Error(`no "not kept" notice; saw ${JSON.stringify(seen)}`);
});

test('the pages are still in the tray, so the export can be retried',
  async (context) => {
    const page = await context.newPage();
    await page.addInitScript(REFUSE_BLOBS);
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await scanAndExport(page);
    await page.waitForTimeout(3000);
    const left = await page.evaluate(() =>
      Number(document.getElementById('tray-badge')?.textContent ?? '0'));
    if (left < 1) {
      throw new Error('the tray was emptied even though nothing was saved');
    }
  });

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
for (const { name, fn } of tests) {
  const context = await browser.newContext({ ...devices['Pixel 7'], acceptDownloads: true });
  try {
    await fn(context);
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
