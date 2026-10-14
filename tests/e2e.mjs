// End-to-end test: opens the app in real browser engines at iPad and iPhone sizes and
// goes through every main step with a real photo of a person, saving a screenshot of each.
// Run: node tests/e2e.mjs [http://localhost:8080/] [outDir] [engines]
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }

const URL_ = process.argv[2] || 'http://localhost:8080/';
const OUT = process.argv[3] || 'test-shots';
const ENGINES = (process.argv[4] || 'chromium,webkit').split(',');
const PHOTO = path.resolve(path.dirname(new URL(import.meta.url).pathname), process.env.PHOTO || 'person.png');
const DEVICES = {
  ipad: { viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
};

fs.mkdirSync(OUT, { recursive: true });
const results = [];

async function run(engine, devName) {
  // HEADED=1 shows a real window (on GitHub inside a virtual screen), which gives WebKit a
  // working graphics chip (WebGL) for the face finder.
  const browser = await pw[engine].launch({ headless: !process.env.HEADED });
  const ctx = await browser.newContext({ ...DEVICES[devName], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/^INFO:|XNNPACK/.test(m.text())) errors.push(m.text()); });
  const tag = `${engine}-${devName}`;
  let n = 0;
  const shot = async name => page.screenshot({ path: `${OUT}/${tag}-${String(++n).padStart(2, '0')}-${name}.png` });
  const step = async (name, fn) => {
    const t = Date.now();
    try {
      await fn();
      const errBox = await page.locator('#error').isVisible();
      if (errBox) throw new Error('Error box shown: ' + (await page.locator('#errorText').textContent()) + ' / ' + (await page.locator('#errorDetails').textContent()));
      await shot(name);
      results.push({ tag, name, ok: true, ms: Date.now() - t });
    } catch (e) {
      await shot(name + '-FAILED').catch(() => {});
      results.push({ tag, name, ok: false, err: e.message.split('\n')[0] });
    }
  };
  const idle = () => page.waitForFunction(() => document.querySelector('#busy').hidden, null, { timeout: 180000 });
  // Paint with a "finger" along image-space points on a brush screen.
  // pts and size are in 512-px photo terms, so the same marks land on any screen size.
  let paint = async (pts, size) => {
    const box = await page.locator('#brushStage').boundingBox();
    const info = await page.evaluate(() => {
      const st = document.querySelector('#brushStage').getBoundingClientRect();
      return { w: st.width, h: st.height };
    });
    const iw = Number(process.env.PHOTO_SIZE || 512), ih = iw;
    pts = pts.map(([x, y]) => [x * iw / 512, y * iw / 512]);
    const s = Math.min((info.w - 24) / iw, (info.h - 24) / ih);
    const ox = (info.w - iw * s) / 2, oy = (info.h - ih * s) / 2;
    const P = ([x, y]) => [box.x + ox + x * s, box.y + oy + y * s];
    await page.locator('#brushSize').fill(String(Math.round((size * s * iw) / 512)));
    await page.mouse.move(...P(pts[0]));
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(...P(p), { steps: 8 });
    await page.mouse.up();
  };

  // Read the pixels of the brush screen around photo points (512-px photo terms).
  const sample = (pts, rad) => page.evaluate(({ pts, rad, iw }) => {
    const st = document.querySelector('#brushStage').getBoundingClientRect();
    const s = Math.min((st.width - 24) / iw, (st.height - 24) / iw);
    const ox = (st.width - iw * s) / 2, oy = (st.height - iw * s) / 2;
    const cv = document.querySelector('#brushView');
    const dpr = cv.width / st.width;
    const c = cv.getContext('2d');
    const k = iw / 512;
    return pts.map(([x, y]) => {
      const R = Math.max(1, Math.round(rad * k * s * dpr));
      const X = Math.round((ox + x * k * s) * dpr), Y = Math.round((oy + y * k * s) * dpr);
      return Array.from(c.getImageData(X - R, Y - R, 2 * R, 2 * R).data);
    });
  }, { pts, rad, iw: Number(process.env.PHOTO_SIZE || 512) });
  const diff = (a, b) => { let t = 0, n = 0; for (let i = 0; i < a.length; i += 4) { t += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n += 3; } return t / n; };
  // Close-up of the face on the brush screen.
  const faceShot = async name => {
    const box = await page.locator('#brushStage').boundingBox();
    const iw = Number(process.env.PHOTO_SIZE || 512);
    const s = Math.min((box.width - 24) / iw, (box.height - 24) / iw) * iw / 512;
    const ox = box.x + (box.width - 512 * s) / 2, oy = box.y + (box.height - 512 * s) / 2;
    await page.screenshot({ path: `${OUT}/${tag}-face-${name}.png`, clip: { x: ox + 150 * s, y: oy + 20 * s, width: 150 * s, height: 175 * s } });
  };

  // A real two-finger pinch (Chrome only: sent as touch events through Chrome's testing tools).
  const pinch = async (cx, cy, from, to, steps = 12) => {
    const cdp = await page.context().newCDPSession(page);
    const pts = d => [{ x: cx - d / 2, y: cy, id: 0 }, { x: cx + d / 2, y: cy, id: 1 }];
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
    for (let i = 1; i <= steps; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / steps) });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await page.waitForTimeout(150);
  };
  // Average brightness of the middle of a canvas (to check the photo is still showing).
  const canvasMiddle = sel => page.evaluate(sel => {
    const c = document.querySelector(sel), g = c.getContext('2d');
    const d = g.getImageData(c.width / 2 - 20, c.height / 2 - 20, 40, 40).data;
    let t = 0; for (let i = 0; i < d.length; i += 4) t += d[i] + d[i + 1] + d[i + 2];
    return t / (d.length / 4) / 3;
  }, sel);

  await page.goto(URL_);
  await step('home', async () => { await page.locator('.tile').first().waitFor(); });

  await step('open-photo', async () => {
    await page.locator('#fileEdit').setInputFiles(PHOTO);
    await page.locator('#editor.active').waitFor();
    await idle();
    await page.locator('[data-act=bg]').waitFor();
  });

  if (engine === 'chromium') {
    await step('pinch-zoom-editor', async () => {
      const r = await page.locator('#stage').boundingBox();
      const before = await canvasMiddle('#view');
      await pinch(r.x + r.width / 2, r.y + r.height / 2, 80, 260);
      if (await page.locator('#fitBtn').isHidden()) throw new Error('Fit button did not appear after zooming');
      const after = await canvasMiddle('#view');
      if (Math.abs(after - 239) < 3) throw new Error('The photo disappeared after zooming');
      await shot('editor-zoomed');
      await page.locator('#fitBtn').click();
      await page.waitForTimeout(150);
      if (!(await page.locator('#fitBtn').isHidden())) throw new Error('Fit did not reset the zoom');
      if (Math.abs((await canvasMiddle('#view')) - before) > 2) throw new Error('Picture looks different after Fit');
    });

    await step('pinch-zoom-remove-blemish', async () => {
      await page.locator('[data-act=erase]').click();
      await page.locator('#brush.active').waitFor();
      const r = await page.locator('#brushStage').boundingBox();
      const iw = Number(process.env.PHOTO_SIZE || 512);
      const s = Math.min((r.width - 24) / iw, (r.height - 24) / iw) * iw / 512;
      const ox = r.x + (r.width - 512 * s) / 2, oy = r.y + (r.height - 512 * s) / 2;
      // The small name tag on the suit (about 300, 357) stands in for a blemish.
      const tag = [300, 357];
      const fx = ox + tag[0] * s, fy = oy + tag[1] * s;
      const before = await page.evaluate(([x, y]) => { const c = document.querySelector('#brushView'), k = c.width / c.getBoundingClientRect().width, r = c.getBoundingClientRect(); return Array.from(c.getContext('2d').getImageData((x - r.x) * k - 3, (y - r.y) * k - 3, 6, 6).data); }, [fx, fy]);
      await pinch(fx, fy, 60, 180); // zoom in 3x around the tag
      if (await page.locator('#brushFit').isHidden()) throw new Error('Fit button did not appear on the brush screen');
      await shot('brush-zoomed');
      // While zoomed, one finger paints over the tag (it is now 3x bigger on screen).
      await page.locator('#brushSize').fill('60');
      await page.mouse.move(fx - 60, fy);
      await page.mouse.down();
      await page.mouse.move(fx + 60, fy, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(300);
      await idle();
      await shot('brush-zoomed-removed');
      await page.locator('#brushFit').click();
      await page.waitForTimeout(150);
      const after = await page.evaluate(([x, y]) => { const c = document.querySelector('#brushView'), k = c.width / c.getBoundingClientRect().width, r = c.getBoundingClientRect(); return Array.from(c.getContext('2d').getImageData((x - r.x) * k - 3, (y - r.y) * k - 3, 6, 6).data); }, [fx, fy]);
      const d = diff(before, after);
      if (d < 8) throw new Error(`The spot did not change after removing it while zoomed (${d.toFixed(1)})`);
      await page.locator('#brushDone').click();
      await page.locator('#editor.active').waitFor();
    });
  }

  await step('remove-background', async () => {
    await page.locator('[data-act=bg]').click();
    await page.waitForTimeout(300);
    await idle();
    await page.locator('#refineBtn').waitFor({ state: 'visible', timeout: 10000 });
  });

  await step('refine-edges', async () => {
    await page.locator('#refineBtn').click();
    await page.locator('#brush.active').waitFor();
    // Erase a strip at the top-left of the hair, then restore part of it.
    await paint([[150, 40], [200, 30], [250, 25]], 40);
    await page.locator('#brushModes [data-mode=restore]').click();
    await paint([[230, 25], [250, 25]], 40);
    await shot('refine-screen');
    await page.locator('#brushDone').click();
    await page.locator('#editor.active').waitFor();
  });

  await step('remove-object', async () => {
    await page.locator('[data-act=erase]').click();
    await page.locator('#brush.active').waitFor();
    // Paint over the round mission patch on the suit.
    await paint([[150, 360], [195, 360], [195, 380], [150, 385], [150, 405], [195, 405], [150, 405], [150, 360]], 40);
    await page.waitForTimeout(300);
    await idle();
    await shot('object-removed-screen');
    await page.locator('#brushDone').click();
    await page.locator('#editor.active').waitFor();
  });

  // ---------- Retouch: use every tool on its spot, check that only that spot changed ----------
  const RETOUCH = [
    { tool: 'smooth', opt: 'smoother', size: 22, strength: 90, at: [226, 84], rad: 6, strokes: [[[206, 80], [246, 80]], [[206, 88], [246, 88]], [[186, 122], [200, 130]]] },
    { tool: 'whiten', size: 8, strength: 90, at: [224, 144], rad: 3, strokes: [[[210, 144], [238, 144]]] },
    { tool: 'eyes', color: '#2F9467', size: 7, strength: 90, at: [204, 101], rad: 2, strokes: [[[203, 101], [206, 101]], [[244, 102], [247, 102]]] },
    { tool: 'brighten', size: 10, strength: 90, at: [205, 111], rad: 3, strokes: [[[198, 111], [212, 111]], [[238, 112], [252, 112]]] },
    { tool: 'makeup', opt: 'lips', color: '#C2185B', size: 6, strength: 90, at: [223, 150], rad: 2, strokes: [[[212, 149], [235, 149]], [[214, 139], [233, 139]], [[212, 144], [236, 144]]], keep: [[220, 146], 1] },
    { tool: 'makeup', opt: 'blush', color: '#E8709A', size: 16, strength: 90, at: [195, 127], rad: 4, strokes: [[[190, 125], [200, 129]], [[250, 125], [260, 129]]] },
    { tool: 'hair', color: '#E6C77D', size: 16, strength: 90, at: [225, 46], rad: 5, strokes: [[[195, 40], [255, 40], [255, 52], [195, 52], [195, 62], [255, 62]]] },
    { tool: 'reshape', opt: 'move', size: 30, strength: 70, at: [262, 150], rad: 4, strokes: [[[264, 150], [254, 150]]] },
    { tool: 'reshape', opt: 'restore', size: 30, strength: 90, at: [262, 150], rad: 4, strokes: [[[262, 145], [262, 155]]] },
  ];
  await step('retouch-open', async () => {
    await page.locator('[data-retouch=smooth]').click();
    await page.locator('#brush.active').waitFor();
    await faceShot('0-before');
  });
  const control = [[300, 30]]; // plain background, must never change
  let controlBefore;
  for (const t of RETOUCH) {
    const name = 'retouch-' + (t.opt && t.tool !== 'smooth' ? t.opt : t.tool);
    await step(name, async () => {
      if (!controlBefore) controlBefore = await sample(control, 6);
      await page.locator(`#retouchTools [data-tool=${t.tool}]`).click();
      if (t.opt) await page.locator(`#retouchOpts [data-opt=${t.opt}]`).click();
      if (t.color) await page.locator(`#retouchColors [data-color="${t.color}"]`).click();
      await page.locator('#brushStrength').fill(String(t.strength));
      const before = await sample([t.at], t.rad);
      const keepBefore = t.keep ? (await sample([t.keep[0]], t.keep[1]))[0] : null;
      for (const st of t.strokes) await paint(st, t.size);
      await page.waitForTimeout(100);
      const after = await sample([t.at], t.rad);
      const d = diff(before[0], after[0]);
      await faceShot(name);
      if (d < 2) throw new Error(`${name} changed its spot by only ${d.toFixed(2)} (expected a visible change)`);
      if (t.keep) {
        // A spot that must NOT change (lip colour brushed straight across the teeth).
        const k0 = keepBefore, k1 = (await sample([t.keep[0]], t.keep[1]))[0];
        const kd = diff(k0, k1);
        if (kd > 4) throw new Error(`${name} also coloured the teeth (${kd.toFixed(1)})`);
      }
      const c = diff(controlBefore[0], (await sample(control, 6))[0]);
      if (c > 0.5) throw new Error(`${name} changed the background too (${c.toFixed(2)})`);
    });
  }
  await step('retouch-undo-apply', async () => {
    // Undo inside the screen takes back the last stroke, then apply with the check mark.
    await page.locator('#brushUndo').click();
    await page.locator('#brushDone').click();
    await page.locator('#editor.active').waitFor();
    // Editor undo and redo swap the whole retouch in and out.
    await page.locator('#undoBtn').click();
    await page.waitForTimeout(200);
    await shot('retouch-editor-undo');
    await page.locator('#redoBtn').click();
    await page.waitForTimeout(200);
  });

  await step('remove-precision', async () => {
    // Paint a small dot (radius 12 px) on a full-size 2000 px photo, remove it, and check that
    // nothing more than 5 px outside the dot changed.
    const res = await page.evaluate(async () => {
      const u = await import('/js/util.js'); const ai = await import('/js/ai.js');
      const img = await u.fileToCanvas(await (await fetch('/tests/person.png')).blob(), 2000);
      const big = u.makeCanvas(2000, 2000); big.getContext('2d').drawImage(img, 0, 0, 2000, 2000);
      const paint = u.makeCanvas(2000, 2000), pc = paint.getContext('2d');
      const cx = 820, cy = 510, R = 12; // a spot on the forehead
      pc.fillStyle = '#f00'; pc.beginPath(); pc.arc(cx, cy, R, 0, 7); pc.fill();
      const out = await ai.removeObjects(big, paint);
      const a = big.getContext('2d').getImageData(cx - 80, cy - 80, 160, 160).data, b = out.getContext('2d').getImageData(cx - 80, cy - 80, 160, 160).data;
      let far = 0, maxD = 0;
      for (let y = 0; y < 160; y++) for (let x = 0; x < 160; x++) {
        const i = (y * 160 + x) * 4, dd = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        const dist = Math.hypot(x - 80, y - 80);
        if (dd > 6) { maxD = Math.max(maxD, dist); if (dist > R + 5) far++; }
      }
      return { far, maxD };
    });
    if (res.far > 0) throw new Error(`Removal reached ${res.maxD.toFixed(1)} px from the centre of a 12 px dot (${res.far} pixels too far)`);
    results.push({ tag, name: `  removal reached ${res.maxD.toFixed(1)} px for a 12 px dot`, ok: true, ms: 0 });
  });

  await step('outline', async () => {
    await page.locator('[data-tool=outline]').click();
    await page.locator('.switch-row input').check();
    await page.waitForTimeout(500);
  });

  await step('shadow', async () => {
    await page.locator('[data-back]').click();
    await page.locator('[data-tool=shadow]').click();
    await page.locator('.switch-row input').check();
    await page.locator('[data-back]').click();
    await page.waitForTimeout(300);
  });

  await step('adjust-filter', async () => {
    await page.locator('[data-tool=filters]').click();
    await page.locator('.filter-item', { hasText: 'Vivid' }).click();
    await page.locator('[data-back]').click();
  });

  await step('text', async () => {
    await page.locator('#addTextBtn').click();
    await page.locator('#textScreen.active').waitFor();
    await page.locator('#textInput').fill('Hello there');
    await page.locator('#fontRow [data-font=bold]').click();
    await page.locator('#textColors [data-color="#F7D44C"]').click();
    await shot('text-screen');
    await page.locator('#textDone').click();
    await page.locator('#editor.active').waitFor();
    await page.waitForTimeout(300);
  });

  await step('undo', async () => {
    const count = () => page.evaluate(() => document.querySelectorAll('#layerList .layer-row').length);
    await page.locator('#undoBtn').click();
    await page.waitForTimeout(300);
    await page.locator('#layersBtn').click();
    const c = await count();
    await shot('layers-after-undo');
    await page.locator('#layersSheet [data-close]').click();
    if (c !== 1) throw new Error('Expected 1 layer after undo, found ' + c);
    await page.locator('#redoBtn').click();
    await page.waitForTimeout(300);
  });

  for (const fmt of ['png', 'jpg']) {
    await step('save-' + fmt, async () => {
      await page.locator('#saveBtn').click();
      await page.locator(`#formatBtns [data-format=${fmt}]`).click();
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#downloadBtn').click()]);
      const file = `${OUT}/${tag}-saved.${fmt}`;
      await dl.saveAs(file);
      const size = fs.statSync(file).size;
      if (size < 5000) throw new Error('Saved file looks empty: ' + size + ' bytes');
    });
  }

  await step('back-home-recent', async () => {
    await page.locator('#backBtn').click();
    await page.locator('#home.active').waitFor();
    await page.locator('.recent-item').first().waitFor({ timeout: 20000 });
  });

  await step('reopen-project', async () => {
    await page.locator('.recent-item img').first().click();
    await page.locator('#editor.active').waitFor();
    await idle();
    await page.locator('#layersBtn').click();
    const c = await page.evaluate(() => document.querySelectorAll('#layerList .layer-row').length);
    await page.locator('#layersSheet [data-close]').click();
    if (c !== 2) throw new Error('Expected 2 layers in the reopened project, found ' + c);
  });

  // ---------- Faces: pick a face, edits stay on that face only ----------
  const TWO = path.resolve(path.dirname(PHOTO), 'two-people.jpg');
  const THREE = path.resolve(path.dirname(PHOTO), 'three-people.jpg');
  // Screen point of a picture pixel in the editor (the photo fills the canvas).
  const editorPt = async (x, y, W, H) => {
    const r = await page.locator('#stage').boundingBox();
    const s = Math.min((r.width - 48) / W, (r.height - 48) / H);
    return [r.x + (r.width - W * s) / 2 + x * s, r.y + (r.height - H * s) / 2 + y * s];
  };
  // Paint on the brush screen using picture pixels.
  const paintImg = async (pts, size, W, H) => {
    const r = await page.locator('#brushStage').boundingBox();
    const s = Math.min((r.width - 24) / W, (r.height - 24) / H);
    const P = ([x, y]) => [r.x + (r.width - W * s) / 2 + x * s, r.y + (r.height - H * s) / 2 + y * s];
    await page.locator('#brushSize').fill(String(Math.round(size * s)));
    await page.mouse.move(...P(pts[0]));
    await page.mouse.down();
    for (const q of pts.slice(1)) await page.mouse.move(...P(q), { steps: 12 });
    await page.mouse.up();
  };
  // Compare the saved picture with the original photo inside a box (in the browser, same decoder).
  const boxDiff = (savedB64, original, box) => page.evaluate(async ({ savedB64, original, box }) => {
    const load = async src => { const b = await (await fetch(src)).blob(); const bm = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; c.getContext('2d').drawImage(bm, 0, 0); return c.getContext('2d').getImageData(box.x, box.y, box.w, box.h).data; };
    const a = await load('data:image/png;base64,' + savedB64), b = await load(original);
    let t = 0;
    for (let i = 0; i < a.length; i += 4) t += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    return t / (a.length / 4 * 3);
  }, { savedB64, original, box });
  const FACE_A = { x: 175, y: 70, w: 100, h: 115 }, FACE_B = { x: 748, y: 70, w: 100, h: 115 };

  // The face finder needs WebGL 2 (every recent iPhone, iPad and computer browser has it).
  // Some test computers don't, so record it and skip the face steps there instead of failing.
  const gl2 = await page.evaluate(() => !!document.createElement('canvas').getContext('webgl2'));
  if (!gl2) {
    results.push({ tag, name: 'faces SKIPPED: this test computer has no WebGL 2', ok: true, skip: true, ms: 0 });
    await browser.close();
    return;
  }
  await step('faces-two-found', async () => {
    await page.locator('#backBtn').click();
    await page.locator('#home.active').waitFor();
    await page.locator('#fileEdit').setInputFiles(TWO);
    await page.locator('#editor.active').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-face]').length === 2, null, { timeout: 90000 });
  });

  await step('faces-tap-to-select', async () => {
    await page.mouse.click(...(await editorPt(797, 125, 1024, 512)));
    await page.waitForTimeout(300);
    const on2 = await page.locator('[data-face].on').textContent();
    await page.mouse.click(...(await editorPt(225, 125, 1024, 512)));
    await page.waitForTimeout(300);
    const on1 = await page.locator('[data-face].on').textContent();
    if (on2.trim() !== 'Face 2' || on1.trim() !== 'Face 1') throw new Error(`Tapping faces selected "${on2}" then "${on1}"`);
  });

  await step('faces-retouch-only-selected', async () => {
    // Face 1 is selected; brush across BOTH faces. Face 2 must not change.
    await page.locator('[data-retouch=brighten]').click();
    await page.locator('#brush.active').waitFor();
    await page.locator('#brushStrength').fill('100');
    await paintImg([[190, 135], [500, 135], [820, 135]], 30, 1024, 512);
    await page.waitForTimeout(200);
    await shot('faces-brush-across-both');
    await page.locator('#brushDone').click();
    await page.locator('#editor.active').waitFor();
  });

  await step('brows-auto-fix', async () => {
    await page.locator('[data-tool=brows]').click();
    await page.locator('.brow-grid').waitFor();
    await page.locator('.big-btn.wide').click();
    await page.waitForTimeout(400);
    if (!(await page.locator('#panel .slider-row', { hasText: 'Strength' }).count())) throw new Error('Strength slider missing after Auto Fix');
  });

  await step('brows-style-and-sliders', async () => {
    await page.locator('[data-style=higharch]').click();
    await idle();
    await page.waitForTimeout(400);
    const on = await page.locator('.brow-item.on').textContent();
    if (!on.includes('High Arch')) throw new Error('High Arch not selected: ' + on);
    const th = page.locator('#panel .slider-row', { hasText: 'Thickness' }).locator('input');
    await th.fill('130');
    await th.dispatchEvent('change');
    await page.waitForTimeout(300);
    await page.locator('[data-col="#3A2A21"]').click();
    await page.waitForTimeout(300);
  });

  await step('brows-before-after', async () => {
    const btn = page.locator('[data-before]');
    const b = await btn.boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(300);
    await shot('brows-holding-before');
    await page.mouse.up();
    await page.waitForTimeout(300);
  });

  await step('brows-undo-redo-reset', async () => {
    await page.locator('#undoBtn').click();   // undo the colour
    await page.waitForTimeout(200);
    await page.locator('#redoBtn').click();
    await page.waitForTimeout(200);
    await page.locator('[data-tool=brows]').click();
    await page.locator('[data-reset]').click();
    await page.waitForTimeout(200);
    if (await page.locator('#panel .slider-row', { hasText: 'Strength' }).count()) throw new Error('Brows still set after Reset');
    await page.locator('[data-style=bold]').click();
    await idle();
    await page.waitForTimeout(300);
  });

  await step('faces-save-other-face-untouched', async () => {
    await page.locator('#saveBtn').click();
    await page.locator('#formatBtns [data-format=png]').click();
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#downloadBtn').click()]);
    const file = `${OUT}/${tag}-two-faces.png`;
    await dl.saveAs(file);
    const b64 = fs.readFileSync(file).toString('base64');
    const orig = '/tests/two-people.jpg';
    const dB = await boxDiff(b64, orig, FACE_B), dA = await boxDiff(b64, orig, FACE_A);
    if (dA < 1) throw new Error(`Face 1 did not change (${dA.toFixed(2)})`);
    if (dB > 0.5) throw new Error(`Face 2 changed (${dB.toFixed(2)}) but only Face 1 was edited`);
    results.push({ tag, name: `  face1 changed ${dA.toFixed(1)}, face2 ${dB.toFixed(2)}`, ok: true, ms: 0 });
  });

  await step('faces-three-found', async () => {
    await page.locator('#backBtn').click();
    await page.locator('#home.active').waitFor();
    await page.locator('#fileEdit').setInputFiles(THREE);
    await page.locator('#editor.active').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-face]').length >= 3, null, { timeout: 90000 });
  });

  if (errors.length) results.push({ tag, name: 'console', ok: false, err: errors.slice(0, 3).join(' | ') });
  await browser.close();
}

for (const engine of ENGINES) {
  for (const dev of Object.keys(DEVICES)) {
    try { await run(engine, dev); } catch (e) { results.push({ tag: `${engine}-${dev}`, name: 'launch', ok: false, err: e.message.split('\n')[0] }); }
  }
}
const lines = results.map(r => `${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(18)} ${r.name.padEnd(20)} ${r.ok ? r.ms + ' ms' : r.err}`);
fs.writeFileSync(`${OUT}/results.txt`, lines.join('\n') + '\n');
for (const r of results) console.log(`${r.skip ? 'SKIP' : r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(18)} ${r.name.padEnd(20)} ${r.ok ? r.ms + ' ms' : r.err}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
