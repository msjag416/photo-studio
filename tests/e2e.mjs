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
  const browser = await pw[engine].launch();
  const ctx = await browser.newContext({ ...DEVICES[devName], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
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

  await page.goto(URL_);
  await step('home', async () => { await page.locator('.tile').first().waitFor(); });

  await step('open-photo', async () => {
    await page.locator('#fileEdit').setInputFiles(PHOTO);
    await page.locator('#editor.active').waitFor();
    await idle();
    await page.locator('[data-act=bg]').waitFor();
  });

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

  if (errors.length) results.push({ tag, name: 'console', ok: false, err: errors.slice(0, 3).join(' | ') });
  await browser.close();
}

for (const engine of ENGINES) {
  for (const dev of Object.keys(DEVICES)) {
    try { await run(engine, dev); } catch (e) { results.push({ tag: `${engine}-${dev}`, name: 'launch', ok: false, err: e.message.split('\n')[0] }); }
  }
}
const lines = results.map(r => `${r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(18)} ${r.name.padEnd(20)} ${r.ok ? r.ms + ' ms' : r.err}`);
fs.writeFileSync(`${OUT}/results.txt`, lines.join('\n') + '\n');
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.tag.padEnd(18)} ${r.name.padEnd(20)} ${r.ok ? r.ms + ' ms' : r.err}`);
process.exit(results.every(r => r.ok) ? 0 : 1);
