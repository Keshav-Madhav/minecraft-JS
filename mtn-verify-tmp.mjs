// Verify the new mountain-range terrain (seed 4242).
// Tallest crest ~ world (-1400, -6200); range follows warped spine chains + foothills.
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';
const SHOT_DIR = '/tmp/worldgen-after';

const browser = await chromium.launch({
  executablePath: EXE,
  headless: false,
});

const log = (...a) => console.log('[mtn]', ...a);

const clickSeg = (page, label) => page.evaluate((t) => {
  const b = [...document.querySelectorAll('.ui-seg__btn')].find((x) => (x.textContent || '').trim() === t);
  if (!b) throw new Error('no seg btn: ' + t);
  b.click();
}, label);

const settle = async (page, capSec = 30) => {
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return (w.pending?.length === 0) && (w.outstanding === 0);
  }, null, { timeout: capSec * 1000, polling: 500 }).catch(() => log('settle: cap hit'));
  await page.waitForTimeout(2000);
};

const teleport = (page, px, py, pz, tx, ty, tz) => page.evaluate((p) => {
  const { player } = window.__mcDebug;
  player.position.set(p.px, p.py, p.pz);
  player.velocity.set(0, 0, 0);
  player.camera.position.copy(player.position);
  player.camera.lookAt(p.tx, p.ty, p.tz);
}, { px, py, pz, tx, ty, tz });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => log('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') log('[console.error]', m.text()); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000, polling: 500 });
  log('booted, chunkMap > 0');

  // Pin the seed.
  await page.evaluate(() => { const w = window.__mcDebug.world; w.params.seed = 4242; w.generate(false); });
  await page.waitForTimeout(3000);
  log('seed pinned to 4242');

  // Sample the terrain heights along the claimed spine to report numerically.
  const heights = await page.evaluate(() => {
    const { world } = window.__mcDebug;
    const sea = world.params.terrain.waterOffset;
    const pts = [];
    // Crest area + a transect along z from -4900 to -6800 at x=-1400.
    for (let z = -4600; z >= -7000; z -= 200) {
      const s = world.sampler(-1400, z);
      pts.push({ x: -1400, z, h: Math.round(s.height), biome: s.biome });
    }
    // Crossline at the crest, vary x.
    const cross = [];
    for (let x = -2200; x <= -600; x += 200) {
      const s = world.sampler(x, -6200);
      cross.push({ x, z: -6200, h: Math.round(s.height), biome: s.biome });
    }
    const crest = world.sampler(-1400, -6200);
    return { sea, crestH: Math.round(crest.height), crestBiome: crest.biome, transect: pts, cross };
  });
  log('sea level:', heights.sea, 'crest height:', heights.crestH, 'crest biome:', heights.crestBiome);
  log('transect (x=-1400, z varies):', JSON.stringify(heights.transect));
  log('crossline (z=-6200, x varies):', JSON.stringify(heights.cross));

  // ---- FAR: Ultra preset ----
  await clickSeg(page, 'Ultra');
  log('Ultra preset applied');
  teleport(page, -1400, 320, -4900, -1400, 220, -6200);
  // Let LOD ring + chunks stream for the far view.
  await page.waitForFunction(() => {
    const w = window.__mcDebug.world;
    return (w.lodBuiltCount ?? 0) > 0;
  }, null, { timeout: 120000, polling: 1000 }).catch(() => log('far: no lod built (cap)'));
  await settle(page, 30);
  await page.waitForTimeout(4000);
  teleport(page, -1400, 320, -4900, -1400, 220, -6200);
  await page.waitForTimeout(1500);
  const farStats = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    return { chunks: w.chunkCount, lodTiles: w.lodTileCount, lodBuilt: w.lodBuiltCount };
  });
  log('far stats:', JSON.stringify(farStats));
  await page.screenshot({ path: `${SHOT_DIR}/mountains-far.png` });
  log('mountains-far.png captured');

  // ---- MID ----
  teleport(page, -1400, 260, -5600, -1400, 220, -6200);
  await settle(page, 30);
  await page.waitForTimeout(2000);
  teleport(page, -1400, 260, -5600, -1400, 220, -6200);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOT_DIR}/mountains-mid.png` });
  log('mountains-mid.png captured');

  // ---- NEAR: Balanced preset, view peak from far side ----
  await clickSeg(page, 'Balanced');
  log('Balanced preset applied');
  teleport(page, -1400, 200, -6450, -1400, 240, -6200);
  await settle(page, 30);
  await page.waitForTimeout(2000);
  // re-aim at the crest
  teleport(page, -1400, 200, -6450, -1400, 240, -6200);
  await page.waitForTimeout(1500);
  const nearStats = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    return { chunks: w.chunkCount, pending: w.pending?.length, outstanding: w.outstanding };
  });
  log('near stats:', JSON.stringify(nearStats));
  await page.screenshot({ path: `${SHOT_DIR}/mountains-near.png` });
  log('mountains-near.png captured');

  log('DONE');
} catch (e) {
  log('ERROR', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
