// The strings the scanner produces while it runs.
//
// The eight locale pages ship their labels already translated, and every one of
// them loads the same app.js. So anything the app wrote at runtime was English
// for all eight — and worse, it overwrote the markup's own translation: on the
// German page `busy-label` went from `Arbeitet…` to `Opening image…` the moment
// someone imported a file. A half-translated interface reads as a machine
// translation, and the half that goes missing is the error messages, which is
// the half people most need to understand.
//
// Run with: node apps/web/e2e/i18n.spec.mjs   (BASE_URL to point it elsewhere)
//
// Like account.spec.mjs this runs against the real origin by default: the
// locale pages are generated into the deploy tree, not into this repo, so a
// purely local run would have nothing to open.

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const BASE = process.env.BASE_URL ?? 'https://opendocscan.com';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// Each locale page and the path it is served at. `en` is the apex itself.
const LOCALES = [
  ['en', '/'], ['de', '/de'], ['es', '/es'], ['ja', '/ja'],
  ['ko', '/ko'], ['pt', '/pt'], ['zh-Hans', '/zh-Hans'], ['zh-Hant', '/zh-Hant'],
];

// The module reads `<html lang>` at import time, so each language needs its own
// module instance. A distinct query string is what gets one past the ES module
// cache; importing it twice otherwise returns the first language forever.
async function load(lang) {
  globalThis.document = { documentElement: { lang } };
  return import(`${join(WEB_DIR, 'src/i18n.js')}?${encodeURIComponent(lang)}`);
}

// ------------------------------------------------------------- the catalogue

test('every language carries every key', async () => {
  const { catalogue } = await load('en');
  const expected = Object.keys(catalogue.en).sort();
  for (const [lang, strings] of Object.entries(catalogue)) {
    const actual = Object.keys(strings).sort();
    const missing = expected.filter((k) => !actual.includes(k));
    const extra = actual.filter((k) => !expected.includes(k));
    if (missing.length) throw new Error(`${lang} is missing: ${missing.join(', ')}`);
    // An extra key is a typo in a language block that no call site will ever
    // read, so it is a silent no-op rather than a visible error.
    if (extra.length) throw new Error(`${lang} has keys English does not: ${extra.join(', ')}`);
  }
});

test('every language actually translates — no block is a copy of English', async () => {
  const { catalogue } = await load('en');
  const flat = (strings) => Object.entries(strings)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? Object.values(v).join('|') : v}`);
  const english = new Set(flat(catalogue.en));
  for (const [lang, strings] of Object.entries(catalogue)) {
    if (lang === 'en') continue;
    const same = flat(strings).filter((entry) => english.has(entry));
    // A handful may legitimately coincide; a whole block matching means the
    // language was stubbed out with English and nobody noticed.
    if (same.length > 3) {
      throw new Error(`${lang} shares ${same.length} strings with English — is it translated?`);
    }
  }
});

test('the plural forms a language declares match what Intl asks it for', async () => {
  // Japanese, Korean and Chinese have one form; German, Spanish, Portuguese and
  // English have two. Declaring `one` for a language that never selects it is
  // dead weight; omitting a form that Intl does select renders `undefined`.
  const { catalogue } = await load('en');
  for (const lang of Object.keys(catalogue)) {
    const rules = new Intl.PluralRules(lang.startsWith('zh') ? 'zh' : lang);
    const wanted = new Set([0, 1, 2, 5, 11].map((n) => rules.select(n)));
    for (const [key, value] of Object.entries(catalogue[lang])) {
      if (typeof value !== 'object') continue;
      for (const form of wanted) {
        if (value[form] === undefined) {
          throw new Error(`${lang} ${key} has no "${form}" form, which Intl selects`);
        }
      }
    }
  }
});

test('a placeholder is filled, and an unknown one is left visible', async () => {
  const { t } = await load('de');
  const filled = t('import.progress', { index: 2, count: 7 });
  if (filled.includes('{')) throw new Error(`placeholders survived: ${filled}`);
  if (!filled.includes('2') || !filled.includes('7')) throw new Error(filled);
  // A missing parameter must not render the word "undefined" at a user.
  const partial = t('import.progress', { index: 2 });
  if (partial.includes('undefined')) throw new Error(`rendered undefined: ${partial}`);
});

test('an unknown language falls back rather than rendering blank', async () => {
  const { t, lang } = await load('fr-CA');
  if (lang !== 'en') throw new Error(`fr-CA resolved to ${lang}`);
  if (t('camera.notReady') !== 'The camera is not ready yet.') throw new Error(t('camera.notReady'));
  const { lang: base } = await load('de-AT');
  if (base !== 'de') throw new Error(`de-AT resolved to ${base}, not de`);
});

// ------------------------------------------------------------- the real pages

// The two strings the reporter's own repro produces, and the node the app
// rewrites on the way. Both are read from the running page.
const wired = new WeakMap();

async function runtimeStrings(page, base, path) {
  await page.goto(`${base}${path}`, { waitUntil: 'networkidle' });
  // `exposeFunction` is per page and throws on a second registration, so the
  // binding is installed once and the array behind it swapped per locale.
  let toasts = [];
  if (!wired.has(page)) {
    await page.exposeFunction('__toast', (text) => wired.get(page).push(text));
    wired.set(page, toasts);
  } else {
    wired.set(page, toasts);
  }
  toasts = wired.get(page);
  await page.evaluate(() => {
    const el = document.getElementById('toast');
    new MutationObserver(() => {
      const text = el.textContent.trim();
      if (text && !el.hidden) window.__toast(text);
    }).observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
  });
  // A file that claims an image type and cannot be decoded. Importing a .txt
  // is the obvious repro and is not one — onFilesPicked filters on the MIME
  // type and returns silently, so that path shows nothing at all.
  await page.setInputFiles('#file-input',
    { name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not a png') });
  await page.waitForTimeout(2200);
  return toasts;
}

test('no locale page raises an English toast', async (page) => {
  const { catalogue } = await load('en');
  const english = new Set(Object.values(catalogue.en).filter((v) => typeof v === 'string'));

  for (const [lang, path] of LOCALES) {
    const toasts = await runtimeStrings(page, BASE, path);
    if (toasts.length === 0) throw new Error(`${path} raised no toast at all`);
    for (const text of toasts) {
      const isEnglish = english.has(text);
      if (lang === 'en' ? !isEnglish : isEnglish) {
        throw new Error(`${path} raised ${JSON.stringify(text)} — ${lang === 'en'
          ? 'not a catalogue string' : 'this is the English one'}`);
      }
    }
  }
});

test('the app does not overwrite the markup’s own translation with English',
  async (page) => {
    // These five nodes ship translated and are rewritten by the app as it runs.
    // The bug was not that they change — a heading going from "Seiten" to
    // "1 Seite" is correct — but that they changed into English.
    const { catalogue } = await load('en');
    const english = new Set(Object.values(catalogue.en).filter((v) => typeof v === 'string'));
    const IDS = ['capture-note', 'tray-title', 'doc-name', 'capture-count', 'busy-label'];

    await runtimeStrings(page, BASE, '/de');
    const after = await page.evaluate((ids) => Object.fromEntries(
      ids.map((id) => [id, document.getElementById(id)?.textContent?.trim() ?? null])), IDS);

    for (const [id, text] of Object.entries(after)) {
      if (text && english.has(text)) {
        throw new Error(`#${id} on /de reads ${JSON.stringify(text)}, which is the English string`);
      }
    }
  });

test('no English catalogue string is visible anywhere on a locale page',
  async (page) => {
    // The general form of the check above, and the one that matters. The first
    // version of this suite asserted on toasts and five node ids, and a
    // reviewer still found `Your browser may clear these scans if it runs short
    // of space.` sitting on the home screen — it was passed to createTextNode,
    // so neither the sweep that wrote the catalogue nor the test that guarded
    // it could see it. This walks everything a person can read instead.
    const { catalogue } = await load('en');
    // Only entries with no placeholder: an interpolated one renders differently
    // and comparing the raw template would never match anyway.
    const english = Object.values(catalogue.en)
      .flatMap((v) => (typeof v === 'object' ? Object.values(v) : [v]))
      .filter((v) => !v.includes('{') && v.trim().length > 8);

    for (const [lang, path] of LOCALES) {
      if (lang === 'en') continue;
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      // The storage notice and the status sheet only render once asked for.
      if (await page.isVisible('#btn-about')) {
        await page.click('#btn-about');
        await page.waitForTimeout(700);
      }
      const visible = await page.evaluate(() => document.body.innerText);
      const leaked = english.filter((phrase) => visible.includes(phrase.trim()));
      if (leaked.length) {
        throw new Error(`${path} shows English: ${leaked.map((l) => JSON.stringify(l.trim().slice(0, 56))).join(', ')}`);
      }
    }
  });

// ------------------------------------------------------------------- runner

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 430, height: 900 } });

let failures = 0;
for (const { name, fn } of tests) {
  // A fresh page per test: exposeFunction cannot be registered twice on one
  // page, and a real sign-in return is a full navigation anyway.
  const page = await context.newPage();
  try {
    await fn(page);
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
console.log(failures === 0 ? '\nall green' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
