// REAL-GPU fragment-vs-vertex gate. Unlike the other *.mjs (SwiftShader, for
// determinism), this launches HEADED Google Chrome with hardware Metal and vsync
// DISABLED, so __mcDebug.gate()'s loop-fps@1.0-vs-0.5 ratio actually reflects this
// machine's GPU (Apple M5 Pro). Runs the gate at Balanced (typical) and MAX (heavy
// regime) over dense land, and reports the verdict + draws/tris at each.
import { chromium } from 'playwright-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL || 'http://localhost:5173/';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,                       // headed → real GPU context (not SwiftShader)
  args: [
    '--disable-gpu-vsync',               // let the loop exceed refresh so the ratio is meaningful
    '--disable-frame-rate-limit',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion',
  ],
});
const domClick = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t || (x.textContent || '').includes(t));
  if (!b) throw new Error('no button: ' + t); b.click();
}, text);

const place = () => {
  // stand at ground level over the nearest tall LAND column, looking at the horizon
  const { world, player } = window.__mcDebug;
  const sea = world.params.terrain.waterOffset;
  let lx = 0, lz = 0, best = -1;
  for (let r = 0; r <= 480; r += 32) {
    for (const [dx, dz] of [[r, 0], [0, r], [-r, 0], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
      const h = world.sampler(dx, dz).height;
      if (h > best) { best = h; lx = dx; lz = dz; }
    }
    if (best > sea + 12) break;
  }
  const surf = Math.max(best, sea);
  player.position.set(lx, surf + 2, lz);
  player.camera.position.set(lx, surf + 2, lz);
  player.camera.lookAt(lx + 400, surf + 18, lz + 120);
  return { lx, lz, surf };
};

async function gateAt(preset) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) console.log(`[pageerror] ${e.message}`); });
  try {
    await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 1000 });
    await domClick(page, 'Settings');
    await domClick(page, preset);
    await domClick(page, 'Mode');
    await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
    await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 80, null, { timeout: 240000, polling: 1000 });
    const at = await page.evaluate(place);
    await page.waitForFunction((t) => window.__mcDebug.world.isLoadedAt(t.lx, t.lz), at, { timeout: 120000, polling: 1000 });
    // let streaming settle so the gate measures a steady scene, not a gen burst
    await page.waitForFunction(() => { const w = window.__mcDebug.world; const n = w.chunkCount; if (window.__s === n) return (window.__st = (window.__st || 0) + 1) >= 4; window.__s = n; window.__st = 0; return false; }, null, { timeout: 120000, polling: 750 });
    await page.waitForTimeout(1500);
    const g = await page.evaluate(async () => {
      const r0 = window.__mcDebug.renderer.info.render;
      const baseDraws = r0.calls, baseTris = r0.triangles;
      const res = await window.__mcDebug.gate({ settleMs: 1500, sampleMs: 3000 });
      return { ...res, baseDraws, baseTris, ultra: window.__mcDebug.renderer.capabilities ? undefined : undefined };
    });
    console.log(`\n[${preset}] fps @1.0=${g.full.toFixed(0)}  @0.5=${g.half.toFixed(0)}  ratio=${g.ratio.toFixed(2)}  draws=${g.draws}  tris=${g.tris.toLocaleString()}`);
    return { preset, ...g };
  } finally {
    await page.close();
  }
}

try {
  const results = [];
  for (const preset of ['Balanced', 'MAX']) results.push(await gateAt(preset));

  console.log('\n========================= REAL-GPU GATE (Apple M5 Pro, Metal, vsync off) =========================');
  for (const r of results) {
    // Interpret: high fps + ratio≈1 → CPU/loop-bound (GPU idle). low-ish fps + ratio≈1 → vertex/triangle-bound.
    // ratio≥1.4 → fragment-bound. Flag vsync-capping if both samples sit near a refresh multiple.
    let read;
    if (r.ratio >= 1.4) read = 'FRAGMENT-BOUND → z-prepass · aniso 8→2 · cheap LOD material · god-rays half-res';
    else if (r.full > 200 && r.ratio <= 1.15) read = 'CPU/LOOP-BOUND (GPU idle at this load) → mesher typed-Acc · least-loaded dispatch · per-frame CPU wins';
    else if (r.ratio <= 1.15) read = 'VERTEX/TRIANGLE-BOUND → face-orientation culling · cave/occlusion culling · LOD wall-merge';
    else read = 'MIXED → start with cheap fragment wins (aniso, god-rays half-res), re-measure';
    console.log(`${r.preset.padEnd(9)} fps ${r.full.toFixed(0).padStart(5)} → ${r.half.toFixed(0).padStart(5)} (×${r.ratio.toFixed(2)})  tris ${r.tris.toLocaleString().padStart(11)}  draws ${String(r.draws).padStart(4)}`);
    console.log(`          ${read}`);
  }
  console.log('==================================================================================================');
} finally {
  await browser.close();
}
