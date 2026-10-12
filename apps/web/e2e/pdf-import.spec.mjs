// Test PDF generation and re-importing into HC-Scanner using genuine PDF blob
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8765';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();
page.on('console', msg => console.log('BROWSER:', msg.type(), msg.text()));
page.on('pageerror', err => console.log('PAGE ERROR:', err));
await page.goto(`${BASE}/index.html`);
await page.waitForTimeout(1000);

console.log('1. Generating a valid PDF in browser using exportPdf...');
const pdfGenerated = await page.evaluate(async () => {
  const { exportPdf } = await import('./src/scanner.js');
  
  // Make a sample canvas page
  const canvas = document.createElement('canvas');
  canvas.width = 600;
  canvas.height = 800;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 600, 800);
  ctx.fillStyle = '#111827';
  ctx.font = '24px sans-serif';
  ctx.fillText('Sample Invoice PDF', 50, 100);
  ctx.fillText('Amount: $120.00', 50, 150);

  const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.9));
  const pages = [{
    id: 'p1',
    index: 0,
    blob,
    thumb: blob,
    width: 600,
    height: 800,
  }];

  const pdfBlob = await exportPdf(pages, { paper: 'a4', margin: 18, quality: 82, title: 'Test Document' });
  window._generatedPdfBlob = pdfBlob;
  return { size: pdfBlob.size, type: pdfBlob.type };
});

console.log('  ok   Generated PDF:', pdfGenerated);
assert.ok(pdfGenerated.size > 0, 'PDF should have positive size');

console.log('2. Verifying offline renderPdfPages engine...');
const renderResult = await page.evaluate(async () => {
  const { renderPdfPages } = await import('./src/pdf-import.js');
  const pages = await renderPdfPages(window._generatedPdfBlob, 1600);
  return { success: true, count: pages.length, width: pages[0]?.width, height: pages[0]?.height };
});
assert.equal(renderResult.count, 1, 'PDF rendered 1 page');
assert.ok(renderResult.width > 0 && renderResult.height > 0, 'Page has valid dimensions');
console.log('  ok   Offline PDF rendering engine verified');

console.log('3. Importing PDF via UI file picker into HC-Scanner...');
await page.evaluate(() => {
  const file = new File([window._generatedPdfBlob], 'invoice.pdf', { type: 'application/pdf' });
  const input = document.getElementById('file-input');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
});

// Single-page PDF routes to corner editor (view-crop)
await page.waitForSelector('#view-crop:not([hidden])', { timeout: 15000 });
console.log('  ok   PDF page successfully routed to Crop view!');

// Confirm crop and continue
await page.click('#btn-crop-confirm');
await page.waitForSelector('#view-filter:not([hidden])', { timeout: 15000 });
console.log('  ok   PDF arrived at Filter view');

await page.click('#btn-filter-confirm');
await page.waitForSelector('#view-tray:not([hidden])', { timeout: 15000 });
console.log('  ok   PDF page arrived in Review Tray!');

const pageCount = await page.evaluate(() => document.querySelectorAll('#tray-list .tray-item').length);
assert.equal(pageCount, 1, 'Tray should have 1 page from the imported PDF');

const title = await page.inputValue('#doc-title');
console.log('  ok   Tray doc title:', title);
assert.ok(title.endsWith('.pdf'), 'Imported PDF defaults to .pdf format');

console.log('\nSUCCESS: PDF import verified completely end-to-end!');
await browser.close();
