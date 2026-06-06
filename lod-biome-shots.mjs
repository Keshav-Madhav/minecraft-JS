// Biome-targeted visual pass: snowy forest (snow-capped LOD trees), ocean
// (depth-shaded seabed under the water plane), and a green forest horizon.
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
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Settings')).click();
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Balanced').click();
    document.querySelector('.menu__resume').click();
  });

  // Find a spot for each scene by sampling the deterministic world.
  // snowy: taiga/snowy/mountains (4, 2, 31) with land; ocean: mostly submerged.
  const findSpot = (kinds, wantLand) => page.evaluate(({ kinds, wantLand }) => {
    const { world } = window.__mcDebug;
    const sea = world.params.terrain.waterOffset;
    for (let r = 1; r < 60; r++) {
      for (let a = 0; a < 12; a++) {
        const x = Math.round(Math.cos(a / 12 * Math.PI * 2) * r * 350);
        const z = Math.round(Math.sin(a / 12 * Math.PI * 2) * r * 350);
        let hit = 0, land = 0;
        for (let k = 0; k < 6; k++) {
          const s = world.sampler(x + Math.round(Math.cos(k / 6 * Math.PI * 2) * 350), z + Math.round(Math.sin(k / 6 * Math.PI * 2) * 350));
          if (kinds.includes(s.biome)) hit++;
          if (s.height > sea + 3) land++;
        }
        if (hit >= 4 && (wantLand ? land >= 5 : land <= 1)) return { x, z };
      }
    }
    return null;
  }, { kinds, wantLand });

  const shoot = async (name, spot, dy, lx, ly, lz) => {
    if (!spot) { console.log(`${name}: no spot found, skipped`); return; }
    await page.evaluate(({ spot, dy, lx, ly, lz }) => {
      const { world, player } = window.__mcDebug;
      const surf = Math.max(world.sampler(spot.x, spot.z).height, world.params.terrain.waterOffset);
      player.position.set(spot.x, surf + dy, spot.z);
      player.velocity.set(0, 0, 0);
      player.camera.position.copy(player.position);
      player.camera.lookAt(spot.x + lx, surf + dy + ly, spot.z + lz);
    }, { spot, dy, lx, ly, lz });
    // settle: wait for streaming to catch up at the new location
    await page.waitForTimeout(20000);
    await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
    console.log(`${name} ✔ at ${spot.x},${spot.z}`);
  };

  await shoot('biome-snowy', await findSpot([2, 4, 31], true), 60, 700, -50, 200);
  await shoot('biome-ocean', await findSpot([0, 19, 20, 21, 22], false), 40, 800, -30, 150);
  await shoot('biome-forest', await findSpot([6, 10, 26], true), 50, 750, -40, 250);
  console.log('done');
} finally {
  await browser.close();
}
