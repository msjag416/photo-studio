// Face Shape: smooth, even reshaping of one face with sliders (slim face, cheeks, mouth width,
// lip fullness, smile lift, nose). Like the eyebrows, the photo is never changed: each face's
// slider values are stored on the layer and the warp is applied fresh every time it is drawn.
//
// How the warp works: each slider adds a few soft "moves" placed with the face points
// (for example: pull the jaw line toward the middle, or stretch the area around the mouth).
// Every pixel of the result looks up the pixel it came from (the sum of the moves near it),
// so the whole area shifts as one smooth piece with no seams.
import { makeCanvas, ctx2d } from './util.js';
import { pt } from './faces.js';

export const SHAPE_SLIDERS = [
  { id: 'slim', name: 'Slim face', min: 0, max: 100 },
  { id: 'cheeks', name: 'Cheeks (slimmer / fuller)', min: -100, max: 100 },
  { id: 'mouth', name: 'Mouth width', min: -100, max: 100 },
  { id: 'lips', name: 'Lip fullness', min: -100, max: 100 },
  { id: 'smile', name: 'Smile lift', min: 0, max: 100 },
  { id: 'nose', name: 'Nose (narrower / wider)', min: -100, max: 100 },
];
export const hasShape = v => !!v && SHAPE_SLIDERS.some(s => v[s.id]);

// Jaw and cheek outline points (left side of the picture, then the matching right side).
const JAW_L = [132, 58, 172, 136, 150, 149, 176], JAW_R = [361, 288, 397, 365, 379, 378, 400];
const CHEEK_L = [234, 93, 132], CHEEK_R = [454, 323, 361];

// Build the list of moves for one face. All positions are in picture pixels.
function moves(face, v) {
  const P = i => pt(face, i);
  const eyeA = P(33), eyeB = P(263);
  let ux = eyeB.x - eyeA.x, uy = eyeB.y - eyeA.y;
  const el = Math.hypot(ux, uy) || 1;
  ux /= el; uy /= el;                     // across the face (left to right in the picture)
  const dx = -uy, dy = ux;                // down the face
  const faceW = Math.hypot(P(454).x - P(234).x, P(454).y - P(234).y);
  const mid = P(168);                     // between the eyes: the face's middle line
  const side = q => ((q.x - mid.x) * ux + (q.y - mid.y) * uy) > 0 ? 1 : -1;
  const out = [];
  const pull = (q, amount, R) => {        // move point q toward (amount > 0) or away from the middle line
    const s = -side(q) * amount;
    out.push({ t: 'move', x: q.x, y: q.y, vx: ux * s, vy: uy * s, R });
  };
  if (v.slim) {
    const a = (v.slim / 100) * faceW * 0.045;
    [...JAW_L, ...JAW_R].forEach((i, k) => pull(P(i), a * (k % 7 < 5 ? 1 : 0.6), faceW * 0.2));
    const chin = P(152); // lift the chin a touch, which reads as "slimmer"
    out.push({ t: 'move', x: chin.x, y: chin.y, vx: -dx * a * 0.35, vy: -dy * a * 0.35, R: faceW * 0.18 });
  }
  if (v.cheeks) {
    const a = -(v.cheeks / 100) * faceW * 0.035; // fuller = away from the middle
    [...CHEEK_L, ...CHEEK_R].forEach(i => pull(P(i), a, faceW * 0.22));
  }
  const cA = P(61), cB = P(291);
  const mouthW = Math.hypot(cB.x - cA.x, cB.y - cA.y);
  const mc = { x: (cA.x + cB.x) / 2, y: (cA.y + cB.y) / 2 };
  const lipH = Math.hypot(P(17).x - P(0).x, P(17).y - P(0).y);
  if (v.mouth) {
    out.push({ t: 'scale', x: mc.x, y: mc.y, ra: mouthW * 0.95, rb: Math.max(lipH * 1.3, mouthW * 0.45), ka: (v.mouth / 100) * 0.16, kb: 0, ux, uy });
  }
  if (v.lips) {
    const lc = { x: (P(0).x + P(17).x) / 2, y: (P(0).y + P(17).y) / 2 };
    out.push({ t: 'scale', x: lc.x, y: lc.y, ra: mouthW * 0.7, rb: lipH * 1.25, ka: (v.lips / 100) * 0.04, kb: (v.lips / 100) * 0.22, ux, uy });
  }
  if (v.smile) {
    const a = (v.smile / 100) * mouthW * 0.07;
    for (const q of [cA, cB]) {
      out.push({ t: 'move', x: q.x, y: q.y, vx: -dx * a + -side(q) * ux * a * -0.3, vy: -dy * a + -side(q) * uy * a * -0.3, R: mouthW * 0.32 });
    }
  }
  if (v.nose) {
    const nA = P(129), nB = P(358);
    const nW = Math.hypot(nB.x - nA.x, nB.y - nA.y);
    const nc = P(4);
    out.push({ t: 'scale', x: nc.x, y: nc.y, ra: nW * 1.05, rb: nW * 0.95, ka: (v.nose / 100) * 0.38, kb: 0, ux, uy });
  }
  return out;
}

const fall = t => (t >= 1 ? 0 : (1 - t * t) * (1 - t * t)); // smooth, 1 in the middle, 0 at the edge

// Warp the canvas c (which shows picture area `crop` at scale s) for one face.
export function applyShape(c, face, v, crop, s) {
  const list = moves(face, v);
  if (!list.length) return;
  // Only the area the moves can reach needs work.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const m of list) {
    const r = m.t === 'move' ? m.R : Math.max(m.ra, m.rb);
    x0 = Math.min(x0, m.x - r); y0 = Math.min(y0, m.y - r); x1 = Math.max(x1, m.x + r); y1 = Math.max(y1, m.y + r);
  }
  // Into canvas pixels.
  const toC = (x, y) => ({ x: (x - crop.x) * s, y: (y - crop.y) * s });
  const ms = list.map(m => {
    const p = toC(m.x, m.y);
    return m.t === 'move' ? { ...m, x: p.x, y: p.y, vx: m.vx * s, vy: m.vy * s, R: m.R * s }
      : { ...m, x: p.x, y: p.y, ra: m.ra * s, rb: m.rb * s };
  });
  const X0 = Math.max(0, Math.floor((x0 - crop.x) * s)), Y0 = Math.max(0, Math.floor((y0 - crop.y) * s));
  const X1 = Math.min(c.width, Math.ceil((x1 - crop.x) * s)), Y1 = Math.min(c.height, Math.ceil((y1 - crop.y) * s));
  const W = X1 - X0, H = Y1 - Y0;
  if (W < 2 || H < 2) return;
  const cx = ctx2d(c);
  const id = cx.getImageData(X0, Y0, W, H);
  const src = new Uint8ClampedArray(id.data);
  const d = id.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const px = x + X0, py = y + Y0;
      let ox = 0, oy = 0;
      for (const m of ms) {
        if (m.t === 'move') {
          const f = fall(Math.hypot(px - m.x, py - m.y) / m.R);
          if (f) { ox += m.vx * f; oy += m.vy * f; }
        } else {
          // Stretch (k > 0) or squeeze (k < 0) around a point, along the face's own directions.
          const rx = px - m.x, ry = py - m.y;
          const a = rx * m.ux + ry * m.uy, b = -rx * m.uy + ry * m.ux;
          const f = fall(Math.hypot(a / m.ra, b / m.rb));
          if (f) {
            const da = a * m.ka * f, db = b * m.kb * f;
            ox += da * m.ux - db * m.uy; oy += da * m.uy + db * m.ux;
          }
        }
      }
      if (!ox && !oy) continue;
      // This pixel shows what was at (p - offset): smooth sampling between pixels.
      const sx = Math.min(W - 1, Math.max(0, x - ox)), sy = Math.min(H - 1, Math.max(0, y - oy));
      const ix = Math.floor(sx), iy = Math.floor(sy), fx = sx - ix, fy = sy - iy;
      const ix1 = Math.min(W - 1, ix + 1), iy1 = Math.min(H - 1, iy + 1);
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        const A = src[(iy * W + ix) * 4 + k], B = src[(iy * W + ix1) * 4 + k];
        const C = src[(iy1 * W + ix) * 4 + k], D = src[(iy1 * W + ix1) * 4 + k];
        d[o + k] = (A * (1 - fx) + B * fx) * (1 - fy) + (C * (1 - fx) + D * fx) * fy;
      }
    }
  }
  cx.putImageData(id, X0, Y0);
}
