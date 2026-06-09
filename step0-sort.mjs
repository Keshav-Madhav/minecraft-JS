// Z-PREPASS STEP 0 (free gate, no source changes): does front-to-back ordering
// even help on this GPU? If `renderer.sortObjects = true` recovers little fps at
// Balanced over a dense horizon, the GPU's hierarchical-Z already eats the
// overdraw and a z-prepass is pointless (or a net loss). Headed Chrome = real
// M5 Pro (Metal), vsync off. Reuses __mcDebug.gate() to sample loop-fps@1.0
// under sortObjects=false vs true (renderer is exposed on __mcDebug).
import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL || `http://localhost:${process.env.MC_PORT || '5175'}/`;

const browser = await chromium.launch({
  executablePath: CHROME, headless: false,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-features=CalculateNativeWinOcclusion'],
});
const domClick = (page, t) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').includes(x)); if (!b) throw new Error('no button ' + x); b.click(); }, t);

try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) console.log('[pageerror]', e.message); });
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 1000 });
  await domClick(page, 'Settings'); await domClick(page, 'Balanced');
  await domClick(page, 'Mode');
  await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
  await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 80, null, { timeout: 240000, polling: 1000 });
  // dense-land horizon (max overdraw): nearest tall column, look slightly down at the horizon
  const at = await page.evaluate(() => {
    const { world, player } = window.__mcDebug; const sea = world.params.terrain.waterOffset;
    let lx = 0, lz = 0, best = -1;
    for (let r = 0; r <= 480; r += 32) { for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) { const h = world.sampler(dx, dz).height; if (h > best) { best = h; lx = dx; lz = dz; } } if (best > sea + 12) break; }
    const surf = Math.max(best, sea);
    player.position.set(lx, surf + 2, lz); player.camera.position.set(lx, surf + 2, lz);
    player.camera.lookAt(lx + 400, surf + 14, lz + 120);
    return { lx, lz };
  });
  await page.waitForFunction((t) => window.__mcDebug.world.isLoadedAt(t.lx, t.lz), at, { timeout: 120000, polling: 1000 });
  await page.waitForFunction(() => { const n = window.__mcDebug.world.chunkCount; if (window.__s === n) return (window.__st = (window.__st || 0) + 1) >= 4; window.__s = n; window.__st = 0; return false; }, null, { timeout: 120000, polling: 750 });
  await page.waitForTimeout(1500);

  const run = async (sort) => page.evaluate(async (s) => {
    window.__mcDebug.renderer.sortObjects = s;
    const g = await window.__mcDebug.gate({ settleMs: 1200, sampleMs: 3000 });  // we use g.full = loop-fps @ resolutionScale 1.0
    return g.full;
  }, sort);

  const off = await run(false);
  const on = await run(true);
  await page.evaluate(() => { window.__mcDebug.renderer.sortObjects = false; });  // restore engine default
  const delta = (on - off) / off * 100;

  console.log('\n===== Z-PREPASS STEP 0 — sortObjects A/B (real M5 Pro, Balanced, dense horizon, resScale 1.0) =====');
  console.log(`  sortObjects=false : ${off.toFixed(1)} fps`);
  console.log(`  sortObjects=true  : ${on.toFixed(1)} fps`);
  console.log(`  delta             : ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`);
  console.log('  ---');
  if (delta >= 10) console.log('  → ≥10%: overdraw is REAL and unmanaged → a z-prepass is worth prototyping. PROCEED.');
  else if (delta >= 4) console.log('  → 4-10%: marginal/ambiguous. The sort proxy underestimates a true prepass; prototype to settle it.');
  else console.log('  → <4%: the GPU early-Z already eats the overdraw → a z-prepass likely will NOT help (or net loss). SHELVE unless targeting heavier configs.');
  console.log('=================================================================================================');
} finally {
  await browser.close();
}
