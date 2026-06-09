// Z-PREPASS A/B on the real M5 Pro: does it beat the (already-shipped) sortObjects=true
// baseline, AND is it pixel-identical? Headed Chrome (hardware Metal, vsync off).
//   FPS: __mcDebug.gate().full (loop-fps @ resScale 1.0) with zPrepass off vs on,
//        sortObjects=true forced (the shipped baseline — prepass must beat THIS).
//   PIXEL: screenshots at a FROZEN camera. Take an off-vs-off pair as the AA/sun-drift
//        noise floor, then off-vs-on; if off-on ≈ off-off the prepass is pixel-clean,
//        if off-on >> noise floor it z-fights/changes the image (MSAA+EQUAL footgun).
import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.MC_PORT || '5173';
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch({
  executablePath: CHROME, headless: false,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
});
const domClick = (page, t) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').includes(x)); if (!b) throw new Error('no button ' + x); b.click(); }, t);
const b64 = (buf) => 'data:image/png;base64,' + buf.toString('base64');

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) { errs.push(e.message); console.log('[pageerror]', e.message); } });
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 1000 });
  await domClick(page, 'Settings'); await domClick(page, 'Balanced');
  await domClick(page, 'Mode');
  await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
  await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 80, null, { timeout: 240000, polling: 1000 });
  // frozen dense-land horizon (max opaque overdraw)
  const at = await page.evaluate(() => {
    const { world, player } = window.__mcDebug; const sea = world.params.terrain.waterOffset;
    let lx = 0, lz = 0, best = -1;
    for (let r = 0; r <= 480; r += 32) { for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const h = world.sampler(dx, dz).height; if (h > best) { best = h; lx = dx; lz = dz; } } if (best > sea + 12) break; }
    const surf = Math.max(best, sea);
    player.position.set(lx, surf + 2, lz); player.camera.position.set(lx, surf + 2, lz);
    player.camera.lookAt(lx + 400, surf + 14, lz + 120);
    window.__mcDebug.renderer.sortObjects = true;   // the shipped baseline — prepass must beat THIS
    return { lx, lz };
  });
  await page.waitForFunction((t) => window.__mcDebug.world.isLoadedAt(t.lx, t.lz), at, { timeout: 120000, polling: 1000 });
  await page.waitForFunction(() => { const n = window.__mcDebug.world.chunkCount; if (window.__s === n) return (window.__st = (window.__st || 0) + 1) >= 4; window.__s = n; window.__st = 0; return false; }, null, { timeout: 120000, polling: 1000 });
  await page.waitForTimeout(1500);

  // ---- FPS A/B ----
  const fpsOff = await page.evaluate(async () => { window.__mcDebug.zPrepass(false); return (await window.__mcDebug.gate({ settleMs: 1200, sampleMs: 3000 })).full; });
  const fpsOn = await page.evaluate(async () => { window.__mcDebug.zPrepass(true); return (await window.__mcDebug.gate({ settleMs: 1200, sampleMs: 3000 })).full; });
  await page.evaluate(() => window.__mcDebug.zPrepass(false));
  const fpsDelta = (fpsOn - fpsOff) / fpsOff * 100;

  // ---- PIXEL identity (frozen camera) ----
  await page.evaluate(() => window.__mcDebug.zPrepass(false));
  await page.waitForTimeout(800);
  const s1 = b64(await page.screenshot());           // off #1
  await page.waitForTimeout(1200);
  const s2 = b64(await page.screenshot());           // off #2 (noise floor: AA + sun drift)
  await page.evaluate(() => window.__mcDebug.zPrepass(true));
  await page.waitForTimeout(1200);
  const s3 = b64(await page.screenshot());           // on
  await page.evaluate(() => window.__mcDebug.zPrepass(false));

  const diff = await page.evaluate(async ([a, b, c]) => {
    const load = (d) => new Promise((res) => { const img = new Image(); img.onload = () => res(img); img.src = d; });
    const [ia, ib, ic] = await Promise.all([load(a), load(b), load(c)]);
    const cv = document.createElement('canvas'); cv.width = ia.width; cv.height = ia.height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const grab = (img) => { ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, cv.width, cv.height).data; };
    const da = grab(ia), db = grab(ib), dc = grab(ic);
    const count = (x, y) => { let n = 0, mx = 0; for (let i = 0; i < x.length; i += 4) { const m = Math.max(Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2])); if (m > 8) n++; if (m > mx) mx = m; } return { n, mx, total: x.length / 4 }; };
    return { noise: count(da, db), offOn: count(da, dc), dims: `${cv.width}x${cv.height}` };
  }, [s1, s2, s3]);

  console.log('\n===== Z-PREPASS A/B (real M5 Pro, Balanced, dense horizon, sortObjects=true baseline) =====');
  console.log(`  FPS  prepass off ${fpsOff.toFixed(1)}  →  on ${fpsOn.toFixed(1)}   (${fpsDelta >= 0 ? '+' : ''}${fpsDelta.toFixed(1)}% over the sort baseline)`);
  const nf = diff.noise.n / diff.noise.total * 100, of = diff.offOn.n / diff.offOn.total * 100;
  console.log(`  PIXEL (${diff.dims}): noise floor off-vs-off = ${nf.toFixed(3)}% (maxΔ ${diff.noise.mx});  off-vs-ON = ${of.toFixed(3)}% (maxΔ ${diff.offOn.mx})`);
  console.log(`  page errors: ${errs.length}`);
  console.log('  ---');
  const pixelClean = of <= Math.max(nf * 1.5, 0.1);
  const fpsWin = fpsDelta >= 8;
  if (fpsWin && pixelClean) console.log(`  → SHIP: +${fpsDelta.toFixed(1)}% over sort, pixel-clean (off-on ≈ noise floor).`);
  else if (!pixelClean) console.log(`  → DO NOT SHIP: off-vs-on (${of.toFixed(3)}%) exceeds noise floor (${nf.toFixed(3)}%) → the prepass changes the image (z-fight / MSAA-EQUAL). Pixel-identity FAILED.`);
  else console.log(`  → MARGINAL: only +${fpsDelta.toFixed(1)}% over the free sortObjects win — not worth the two-pass complexity. SHELVE (keep the flag off).`);
  console.log('==========================================================================================');
} finally { await browser.close(); }
