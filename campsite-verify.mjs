// Verify campsite tent fix on seed 4242. Two campsites: (1227,496) and (236,1385).
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';
const SHOT = '/tmp/worldgen-after';

const browser = await chromium.launch({ executablePath: EXE, headless: false });
const log = (...a) => console.log(...a);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, { timeout: 60000 });
  log('booted, chunks present');

  // PIN SEED
  await page.evaluate(() => { const w = window.__mcDebug.world; w.params.seed = 4242; w.generate(false); });
  await page.waitForTimeout(3000);
  log('seed pinned to 4242');

  // Close menu so the scene renders.
  await page.evaluate(() => { const r = document.querySelector('.menu__resume'); if (r) r.click(); }).catch(() => {});

  // Balanced preset.
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.ui-seg__btn')].find((x) => x.textContent.trim() === 'Balanced');
    if (b) b.click();
  });
  log('Balanced preset clicked');
  await page.evaluate(() => { const r = document.querySelector('.menu__resume'); if (r) r.click(); }).catch(() => {});
  await page.waitForTimeout(2000);

  // Settle by waiting for chunkCount to be stable across polls (pending/outstanding are private).
  const settle = async () => {
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      const n = w.chunkCount;
      if (window.__cc === n) return (window.__ccTicks = (window.__ccTicks || 0) + 1) >= 4;
      window.__cc = n; window.__ccTicks = 0;
      return false;
    }, { timeout: 30000, polling: 500 }).catch(() => log('settle timed out (continuing)'));
    await page.evaluate(() => { window.__cc = -1; window.__ccTicks = 0; });
    await page.waitForTimeout(2000);
  };

  const inspect = (cx, cz) => page.evaluate(({ cx, cz }) => {
    const { world, BLOCK_IDS } = window.__mcDebug;
    const id2name = {};
    for (const [k, v] of Object.entries(BLOCK_IDS)) id2name[v] = k;
    const g = (x, y, z) => world.getBlockId(x, y, z);
    const nm = (x, y, z) => { const id = g(x, y, z); return id2name[id] ?? `#${id}`; };
    // Find floor: first solid scanning down from 140 at center.
    let baseY = null;
    for (let y = 140; y > 0; y--) { const id = g(cx, y, cz); if (id && id !== BLOCK_IDS.air) { baseY = y; break; } }
    const RIDGE = baseY + 4;
    const rep = { center: [cx, cz], floorY: baseY, ridgeY: RIDGE };
    rep.hearth = nm(cx, baseY, cz);
    rep.campfire = nm(cx, baseY + 1, cz);
    // ridge row (apex along z=cz+5): block at peak height per dx
    rep.ridgeRow = {};
    for (let dx = -3; dx <= 3; dx++) rep.ridgeRow[`dx${dx}`] = nm(cx + dx, RIDGE - Math.abs(dx), cz + 5);
    // back gable wall (cz+7) at body level
    rep.backGable = [];
    for (let dx = -3; dx <= 3; dx++) rep.backGable.push(nm(cx + dx, baseY + 2, cz + 7));
    // front opening (cz+3) at body level — should be mostly air
    rep.frontBody = [];
    for (let dx = -3; dx <= 3; dx++) rep.frontBody.push(nm(cx + dx, baseY + 2, cz + 3));
    // interior items
    rep.bedFoot = nm(cx - 1, baseY + 1, cz + 6);
    rep.bedHead = nm(cx - 1, baseY + 1, cz + 7);
    rep.chest = nm(cx + 2, baseY + 1, cz + 7);
    rep.barrel = nm(cx + 2, baseY + 1, cz + 6);
    rep.lantern = nm(cx, baseY + 3, cz + 5);
    // log seats around fire
    rep.seats = [nm(cx - 2, baseY + 1, cz), nm(cx + 2, baseY + 1, cz), nm(cx, baseY + 1, cz - 2)];
    // Count wool in tent volume + check for stray wool 2*oz away (the old bug: tent placed ~2*oz off).
    let redWool = 0, whiteWool = 0;
    for (let dx = -3; dx <= 3; dx++) for (let z = cz + 3; z <= cz + 7; z++) for (let y = baseY + 1; y <= RIDGE; y++) {
      const id = g(cx + dx, y, z);
      if (id === BLOCK_IDS.woolRed) redWool++;
      else if (id === BLOCK_IDS.woolWhite) whiteWool++;
    }
    rep.tentWool = { redWool, whiteWool };
    // Scan a wide box for ANY wool to detect a misplaced tent.
    let strayWool = 0, woolMinZ = 1e9, woolMaxZ = -1e9, woolMinX = 1e9, woolMaxX = -1e9;
    for (let x = cx - 12; x <= cx + 12; x++) for (let z = cz - 12; z <= cz + 20; z++) for (let y = baseY; y <= baseY + 6; y++) {
      const id = g(x, y, z);
      if (id === BLOCK_IDS.woolRed || id === BLOCK_IDS.woolWhite) {
        strayWool++;
        if (z < woolMinZ) woolMinZ = z; if (z > woolMaxZ) woolMaxZ = z;
        if (x < woolMinX) woolMinX = x; if (x > woolMaxX) woolMaxX = x;
      }
    }
    rep.woolBBox = strayWool ? { count: strayWool, x: [woolMinX, woolMaxX], z: [woolMinZ, woolMaxZ] } : null;
    return rep;
  }, { cx, cz });

  const orbit = async (cx, cz, ang, file, dist = 14) => {
    await page.evaluate(({ cx, cz, ang, dist }) => {
      const { world, player } = window.__mcDebug;
      const surf = Math.max(world.sampler(cx, cz).height, world.params.terrain.waterOffset);
      const camY = surf + 12;
      // tent centroid is ~ (cx, cz+5); look there
      const tx = cx, tz = cz + 4;
      const px = cx + Math.cos(ang) * dist;
      const pz = (cz + 2) + Math.sin(ang) * dist;
      player.position.set(px, camY, pz);
      player.velocity.set(0, 0, 0);
      player.camera.position.copy(player.position);
      player.camera.lookAt(tx, surf + 2, tz);
    }, { cx, cz, ang, dist });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT}/${file}` });
    log(`shot ${file}`);
  };

  const tpAbove = (x, z) => page.evaluate(({ x, z }) => {
    const { player } = window.__mcDebug;
    player.position.set(x, 200, z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    player.camera.lookAt(x, 100, z);
  }, { x, z });

  // ---- Campsite 1: (1227, 496) ----
  await tpAbove(1227, 496);
  await settle();
  log('campsite 1 settled');
  const r1 = await inspect(1227, 496);
  log('CAMPSITE-1 INSPECT:', JSON.stringify(r1));
  // front view from -z side (looking +z into the open front), plus a side angle
  await orbit(1227, 496, -Math.PI / 2 - 0.5, 'campsite-1.png');
  await orbit(1227, 496, -Math.PI / 2 + 1.1, 'campsite-2.png');

  // ---- Campsite 2: (236, 1385) ----
  await tpAbove(236, 1385);
  await settle();
  log('campsite 2 settled');
  const r2 = await inspect(236, 1385);
  log('CAMPSITE-2 INSPECT:', JSON.stringify(r2));
  await orbit(236, 1385, -Math.PI / 2 - 0.5, 'campsite-3.png');

  const stats = await page.evaluate(() => {
    const el = document.getElementById('stats-overlay');
    return (el?.textContent || '').replace(/\n/g, ' | ');
  });
  log('overlay:', stats);
} finally {
  await browser.close();
}
