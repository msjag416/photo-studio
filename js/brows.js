// Eyebrows: shape them from the face points, then draw them as a soft powder base plus
// hundreds of fine hairs that follow the brow's direction. Nothing here changes the photo itself:
// brows are stored as settings per face and drawn fresh every time (see render.js).
// For styles with a different shape, the original brows are first removed by filling them in with
// the surrounding skin (that picture is made once and kept as layer.noBrows).
import { makeCanvas, ctx2d, blurCanvas } from './util.js';
import { BROWS, pt } from './faces.js';

// Settings for one face's brows. All numbers are 0..1 unless noted.
export const DEFAULT_BROWS = {
  style: 'none', intensity: 0.7,
  thick: 1,          // thickness, 0.5..1.6 times the natural brow
  arch: 0,           // -1 (flatter) .. 1 (higher arch)
  length: 1,         // 0.8..1.25 times the natural length
  density: 0.5, darkness: 0.3, definition: 0.5, symmetry: 0, texture: 0.5,
  color: null,       // null = matched to the person's own brow colour
  match: true,       // keep a little of the natural difference between the two brows
  clear: 0,          // how much of the original brow is removed first
  peak: 0.62, sharp: 0.5, lift: 0, // arch position, arch sharpness, hair direction (upward brushing)
};

export const BROW_STYLES = [
  { id: 'natural', name: 'Natural', p: { density: 0.45, darkness: 0.2, definition: 0.35 } },
  { id: 'softarch', name: 'Soft Arch', p: { arch: 0.45, clear: 0.6, density: 0.55, definition: 0.5, sharp: 0.3 } },
  { id: 'higharch', name: 'High Arch', p: { arch: 1, clear: 1, density: 0.6, definition: 0.65, sharp: 0.85, peak: 0.6 } },
  { id: 'straight', name: 'Straight', p: { arch: -0.9, clear: 1, density: 0.6, thick: 1.1, definition: 0.55 } },
  { id: 'rounded', name: 'Rounded', p: { arch: 0.5, clear: 0.8, sharp: 0, peak: 0.5, density: 0.55 } },
  { id: 'thickfull', name: 'Thick and Full', p: { thick: 1.45, density: 0.85, darkness: 0.4, definition: 0.45 } },
  { id: 'thin', name: 'Thin and Defined', p: { thick: 0.6, clear: 1, density: 0.7, darkness: 0.45, definition: 0.9, sharp: 0.6 } },
  { id: 'feathered', name: 'Feathered', p: { thick: 1.15, density: 0.65, definition: 0.3, lift: 0.6, texture: 0.75 } },
  { id: 'laminated', name: 'Laminated', p: { thick: 1.25, density: 0.75, lift: 1, texture: 0.8, clear: 0.3, definition: 0.6 } },
  { id: 'softglam', name: 'Soft Glam', p: { thick: 1.1, arch: 0.3, density: 0.6, darkness: 0.45, definition: 0.6, clear: 0.3 } },
  { id: 'bold', name: 'Bold and Sculpted', p: { thick: 1.3, arch: 0.55, density: 0.85, darkness: 0.75, definition: 1, sharp: 0.7, clear: 0.5 } },
];

// One-tap fix: even out the two sides, fill sparse spots, a little more definition, tidy tails.
export const AUTO_FIX = { style: 'auto', symmetry: 0.75, match: true, density: 0.65, thick: 1.06, darkness: 0.3, definition: 0.6 };

export function styleParams(id, keep = {}) {
  const s = BROW_STYLES.find(x => x.id === id);
  return { ...DEFAULT_BROWS, ...(s ? s.p : {}), style: id, color: keep.color ?? null, intensity: keep.intensity ?? 0.8 };
}

// ---------- Shape ----------
// The natural brow of one side in the eye's own frame: s = along the eye line (outward),
// t = upward, T = thickness; measured from the inner end of the brow.
function natural(face, side) {
  const B = BROWS[side];
  const ein = pt(face, B.eyeIn), eout = pt(face, B.eyeOut);
  let ex = { x: eout.x - ein.x, y: eout.y - ein.y };
  const el = Math.hypot(ex.x, ex.y) || 1;
  ex = { x: ex.x / el, y: ex.y / el };
  let n = { x: ex.y, y: -ex.x };
  const c0 = mid(pt(face, B.upper[0]), pt(face, B.lower[0]));
  const eyeMid = mid(ein, eout);
  if ((c0.x - eyeMid.x) * n.x + (c0.y - eyeMid.y) * n.y < 0) n = { x: -n.x, y: -n.y };
  const s = [], t = [], T = [];
  for (let i = 0; i < 5; i++) {
    const u = pt(face, B.upper[i]), l = pt(face, B.lower[i]);
    const c = mid(u, l);
    s.push((c.x - c0.x) * ex.x + (c.y - c0.y) * ex.y);
    t.push((c.x - c0.x) * n.x + (c.y - c0.y) * n.y);
    T.push(Math.hypot(u.x - l.x, u.y - l.y));
  }
  return { c0, ex, n, s, t, T };
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Apply the settings to both brows; returns outlines and sample points in picture pixels.
export function browShapes(face, p) {
  const A = natural(face, 'a'), B = natural(face, 'b');
  const eyeGap = Math.hypot(pt(face, 33).x - pt(face, 263).x, pt(face, 33).y - pt(face, 263).y);
  const sym = p.symmetry * (p.match ? 0.75 : 1);
  return [A, B].map((N, k) => {
    const O = k ? A : B; // the other brow
    let s = N.s.map((v, i) => v + (((v + O.s[i]) / 2) - v) * sym);
    let t = N.t.map((v, i) => v + (((v + O.t[i]) / 2) - v) * sym);
    let T = N.T.map((v, i) => v + (((v + O.T[i]) / 2) - v) * sym);
    // Length (the inner end stays put).
    s = s.map(v => v * p.length);
    // Arch: raise (or flatten) the brow around the peak.
    if (p.arch >= 0) {
      t = t.map((v, i) => v + p.arch * eyeGap * 0.045 * bump(i / 4, p.peak, p.sharp));
    } else {
      t = t.map((v, i) => v + ((t[0] + (t[4] - t[0]) * (i / 4)) - v) * -p.arch);
    }
    T = T.map(v => v * p.thick);
    return buildShape(N, s, t, T, p);
  });
}

function bump(u, peak, sharp) {
  if (u <= peak) return Math.sin((u / peak) * Math.PI / 2);
  const d = (u - peak) / (1 - peak);
  return Math.pow(Math.cos(d * Math.PI / 2), 0.6 + sharp * 1.4);
}

// Smooth curve through the 5 centre points, with a thickness that tapers toward the tail.
function buildShape(N, s, t, T, p) {
  const toImg = (a, b) => ({ x: N.c0.x + N.ex.x * a + N.n.x * b, y: N.c0.y + N.ex.y * a + N.n.y * b });
  const C = s.map((v, i) => toImg(v, t[i]));
  const samples = [];
  const M = 40;
  for (let j = 0; j <= M; j++) {
    const u = j / M;
    const f = u * 4, i = Math.min(3, Math.floor(f)), q = f - i;
    const c = catmull(C[Math.max(0, i - 1)], C[i], C[i + 1], C[Math.min(4, i + 2)], q);
    const th = T[i] + (T[i + 1] - T[i]) * q;
    const taper = 1 - (0.55 + p.definition * 0.35) * smooth(0.6, 1, u); // pointed tail
    const head = 0.85 + 0.15 * smooth(0, 0.12, u);                      // slightly softer start
    samples.push({ u, c, w: Math.max(0.8, th * taper * head) });
  }
  // Directions along the curve and across it (pointing up, away from the eye).
  for (let j = 0; j <= M; j++) {
    const a = samples[Math.max(0, j - 1)].c, b = samples[Math.min(M, j + 1)].c;
    let tx = b.x - a.x, ty = b.y - a.y;
    const l = Math.hypot(tx, ty) || 1;
    tx /= l; ty /= l;
    let nx = ty, ny = -tx;
    if (nx * N.n.x + ny * N.n.y < 0) { nx = -nx; ny = -ny; }
    Object.assign(samples[j], { tx, ty, nx, ny });
  }
  const upper = samples.map(q => ({ x: q.c.x + q.nx * q.w / 2, y: q.c.y + q.ny * q.w / 2 }));
  const lower = samples.map(q => ({ x: q.c.x - q.nx * q.w / 2, y: q.c.y - q.ny * q.w / 2 }));
  const avgT = T.reduce((a, b) => a + b, 0) / 5;
  return { samples, outline: [...upper, ...lower.reverse()], avgT, up: N.n };
}

function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
  return { x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) };
}
const smooth = (a, b, x) => { const q = Math.min(1, Math.max(0, (x - a) / (b - a))); return q * q * (3 - 2 * q); };

// The original brows (no changes), used for removing them and for matching their colour.
export function naturalShapes(face) {
  return browShapes(face, { ...DEFAULT_BROWS, definition: 0 });
}

// ---------- Colour ----------
// The person's own brow colour: the average of the darker pixels inside their brows.
export function matchColor(img, face) {
  const vals = [];
  for (const sh of naturalShapes(face)) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const area = grow(sh, sh.avgT * 0.3);
    for (const o of area) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x); y1 = Math.max(y1, o.y); }
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    const w = Math.min(img.width, Math.ceil(x1)) - x0, h = Math.min(img.height, Math.ceil(y1)) - y0;
    if (w < 2 || h < 2) continue;
    const m = makeCanvas(w, h);
    const mc = ctx2d(m);
    mc.translate(-x0, -y0);
    mc.fillStyle = '#fff';
    fillPoly(mc, area);
    const md = mc.getImageData(0, 0, w, h).data;
    const d = ctx2d(img).getImageData(x0, y0, w, h).data;
    for (let i = 0; i < w * h; i++) if (md[i * 4 + 3] > 128) vals.push([d[i * 4], d[i * 4 + 1], d[i * 4 + 2], d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11]);
  }
  if (!vals.length) return '#4A3426';
  vals.sort((a, b) => a[3] - b[3]);
  const dark = vals.slice(0, Math.max(1, Math.round(vals.length * 0.15)));
  const avg = [0, 1, 2].map(k => dark.reduce((a, v) => a + v[k], 0) / dark.length);
  return '#' + avg.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

// ---------- Drawing ----------
// Draw one face's brows onto canvas c, which shows the picture area `crop` at scale s.
// base = the picture the brows sit on before the change (for removing the original brows).
export function drawBrows(c, L, face, p, crop, s) {
  if (!p || p.intensity <= 0) return;
  const shapes = browShapes(face, p);
  const orig = naturalShapes(face);
  // Work area around both brows (picture pixels).
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const sh of [...shapes, ...orig]) for (const q of sh.outline) {
    x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y);
  }
  const pad = Math.max(...shapes.map(q => q.avgT)) * 1.2 + 4;
  const R = { x: Math.floor(x0 - pad), y: Math.floor(y0 - pad), w: 0, h: 0 };
  R.w = Math.ceil(x1 + pad) - R.x; R.h = Math.ceil(y1 + pad) - R.y;
  const W = Math.max(1, Math.round(R.w * s)), H = Math.max(1, Math.round(R.h * s));
  const at = cx => cx.setTransform(s, 0, 0, s, -R.x * s, -R.y * s); // draw in picture pixels

  // 1. Start from what the photo looks like there now.
  const area = makeCanvas(W, H);
  const ac = ctx2d(area);
  ac.drawImage(c, (R.x - crop.x) * s, (R.y - crop.y) * s, W, H, 0, 0, W, H);

  // 2. Remove the original brows (using the picture made by the object-removal AI).
  if (p.clear > 0 && L.noBrows && L.noBrowsFor === L.img._id) {
    const m = makeCanvas(W, H);
    const mc = ctx2d(m);
    at(mc);
    mc.fillStyle = '#fff';
    for (const sh of orig) { fillPoly(mc, grow(sh, sh.avgT * 0.7 + 2, sh.avgT * 0.45 + 1.5)); }
    const soft = softMask(m, Math.max(1, Math.round(orig[0].avgT * 0.3 * s)));
    const nb = makeCanvas(W, H);
    const nc = ctx2d(nb);
    at(nc);
    nc.drawImage(L.noBrows, 0, 0);
    nc.setTransform(1, 0, 0, 1, 0, 0);
    nc.globalCompositeOperation = 'destination-in';
    nc.drawImage(soft, 0, 0);
    ac.globalAlpha = p.clear;
    ac.drawImage(nb, 0, 0);
    ac.globalAlpha = 1;
  }

  const col = darken(p.color || L.browColor?.[face.id] || '#4A3426', p.darkness);
  // 3. A soft powder base, multiplied in so the skin's own texture still shows. It fades in from
  // the end near the nose, like real brows, instead of starting as a hard block.
  const powder = makeCanvas(W, H);
  const pc = ctx2d(powder);
  at(pc);
  pc.fillStyle = col;
  for (const sh of shapes) {
    const S2 = sh.samples, up = grow(sh, 0);
    const n = S2.length;
    for (let j = 0; j < n - 1; j++) {
      pc.globalAlpha = fade(S2[j].u);
      pc.beginPath();
      pc.moveTo(up[j].x, up[j].y); pc.lineTo(up[j + 1].x, up[j + 1].y);
      pc.lineTo(up[2 * n - 2 - j].x, up[2 * n - 2 - j].y); pc.lineTo(up[2 * n - 1 - j].x, up[2 * n - 1 - j].y);
      pc.closePath(); pc.fill();
    }
  }
  pc.globalAlpha = 1;
  const soft = blurCanvas(powder, Math.max(0.8, shapes[0].avgT * (0.12 + 0.25 * (1 - p.definition)) * s));
  ac.globalCompositeOperation = 'multiply';
  ac.globalAlpha = 0.1 + 0.32 * p.density;
  ac.drawImage(soft, 0, 0);
  ac.globalAlpha = 1;
  ac.globalCompositeOperation = 'source-over';

  // 4. Fine hairs, always placed the same way for the same face (seeded random numbers).
  at(ac);
  shapes.forEach((sh, k) => drawHairs(ac, sh, p, col, rng(hash(face.id) + k * 7919)));
  ac.setTransform(1, 0, 0, 1, 0, 0);

  // 5. Put the area back, at the chosen strength.
  const cc = ctx2d(c);
  cc.save();
  cc.globalAlpha = p.intensity;
  cc.drawImage(area, (R.x - crop.x) * s, (R.y - crop.y) * s);
  cc.restore();
}

function drawHairs(cx, sh, p, col, rand) {
  const S = sh.samples;
  // Rough area of the brow, to decide how many hairs it needs.
  let len = 0;
  for (let j = 1; j < S.length; j++) len += Math.hypot(S[j].c.x - S[j - 1].c.x, S[j].c.y - S[j - 1].c.y);
  const spacing = Math.max(0.5, sh.avgT * 0.1);
  const count = Math.min(1600, Math.round((len * sh.avgT) / (spacing * spacing) * (0.25 + 0.75 * p.density)));
  const [r0, g0, b0] = hex(col);
  cx.save();
  // Crisp outline for high definition, a softer, slightly wider one for low definition.
  cx.beginPath();
  poly(cx, grow(sh, sh.avgT * 0.18 * (1 - p.definition)));
  cx.clip();
  cx.lineCap = 'round';
  const wBase = Math.max(0.3, sh.avgT * 0.035) * (0.8 + p.texture * 0.4);
  for (let h = 0; h < count; h++) {
    const u = Math.pow(rand(), 0.9);
    const j = Math.min(S.length - 1, Math.round(u * (S.length - 1)));
    const q = S[j];
    const v = (rand() + rand() - 1); // more hairs near the middle line
    const bx = q.c.x + q.nx * v * q.w / 2, by = q.c.y + q.ny * v * q.w / 2;
    // Hair direction: up near the nose, along the brow toward the tail; lifted when brushed up.
    const along = smooth(0.1, 0.5, u);
    let ang = (1 - along) * 0.95 + along * 0.3;                   // radians away from the brow line
    ang += p.lift * (1.2 - ang) * 0.85;                            // brushed-up styles
    ang += -v * 0.3 + (rand() - 0.5) * 0.5;                        // hairs lean toward the middle, varied
    const dx = q.tx * Math.cos(ang) + q.nx * Math.sin(ang), dy = q.ty * Math.cos(ang) + q.ny * Math.sin(ang);
    const L = q.w * (0.3 + rand() * 0.35) * (0.8 + p.texture * 0.5) * (1 + p.lift * 0.3);
    const bend = (rand() - 0.3) * L * 0.25 * (0.5 + p.texture);
    const ex = bx + dx * L, ey = by + dy * L;
    const mx = (bx + ex) / 2 + q.tx * bend, my = (by + ey) / 2 + q.ty * bend;
    const j2 = 0.82 + rand() * 0.36;
    const a = (0.15 + rand() * 0.5) * (0.55 + p.definition * 0.45) * (0.35 + 0.65 * fade(u));
    cx.strokeStyle = `rgba(${Math.round(r0 * j2)},${Math.round(g0 * j2)},${Math.round(b0 * j2)},${a})`;
    cx.lineWidth = wBase * (0.7 + rand() * 0.6);
    cx.beginPath();
    cx.moveTo(bx, by);
    cx.quadraticCurveTo(mx, my, ex, ey);
    cx.stroke();
  }
  cx.restore();
}

// How strong the brow is along its length: fades in near the nose, a little lighter at the tail.
const fade = u => (0.3 + 0.7 * smooth(0, 0.28, u)) * (1 - 0.25 * smooth(0.85, 1, u));

// Outline grown outward by d picture pixels (from the centre line); dDown for the eye side if given.
function grow(sh, d, dDown = d) {
  const up = sh.samples.map(q => ({ x: q.c.x + q.nx * (q.w / 2 + d), y: q.c.y + q.ny * (q.w / 2 + d) }));
  const lo = sh.samples.map(q => ({ x: q.c.x - q.nx * (q.w / 2 + dDown), y: q.c.y - q.ny * (q.w / 2 + dDown) }));
  return [...up, ...lo.reverse()];
}
function poly(cx, pts) { pts.forEach((q, i) => (i ? cx.lineTo(q.x, q.y) : cx.moveTo(q.x, q.y))); cx.closePath(); }
function fillPoly(cx, pts) { cx.beginPath(); poly(cx, pts); cx.fill(); }

// The photo with the original brows removed: each brow area is filled from the skin around it
// ("push-pull" fill: average the known pixels at smaller and smaller sizes, then fill the holes
// back in from those averages), then given a little skin grain so it isn't too smooth.
export function removeBrows(img, faces) {
  const out = makeCanvas(img.width, img.height);
  const oc = ctx2d(out);
  oc.drawImage(img, 0, 0);
  for (const f of faces) {
    const sh = naturalShapes(f);
    const T = Math.max(...sh.map(q => q.avgT));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of sh) for (const o of q.outline) { x0 = Math.min(x0, o.x); y0 = Math.min(y0, o.y); x1 = Math.max(x1, o.x); y1 = Math.max(y1, o.y); }
    const pad = T * 3 + 8;
    const R = { x: Math.max(0, Math.floor(x0 - pad)), y: Math.max(0, Math.floor(y0 - pad)) };
    R.w = Math.min(img.width, Math.ceil(x1 + pad)) - R.x; R.h = Math.min(img.height, Math.ceil(y1 + pad)) - R.y;
    if (R.w < 4 || R.h < 4) continue;
    // Hole mask: the brows, grown a little, with soft edges.
    const m = makeCanvas(R.w, R.h);
    const mc = ctx2d(m);
    mc.translate(-R.x, -R.y);
    mc.fillStyle = '#fff';
    for (const q of sh) fillPoly(mc, grow(q, q.avgT * 0.7 + 2, q.avgT * 0.45 + 1.5));
    const hole = ctx2d(softMask(m, Math.max(1, Math.round(T * 0.3)))).getImageData(0, 0, R.w, R.h).data;
    const id = oc.getImageData(R.x, R.y, R.w, R.h);
    const d = id.data;
    const n = R.w * R.h;
    const wgt = new Float32Array(n), rgb = new Float32Array(n * 3);
    // Only blend in pixels that look like skin: anything much darker than the typical skin
    // around the brows (hair, lashes, the edge of the brow) is left out.
    const lum = i => d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11;
    const around = [];
    for (let i = 0; i < n; i++) if (hole[i * 4 + 3] < 5) around.push(lum(i));
    around.sort((a, b) => a - b);
    const skin = around.length ? around[Math.floor(around.length * 0.6)] : 128;
    // The person's skin colour, from the cheeks and the middle of the forehead.
    const ref = [0, 0, 0];
    let rn = 0;
    for (const k of [50, 280, 151]) {
      const q = pt(f, k);
      const px = ctx2d(img).getImageData(Math.max(0, Math.round(q.x) - 2), Math.max(0, Math.round(q.y) - 2), 5, 5).data;
      for (let j = 0; j < px.length; j += 4) { ref[0] += px[j]; ref[1] += px[j + 1]; ref[2] += px[j + 2]; rn++; }
    }
    for (let k = 0; k < 3; k++) ref[k] /= rn;
    for (let i = 0; i < n; i++) {
      const h = hole[i * 4 + 3] / 255;
      const dist = Math.hypot(d[i * 4] - ref[0], d[i * 4 + 1] - ref[1], d[i * 4 + 2] - ref[2]);
      const likeSkin = Math.min(1, Math.max(0, (lum(i) - (skin - 40)) / 20)) * Math.min(1, Math.max(0, 1 - (dist - 35) / 40));
      wgt[i] = h > 0.02 ? 0 : likeSkin;
      rgb[i * 3] = d[i * 4]; rgb[i * 3 + 1] = d[i * 4 + 1]; rgb[i * 3 + 2] = d[i * 4 + 2];
    }
    const fill = pushPull(rgb, wgt, R.w, R.h);
    // Skin grain: how much the skin around the brows varies from pixel to pixel.
    let sum = 0, cnt = 0;
    for (let y = 1; y < R.h - 1; y++) for (let x = 1; x < R.w - 1; x++) {
      const i = y * R.w + x;
      if (wgt[i] < 1 || wgt[i - 1] < 1 || wgt[i + 1] < 1) continue;
      const g = (d[i * 4 + 1] * 2 - d[(i - 1) * 4 + 1] - d[(i + 1) * 4 + 1]) / 2;
      sum += g * g; cnt++;
    }
    const grain = Math.min(10, Math.sqrt(sum / Math.max(1, cnt)));
    const rand = rng(hash(f.id) ^ 0x5bd1e995);
    for (let i = 0; i < n; i++) {
      const h = hole[i * 4 + 3] / 255;
      if (h <= 0) continue;
      const g = (rand() + rand() + rand() - 1.5) * grain;
      for (let k = 0; k < 3; k++) d[i * 4 + k] = d[i * 4 + k] * (1 - h) + (fill[i * 3 + k] + g) * h;
    }
    oc.putImageData(id, R.x, R.y);
  }
  return out;
}

// Soften the edge of a white-on-clear mask by exactly r pixels (two box blurs on the alpha).
// (The quick blur in util.js smears too far on small areas.)
function softMask(m, r) {
  const W = m.width, H = m.height;
  const c = ctx2d(m);
  const id = c.getImageData(0, 0, W, H);
  let a = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) a[i] = id.data[i * 4 + 3];
  const pass = (src, horiz) => {
    const out = new Float32Array(W * H);
    const len = horiz ? W : H, lines = horiz ? H : W;
    for (let l = 0; l < lines; l++) {
      const at = k => (horiz ? l * W + k : k * W + l);
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[at(Math.min(len - 1, Math.max(0, k)))];
      for (let k = 0; k < len; k++) {
        out[at(k)] = sum / (2 * r + 1);
        sum += src[at(Math.min(len - 1, k + r + 1))] - src[at(Math.max(0, k - r))];
      }
    }
    return out;
  };
  for (let n = 0; n < 2; n++) a = pass(pass(a, true), false);
  const out = makeCanvas(W, H);
  const oc = ctx2d(out);
  const od = oc.createImageData(W, H);
  for (let i = 0; i < W * H; i++) { od.data[i * 4] = od.data[i * 4 + 1] = od.data[i * 4 + 2] = 255; od.data[i * 4 + 3] = a[i]; }
  oc.putImageData(od, 0, 0);
  return out;
}

function pushPull(rgb, wgt, W, H) {
  if (W <= 1 && H <= 1) return rgb;
  const w2 = Math.max(1, Math.ceil(W / 2)), h2 = Math.max(1, Math.ceil(H / 2));
  const c = new Float32Array(w2 * h2 * 3), cw = new Float32Array(w2 * h2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = (y >> 1) * w2 + (x >> 1), w = wgt[i];
    cw[j] += w; c[j * 3] += rgb[i * 3] * w; c[j * 3 + 1] += rgb[i * 3 + 1] * w; c[j * 3 + 2] += rgb[i * 3 + 2] * w;
  }
  for (let j = 0; j < w2 * h2; j++) if (cw[j] > 0) { c[j * 3] /= cw[j]; c[j * 3 + 1] /= cw[j]; c[j * 3 + 2] /= cw[j]; cw[j] = Math.min(1, cw[j]); }
  const coarse = (W === w2 && H === h2) ? c : pushPull(c, cw, w2, h2);
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, w = wgt[i];
    // Smooth (bilinear) sample of the coarser level.
    const fx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(w2 - 1, x0 + 1), y1 = Math.min(h2 - 1, y0 + 1), ax = fx - x0, ay = fy - y0;
    for (let k = 0; k < 3; k++) {
      const v = (coarse[(y0 * w2 + x0) * 3 + k] * (1 - ax) + coarse[(y0 * w2 + x1) * 3 + k] * ax) * (1 - ay)
        + (coarse[(y1 * w2 + x0) * 3 + k] * (1 - ax) + coarse[(y1 * w2 + x1) * 3 + k] * ax) * ay;
      out[i * 3 + k] = rgb[i * 3 + k] * w + v * (1 - w);
    }
  }
  return out;
}

function hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function darken(h, d) { return '#' + hex(h).map(v => Math.round(v * (1 - d * 0.55)).toString(16).padStart(2, '0')).join(''); }
function hash(str) { let x = 2166136261; for (const ch of String(str)) x = Math.imul(x ^ ch.charCodeAt(0), 16777619); return x >>> 0; }
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
