// Full-screen brush tools:
//  - "refine": paint on the cut-out mask (Erase hides, Restore brings back the original).
//  - "erase":  paint over an object; when the finger lifts, the AI removes it and fills the gap.
//  - "patch":  two linked circles; the area under "copy from" is pasted at "paste here".
//  - "retouch": smooth skin, whiten teeth, eye colour, brighten, makeup, hair colour, reshape.
//    Each stroke is worked on a copy of the photo ("work"); lifting the finger keeps it.
// One finger paints. Two fingers zoom and move the picture.
import { $, $$, makeCanvas, ctx2d, copyCanvas, showError, busy, nextFrame } from './util.js';
import { removeObjects } from './ai.js';
import { RETOUCH_TOOLS, toolById, colorsFor, makeEffect, grabWarp, pastePatch } from './retouch.js';
import { faceMask } from './faces.js';

let S = null; // state of the open screen

// face: for Retouch, the selected face; brushing then only changes that face.
export function openBrush(kind, layer, toolId, face = null) {
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
    const titles = { refine: 'Refine edges', erase: 'Remove objects', retouch: 'Retouch', patch: 'Patch' };
    const hints = { refine: 'Paint to erase or restore. Two fingers to zoom.', erase: 'Mark what you want removed', retouch: 'Brush over the area. Two fingers to zoom.', patch: 'Drag the dashed circle onto what to copy, and the solid one to where it goes.' };
    $('#brushTitle').textContent = titles[kind];
    $('#brushHint').textContent = hints[kind];
    $('#brushHint').hidden = false;
    $('#brushModes').hidden = kind !== 'refine';
    $('#retouchTools').hidden = kind !== 'retouch';
    $('#strengthRow').hidden = kind !== 'retouch' && kind !== 'patch';
    $('#patchBtns').hidden = kind !== 'patch';
    $('#strengthLabel').textContent = kind === 'patch' ? 'Edge softness' : 'Strength';
    $('#sizeLabel').textContent = kind === 'patch' ? 'Patch size' : 'Brush size';
    $('#brushSize').max = kind === 'patch' ? 320 : 120;
    setMode('erase');
    if (kind === 'retouch') {
      S.orig = img; S.face = face; S.strokeMask = makeCanvas(img.width, img.height); setTool(toolId);
      if (face && layer.faces && layer.faces.length > 1) $('#brushHint').textContent = `Only Face ${layer.faces.indexOf(face) + 1} will change. Two fingers to zoom.`;
    }
    else { $('#retouchOpts').hidden = $('#retouchColors').hidden = true; }
    if (kind === 'patch') $('#brushStrength').value = 60;
    show(true);
    fit();
    if (kind === 'patch') startPatch();
    draw();
    // Scroll the tool row so the picked tool can be seen (only works once the screen is showing).
    const on = kind === 'retouch' && $('#retouchTools .chip-btn.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
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

// ---------- Retouch tool, option and colour ----------
function setTool(id) {
  const t = toolById(id);
  S.tool = t;
  S.opt = t.opts ? t.opts[0].id : null;
  // Where brushing is allowed: the selected face (a bigger head area for hair colour and for
  // reshaping, so the cheek and jaw edges can move), or everywhere.
  S.faceMask = S.face ? faceMask(S.face, S.img.width, S.img.height, t.id === 'hair' || t.id === 'reshape' ? 'head' : 'face') : null;
  $('#brushStrength').value = t.strength;
  // Reshaping cheeks, lips or a jaw needs a wide, soft brush.
  if (t.id === 'reshape' && Number($('#brushSize').value) < 120) $('#brushSize').value = 120;
  $$('#retouchTools .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.tool === t.id));
  const on = $('#retouchTools .chip-btn.on');
  if (on && on.offsetParent && on.scrollIntoView) on.scrollIntoView({ block: 'nearest', inline: 'center' });
  buildOptions();
}
function buildOptions() {
  const t = S.tool;
  const opts = $('#retouchOpts');
  opts.hidden = !t.opts;
  opts.innerHTML = (t.opts || []).map(o => `<button data-opt="${o.id}" class="${o.id === S.opt ? 'on' : ''}">${o.name}</button>`).join('');
  opts.querySelectorAll('button').forEach(b => (b.onclick = () => { S.opt = b.dataset.opt; S.effect = null; buildOptions(); }));
  const cols = colorsFor(t, S.opt);
  if (!cols || !cols.includes(S.color)) S.color = cols ? cols[0] : null;
  const sw = $('#retouchColors');
  sw.hidden = !cols;
  sw.innerHTML = (cols || []).map(c => `<button class="swatch${c === S.color ? ' on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
  sw.querySelectorAll('.swatch').forEach(b => (b.onclick = () => { S.color = b.dataset.color; S.effect = null; buildOptions(); }));
  S.effect = null;
  if (S.view) draw();
}
const strength = () => Number($('#brushStrength').value) / 100;

// ---------- View (fit, zoom, pan) ----------
function stageSize() {
  const r = $('#brushStage').getBoundingClientRect();
  return { w: r.width, h: r.height };
}
function fit() {
  const { w, h } = stageSize();
  const s = Math.min((w - 24) / S.img.width, (h - 24) / S.img.height);
  S.view = { scale: s, ox: (w - S.img.width * s) / 2, oy: (h - S.img.height * s) / 2 };
  S.fitFor = w + 'x' + h;
  S.fitScale = s;
  $('#brushFit').hidden = true;
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
  if (S.fitFor !== w + 'x' + h) fit(); // the area changed size (for example a row of swatches appeared)
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
  } else if (S.kind === 'retouch' || S.kind === 'patch') {
    cx.drawImage(S.work || S.img, ox, oy, iw, ih);
    if (S.kind === 'patch') drawPatchCircles(cx);
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
  } else if (S.kind === 'retouch') {
    retouchDab(p, r);
  } else {
    const c = ctx2d(S.paint);
    c.fillStyle = '#FF3B5C';
    c.beginPath(); c.arc(p.x, p.y, r, 0, Math.PI * 2); c.fill();
  }
}

// Soft round dab of the effect (or of the original, for Reshape > Restore).
function retouchDab(p, r) {
  const x0 = Math.max(0, Math.floor(p.x - r - 1)), y0 = Math.max(0, Math.floor(p.y - r - 1));
  const x1 = Math.min(S.img.width, Math.ceil(p.x + r + 1)), y1 = Math.min(S.img.height, Math.ceil(p.y + r + 1));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const soft = (c, ox, oy) => {
    // Blush gets an extra-soft edge; the other tools keep a firmer centre for detail work.
    const inner = S.tool.id === 'makeup' && S.opt === 'blush' ? 0 : 0.5;
    const g = c.createRadialGradient(p.x - ox, p.y - oy, r * inner, p.x - ox, p.y - oy, r);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(p.x - ox, p.y - oy, r, 0, Math.PI * 2); c.fill();
  };
  const tmp = makeCanvas(w, h);
  const tc = ctx2d(tmp);
  const wc = ctx2d(S.work);
  if (S.tool.id === 'reshape') {
    // Restore: brush the original photo back in, a little at a time.
    soft(tc, x0, y0);
    tc.globalCompositeOperation = 'source-in';
    tc.drawImage(S.orig, x0, y0, w, h, 0, 0, w, h);
    if (S.faceMask) { tc.globalCompositeOperation = 'destination-in'; tc.drawImage(S.faceMask, x0, y0, w, h, 0, 0, w, h); }
    wc.globalAlpha = strength() * 0.5;
    wc.drawImage(tmp, x0, y0);
    wc.globalAlpha = 1;
    return;
  }
  // Grow this stroke's mask, then show the effect through it (never stronger than Strength).
  soft(ctx2d(S.strokeMask), 0, 0);
  if (S.faceMask) {
    // Nothing outside the selected face can be brushed.
    const mc = ctx2d(S.strokeMask);
    mc.save();
    mc.beginPath(); mc.rect(x0, y0, w, h); mc.clip();
    mc.globalCompositeOperation = 'destination-in';
    mc.drawImage(S.faceMask, 0, 0);
    mc.restore();
  }
  tc.drawImage(S.effect, x0, y0, w, h, 0, 0, w, h);
  tc.globalCompositeOperation = 'destination-in';
  tc.drawImage(S.strokeMask, x0, y0, w, h, 0, 0, w, h);
  wc.save();
  wc.beginPath(); wc.rect(x0, y0, w, h); wc.clip();
  wc.clearRect(x0, y0, w, h);
  wc.drawImage(S.img, 0, 0);
  wc.globalAlpha = strength();
  wc.drawImage(tmp, x0, y0);
  wc.restore();
}

// Put back the original pixels outside the selected face (after a Reshape move).
function keepOutsideFace(x, y, w, h) {
  if (!S.faceMask) return;
  const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
  const ww = Math.min(S.img.width, Math.ceil(x + w)) - x0, hh = Math.min(S.img.height, Math.ceil(y + h)) - y0;
  if (ww <= 0 || hh <= 0) return;
  const tmp = makeCanvas(ww, hh);
  const tc = ctx2d(tmp);
  tc.drawImage(S.img, x0, y0, ww, hh, 0, 0, ww, hh);
  tc.globalCompositeOperation = 'destination-out';
  tc.drawImage(S.faceMask, x0, y0, ww, hh, 0, 0, ww, hh);
  ctx2d(S.work).drawImage(tmp, x0, y0);
}

function strokeTo(p) {
  const r = brushPx() / 2 / S.view.scale;
  if (S.kind === 'retouch' && S.tool.id === 'reshape' && S.opt === 'move') {
    // Reshape > Move: grab the spot where the finger first touched and drag it. A round area
    // (the brush circle) moves with the finger as one smooth piece, fading out at the edge.
    // Each move redraws from the photo as it was when the finger went down, so nothing smears.
    const st = S.stroke;
    if (!st.grab) { st.grab = p; st.box = null; return; }
    const k = 0.35 + 0.65 * strength();
    const v = { x: (p.x - st.grab.x) * k, y: (p.y - st.grab.y) * k };
    const R = r * 1.2;
    const reach = R + Math.hypot(v.x, v.y) + 3;
    // Area touched now, plus what the last move touched (so it can be put back).
    const box = { x0: st.grab.x - reach, y0: st.grab.y - reach, x1: st.grab.x + reach, y1: st.grab.y + reach };
    const all = st.box ? { x0: Math.min(box.x0, st.box.x0), y0: Math.min(box.y0, st.box.y0), x1: Math.max(box.x1, st.box.x1), y1: Math.max(box.y1, st.box.y1) } : box;
    st.box = box;
    grabWarp(S.work, S.img, st.grab, v, R, all);
    keepOutsideFace(all.x0, all.y0, all.x1 - all.x0, all.y1 - all.y0);
    return;
  }
  const last = S.stroke.last;
  if (!last) { dab(p, r); S.stroke.last = p; return; }
  const d = Math.hypot(p.x - last.x, p.y - last.y);
  const step = Math.max(1, r / 4);
  for (let t = step; t <= d; t += step) dab({ x: last.x + ((p.x - last.x) * t) / d, y: last.y + ((p.y - last.y) * t) / d }, r);
  if (d >= step) S.stroke.last = p;
}

// ---------- Patch ----------
// S.src = centre of "copy from", S.dst = centre of "paste here", S.R = radius (picture pixels).
// S.work shows the photo with the patch pasted; Stamp keeps it and lets you patch again.
function startPatch() {
  const W = S.img.width, H = S.img.height;
  $('#brushSize').value = 140;
  S.R = Math.max(3, brushPx() / 2 / S.view.scale);
  S.dst = { x: W * 0.45, y: H * 0.45 };
  S.src = { x: Math.min(W - S.R, S.dst.x + S.R * 2.4), y: S.dst.y };
  S.flip = false;
  $('#patchFlip').classList.remove('on');
  S.work = copyCanvas(S.img);
  S.patchBox = null;
  S.dirty = false; // nothing is pasted until a circle is moved
}
const softness = () => 0.15 + 0.8 * strength();
function renderPatch() {
  if (!S.work) S.work = copyCanvas(S.img);
  const wc = ctx2d(S.work);
  // Put back what the last preview covered, then paste the new one.
  if (S.patchBox) { const b = S.patchBox; wc.clearRect(b.x, b.y, b.w, b.h); wc.drawImage(S.img, b.x, b.y, b.w, b.h, b.x, b.y, b.w, b.h); }
  S.patchBox = pastePatch(S.work, S.img, S.src, S.dst, S.R, softness(), S.flip);
  S.dirty = true;
}
function stampPatch() {
  if (!S.dirty) return;
  S.undo.push(S.img);
  if (S.undo.length > 20) S.undo.shift();
  S.img = S.work;
  S.work = copyCanvas(S.img);
  S.patchBox = null;
  S.dirty = false;
  $('#brushHint').textContent = 'Patch stamped. Move the circles to patch again, or tap ✓ to finish.';
  $('#brushHint').hidden = false;
}
function patchDown(e) {
  if (S.pointers.size === 2) {
    S.drag = null;
    const [a, b] = [...S.pointers.values()];
    S.pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...S.view } };
    return;
  }
  if (S.pointers.size > 2) return;
  const q = toImg(local(e).x, local(e).y);
  const near = c => Math.hypot(q.x - c.x, q.y - c.y) <= S.R * 1.15;
  // Grab a circle; touching anywhere else moves the "paste here" circle there.
  const which = near(S.dst) ? 'dst' : near(S.src) ? 'src' : 'dst';
  if (!near(S.dst) && !near(S.src)) { S.dst = { x: q.x, y: q.y }; renderPatch(); }
  S.drag = { which, from: q, start: { ...S[which] } };
  $('#brushHint').hidden = true;
}
function patchMove(p) {
  const q = toImg(p.x, p.y);
  const d = S.drag;
  S[d.which] = {
    x: Math.min(S.img.width, Math.max(0, d.start.x + q.x - d.from.x)),
    y: Math.min(S.img.height, Math.max(0, d.start.y + q.y - d.from.y)),
  };
  renderPatch();
}
function drawPatchCircles(cx) {
  const { scale, ox, oy } = S.view;
  const sp = c => ({ x: ox + c.x * scale, y: oy + c.y * scale });
  const a = sp(S.src), b = sp(S.dst), r = S.R * scale;
  cx.save();
  // A line linking the two circles.
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
  if (len > r * 2) {
    cx.beginPath();
    cx.moveTo(a.x + (dx / len) * r, a.y + (dy / len) * r);
    cx.lineTo(b.x - (dx / len) * r, b.y - (dy / len) * r);
    cx.setLineDash([4, 4]); cx.lineWidth = 1.5; cx.strokeStyle = 'rgba(255,255,255,.8)'; cx.stroke();
  }
  for (const [c, dash, label] of [[a, [7, 5], 'Copy from'], [b, [], 'Paste here']]) {
    cx.setLineDash(dash);
    cx.beginPath(); cx.arc(c.x, c.y, r, 0, Math.PI * 2);
    cx.lineWidth = 4; cx.strokeStyle = 'rgba(0,0,0,.4)'; cx.stroke();
    cx.lineWidth = 2; cx.strokeStyle = '#fff'; cx.stroke();
    cx.setLineDash([]);
    cx.font = '600 12px -apple-system, Helvetica, Arial, sans-serif';
    cx.textAlign = 'center';
    const ty = label === 'Paste here' ? c.y + r + 16 : c.y - r - 8;
    const tw = cx.measureText(label).width + 12;
    cx.fillStyle = 'rgba(0,0,0,.6)';
    cx.fillRect(c.x - tw / 2, ty - 10, tw, 18);
    cx.fillStyle = '#fff';
    cx.fillText(label, c.x, ty + 3);
  }
  cx.restore();
}

function local(e) {
  const r = $('#brushStage').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e) {
  if (!S || S.busy || e.target !== $('#brushView')) return; // the Fit button is not a brush stroke
  e.preventDefault();
  $('#brushStage').setPointerCapture(e.pointerId);
  S.pointers.set(e.pointerId, local(e));
  if (S.kind === 'patch') { patchDown(e); draw(); return; }
  if (S.pointers.size === 1) {
    // Save a copy first so Undo can go back one stroke.
    if (S.kind === 'retouch') startRetouchStroke();
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
    S.pinch = { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, view: { ...S.view } };
  }
  draw();
}

function startRetouchStroke() {
  if (!S.effect && S.tool.id !== 'reshape') S.effect = makeEffect(S.img, S.tool.id, S.opt, S.color);
  S.work = copyCanvas(S.img);
  ctx2d(S.strokeMask).clearRect(0, 0, S.img.width, S.img.height);
}

function cancelStroke() {
  const prev = S.undo.pop();
  if (S.kind === 'retouch') { S.work = null; return; }
  if (S.kind === 'refine') { S.mask = prev; rebuildCut(0, 0, S.img.width, S.img.height); }
  else ctx2d(S.paint).clearRect(0, 0, S.paint.width, S.paint.height);
}

function onMove(e) {
  if (!S || !S.pointers.has(e.pointerId)) return;
  e.preventDefault();
  const p = local(e);
  S.pointers.set(e.pointerId, p);
  if (S.kind === 'patch' && S.pointers.size === 1 && S.drag) {
    patchMove(p);
  } else if (S.pointers.size === 1 && S.stroke) {
    S.cursor = p;
    strokeTo(toImg(p.x, p.y));
  } else if (S.pointers.size === 2 && S.pinch) {
    const [a, b] = [...S.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const v0 = S.pinch.view;
    // Zoom between half size and 16x the fitted size, so the photo can't vanish.
    const scale = Math.min(S.fitScale * 16, Math.max(S.fitScale * 0.5, (v0.scale * d) / S.pinch.d));
    const k = scale / v0.scale;
    S.view = { scale, ox: mx - (S.pinch.mx - v0.ox) * k, oy: my - (S.pinch.my - v0.oy) * k };
    $('#brushFit').hidden = false;
  }
  draw();
}

async function onUp(e) {
  if (!S || !S.pointers.has(e.pointerId)) return;
  S.pointers.delete(e.pointerId);
  if (S.pointers.size === 0) {
    S.pinch = null;
    S.cursor = null;
    S.drag = null;
    const painted = S.stroke && S.stroke.painted;
    S.stroke = null;
    draw();
    if (painted && S.kind === 'erase') await runErase();
    if (painted && S.kind === 'retouch' && S.work) { S.img = S.work; S.work = null; draw(); }
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
  else if (S.kind === 'retouch') { S.img = prev; S.effect = null; }
  else if (S.kind === 'patch') { S.img = prev; S.work = copyCanvas(S.img); S.patchBox = null; S.dirty = false; } // show the photo without a patch until a circle moves
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
  $('#patchApply').onclick = () => { if (S && S.kind === 'patch') { stampPatch(); draw(); } };
  $('#patchFlip').onclick = () => {
    if (!S || S.kind !== 'patch') return;
    S.flip = !S.flip;
    $('#patchFlip').classList.toggle('on', S.flip);
    if (S.dirty) renderPatch();
    draw();
  };
  const patchSizeOrSoft = () => { if (S && S.kind === 'patch') { S.R = Math.max(3, brushPx() / 2 / S.view.scale); if (S.dirty) renderPatch(); draw(); } };
  $('#brushSize').addEventListener('input', patchSizeOrSoft);
  $('#brushStrength').addEventListener('input', () => { if (S && S.kind === 'patch' && S.dirty) { renderPatch(); draw(); } });
  $('#brushFit').onclick = () => { if (S) { fit(); draw(); } };
  $('#brushCancel').onclick = () => S && !S.busy && close(null);
  $('#brushDone').onclick = () => {
    if (!S || S.busy) return;
    if (S.kind === 'patch' && S.dirty) stampPatch();
    close(S.kind === 'refine' ? { mask: S.mask } : { img: S.img });
  };
  $$('#brushModes button').forEach(b => (b.onclick = () => setMode(b.dataset.mode)));
  $('#retouchTools').innerHTML = RETOUCH_TOOLS.map(t => `<button class="chip-btn" data-tool="${t.id}">${t.name}</button>`).join('');
  $$('#retouchTools .chip-btn').forEach(b => (b.onclick = () => S && !S.busy && setTool(b.dataset.tool)));
  $('#brushSize').addEventListener('input', () => {
    if (!S || S.kind === 'patch') return;
    const { w, h } = stageSize();
    S.cursor = { x: w / 2, y: h / 2 };
    draw();
    clearTimeout(S.cursorTimer);
    S.cursorTimer = setTimeout(() => { if (S) { S.cursor = null; draw(); } }, 700);
  });
  window.addEventListener('resize', () => { if (S) { fit(); draw(); } });
}
