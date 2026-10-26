// Healing: rebuild a filled-in hole from real pieces of the photo, so it stays sharp.
// The AI's first guess is good at the overall shape but tends to look smeared. Here every
// small square ("patch") around the hole is matched to the most similar patch elsewhere in the
// picture (the "PatchMatch" method used by professional editors), and the hole is rebuilt from
// those real patches. This is done from a small version of the picture up to full size.
//
// rgb: Float32Array of the picture (3 values per pixel), already holding the first guess
// inside the hole. hole: Uint8Array (1 = hole). Returns a new Float32Array.
const PR = 3; // patch radius: patches are 7 x 7 pixels

export function healHole(rgb, hole, W, H) {
  // Picture pyramid, from full size down to small.
  const levels = [{ rgb, hole, W, H }];
  while (true) {
    const L = levels[levels.length - 1];
    let hx0 = L.W, hy0 = L.H, hx1 = -1, hy1 = -1;
    for (let y = 0; y < L.H; y++) for (let x = 0; x < L.W; x++) if (L.hole[y * L.W + x]) { hx0 = Math.min(hx0, x); hx1 = Math.max(hx1, x); hy0 = Math.min(hy0, y); hy1 = Math.max(hy1, y); }
    if (hx1 < 0 || Math.max(hx1 - hx0, hy1 - hy0) < 10 || Math.min(L.W, L.H) < 48 || levels.length > 6) break;
    levels.push(down(L));
  }
  let nn = null; // best-match field from the smaller level
  for (let li = levels.length - 1; li >= 0; li--) {
    const L = levels[li];
    const fine = li === 0;
    const st = prepare(L);
    if (!st) return rgb;
    if (nn) { st.nn = upNN(nn, levels[li + 1], L, st); vote(L, st); }
    else initNN(L, st);
    const em = fine ? 2 : 4, pm = fine ? 3 : 4;
    for (let e = 0; e < em; e++) {
      for (let k = 0; k < pm; k++) patchMatch(L, st, k);
      vote(L, st);
    }
    nn = { nn: st.nn, list: st.list, W: L.W, H: L.H, tIndex: st.tIndex };
  }
  return levels[0].rgb;
}

function down(L) {
  const W = Math.max(1, L.W >> 1), H = Math.max(1, L.H >> 1);
  const rgb = new Float32Array(W * H * 3), hole = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, n = 0, h = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const sx = Math.min(L.W - 1, 2 * x + dx), sy = Math.min(L.H - 1, 2 * y + dy), i = sy * L.W + sx;
      r += L.rgb[i * 3]; g += L.rgb[i * 3 + 1]; b += L.rgb[i * 3 + 2]; n++;
      if (L.hole[i]) h = 1;
    }
    const o = y * W + x;
    rgb[o * 3] = r / n; rgb[o * 3 + 1] = g / n; rgb[o * 3 + 2] = b / n; hole[o] = h;
  }
  return { rgb, hole, W, H };
}

// Which patches are being rebuilt (they touch the hole) and which can be copied from
// (completely outside the hole).
function prepare(L) {
  const { W, H, hole } = L;
  const near = new Uint8Array(W * H); // touches the hole
  const bad = new Uint8Array(W * H);  // can't be a source
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!hole[y * W + x]) continue;
    for (let dy = -PR; dy <= PR; dy++) for (let dx = -PR; dx <= PR; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) { near[yy * W + xx] = 1; bad[yy * W + xx] = 1; }
    }
  }
  const list = [], tIndex = new Int32Array(W * H).fill(-1);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (near[y * W + x]) { tIndex[y * W + x] = list.length; list.push(y * W + x); }
  // A source patch must be fully inside the picture and fully outside the hole.
  const ok = new Uint8Array(W * H);
  let okCount = 0;
  for (let y = PR; y < H - PR; y++) for (let x = PR; x < W - PR; x++) if (!bad[y * W + x]) { ok[y * W + x] = 1; okCount++; }
  if (!okCount || !list.length) return null;
  return { list, tIndex, ok, nn: new Int32Array(list.length), d: new Float32Array(list.length) };
}

let seed = 9001;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

function randomSource(L, st) {
  for (let t = 0; t < 60; t++) {
    const i = Math.floor(rnd() * L.W * L.H);
    if (st.ok[i]) return i;
  }
  for (let i = 0; i < st.ok.length; i++) if (st.ok[i]) return i;
  return 0;
}

// How different two patches are (sum of squared colour differences).
function dist(L, p, q, best) {
  const { W, H, rgb } = L;
  const px = p % W, py = (p / W) | 0, qx = q % W, qy = (q / W) | 0;
  let d = 0;
  for (let dy = -PR; dy <= PR; dy++) {
    const ay = py + dy, by = qy + dy;
    if (ay < 0 || ay >= H) continue;
    for (let dx = -PR; dx <= PR; dx++) {
      const ax = px + dx;
      if (ax < 0 || ax >= W) continue;
      const a = (ay * W + ax) * 3, b = (by * W + qx + dx) * 3;
      const r = rgb[a] - rgb[b], g = rgb[a + 1] - rgb[b + 1], bl = rgb[a + 2] - rgb[b + 2];
      d += r * r + g * g + bl * bl;
    }
    if (d > best) return d; // already worse than the best one found
  }
  return d;
}

function initNN(L, st) {
  for (let t = 0; t < st.list.length; t++) { st.nn[t] = randomSource(L, st); st.d[t] = dist(L, st.list[t], st.nn[t], Infinity); }
}

// Carry the matches up from the smaller picture (twice the position, plus the offset).
function upNN(c, Lc, L, st) {
  const nn = new Int32Array(st.list.length);
  for (let t = 0; t < st.list.length; t++) {
    const p = st.list[t], x = p % L.W, y = (p / L.W) | 0;
    const cx = Math.min(Lc.W - 1, x >> 1), cy = Math.min(Lc.H - 1, y >> 1);
    const ci = c.tIndex[cy * Lc.W + cx];
    let q = -1;
    if (ci >= 0) {
      const cq = c.nn[ci], qx = Math.min(L.W - 1, 2 * (cq % Lc.W) + (x & 1)), qy = Math.min(L.H - 1, 2 * ((cq / Lc.W) | 0) + (y & 1));
      q = qy * L.W + qx;
    }
    nn[t] = q >= 0 && st.ok[q] ? q : randomSource(L, st);
  }
  for (let t = 0; t < st.list.length; t++) st.d[t] = dist(L, st.list[t], nn[t], Infinity);
  return nn;
}

function patchMatch(L, st, iter) {
  const { W, H } = L;
  const n = st.list.length, rev = iter % 2 === 1, s = rev ? 1 : -1;
  for (let k = 0; k < n; k++) {
    const t = rev ? n - 1 - k : k;
    const p = st.list[t], x = p % W, y = (p / W) | 0;
    let best = st.nn[t], bd = st.d[t];
    // Propagation: a neighbour's match, shifted by one, is often a good match here too.
    for (const [nx, ny] of [[x + s, y], [x, y + s]]) {
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ti = st.tIndex[ny * W + nx];
      if (ti < 0) continue;
      const q = st.nn[ti] - (nx - x) - (ny - y) * W;
      if (q < 0 || q >= W * H || !st.ok[q]) continue;
      const d = dist(L, p, q, bd);
      if (d < bd) { bd = d; best = q; }
    }
    // Random search around the best match, in smaller and smaller circles.
    let rad = Math.max(W, H);
    const bx = () => best % W, by = () => (best / W) | 0;
    while (rad >= 1) {
      const qx = Math.round(bx() + (rnd() * 2 - 1) * rad), qy = Math.round(by() + (rnd() * 2 - 1) * rad);
      if (qx >= 0 && qy >= 0 && qx < W && qy < H) {
        const q = qy * W + qx;
        if (st.ok[q]) { const d = dist(L, p, q, bd); if (d < bd) { bd = d; best = q; } }
      }
      rad >>= 1;
    }
    st.nn[t] = best; st.d[t] = bd;
  }
}

// Rebuild the hole: each hole pixel becomes the weighted average of what the matching
// patches that cover it say it should be (closer matches count more).
function vote(L, st) {
  const { W, H, rgb, hole } = L;
  const acc = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
  // Typical match difference, to turn differences into weights.
  let mean = 0;
  for (let t = 0; t < st.list.length; t++) mean += st.d[t];
  mean = mean / st.list.length + 1;
  for (let t = 0; t < st.list.length; t++) {
    const p = st.list[t], q = st.nn[t], px = p % W, py = (p / W) | 0, qx = q % W, qy = (q / W) | 0;
    const w = Math.exp(-st.d[t] / mean);
    for (let dy = -PR; dy <= PR; dy++) {
      const ay = py + dy;
      if (ay < 0 || ay >= H) continue;
      for (let dx = -PR; dx <= PR; dx++) {
        const ax = px + dx;
        if (ax < 0 || ax >= W) continue;
        const a = ay * W + ax;
        if (!hole[a]) continue;
        const b = ((qy + dy) * W + qx + dx) * 3;
        acc[a * 3] += rgb[b] * w; acc[a * 3 + 1] += rgb[b + 1] * w; acc[a * 3 + 2] += rgb[b + 2] * w; wsum[a] += w;
      }
    }
  }
  for (let a = 0; a < W * H; a++) {
    if (!hole[a] || !wsum[a]) continue;
    rgb[a * 3] = acc[a * 3] / wsum[a]; rgb[a * 3 + 1] = acc[a * 3 + 1] / wsum[a]; rgb[a * 3 + 2] = acc[a * 3 + 2] / wsum[a];
  }
}
