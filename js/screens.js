// Full-screen text typing and the crop screen.
import { $, $$, makeCanvas, ctx2d } from './util.js';
import { FONTS, fontCss } from './render.js';

export const COLORS = ['#FFFFFF', '#1F1F1F', '#E5484D', '#F5A524', '#F7D44C', '#3DB46D', '#2F9BD8', '#6C5CE7', '#E85AAD', '#8B5E3C'];

function showScreen(id, on) {
  $('#' + id).classList.toggle('active', on);
  $('#editor').classList.toggle('active', !on);
}

// ---------------- Text ----------------
let T = null;
export function openText(start) {
  return new Promise(resolve => {
    T = { resolve, font: start.font || 'sans', color: start.color || '#FFFFFF', align: start.align || 'center' };
    $('#textInput').value = start.text || '';
    refreshText();
    showScreen('textScreen', true);
    setTimeout(() => $('#textInput').focus(), 50);
  });
}
function refreshText() {
  const ta = $('#textInput');
  ta.style.font = fontCss(T.font, 34);
  ta.style.color = T.color;
  ta.style.textAlign = T.align;
  ta.style.textShadow = T.color.toUpperCase() === '#FFFFFF' ? 'none' : '0 0 1px rgba(255,255,255,.4)';
  $$('#fontRow .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.font === T.font));
  $$('#textColors .swatch').forEach(b => b.classList.toggle('on', b.dataset.color === T.color));
  $$('#alignBtns button').forEach(b => b.classList.toggle('on', b.dataset.align === T.align));
}
function closeText(ok) {
  const r = T.resolve;
  const val = { text: $('#textInput').value.replace(/\s+$/, ''), font: T.font, color: T.color, align: T.align };
  T = null;
  $('#textInput').blur();
  showScreen('textScreen', false);
  r(ok && val.text.trim() ? val : null);
}

// ---------------- Crop ----------------
const RATIOS = [
  { id: 'free', name: 'Free', r: 0 },
  { id: 'orig', name: 'Original', r: -1 },
  { id: '1:1', name: 'Square', r: 1 },
  { id: '4:5', name: '4:5', r: 4 / 5 },
  { id: '9:16', name: '9:16', r: 9 / 16 },
  { id: '16:9', name: '16:9', r: 16 / 9 },
];
let C = null;
export function openCrop(layer) {
  return new Promise(resolve => {
    const img = layer.img;
    // Show the photo as it looks now (with its cut-out), without the old crop.
    const pic = makeCanvas(img.width, img.height);
    const pc = ctx2d(pic);
    pc.drawImage(img, 0, 0);
    if (layer.mask) { pc.globalCompositeOperation = 'destination-in'; pc.drawImage(layer.mask, 0, 0); }
    C = { resolve, pic, rect: { ...(layer.crop || { x: 0, y: 0, w: img.width, h: img.height }) }, ratio: 'free', drag: null };
    showScreen('cropScreen', true);
    refreshRatios();
    drawCrop();
  });
}
function refreshRatios() {
  $$('#cropRatios .chip-btn').forEach(b => b.classList.toggle('on', b.dataset.ratio === C.ratio));
}
function cropView() {
  const r = $('#cropStage').getBoundingClientRect();
  const s = Math.min((r.width - 48) / C.pic.width, (r.height - 48) / C.pic.height);
  return { w: r.width, h: r.height, s, ox: (r.width - C.pic.width * s) / 2, oy: (r.height - C.pic.height * s) / 2 };
}
function drawCrop() {
  if (!C) return;
  const cv = $('#cropView');
  const v = cropView();
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(v.w * dpr); cv.height = Math.round(v.h * dpr);
  const cx = cv.getContext('2d');
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.drawImage(C.pic, v.ox, v.oy, C.pic.width * v.s, C.pic.height * v.s);
  const R = C.rect;
  const x = v.ox + R.x * v.s, y = v.oy + R.y * v.s, w = R.w * v.s, h = R.h * v.s;
  cx.fillStyle = 'rgba(0,0,0,.55)';
  cx.beginPath();
  cx.rect(0, 0, v.w, v.h);
  cx.rect(x, y, w, h);
  cx.fill('evenodd');
  cx.strokeStyle = '#fff'; cx.lineWidth = 2;
  cx.strokeRect(x, y, w, h);
  cx.lineWidth = 1; cx.strokeStyle = 'rgba(255,255,255,.5)';
  for (let i = 1; i < 3; i++) {
    cx.beginPath(); cx.moveTo(x + (w * i) / 3, y); cx.lineTo(x + (w * i) / 3, y + h); cx.stroke();
    cx.beginPath(); cx.moveTo(x, y + (h * i) / 3); cx.lineTo(x + w, y + (h * i) / 3); cx.stroke();
  }
  cx.fillStyle = '#fff';
  for (const [hx, hy] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
    cx.beginPath(); cx.arc(hx, hy, 9, 0, Math.PI * 2); cx.fill();
  }
}
function applyRatio(id) {
  C.ratio = id;
  const def = RATIOS.find(r => r.id === id);
  const W = C.pic.width, H = C.pic.height;
  let r = def.r === -1 ? W / H : def.r;
  if (r > 0) {
    let w = W, h = w / r;
    if (h > H) { h = H; w = h * r; }
    C.rect = { x: (W - w) / 2, y: (H - h) / 2, w, h };
  }
  refreshRatios();
  drawCrop();
}
function ratioValue() {
  const def = RATIOS.find(r => r.id === C.ratio);
  return def.r === -1 ? C.pic.width / C.pic.height : def.r;
}
function cropDown(e) {
  if (!C) return;
  e.preventDefault();
  $('#cropStage').setPointerCapture(e.pointerId);
  const v = cropView();
  const b = $('#cropStage').getBoundingClientRect();
  const px = (e.clientX - b.left - v.ox) / v.s, py = (e.clientY - b.top - v.oy) / v.s;
  const R = C.rect;
  const near = 28 / v.s;
  const corners = [['tl', R.x, R.y], ['tr', R.x + R.w, R.y], ['bl', R.x, R.y + R.h], ['br', R.x + R.w, R.y + R.h]];
  const hit = corners.find(([, cx, cy]) => Math.hypot(px - cx, py - cy) < near);
  C.drag = { kind: hit ? hit[0] : 'move', px, py, start: { ...R } };
}
function cropMove(e) {
  if (!C || !C.drag) return;
  const v = cropView();
  const b = $('#cropStage').getBoundingClientRect();
  const px = (e.clientX - b.left - v.ox) / v.s, py = (e.clientY - b.top - v.oy) / v.s;
  const W = C.pic.width, H = C.pic.height, min = Math.max(20, Math.min(W, H) * 0.05);
  const d = C.drag, s = d.start;
  const dx = px - d.px, dy = py - d.py;
  if (d.kind === 'move') {
    C.rect = { ...s, x: Math.min(W - s.w, Math.max(0, s.x + dx)), y: Math.min(H - s.h, Math.max(0, s.y + dy)) };
  } else {
    // The opposite corner stays still.
    const fx = d.kind.includes('l') ? s.x + s.w : s.x;
    const fy = d.kind.includes('t') ? s.y + s.h : s.y;
    let mx = Math.min(W, Math.max(0, px)), my = Math.min(H, Math.max(0, py));
    let w = Math.max(min, Math.abs(mx - fx)), h = Math.max(min, Math.abs(my - fy));
    const r = ratioValue();
    if (r > 0) { if (w / h > r) w = h * r; else h = w / r; }
    let x = d.kind.includes('l') ? fx - w : fx;
    let y = d.kind.includes('t') ? fy - h : fy;
    if (x < 0 || y < 0 || x + w > W || y + h > H) return;
    C.rect = { x, y, w, h };
  }
  drawCrop();
}
function closeCrop(ok) {
  const r = C.resolve;
  const R = C.rect;
  const full = R.x <= 0.5 && R.y <= 0.5 && Math.abs(R.w - C.pic.width) < 1 && Math.abs(R.h - C.pic.height) < 1;
  const rect = full ? null : { x: Math.round(R.x), y: Math.round(R.y), w: Math.round(R.w), h: Math.round(R.h) };
  C = null;
  showScreen('cropScreen', false);
  r(ok ? { crop: rect } : null);
}

export function initScreens() {
  $('#fontRow').innerHTML = FONTS.map(f => `<button class="chip-btn" data-font="${f.id}" style="font:${fontCss(f.id, 16)}">${f.name}</button>`).join('');
  $('#textColors').innerHTML = COLORS.map(c => `<button class="swatch" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('');
  $$('#fontRow .chip-btn').forEach(b => (b.onclick = () => { T.font = b.dataset.font; refreshText(); }));
  $$('#textColors .swatch').forEach(b => (b.onclick = () => { T.color = b.dataset.color; refreshText(); }));
  $$('#alignBtns button').forEach(b => (b.onclick = () => { T.align = b.dataset.align; refreshText(); }));
  $('#textDone').onclick = () => T && closeText(true);
  $('#textCancel').onclick = () => T && closeText(false);

  $('#cropRatios').innerHTML = RATIOS.map(r => `<button class="chip-btn" data-ratio="${r.id}">${r.name}</button>`).join('');
  $$('#cropRatios .chip-btn').forEach(b => (b.onclick = () => applyRatio(b.dataset.ratio)));
  const st = $('#cropStage');
  st.addEventListener('pointerdown', cropDown);
  st.addEventListener('pointermove', cropMove);
  st.addEventListener('pointerup', () => C && (C.drag = null));
  st.addEventListener('pointercancel', () => C && (C.drag = null));
  $('#cropDone').onclick = () => C && closeCrop(true);
  $('#cropCancel').onclick = () => C && closeCrop(false);
  window.addEventListener('resize', drawCrop);
}
