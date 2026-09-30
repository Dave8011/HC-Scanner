// The scanner on a phone: what it asks the camera for, and where it sits.
//
// Three reports from two real handsets, all in the capture path and all
// invisible on a desktop, which is where this suite used to run:
//
//   the shutter lifted a frame out of a 1920x1080 preview, so a receipt that
//   filled half the viewfinder reached the rectifier with about half a
//   megapixel and came back as a blur;
//
//   the page's sticky masthead covered the scanner's own bar, so there was no
//   visible way back out of the corner editor, and Safari's floating address
//   bar covered the row of buttons at the other end;
//
//   and the viewfinder was letterboxed, so on an iPhone the picture was about
//   half the width of the card with black down both sides.
//
// Run with: node apps/web/e2e/mobile.spec.mjs   (BASE_URL to point elsewhere)

import { chromium, devices } from 'playwright';

const BASE = process.env.BASE_URL ?? 'https://opendocscan.com';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('the shutter asks the camera for more than a preview', async (page) => {
  // Recorded before the app loads, because the constraints are the fix: a
  // stream opened at 1920x1080 is two megapixels however good the sensor is.
  await page.addInitScript(() => {
    window.__asked = [];
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) => { window.__asked.push(c); return real(c); };
  });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('#btn-new-scan');
  await page.waitForTimeout(2500);

  const asked = await page.evaluate(() => window.__asked);
  if (!asked.length) throw new Error('the camera was never opened');
  const v = asked[0].video ?? {};
  const wanted = v.width?.ideal ?? 0;
  if (wanted < 3840) {
    throw new Error(`asked the camera for ${wanted}px wide; a preview preset is what made scans blurry`);
  }
});

test('the viewfinder fills the stage instead of sitting in the middle of it',
  async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.click('#btn-new-scan');
    await page.waitForFunction(() => {
      const v = document.getElementById('video');
      return v && v.videoWidth > 0;
    }, { timeout: 15_000 });
    await page.waitForTimeout(600);

    const fit = await page.evaluate(() => {
      const v = document.getElementById('video');
      return { fit: getComputedStyle(v).objectFit,
               vw: v.videoWidth, vh: v.videoHeight,
               box: v.getBoundingClientRect().toJSON() };
    });
    // `contain` is what letterboxed it. The overlay's own maths has to agree,
    // which is why this asserts the property rather than a pixel measurement:
    // coverRect in app.js is written against exactly this value.
    if (fit.fit !== 'cover') {
      throw new Error(`#video is object-fit: ${fit.fit}, which letterboxes a portrait camera`);
    }
  });

test('the scanner’s own bar is not underneath the page’s', async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.click('#btn-new-scan');
  await page.waitForTimeout(2000);
  // Put the stage where a person scrolls it: top of the screen.
  await page.evaluate(() => document.querySelector('.site-stage')
    ?.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(700);

  const geometry = await page.evaluate(() => {
    const header = document.querySelector('.site-header');
    const bar = document.querySelector('#app .view:not([hidden]) .bar');
    if (!bar) return null;
    return {
      headerSticky: header ? getComputedStyle(header).position : 'none',
      headerBottom: header ? header.getBoundingClientRect().bottom : 0,
      barTop: bar.getBoundingClientRect().top,
      barVisible: bar.getBoundingClientRect().height > 0,
    };
  });
  if (!geometry) throw new Error('the scanner has no visible bar at all');
  if (!geometry.barVisible) throw new Error('the scanner bar has no height');
  // Either the masthead is out of the way, or it genuinely sits above the bar.
  const pinned = geometry.headerSticky === 'sticky' || geometry.headerSticky === 'fixed';
  if (pinned && geometry.headerBottom > geometry.barTop) {
    throw new Error(
      `the masthead (bottom ${Math.round(geometry.headerBottom)}px) covers the scanner bar ` +
      `(top ${Math.round(geometry.barTop)}px) — the back button is under it`);
  }
});

test('the scanner fits the screen with the browser’s chrome showing',
  async (page) => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.click('#btn-new-scan');
    await page.waitForTimeout(2000);
    const size = await page.evaluate(() => {
      const app = document.getElementById('app');
      return { app: app.getBoundingClientRect().height, inner: window.innerHeight };
    });
    // Sized in `dvh` the stage is measured against a collapsed browser chrome
    // and overhangs the visible area, which is what put Continue under
    // Safari's floating bar.
    if (size.app > size.inner) {
      throw new Error(`the scanner is ${Math.round(size.app)}px tall in a ${size.inner}px viewport`);
    }
  });

test('the "no outline" advice does not cover the button it is about',
  async (page) => {
    // The corner editor's dock carries a line of instructions above its
    // buttons, so it is taller than the capture screen's. A toast lifted by a
    // single constant cleared one and landed on the other — across Continue,
    // which is the button the message is telling you to press.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    // Scroll the card where a person puts it before working in it. This is
    // what exposes the bug rather than hiding it: the toast was positioned
    // against the viewport, so it only lands on the dock once the card and the
    // viewport stop sharing a bottom edge.
    await page.evaluate(() => document.querySelector('.site-stage')
      ?.scrollIntoView({ block: 'start' }));
    await page.waitForTimeout(500);
    const png = await page.evaluate(async () => {
      // No sheet in this: a flat gradient, so detection finds no outline.
      const c = document.createElement('canvas'); c.width = 900; c.height = 1200;
      const x = c.getContext('2d');
      const g = x.createLinearGradient(0, 0, 900, 1200);
      g.addColorStop(0, '#4a5a6a'); g.addColorStop(1, '#2a3038');
      x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      return Array.from(new Uint8Array(await blob.arrayBuffer()));
    });
    await page.setInputFiles('#file-input',
      { name: 'screen.png', mimeType: 'image/png', buffer: Buffer.from(png) });
    await page.waitForSelector('#toast:not([hidden])', { timeout: 20_000 });
    await page.waitForTimeout(250);

    // The invariant, rather than a pixel overlap on one emulated handset: the
    // toast has to sit above the dock that is actually on screen. The reported
    // symptom needed iPhone Safari's floating address bar to show itself, and
    // headless Chromium has no such thing — but the cause does not depend on
    // it. The toast cleared a flat 88px while the corner editor's dock is
    // taller than that, so on any geometry where the card's bottom is not the
    // viewport's, the two meet.
    const geom = await page.evaluate(() => {
      const toast = document.getElementById('toast');
      const dock = document.querySelector('.view:not([hidden]) .dock');
      const go = document.getElementById('btn-crop-confirm');
      if (!toast || !dock || toast.hidden) return null;
      const t = toast.getBoundingClientRect(), d = dock.getBoundingClientRect();
      const b = go.getBoundingClientRect();
      const x = Math.max(0, Math.min(t.right, b.right) - Math.max(t.left, b.left));
      const y = Math.max(0, Math.min(t.bottom, b.bottom) - Math.max(t.top, b.top));
      return { toastBottom: t.bottom, dockTop: d.top, dockHeight: d.height,
               overlapsButton: x * y, text: toast.textContent.trim() };
    });
    if (!geom) throw new Error('no toast was raised, so nothing was tested');
    if (geom.overlapsButton > 0) {
      throw new Error(`the toast covers ${Math.round(geom.overlapsButton)}px\u00b2 of Continue: "${geom.text}"`);
    }
    if (geom.toastBottom > geom.dockTop + 1) {
      throw new Error(
        `the toast reaches ${Math.round(geom.toastBottom)}px, past the top of a ` +
        `${Math.round(geom.dockHeight)}px dock at ${Math.round(geom.dockTop)}px`);
    }
  });

test('an empty library does not offer to search it', async (page) => {
  // Three blocks about scans, on a first visit, before there are any: the
  // search field, its line of explanation, and an offer to keep permanently
  // something that does not exist. On a phone they pushed Import and Scan
  // most of the way down the card.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  const shown = await page.evaluate(() => {
    const search = document.getElementById('search');
    const row = search?.closest('.pad');
    const notices = document.getElementById('library-notices');
    const visible = (el) => !!el && !el.hidden && el.getBoundingClientRect().height > 0;
    return { search: visible(row), notices: visible(notices) && notices.children.length > 0 };
  });
  if (shown.search) throw new Error('the search box is offered on an empty library');
  if (shown.notices) throw new Error('a storage notice is shown with nothing stored');
});

test('the Scan button is on the first screen', async (page) => {
  // The page's own argument is that the scanner below the headline is running
  // rather than a picture of it, and on a phone nobody saw it: six lines of
  // lede pushed the card below the fold, and Scan sits at the bottom of the
  // card.
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const seen = await page.evaluate(() => {
    const b = document.getElementById('btn-new-scan').getBoundingClientRect();
    return { top: b.top, bottom: b.bottom, viewport: window.innerHeight };
  });
  if (seen.bottom > seen.viewport || seen.top < 0) {
    throw new Error(
      `Scan sits at ${Math.round(seen.top)}–${Math.round(seen.bottom)}px in a ` +
      `${seen.viewport}px screen — it is not on the first one`);
  }
});

// ------------------------------------------------------------------- runner

const browser = await chromium.launch({
  args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
});
let failures = 0;
for (const { name, fn } of tests) {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    permissions: ['camera'],
  });
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
