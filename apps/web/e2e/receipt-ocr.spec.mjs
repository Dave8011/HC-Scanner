// Faint grey print, through the filter and the recogniser.
//
// This is a smoke test, and it is worth saying which. The bug it comes from
// was "the receipt is soft and the PDF is not searchable": of the words
// printed on a photographed till receipt the app found one, and what it did
// return began "stemes | fos | Sones rat] | SEE". Measured on that
// photograph, the fix took it from 25 words to 120, and from 6 of 30 printed
// words to 18.
//
// That photograph is not in this repository — it was the reporter's own and
// the background of it was her screen — and the failure does not survive being
// drawn. The stand-in below reads about the same whichever illumination
// estimate is in place, so this cannot go red for the reported bug; what it
// guards is that the path itself keeps working on faint grey print. The
// regression that does go red is in docscan-filters, on the illumination
// estimate.
//
// The fixture was the reporter's own photograph until she asked for it back:
// the background of it was her screen. What stands in for it is drawn, by
// photographs/make-faint-receipt.py, and carries the two properties that made
// the bug visible — grey print on grey paper, and light that falls unevenly
// across a page whose print is dense in some bands and sparse in others. The
// numbers in the record (25 words becoming 120) came from the photograph; what
// this guards is the same path.
//
// Run with: node apps/web/e2e/receipt-ocr.spec.mjs   (BASE_URL to point elsewhere)

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'https://opendocscan.com';
const RECEIPT = join(HERE, 'photographs/faint-receipt.jpg');

// Printed on the receipt, in the reporter's own list and readable in the
// photograph. Matched case-insensitively against the recognised text.
const PRINTED = [
  'SAMPLE', 'STORE', 'NUMBER', 'WESTGATE', 'BRANCH', 'COUNTER', 'INVOICE', 'TILL',
  'QUANTITY', 'GREEN', 'LOOSE', 'LEAF', 'BISCUITS', 'PLAIN', 'SPARKLING', 'WATER',
  'SUBTOTAL', 'DISCOUNT', 'APPLIED', 'BALANCE', 'PAYMENT', 'CARD', 'APPROVED',
  'CHANGE', 'SIGNATURE', 'REQUIRED', 'RETAIN', 'REFUND', 'EXCHANGE', 'SERVICE',
  'WITHIN', 'DAYS', 'THANK', 'PURCHASE', 'PLEASE', 'VISIT', 'AGAIN', 'SOON',
];

/// Runs the app's own modules on the fixture: the same filter the Clean up
/// screen applies, then the same recogniser the tray queues. Driving the
/// screens instead would measure the screens; what the task is about is what
/// comes back from those two.
async function readReceipt(page, filter) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  const bytes = Array.from(readFileSync(RECEIPT));
  return page.evaluate(async ({ bytes, filter }) => {
    const scanner = await import('/src/scanner.js');
    const ocr = await import('/src/ocr.js');
    scanner.initScanner();

    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' });
    const image = await scanner.blobToImageData(blob);
    const filtered = await scanner.applyFilter(image, filter, 0, 0);
    const out = await scanner.encodeImage(filtered, 'image/jpeg', 0.92);
    const result = await ocr.recognize(out);
    return { words: result.words.length, text: result.text,
             size: `${image.width}x${image.height}` };
  }, { bytes, filter });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('faint grey print survives the filter and the recogniser', async (page) => {
  // Enhance, which is the filter the Clean up screen opens on and the one the
  // report was made with. B & W was measured on the reporter's photograph and
  // is unchanged by this work — Sauvola does not use the illumination
  // estimate, and widening its window does not help it either (10, 8 and 9
  // words at three window sizes). That it does worse than Enhance on faint
  // thermal print is a separate matter from this one.
  const { words, text, size } = await readReceipt(page, 'enhance');
  const hits = PRINTED.filter((w) => text.toLowerCase().includes(w.toLowerCase()));
  console.log(`       ${size}, ${words} words read | ${hits.length}/${PRINTED.length} printed words found`);
  console.log(`       ${hits.join(', ') || '(none)'}`);
  if (hits.length < 30) {
    throw new Error(
      `only ${hits.length} of ${PRINTED.length} printed words came back; ` +
      'something between the filter and the recogniser has broken');
  }
});

// ------------------------------------------------------------------- runner

const browser = await chromium.launch({ args: ['--no-sandbox'] });
let failures = 0;
for (const { name, fn } of tests) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  try {
    await fn(page);
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}\n       ${error.message.split('\n')[0]}`);
  }
  await context.close();
}
await browser.close();
console.log(failures ? `\n${failures} failing` : '\nall green');
process.exit(failures ? 1 : 0);
