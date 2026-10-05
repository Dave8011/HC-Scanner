// A returning visitor gets the build that was just published.
//
// The worker serves cache-first and never revalidates, so the cache name is
// the only thing that can replace a file someone already has. On 30 September
// `app.js` and `styles.css` shipped six mobile fixes and `sw.js` did not
// change, so `opendocscan-shell-v7` kept serving the old ones: two real
// handsets were stuck, reloading did nothing, and every automated check stayed
// green because each one runs in a browser that has never been there before.
//
// That is the shape this covers: the second visit, not the first. It needs a
// profile that survives, and a server whose content it can change underneath
// the browser, so it runs its own copy of the site rather than pointing at one.
//
//   node apps/web/e2e/sw-update.spec.mjs

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SITE = WEB_DIR;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.json': 'application/json', '.wasm': 'application/wasm',
                '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
                '.woff2': 'font/woff2', '.gz': 'application/gzip', '.txt': 'text/plain' };

const root = mkdtempSync(join(tmpdir(), 'sw-update-'));
const profile = mkdtempSync(join(tmpdir(), 'sw-profile-'));
cpSync(SITE, root, { recursive: true });

// nginx's try_files, and no caching headers of its own — the question here is
// what the service worker does, not what an HTTP cache does.
const server = createServer((req, res) => {
  let p = join(root, decodeURIComponent(req.url.split('?')[0]));
  console.log("SERVER REQ:", req.url, "->", p);
  try { if (statSync(p).isDirectory()) p = join(p, 'index.html'); } catch { /* below */ }
  try { statSync(p); } catch { try { statSync(p + '.html'); p += '.html'; } catch { console.log("SERVER 404:", req.url); res.writeHead(404); return res.end(); } }
  console.log("SERVER 200:", req.url);
  res.writeHead(200, { 'content-type': TYPES[extname(p)] ?? 'application/octet-stream',
                       'cache-control': 'no-cache' });
  res.end(readFileSync(p));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (ok, name, detail = '') => {
  if (ok) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}`); if (detail) console.log(`       ${detail}`); }
};

const context = await chromium.launchPersistentContext(profile, { args: ['--no-sandbox', '--disable-gpu'] });
try {
  console.log("launched browser");
  // First visit: the worker installs and takes the shell.
  let page = await context.newPage();
  page.on('console', msg => console.log('PAGE LOG:', msg.text()));
  page.on('pageerror', exception => console.log('PAGE ERROR:', exception));
  console.log("navigating to BASE...");
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  console.log("waiting for SW ready...");
  await page.evaluate(() => navigator.serviceWorker.ready);
  console.log("SW is ready.");
  await page.waitForTimeout(1500);
  const firstVersion = await page.evaluate(async () =>
    (await caches.keys()).find((k) => k.includes('shell')));
  check(Boolean(firstVersion), 'the worker installs and names a shell cache', String(firstVersion));
  await page.close();

  // Publish: change something a visitor can see, and stamp the worker the way
  // the deploy does.
  const appJs = join(root, 'src/app.js');
  const marker = `APP_UPDATE_MARKER_${Date.now()}`;
  writeFileSync(appJs, readFileSync(appJs, 'utf8') + `\nwindow.__marker = ${JSON.stringify(marker)};\n`);
  execFileSync('python3', [join(root, 'scripts/stamp-sw.py')], { cwd: root });

  const stamped = readFileSync(join(root, 'sw.js'), 'utf8').match(/const VERSION = '([^']+)'/)[1];
  check(stamped !== firstVersion?.split('-').pop(),
        'stamping moves the cache version', `now ${stamped}`);

  // Second visit: the same profile, the same worker already installed.
  page = await context.newPage();
  let seen = null;
  for (let reload = 0; reload < 2 && !seen; reload++) {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2500);
    seen = await page.evaluate(() => window.__marker ?? null);
  }
  check(seen === marker,
        'a returning visitor gets the new build within two reloads',
        seen === null ? 'still serving the old app.js from cache' : `saw ${seen}`);

  const caches_ = await page.evaluate(async () => await caches.keys());
  check(!caches_.some((k) => k.endsWith(firstVersion?.split('-').pop() ?? 'none')),
        'the superseded cache is deleted rather than left behind', caches_.join(', '));
  await page.close();


} finally {
  await context.close();
  server.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nall green' : `\n${failures} failing`);
process.exit(failures === 0 ? 0 : 1);
