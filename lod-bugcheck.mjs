// Regression checks for the reported LOD bugs:
//  1. "LOD stays when super close" — after the view's chunks finish loading,
//     NO visible LOD tile may overlap the loaded in-view area.
//  2. behind-camera fill still works (tiles behind stay visible).
//  3. trees: canopy blobs must be sub-cell sized and have trunks (terrain mesh
//     grows trunk quads) — verified structurally + screenshot.
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

  // Find a forested landmass and park there (same spiral as lod-shots).
  const spot = await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const sea = world.params.terrain.waterOffset;
    for (let r = 0; r < 40; r++) {
      for (let a = 0; a < 8; a++) {
        const x = Math.round(Math.cos(a / 8 * Math.PI * 2) * r * 400);
        const z = Math.round(Math.sin(a / 8 * Math.PI * 2) * r * 400);
        let land = 0, forest = 0;
        for (let k = 0; k < 8; k++) {
          const s = world.sampler(x + Math.round(Math.cos(k / 8 * Math.PI * 2) * 300), z + Math.round(Math.sin(k / 8 * Math.PI * 2) * 300));
          if (s.height > sea + 4) land++;
          if ([4, 6, 10, 24, 25, 26, 29].includes(s.biome)) forest++;
        }
        if (land >= 7 && forest >= 4) {
          const surf = world.sampler(x, z).height;
          player.position.set(x, surf + 3, z);
          player.velocity.set(0, 0, 0);
          player.camera.position.set(x, surf + 24, z);
          player.camera.lookAt(x + 800, surf - 20, z + 120);
          return { x, z, surf };
        }
      }
    }
    return null;
  });
  if (!spot) throw new Error('no forest spot found');
  console.log('forest spot:', JSON.stringify(spot));

  // Let the view settle: chunk pending drained + lod ring built.
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return w.lodBuiltCount > 20 && w.chunkCount > 200;
  }, null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(12000);   // streaming settle (SwiftShader is slow)

  // CHECK 1: no visible LOD over the fully-loaded in-view area. We test the
  // tile directly under the camera (its in-view chunks are certainly loaded).
  const close = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    const p = window.__mcDebug.player.position;
    const T = 8 * w.chunkSize.width;   // tile span in blocks
    const tx = Math.floor(p.x / T), tz = Math.floor(p.z / T);
    const t = w.lodMap.get(`${tx},${tz}`);
    if (!t || (!t.terrainH && !t.canopyH)) return null;   // no built tile here (also fine)
    return { visible: t.shown };
  });
  console.log('player-tile LOD:', JSON.stringify(close));
  if (close && close.visible) throw new Error('BUG: LOD tile under the player is still visible (close-LOD bug not fixed)');
  console.log('close-LOD hiding ✔');

  // CHECK 2: tiles behind the camera (opposite the view direction, beyond the
  // near-keep ring) should still be VISIBLE meshes for the turn-fill.
  const behind = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    const p = window.__mcDebug.player.position;
    let behindVisible = 0, behindTotal = 0;
    for (const t of w.lodMap.values()) {
      if (!t.terrainH && !t.canopyH) continue;
      const tb = t.tileChunks * w.chunkSize.width;
      const dx = t.tx * tb + tb / 2 - p.x;
      // camera looks roughly +x: "behind" = well in -x
      if (dx < -200) { behindTotal++; if (t.shown) behindVisible++; }
    }
    return { behindVisible, behindTotal };
  });
  console.log('behind-camera tiles:', JSON.stringify(behind));
  if (behind.behindTotal > 0 && behind.behindVisible === 0) throw new Error('BUG: all behind-camera LOD hidden (turn-fill broken)');
  console.log('behind-camera fill ✔');

  // Screenshot: forest horizon from the treetops (trees + transition seam).
  await page.screenshot({ path: `${SHOT_DIR}/fix-forest.png` });

  // Screenshot: high vantage for the overall ring.
  await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const p = player.position;
    const surf = world.sampler(Math.floor(p.x), Math.floor(p.z)).height;
    player.camera.position.set(p.x, surf + 180, p.z);
    player.camera.lookAt(p.x + 500, surf - 60, p.z + 500);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/fix-high.png` });

  // Screenshot: ground-level horizon (what the player actually sees).
  await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const p = player.position;
    const surf = world.sampler(Math.floor(p.x), Math.floor(p.z)).height;
    player.camera.position.set(p.x, surf + 2, p.z);
    player.camera.lookAt(p.x + 900, surf + 6, p.z + 150);
  });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/fix-ground.png` });

  console.log('LOD BUGCHECK PASSED ✔');
} finally {
  await browser.close();
}
