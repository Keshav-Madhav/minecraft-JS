// Full-ring fill benchmark: teleport at Ultra and time until the ENTIRE draw
// ring is generated (pending + outstanding drained). Directly measures worker
// throughput, unlike the ±2 playable-bubble metric (latency-floor bound).
//   WORKERS=4 node lod-fill.mjs   # spoof hardwareConcurrency to force a count
import { chromium } from 'playwright-core';

const WORKERS = Number(process.env.WORKERS || 0);   // 0 = native
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1300,800'] });
try {
  const page = await (await browser.newContext()).newPage();
  if (WORKERS > 0) {
    // world.ts: count = min(8, hardwareConcurrency - 2) → spoof hc = W + 2
    await page.addInitScript(`Object.defineProperty(navigator, 'hardwareConcurrency', { value: ${WORKERS + 2} });`);
  }
  await page.goto('http://localhost:5199/');
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000 });
  await page.evaluate(() => {
    [...document.querySelectorAll('.ui-seg__btn')].find((b) => (b.textContent || '').trim() === 'Ultra')?.click();
  });
  await page.waitForTimeout(2000);

  const r = await page.evaluate(async () => {
    const { world, player } = window.__mcDebug;
    const nWorkers = world.workers.length;
    const x = player.position.x + 5000, z = player.position.z + 5000;
    const surf = Math.max(world.sampler(Math.floor(x), Math.floor(z)).height, world.params.terrain.waterOffset);
    player.position.set(x, surf + 20, z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    const t0 = performance.now();
    let peak = 0;
    await new Promise((res) => {
      const check = () => {
        peak = Math.max(peak, world.pending.length + world.outstanding);
        // drained AND something actually streamed (rescan latency guard)
        if (peak > 50 && world.pending.length === 0 && world.outstanding === 0) res();
        else setTimeout(check, 50);
      };
      check();
    });
    return {
      nWorkers,
      fillMs: Math.round(performance.now() - t0),
      chunks: world.chunkMap.size,
      peakQueue: peak,
    };
  });
  console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
