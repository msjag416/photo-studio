// Retouch tools for photos of people. No AI: each tool is simple colour math.
// For every tool (except Reshape) we make an "effect picture": the whole photo with the
// effect applied everywhere. Brushing reveals that picture only where you paint.
import { makeCanvas, ctx2d } from './util.js';

export const RETOUCH_TOOLS = [
  { id: 'smooth', name: 'Smooth skin', icon: 'sparkle', strength: 60,
    opts: [{ id: 'smooth', name: 'Smooth' }, { id: 'smoother', name: 'Smoother' }] },
  { id: 'whiten', name: 'Whiten teeth', icon: 'tooth', strength: 70 },
  { id: 'eyes', name: 'Eye colour', icon: 'eye', strength: 45,
    colors: ['#3F7FCF', '#2F9467', '#8B5E34', '#7D8E9C', '#6A4BB0', '#1C5A86'] },
  { id: 'brighten', name: 'Brighten', icon: 'sun', strength: 40 },
  { id: 'makeup', name: 'Makeup', icon: 'lips', strength: 40,
    opts: [{ id: 'lips', name: 'Lips' }, { id: 'blush', name: 'Blush' }],
    colors: { lips: ['#C2185B', '#E0446A', '#B5302F', '#D08277', '#7A2A42', '#F07F72'],
      blush: ['#F08A8A', '#E8709A', '#F3A27C', '#D46A78'] } },
  { id: 'hair', name: 'Hair colour', icon: 'hair', strength: 45,
    colors: ['#3A2418', '#7A4428', '#C98B4E', '#E6C77D', '#A8322B', '#B9BEC6', '#E2609F', '#7D55D0', '#3E6FD1'] },
  { id: 'reshape', name: 'Reshape', icon: 'reshape', strength: 70,
    opts: [{ id: 'move', name: 'Move' }, { id: 'restore', name: 'Restore' }] },
];
export const toolById = id => RETOUCH_TOOLS.find(t => t.id === id) || RETOUCH_TOOLS[0];

// Colours offered for the current option (Makeup has different colours for lips and blush).
export function colorsFor(tool, opt) {
  if (!tool.colors) return null;
  return Array.isArray(tool.colors) ? tool.colors : tool.colors[opt];
}

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const hexRgb = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// Make the effect picture for a tool. opt = the option (Smooth/Smoother, Lips/Blush), color = swatch.
export function makeEffect(img, toolId, opt, color) {
  const W = img.width, H = img.height;
  const out = makeCanvas(W, H);
  const oc = ctx2d(out);
  const src = ctx2d(img).getImageData(0, 0, W, H);
  const s = src.data;
  const res = oc.createImageData(W, H);
  const d = res.data;
  const long = Math.max(W, H);

  if (toolId === 'smooth') {
    // Edge-preserving smoothing (a "guided filter"), done separately on red, green and blue:
    // where the skin is even (small differences, like wrinkles and blotches) it is averaged out;
    // where there are strong edges (eyes, nostrils, lips, hairline) the photo is kept as it is.
    // Each colour is only averaged with itself, so the skin colour stays exactly the same.
    // A little of the finest texture (pores) is put back so the skin doesn't look plastic.
    const r = Math.max(2, Math.round(long * (opt === 'smoother' ? 0.011 : 0.006)));
    const eps = (opt === 'smoother' ? 20 : 13) ** 2;
    const keep = opt === 'smoother' ? 0.4 : 0.5;
    const n = W * H;
    const I = new Float32Array(n), II = new Float32Array(n);
    for (let c = 0; c < 3; c++) {
      for (let i = 0; i < n; i++) { const v = s[i * 4 + c]; I[i] = v; II[i] = v * v; }
      const mI = boxMean(I, W, H, r), mII = boxMean(II, W, H, r);
      const A = new Float32Array(n), B = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const v = mII[i] - mI[i] * mI[i];
        A[i] = v / (v + eps);
        B[i] = mI[i] - A[i] * mI[i];
      }
      const mA = boxMean(A, W, H, r), mB = boxMean(B, W, H, r);
      const fine = boxMean(I, W, H, 1);
      for (let i = 0; i < n; i++) d[i * 4 + c] = mA[i] * I[i] + mB[i] + (I[i] - fine[i]) * keep * (1 - mA[i]);
    }
    for (let i = 0; i < n; i++) d[i * 4 + 3] = s[i * 4 + 3];
  } else {
    const [tr, tg, tb] = color ? hexRgb(color) : [0, 0, 0];
    const ty = lum(tr, tg, tb);
    const kind = toolId === 'makeup' ? opt : toolId;
    // How far the lightness moves toward the new colour (dark hair can't go blonde with colour alone),
    // and how much of the new colour's strength is used (less looks more natural).
    const pull = { eyes: 0.25, lips: 0.15, hair: 0.45 }[kind] || 0;
    const chroma = { eyes: 0.7, lips: 0.55, hair: 0.75 }[kind] || 1;
    const [cr, cg, cb] = [(tr - ty) * chroma, (tg - ty) * chroma, (tb - ty) * chroma];
    for (let i = 0; i < s.length; i += 4) {
      let r = s[i], g = s[i + 1], b = s[i + 2];
      const y = lum(r, g, b);
      if (toolId === 'whiten') {
        // Take out most of the yellow (blue is the colour yellow lacks), keep a little warmth, lighten.
        // Gums and lips (pink or red: much more red than green) and dark gaps are left alone.
        const w = (1 - Math.min(1, Math.max(0, (r - g - 18) / 25))) * Math.min(1, Math.max(0, (y - 70) / 60));
        const yb = Math.max(0, (r + g) / 2 - b);
        let nr = r, ng = g, nb = b + yb * 0.7;
        nr = y + (nr - y) * 0.35; ng = y + (ng - y) * 0.35; nb = y + (nb - y) * 0.35;
        nr += (255 - nr) * 0.45; ng += (255 - ng) * 0.45; nb += (255 - nb) * 0.45;
        r += (nr - r) * w; g += (ng - g) * w; b += (nb - b) * w;
      } else if (toolId === 'brighten') {
        // Lift darker tones more than light ones, so nothing washes out.
        const k = 0.42 * (1 - y / 255);
        r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
      } else if (kind === 'blush') {
        // A soft wash of colour, like powder: mostly the skin, tinted by the colour.
        r = r * 0.55 + (r * tr / 255) * 0.45 + 10; g = g * 0.55 + (g * tg / 255) * 0.45 + 4; b = b * 0.55 + (b * tb / 255) * 0.45 + 6;
      } else {
        // New colour, same light and dark detail ("colour" blend).
        const ny = y + (ty - y) * pull;
        let nr = ny + cr, ng = ny + cg, nb = ny + cb;
        // Leave very light and very dark spots alone: whites of the eyes, pupils, teeth, shine.
        let w = 1;
        if (kind === 'eyes') w = Math.max(0, 1 - ((y - 95) / 105) ** 2);
        // Lips are pinkish-red (much more red than green); teeth are white or cream, so leave those alone.
        if (kind === 'lips') w = Math.min(1, Math.max(0, (r - g - 25) / 20)) * (1 - Math.min(1, Math.max(0, (y - 215) / 30)));
        r += (nr - r) * w; g += (ng - g) * w; b += (nb - b) * w;
      }
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = s[i + 3];
    }
  }
  oc.putImageData(res, 0, 0);
  return out;
}

// Reshape: slide the pixels inside a circle of radius r by (dx, dy), strongest in the middle.
export function reshapeStep(work, cx, cy, dx, dy, r, strength) {
  const x0 = Math.max(0, Math.floor(cx - r - 2)), y0 = Math.max(0, Math.floor(cy - r - 2));
  const x1 = Math.min(work.width, Math.ceil(cx + r + 2)), y1 = Math.min(work.height, Math.ceil(cy + r + 2));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const c = ctx2d(work);
  const id = c.getImageData(x0, y0, w, h);
  const src = new Uint8ClampedArray(id.data);
  const d = id.data;
  const r2 = r * r;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x + x0 - cx, py = y + y0 - cy;
      const q = Math.sqrt((px * px + py * py) / r2);
      if (q >= 1) continue;
      // The middle of the brush carries the picture fully along with the finger; it softens
      // toward the edge so there is no seam.
      const e = Math.min(1, Math.max(0, (q - 0.25) / 0.75));
      const f = (1 - e * e * (3 - 2 * e)) * strength;
      // Take the colour from where this pixel "came from" (smooth sampling between pixels).
      const sx = Math.min(w - 1, Math.max(0, x - dx * f)), sy = Math.min(h - 1, Math.max(0, y - dy * f));
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const ix1 = Math.min(w - 1, ix + 1), iy1 = Math.min(h - 1, iy + 1);
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const a = src[(iy * w + ix) * 4 + k], b = src[(iy * w + ix1) * 4 + k];
        const cc = src[(iy1 * w + ix) * 4 + k], dd = src[(iy1 * w + ix1) * 4 + k];
        d[o + k] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + dd * fx) * fy;
      }
    }
  }
  c.putImageData(id, x0, y0);
}

// Reshape: "grab and drag". Points near the grab point g move by v, fading smoothly to nothing at
// radius R. Every pixel in the box is redrawn from src (the photo before this drag) into dst.
// Each pixel finds where it came from by reversing the move (a few quick rounds of refinement),
// which keeps the moved area smooth and in one piece.
export function grabWarp(dst, src, g, v, R, box) {
  const W = src.width, H = src.height;
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(W, Math.ceil(box.x1)), y1 = Math.min(H, Math.ceil(box.y1));
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return;
  const s = ctx2d(src).getImageData(x0, y0, w, h).data;
  const dc = ctx2d(dst);
  const out = dc.createImageData(w, h);
  const d = out.data;
  const fall = t => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t));
  const gx = g.x - x0, gy = g.y - y0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let qx = x, qy = y;
      for (let it = 0; it < 4; it++) {
        const f = fall(Math.hypot(qx - gx, qy - gy) / R);
        qx = x - v.x * f; qy = y - v.y * f;
      }
      const sx = Math.min(w - 1, Math.max(0, qx)), sy = Math.min(h - 1, Math.max(0, qy));
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const ix1 = Math.min(w - 1, ix + 1), iy1 = Math.min(h - 1, iy + 1);
      const o = (y * w + x) * 4;
      for (let k = 0; k < 4; k++) {
        const A = s[(iy * w + ix) * 4 + k], B = s[(iy * w + ix1) * 4 + k];
        const C = s[(iy1 * w + ix) * 4 + k], D = s[(iy1 * w + ix1) * 4 + k];
        d[o + k] = (A * (1 - fx) + B * fx) * (1 - fy) + (C * (1 - fx) + D * fx) * fy;
      }
    }
  }
  dc.putImageData(out, x0, y0);
}

// Patch: copy the round area at s (radius R) from src and paste it at t on dst, with a soft
// edge (soft 0..1 = how much of the radius fades out). flip mirrors the copy left to right.
// Returns the box it changed, so it can be put back later.
export function pastePatch(dst, src, s, t, R, soft, flip) {
  const size = Math.ceil(R * 2) + 2;
  const tmp = makeCanvas(size, size);
  const c = ctx2d(tmp);
  c.save();
  c.translate(size / 2, size / 2);
  if (flip) c.scale(-1, 1);
  c.drawImage(src, -s.x, -s.y);
  c.restore();
  // Soft round edge: fully the copy in the middle, fading to nothing at the circle's edge.
  const g = c.createRadialGradient(size / 2, size / 2, R * (1 - soft), size / 2, size / 2, R);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  c.globalCompositeOperation = 'destination-in';
  c.fillStyle = g;
  c.fillRect(0, 0, size, size);
  const x = Math.round(t.x - size / 2), y = Math.round(t.y - size / 2);
  ctx2d(dst).drawImage(tmp, x, y);
  return { x, y, w: size, h: size };
}

// Average of each value with its neighbours in a (2r+1) square (one box blur across, one down).
// Edges reuse the nearest value, so nothing outside the photo leaks in.
export function boxMean(src, W, H, r) {
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  const k = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[o + Math.min(W - 1, Math.max(0, i))];
    for (let x = 0; x < W; x++) {
      tmp[o + x] = sum * k;
      sum += src[o + Math.min(W - 1, x + r + 1)] - src[o + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < W; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += tmp[Math.min(H - 1, Math.max(0, i)) * W + x];
    for (let y = 0; y < H; y++) {
      out[y * W + x] = sum * k;
      sum += tmp[Math.min(H - 1, y + r + 1) * W + x] - tmp[Math.max(0, y - r) * W + x];
    }
  }
  return out;
}
