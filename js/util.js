// Small helpers shared by every part of the app.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

let nextId = 1;
export const uid = () => 'id' + Date.now().toString(36) + (nextId++);

// Make a new canvas. Every canvas gets an id so the render cache can tell pictures apart.
export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c._id = uid();
  return c;
}
export function ctx2d(c) {
  return c.getContext('2d', { willReadFrequently: true });
}
export function copyCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  ctx2d(c).drawImage(src, 0, 0);
  return c;
}

// Cheap blur that works in every browser (Safari does not support ctx.filter):
// shrink the picture, then stretch it back with smoothing.
export function blurCanvas(src, radius) {
  const w = src.width, h = src.height;
  const f = Math.max(1, radius / 1.5);
  const sw = Math.max(1, Math.round(w / f)), sh = Math.max(1, Math.round(h / f));
  const small = makeCanvas(sw, sh);
  const sc = ctx2d(small);
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(src, 0, 0, sw, sh);
  const out = makeCanvas(w, h);
  const oc = ctx2d(out);
  oc.imageSmoothingQuality = 'high';
  oc.drawImage(small, 0, 0, w, h);
  // A second, smaller pass smooths out the blocky look.
  const tiny = makeCanvas(Math.max(1, sw >> 1), Math.max(1, sh >> 1));
  ctx2d(tiny).drawImage(out, 0, 0, tiny.width, tiny.height);
  oc.clearRect(0, 0, w, h);
  oc.drawImage(tiny, 0, 0, w, h);
  return out;
}

// Load a photo file, turn it the right way up and shrink it to about 2000 px on the long side.
export async function fileToCanvas(file, maxSide = 2000) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    bmp = await new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('This file could not be read as a picture.'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w = bmp.width, h = bmp.height;
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = makeCanvas(w * s, h * s);
  const cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(bmp, 0, 0, c.width, c.height);
  if (bmp.close) bmp.close();
  return c;
}

export function canvasToBlob(c, type = 'image/png', q) {
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('Could not make the image file.'))), type, q));
}
export async function blobToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height);
  ctx2d(c).drawImage(bmp, 0, 0);
  if (bmp.close) bmp.close();
  return c;
}

// ---------- Busy spinner ----------
export function busy(text, fraction) {
  const box = $('#busy');
  if (text === false) { box.hidden = true; return; }
  box.hidden = false;
  if (text) $('#busyText').textContent = text;
  $('#busyBar').parentElement.hidden = fraction == null;
  if (fraction != null) $('#busyBar').style.width = Math.round(fraction * 100) + '%';
}
// Let the browser draw the spinner before heavy work starts.
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------- Plain-words error box ----------
export function showError(message, err) {
  busy(false);
  $('#errorText').textContent = message || 'Something went wrong.';
  const detail = err ? (err.message || String(err)) : '';
  $('#errorDetails').textContent = detail || 'No more details.';
  $('#error').hidden = false;
  console.error(message, err);
}

let toastTimer;
export function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2200);
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
