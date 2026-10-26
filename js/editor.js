// The editor: canvas in the middle, top bar, tool panel, layers, undo/redo and saving.
import { $, $$, uid, makeCanvas, ctx2d, busy, nextFrame, showError, toast, canvasToBlob } from './util.js';
import { icon, fillIcons } from './icons.js';
import { renderLayer, layerSize, drawLayer, renderProject, defaultEffects, FILTERS } from './render.js';
import { removeBackground } from './ai.js';
import { detectFaces, matchFaces, faceAt } from './faces.js';
import { BROW_STYLES, AUTO_FIX, DEFAULT_BROWS, styleParams, matchColor, removeBrows, drawBrows, naturalShapes } from './brows.js';
import { openBrush, isMoveMode, setMoveMode } from './brush.js';
import { RETOUCH_TOOLS } from './retouch.js';
import { SHAPE_SLIDERS, hasShape } from './faceshape.js';
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
  const brows = L.brows ? Object.fromEntries(Object.entries(L.brows).map(([k, v]) => [k, { ...v }])) : null;
  const shape = L.shape ? Object.fromEntries(Object.entries(L.shape).map(([k, v]) => [k, { ...v }])) : null;
  return { ...L, adj: { ...L.adj }, outline: { ...L.outline }, shadow: { ...L.shadow }, crop: L.crop ? { ...L.crop } : null, brows, shape, browColor: L.browColor ? { ...L.browColor } : null };
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
  for (const L of P.layers) if (L.type === 'photo') ensureFaces(L, 'quiet'); // find faces in the background
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
  view.fitFor = r.width + 'x' + r.height;
  view.fitScale = s;
  view.zoomed = false;
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
  // The photo area changed size (for example the panel below grew), so fit the photo again.
  if (view.fitFor !== r.width + 'x' + r.height) fit();
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
  if (L && !L.hidden && L.type === 'photo' && L.faces && (L.faces.length > 1 || tool === 'brows' || tool === 'shape')) drawFaceOutlines(cx, L);
  $('#refineBtn').hidden = !(L && L.type === 'photo' && L.mask && !tool);
  $('#fitBtn').hidden = !view.zoomed;
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

// Picture pixels of a photo layer <-> screen points.
function imgToScreen(L, ix, iy) {
  const c = L.crop || { x: 0, y: 0 };
  const { w, h } = layerSize(L);
  const lx = (ix - c.x - w / 2) * (L.flipX ? -1 : 1), ly = (iy - c.y - h / 2) * (L.flipY ? -1 : 1);
  const sc = L.scale * view.scale, cos = Math.cos(L.rot), sin = Math.sin(L.rot);
  return { x: view.ox + L.x * view.scale + (lx * cos - ly * sin) * sc, y: view.oy + L.y * view.scale + (lx * sin + ly * cos) * sc };
}
function screenToImg(L, x, y) {
  const c = L.crop || { x: 0, y: 0 };
  const { w, h } = layerSize(L);
  const sc = L.scale * view.scale, cos = Math.cos(-L.rot), sin = Math.sin(-L.rot);
  const dx = x - (view.ox + L.x * view.scale), dy = y - (view.oy + L.y * view.scale);
  const lx = (dx * cos - dy * sin) / sc, ly = (dx * sin + dy * cos) / sc;
  return { x: lx * (L.flipX ? -1 : 1) + c.x + w / 2, y: ly * (L.flipY ? -1 : 1) + c.y + h / 2 };
}

// An oval around each face; the selected one is solid and coloured, the others dashed.
function drawFaceOutlines(cx, L) {
  cx.save();
  L.faces.forEach((f, n) => {
    const b = f.box, mx = b.x + b.w / 2, my = b.y + b.h / 2;
    const on = f.id === L.selFace;
    cx.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const q = imgToScreen(L, mx + Math.cos(a) * b.w * 0.68, my + Math.sin(a) * b.h * 0.66);
      i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y);
    }
    cx.closePath();
    cx.setLineDash(on ? [] : [6, 5]);
    cx.lineWidth = on ? 4 : 2.5; cx.strokeStyle = 'rgba(0,0,0,.35)'; cx.stroke();
    cx.lineWidth = on ? 2.5 : 1.5; cx.strokeStyle = on ? '#2DD4BF' : '#fff'; cx.stroke();
    const top = imgToScreen(L, mx, my - b.h * 0.66);
    cx.setLineDash([]);
    cx.beginPath(); cx.arc(top.x, top.y, 11, 0, Math.PI * 2);
    cx.fillStyle = on ? '#0F766E' : 'rgba(0,0,0,.55)'; cx.fill();
    cx.fillStyle = '#fff'; cx.font = '600 12px -apple-system, Helvetica, Arial, sans-serif';
    cx.textAlign = 'center'; cx.textBaseline = 'middle';
    cx.fillText(String(n + 1), top.x, top.y + 0.5);
  });
  cx.restore();
}

// ---------------- Faces ----------------
// Find the faces in a photo layer (once per picture). Each face keeps its id when the photo
// changes, matched by position, so its settings stay with the same person.
// mode: 'quiet' (in the background), 'soft' (tools that also work without faces: a short note
// on failure) or 'strict' (tools that need faces: an error box on failure).
const pendingFaces = new Map();
async function ensureFaces(L, mode = 'strict') {
  const quiet = mode !== 'strict' && mode !== 'soft';
  if (!L || L.type !== 'photo') return [];
  if (L.faces && L.facesFor === L.img._id) return L.faces;
  const img = L.img;
  if (!quiet) busy('Finding faces…');
  try {
    if (!pendingFaces.has(img)) pendingFaces.set(img, detectFaces(img));
    const found = await pendingFaces.get(img);
    // Update this layer and its copies in the undo history that show the same picture.
    for (const l of [L, ...hist.stack.flatMap(st => st.layers)]) {
      if (l.id !== L.id || l.img !== img) continue;
      l.faces = matchFaces(l.faces, found.map(f => ({ ...f })));
      l.facesFor = img._id;
      if (!l.faces.some(f => f.id === l.selFace)) l.selFace = l.faces[0] ? l.faces[0].id : null;
    }
    if (quiet && L.faces.length > 1 && P && sel() === L) toast(`Found ${L.faces.length} faces. Tap one to choose who to edit.`);
  } catch (err) {
    pendingFaces.delete(img);
    if (mode === 'strict') showError('Faces could not be found in this photo. Please try again.', err);
    else if (mode === 'soft') toast('Faces could not be found, so the brush works on the whole photo.');
    else console.warn('Face finding failed', err);
    return [];
  } finally {
    if (!quiet) busy(false);
  }
  if (P) { draw(); if (sel() === L && !tool) buildPanel(); }
  return L.faces || [];
}
const selFace = L => (L.faces || []).find(f => f.id === L.selFace) || null;
function chooseFace(L, id) {
  L.selFace = id;
  draw(); buildPanel();
  toast(`Face ${L.faces.findIndex(f => f.id === id) + 1} selected`);
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

// ---------- Mouse and trackpad zoom (for computers without touch) ----------
let spaceDown = false;
function zoomView(factor, cx, cy) {
  if (!P) return;
  const v0 = view;
  const scale = Math.min(v0.fitScale * 12, Math.max(v0.fitScale * 0.5, v0.scale * factor));
  const k = scale / v0.scale;
  view = { ...v0, scale, ox: cx - (cx - v0.ox) * k, oy: cy - (cy - v0.oy) * k, zoomed: true };
  draw();
}
function onWheel(e) {
  if (!P) return;
  e.preventDefault();
  const p = local(e);
  const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
  // Mouse wheel and trackpad pinch zoom; trackpad two-finger scroll moves the picture.
  if (!e.ctrlKey && !isMouseWheel(e)) {
    view = { ...view, ox: view.ox - e.deltaX * unit, oy: view.oy - e.deltaY * unit, zoomed: true };
    draw();
    return;
  }
  zoomView(Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), p.x, p.y);
}

function onDown(e) {
  if (!P || e.target !== $('#view')) return; // taps on floating buttons are not canvas taps
  const r0 = stageRect();
  if (view.fitFor !== r0.width + 'x' + r0.height) { fit(); draw(); }
  e.preventDefault();
  const p = local(e);
  if (picking) { pickColour(p); return; }
  $('#stage').setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || spaceDown || isMoveMode()) {
    // Middle or right mouse button, or Space held down: drag to move around the picture.
    pointers.set(e.pointerId, p);
    gesture = { kind: 'pan', x: p.x, y: p.y, ox: view.ox, oy: view.oy };
    $('#stage').classList.add('panning');
    return;
  }
  pointers.set(e.pointerId, p);
  const L = sel();
  if (pointers.size === 2) {
    // Two fingers zoom in and move around the picture (like a magnifier); the photo itself
    // doesn't change. Undo any small move the first finger already made.
    if (gesture && gesture.kind === 'move' && gesture.moved && L) { L.x = gesture.x0; L.y = gesture.y0; }
    const [a, b] = [...pointers.values()];
    gesture = { kind: 'zoom', d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, v0: { ...view } };
    draw();
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
  if (gesture && gesture.kind === 'pan') {
    view = { ...view, ox: gesture.ox + p.x - gesture.x, oy: gesture.oy + p.y - gesture.y, zoomed: true };
    draw();
    return;
  }
  if (gesture && gesture.kind === 'zoom') {
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const g = gesture, v0 = g.v0;
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const scale = Math.min(v0.fitScale * 12, Math.max(v0.fitScale * 0.5, (v0.scale * d) / g.d));
      const k = scale / v0.scale;
      view = { ...v0, scale, ox: mx - (g.mx - v0.ox) * k, oy: my - (g.my - v0.oy) * k, zoomed: true };
      draw();
    }
    return;
  }
  const L = sel();
  if (!gesture || !L) return;
  if (gesture.kind === 'move') {
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
  $('#stage').classList.remove('panning');
  if (!g || g.kind === 'pan') return;
  if (g.moved) commit();
  else if (g.kind === 'move') {
    const L = sel();
    if (L && L.type === 'text' && g.wasSelected) editText(L);
    if (L && L.type === 'photo' && L.faces && L.faces.length > 1) {
      // Tapping a face picks who to edit.
      const q = screenToImg(L, g.start.x, g.start.y);
      const f = faceAt(L.faces, q.x, q.y);
      if (f && f.id !== L.selFace) chooseFace(L, f.id);
    }
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
// Retouch: the brush screen returns a new picture; it replaces the photo as one undo step.
async function doRetouch(toolId) {
  const L = sel();
  if (!L || L.type !== 'photo') return;
  const faces = await ensureFaces(L, 'soft');
  const res = await openBrush('retouch', L, toolId, faces.length ? selFace(L) : null);
  fit(); draw();
  if (res && res.img !== L.img) { L.img = res.img; commit(); draw(); }
}
// Patch: copy a round area onto another spot. Returns a new picture (one undo step).
async function doPatch() {
  const L = sel();
  if (!L || L.type !== 'photo') return;
  const res = await openBrush('patch', L);
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
      </div>
      <div class="panel-sub">Retouch</div>
      ${faceChooser(L)}
      <div class="tools">
        <button class="tool" data-tool="shape">${icon('reshape')}Face Shape</button>
        <button class="tool" data-tool="patch">${icon('patch')}Patch</button>
        <button class="tool" data-tool="brows">${icon('brow')}Eyebrows</button>
        ${RETOUCH_TOOLS.map(t => `<button class="tool" data-retouch="${t.id}">${icon(t.icon)}${t.name}</button>`).join('')}
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
  panel.querySelectorAll('[data-retouch]').forEach(b => (b.onclick = () => doRetouch(b.dataset.retouch)));
  wireFaceChooser(panel, L);
}

// "Face 1 / Face 2 …" row, shown when a photo has more than one face.
function faceChooser(L) {
  if (!L.faces || L.faces.length < 2) return '';
  return `<div class="chips face-chips">${L.faces.map((f, n) => `<button class="chip-btn${f.id === L.selFace ? ' on' : ''}" data-face="${f.id}">Face ${n + 1}</button>`).join('')}</div>
    <p class="panel-note">Edits only change the selected face. Tap a face on the photo to switch.</p>`;
}
function wireFaceChooser(panel, L) {
  panel.querySelectorAll('[data-face]').forEach(b => (b.onclick = () => chooseFace(L, b.dataset.face)));
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
  if (id === 'patch') return doPatch();
  if (id === 'crop') {
    const r = await openCrop(L);
    fit();
    if (r) { L.crop = r.crop; commit(); }
    draw(); buildPanel();
    return;
  }
  if (id === 'enhance') { L.enhance = !L.enhance; commit(); draw(); buildPanel(); toast(L.enhance ? 'Enhanced' : 'Enhance off'); return; }
  if (id === 'blur' && !(await ensureSubject(L))) return;
  if (id === 'shape') {
    const faces = await ensureFaces(L);
    if (!faces.length) { toast('No face was found in this photo.'); return; }
  }
  if (id === 'brows') {
    const faces = await ensureFaces(L);
    if (!faces.length) { toast('No face was found in this photo.'); return; }
    // The person's own brow colour, worked out once per face.
    L.browColor = { ...(L.browColor || {}) };
    for (const f of faces) if (!L.browColor[f.id]) L.browColor[f.id] = matchColor(L.img, f);
  }
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
  const titles = Object.fromEntries([...PHOTO_TOOLS, ...TEXT_TOOLS, ['brows', 'Eyebrows'], ['shape', 'Face Shape']].map(([id, n]) => [id, n]));
  panel.innerHTML = header(titles[tool] || '');
  panel.querySelector('[data-back]').onclick = () => { tool = null; picking = null; $('#pickHint').hidden = true; buildPanel(); draw(); };
  const add = el => panel.appendChild(el);
  const note = t => { const p = document.createElement('p'); p.className = 'panel-note'; p.textContent = t; add(p); };

  if (tool === 'brows') return browsPanel(panel, L, add, note);
  if (tool === 'shape') return shapePanel(panel, L, add, note);
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

// ---------------- Eyebrows panel ----------------
const BROW_COLORS = ['#1F1A17', '#3A2A21', '#5A4031', '#7B5B42', '#A8875F', '#6F3A28', '#6A6560', '#7C6B62'];

// The photo with the original brows filled in with skin, made once per photo (for reshaping styles).
async function ensureNoBrows(L) {
  if (L.noBrows && L.noBrowsFor === L.img._id) return true;
  try {
    busy('Preparing eyebrow styles…');
    await nextFrame();
    const img = L.img;
    const out = removeBrows(img, L.faces);
    for (const l of [L, ...hist.stack.flatMap(st => st.layers)]) {
      if (l.id === L.id && l.img === img) { l.noBrows = out; l.noBrowsFor = img._id; }
    }
    busy(false);
    return true;
  } catch (err) {
    showError('The eyebrow styles could not be prepared. Please try again.', err);
    return false;
  }
}

// A small picture of the selected person's brows with a style applied.
function browThumb(L, face, params, W = 132, H = 66) {
  const sh = naturalShapes(face);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s2 of sh) for (const q of s2.outline) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  let w = (x1 - x0) * 1.25, h = Math.max((y1 - y0) * 3, w * H / W);
  w = h * W / H;
  const crop = { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h * 0.45 };
  const s = W / w;
  const c = makeCanvas(W, H);
  const cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(L.img, crop.x, crop.y, w, h, 0, 0, W, H);
  if (params) drawBrows(c, L, face, { ...params, intensity: 1 }, crop, s);
  return c;
}

function browsPanel(panel, L, add, note) {
  const face = selFace(L);
  if (!face) { note('No face found.'); return; }
  const cur = () => (L.brows && L.brows[face.id]) || null;
  const setP = patch => {
    L.brows = { ...(L.brows || {}) };
    L.brows[face.id] = { ...(cur() || { ...DEFAULT_BROWS, style: 'custom', intensity: 0.8 }), ...patch };
  };
  const wrap = document.createElement('div');
  wrap.innerHTML = faceChooser(L);
  add(wrap);
  wireFaceChooser(wrap, L);

  // One-tap fix.
  const fix = document.createElement('button');
  fix.className = 'big-btn wide';
  fix.innerHTML = icon('sparkle') + 'Auto Fix Brows';
  fix.onclick = () => { setP({ ...DEFAULT_BROWS, ...AUTO_FIX, intensity: cur() ? cur().intensity : 0.8, color: cur() ? cur().color : null }); commit(); draw(); buildPanel(); };
  add(fix);

  if (cur()) add(slider('Strength', 0, 100, () => Math.round(cur().intensity * 100), v => setP({ intensity: v / 100 }), '%'));

  // Style gallery: previews on this person's own face.
  const head = document.createElement('div');
  head.className = 'panel-note';
  head.style.margin = '12px 0 6px';
  head.textContent = 'Styles';
  add(head);
  const grid = document.createElement('div');
  grid.className = 'brow-grid';
  const curStyle = cur() ? cur().style : 'none';
  const items = [{ id: 'none', name: 'None' }, ...BROW_STYLES];
  for (const st of items) {
    const b = document.createElement('button');
    b.className = 'brow-item' + (curStyle === st.id ? ' on' : '');
    b.dataset.style = st.id;
    const params = st.id === 'none' ? null : styleParams(st.id, cur() || {});
    try { b.appendChild(browThumb(L, face, params)); } catch (e) { console.warn(e); }
    b.appendChild(document.createTextNode(st.name));
    b.onclick = async () => {
      if (st.id === 'none') { delete L.brows[face.id]; commit(); draw(); buildPanel(); return; }
      if (params.clear > 0 && !(await ensureNoBrows(L))) return;
      setP(styleParams(st.id, cur() || {}));
      commit(); draw(); buildPanel();
    };
    grid.appendChild(b);
  }
  add(grid);

  // Colour: matched to the person's own brows, or a swatch.
  const colHead = document.createElement('div');
  colHead.className = 'panel-note';
  colHead.style.margin = '12px 0 4px';
  colHead.textContent = 'Colour';
  add(colHead);
  const sw = document.createElement('div');
  sw.className = 'swatches';
  const curCol = cur() ? cur().color : null;
  sw.innerHTML = `<button class="chip-btn${!curCol ? ' on' : ''}" data-col="">Match</button>` +
    BROW_COLORS.map(c => `<button class="swatch${curCol === c ? ' on' : ''}" data-col="${c}" style="background:${c}" aria-label="Brow colour"></button>`).join('');
  sw.querySelectorAll('[data-col]').forEach(b => (b.onclick = () => { setP({ color: b.dataset.col || null }); commit(); draw(); buildPanel(); }));
  add(sw);

  // Fine-tuning. Each slider changes the brows live; letting go saves an undo step.
  const num = (k, mul = 100) => () => Math.round(((cur() || DEFAULT_BROWS)[k]) * mul);
  const put = (k, mul = 100) => v => setP({ [k]: v / mul });
  add(slider('Thickness', 50, 160, num('thick'), put('thick'), '%'));
  add(slider('Arch height', -100, 100, num('arch'), put('arch')));
  add(slider('Length', 80, 125, num('length'), put('length'), '%'));
  add(slider('Density', 0, 100, num('density'), put('density')));
  add(slider('Darkness', 0, 100, num('darkness'), put('darkness')));
  add(slider('Definition', 0, 100, num('definition'), put('definition')));
  add(slider('Symmetry', 0, 100, num('symmetry'), put('symmetry')));
  add(slider('Hair texture', 0, 100, num('texture'), put('texture')));
  add(switchRow('Match natural brows', () => (cur() || DEFAULT_BROWS).match, v => setP({ match: v })));

  // Before/after (hold) and reset.
  const row = document.createElement('div');
  row.className = 'row-btns';
  row.innerHTML = `<button class="chip-btn" data-before>Hold to see before</button><button class="chip-btn" data-reset>Reset brows</button>`;
  const before = row.querySelector('[data-before]');
  const on = e => { e.preventDefault(); L.browsOff = true; draw(); };
  const off = () => { if (L.browsOff) { delete L.browsOff; draw(); } };
  before.addEventListener('pointerdown', on);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => before.addEventListener(ev, off));
  row.querySelector('[data-reset]').onclick = () => {
    if (L.brows && L.brows[face.id]) { L.brows = { ...L.brows }; delete L.brows[face.id]; commit(); draw(); buildPanel(); }
  };
  add(row);
}

// ---------------- Face Shape panel ----------------
function shapePanel(panel, L, add, note) {
  const face = selFace(L);
  if (!face) { note('No face found.'); return; }
  const cur = () => (L.shape && L.shape[face.id]) || {};
  const setV = (k, val) => {
    L.shape = { ...(L.shape || {}) };
    L.shape[face.id] = { ...cur(), [k]: val };
  };
  const wrap = document.createElement('div');
  wrap.innerHTML = faceChooser(L);
  add(wrap);
  wireFaceChooser(wrap, L);
  note('Each slider reshapes the whole area smoothly and evenly on both sides. Small amounts look most natural.');
  for (const sl of SHAPE_SLIDERS) add(slider(sl.name, sl.min, sl.max, () => cur()[sl.id] || 0, v => setV(sl.id, v)));
  const row = document.createElement('div');
  row.className = 'row-btns';
  row.innerHTML = `<button class="chip-btn" data-before>Hold to see before</button><button class="chip-btn" data-reset>Reset face shape</button>`;
  const before = row.querySelector('[data-before]');
  const on = e => { e.preventDefault(); L.shapeOff = true; draw(); };
  const off = () => { if (L.shapeOff) { delete L.shapeOff; draw(); } };
  before.addEventListener('pointerdown', on);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => before.addEventListener(ev, off));
  row.querySelector('[data-reset]').onclick = () => {
    if (L.shape && hasShape(L.shape[face.id])) { L.shape = { ...L.shape }; delete L.shape[face.id]; commit(); draw(); buildPanel(); }
  };
  add(row);
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
  const c = renderProject(P, { background: null });
  const blob = await canvasToBlob(c, 'image/png');
  busy(false);
  const name = `photo-studio-${new Date().toISOString().slice(0, 10)}.png`;
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
  ensureFaces(L, 'quiet');
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
  $('#fitBtn').onclick = () => { fit(); draw(); };
  st.addEventListener('wheel', onWheel, { passive: false });
  st.addEventListener('contextmenu', e => e.preventDefault());
  $$('#editorZoom [data-zoom]').forEach(b => (b.onclick = () => {
    b.blur(); // so pressing Space afterwards doesn't press this button again
    if (b.dataset.zoom === 'move') { setMoveMode(!isMoveMode()); return; }
    const r = stageRect();
    zoomView(b.dataset.zoom === 'in' ? 1.5 : 1 / 1.5, r.width / 2, r.height / 2);
  }));
  window.addEventListener('keydown', e => {
    if (!P || !$('#editor').classList.contains('active') || isTyping(e.target)) return;
    const r = stageRect();
    if (e.key === ' ') { spaceDown = true; e.preventDefault(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); }
    else if (e.key.startsWith('Arrow') && !sel()) {
      e.preventDefault();
      const st = 60, dx = e.key === 'ArrowLeft' ? st : e.key === 'ArrowRight' ? -st : 0, dy = e.key === 'ArrowUp' ? st : e.key === 'ArrowDown' ? -st : 0;
      view = { ...view, ox: view.ox + dx, oy: view.oy + dy, zoomed: true };
      draw();
    }
    else if (e.key === '+' || e.key === '=') zoomView(1.5, r.width / 2, r.height / 2);
    else if (e.key === '-' || e.key === '_') zoomView(1 / 1.5, r.width / 2, r.height / 2);
    else if (e.key === '0') { fit(); draw(); }
  });
  window.addEventListener('keyup', e => { if (e.key === ' ') { spaceDown = false; e.preventDefault(); } });
  $('#fitBtn').addEventListener('click', e => e.currentTarget.blur());
  $('#downloadBtn').onclick = download;
  $('#shareBtn').onclick = share;
  window.addEventListener('resize', () => { if (P) { fit(); draw(); } });
  fillIcons();
}

// True only while typing text (a slider having the focus must not block the zoom keys).
function isTyping(el) {
  if (!el || !el.tagName) return false;
  if (/textarea|select/i.test(el.tagName) || el.isContentEditable) return true;
  return /input/i.test(el.tagName) && !/range|checkbox|radio|button/i.test(el.type);
}

// Is this wheel event from a mouse wheel (big, whole steps) rather than a trackpad scroll?
function isMouseWheel(e) {
  if (e.deltaMode === 1 || e.deltaMode === 2) return true;
  return e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY);
}
