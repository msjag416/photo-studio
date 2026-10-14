// Finding faces with MediaPipe Face Landmarker (free, runs in the browser, Apache licence).
// Each face gets 478 points (eyebrows, eyes, lips, face outline), a box and its own id.
import { makeCanvas, ctx2d, uid, blurCanvas } from './util.js';

const BASE = new URL('../', import.meta.url).href;
let landmarkerPromise = null;

function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      if (!document.createElement('canvas').getContext('webgl2')) {
        throw new Error('This browser has no WebGL 2, which the face finder needs. Try an up-to-date Safari or Chrome.');
      }
      const { FaceLandmarker, FilesetResolver } = await import(BASE + 'vendor/mediapipe/vision_bundle.mjs');
      const files = await FilesetResolver.forVisionTasks(BASE + 'vendor/mediapipe/wasm');
      return FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: BASE + 'models/face_landmarker.task', delegate: 'CPU' },
        // A normal canvas for its WebGL work. (By default it uses an "offscreen" canvas, which
        // some Safari versions can't use with WebGL.)
        canvas: document.createElement('canvas'),
        runningMode: 'IMAGE',
        numFaces: 12,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
      });
    })();
    landmarkerPromise.catch(() => (landmarkerPromise = null)); // allow a retry after a failure
  }
  return landmarkerPromise;
}

// Point numbers in the 478-point face map.
export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
// Eyebrows, from the end near the nose to the tail: upper edge and lower edge.
export const BROWS = {
  a: { upper: [107, 66, 105, 63, 70], lower: [55, 65, 52, 53, 46], eyeIn: 133, eyeOut: 33 },
  b: { upper: [336, 296, 334, 293, 300], lower: [285, 295, 282, 283, 276], eyeIn: 362, eyeOut: 263 },
};

// Find every face in a picture. Points are in picture pixels.
// The detector shrinks what it looks at to a small square, so faces in a wide or group photo can
// become too small to see. So we look at the whole photo, then at overlapping squares at two sizes,
// and keep each person once (the copy that sat most centrally in its square).
export async function detectFaces(img) {
  const lm = await getLandmarker();
  const W = img.width, H = img.height;
  const found = [];
  const look = (x, y, w, h) => {
    const k = Math.min(1, 640 / Math.max(w, h));
    const t = makeCanvas(w * k, h * k);
    const c = ctx2d(t);
    c.imageSmoothingQuality = 'high';
    c.drawImage(img, x, y, w, h, 0, 0, t.width, t.height);
    for (const list of lm.detect(t).faceLandmarks || []) {
      const pts = [];
      for (const p of list) pts.push(x + p.x * w, y + p.y * h);
      const box = boxOf(pts, FACE_OVAL);
      // How far the face is from the edges of the square (bigger = more central = more trustworthy).
      const edge = Math.min(box.x - x, box.y - y, x + w - box.x - box.w, y + h - box.y - box.h) / Math.max(w, h);
      found.push({ pts, box, edge: x === 0 && y === 0 && w === W && h === H ? 1 : edge });
    }
  };
  look(0, 0, W, H);
  const short = Math.min(W, H);
  for (const size of [short, short / 2]) {
    if (size < 160) continue;
    const step = size / 2;
    for (let y = 0; y + size <= H + 1; y += step) {
      for (let x = 0; x + size <= W + 1; x += step) look(Math.round(x), Math.round(y), Math.round(size), Math.round(size));
    }
  }
  const faces = [];
  for (const f of found.filter(f => f.edge > -0.01).sort((a, b) => b.edge - a.edge)) {
    const cx = f.box.x + f.box.w / 2, cy = f.box.y + f.box.h / 2;
    const dup = faces.some(g => Math.hypot(g.box.x + g.box.w / 2 - cx, g.box.y + g.box.h / 2 - cy) < Math.max(g.box.w, f.box.w) * 0.5);
    if (!dup) faces.push({ id: uid(), pts: f.pts, box: f.box });
  }
  // Left to right, so "Face 1" is the leftmost person.
  faces.sort((a, b) => a.box.x - b.box.x);
  return faces;
}

export function pt(face, i) {
  return { x: face.pts[i * 2], y: face.pts[i * 2 + 1] };
}

function boxOf(pts, idx) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const i of idx) {
    const x = pts[i * 2], y = pts[i * 2 + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// Keep the same id for the same person after the photo changes (match by where the face is).
export function matchFaces(oldFaces, newFaces) {
  const used = new Set();
  for (const f of newFaces) {
    const cx = f.box.x + f.box.w / 2, cy = f.box.y + f.box.h / 2;
    let best = null, bestD = Infinity;
    for (const o of oldFaces || []) {
      if (used.has(o.id)) continue;
      const d = Math.hypot(o.box.x + o.box.w / 2 - cx, o.box.y + o.box.h / 2 - cy);
      if (d < bestD && d < Math.max(o.box.w, f.box.w) * 0.5) { best = o; bestD = d; }
    }
    if (best) { f.id = best.id; used.add(best.id); }
  }
  return newFaces;
}

// A soft mask (same size as the photo) covering one face: the face outline grown a little.
// "head" grows it much more, mostly upward, so it also covers the hair.
export function faceMask(face, W, H, kind = 'face') {
  const m = makeCanvas(W, H);
  const c = ctx2d(m);
  const b = face.box;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const grow = kind === 'head' ? 1.55 : 1.12;
  const lift = kind === 'head' ? b.h * 0.3 : 0;
  c.fillStyle = '#fff';
  c.beginPath();
  FACE_OVAL.forEach((i, n) => {
    const x = cx + (face.pts[i * 2] - cx) * grow, y = cy + (face.pts[i * 2 + 1] - cy) * grow - (face.pts[i * 2 + 1] < cy ? lift : 0);
    n ? c.lineTo(x, y) : c.moveTo(x, y);
  });
  c.closePath();
  c.fill();
  // Soft edge, so a strong stroke doesn't leave a hard line where the face area ends.
  return blurCanvas(m, Math.max(2, b.w * 0.05));
}

// Which face (if any) is under a point in picture pixels.
export function faceAt(faces, x, y) {
  return (faces || []).find(f => x >= f.box.x && x <= f.box.x + f.box.w && y >= f.box.y && y <= f.box.y + f.box.h) || null;
}
