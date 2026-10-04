// Screen flow, camera, and the glue between them.
//
// The whole app is one document with several sections; "navigation" is
// which section is not hidden. There is no router and no framework — this
// is a tool with six screens and a hard requirement that it work with no
// network, and every kilobyte of framework is a kilobyte that has to be
// cached and parsed before someone can photograph a receipt.

import { t, lang } from './i18n.js';
import * as store from './store.js';
import * as ocr from './ocr.js';
import * as hc from './hc.js';
import {
  initScanner,
  imageDataFrom,
  blobToImageData,
  encodeImage,
  detectQuad,
  fullFrameQuad,
  rectify,
  applyFilter,
  exportPdf,
  hold,
  derive,
  release,
} from './scanner.js';

const $ = (id) => document.getElementById(id);

// Longest edge of the frame handed to live detection.
//
// Detection is synchronous on the main thread, so its cost is frames the
// preview does not draw. A page's corners are a large-scale feature and
// survive this reduction untouched; the captured photo is detected at full
// resolution afterwards, where a few hundred milliseconds costs nothing.
const LIVE_DETECT_EDGE = 480;
const LIVE_DETECT_INTERVAL_MS = 200;

// Longest edge of a stored page. About 300dpi across A4 — past the point
// where scanned text keeps looking better, and well short of where a phone
// tab runs out of memory holding a few of them.
const PAGE_MAX_EDGE = 2400;

// Longest edge of the frame the shutter hands to the rectifier.
//
// Deliberately larger than PAGE_MAX_EDGE, which caps the *finished* page. The
// sheet is only ever part of what the camera sees, so the pixels that survive
// into the rectified page are a fraction of this; feeding it 2400 would mean a
// receipt that fills half the frame arrives at the rectifier with 1200 pixels
// across and gets upsampled into the 2400 output. Bounded rather than
// unlimited because one frame at this size is already about 30 MB of
// ImageData, and a phone holds several while cropping.
const CAPTURE_MAX_EDGE = 3200;
const THUMB_EDGE = 400;

// Longest edge of the image the filter screen previews.
//
// `enhance` sorts every pixel to find its percentiles, so at full page
// resolution it is several million elements — about a second of blocked
// main thread per nudge of the brightness slider. The preview is a
// downscale; the filter is applied to the full-resolution page once, on
// confirm. What the slider shows is what gets stored, at a size where the
// difference is not visible.
const FILTER_PREVIEW_EDGE = 1100;

const state = {
  view: 'library',
  // Pages of the document being built. Each is a finished, filtered page
  // plus the rectified source it came from, both as Blobs — decoded only
  // while being worked on, so memory stays at roughly one page.
  draft: [],
  editing: null,
  camera: null,
  facingMode: 'environment',
  liveQuad: null,
  liveLoop: null,
  detectAt: 0,
  // Whether a detection request is still in flight in the worker. Without
  // it a phone slower than the detection interval would queue requests
  // faster than it answers them, and the outline would drift further
  // behind the camera the longer someone pointed it at anything.
  detecting: false,
  crop: null,
  filter: { source: null, preview: null, name: 'enhance', brightness: 0, rotation: 0 },
  ocrEnabled: true,
  openDoc: null,
  importTarget: 'draft',
  objectUrls: new Set(),
};

// --- small helpers ---------------------------------------------------------

function objectUrl(blob) {
  const url = URL.createObjectURL(blob);
  state.objectUrls.add(url);
  return url;
}

// Detaches the elements first, then frees the URLs they were pointing at.
//
// The other order looks equivalent and is not: revoking a URL that an
// `<img>` in the document still names makes the browser re-resolve it and
// log a failed load. Nothing breaks — the element is about to be replaced
// anyway — but it fills the console with errors that look like the app
// losing images, which is a bad thing for a real one to hide behind.
// The images the worker is holding on behalf of the scan in progress.
//
// Held rather than passed because the interface refers to each of them
// many times — detect then rectify, filter preview then filter again on
// every slider nudge — and each is megabytes. The cost of that is that
// their lifetime is now something this file has to state, which is what
// this constant and `releaseScanSlots` are for: a scan that ends any way
// other than by adding a page would otherwise leave a 12-megapixel buffer
// alive in the worker, and doing that a few times is how a phone tab gets
// killed with no error anyone can catch.
const SCAN_SLOTS = ['crop', 'filter-source', 'filter-preview'];

function releaseScanSlots() {
  return Promise.all(SCAN_SLOTS.map((slot) => release(slot)));
}

function replaceAndReleaseUrls(container, children = []) {
  container.replaceChildren(...children);
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls.clear();
}

let toastTimer = null;
function toast(message, ms = 2600) {
  const el = $('toast');
  // Lift it clear of whichever dock is on screen. The corner editor's is
  // taller than the capture screen's, and a single constant could only ever
  // be right for one of them.
  liftToastAboveDock(el);
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/// Put the toast above whichever dock is on screen.
///
/// Measured twice: once now, and once on the next frame. The view is switched
/// immediately before some of these are raised, and the dock is still settling
/// when the first measurement runs — the corner editor's carries a line of
/// instructions that wraps, and it finishes 14px taller than it starts. The
/// first reading keeps the toast from ever being drawn low; the second corrects
/// it before anyone could see the difference.
function liftToastAboveDock(el) {
  // The toast is markup-wise a sibling of the scanner, not a child of it, so
  // `position: absolute` resolved against the page body and the offset put it
  // wherever the card happened to be. Moving it inside #app once — which is
  // `position: relative` — is what makes the offset mean "above this card's
  // dock". Done here rather than in the eight locale pages, which each carry
  // their own copy of this markup.
  const app = document.getElementById('app');
  if (app && el.parentElement !== app) app.append(el);

  const measure = () => {
    const dock = document.querySelector('.view:not([hidden]) .dock');
    if (dock) el.style.setProperty('--toast-lift', `${dock.offsetHeight}px`);
  };
  measure();
  requestAnimationFrame(measure);
}

function dismissToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

function busy(label) {
  $('busy-label').textContent = label;
  $('busy').hidden = false;
}

function idle() {
  $('busy').hidden = true;
}

// Yield to the compositor so a spinner shown a line earlier actually
// paints before the synchronous WASM call that follows blocks the thread.
const paint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

// The rectangle a `srcW x srcH` image occupies when fitted inside
// `dstW x dstH` without cropping — the geometry `object-fit: contain`
// applies, recomputed here because the overlay has to agree with it
// exactly or the detected outline floats away from the page.
function containRect(srcW, srcH, dstW, dstH) {
  const scale = Math.min(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height, scale };
}

/// The same fit an `object-fit: cover` element uses: fill the box and let the
/// overflow fall outside it.
///
/// Only the live viewfinder wants this. Every other caller of `containRect` is
/// showing a page that has already been captured, where seeing all of it is
/// the point. The camera is the opposite case: a phone's rear camera hands
/// back a portrait frame, the stage is close to square, and `contain` left the
/// picture sitting in the middle of it about half as wide as the card with
/// black down both sides — too small to aim with, which is what was reported.
///
/// x and y come back negative here, because the scaled frame is larger than
/// the box. That is what makes the arithmetic at the call site identical: the
/// overlay canvas clips whatever lands outside it.
function coverRect(srcW, srcH, dstW, dstH) {
  const scale = Math.max(dstW / srcW, dstH / srcH);
  const width = srcW * scale;
  const height = srcH * scale;
  return { x: (dstW - width) / 2, y: (dstH - height) / 2, width, height, scale };
}

function show(view) {
  state.view = view;
  for (const section of document.querySelectorAll('.view')) {
    section.hidden = section.dataset.view !== view;
  }
  // A toast belongs to the view that raised it. "No page outline found —
  // drag the corners to fit" is advice about the corner editor, and left
  // to run out its two and a half seconds it follows you into the next
  // screen and sits on top of the filter chips, where it is both wrong
  // and in the way.
  dismissToast();
  if (view !== 'capture') stopCamera();
}

// --- library ---------------------------------------------------------------

async function renderLibrary(query = '') {
  const docs = query ? await store.searchDocuments(query) : await store.listDocuments();
  const grid = $('library-grid');
  replaceAndReleaseUrls(grid);

  $('library-empty').hidden = docs.length > 0 || Boolean(query);
  grid.hidden = docs.length === 0;

  // Nothing scanned yet means nothing to search. The box, its line of
  // explanation and the storage notice were all present on a first visit,
  // stacked above the empty state, and on a phone they pushed Import and Scan
  // most of the way down the card — three blocks about scans, before there
  // were any. The search field comes back with the first document.
  // `closest` rather than an id, because this markup is copied into all eight
  // locale pages and an id would have to be added to each of them.
  const bare = docs.length === 0 && !query;
  const searchRow = $('search').closest('.pad');
  if (searchRow) searchRow.hidden = bare;

  if (docs.length === 0 && query) {
    const none = document.createElement('p');
    none.className = 'hint';
    none.textContent = t('library.noMatch', { query });
    grid.hidden = false;
    grid.append(none);
    return;
  }

  for (const doc of docs) {
    const card = document.createElement('button');
    card.className = 'card';
    card.type = 'button';

    const img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    if (doc.thumb) img.src = objectUrl(doc.thumb);
    card.append(img);

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const title = document.createElement('strong');
    title.textContent = doc.title || t('library.untitled');
    const sub = document.createElement('span');
    const pages = t('pages.count', { count: doc.pageCount });
    // The page's language, not the browser's. With no argument this formats a
    // German page's dates in whatever locale the browser happens to be set to,
    // which is how a translated page ends up with an English-looking date.
    sub.textContent = `${pages} · ${new Date(doc.updated).toLocaleDateString(lang)}`;
    meta.append(title, sub);
    card.append(meta);

    card.addEventListener('click', () => openDocument(doc.id));
    grid.append(card);
  }
}

async function renderNotices() {
  const box = $('library-notices');
  box.replaceChildren();

  // "Your browser may clear these scans if it runs short of space" is a true
  // sentence about an empty library and a useless one: there is nothing there
  // to clear, and the offer to keep it permanently is an offer about nothing.
  // It belongs with the first scan.
  if ((await store.listDocuments()).length === 0) return;

  const damaged = await store.checkIntegrity();
  if (damaged.length > 0) {
    const notice = document.createElement('div');
    notice.className = 'notice warn';
    notice.textContent = t('library.damaged', { count: damaged.length });
    box.append(notice);
  }

  const persisted = await navigator.storage?.persisted?.().catch(() => false);
  if (persisted === false) {
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.append(document.createTextNode(t('storage.mayClear')));
    const ask = document.createElement('button');
    ask.textContent = t('storage.keep');
    ask.addEventListener('click', async () => {
      const granted = await store.requestPersistence();
      toast(t(granted ? 'storage.granted' : 'storage.declined'));
      renderNotices();
    });
    notice.append(ask);
    box.append(notice);
  }
}

// --- camera ----------------------------------------------------------------

async function startCamera() {
  const video = $('video');
  stopCamera();

  try {
    state.camera = await navigator.mediaDevices.getUserMedia({
      video: {
        // "ideal" rather than "exact": a laptop with only a front camera
        // should still work rather than throwing OverconstrainedError.
        facingMode: { ideal: state.facingMode },
        // Ask for the most the camera has, not a broadcast preset. 1920x1080
        // is about two megapixels, and a shopping receipt that fills half the
        // viewfinder lands on a quarter of those — which is why small print
        // came out of the rectifier as a blur while the same receipt imported
        // from the system camera read cleanly. `ideal` still degrades: a
        // laptop webcam that has nothing near this simply returns its best.
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      },
      audio: false,
    });
  } catch (error) {
    $('capture-note').textContent =
      t(error?.name === 'NotAllowedError' ? 'camera.denied' : 'camera.none');
    return;
  }

  // `ideal` is a preference, not a floor: a phone that can shoot 4K may still
  // hand back 1280x720 because that is what it opened with. Once the track
  // exists it will say what it is capable of, and that is worth asking for.
  // Wrapped because getCapabilities is absent on Firefox and applyConstraints
  // may refuse — in both cases the stream we already have is fine.
  try {
    const track = state.camera.getVideoTracks()[0];
    const caps = track?.getCapabilities?.();
    if (caps?.width?.max && caps.width.max > (track.getSettings?.().width ?? 0)) {
      await track.applyConstraints({
        width: { ideal: caps.width.max },
        height: { ideal: caps.height?.max ?? undefined },
      });
    }
  } catch {
    /* keep whatever the camera opened with */
  }

  video.srcObject = state.camera;
  await video.play().catch(() => {});
  startLiveDetection();
}

function stopCamera() {
  cancelAnimationFrame(state.liveLoop);
  state.liveLoop = null;
  state.liveQuad = null;
  if (state.camera) {
    for (const track of state.camera.getTracks()) track.stop();
    state.camera = null;
  }
  const video = $('video');
  if (video.srcObject) video.srcObject = null;
}

function startLiveDetection() {
  const video = $('video');
  const overlay = $('overlay');
  const ctx = overlay.getContext('2d');

  const step = (timestamp) => {
    if (!state.camera || state.view !== 'capture') return;
    state.liveLoop = requestAnimationFrame(step);

    if (!video.videoWidth) return;

    const rect = overlay.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
      overlay.width = rect.width;
      overlay.height = rect.height;
    }

    // Detection now runs in a worker, so this asks and moves on rather
    // than waiting. `state.detecting` is what keeps the queue from
    // growing: if a frame takes longer than the interval — which is
    // exactly what happens on a slow phone, the case this all exists for —
    // the next request is skipped rather than stacked behind it.
    if (timestamp - state.detectAt > LIVE_DETECT_INTERVAL_MS && !state.detecting) {
      state.detectAt = timestamp;
      state.detecting = true;
      const frame = imageDataFrom(video, video.videoWidth, video.videoHeight, LIVE_DETECT_EDGE);
      const { width: frameWidth, height: frameHeight } = frame;

      detectQuad(frame)
        .then((quad) => {
          // Corners come back in the downscaled frame's space; normalise
          // to 0..1 so drawing does not have to know what size that was.
          state.liveQuad = quad
            ? quad.map((c) => ({ x: c.x / frameWidth, y: c.y / frameHeight }))
            : null;
        })
        .catch(() => {
          state.liveQuad = null;
        })
        .finally(() => {
          state.detecting = false;
          const note = $('capture-note');
          note.textContent = t(state.liveQuad ? 'capture.pageFound' : 'capture.pointAt');
          note.classList.toggle('is-locked', Boolean(state.liveQuad));
        });
    }

    ctx.clearRect(0, 0, overlay.width, overlay.height);
    if (!state.liveQuad) return;

    const fit = coverRect(video.videoWidth, video.videoHeight, overlay.width, overlay.height);
    ctx.beginPath();
    state.liveQuad.forEach((corner, i) => {
      const x = fit.x + corner.x * fit.width;
      const y = fit.y + corner.y * fit.height;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(76, 141, 255, 0.18)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(76, 141, 255, 0.95)';
    ctx.lineWidth = 3;
    ctx.stroke();
  };

  state.liveLoop = requestAnimationFrame(step);
}

async function capture() {
  const video = $('video');
  if (!video.videoWidth) {
    toast(t('camera.notReady'));
    return;
  }
  let frame = await stillFromCamera();
  if (!frame) {
    frame = imageDataFrom(video, video.videoWidth, video.videoHeight, CAPTURE_MAX_EDGE);
    noteCapture('frame', video.videoWidth, video.videoHeight, frame.width, frame.height);
  }
  await openCrop(frame);
}

/// What the last press of the shutter actually produced.
///
/// Asked for by a reporter testing on real hardware, and the right thing to
/// ask for: `ImageCapture` is absent on Safari and can throw on Android even
/// where it exists, and when it does the fallback looks identical from the
/// outside — the scan simply comes out soft. From a phone there is no console
/// to check. This is the answer, in the panel behind the "?".
function noteCapture(source, rawWidth, rawHeight, usedWidth, usedHeight) {
  state.lastCapture = { source, rawWidth, rawHeight, usedWidth, usedHeight };
}

/// The camera's own photo, rather than a frame lifted out of the preview.
///
/// A preview stream is sized for showing on a screen; the still is sized for
/// the sensor, and on a phone that is the difference between two megapixels
/// and twelve. `ImageCapture` is how a page asks for one. Safari does not
/// implement it and Firefox only behind a flag, so this returns null there and
/// the caller takes the video frame — which is still larger now than the whole
/// capture used to be.
async function stillFromCamera() {
  const track = state.camera?.getVideoTracks?.()[0];
  if (!track || typeof ImageCapture === 'undefined') return null;
  try {
    const photo = await new ImageCapture(track).takePhoto();
    // Decoded here rather than through `blobToImageData` so the sensor's own
    // dimensions can be recorded before the cap is applied. On a phone that is
    // the difference between "the still worked and gave twelve megapixels" and
    // "it threw and you are looking at a preview frame", and from the outside
    // the two produce the same screen.
    const bitmap = await createImageBitmap(photo);
    try {
      const frame = imageDataFrom(bitmap, bitmap.width, bitmap.height, CAPTURE_MAX_EDGE);
      noteCapture('still', bitmap.width, bitmap.height, frame.width, frame.height);
      return frame;
    } finally {
      bitmap.close();
    }
  } catch {
    // Some Android cameras advertise ImageCapture and then reject takePhoto
    // while the torch or focus is mid-change. The preview frame is right
    // there and is a better answer than an error.
    return null;
  }
}

// --- import ----------------------------------------------------------------

function pickFiles(target) {
  state.importTarget = target;
  $('file-input').value = '';
  $('file-input').click();
}

async function onFilesPicked(files) {
  const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
  if (images.length === 0) return;

  // One image goes straight to the corner editor, the way a capture does.
  // A batch is taken at face value — someone importing twelve photos is
  // not asking to confirm twelve sets of corners — and detection is
  // applied per image without stopping to ask.
  if (images.length === 1) {
    busy(t('import.opening'));
    await paint();
    try {
      const frame = await blobToImageData(images[0], PAGE_MAX_EDGE);
      idle();
      await openCrop(frame);
    } catch {
      idle();
      toast(t('import.notImage'));
    }
    return;
  }

  busy(t('import.importing', { count: images.length }));
  await paint();
  let added = 0;
  for (const [index, file] of images.entries()) {
    $('busy-label').textContent = t('import.progress', { index: index + 1, count: images.length });
    await paint();
    try {
      const frame = await blobToImageData(file, PAGE_MAX_EDGE);
      const { width, height } = frame;
      // Held rather than sent twice: detection and rectification both
      // want these pixels, and at import sizes that is twenty megabytes
      // that would otherwise cross the boundary a second time.
      await hold('import', frame);
      const quad = (await detectQuad({ slot: 'import' })) ?? fullFrameQuad(width, height);
      const page = await rectify({ slot: 'import' }, quad, PAGE_MAX_EDGE);
      await addPage(page, 'enhance', 0);
      added += 1;
    } catch {
      /* Skip what cannot be read; the count reported below tells the truth. */
    } finally {
      await release('import');
    }
  }
  idle();

  if (added === 0) {
    toast(t('import.noneImages'));
    return;
  }
  if (added < images.length) toast(t('import.partial', { added, count: images.length }));
  openTray();
}

// --- crop ------------------------------------------------------------------

async function openCrop(frame) {
  const { width, height } = frame;

  // The frame lives as ImageData, which only `putImageData` can draw — and
  // that ignores scaling. Getting it onto a bitmap-shaped canvas once, here,
  // rather than inside the redraw is the difference between a corner that
  // follows a finger and one that stutters: dragging redraws on every
  // pointermove, and rebuilding a multi-megapixel canvas each time is far
  // more work than the drag itself.
  //
  // Drawn *before* the pixels are handed over, because handing them over
  // transfers the buffer and leaves this `ImageData` detached. After this
  // point the canvas is what the interface draws and the worker's `crop`
  // slot is what the core reads; neither is a copy of the other.
  const buffer = document.createElement('canvas');
  buffer.width = width;
  buffer.height = height;
  buffer.getContext('2d').putImageData(frame, 0, 0);

  await hold('crop', frame);
  const detected = await detectQuad({ slot: 'crop' });

  state.crop = {
    // Only the size: the pixels are in the worker, and every reader below
    // this point wants the dimensions rather than the buffer.
    frame: { width, height },
    buffer,
    corners: detected ?? insetQuad(width, height),
    dragging: -1,
  };
  show('crop');
  drawCrop();
  if (!detected) toast(t('crop.noOutline'));
}

// A quad set in from the frame's edges, used when detection finds nothing.
// Starting from the full frame instead would put every handle exactly on a
// corner of the canvas, where it is awkward to grab.
function insetQuad(width, height) {
  const ix = width * 0.08;
  const iy = height * 0.08;
  return [
    { x: ix, y: iy },
    { x: width - ix, y: iy },
    { x: width - ix, y: height - iy },
    { x: ix, y: height - iy },
  ];
}

function cropFit() {
  const canvas = $('crop-canvas');
  // Always use containRect for crop: the drag-corner math in onCropMove also
  // uses containRect and the two must agree exactly, otherwise dragging a
  // corner moves a different part of the image from what the finger touches.
  return containRect(state.crop.frame.width, state.crop.frame.height, canvas.width, canvas.height);
}

function drawCrop() {
  const canvas = $('crop-canvas');
  const stage = $('crop-stage');
  const rect = stage.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const { frame, buffer, corners } = state.crop;
  const fit = containRect(frame.width, frame.height, canvas.width, canvas.height);
  ctx.drawImage(buffer, fit.x, fit.y, fit.width, fit.height);

  const toCanvas = (corner) => ({
    x: fit.x + (corner.x / frame.width) * fit.width,
    y: fit.y + (corner.y / frame.height) * fit.height,
  });
  const points = corners.map(toCanvas);

  // Dim everything outside the page, so the crop reads as "this part" and
  // not as "a shape drawn on a photo".
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fill('evenodd');
  ctx.restore();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.closePath();
  ctx.strokeStyle = '#4c8dff';
  ctx.lineWidth = 2 * dpr;
  ctx.stroke();

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 11 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#4c8dff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}

function cropPointer(event) {
  const canvas = $('crop-canvas');
  const rect = canvas.getBoundingClientRect();
  const dpr = canvas.width / rect.width;
  return { x: (event.clientX - rect.left) * dpr, y: (event.clientY - rect.top) * dpr };
}

function onCropDown(event) {
  if (!state.crop) return;
  const canvas = $('crop-canvas');
  const point = cropPointer(event);
  const { frame, corners } = state.crop;
  const fit = containRect(frame.width, frame.height, canvas.width, canvas.height);
  const dpr = canvas.width / canvas.getBoundingClientRect().width;

  let best = -1;
  // A generous radius: a fingertip is about 9mm across and the handle is
  // drawn at 11px, so hit-testing at the drawn size would mean a handle
  // that looks grabbable and is not.
  let bestDistance = 34 * dpr;
  corners.forEach((corner, index) => {
    const x = fit.x + (corner.x / frame.width) * fit.width;
    const y = fit.y + (corner.y / frame.height) * fit.height;
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });

  if (best < 0) return;
  state.crop.dragging = best;
  canvas.setPointerCapture(event.pointerId);
  event.preventDefault();
}

function onCropMove(event) {
  if (!state.crop || state.crop.dragging < 0) return;
  const canvas = $('crop-canvas');
  const point = cropPointer(event);
  const { frame } = state.crop;
  const fit = containRect(frame.width, frame.height, canvas.width, canvas.height);

  // Clamped to the frame: a corner dragged off the photo would rectify
  // black bars into the page.
  const x = ((point.x - fit.x) / fit.width) * frame.width;
  const y = ((point.y - fit.y) / fit.height) * frame.height;
  state.crop.corners[state.crop.dragging] = {
    x: Math.min(Math.max(x, 0), frame.width),
    y: Math.min(Math.max(y, 0), frame.height),
  };
  drawCrop();
}

function onCropUp() {
  if (state.crop) state.crop.dragging = -1;
}

async function confirmCrop() {
  const btn = $('btn-crop-confirm');
  btn.disabled = true;
  const { corners } = state.crop;
  busy(t('crop.straightening'));
  await paint();
  try {
    // The `crop` slot stays held. The filter view has a back button that
    // returns here, and confirming a second time needs these same pixels;
    // releasing on the way forward made that path fail rather than leak,
    // which is the more expensive kind of mistake.
    const page = await rectify({ slot: 'crop' }, corners, PAGE_MAX_EDGE);
    await openFilter(page);
    idle();
  } catch (error) {
    idle();
    console.error('rectify failed', error);
    toast(t('crop.badCorners'));
  } finally {
    btn.disabled = false;
  }
}

// --- filter ----------------------------------------------------------------

async function openFilter(page) {
  const { width, height } = page;
  await hold('filter-source', page);
  // Two images, one crossing. The preview is derived inside the worker
  // from the page already there, so the full-resolution buffer never
  // travels back here to be shrunk — and every slider nudge afterwards
  // sends a filter name and a number instead of a megapixel image.
  const preview = await derive('filter-source', 'filter-preview', FILTER_PREVIEW_EDGE);

  state.filter = {
    source: { width, height },
    preview,
    name: 'enhance',
    brightness: 0,
    rotation: 0,
  };
  for (const chip of document.querySelectorAll('.chip')) {
    chip.classList.toggle('is-on', chip.dataset.filter === 'enhance');
  }
  $('brightness').value = '0';
  $('brightness-out').textContent = '0';
  show('filter');
  await renderFilter();
}

let filterPending = false;
async function renderFilter() {
  if (filterPending) return;
  filterPending = true;
  await paint();

  try {
    const { name, brightness, rotation } = state.filter;
    const result = await applyFilter({ slot: 'filter-preview' }, name, brightness, rotation);

    const canvas = $('filter-canvas');
    const stage = $('filter-stage');
    const rect = stage.getBoundingClientRect();
    const fit = containRect(result.width, result.height, rect.width, rect.height);
    canvas.style.width = `${Math.round(fit.width)}px`;
    canvas.style.height = `${Math.round(fit.height)}px`;
    canvas.width = result.width;
    canvas.height = result.height;
    canvas.getContext('2d').putImageData(result, 0, 0);
  } catch (error) {
    console.error('filter failed', error);
    toast(t('filter.failed'));
  } finally {
    filterPending = false;
  }
}

// Called by the primary "Continue →" button on the filter/cleanup screen.
// Finishes processing the current page and goes to the Document Review screen.
async function confirmFilter() {
  const { source, name, brightness, rotation } = state.filter;
  if (!source) return;
  const btn = $('btn-filter-confirm');
  btn.disabled = true;
  busy(t('page.adding'));
  await paint();
  try {
    // The one full-resolution pass. Everything up to here was preview.
    const page = await applyFilter({ slot: 'filter-source' }, name, brightness, rotation);
    await addPage(page, name, brightness);
    idle();
    // Go to Document Review — the user is done with this page.
    openTray();
  } catch (error) {
    idle();
    console.error('addPage failed', error);
    toast(t('page.addFailed'));
  } finally {
    btn.disabled = false;
    // The scan is over either way: a page was added, or it failed and the
    // user is being told so. Nothing downstream refers to these again.
    await releaseScanSlots();
  }
}

// Called by the secondary "+ Add page" button on the filter/cleanup screen.
// Saves the current filter choice then adds this page and goes back to camera.
async function filterAddPage() {
  const { source, name, brightness, rotation } = state.filter;
  if (!source) return;
  const btn = $('btn-filter-add-page');
  btn.disabled = true;
  busy(t('page.adding'));
  await paint();
  try {
    const page = await applyFilter({ slot: 'filter-source' }, name, brightness, rotation);
    await addPage(page, name, brightness);
    idle();
    // Go back to the camera to capture the next page.
    show('capture');
    await startCamera();
  } catch (error) {
    idle();
    console.error('addPage failed', error);
    toast(t('page.addFailed'));
  } finally {
    btn.disabled = false;
    await releaseScanSlots();
  }
}

// --- pages -----------------------------------------------------------------

async function addPage(imageData, filterName, brightness) {
  // Black-and-white pages are stored as PNG. Their whole point is hard
  // edges between two values, which is exactly what JPEG destroys — and
  // what the PDF writer then packs a bit per pixel, so a JPEG here would
  // bake in artefacts the export would faithfully preserve.
  const type = filterName === 'bw' ? 'image/png' : 'image/jpeg';
  const { width, height } = imageData;
  // Held once and encoded twice. Both encodes — including the thumbnail's
  // downscale — happen in the worker, so the main thread never runs a
  // multi-megapixel JPEG compression while someone is waiting to see the
  // page appear in the tray.
  await hold('page', imageData);
  const blob = await encodeImage({ slot: 'page' }, type, 0.92);
  const thumb = await encodeImage({ slot: 'page' }, 'image/jpeg', 0.7, THUMB_EDGE);
  await release('page');

  const page = {
    id: store.newId(),
    blob,
    thumb,
    width,
    height,
    filter: filterName,
    brightness,
    ocr: null,
    text: '',
  };
  state.draft.push(page);

  if (state.ocrEnabled) queueOcr(page);
  updateTrayBadge();
  return page;
}

// Recognition runs in the background from the moment a page is added, so
// that by the time someone has finished scanning and typed a name, the
// text is usually already there. The promise is kept on the page so export
// can wait for whatever is still running.
function queueOcr(page) {
  page.ocrPromise = ocr
    .recognize(page.blob)
    .then((result) => {
      page.ocr = { words: result.words, width: result.width, height: result.height };
      page.text = result.text;
      if (state.view === 'tray') renderTray();
    })
    .catch((error) => {
      // A failed read must not block the export. The page still becomes a
      // PDF, just without a searchable layer.
      console.warn('OCR failed for a page:', error);
      page.ocrFailed = true;
      if (state.view === 'tray') renderTray();
    });
  return page.ocrPromise;
}

function updateTrayBadge() {
  $('tray-badge').textContent = String(state.draft.length);
  $('btn-to-tray').disabled = state.draft.length === 0;
  $('capture-count').textContent =
    state.draft.length === 0
      ? t('capture.newDocument')
      : t('pages.count', { count: state.draft.length });
}

function openTray() {
  show('tray');
  renderTray();
}

function renderTray() {
  const list = $('tray-list');
  replaceAndReleaseUrls(list);

  const count = state.draft.length;
  $('tray-title').textContent = count === 1 ? '1 page' : `${count} pages`;

  const hasAuth = hc.getAuthState();
  const btnSave = $('btn-save');
  const btnSaveLocal = $('btn-save-local');

  if (hasAuth) {
    // Authenticated: primary = Save to HC Cloud, secondary = Download Locally
    btnSave.textContent = 'Save to HC Cloud';
    btnSaveLocal.hidden = false;
  } else {
    // Standalone: primary = Save & export (local), hide the "Download Locally" ghost
    // (it would be a confusing duplicate — both buttons do the same thing)
    btnSave.textContent = 'Save & export';
    btnSaveLocal.hidden = true;
  }

  btnSave.disabled = count === 0;
  btnSaveLocal.disabled = count === 0;

  state.draft.forEach((page, index) => {
    const item = document.createElement('div');
    item.className = 'tray-item';

    const img = document.createElement('img');
    img.alt = t('page.alt', { index: index + 1 });
    img.src = objectUrl(page.thumb);
    item.append(img);

    const number = document.createElement('span');
    number.className = 'n';
    number.textContent = String(index + 1);
    item.append(number);

    if (state.ocrEnabled) {
      const flag = document.createElement('span');
      flag.className = 'ocr-flag';
      if (page.ocr) flag.textContent = t('ocr.words', { count: page.ocr.words.length });
      else if (page.ocrFailed) flag.textContent = t('ocr.none');
      else flag.textContent = t('ocr.reading');
      item.append(flag);
    }

    const tools = document.createElement('div');
    tools.className = 'tray-tools';

    const left = document.createElement('button');
    left.type = 'button';
    left.textContent = '←';
    left.title = t('tray.moveEarlier');
    left.disabled = index === 0;
    left.addEventListener('click', () => movePage(index, -1));

    const right = document.createElement('button');
    right.type = 'button';
    right.textContent = '→';
    right.title = t('tray.moveLater');
    right.disabled = index === state.draft.length - 1;
    right.addEventListener('click', () => movePage(index, 1));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '✕';
    remove.title = t('tray.deletePage');
    remove.addEventListener('click', () => {
      state.draft.splice(index, 1);
      updateTrayBadge();
      renderTray();
    });

    tools.append(left, right, remove);
    item.append(tools);
    list.append(item);
  });
}

function movePage(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.draft.length) return;
  const [page] = state.draft.splice(index, 1);
  state.draft.splice(target, 0, page);
  renderTray();
}

// --- save and export -------------------------------------------------------

let cloudSaveContext = null;

// skipCloud=true: always download locally regardless of auth state.
// skipCloud=false (default): go to cloud save if authenticated, else download locally.
async function saveAndExport(skipCloud = false) {
  if (state.draft.length === 0) return;

  $('btn-save').disabled = true;
  $('btn-save-local').disabled = true;

  const pending = state.draft.filter((p) => p.ocrPromise && !p.ocr && !p.ocrFailed);
  if (pending.length > 0) {
    busy(t('ocr.readingPages', { count: pending.length }));
    await Promise.allSettled(pending.map((p) => p.ocrPromise));
  }

  // A page whose text could not be read still exports — losing the scan over a
  // missing text layer would be worse. But it must not export *quietly*: the
  // PDF looks finished, opens correctly, and cannot be searched, and the only
  // previous sign was a console warning. Someone who scans a contract offline
  // and files it away would find out months later, if at all.
  const unread = state.draft.filter((p) => p.ocrFailed);
  if (unread.length > 0 && $('opt-ocr')?.checked) {
    toast(t('ocr.notRead', { count: unread.length }), 6000);
    await paint();
  }

  busy(t('pdf.building'));
  await paint();

  const title = $('doc-title').value.trim() || t('library.untitled');
  const now = Date.now();
  const id = store.newId();

  try {
    const pages = state.draft.map((page, index) => ({
      id: page.id,
      index,
      blob: page.blob,
      thumb: page.thumb,
      width: page.width,
      height: page.height,
      ocr: page.ocr,
      text: page.text,
    }));

    const pdf = await exportPdf(pages, {
      paper: $('opt-paper').value,
      margin: $('opt-paper').value === 'original' ? 0 : 18,
      quality: Number($('opt-quality').value),
      title,
    });

    // Attempted before the file is offered, so a share sheet dismissed or a
    // download cancelled still leaves the document in the library — but not
    // *required*, which it used to be. A throw here jumped to the catch and
    // discarded a PDF that was already built and sitting in memory. A private
    // window refuses to store a Blob at all, so the people most likely to be
    // scanning something sensitive were the ones who walked away with nothing.
    let kept = true;
    try {
      await store.saveDocument(
        {
          id,
          title,
          created: now,
          updated: now,
          pageCount: pages.length,
          text: pages.map((p) => p.text).filter(Boolean).join(' '),
          thumb: pages[0].thumb,
        },
        pages,
      );
    } catch (error) {
      kept = false;
      console.error('could not keep this scan in the library', error);
    }

    idle();
    if (kept) {
      // Only when it is really in the library. Clearing the tray on a failed
      // save would take away the pages as well as the record of them, and the
      // export they could retry from.
      state.draft = [];
      updateTrayBadge();
      await renderLibrary();
    }

    if (skipCloud === true || !hc.getAuthState()) {
      // Just download locally.
      const filename = `${safeFileName(title)}.pdf`;
      await offerFile(pdf, filename);
      if (kept) await openDocument(id);
    } else {
      // Hand over to the HC Cloud Save UI instead of immediately downloading
      openCloudSave(pdf, title, id, kept);
    }

  } catch (error) {
    idle();
    $('btn-save').disabled = false;
    $('btn-save-local').disabled = false;
    console.error('export failed', error);
    toast(t('export.failedKept'));
  }
}

async function openCloudSave(pdfBlob, title, id, kept) {
  cloudSaveContext = { pdfBlob, title, id, kept };
  $('cloud-doc-title').value = title + '.pdf';
  
  $('cloud-auth-required').hidden = true;
  $('cloud-storage-ui').hidden = true;
  $('cloud-upload-ui').hidden = true;
  $('cloud-status-msg').textContent = '';
  $('btn-cloud-save').disabled = false;
  $('btn-cloud-save').hidden = false;
  $('btn-cloud-download').disabled = false;
  
  show('cloud-save');
  
  if (!hc.getAuthState()) {
    $('cloud-auth-required').hidden = false;
    $('btn-cloud-save').disabled = true;
    return;
  }
  
  $('cloud-storage-ui').hidden = false;
  $('cloud-status-msg').textContent = 'Loading drives...';
  $('cloud-drive-select').innerHTML = '';
  $('cloud-folder-select').innerHTML = '';
  $('btn-cloud-save').disabled = true;
  
  try {
    const drives = await hc.fetchDrives();
    if (drives.length === 0) {
      $('cloud-status-msg').textContent = 'No drives available.';
      return;
    }
    
    $('cloud-status-msg').textContent = '';
    for (const d of drives) {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      $('cloud-drive-select').appendChild(opt);
    }
    await loadCloudFolders();
  } catch (err) {
    handleHcError(err);
  }
}

async function loadCloudFolders() {
  const driveId = $('cloud-drive-select').value;
  if (!driveId) return;
  
  $('cloud-status-msg').textContent = 'Loading folders...';
  $('cloud-folder-select').innerHTML = '';
  $('btn-cloud-save').disabled = true;
  
  try {
    const folders = await hc.fetchFolders(driveId);
    if (folders.length === 0) {
      $('cloud-status-msg').textContent = 'Empty folder.';
    } else {
      $('cloud-status-msg').textContent = '';
      for (const f of folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name;
        $('cloud-folder-select').appendChild(opt);
      }
    }
    $('btn-cloud-save').disabled = false;
  } catch (err) {
    handleHcError(err);
  }
}

function handleHcError(err) {
  $('btn-cloud-save').disabled = true;
  const msg = err.message;
  if (msg === '401') {
    $('cloud-auth-required').hidden = false;
    $('cloud-storage-ui').hidden = true;
  } else if (msg === '403') {
    $('cloud-status-msg').textContent = 'Permission denied.';
  } else if (msg === '404') {
    $('cloud-status-msg').textContent = 'Storage location unavailable.';
  } else if (msg === '409') {
    $('cloud-status-msg').textContent = 'File already exists.';
  } else if (msg === '413') {
    $('cloud-status-msg').textContent = 'File is too large.';
  } else if (msg === '500') {
    $('cloud-status-msg').textContent = 'HC Cloud could not save the document.';
  } else {
    $('cloud-status-msg').textContent = 'Unable to connect to HC Cloud.';
  }
}

async function onCloudSaveClick() {
  let filename = $('cloud-doc-title').value.trim();
  filename = filename.replace(/[^\p{L}\p{N} ._-]/gu, '').trim();
  if (!filename) filename = 'Scanned_Document';
  if (!filename.toLowerCase().endsWith('.pdf')) {
    filename += '.pdf';
  }
  
  const driveId = $('cloud-drive-select').value;
  const folderId = $('cloud-folder-select').value;
  
  $('cloud-storage-ui').hidden = true;
  $('cloud-upload-ui').hidden = false;
  $('cloud-upload-title').textContent = 'Uploading document...';
  $('cloud-upload-pct').textContent = '0%';
  $('cloud-upload-progress-bar').style.width = '0%';
  $('btn-cloud-save').disabled = true;
  $('btn-cloud-download').disabled = true;
  
  try {
    await hc.uploadDocument(cloudSaveContext.pdfBlob, driveId, folderId, filename, (pct) => {
      $('cloud-upload-pct').textContent = `${pct}%`;
      $('cloud-upload-progress-bar').style.width = `${pct}%`;
    });
    $('cloud-upload-title').textContent = '✓ Document saved';
    $('btn-cloud-save').hidden = true;
    $('btn-cloud-download').disabled = false;
  } catch (err) {
    $('cloud-upload-ui').hidden = true;
    $('cloud-storage-ui').hidden = false;
    handleHcError(err);
    $('btn-cloud-save').disabled = false;
    $('btn-cloud-download').disabled = false;
  }
}

async function onCloudDownloadClick() {
  const filename = safeFileName(cloudSaveContext.title) + '.pdf';
  await offerFile(cloudSaveContext.pdfBlob, filename);
  if (cloudSaveContext.kept) {
    await openDocument(cloudSaveContext.id);
  } else {
    toast(t('export.notKept'), 7000);
  }
}


function safeFileName(title) {
  return title.replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'scan';
}

// Hand the file to the OS if it will take it, and fall back to a download.
//
// Share is tried first because on a phone it is the only route to "send
// this to someone" that does not go through a download folder the user
// then has to go and find.
async function offerFile(blob, filename) {
  const file = new File([blob], filename, { type: blob.type });

  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return;
    } catch (error) {
      // A user dismissing the share sheet is not a failure, and must not
      // then dump a download on them as if it were.
      if (error?.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// --- saved document --------------------------------------------------------

async function openDocument(id) {
  const doc = await store.getDocument(id);
  if (!doc) {
    toast(t('library.missing'));
    return;
  }
  const pages = await store.getPages(id);
  state.openDoc = { doc, pages };

  $('doc-name').textContent = doc.title || t('library.untitled');
  const container = $('doc-pages');
  replaceAndReleaseUrls(container);

  if (pages.length < doc.pageCount) {
    const notice = document.createElement('div');
    notice.className = 'notice warn';
    notice.textContent = t('doc.missingPages', { count: doc.pageCount - pages.length });
    container.append(notice);
  }

  for (const [index, page] of pages.entries()) {
    const img = document.createElement('img');
    img.alt = t('page.alt', { index: index + 1 });
    img.loading = 'lazy';
    img.src = objectUrl(page.blob);
    container.append(img);
  }

  show('doc');
}

async function exportOpenDoc(share) {
  if (!state.openDoc) return;
  const { doc, pages } = state.openDoc;
  busy(t('pdf.building'));
  await paint();
  try {
    const pdf = await exportPdf(pages, {
      paper: (await store.getSetting('paper', 'a4')),
      margin: 18,
      quality: Number(await store.getSetting('quality', 82)),
      title: doc.title,
    });
    idle();
    const filename = `${safeFileName(doc.title)}.pdf`;
    if (share) await offerFile(pdf, filename);
    else {
      const url = URL.createObjectURL(pdf);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    }
  } catch (error) {
    idle();
    console.error('export failed', error);
    toast(t('export.failed'));
  }
}

// --- about -----------------------------------------------------------------

/// "Camera photo &middot; 4032 x 3024" — or what it fell back to, and why that matters.
function describeLastCapture() {
  const last = state.lastCapture;
  if (!last) return t('about.captureNone');
  const source = t(last.source === 'still' ? 'about.captureStill' : 'about.captureFrame');
  const raw = `${last.rawWidth} \u00d7 ${last.rawHeight}`;
  // Only when the cap actually bit, so the common case stays one number.
  const used =
    last.usedWidth === last.rawWidth && last.usedHeight === last.rawHeight
      ? ''
      : ` \u2192 ${last.usedWidth} \u00d7 ${last.usedHeight}`;
  return `${source} \u00b7 ${raw}${used}`;
}

async function showAbout() {
  const facts = $('about-facts');
  facts.replaceChildren();

  const estimate = await store.storageEstimate();
  const persisted = await navigator.storage?.persisted?.().catch(() => false);

  const rows = [
    [t('about.storedIn'), t('about.storedInValue')],
    [t('about.persisted'), persisted ? t('common.yes') : t('about.persistedNo')],
    [
      t('about.spaceUsed'),
      estimate?.usage != null
        ? t('about.megabytes', { size: (estimate.usage / 1024 / 1024).toFixed(1) })
        : t('about.unknown'),
    ],
    [t('about.ocr'), ocr.isEngineLoaded() ? t('about.ocrLoaded') : t('about.ocrLater')],
    [t('about.offline'), navigator.serviceWorker?.controller ? t('common.yes') : t('about.offlineAfter')],
    [t('about.lastCapture'), describeLastCapture()],
  ];

  for (const [term, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = term;
    const dd = document.createElement('dd');
    dd.textContent = value;
    facts.append(dt, dd);
  }

  $('about').showModal();
}

// --- wiring ----------------------------------------------------------------

function wire() {
  for (const button of document.querySelectorAll('[data-back]')) {
    button.addEventListener('click', async () => {
      show(button.dataset.back);
      if (button.dataset.back === 'library') await renderLibrary($('search').value.trim());
    });
  }

  $('btn-about').addEventListener('click', showAbout);

  let searchTimer = null;
  $('search').addEventListener('input', (event) => {
    clearTimeout(searchTimer);
    const query = event.target.value.trim();
    searchTimer = setTimeout(() => renderLibrary(query), 160);
  });

  $('btn-new-scan').addEventListener('click', async () => {
    show('capture');
    updateTrayBadge();
    await startCamera();
  });

  $('btn-import-library').addEventListener('click', () => pickFiles('draft'));
  $('btn-import-capture').addEventListener('click', () => pickFiles('draft'));
  $('file-input').addEventListener('change', (event) => onFilesPicked(event.target.files));

  $('btn-shutter').addEventListener('click', capture);
  $('btn-flip').addEventListener('click', async () => {
    state.facingMode = state.facingMode === 'environment' ? 'user' : 'environment';
    await startCamera();
  });
  $('btn-to-tray').addEventListener('click', openTray);

  const cropCanvas = $('crop-canvas');
  cropCanvas.addEventListener('pointerdown', onCropDown);
  cropCanvas.addEventListener('pointermove', onCropMove);
  cropCanvas.addEventListener('pointerup', onCropUp);
  cropCanvas.addEventListener('pointercancel', onCropUp);

  $('btn-crop-cancel').addEventListener('click', async () => {
    state.crop = null;
    await releaseScanSlots();
    if (state.draft.length > 0) openTray();
    else {
      show('capture');
      await startCamera();
    }
  });
  $('btn-crop-reset').addEventListener('click', () => {
    const { frame } = state.crop;
    state.crop.corners = fullFrameQuad(frame.width, frame.height);
    drawCrop();
  });
  $('btn-crop-confirm').addEventListener('click', confirmCrop);

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      for (const other of document.querySelectorAll('.chip')) other.classList.remove('is-on');
      chip.classList.add('is-on');
      state.filter.name = chip.dataset.filter;
      void renderFilter();
    });
  }

  $('brightness').addEventListener('input', (event) => {
    state.filter.brightness = Number(event.target.value);
    $('brightness-out').textContent = event.target.value;
    void renderFilter();
  });

  $('btn-filter-rotate').addEventListener('click', () => {
    state.filter.rotation += 1;
    void renderFilter();
  });
  $('btn-filter-back').addEventListener('click', () => {
    show('crop');
    drawCrop();
  });
  // "Continue →" — finish this page and go to Document Review
  $('btn-filter-confirm').addEventListener('click', confirmFilter);
  // "+ Add page" — save this page and immediately go back to camera for the next
  $('btn-filter-add-page').addEventListener('click', filterAddPage);

  $('btn-tray-back').addEventListener('click', async () => {
    show('capture');
    await startCamera();
  });
  // "+ Add another page" on the Document Review screen — go back to camera
  $('btn-add-page').addEventListener('click', async () => {
    show('capture');
    await startCamera();
  });
  $('btn-tray-discard').addEventListener('click', async () => {
    if (
      state.draft.length > 0 &&
      !confirm(t('tray.discardConfirm', { count: state.draft.length }))
    ) {
      return;
    }
    state.draft = [];
    updateTrayBadge();
    show('library');
    await renderLibrary();
  });
  // Primary save button: goes to HC Cloud if authenticated, else downloads locally
  $('btn-save').addEventListener('click', () => saveAndExport(false));
  // Secondary: always download locally (only shown when authenticated)
  $('btn-save-local').addEventListener('click', () => saveAndExport(true));
  
  // HC Cloud Integration Events
  $('btn-cloud-back').addEventListener('click', openTray);
  $('cloud-drive-select').addEventListener('change', loadCloudFolders);
  $('btn-cloud-save').addEventListener('click', onCloudSaveClick);
  $('btn-cloud-download').addEventListener('click', onCloudDownloadClick);

  $('opt-ocr').addEventListener('change', async (event) => {
    state.ocrEnabled = event.target.checked;
    await store.setSetting('ocr', state.ocrEnabled);
    // Turning it on mid-document should catch up the pages already added,
    // rather than exporting a document where only the last pages are
    // searchable.
    if (state.ocrEnabled) {
      for (const page of state.draft) {
        if (!page.ocr && !page.ocrPromise) queueOcr(page);
      }
    }
    renderTray();
  });
  $('opt-paper').addEventListener('change', (e) => store.setSetting('paper', e.target.value));
  $('opt-quality').addEventListener('change', (e) => store.setSetting('quality', e.target.value));

  $('btn-doc-share').addEventListener('click', () => exportOpenDoc(true));
  $('btn-doc-pdf').addEventListener('click', () => exportOpenDoc(false));
  $('btn-doc-delete').addEventListener('click', async () => {
    if (!state.openDoc) return;
    if (!confirm(t('library.deleteConfirm', { title: state.openDoc.doc.title }))) return;
    await store.deleteDocument(state.openDoc.doc.id);
    state.openDoc = null;
    show('library');
    await renderLibrary();
  });

  // Redrawing on resize matters more than usual here: rotating a phone
  // changes the stage's aspect completely, and a crop overlay computed for
  // the old one points at nothing.
  window.addEventListener('resize', () => {
    if (state.view === 'crop' && state.crop) drawCrop();
    if (state.view === 'filter' && state.filter.preview) void renderFilter();
  });

  // Releasing the camera when the tab is backgrounded is both a courtesy
  // (the recording indicator goes out) and a necessity on iOS, which
  // suspends the stream and does not always resume it.
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) stopCamera();
    else if (state.view === 'capture') await startCamera();
  });
}

// --- start -----------------------------------------------------------------

async function main() {
  wire();
  updateTrayBadge();

  // Started, not awaited. Fetching and compiling the wasm module takes a
  // moment, and the view someone lands on — their library — needs none of
  // it. Awaiting here meant an empty screen for the length of that
  // compile, for no reason: the worker queues every request until the
  // module is live, so an operation that arrives early simply waits, and
  // one that arrives after the usual second or two of reading the library
  // does not wait at all.
  initScanner().catch((error) => {
    console.error(error);
    toast(t('engine.failed'));
  });

  // Four independent reads of the same database. Sequential awaits made
  // them four round trips deep rather than one wide.
  const [ocrEnabled, paper, quality] = await Promise.all([
    store.getSetting('ocr', true),
    store.getSetting('paper', 'a4'),
    store.getSetting('quality', 82),
  ]);
  state.ocrEnabled = ocrEnabled;
  $('opt-ocr').checked = ocrEnabled;
  $('opt-paper').value = paper;
  $('opt-quality').value = String(quality);

  await Promise.all([renderLibrary(), renderNotices()]);

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      // Offline support is a bonus, not a prerequisite — the app works
      // without it, so a failed registration is logged and dropped.
      console.warn('offline support unavailable:', error);
    });
  }
}

/// How much of the bottom of the window the browser is covering.
///
/// iOS Safari's floating address bar is painted over the page rather than
/// beside it, and it is not part of `env(safe-area-inset-bottom)` — that is 0
/// in a normal tab and only becomes non-zero in a home-screen app. So the only
/// thing that knows where the visible area really ends is the visual viewport,
/// and the difference between it and `innerHeight` is the furniture.
///
/// Everything here degrades to 0: a browser with no `visualViewport`, or one
/// whose chrome does not overlap, leaves the dock padded exactly as before.
function trackBrowserChrome() {
  const vv = window.visualViewport;
  if (!vv) return;
  const measure = () => {
    const covered = window.innerHeight - (vv.height + vv.offsetTop);
    const px = Math.max(0, Math.round(covered));
    document.documentElement.style.setProperty('--browser-chrome', `${px}px`);
  };
  measure();
  vv.addEventListener('resize', measure);
  vv.addEventListener('scroll', measure);
  window.addEventListener('orientationchange', () => setTimeout(measure, 300));
}

trackBrowserChrome();
main();
