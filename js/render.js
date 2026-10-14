// Draws layers and whole projects.
// A layer is first drawn on its own canvas with all its effects (colour, filter, cut-out,
// corners, outline). Then it is placed on the main canvas (position, size, turn, shadow).
import { makeCanvas, ctx2d, blurCanvas } from './util.js';
import { drawBrows } from './brows.js';

export const FILTERS = [
  { id: 'none', name: 'Original' },
  { id: 'vivid', name: 'Vivid' },
  { id: 'warm', name: 'Golden' },
  { id: 'cool', name: 'Breeze' },
  { id: 'fade', name: 'Faded' },
  { id: 'mono', name: 'Mono' },
  { id: 'noir', name: 'Noir' },
  { id: 'sepia', name: 'Vintage' },
  { id: 'pop', name: 'Pop' },
];

export const FONTS = [
  { id: 'sans', name: 'Clean', css: '700 {s}px -apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { id: 'serif', name: 'Classic', css: '600 {s}px Georgia, "Times New Roman", serif' },
  { id: 'elegant', name: 'Elegant', css: 'italic 400 {s}px Didot, "Bodoni 72", "Playfair Display", Georgia, serif' },
  { id: 'bold', name: 'Loud', css: '900 {s}px Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  { id: 'hand', name: 'Marker', css: '400 {s}px "Marker Felt", "Comic Sans MS", "Chalkboard SE", cursive' },
  { id: 'script', name: 'Script', css: '400 {s}px "Snell Roundhand", "Brush Script MT", "Segoe Script", cursive' },
  { id: 'mono', name: 'Typewriter', css: '400 {s}px "American Typewriter", "Courier New", monospace' },
];
export const fontCss = (id, size) => (FONTS.find(f => f.id === id) || FONTS[0]).css.replace('{s}', size);

// ---------- Default settings for new layers ----------
export function defaultEffects() {
  return {
    opacity: 100,
    adj: { bright: 0, contrast: 0, sat: 0, warmth: 0 },
    filter: 'none',
    enhance: false,
    blurBg: 0,
    radius: 0,
    outline: { on: false, size: 20, gap: 0, color: '#FFFFFF' },
    shadow: { on: false, blur: 30, dist: 20, angle: 90, color: '#000000', strength: 45 },
  };
}

// ---------- Cache so sliders stay smooth ----------
const cache = new Map();
function cacheKey(L, cap) {
  const ids = [L.img && L.img._id, L.mask && L.mask._id, L.subject && L.subject._id, L.noBrows && L.noBrows._id].join(',');
  // Face points are long lists; facesFor says which picture they belong to, which is enough here.
  const { x, y, scale, rot, hidden, opacity, shadow, name, faces, selFace, ...rest } = L;
  return cap + '|' + ids + '|' + JSON.stringify(rest, (k, v) => (v instanceof HTMLCanvasElement ? undefined : v));
}

// Returns { canvas, s, pad }: s = render scale (canvas px per layer px), pad = extra space for outline (layer px).
export function renderLayer(L, cap = 1400) {
  const key = cacheKey(L, cap);
  const hit = cache.get(key);
  if (hit) return hit;
  const out = L.type === 'text' ? renderText(L, cap) : renderPhoto(L, cap);
  cache.set(key, out);
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return out;
}

export function layerSize(L) {
  if (L.type === 'text') { const r = renderLayer(L); return { w: r.w, h: r.h }; }
  const c = L.crop || { w: L.img.width, h: L.img.height };
  return { w: c.w, h: c.h };
}

function renderPhoto(L, cap) {
  const crop = L.crop || { x: 0, y: 0, w: L.img.width, h: L.img.height };
  const s = Math.min(1, cap / Math.max(crop.w, crop.h));
  const w = Math.max(1, Math.round(crop.w * s)), h = Math.max(1, Math.round(crop.h * s));
  const u = (Math.max(crop.w, crop.h) / 1000) * s; // one "unit" = 1/1000 of the long side
  let c = makeCanvas(w, h);
  let cx = ctx2d(c);
  cx.imageSmoothingQuality = 'high';
  cx.drawImage(L.img, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);

  // Blur background: blur everything, then put the sharp person back on top.
  if (L.blurBg > 0 && L.subject) {
    const blurred = blurCanvas(c, L.blurBg * u * 0.6);
    const person = makeCanvas(w, h);
    const pc = ctx2d(person);
    pc.drawImage(c, 0, 0);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(L.subject, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    cx.clearRect(0, 0, w, h);
    cx.drawImage(blurred, 0, 0);
    cx.drawImage(person, 0, 0);
  }

  // Eyebrows, drawn fresh from each face's settings (the photo itself is never changed).
  if (L.brows && L.faces && !L.browsOff) {
    for (const f of L.faces) if (L.brows[f.id]) drawBrows(c, L, f, L.brows[f.id], crop, s);
  }

  colourPass(c, L);

  if (L.mask) {
    cx.globalCompositeOperation = 'destination-in';
    cx.drawImage(L.mask, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
    cx.globalCompositeOperation = 'source-over';
  }
  if (L.radius > 0) {
    const r = (L.radius / 100) * Math.min(w, h) / 2;
    cx.globalCompositeOperation = 'destination-in';
    cx.beginPath();
    roundRectPath(cx, 0, 0, w, h, r);
    cx.fill();
    cx.globalCompositeOperation = 'source-over';
  }
  return finish(c, L, s, u);
}

function renderText(L, cap) {
  const fs = 120; // draw text at a fixed size; layer.scale sets how big it looks
  const lines = (L.text || ' ').split('\n');
  const m = makeCanvas(10, 10);
  const mc = ctx2d(m);
  mc.font = fontCss(L.font, fs);
  const lh = fs * 1.2;
  const tw = Math.max(...lines.map(t => mc.measureText(t).width), fs * 0.5);
  const pad = fs * 0.15;
  const W = Math.ceil(tw + pad * 2), H = Math.ceil(lines.length * lh + pad * 2);
  const s = Math.min(1, cap / Math.max(W, H)) || 1;
  const c = makeCanvas(W * s, H * s);
  const cx = ctx2d(c);
  cx.scale(s, s);
  cx.font = fontCss(L.font, fs);
  cx.fillStyle = L.color || '#FFFFFF';
  cx.textBaseline = 'middle';
  cx.textAlign = L.align || 'center';
  const ax = L.align === 'left' ? pad : L.align === 'right' ? W - pad : W / 2;
  lines.forEach((t, i) => cx.fillText(t, ax, pad + lh * (i + 0.5)));
  const r = finish(c, L, s, (Math.max(W, H) / 1000) * s);
  r.w = W; r.h = H;
  return r;
}

// Outline is added last, because it follows the final shape.
function finish(c, L, s, u) {
  const o = L.outline;
  if (!o || !o.on || o.size <= 0) return { canvas: c, s, pad: 0 };
  const t = o.size * u * 0.5, g = o.gap * u * 0.5;
  const pad = Math.ceil(t + g + 2);
  const W = c.width + pad * 2, H = c.height + pad * 2;
  const a = ctx2d(c).getImageData(0, 0, c.width, c.height).data;
  // Distance from every pixel to the nearest solid pixel of the shape.
  const inside = new Float32Array(W * H).fill(1e20);
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (a[(y * c.width + x) * 4 + 3] > 127) inside[(y + pad) * W + x + pad] = 0;
    }
  }
  const dist = edt(inside, W, H);
  const ring = makeCanvas(W, H);
  const rc = ctx2d(ring);
  const img = rc.createImageData(W, H);
  const [r, gg, b] = hexToRgb(o.color);
  for (let p = 0; p < W * H; p++) {
    const d = Math.sqrt(dist[p]);
    const outer = Math.min(1, Math.max(0, t + g - d + 0.5));
    const inner = g > 0 ? Math.min(1, Math.max(0, g - d + 0.5)) : 0;
    const al = Math.max(0, outer - inner);
    if (al > 0) {
      img.data[p * 4] = r; img.data[p * 4 + 1] = gg; img.data[p * 4 + 2] = b;
      img.data[p * 4 + 3] = Math.round(al * 255);
    }
  }
  rc.putImageData(img, 0, 0);
  rc.drawImage(c, pad, pad);
  return { canvas: ring, s, pad: pad / s };
}

// Exact distance transform (Felzenszwalb & Huttenlocher), returns squared distances.
export function edt(f, W, H) {
  const n = Math.max(W, H);
  const d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1), tmp = new Float32Array(n);
  const pass = (get, set, len) => {
    for (let q = 0; q < len; q++) tmp[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -1e20; z[1] = 1e20;
    for (let q = 1; q < len; q++) {
      let sp;
      for (;;) {
        const r = v[k];
        sp = ((tmp[q] + q * q) - (tmp[r] + r * r)) / (2 * q - 2 * r);
        if (sp <= z[k]) { k--; if (k < 0) { k = 0; break; } } else break;
      }
      k++; v[k] = q; z[k] = sp; z[k + 1] = 1e20;
    }
    k = 0;
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++;
      const r = v[k];
      d[q] = (q - r) * (q - r) + tmp[r];
    }
    for (let q = 0; q < len; q++) set(q, d[q]);
  };
  for (let x = 0; x < W; x++) pass(y => f[y * W + x], (y, val) => (f[y * W + x] = val), H);
  for (let y = 0; y < H; y++) pass(x => f[y * W + x], (x, val) => (f[y * W + x] = val), W);
  return f;
}

// Brightness, contrast, saturation, warmth, filter and enhance in one pass over the pixels.
function colourPass(c, L) {
  const a = L.adj || {};
  const f = L.filter || 'none';
  if (!a.bright && !a.contrast && !a.sat && !a.warmth && f === 'none' && !L.enhance) return;
  const cx = ctx2d(c);
  const id = cx.getImageData(0, 0, c.width, c.height);
  const d = id.data;

  // Enhance: stretch the darkest and brightest 1% to full range, a little more colour.
  let lo = 0, hi = 255;
  if (L.enhance) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < d.length; i += 16) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
    const total = d.length / 16;
    let acc = 0;
    for (lo = 0; lo < 255 && (acc += hist[lo]) < total * 0.01; lo++);
    acc = 0;
    for (hi = 255; hi > 0 && (acc += hist[hi]) < total * 0.01; hi--);
    if (hi - lo < 50) { lo = 0; hi = 255; }
  }
  const stretch = 255 / Math.max(1, hi - lo);
  const br = (a.bright || 0) * 1.0;
  const ct = 1 + (a.contrast || 0) / 100;
  let sat = 1 + (a.sat || 0) / 100 + (L.enhance ? 0.12 : 0);
  const wm = (a.warmth || 0) * 0.35;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = (v - lo) * stretch;
    x = (x - 128) * ct + 128 + br;
    lut[v] = x;
  }
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    r += wm; b -= wm;
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    let s2 = sat;
    switch (f) {
      case 'vivid': s2 *= 1.35; r = (r - 128) * 1.1 + 128; g = (g - 128) * 1.1 + 128; b = (b - 128) * 1.1 + 128; break;
      case 'warm': r += 18; g += 6; b -= 14; break;
      case 'cool': r -= 12; g += 2; b += 18; break;
      case 'fade': r = r * 0.82 + 34; g = g * 0.82 + 30; b = b * 0.82 + 38; s2 *= 0.8; break;
      case 'mono': s2 = 0; break;
      case 'noir': s2 = 0; r = g = b = (y - 128) * 1.45 + 118; break;
      case 'sepia': { const t = y; r = t * 1.07 + 28; g = t * 0.95 + 12; b = t * 0.76; s2 = 1; break; }
      case 'pop': s2 *= 1.6; r = (r - 128) * 1.2 + 128; g = (g - 128) * 1.2 + 128; b = (b - 128) * 1.2 + 128; break;
    }
    if (s2 !== 1) {
      const yy = 0.299 * r + 0.587 * g + 0.114 * b;
      r = yy + (r - yy) * s2; g = yy + (g - yy) * s2; b = yy + (b - yy) * s2;
    }
    d[i] = r; d[i + 1] = g; d[i + 2] = b;
  }
  cx.putImageData(id, 0, 0);
}

// ---------- Placing layers on a canvas ----------
// view: { scale, ox, oy } turns project px into canvas px.
export function drawLayer(ctx, L, view, cap) {
  if (L.hidden) return;
  const r = renderLayer(L, cap);
  const { w, h } = layerSize(L);
  const sc = L.scale * view.scale;
  ctx.save();
  ctx.globalAlpha = (L.opacity ?? 100) / 100;
  if (L.shadow && L.shadow.on) {
    const unit = Math.max(w, h) * sc / 1000;
    const ang = (L.shadow.angle * Math.PI) / 180;
    const [r0, g0, b0] = hexToRgb(L.shadow.color);
    ctx.shadowColor = `rgba(${r0},${g0},${b0},${L.shadow.strength / 100})`;
    ctx.shadowBlur = L.shadow.blur * unit;
    ctx.shadowOffsetX = Math.cos(ang) * L.shadow.dist * unit;
    ctx.shadowOffsetY = Math.sin(ang) * L.shadow.dist * unit;
  }
  ctx.translate(view.ox + L.x * view.scale, view.oy + L.y * view.scale);
  ctx.rotate(L.rot || 0);
  ctx.scale(sc * (L.flipX ? -1 : 1), sc * (L.flipY ? -1 : 1));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(r.canvas, -w / 2 - r.pad, -h / 2 - r.pad, w + r.pad * 2, h + r.pad * 2);
  ctx.restore();
}

// Draw the whole project at full size (used for saving and thumbnails).
export function renderProject(P, { maxSide = 0, background = null } = {}) {
  const s = maxSide ? Math.min(1, maxSide / Math.max(P.w, P.h)) : 1;
  const c = makeCanvas(P.w * s, P.h * s);
  const cx = ctx2d(c);
  const bg = P.bg || background;
  if (bg) { cx.fillStyle = bg; cx.fillRect(0, 0, c.width, c.height); }
  const cap = maxSide ? 800 : 100000;
  for (const L of P.layers) drawLayer(cx, L, { scale: s, ox: 0, oy: 0 }, cap);
  return c;
}

export function roundRectPath(cx, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  cx.moveTo(x + r, y);
  cx.arcTo(x + w, y, x + w, y + h, r);
  cx.arcTo(x + w, y + h, x, y + h, r);
  cx.arcTo(x, y + h, x, y, r);
  cx.arcTo(x, y, x + w, y, r);
  cx.closePath();
}

export function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(x => x + x).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
