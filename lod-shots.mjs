// Visual pass for the LOD ring: find interesting biomes via the sampler, park
// the camera above them, capture screenshots (transition seam, canopy, ocean).
import { chromium } from 'playwright-core';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5199/';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/lod-shots';

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 180000, polling: 1000 });

  await page.evaluate((t) => {
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(t)).click();
  }, 'Settings');
  await page.evaluate((t) => {
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t).click();
  }, 'Balanced');

  // Close the menu so the HUD-free scene renders (click Play/Resume).
  await page.evaluate(() => document.querySelector('.menu__resume').click());

  // Find a spot where LAND fills the view to ~700m: spiral-sample the world for
  // a column whose 8 ring samples at 400m are all above sea (big landmass).
  const spot = await page.evaluate(() => {
    const { world } = window.__mcDebug;
    const sea = world.params.terrain.waterOffset;
    for (let r = 0; r < 40; r++) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(Math.cos(a / 8 * Math.PI * 2) * r * 400);
        const z = Math.round(Math.sin(a / 8 * Math.PI * 2) * r * 400);
        let land = 0, forest = 0;
        for (let k = 0; k < 8; k++) {
          const s = world.sampler(x + Math.round(Math.cos(k / 8 * Math.PI * 2) * 400), z + Math.round(Math.sin(k / 8 * Math.PI * 2) * 400));
          if (s.height > sea + 4) land++;
          if ([4, 6, 10, 24, 25, 26, 29].includes(s.biome)) forest++;   // taiga/forest/warm/jungle/dark/birch/redwood
        }
        if (land >= 7 && forest >= 2) return { x, z };
      }
    }
    return { x: 0, z: 0 };
  });
  console.log('vantage spot:', JSON.stringify(spot));

  const goto = (x, z, dy, lx, ly, lz) => page.evaluate((p) => {
    const { world, player } = window.__mcDebug;
    const surf = Math.max(world.sampler(Math.floor(p.x), Math.floor(p.z)).height, world.params.terrain.waterOffset);
    player.position.set(p.x, surf + p.dy, p.z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    player.camera.lookAt(p.x + p.lx, surf + p.dy + p.ly, p.z + p.lz);
    return surf;
  }, { x, z, dy, lx, ly, lz });

  // Let the ring fill at the spot first.
  await goto(spot.x, spot.z, 120, 700, -130, 250);
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return w.isLoadedAt(Math.round(w.children[0]?.position?.x ?? 0), 0) || true;   // just wait via timeout below
  }, null, { timeout: 5000, polling: 1000 }).catch(() => {});
  // Wait until chunk pending drains AND some lod meshes applied near here.
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return w.lodGroup.children.length > 20 && w.chunkCount > 150;
  }, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(8000);   // let applies settle (SwiftShader ~few fps)

  await goto(spot.x, spot.z, 120, 700, -130, 250);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/v-high.png` });
  console.log('v-high done');

  await goto(spot.x, spot.z, 3, 800, 30, 80);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/v-ground.png` });
  console.log('v-ground done');

  // Looking straight along the transition: camera at the full-ring edge height.
  await goto(spot.x, spot.z, 40, 400, -20, 400);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/v-seam.png` });
  console.log('v-seam done');

  const stats = await page.evaluate(() => {
    const el = document.getElementById('stats-overlay');
    return (el?.textContent || '').replace(/\n/g, ' | ');
  });
  console.log('overlay:', stats);
} finally {
  await browser.close();
}
