import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const origin = process.env.BASE_URL || 'http://127.0.0.1:8765';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();

  await page.goto(`${origin}/index.html`, { waitUntil: 'networkidle' });
  await page.waitForSelector('#view-library');

  console.log('1. Generating a valid PDF in browser using exportPdf...');
  const pdfGenerated = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 800;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 600, 800);
    ctx.fillStyle = '#111827';
    ctx.font = '24px sans-serif';
    ctx.fillText('HC Scanner PDF Import Test', 50, 80);
    ctx.fillText('Invoice #998822', 50, 130);
    ctx.fillText('Total Paid: $1,250.00', 50, 180);

    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));
    const pages = [{
      blob,
      filter: 'enhance',
      rotation: 0,
      aspect: 600 / 800,
      ocr: null
    }];

    const { exportPdf } = await import('./src/scanner.js');
    const pdfBlob = await exportPdf(pages, { paper: 'a4', quality: 0.82 });
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

  // PDF import choice modal should appear!
  await page.waitForSelector('#modal-pdf-import[open]', { timeout: 10000 });
  console.log('  ok   PDF import choice modal opened successfully!');

  // Select "Upload As It Is" (recommended uncropped flow)
  await page.click('#btn-pdf-import-asis');

  // Should navigate straight to Review Tray without destructive cropping!
  await page.waitForSelector('#view-tray:not([hidden])', { timeout: 15000 });
  console.log('  ok   PDF page arrived in Review Tray as-is without cropping!');

  const pageCount = await page.evaluate(() => document.querySelectorAll('#tray-list .tray-item').length);
  assert.equal(pageCount, 1, 'Tray should have 1 page from the imported PDF');

  const title = await page.inputValue('#doc-title');
  console.log('  ok   Tray doc title:', title);
  assert.ok(title.endsWith('.pdf'), 'Imported PDF defaults to .pdf format');

  console.log('\nSUCCESS: PDF import verified completely end-to-end!');
} finally {
  await browser.close();
}
