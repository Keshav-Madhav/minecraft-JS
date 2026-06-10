// Deterministic headed-Chrome fps A/B: fixed seed + fixed spot + gate() sampling.
import { chromium } from 'playwright-core';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = process.env.APP_URL || 'http://localhost:5199/';
const LABEL = process.env.LABEL || 'run';

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--disable-gpu-vsync', '--disable-frame-rate-limit', '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-features=CalculateNativeWinOcclusion'],
});
const domClick = (page, text) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === t || (x.textContent || '').includes(t));
  if (!b) throw new Error('no button: ' + t); b.click();
}, text);

try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => { const t = document.querySelector('.menu__tab'); return !!t && t.getBoundingClientRect().width > 0; }, null, { timeout: 180000, polling: 500 });

  // fixed world
  await page.evaluate(() => { const { world } = window.__mcDebug; world.params.seed = 4242; world.generate(false); });

  const measure = async (preset) => {
    await domClick(page, 'Settings');
    await domClick(page, preset);
    await page.evaluate(() => document.querySelector('.menu__resume')?.click());
    // fixed dense-land spot for seed 4242 (deterministic via the sampler)
    await page.evaluate(() => {
      const { world, player } = window.__mcDebug;
      const sea = world.params.terrain.waterOffset;
      let sx = 0, sz = 0;
      outer: for (let r = 1; r < 60; r++) for (let a = 0; a < 12; a++) {
        const x = Math.round(Math.cos(a / 12 * 6.283) * r * 40), z = Math.round(Math.sin(a / 12 * 6.283) * r * 40);
        let land = true;
        for (let k = 0; k < 8 && land; k++) {
          const px = x + Math.round(Math.cos(k / 8 * 6.283) * 300), pz = z + Math.round(Math.sin(k / 8 * 6.283) * 300);
          if (world.sampler(px, pz).height <= sea + 2) land = false;
        }
        if (land) { sx = x; sz = z; break outer; }
      }
      const h = world.sampler(sx, sz).height;
      player.position.set(sx, h + 2.5, sz);
      player.velocity.set(0, 0, 0);
      player.camera.position.copy(player.position);
      player.camera.lookAt(sx + 100, h - 6, sz + 100);
      player.camera.updateMatrixWorld(true);
    });
    // wait for the ring to fill (outstanding drained + chunk count stable)
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      return w.chunkCount > 200 && w.applyQueue?.length === 0 && w.pending?.length === 0;
    }, null, { timeout: 300000, polling: 1000 });
    await page.waitForTimeout(2500);
    const g = await page.evaluate(() => window.__mcDebug.gate({ settleMs: 1200, sampleMs: 3000 }));
    console.log(`${LABEL} ${preset.padEnd(9)} fps@1.0=${g.full.toFixed(0).padStart(4)}  fps@0.5=${g.half.toFixed(0).padStart(4)}  draws=${g.draws}  tris=${g.tris.toLocaleString()}`);
  };

  await measure('Balanced');
  await measure('Ultra');
} finally { await browser.close(); }
