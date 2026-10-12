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

  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });

  // 1. Verify Library Bar & Back to HC Cloud Button inside view-library
  const libBar = await page.$('#library-bar');
  assert.ok(libBar, '#library-bar should exist inside view-library');

  const backCloudBtn = await page.$('#btn-back-hc-cloud');
  assert.ok(backCloudBtn, '#btn-back-hc-cloud should exist in the library bar');
  const backText = await page.$eval('#btn-back-hc-cloud', el => el.innerText.trim());
  assert.ok(backText.includes('HC Cloud'), 'Button should say HC Cloud');

  const aboutBtn = await page.$('#btn-about');
  assert.ok(aboutBtn, '#btn-about should exist in the library bar');

  const brandTag = await page.$('.brand-wrap .version-tag');
  assert.ok(brandTag, 'Version tag in brand-wrap should exist');

  // 2. Verify Viewfinder HUD reticle & scanning laser beam
  const hudReticle = await page.$('#viewfinder-hud .hud-reticle');
  assert.ok(hudReticle, '.hud-reticle should exist in #viewfinder-hud');
  const hudScanBeam = await page.$('#viewfinder-hud .hud-scan-beam');
  assert.ok(hudScanBeam, '.hud-scan-beam should exist in #viewfinder-hud');

  // 3. Verify Empty State UI elements
  const emptySvg = await page.$('#library-empty .empty-svg');
  assert.ok(emptySvg, '.empty-svg should exist in #library-empty');
  const featureTags = await page.$$eval('#library-empty .feature-tag', els => els.map(e => e.innerText.trim()));
  assert.equal(featureTags.length, 3, 'Should have 3 feature tags in library empty state');
  assert.ok(featureTags.some(t => t.includes('Private')), 'Tag should mention Private');
  assert.ok(featureTags.some(t => t.includes('WASM')), 'Tag should mention WASM');
  assert.ok(featureTags.some(t => t.includes('PDF')), 'Tag should mention PDF');

  // 4. Verify PDF Import Choice Modal elements
  const pdfModal = await page.$('#modal-pdf-import');
  assert.ok(pdfModal, '#modal-pdf-import should exist');
  const btnAsIs = await page.$('#btn-pdf-import-asis');
  assert.ok(btnAsIs, '#btn-pdf-import-asis should exist');
  const btnCrop = await page.$('#btn-pdf-import-crop');
  assert.ok(btnCrop, '#btn-pdf-import-crop should exist');

  console.log('  ok   Header, Back to Cloud button, & Version Tag verified');
  console.log('  ok   Viewfinder HUD laser reticle & scan beam verified');
  console.log('  ok   Library Empty state graphics & privacy badges verified');
  console.log('  ok   PDF Import Choice Modal verified');
  console.log('\nAll UI mastery and capture enhancements passed successfully!\n');
} finally {
  await browser.close();
}
