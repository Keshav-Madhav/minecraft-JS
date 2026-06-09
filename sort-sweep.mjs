// Verify renderer.sortObjects=true across presets before shipping it unconditionally.
// The +17% was measured at Balanced (fragment-bound); confirm Low (vertex/CPU-bound,
// shadows off) and MAX (vertex-bound, postfx) don't REGRESS from the per-frame sort
// CPU cost. Real M5 Pro (headed Chrome, vsync off). In-page toggles renderer.sortObjects
// and reuses __mcDebug.gate().full (loop-fps @ resolutionScale 1.0) under each setting.
import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.MC_PORT || '5175';
const URL = `http://localhost:${PORT}/`;

const browser = await chromium.launch({
  executablePath: CHROME, headless: false,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
});
const domClick = (page, t) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').includes(x)); if (!b) throw new Error('no button ' + x); b.click(); }, t);
const place = () => {
  const { world, player } = window.__mcDebug; const sea = world.params.terrain.waterOffset;
  let lx = 0, lz = 0, best = -1;
  for (let r = 0; r <= 480; r += 32) { for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const h = world.sampler(dx, dz).height; if (h > best) { best = h; lx = dx; lz = dz; } } if (best > sea + 12) break; }
  const surf = Math.max(best, sea);
  player.position.set(lx, surf + 2, lz); player.camera.position.set(lx, surf + 2, lz);
  player.camera.lookAt(lx + 400, surf + 14, lz + 120);
  return { lx, lz };
};

async function sweep(preset) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) console.log('[pageerror]', e.message); });
  try {
    await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 1000 });
    await domClick(page, 'Settings'); await domClick(page, preset);
    await domClick(page, 'Mode');
    await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
    await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 80, null, { timeout: 300000, polling: 1000 });
    const at = await page.evaluate(place);
    await page.waitForFunction((t) => window.__mcDebug.world.isLoadedAt(t.lx, t.lz), at, { timeout: 180000, polling: 1000 });
    await page.waitForFunction(() => { const n = window.__mcDebug.world.chunkCount; if (window.__s === n) return (window.__st = (window.__st || 0) + 1) >= 4; window.__s = n; window.__st = 0; return false; }, null, { timeout: 180000, polling: 1000 });
    await page.waitForTimeout(1500);
    const run = (s) => page.evaluate(async (sort) => { window.__mcDebug.renderer.sortObjects = sort; return (await window.__mcDebug.gate({ settleMs: 1200, sampleMs: 3000 })).full; }, s);
    const off = await run(false);
    const on = await run(true);
    const tris = await page.evaluate(() => window.__mcDebug.renderer.info.render.triangles);
    return { preset, off, on, delta: (on - off) / off * 100, tris };
  } finally { await page.close(); }
}

try {
  const results = [];
  for (const p of ['Low', 'Balanced', 'MAX']) { try { results.push(await sweep(p)); } catch (e) { console.log(`[${p}] FAILED: ${e.message}`); } }
  console.log('\n===== sortObjects=true preset sweep (real M5 Pro, dense horizon, resScale 1.0) =====');
  for (const r of results) {
    const verdict = r.delta >= 3 ? 'WIN' : r.delta <= -3 ? 'REGRESSION → must preset-gate' : 'neutral';
    console.log(`  ${r.preset.padEnd(9)} off ${r.off.toFixed(0).padStart(5)} → on ${r.on.toFixed(0).padStart(5)} fps  (${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}%)  tris ${r.tris.toLocaleString()}  [${verdict}]`);
  }
  const anyRegress = results.some((r) => r.delta <= -3);
  console.log('  ---');
  console.log(anyRegress ? '  → at least one preset REGRESSES → ship sortObjects=true GATED to fragment-bound presets only' : '  → no preset regresses → ship sortObjects=true UNCONDITIONALLY');
  console.log('====================================================================================');
} finally { await browser.close(); }
