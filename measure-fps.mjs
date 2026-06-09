// Scene-cost measurement: reports DRAW CALLS + TRIANGLES (renderer.info — CPU-side
// submission counts that are GPU-INDEPENDENT and valid even under headless
// SwiftShader) at representative views/presets, so we can see where the GPU work
// is before picking an optimization. Also smoke-runs __mcDebug.gate() to confirm
// the tool works end-to-end — but its fps verdict is MEANINGLESS here (SwiftShader
// is a CPU rasterizer, always fill-bound); the real verdict needs a real GPU.
import { chromium } from 'playwright-core';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5173/';
const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const domClick = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t || (x.textContent || '').includes(t));
  if (!b) throw new Error('no button: ' + t); b.click();
}, text);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 1000 });
  await domClick(page, 'Settings');
  await domClick(page, 'Balanced');
  await domClick(page, 'Mode');
  await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
  await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 100, null, { timeout: 240000, polling: 1000 });
  await page.waitForTimeout(2000);

  const view = async (label, place) => {
    await page.evaluate(place);
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => {
      const r = window.__mcDebug.renderer.info.render, w = window.__mcDebug.world;
      return { draws: r.calls, tris: r.triangles, chunks: w.chunkCount, lod: w.lodTileCount, compressed: w.compressedChunkCount };
    });
    console.log(`${label.padEnd(16)} draws=${String(m.draws).padStart(5)}  tris=${m.tris.toLocaleString().padStart(12)}  chunks=${m.chunks}  lod=${m.lod}  compressed=${m.compressed}`);
    return m;
  };

  const highVantage = () => {
    const { world, player } = window.__mcDebug;
    const px = player.position.x, pz = player.position.z;
    const surf = Math.max(world.sampler(Math.floor(px), Math.floor(pz)).height, world.params.terrain.waterOffset);
    player.position.set(px, surf + 3, pz); player.camera.position.set(px, surf + 160, pz);
    player.camera.lookAt(px + 600, surf - 40, pz + 600);
  };
  const groundView = () => {
    const { world, player } = window.__mcDebug;
    const px = player.position.x, pz = player.position.z;
    const surf = Math.max(world.sampler(Math.floor(px), Math.floor(pz)).height, world.params.terrain.waterOffset);
    player.camera.position.set(px, surf + 2, pz); player.camera.lookAt(px + 800, surf + 10, pz + 200);
  };

  console.log('\n=== scene cost (draws + triangles are GPU-independent / valid headless) ===');
  await view('high-vantage', highVantage);
  await view('ground-horizon', groundView);

  // Bump draw distance to see how triangle load scales (the RAM lever's domain too).
  await page.evaluate(() => { window.__mcDebug.world.drawDistance = 20; window.__mcDebug.world.forceRescan(); });
  await page.waitForTimeout(6000);
  await view('high dd=20', highVantage);

  console.log('\n=== gate() smoke (SwiftShader — verdict NOT representative of a real GPU) ===');
  const g = await page.evaluate(async () => await window.__mcDebug.gate({ settleMs: 800, sampleMs: 1500 }));
  console.log('gate returned:', JSON.stringify(g));
  console.log('\n(^ run `await __mcDebug.gate()` on your real GPU for the verdict that counts.)');
} finally {
  await browser.close();
}
