// The editor: canvas in the middle, top bar, tool panel, layers, undo/redo and saving.
import { $, $$, uid, makeCanvas, ctx2d, busy, nextFrame, showError, toast, canvasToBlob } from './util.js';
import { icon, fillIcons } from './icons.js';
import { renderLayer, layerSize, drawLayer, renderProject, defaultEffects, FILTERS } from './render.js';
import { removeBackground } from './ai.js';
import { openBrush } from './brush.js';
import { openText, openCrop, COLORS } from './screens.js';
import { saveProject } from './store.js';

const PREVIEW_CAP = 1400; // editor draws layers at up to this size; saving uses full size
const HISTORY_MAX = 30;

let P = null;          // the open project { id, w, h, bg, layers }
let selId = null;      // selected layer id
let tool = null;       // open tool in the panel, or null for the tool list
let view = { scale: 1, ox: 0, oy: 0 };
let hist = { stack: [], idx: -1 };
let picking = null;    // eyedropper callback
let onExit = null;
let saveFormat = 'png';

const sel = () => (P ? P.layers.find(l => l.id === selId) : null);

// ---------------- Project and layer creation ----------------
export function newProject(w, h, bg = null) {
  return { id: uid(), w: Math.round(w), h: Math.round(h), bg, layers: [] };
}
export function photoLayer(img, P0, fill = false) {
  const fit = fill ? Math.min(P0.w / img.width, P0.h / img.height) : Math.min((P0.w * 0.7) / img.width, (P0.h * 0.7) / img.height);
  return { id: uid(), type: 'photo', img, mask: null, subject: null, crop: null, x: P0.w / 2, y: P0.h / 2, scale: fit, rot: 0, ...defaultEffects() };
}

// ---------------- History (undo / redo) ----------------
// Each step keeps a copy of the settings. Pictures are never changed in place
// (tools always make a new canvas), so steps can share them safely.
function cloneLayer(L) {
  return { ...L, adj: { ...L.adj }, outline: { ...L.outline }, shadow: { ...L.shadow }, crop: L.crop ? { ...L.crop } : null };
}
function snapshot() {
  return { w: P.w, h: P.h, bg: P.bg, layers: P.layers.map(cloneLayer), selId };
}
function commit() {
  hist.stack = hist.stack.slice(0, hist.idx + 1);
  hist.stack.push(snapshot());
  if (hist.stack.length > HISTORY_MAX) hist.stack.shift();
  hist.idx = hist.stack.length - 1;
  updateUndo();
}
function restore(s) {
  P.w = s.w; P.h = s.h; P.bg = s.bg;
  P.layers = s.layers.map(cloneLayer);
  selId = P.layers.some(l => l.id === s.selId) ? s.selId : null;
  tool = null;
  fit(); draw(); buildPanel(); updateUndo();
}
function undo() { if (hist.idx > 0) { hist.idx--; restore(hist.stack[hist.idx]); } }
function redo() { if (hist.idx < hist.stack.length - 1) { hist.idx++; restore(hist.stack[hist.idx]); } }
function updateUndo() {
  $('#undoBtn').disabled = hist.idx <= 0;
  $('#redoBtn').disabled = hist.idx >= hist.stack.length - 1;
}

// ---------------- Open / close ----------------
export async function openEditor(project, opts = {}, exit) {
  P = project;
  onExit = exit;
  selId = opts.select || (P.layers.length === 1 ? P.layers[0].id : null);
  tool = null;
  hist = { stack: [], idx: -1 };
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#editor').classList.add('active');
  await nextFrame();
  fit(); commit(); draw(); buildPanel();
  if (opts.then === 'bg' && sel()) await doRemoveBg();
  if (opts.then === 'erase' && sel()) await doEraseObjects();
}

async function leave() {
  try {
    if (P.layers.length) {
      busy('Saving your project…');
      await nextFrame();
      await saveProject(P, renderProject(P, { maxSide: 320 }));
    }
  } catch (err) {
    console.warn('Could not save project', err);
    toast('This project could not be kept on this device.');
  }
  busy(false);
  P = null;
  onExit && onExit();
}
export async function autosave() {
  if (P && P.layers.length) {
    try { await saveProject(P, renderProject(P, { maxSide: 320 })); } catch (e) { console.warn(e); }
  }
}

// ---------------- Drawing the canvas ----------------
function stageRect() { return $('#stage').getBoundingClientRect(); }
function fit() {
  if (!P) return;
  const r = stageRect();
  const m = 24;
  const s = Math.min((r.width - m * 2) / P.w, (r.height - m * 2) / P.h);
  view = { scale: s, ox: (r.width - P.w * s) / 2, oy: (r.height - P.h * s) / 2 };
}

let checker;
function checkerFill(cx) {
  if (!checker) {
    checker = makeCanvas(16, 16);
    const c = ctx2d(checker);
    c.fillStyle = '#dcdcdc'; c.fillRect(0, 0, 16, 16);
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, 8, 8); c.fillRect(8, 8, 8, 8);
  }
  return cx.createPattern(checker, 'repeat');
}

let raf = 0;
function draw() {
  if (raf) return;
  raf = requestAnimationFrame(() => { raf = 0; drawNow(); });
}
function drawNow() {
  if (!P) return;
  const cv = $('#view');
  const r = stageRect();
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) {
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  }
  const cx = cv.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, r.width, r.height);
  const pw = P.w * view.scale, ph = P.h * view.scale;
  cx.save();
  cx.shadowColor = 'rgba(0,0,0,.12)'; cx.shadowBlur = 16;
  cx.fillStyle = P.bg || checkerFill(cx);
  cx.fillRect(view.ox, view.oy, pw, ph);
  cx.restore();
  cx.save();
  cx.beginPath(); cx.rect(view.ox, view.oy, pw, ph); cx.clip();
  for (const L of P.layers) {
    try { drawLayer(cx, L, view, PREVIEW_CAP); } catch (err) { console.error(err); }
  }
  cx.restore();
  const L = sel();
  if (L && !L.hidden) drawSelection(cx, L);
  $('#refineBtn').hidden = !(L && L.type === 'photo' && L.mask && !tool);
}

// Corners of the selected layer on screen, plus the rotate handle.
function handles(L) {
  const { w, h } = layerSize(L);
  const sc = L.scale * view.scale;
  const cx = view.ox + L.x * view.scale, cy = view.oy + L.y * view.scale;
  const cos = Math.cos(L.rot), sin = Math.sin(L.rot);
  const pt = (lx, ly) => ({ x: cx + (lx * cos - ly * sin) * sc, y: cy + (lx * sin + ly * cos) * sc });
  const hw = w / 2, hh = h / 2;
  const corners = [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)];
  const top = pt(0, -hh);
  const rotH = { x: top.x + sin * 34, y: top.y - cos * 34 };
  return { corners, top, rot: rotH, center: { x: cx, y: cy } };
}
function drawSelection(cx, L) {
  const H = handles(L);
  cx.save();
  cx.strokeStyle = '#0F766E'; cx.lineWidth = 2;
  cx.beginPath();
  H.corners.forEach((p, i) => (i ? cx.lineTo(p.x, p.y) : cx.moveTo(p.x, p.y)));
  cx.closePath(); cx.stroke();
  cx.beginPath(); cx.moveTo(H.top.x, H.top.y); cx.lineTo(H.rot.x, H.rot.y); cx.stroke();
  cx.fillStyle = '#fff';
  for (const p of H.corners) { cx.beginPath(); cx.arc(p.x, p.y, 9, 0, Math.PI * 2); cx.fill(); cx.stroke(); }
  cx.beginPath(); cx.arc(H.rot.x, H.rot.y, 11, 0, Math.PI * 2); cx.fillStyle = '#0F766E'; cx.fill();
  cx.strokeStyle = '#fff'; cx.lineWidth = 1.6;
  cx.beginPath(); cx.arc(H.rot.x, H.rot.y, 5, -Math.PI * 0.9, Math.PI * 0.5); cx.stroke();
  cx.restore();
}

// Is the screen point inside layer L?
function hitLayer(L, x, y) {
  const { w, h } = layerSize(L);
  const sc = L.scale * view.scale;
  const dx = x - (view.ox + L.x * view.scale), dy = y - (view.oy + L.y * view.scale);
  const cos = Math.cos(-L.rot), sin = Math.sin(-L.rot);
  const lx = (dx * cos - dy * sin) / sc, ly = (dx * sin + dy * cos) / sc;
  return Math.abs(lx) <= w / 2 && Math.abs(ly) <= h / 2;
}

// ---------------- Touch and mouse on the canvas ----------------
const pointers = new Map();
let gesture = null;

function local(e) {
  const r = stageRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function onDown(e) {
  if (!P || e.target !== $('#view')) return; // taps on floating buttons are not canvas taps
  e.preventDefault();
  const p = local(e);
  if (picking) { pickColour(p); return; }
  $('#stage').setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, p);
  const L = sel();
  if (pointers.size === 2 && L) {
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), scale: L.scale, rot: L.rot, moved: true };
    return;
  }
  if (pointers.size > 1) return;
  if (L && !L.hidden) {
    const H = handles(L);
    if (Math.hypot(p.x - H.rot.x, p.y - H.rot.y) < 24) { gesture = { kind: 'rotate', start: p, rot0: L.rot, a0: Math.atan2(p.y - H.center.y, p.x - H.center.x) }; return; }
    if (H.corners.some(c => Math.hypot(p.x - c.x, p.y - c.y) < 24)) {
      gesture = { kind: 'scale', start: p, scale0: L.scale, d0: Math.hypot(p.x - H.center.x, p.y - H.center.y) };
      return;
    }
  }
  const hit = [...P.layers].reverse().find(l => !l.hidden && hitLayer(l, p.x, p.y));
  if (hit) {
    const wasSelected = hit.id === selId;
    if (!wasSelected) { selId = hit.id; tool = null; buildPanel(); }
    gesture = { kind: 'move', start: p, x0: hit.x, y0: hit.y, wasSelected, moved: false };
  } else {
    if (selId) { selId = null; tool = null; buildPanel(); }
    gesture = null;
  }
  draw();
}

function onMove(e) {
  if (!pointers.has(e.pointerId)) return;
  e.preventDefault();
  const p = local(e);
  pointers.set(e.pointerId, p);
  const L = sel();
  if (!gesture || !L) return;
  if (gesture.kind === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    L.scale = Math.max(0.01, (gesture.scale * d) / gesture.d);
    L.rot = gesture.rot + Math.atan2(b.y - a.y, b.x - a.x) - gesture.ang;
  } else if (gesture.kind === 'move') {
    const dx = p.x - gesture.start.x, dy = p.y - gesture.start.y;
    if (Math.hypot(dx, dy) > 3) gesture.moved = true;
    if (gesture.moved) { L.x = gesture.x0 + dx / view.scale; L.y = gesture.y0 + dy / view.scale; }
  } else if (gesture.kind === 'scale') {
    const H = handles(L);
    const d = Math.hypot(p.x - H.center.x, p.y - H.center.y);
    L.scale = Math.max(0.01, (gesture.scale0 * d) / Math.max(1, gesture.d0));
    gesture.moved = true;
  } else if (gesture.kind === 'rotate') {
    const H = handles(L);
    let r = gesture.rot0 + Math.atan2(p.y - H.center.y, p.x - H.center.x) - gesture.a0;
    // Snap to straight angles when close.
    const snap = Math.round(r / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(r - snap) < 0.06) r = snap;
    L.rot = r;
    gesture.moved = true;
  }
  draw();
}

async function onUp(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size > 0) return;
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.moved) commit();
  else if (g.kind === 'move' && g.wasSelected) {
    const L = sel();
    if (L && L.type === 'text') editText(L);
  }
}

// ---------------- Eyedropper ----------------
function startPicking(cb) {
  picking = cb;
  $('#pickHint').hidden = false;
}
function pickColour(p) {
  const cv = $('#view');
  const dpr = window.devicePixelRatio || 1;
  const d = cv.getContext('2d').getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data;
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('').toUpperCase();
  const cb = picking;
  picking = null;
  $('#pickHint').hidden = true;
  cb(hex);
}

// ---------------- The AI actions ----------------
async function doRemoveBg() {
  const L = sel();
  if (!L || L.type !== 'photo') return;
  try {
    busy('Removing the background…');
    await nextFrame();
    const mask = await removeBackground(L.img);
    L.subject = mask;
    L.mask = mask;
    busy(false);
    commit(); draw(); buildPanel();
    toast('Background removed. Tap Refine edges to touch up.');
  } catch (err) {
    showError('The background could not be removed. Check your internet connection the first time you use it, then try again.', err);
  }
}
async function doEraseObjects() {
  const L = sel();
  if (!L || L.type !== 'photo') return;
  const res = await openBrush('erase', L);
  fit(); draw();
  if (res && res.img !== L.img) { L.img = res.img; commit(); draw(); }
}
async function doRefine() {
  const L = sel();
  if (!L || L.type !== 'photo') return;
  const res = await openBrush('refine', L);
  fit(); draw();
  if (res) { L.mask = res.mask; commit(); draw(); }
}
async function ensureSubject(L) {
  if (L.subject) return true;
  try {
    busy('Finding the person in the photo…');
    await nextFrame();
    L.subject = await removeBackground(L.img);
    busy(false);
    return true;
  } catch (err) {
    showError('The photo could not be checked for a person. Please try again.', err);
    return false;
  }
}

// ---------------- Text ----------------
async function addText() {
  const hasPhoto = P.layers.some(l => l.type === 'photo');
  const v = await openText({ color: hasPhoto || !P.bg ? '#FFFFFF' : '#1F1F1F' });
  fit(); draw();
  if (!v) return;
  const L = { id: uid(), type: 'text', ...v, x: P.w / 2, y: P.h / 2, scale: 1, rot: 0, ...defaultEffects() };
  const { w, h } = layerSize(L);
  L.scale = Math.min((P.w * 0.7) / w, (P.h * 0.25) / h);
  P.layers.push(L);
  selId = L.id; tool = null;
  commit(); draw(); buildPanel();
}
async function editText(L) {
  const v = await openText(L);
  fit(); draw();
  if (!v) return;
  Object.assign(L, v); // scale stays the same, so the letters keep their size
  commit(); draw(); buildPanel();
}

// ---------------- Panel ----------------
const PHOTO_TOOLS = [
  ['blur', 'Blur background', 'blur'],
  ['enhance', 'Enhance', 'sparkle'],
  ['adjust', 'Adjust', 'sliders'],
  ['filters', 'Filters', 'filter'],
  ['corners', 'Corners', 'corners'],
  ['outline', 'Outline', 'outline'],
  ['shadow', 'Shadow', 'shadow'],
  ['opacity', 'Opacity', 'opacity'],
  ['nudge', 'Nudge', 'move'],
  ['crop', 'Crop', 'crop'],
  ['expand', 'Expand', 'expand'],
];
const TEXT_TOOLS = [
  ['outline', 'Outline', 'outline'],
  ['shadow', 'Shadow', 'shadow'],
  ['opacity', 'Opacity', 'opacity'],
  ['nudge', 'Nudge', 'move'],
];

function buildPanel() {
  const panel = $('#panel');
  const L = sel();
  panel.innerHTML = '';
  if (!L) return canvasPanel(panel);
  if (tool) return toolPanel(panel, L);
  if (L.type === 'photo') {
    panel.innerHTML = `
      <div class="big-actions">
        <button class="big-btn" data-act="bg">${icon('cutout')}${L.mask ? 'Bring back background' : 'Remove background'}</button>
        <button class="big-btn alt" data-act="erase">${icon('eraser')}Remove objects</button>
      </div>
      <div class="tools">
        ${L.mask ? `<button class="tool" data-tool="refine">${icon('brush')}Refine edges</button>` : ''}
        ${PHOTO_TOOLS.map(([id, name, ic]) => `<button class="tool${toolActive(L, id) ? ' on' : ''}" data-tool="${id}">${icon(ic)}${name}</button>`).join('')}
      </div>`;
  } else {
    panel.innerHTML = `
      <div class="big-actions">
        <button class="big-btn" data-act="edittext">${icon('text')}Edit text</button>
        <button class="big-btn alt" data-act="duplicate">${icon('copy')}Duplicate</button>
      </div>
      <div class="tools">${TEXT_TOOLS.map(([id, name, ic]) => `<button class="tool${toolActive(L, id) ? ' on' : ''}" data-tool="${id}">${icon(ic)}${name}</button>`).join('')}</div>`;
  }
  panel.querySelectorAll('[data-act]').forEach(b => (b.onclick = () => panelAction(b.dataset.act)));
  panel.querySelectorAll('[data-tool]').forEach(b => (b.onclick = () => openTool(b.dataset.tool)));
}

function toolActive(L, id) {
  switch (id) {
    case 'blur': return L.blurBg > 0;
    case 'enhance': return L.enhance;
    case 'adjust': return Object.values(L.adj).some(v => v);
    case 'filters': return L.filter !== 'none';
    case 'corners': return L.radius > 0;
    case 'outline': return L.outline.on;
    case 'shadow': return L.shadow.on;
    case 'opacity': return L.opacity < 100;
    case 'crop': return !!L.crop;
  }
  return false;
}

async function panelAction(act) {
  const L = sel();
  if (act === 'bg') {
    if (L.mask) { L.mask = null; commit(); draw(); buildPanel(); }
    else await doRemoveBg();
  } else if (act === 'erase') await doEraseObjects();
  else if (act === 'edittext') await editText(L);
  else if (act === 'duplicate') duplicate(L);
}

async function openTool(id) {
  const L = sel();
  if (id === 'refine') return doRefine();
  if (id === 'crop') {
    const r = await openCrop(L);
    fit();
    if (r) { L.crop = r.crop; commit(); }
    draw(); buildPanel();
    return;
  }
  if (id === 'enhance') { L.enhance = !L.enhance; commit(); draw(); buildPanel(); toast(L.enhance ? 'Enhanced' : 'Enhance off'); return; }
  if (id === 'blur' && !(await ensureSubject(L))) return;
  tool = id;
  buildPanel();
  draw();
}

function header(title) {
  return `<div class="panel-title"><button class="icon-btn" data-back aria-label="Back">${icon('back')}</button>${title}</div>`;
}

// Builds slider rows. Moving a slider updates the picture live; letting go saves an undo step.
function slider(label, min, max, get, set, unit = '') {
  const row = document.createElement('label');
  row.className = 'slider-row';
  row.innerHTML = `<span>${label}<b>${Math.round(get())}${unit}</b></span><input type="range" min="${min}" max="${max}" value="${get()}">`;
  const input = row.querySelector('input'), out = row.querySelector('b');
  input.addEventListener('input', () => { set(Number(input.value)); out.textContent = input.value + unit; draw(); });
  input.addEventListener('change', () => commit());
  return row;
}
function switchRow(label, get, set) {
  const row = document.createElement('label');
  row.className = 'switch-row';
  row.innerHTML = `<span>${label}</span><input type="checkbox" ${get() ? 'checked' : ''}>`;
  row.querySelector('input').onchange = e => { set(e.target.checked); commit(); draw(); };
  return row;
}
function colourRow(get, set, withNone = false) {
  const row = document.createElement('div');
  row.className = 'swatches';
  const cols = withNone ? [null, ...COLORS] : COLORS;
  row.innerHTML = cols.map(c => `<button class="swatch${c ? '' : ' none'}${get() === c ? ' on' : ''}" data-c="${c || ''}" style="${c ? 'background:' + c : ''}" aria-label="Colour"></button>`).join('')
    + `<input type="color" class="color-input" value="${get() || '#ffffff'}" aria-label="Choose any colour">`
    + `<button class="icon-btn" data-drop aria-label="Pick colour from photo">${icon('dropper')}</button>`;
  const pick = c => { set(c); commit(); draw(); row.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', (s.dataset.c || null) === c)); };
  row.querySelectorAll('.swatch').forEach(s => (s.onclick = () => pick(s.dataset.c || null)));
  const ci = row.querySelector('input');
  ci.addEventListener('input', () => { set(ci.value.toUpperCase()); draw(); });
  ci.addEventListener('change', () => commit());
  row.querySelector('[data-drop]').onclick = () => startPicking(hex => pick(hex));
  return row;
}

function toolPanel(panel, L) {
  const titles = Object.fromEntries([...PHOTO_TOOLS, ...TEXT_TOOLS].map(([id, n]) => [id, n]));
  panel.innerHTML = header(titles[tool] || '');
  panel.querySelector('[data-back]').onclick = () => { tool = null; picking = null; $('#pickHint').hidden = true; buildPanel(); draw(); };
  const add = el => panel.appendChild(el);
  const note = t => { const p = document.createElement('p'); p.className = 'panel-note'; p.textContent = t; add(p); };

  if (tool === 'adjust') {
    add(slider('Brightness', -100, 100, () => L.adj.bright, v => (L.adj.bright = v)));
    add(slider('Contrast', -100, 100, () => L.adj.contrast, v => (L.adj.contrast = v)));
    add(slider('Saturation', -100, 100, () => L.adj.sat, v => (L.adj.sat = v)));
    add(slider('Warmth', -100, 100, () => L.adj.warmth, v => (L.adj.warmth = v)));
    const reset = document.createElement('button');
    reset.className = 'chip-btn'; reset.textContent = 'Reset';
    reset.onclick = () => { L.adj = { bright: 0, contrast: 0, sat: 0, warmth: 0 }; commit(); buildPanel(); draw(); };
    add(reset);
  } else if (tool === 'filters') {
    const grid = document.createElement('div');
    grid.className = 'filter-grid';
    for (const f of FILTERS) {
      const item = document.createElement('button');
      item.className = 'filter-item' + (L.filter === f.id ? ' on' : '');
      const thumb = renderLayer({ ...L, filter: f.id, outline: { ...L.outline, on: false } }, 140).canvas;
      const c = makeCanvas(140, 140);
      const s = Math.min(140 / thumb.width, 140 / thumb.height);
      ctx2d(c).drawImage(thumb, (140 - thumb.width * s) / 2, (140 - thumb.height * s) / 2, thumb.width * s, thumb.height * s);
      item.appendChild(c);
      item.appendChild(document.createTextNode(f.name));
      item.onclick = () => { L.filter = f.id; commit(); draw(); grid.querySelectorAll('.filter-item').forEach(x => x.classList.toggle('on', x === item)); };
      grid.appendChild(item);
    }
    add(grid);
  } else if (tool === 'blur') {
    note('Keeps the person sharp and softens everything behind them.');
    add(slider('Blur amount', 0, 100, () => L.blurBg, v => (L.blurBg = v)));
  } else if (tool === 'corners') {
    add(slider('Roundness', 0, 100, () => L.radius, v => (L.radius = v)));
  } else if (tool === 'outline') {
    add(switchRow('Outline', () => L.outline.on, v => (L.outline.on = v)));
    add(slider('Thickness', 1, 100, () => L.outline.size, v => { L.outline.size = v; L.outline.on = true; }));
    add(slider('Gap', 0, 60, () => L.outline.gap, v => { L.outline.gap = v; L.outline.on = true; }));
    add(colourRow(() => L.outline.color, c => { L.outline.color = c || '#FFFFFF'; L.outline.on = true; }));
  } else if (tool === 'shadow') {
    add(switchRow('Shadow', () => L.shadow.on, v => (L.shadow.on = v)));
    const on = fn => v => { fn(v); L.shadow.on = true; };
    add(slider('Softness', 0, 100, () => L.shadow.blur, on(v => (L.shadow.blur = v))));
    add(slider('Distance', 0, 100, () => L.shadow.dist, on(v => (L.shadow.dist = v))));
    add(slider('Direction', 0, 360, () => L.shadow.angle, on(v => (L.shadow.angle = v)), '°'));
    add(slider('Strength', 0, 100, () => L.shadow.strength, on(v => (L.shadow.strength = v)), '%'));
    add(colourRow(() => L.shadow.color, on(c => (L.shadow.color = c || '#000000'))));
  } else if (tool === 'opacity') {
    add(slider('Opacity', 0, 100, () => L.opacity, v => (L.opacity = v), '%'));
  } else if (tool === 'nudge') {
    const pad = document.createElement('div');
    pad.className = 'nudge';
    const step = () => Math.max(1, Math.round(Math.max(P.w, P.h) / 200));
    const btn = (ic, fn) => { const b = document.createElement('button'); b.innerHTML = icon(ic); b.onclick = () => { fn(); commit(); draw(); }; return b; };
    const blank = () => document.createElement('span');
    pad.append(blank(), btn('up', () => (L.y -= step())), blank(),
      btn('left', () => (L.x -= step())), btn('center', () => { L.x = P.w / 2; L.y = P.h / 2; }), btn('right', () => (L.x += step())),
      blank(), btn('down', () => (L.y += step())), blank());
    add(pad);
    const row = document.createElement('div');
    row.className = 'row-btns';
    row.innerHTML = `<button class="chip-btn" data-f="x">Flip sideways</button><button class="chip-btn" data-f="y">Flip upside down</button><button class="chip-btn" data-f="r">Straighten</button>`;
    row.querySelector('[data-f=x]').onclick = () => { L.flipX = !L.flipX; commit(); draw(); };
    row.querySelector('[data-f=y]').onclick = () => { L.flipY = !L.flipY; commit(); draw(); };
    row.querySelector('[data-f=r]').onclick = () => { L.rot = 0; commit(); draw(); };
    add(row);
  } else if (tool === 'expand') {
    note('Adds see-through space around your picture, so there is room for text or a shadow.');
    const row = document.createElement('div');
    row.className = 'row-btns';
    row.innerHTML = `<button class="chip-btn" data-e="10">Add 10%</button><button class="chip-btn" data-e="25">Add 25%</button><button class="chip-btn" data-e="fit">Fit canvas to this layer</button>`;
    row.querySelectorAll('[data-e]').forEach(b => (b.onclick = () => expandCanvas(b.dataset.e)));
    add(row);
  }
}

function expandCanvas(how) {
  let nw, nh, dx, dy;
  if (how === 'fit') {
    const L = sel();
    const H = handles(L);
    const xs = H.corners.map(p => (p.x - view.ox) / view.scale), ys = H.corners.map(p => (p.y - view.oy) / view.scale);
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    nw = Math.max(...xs) - x0; nh = Math.max(...ys) - y0; dx = -x0; dy = -y0;
  } else {
    const f = Number(how) / 100;
    dx = Math.round(P.w * f); dy = Math.round(P.h * f);
    nw = P.w + dx * 2; nh = P.h + dy * 2;
  }
  if (nw * nh > 6000 * 6000) { toast('The canvas is already as big as it can be.'); return; }
  P.w = Math.round(nw); P.h = Math.round(nh);
  for (const l of P.layers) { l.x += dx; l.y += dy; }
  fit(); commit(); draw();
  toast(`Canvas is now ${P.w} × ${P.h}`);
}

function canvasPanel(panel) {
  panel.innerHTML = `<div class="panel-title">Canvas</div>
    <p class="panel-note">Tap a photo or text to edit it. Use the buttons at the top to add more.</p>
    <div class="panel-note" style="margin-bottom:4px">Background colour</div>`;
  panel.appendChild(colourRow(() => P.bg, c => (P.bg = c), true));
  const row = document.createElement('div');
  row.className = 'row-btns';
  row.innerHTML = `<button class="chip-btn" data-e="10">Add 10% space</button><button class="chip-btn" data-e="25">Add 25% space</button>`;
  row.querySelectorAll('[data-e]').forEach(b => (b.onclick = () => expandCanvas(b.dataset.e)));
  panel.appendChild(row);
  const size = document.createElement('p');
  size.className = 'panel-note';
  size.textContent = `Size: ${P.w} × ${P.h}`;
  panel.appendChild(size);
}

// ---------------- Layers ----------------
function duplicate(L) {
  const c = cloneLayer(L);
  c.id = uid();
  c.x += P.w * 0.04; c.y += P.h * 0.04;
  P.layers.splice(P.layers.indexOf(L) + 1, 0, c);
  selId = c.id; tool = null;
  commit(); draw(); buildPanel();
}

function openLayers() {
  const list = $('#layerList');
  list.innerHTML = '';
  if (!P.layers.length) list.innerHTML = '<p class="panel-note">No layers yet. Add a photo or some text.</p>';
  const rev = [...P.layers].reverse();
  rev.forEach((L, i) => {
    const row = document.createElement('div');
    row.className = 'layer-row' + (L.id === selId ? ' sel' : '');
    const th = makeCanvas(88, 88);
    try {
      const r = renderLayer(L, 160).canvas;
      const s = Math.min(88 / r.width, 88 / r.height);
      ctx2d(th).drawImage(r, (88 - r.width * s) / 2, (88 - r.height * s) / 2, r.width * s, r.height * s);
    } catch (e) { /* thumbnail is optional */ }
    row.appendChild(th);
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = L.type === 'text' ? '“' + L.text.split('\n')[0] + '”' : 'Photo ' + (P.layers.indexOf(L) + 1);
    row.appendChild(name);
    const b = (ic, label, fn, disabled) => {
      const btn = document.createElement('button');
      btn.className = 'icon-btn'; btn.innerHTML = icon(ic); btn.setAttribute('aria-label', label);
      btn.disabled = !!disabled;
      btn.onclick = e => { e.stopPropagation(); fn(); commit(); draw(); buildPanel(); openLayers(); };
      row.appendChild(btn);
    };
    const idx = P.layers.indexOf(L);
    b(L.hidden ? 'eyeoff' : 'eye', L.hidden ? 'Show' : 'Hide', () => (L.hidden = !L.hidden));
    b('up', 'Move up', () => { P.layers.splice(idx, 1); P.layers.splice(idx + 1, 0, L); }, i === 0);
    b('down', 'Move down', () => { P.layers.splice(idx, 1); P.layers.splice(idx - 1, 0, L); }, i === rev.length - 1);
    b('copy', 'Duplicate', () => duplicate(L));
    b('trash', 'Delete', () => { P.layers.splice(idx, 1); if (selId === L.id) { selId = null; tool = null; } });
    row.onclick = () => { selId = L.id; tool = null; $('#layersSheet').hidden = true; buildPanel(); draw(); };
    list.appendChild(row);
  });
  $('#layersSheet').hidden = false;
}

// ---------------- Save ----------------
async function exportBlob() {
  busy('Making your picture…');
  await nextFrame();
  const c = renderProject(P, { background: saveFormat === 'jpg' ? '#FFFFFF' : null });
  const blob = saveFormat === 'jpg' ? await canvasToBlob(c, 'image/jpeg', 0.92) : await canvasToBlob(c, 'image/png');
  busy(false);
  const name = `photo-studio-${new Date().toISOString().slice(0, 10)}.${saveFormat}`;
  return { blob, name };
}
async function download() {
  try {
    const { blob, name } = await exportBlob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    $('#saveSheet').hidden = true;
    toast('Saved');
    autosave();
  } catch (err) {
    showError('The picture could not be saved.', err);
  }
}
async function share() {
  try {
    const { blob, name } = await exportBlob();
    const file = new File([blob], name, { type: blob.type });
    await navigator.share({ files: [file] });
    $('#saveSheet').hidden = true;
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    showError('Sharing did not work. Try Download instead.', err);
  }
}
function openSave() {
  if (!P.layers.length) { toast('Add a photo or text first'); return; }
  const testFile = typeof File !== 'undefined' ? new File([new Blob(['x'], { type: 'image/png' })], 'x.png', { type: 'image/png' }) : null;
  $('#shareBtn').hidden = !(navigator.canShare && testFile && navigator.canShare({ files: [testFile] }));
  $('#saveSheet').hidden = false;
}

// ---------------- Adding photos ----------------
export function addPhoto(img) {
  const L = photoLayer(img, P);
  P.layers.push(L);
  selId = L.id; tool = null;
  commit(); draw(); buildPanel();
}
export const isOpen = () => !!P;

// ---------------- Wiring ----------------
export function initEditor() {
  const st = $('#stage');
  st.addEventListener('pointerdown', onDown);
  st.addEventListener('pointermove', onMove);
  st.addEventListener('pointerup', onUp);
  st.addEventListener('pointercancel', onUp);
  $('#undoBtn').onclick = undo;
  $('#redoBtn').onclick = redo;
  $('#backBtn').onclick = leave;
  $('#addTextBtn').onclick = addText;
  $('#layersBtn').onclick = openLayers;
  $('#saveBtn').onclick = openSave;
  $('#refineBtn').onclick = doRefine;
  $('#downloadBtn').onclick = download;
  $('#shareBtn').onclick = share;
  $$('#formatBtns button').forEach(b => (b.onclick = () => {
    saveFormat = b.dataset.format;
    $$('#formatBtns button').forEach(x => x.classList.toggle('on', x === b));
  }));
  window.addEventListener('resize', () => { if (P) { fit(); draw(); } });
  fillIcons();
}
