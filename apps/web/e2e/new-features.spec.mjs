// Test new features: camera mode switcher, format selector (PDF vs Image), PDF import capability
import { chromium } from 'playwright';
import { strict as assert } from 'node:assert';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8765';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});

const context = await browser.newContext();
const page = await context.newPage();

const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});

console.log('Navigating to ' + `${BASE}/index.html`);
await page.goto(`${BASE}/index.html`);

// 1. Check Library and elements
assert.ok(await page.isVisible('#btn-new-scan'), 'Scan button should be visible');
assert.ok(await page.isVisible('#btn-import-library'), 'Import button should be visible');

// 2. Check File Input accept attribute
const acceptAttr = await page.getAttribute('#file-input', 'accept');
console.log('File input accept:', acceptAttr);
assert.ok(acceptAttr.includes('application/pdf'), 'File input must accept PDF documents');

// 3. Navigate to Capture View
await page.click('#btn-new-scan');
await page.waitForSelector('#view-capture:not([hidden])');
assert.ok(await page.isVisible('#camera-mode-toggle'), 'Camera mode toggle should be visible');
assert.ok(await page.isVisible('#btn-mode-fast'), 'Fast mode button should be visible');
assert.ok(await page.isVisible('#btn-mode-live'), 'Live mode button should be visible');
assert.ok(await page.isVisible('#viewfinder-hud'), 'Viewfinder HUD should be visible');

// Check fast mode is active by default
const isFastActive = await page.evaluate(() => document.getElementById('btn-mode-fast').classList.contains('is-active'));
assert.ok(isFastActive, 'Fast mode should be active by default for smooth 60fps camera');

// Switch to live mode
await page.click('#btn-mode-live');
const isLiveActive = await page.evaluate(() => document.getElementById('btn-mode-live').classList.contains('is-active'));
assert.ok(isLiveActive, 'Live mode should become active');

// Switch back to fast mode
await page.click('#btn-mode-fast');
assert.ok(await page.evaluate(() => document.getElementById('btn-mode-fast').classList.contains('is-active')), 'Fast mode active again');

// 4. Test PDF.js loading and offline PDF rendering capability
const pdfJsLoaded = await page.evaluate(async () => {
  const { loadPdfJs } = await import('./src/pdf-import.js');
  const lib = await loadPdfJs();
  return Boolean(lib && lib.getDocument);
});
assert.ok(pdfJsLoaded, 'Local PDF.js should load and provide getDocument');
console.log('  ok   PDF.js successfully initialized offline');

// 5. Test Format Selector in Review Tray
// Trigger capture or import a dummy image to open Review Tray
const testPage = `() => {
  const canvas = document.createElement('canvas');
  canvas.width = 400;
  canvas.height = 500;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 400, 500);
  ctx.fillStyle = '#000';
  ctx.fillText('Test Page', 50, 50);
  return new Promise(res => canvas.toBlob(res, 'image/png'));
}`;

await page.evaluate(async (maker) => {
  const blob = await eval(maker)();
  const input = document.getElementById('file-input');
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'invoice.png', { type: 'image/png' }));
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}, testPage);

// Arrive at crop view
await page.waitForSelector('#view-crop:not([hidden])', { timeout: 10000 });
await page.click('#btn-crop-confirm');

// Arrive at filter view
await page.waitForSelector('#view-filter:not([hidden])', { timeout: 10000 });
await page.click('#btn-filter-confirm');

// Arrive at review tray
await page.waitForSelector('#view-tray:not([hidden])', { timeout: 10000 });
console.log('  ok   Navigated to Review Tray');

// Check format chips presence
assert.ok(await page.isVisible('#opt-fmt-pdf'), 'PDF format chip should be visible');
assert.ok(await page.isVisible('#opt-fmt-image'), 'Image format chip should be visible');

// Switch to Image format
await page.click('#opt-fmt-image');
const isImageFmtOn = await page.evaluate(() => document.getElementById('opt-fmt-image').classList.contains('is-on'));
assert.ok(isImageFmtOn, 'Image format chip should become active');
const titleWithJpg = await page.inputValue('#doc-title');
console.log('Doc title in image format:', titleWithJpg);
assert.ok(titleWithJpg.endsWith('.jpg'), 'Document title should end with .jpg when Image format selected');

// Switch back to PDF format
await page.click('#opt-fmt-pdf');
const isPdfFmtOn = await page.evaluate(() => document.getElementById('opt-fmt-pdf').classList.contains('is-on'));
assert.ok(isPdfFmtOn, 'PDF format chip should become active');
const titleWithPdf = await page.inputValue('#doc-title');
console.log('Doc title in PDF format:', titleWithPdf);
assert.ok(titleWithPdf.endsWith('.pdf'), 'Document title should end with .pdf when PDF format selected');

console.log('\nAll new feature checks passed successfully!');
await browser.close();
