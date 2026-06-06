// LOD far-terrain smoke test: boot headless, enable a preset with an LOD ring,
// assert tiles stream in (and hide under full chunks), teleport + regenerate to
// exercise the lifecycle, then capture screenshots for a visual pass.
import { chromium } from 'playwright-core';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5173/';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/lod-shots';

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const domClick = (page, text) => page.evaluate((t) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t || (b.textContent || '').includes(t));
  if (!btn) throw new Error('no button: ' + t);
  btn.click();
}, text);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 180000, polling: 1000 });
  console.log('game booted ✔');

  // Settings tab → Balanced preset (dd 12, lod 48).
  await domClick(page, 'Settings');
  await domClick(page, 'Balanced');
  console.log('preset applied: Balanced (dd 12, lod 48)');

  // LOD tiles should appear once the chunk backlog drains (LOD is strictly
  // lower priority, so this also proves chunk streaming still completes).
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return w.lodTileCount > 0 && w.lodGroup.children.length > 0;
  }, null, { timeout: 240000, polling: 1000 });

  // Wait for the ring to settle (tile count stable across 2s) — generous
  // timeout, SwiftShader is slow.
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    const n = w.lodGroup.children.length;
    if (window.__lodStable === n) return (window.__lodStableTicks = (window.__lodStableTicks || 0) + 1) >= 3;
    window.__lodStable = n; window.__lodStableTicks = 0;
    return false;
  }, null, { timeout: 240000, polling: 1000 });

  const stats = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    let visible = 0, hidden = 0, badSphere = 0, shadowed = 0, terrTris = 0;
    for (const m of w.lodGroup.children) {
      if (m.visible) visible++; else hidden++;
      // castShadow must stay off (shadow-pass node count); receiveShadow is
      // deliberately TRUE to match the chunks sharing the material (a mixed
      // value forced a per-draw program re-resolve — profiled CPU sink).
      if (m.castShadow || !m.receiveShadow) shadowed++;
      const bs = m.geometry.boundingSphere;
      if (!bs || !isFinite(bs.radius) || bs.radius <= 0) badSphere++;
      const idx = m.geometry.getIndex();
      terrTris += idx ? idx.count / 3 : 0;
    }
    return {
      chunks: w.chunkCount, lodTiles: w.lodTileCount, lodMeshes: w.lodGroup.children.length,
      visible, hidden, badSphere, shadowed, lodTris: Math.round(terrTris),
      groupY: w.lodGroup.position.y,
    };
  });
  console.log('lod stats:', JSON.stringify(stats));
  if (stats.lodMeshes === 0) throw new Error('no LOD meshes were built');
  if (stats.badSphere > 0) throw new Error(`${stats.badSphere} LOD meshes have invalid bounding spheres (NaN geometry?)`);
  if (stats.shadowed > 0) throw new Error('LOD meshes must not cast/receive shadows');
  if (stats.hidden === 0) console.log('note: no coverage-hidden tiles (ok if full ring is small vs tile grid)');
  if (!(stats.groupY < 0)) throw new Error('lodGroup must carry the downward anti-z-fight offset');

  // The stats overlay (visible while playing) should report lod tiles.
  await domClick(page, 'Mode');
  await page.evaluate(() => {
    // pick Survival via its mode card (also resumes)
    const card = [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival'));
    card.click();
  });
  await page.waitForFunction(() => {
    const el = document.getElementById('stats-overlay');
    return el && el.style.display !== 'none' && /lod \d+/.test(el.textContent || '');
  }, null, { timeout: 30000, polling: 500 });
  console.log('overlay:', (await page.textContent('#stats-overlay')).replace(/\n/g, ' | '));

  // ---- screenshots ----------------------------------------------------------
  // High vantage over spawn: full ring + LOD ring + transition in one frame.
  await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const px = player.position.x, pz = player.position.z;
    const surf = Math.max(world.sampler(Math.floor(px), Math.floor(pz)).height, world.params.terrain.waterOffset);
    player.position.set(px, surf + 3, pz);
    player.camera.position.copy(player.position);
    player.camera.position.y = surf + 160;
    player.camera.lookAt(px + 600, surf - 40, pz + 600);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOT_DIR}/lod-high.png` });

  // Ground level, horizon view.
  await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const px = player.position.x, pz = player.position.z;
    const surf = Math.max(world.sampler(Math.floor(px), Math.floor(pz)).height, world.params.terrain.waterOffset);
    player.camera.position.set(px, surf + 2, pz);
    player.camera.lookAt(px + 800, surf + 10, pz + 200);
  });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/lod-ground.png` });

  // ---- lifecycle: teleport far away — chunks must reflow, LOD must follow ---
  const tp = await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const x = player.position.x + 1500, z = player.position.z + 1500;
    const surf = Math.max(world.sampler(Math.floor(x), Math.floor(z)).height, world.params.terrain.waterOffset);
    player.position.set(x, surf + 3, z);
    player.velocity.set(0, 0, 0);
    player.camera.position.set(x, surf + 120, z);
    player.camera.lookAt(x + 600, surf - 30, z + 600);
    return { x: Math.round(x), z: Math.round(z) };
  });
  await page.waitForFunction((t) => window.__mcDebug.world.isLoadedAt(t.x, t.z), tp, { timeout: 240000, polling: 1000 });
  await page.waitForFunction(() => window.__mcDebug.world.lodTileCount > 0, null, { timeout: 240000, polling: 1000 });
  console.log('teleport reflow ✔ (chunks + LOD followed)');
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOT_DIR}/lod-teleport.png` });

  // ---- lifecycle: regenerate — old tiles must be disposed, new ones stream --
  const before = await page.evaluate(() => window.__mcDebug.world.lodGroup.children.length);
  await page.evaluate(() => { window.__mcDebug.world.params.seed = 4242; window.__mcDebug.world.generate(false); });
  const justAfter = await page.evaluate(() => window.__mcDebug.world.lodGroup.children.length);
  if (justAfter !== 0) throw new Error(`regenerate left ${justAfter} stale LOD meshes (leak)`);
  await page.waitForFunction(() => window.__mcDebug.world.lodGroup.children.length > 0, null, { timeout: 240000, polling: 1000 });
  console.log(`regenerate lifecycle ✔ (had ${before} meshes → 0 on generate → repopulated)`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOT_DIR}/lod-reseed.png` });

  console.log('LOD SMOKE TEST PASSED ✔');
} finally {
  await browser.close();
}
