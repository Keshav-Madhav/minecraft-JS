// Verify structure proxies appear in LOD far terrain. Seed 4242.
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';
const DIR = '/tmp/worldgen-after';

const browser = await chromium.launch({ executablePath: EXE, headless: false });
const log = (...a) => console.log(...a);

const sites = {
  tower: { wx: -84, wz: -218 },
  lighthouse: { wx: 658, wz: -370 },
  village: { wx: -926, wz: -931 },
  pyramid: { wx: 1517, wz: 1639 },
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000, polling: 500 });
  log('booted, chunkMap > 0');

  // PIN SEED
  await page.evaluate(() => { const w = window.__mcDebug.world; w.params.seed = 4242; w.generate(false); });
  await page.waitForTimeout(3000);
  log('seed pinned to 4242, regenerated');

  // Close menu / enter play so HUD-free + pointer scene renders. Try Mode->Survival or Resume.
  await page.evaluate(() => {
    const click = (t) => { const b = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t || (b.textContent || '').includes(t)); if (b) { b.click(); return true; } return false; };
    if (!click('Resume')) {
      // open Mode tab, pick Survival card
      click('Mode');
      const card = [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival'));
      if (card) card.click();
    }
  });
  await page.waitForTimeout(500);

  // Ultra preset (max view distance)
  const setPreset = (name) => page.evaluate((n) => {
    const b = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Settings'));
    if (b) b.click();
    const seg = [...document.querySelectorAll('.ui-seg__btn')].find((b) => b.textContent.trim() === n);
    if (seg) { seg.click(); return true; }
    return false;
  }, name);
  log('Ultra preset set:', await setPreset('Ultra'));
  // close menu again
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Resume' || (b.textContent || '').includes('Resume')); if (b) b.click(); });
  await page.waitForTimeout(1000);

  const teleport = (x, y, z, tx, ty, tz) => page.evaluate((p) => {
    const { world, player } = window.__mcDebug;
    player.position.set(p.x, p.y, p.z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    player.camera.lookAt(p.tx, p.ty, p.tz);
  }, { x, y, z, tx, ty, tz });

  const settle = async (label) => {
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      return w.pending.length === 0 && w.outstanding === 0;
    }, null, { timeout: 30000, polling: 500 }).catch(() => log(`${label}: settle timed out (pending/outstanding)`));
    // also let LOD build settle (stable lodBuiltCount across 3 polls)
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      const n = w.lodBuiltCount;
      if (window.__s === n) return (window.__st = (window.__st || 0) + 1) >= 3;
      window.__s = n; window.__st = 0; return false;
    }, null, { timeout: 30000, polling: 700 }).catch(() => log(`${label}: lod build not stable`));
    await page.waitForTimeout(2000);
  };

  // Brighten if exposed
  await page.evaluate(() => {
    const w = window.__mcDebug.world;
    try {
      if (w.params && typeof w.params.timeOfDay !== 'undefined') w.params.timeOfDay = 0.3;
      if (window.__mcDebug.setTimeOfDay) window.__mcDebug.setTimeOfDay(0.3);
    } catch (e) {}
  });

  // Inspect tiles covering a structure
  const inspectSite = (wx, wz) => page.evaluate((p) => {
    const w = window.__mcDebug.world;
    const TILE = 128, MEGA = 256;
    const tk = `${Math.floor(p.wx / TILE)},${Math.floor(p.wz / TILE)}`;
    const mk = `M${Math.floor(p.wx / MEGA)},${Math.floor(p.wz / MEGA)}`;
    const out = { tk, mk, lodBuiltCount: w.lodBuiltCount, lodTileCount: w.lodTileCount };
    const get = (k) => {
      const t = w.lodMap.get(k);
      if (!t) return null;
      return { built: !!(t.terrainH || t.canopyH), shown: t.shown, stride: t.stride, near: t.near, tileChunks: t.tileChunks };
    };
    out.tile = get(tk);
    out.mega = get(mk);
    // distance from camera to structure
    const cam = w.parent ? null : null;
    return out;
  }, { wx, wz });

  // ===== 1. TOWER (-84,-218): far view from (-84,230,800) =====
  await teleport(-84, 230, 800, -84, 140, -218);
  await settle('tower-far');
  log('tower-far inspect:', JSON.stringify(await inspectSite(sites.tower.wx, sites.tower.wz)));
  await page.screenshot({ path: `${DIR}/lod-tower.png` });
  log('shot: lod-tower.png');

  // 1b. tower closer 500 blocks: (-84,200,350)
  await teleport(-84, 200, 350, -84, 140, -218);
  await settle('tower-500');
  log('tower-500 inspect:', JSON.stringify(await inspectSite(sites.tower.wx, sites.tower.wz)));
  await page.screenshot({ path: `${DIR}/lod-tower-500.png` });
  log('shot: lod-tower-500.png');

  // ===== 2. PYRAMID (1517,1639): from (1517,260,2700) =====
  await teleport(1517, 260, 2700, 1517, 160, 1639);
  await settle('pyramid');
  log('pyramid inspect:', JSON.stringify(await inspectSite(sites.pyramid.wx, sites.pyramid.wz)));
  await page.screenshot({ path: `${DIR}/lod-pyramid.png` });
  log('shot: lod-pyramid.png');

  // ===== 3. VILLAGE (-926,-931): from (-926,230,100) =====
  await teleport(-926, 230, 100, -926, 150, -931);
  await settle('village');
  log('village inspect:', JSON.stringify(await inspectSite(sites.village.wx, sites.village.wz)));
  await page.screenshot({ path: `${DIR}/lod-village.png` });
  log('shot: lod-village.png');

  // ===== 4. SWAP TEST: from 500 closer to (-84,150,-100) =====
  // progressive approach toward the tower, settle, verify the tile hides and no double-render
  const approach = [
    [-84, 200, 250], [-84, 180, 100], [-84, 170, 0],
  ];
  for (const [x, y, z] of approach) {
    await teleport(x, y, z, -84, 150, -218);
    await settle(`approach ${z}`);
    log(`approach z=${z} inspect:`, JSON.stringify(await inspectSite(sites.tower.wx, sites.tower.wz)));
  }
  // final near settle at -100, looking at tower
  await teleport(-84, 150, -100, -84, 150, -218);
  await settle('tower-near');
  const near = await inspectSite(sites.tower.wx, sites.tower.wz);
  log('tower-near inspect:', JSON.stringify(near));
  // Is the tower chunk loaded?
  const chunkLoaded = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    const cx = Math.floor(-84 / 16), cz = Math.floor(-218 / 16);
    const c = w.chunkMap.get(`${cx},${cz}`);
    return { cx, cz, loaded: !!c?.loaded };
  });
  log('tower chunk loaded:', JSON.stringify(chunkLoaded));
  await page.screenshot({ path: `${DIR}/lod-tower-near.png` });
  log('shot: lod-tower-near.png');

  log('DONE');
} catch (e) {
  log('ERROR:', e.message, e.stack);
} finally {
  await browser.close();
}
