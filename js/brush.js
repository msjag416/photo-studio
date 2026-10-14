// Full-screen brush tools:
//  - "refine": paint on the cut-out mask (Erase hides, Restore brings back the original).
//  - "erase":  paint over an object; when the finger lifts, the AI removes it and fills the gap.
// One finger paints. Two fingers zoom and move the picture.
import { $, $$, makeCanvas, ctx2d, copyCanvas, showError, busy, nextFrame } from './util.js';
import { removeObjects } from './ai.js';

let S = null; // state of the open screen

export function openBrush(kind, layer) {
  return new Promise(resolve => {
    const img = layer.img;
    S = {
      kind, resolve, mode: 'erase',
      img,
      mask: kind === 'refine' ? (layer.mask ? copyCanvas(layer.mask) : solidMask(img)) : null,
      paint: kind === 'erase' ? makeCanvas(img.width, img.height) : null,
      undo: [],
      view: null, pointers: new Map(), stroke: null, cursor: null, busy: false,
    };
    if (kind === 'refine') { S.cut = makeCanvas(img.width, img.height); rebuildCut(0, 0, img.width, img.height); }
    $('#brushTitle').textContent = kind === 'refine' ? 'Refine edges' : 'Remove objects';
    $('#brushHint').textContent = kind === 'refine' ? 'Paint to erase or restore. Two fingers to zoom.' : 'Mark what you want removed';
    $('#brushHint').hidden = false;
    $('#brushModes').hidden = kind !== 'refine';
    setMode('erase');
    show(true);
    fit();
    draw();
  });
}

function solidMask(img) {
  const m = makeCanvas(img.width, img.height);
  const c = ctx2d(m);
  c.fillStyle = '#fff';
  c.fillRect(0, 0, m.width, m.height);
  return m;
}

function show(on) {
  $('#brush').classList.toggle('active', on);
  $('#editor').classList.toggle('active', !on);
}

function close(result) {
  const r = S.resolve;
  S = null;
  show(false);
  r(result);
}

function setMode(m) {
  if (S) S.mode = m;
  $$('#brushModes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
}

// ---------- View (fit, zoom, pan) ----------
function stageSize() {
  const r = $('#brushStage').getBoundingClientRect();
  return { w: r.width, h: r.height };
}
function fit() {
  const { w, h } = stageSize();
  const s = Math.min((w - 24) / S.img.width, (h - 24) / S.img.height);
  S.view = { scale: s, ox: (w - S.img.width * s) / 2, oy: (h - S.img.height * s) / 2 };
}
const toImg = (x, y) => ({ x: (x - S.view.ox) / S.view.scale, y: (y - S.view.oy) / S.view.scale });

let checker;
function checkerPattern(cx) {
  if (!checker) {
    checker = makeCanvas(16, 16);
    const c = ctx2d(checker);
    c.fillStyle = '#d8d8d8'; c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#f4f4f4'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
  }
  return cx.createPattern(checker, 'repeat');
}

function draw() {
  if (!S) return;
  const cv = $('#brushView');
  const { w, h } = stageSize();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const cx = cv.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);
  const { scale, ox, oy } = S.view;
  const iw = S.img.width * scale, ih = S.img.height * scale;
  cx.imageSmoothingQuality = 'high';
  if (S.kind === 'refine') {
    cx.fillStyle = checkerPattern(cx);
    cx.fillRect(ox, oy, iw, ih);
    cx.globalAlpha = 0.28; // faint original so you can see what Restore brings back
    cx.drawImage(S.img, ox, oy, iw, ih);
    cx.globalAlpha = 1;
    cx.drawImage(S.cut, ox, oy, iw, ih);
  } else {
    cx.drawImage(S.img, ox, oy, iw, ih);
    cx.globalAlpha = 0.55;
    cx.drawImage(S.paint, ox, oy, iw, ih);
    cx.globalAlpha = 1;
  }
  if (S.cursor) {
    cx.beginPath();
    cx.arc(S.cursor.x, S.cursor.y, brushPx() / 2, 0, Math.PI * 2);
    cx.strokeStyle = '#fff'; cx.lineWidth = 2; cx.stroke();
    cx.strokeStyle = 'rgba(0,0,0,.5)'; cx.lineWidth = 1; cx.stroke();
  }
}

const brushPx = () => Number($('#brushSize').value); // screen pixels

// ---------- Painting ----------
function rebuildCut(x, y, w, h) {
  x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
  w = Math.min(S.img.width - x, Math.ceil(w)); h = Math.min(S.img.height - y, Math.ceil(h));
  if (w <= 0 || h <= 0) return;
  const c = ctx2d(S.cut);
  c.save();
  c.beginPath(); c.rect(x, y, w, h); c.clip();
  c.clearRect(x, y, w, h);
  c.drawImage(S.img, 0, 0);
  c.globalCompositeOperation = 'destination-in';
  c.drawImage(S.mask, 0, 0);
  c.restore();
}

function dab(p, r) {
  if (S.kind === 'refine') {
    const c = ctx2d(S.mask);
    const g = c.createRadialGradient(p.x, p.y, r * 0.55, p.x, p.y, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.globalCompositeOperation = S.mode === 'erase' ? 'destination-out' : 'source-over';
    c.fillStyle = g;
    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
    c.globalCompositeOperation = 'source-over';
    rebuildCut(p.x - r - 1, p.y - r - 1, r * 2 + 2, r * 2 + 2);
  } else {
    const c = ctx2d(S.paint);
    c.fillStyle = '#FF3B5C';
    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
  }
}

function strokeTo(p) {
  const r = brushPx() / 2 / S.view.scale;
  const last = S.stroke.last;
  if (!last) { dab(p, r); S.stroke.last = p; return; }
  const d = Math.hypot(p.x - last.x, p.y - last.y);
  const step = Math.max(1, r / 4);
  for (let t = step; t <= d; t += step) dab({ x: last.x + ((p.x - last.x) * t) / d, y: last.y + ((p.y - last.y) * t) / d }, r);
  if (d >= step) S.stroke.last = p;
}

function local(e) {
  const r = $('#brushStage').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e) {
  if (!S || S.busy) return;
  e.preventDefault();
  $('#brushStage').setPointerCapture(e.pointerId);
  S.pointers.set(e.pointerId, local(e));
  if (S.pointers.size === 1) {
    // Save a copy first so Undo can go back one stroke.
    S.undo.push(S.kind === 'refine' ? copyCanvas(S.mask) : S.img);
    if (S.undo.length > 20) S.undo.shift();
    S.stroke = { last: null, painted: false };
    const p = local(e);
    S.cursor = p;
    strokeTo(toImg(p.x, p.y));
    S.stroke.painted = true;
    $('#brushHint').hidden = true;
  } else if (S.pointers.size === 2) {
    // Second finger: cancel the stroke and start zooming.
    if (S.stroke && S.stroke.painted) cancelStroke();
    S.stroke = null;
    S.cursor = null;
    const [a, b] = [...S.pointers.values()];
    S.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...S.view } };
  }
  draw();
}

function cancelStroke() {
  const prev = S.undo.pop();
  if (S.kind === 'refine') { S.mask = prev; rebuildCut(0, 0, S.img.width, S.img.height); }
  else ctx2d(S.paint).clearRect(0, 0, S.paint.width, S.paint.height);
}

function onMove(e) {
  if (!S || !S.pointers.has(e.pointerId)) return;
  e.preventDefault();
  const p = local(e);
  S.pointers.set(e.pointerId, p);
  if (S.pointers.size === 1 && S.stroke) {
    S.cursor = p;
    strokeTo(toImg(p.x, p.y));
  } else if (S.pointers.size === 2 && S.pinch) {
    const [a, b] = [...S.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const v0 = S.pinch.view;
    const k = Math.max(0.5, Math.min(12, (v0.scale * d) / S.pinch.d / v0.scale));
    const scale = v0.scale * k;
    S.view = { scale, ox: mx - (S.pinch.mx - v0.ox) * k, oy: my - (S.pinch.my - v0.oy) * k };
  }
  draw();
}

async function onUp(e) {
  if (!S || !S.pointers.has(e.pointerId)) return;
  S.pointers.delete(e.pointerId);
  if (S.pointers.size === 0) {
    S.pinch = null;
    S.cursor = null;
    const painted = S.stroke && S.stroke.painted;
    S.stroke = null;
    draw();
    if (painted && S.kind === 'erase') await runErase();
  }
}

async function runErase() {
  S.busy = true;
  try {
    busy('Removing the object…');
    await nextFrame();
    const out = await removeObjects(S.img, S.paint);
    if (!S) return;
    S.img = out;
    ctx2d(S.paint).clearRect(0, 0, S.paint.width, S.paint.height);
    busy(false);
  } catch (err) {
    if (S) { S.undo.pop(); ctx2d(S.paint).clearRect(0, 0, S.paint.width, S.paint.height); }
    showError('The object could not be removed. Please try again with a smaller area.', err);
  } finally {
    if (S) { S.busy = false; draw(); }
  }
}

function onUndo() {
  if (!S || S.busy || !S.undo.length) return;
  const prev = S.undo.pop();
  if (S.kind === 'refine') { S.mask = prev; rebuildCut(0, 0, S.img.width, S.img.height); }
  else { S.img = prev; ctx2d(S.paint).clearRect(0, 0, S.paint.width, S.paint.height); }
  draw();
}

export function initBrush() {
  const st = $('#brushStage');
  st.addEventListener('pointerdown', onDown);
  st.addEventListener('pointermove', onMove);
  st.addEventListener('pointerup', onUp);
  st.addEventListener('pointercancel', onUp);
  $('#brushUndo').onclick = onUndo;
  $('#brushCancel').onclick = () => S && !S.busy && close(null);
  $('#brushDone').onclick = () => {
    if (!S || S.busy) return;
    close(S.kind === 'refine' ? { mask: S.mask } : { img: S.img });
  };
  $$('#brushModes button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
  $('#brushSize').addEventListener('input', () => {
    if (!S) return;
    const { w, h } = stageSize();
    S.cursor = { x: w / 2, y: h / 2 };
    draw();
    clearTimeout(S.cursorTimer);
    S.cursorTimer = setTimeout(() => { if (S) { S.cursor = null; draw(); } }, 700);
  });
  window.addEventListener('resize', () => { if (S) { fit(); draw(); } });
}
