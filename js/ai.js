// The two AI models, run inside the browser for free with onnxruntime-web.
// Main engine: WebAssembly on the CPU, single thread (safe on iPad and iPhone).
// Backup engine: WebGL (graphics chip), only used if the CPU engine fails to start.
import { makeCanvas, ctx2d, busy } from './util.js';
import { edt } from './render.js';

const BASE = new URL('../', import.meta.url).href;
const MODELS = {
  bg: { url: BASE + 'models/u2netp.onnx', label: 'background tool' },
  erase: { url: BASE + 'models/migan.onnx', label: 'object removal tool' },
};
const sessions = {};
let engine = 'wasm';

function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = res;
    s.onerror = () => rej(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

async function loadOrt() {
  if (window.ort) return window.ort;
  await loadScript(BASE + 'vendor/ort.wasm.min.js');
  const ort = window.ort;
  ort.env.wasm.wasmPaths = BASE + 'vendor/';
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  return ort;
}

// Download a model with a progress bar. The browser keeps a copy, so later visits are faster.
// The pieces are collected as they arrive. The size the server reports is only used for the
// progress bar, because servers like GitHub Pages report the smaller, compressed size.
async function download(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) busy(`Getting the ${label} ready (first time only)…`, Math.min(1, got / total));
  }
  const out = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

async function getSession(key) {
  if (sessions[key]) return sessions[key];
  const m = MODELS[key];
  busy(`Getting the ${m.label} ready…`, 0);
  let ort = await loadOrt();
  const bytes = await download(m.url, m.label);
  busy(`Starting the ${m.label}…`);
  const tryWasm = () => ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
  try {
    if (engine !== 'wasm') throw new Error('skip');
    try {
      sessions[key] = await tryWasm();
    } catch (first) {
      // The CPU engine can fail to start once (for example while another AI is loading); try again.
      console.warn('CPU engine failed, trying again', first);
      await new Promise(r => setTimeout(r, 400));
      sessions[key] = await tryWasm();
    }
  } catch (wasmErr) {
    // Backup plan: the WebGL engine. (It can't run every model, so keep the first error to show.)
    console.warn('CPU engine failed, trying WebGL', wasmErr);
    engine = 'webgl';
    if (!window.ortWebgl) {
      const keep = window.ort;
      window.ort = undefined;
      await loadScript(BASE + 'vendor/ort.webgl.min.js');
      window.ortWebgl = window.ort;
      window.ort = keep;
    }
    try {
      sessions[key] = await window.ortWebgl.InferenceSession.create(bytes, { executionProviders: ['webgl'] });
    } catch (glErr) {
      engine = 'wasm'; // try the CPU engine again next time
      throw new Error(`${wasmErr && wasmErr.message ? wasmErr.message : wasmErr} (backup: ${glErr.message || glErr})`);
    }
    sessions[key]._ort = window.ortWebgl;
  }
  if (!sessions[key]._ort) sessions[key]._ort = ort;
  return sessions[key];
}

// Run a model. If it fails, forget that engine's session so the next try starts fresh
// (and goes back to the CPU engine if the backup engine was in use).
async function runSafe(key, sess, feeds) {
  try {
    return await sess.run(feeds);
  } catch (err) {
    delete sessions[key];
    engine = 'wasm';
    throw err;
  }
}

// ---------------- Background removal (U2-Net-p, 320 x 320) ----------------
// Returns a mask canvas the same size as the photo: see-through where the background was.
export async function removeBackground(src) {
  const sess = await getSession('bg');
  const ort = sess._ort;
  busy('Removing the background…');
  const S = 320;
  const small = makeCanvas(S, S);
  const sc = ctx2d(small);
  sc.imageSmoothingQuality = 'high';
  sc.drawImage(src, 0, 0, S, S);
  const px = sc.getImageData(0, 0, S, S).data;
  let max = 1;
  for (let i = 0; i < px.length; i += 4) max = Math.max(max, px[i], px[i + 1], px[i + 2]);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  const input = new Float32Array(3 * S * S);
  for (let i = 0, p = 0; p < S * S; i += 4, p++) {
    for (let ch = 0; ch < 3; ch++) input[ch * S * S + p] = (px[i + ch] / max - mean[ch]) / std[ch];
  }
  const feeds = { [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, S, S]) };
  const out = await runSafe('bg', sess, feeds);
  const pred = out[sess.outputNames[0]].data;
  let lo = Infinity, hi = -Infinity;
  for (const v of pred) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = hi - lo || 1;
  const m = sc.createImageData(S, S);
  for (let p = 0; p < S * S; p++) {
    const v = (pred[p] - lo) / range;
    // Gentle curve: drop faint haze, keep soft edges.
    const a = Math.min(1, Math.max(0, (v - 0.12) / 0.76));
    m.data[p * 4] = m.data[p * 4 + 1] = m.data[p * 4 + 2] = 255;
    m.data[p * 4 + 3] = Math.round(a * 255);
  }
  sc.putImageData(m, 0, 0);
  const mask = makeCanvas(src.width, src.height);
  const mc = ctx2d(mask);
  mc.imageSmoothingQuality = 'high';
  mc.drawImage(small, 0, 0, mask.width, mask.height);
  return mask;
}

// ---------------- Object removal (MI-GAN) ----------------
// paint: canvas the same size as img; anything painted (alpha > 0) is removed.
// Returns a new canvas with the painted area filled in to match its surroundings.
export async function removeObjects(img, paint) {
  const W = img.width, H = img.height;
  const pd = ctx2d(paint).getImageData(0, 0, W, H).data;
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (pd[(y * W + x) * 4 + 3] > 10) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return img; // nothing painted

  const sess = await getSession('erase');
  const ort = sess._ort;
  busy('Removing the object…');

  // Work on a close-up around the painted area, at full sharpness. (The AI works at about
  // 512 x 512 pixels; sending the whole photo made it fill a tiny, low-detail copy of the
  // spot, which looked smudged once stretched back up.) The close-up is about 3 times the
  // size of the painted area, at least 384 pixels, so the AI sees enough surroundings.
  const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
  const side = Math.min(Math.max(W, H), Math.max(384, Math.round(Math.max(bw, bh) * 3 + 48)));
  const cw = Math.min(W, side), ch = Math.min(H, side);
  const cx0 = Math.max(0, Math.min(W - cw, Math.round((x0 + x1) / 2 - cw / 2)));
  const cy0 = Math.max(0, Math.min(H - ch, Math.round((y0 + y1) / 2 - ch / 2)));
  const k = Math.min(1, 1024 / Math.max(cw, ch)); // very big areas are shrunk to save memory
  const w = Math.max(8, Math.round(cw * k)), h = Math.max(8, Math.round(ch * k));

  const small = makeCanvas(w, h);
  const cc = ctx2d(small);
  cc.imageSmoothingQuality = 'high';
  cc.drawImage(img, cx0, cy0, cw, ch, 0, 0, w, h);
  const mcan = makeCanvas(w, h);
  const mctx = ctx2d(mcan);
  mctx.drawImage(paint, cx0, cy0, cw, ch, 0, 0, w, h);
  const ip = cc.getImageData(0, 0, w, h).data;
  const mp = mctx.getImageData(0, 0, w, h).data;
  const n = w * h;

  // Hole = exactly what was painted, kept precise: tiny gaps between strokes are closed and
  // the hole grows by only about 2 pixels (in a round shape), so it follows the brush.
  let hole = new Uint8Array(n);
  for (let p = 0; p < n; p++) hole[p] = mp[p * 4 + 3] > 8 ? 1 : 0;
  hole = shrink(grow(hole, w, h, 5), w, h, 3);
  hole = grow(hole, w, h, 1);

  const imageT = new Uint8Array(3 * n);
  const maskT = new Uint8Array(n);
  for (let p = 0; p < n; p++) {
    imageT[p] = ip[p * 4];
    imageT[n + p] = ip[p * 4 + 1];
    imageT[2 * n + p] = ip[p * 4 + 2];
    maskT[p] = hole[p] ? 0 : 255; // 255 = keep, 0 = remove
  }
  const out = await runSafe('erase', sess, {
    image: new ort.Tensor('uint8', imageT, [1, 3, h, w]),
    mask: new ort.Tensor('uint8', maskT, [1, 1, h, w]),
  });
  const res = out[sess.outputNames[0]].data;
  const fill = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) { fill[p * 3] = res[p]; fill[p * 3 + 1] = res[n + p]; fill[p * 3 + 2] = res[2 * n + p]; }
  matchSurroundings(fill, ip, hole, w, h);

  // Only the hole (with soft edges) is taken from the model; everything else stays untouched.
  const soft = softEdge(grow(hole, w, h, 1), w, h, 1);
  const patch = cc.createImageData(w, h);
  for (let p = 0; p < n; p++) {
    patch.data[p * 4] = fill[p * 3];
    patch.data[p * 4 + 1] = fill[p * 3 + 1];
    patch.data[p * 4 + 2] = fill[p * 3 + 2];
    patch.data[p * 4 + 3] = Math.round(soft[p] * 255);
  }
  const pc = makeCanvas(w, h);
  ctx2d(pc).putImageData(patch, 0, 0);

  const result = makeCanvas(W, H);
  const rc = ctx2d(result);
  rc.drawImage(img, 0, 0);
  rc.imageSmoothingQuality = 'high';
  rc.drawImage(pc, 0, 0, w, h, cx0, cy0, cw, ch);
  return result;
}

// Make the fill blend in: (1) shift its colour so it meets the photo exactly at the hole's
// edge, with the correction fading smoothly toward the middle; (2) give it the same fine grain
// (skin texture) as the area around it, so it doesn't look smooth and smudged.
function matchSurroundings(fill, ip, hole, w, h) {
  const n = w * h;
  const ring = grow(hole, w, h, 3);
  // Colour difference along the edge, spread smoothly across the hole.
  const diff = new Float32Array(n * 3), wt = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    if (ring[p] && !hole[p]) {
      wt[p] = 1;
      for (let k = 0; k < 3; k++) diff[p * 3 + k] = ip[p * 4 + k] - fill[p * 3 + k];
    }
  }
  const spread = spreadFill(diff, wt, w, h);
  // Fine grain of the surroundings: how much each pixel differs from its close neighbours.
  const lum = i => 0.299 * ip[i * 4] + 0.587 * ip[i * 4 + 1] + 0.114 * ip[i * 4 + 2];
  const near = grow(hole, w, h, Math.max(6, Math.round(Math.sqrt(hole.reduce((a, v) => a + v, 0)) * 0.6)));
  let sum = 0, cnt = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!near[i] || hole[i] || hole[i - 1] || hole[i + 1] || hole[i - w] || hole[i + w]) continue;
    const g = lum(i) - (lum(i - 1) + lum(i + 1) + lum(i - w) + lum(i + w)) / 4;
    sum += g * g; cnt++;
  }
  const grain = Math.min(14, Math.sqrt(sum / Math.max(1, cnt)));
  let fsum = 0, fcnt = 0; // grain the model's fill already has
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (!hole[i]) continue;
    const L = j => 0.299 * fill[j * 3] + 0.587 * fill[j * 3 + 1] + 0.114 * fill[j * 3 + 2];
    const g = L(i) - (L(i - 1) + L(i + 1) + L(i - w) + L(i + w)) / 4;
    fsum += g * g; fcnt++;
  }
  const add = Math.sqrt(Math.max(0, grain * grain - fsum / Math.max(1, fcnt))) * 0.9;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let p = 0; p < n; p++) {
    if (!hole[p]) continue;
    const g = (rnd() + rnd() + rnd() - 1.5) * add * 1.4;
    for (let k = 0; k < 3; k++) fill[p * 3 + k] = Math.min(255, Math.max(0, fill[p * 3 + k] + spread[p * 3 + k] + g));
  }
}

// Fill the unknown values (weight 0) smoothly from the known ones ("push-pull": average at
// smaller and smaller sizes, then fill the gaps back in from those averages).
function spreadFill(val, wgt, W, H) {
  if (W <= 1 && H <= 1) return val;
  const w2 = Math.max(1, Math.ceil(W / 2)), h2 = Math.max(1, Math.ceil(H / 2));
  const c = new Float32Array(w2 * h2 * 3), cw = new Float32Array(w2 * h2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, j = (y >> 1) * w2 + (x >> 1), q = wgt[i];
    if (!q) continue;
    cw[j] += q; for (let k = 0; k < 3; k++) c[j * 3 + k] += val[i * 3 + k] * q;
  }
  for (let j = 0; j < w2 * h2; j++) if (cw[j] > 0) { for (let k = 0; k < 3; k++) c[j * 3 + k] /= cw[j]; cw[j] = Math.min(1, cw[j]); }
  const coarse = (W === w2 && H === h2) ? c : spreadFill(c, cw, w2, h2);
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, q = wgt[i];
    const fx = Math.min(w2 - 1, Math.max(0, (x - 0.5) / 2)), fy = Math.min(h2 - 1, Math.max(0, (y - 0.5) / 2));
    const xa = Math.floor(fx), ya = Math.floor(fy), xb = Math.min(w2 - 1, xa + 1), yb = Math.min(h2 - 1, ya + 1), ax = fx - xa, ay = fy - ya;
    for (let k = 0; k < 3; k++) {
      const v = (coarse[(ya * w2 + xa) * 3 + k] * (1 - ax) + coarse[(ya * w2 + xb) * 3 + k] * ax) * (1 - ay)
        + (coarse[(yb * w2 + xa) * 3 + k] * (1 - ax) + coarse[(yb * w2 + xb) * 3 + k] * ax) * ay;
      out[i * 3 + k] = val[i * 3 + k] * q + v * (1 - q);
    }
  }
  return out;
}

// Grow a 0/1 mask outward by r pixels, in a round shape (using the exact distance to the mask).
function grow(m, w, h, r) {
  if (r <= 0) return m;
  const f = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) f[i] = m[i] ? 0 : 1e20;
  const d = edt(f, w, h);
  const out = new Uint8Array(w * h);
  const r2 = r * r;
  for (let i = 0; i < w * h; i++) out[i] = d[i] <= r2 ? 1 : 0;
  return out;
}

// Shrink a 0/1 mask inward by r pixels.
function shrink(m, w, h, r) {
  return grow(m.map(v => 1 - v), w, h, r).map(v => 1 - v);
}

// Turn a 0/1 mask into soft 0..1 values (two box blurs using running sums).
function softEdge(m, w, h, r) {
  let a = Float32Array.from(m);
  const blur = (get, set, len) => {
    let s = 0;
    const buf = new Float32Array(len);
    for (let i = 0; i < len; i++) buf[i] = get(i);
    for (let i = -r; i <= r; i++) s += buf[Math.min(len - 1, Math.max(0, i))];
    for (let i = 0; i < len; i++) {
      set(i, s / (2 * r + 1));
      s += buf[Math.min(len - 1, i + r + 1)] - buf[Math.max(0, i - r)];
    }
  };
  for (let pass = 0; pass < 2; pass++) {
    const t = new Float32Array(w * h);
    for (let y = 0; y < h; y++) blur(x => a[y * w + x], (x, v) => (t[y * w + x] = v), w);
    for (let x = 0; x < w; x++) blur(y => t[y * w + x], (y, v) => (a[y * w + x] = v), h);
  }
  // Keep the centre of the hole fully replaced.
  for (let p = 0; p < w * h; p++) if (m[p] && a[p] > 0.5) a[p] = Math.min(1, a[p] * 1.6);
  return a;
}
