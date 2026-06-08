// Village fix verification at seed-4242 village (-926,-931).
// Headed Google Chrome, viewport 1280x800. Captures overview, path, 3 doors, well.
import { chromium } from 'playwright-core';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5199/';
const SHOT_DIR = '/tmp/worldgen-after';
const VX = -926, VZ = -931;

const browser = await chromium.launch({
  executablePath: EXE,
  headless: false,
  args: ['--use-gl=angle'],
});

const log = (...a) => console.log(...a);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000, polling: 500 });
  log('booted ✔');

  // Pin the seed.
  await page.evaluate(() => { const w = window.__mcDebug.world; w.params.seed = 4242; w.generate(false); });
  await page.waitForTimeout(3000);
  log('seed pinned 4242');

  // Balanced preset.
  const clickBtn = (t) => page.evaluate((txt) => {
    const b = [...document.querySelectorAll('.ui-seg__btn, button')].find(b => b.textContent.trim() === txt || (b.textContent||'').includes(txt));
    if (b) b.click(); return !!b;
  }, t);
  // open Settings if menu shown
  await clickBtn('Settings').catch(()=>{});
  await clickBtn('Balanced');
  log('Balanced preset');
  // resume/close menu if present
  await page.evaluate(() => { const r = document.querySelector('.menu__resume'); if (r) r.click(); }).catch(()=>{});

  const settle = async (label) => {
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      return (w.pending?.length ?? 0) === 0 && (w.outstanding ?? 0) === 0;
    }, null, { timeout: 30000, polling: 500 }).catch(() => log(`  (settle timeout @ ${label})`));
    await page.waitForTimeout(2000);
  };

  const tp = (x, y, z, tx, ty, tz) => page.evaluate((p) => {
    const { player } = window.__mcDebug;
    player.position.set(p.x, p.y, p.z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    player.camera.lookAt(p.tx, p.ty, p.tz);
  }, { x, y, z, tx, ty, tz });

  const groundH = (x, z) => page.evaluate((p) => {
    const w = window.__mcDebug.world;
    const s = w.sampler(Math.floor(p.x), Math.floor(p.z));
    return Math.max(s.height, w.params.terrain.waterOffset);
  }, { x, z });

  // ---- 1) OVERVIEW ----
  await tp(VX, 200, VZ, VX, 0, VZ);
  await settle('overview-load');
  const gh = await groundH(VX, VZ);
  log('village ground height ~', gh);
  // Descend to ~25 above ground, look down at an angle over the village.
  await tp(VX - 30, gh + 25, VZ - 30, VX, gh, VZ);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOT_DIR}/village-over.png` });
  log('village-over.png ✔');

  // ---- PROBE the village: scan a grid around (VX,VZ) for path tiles + doors ----
  const probe = await page.evaluate((p) => {
    const w = window.__mcDebug.world;
    const B = window.__mcDebug.BLOCK_IDS;
    const PATH = new Set([B.gravel, B.cobblestone, B.mossyCobblestone]);
    const isPlant = (id) => {
      // plants are non-cube; rely on shape table if exposed, else id ranges
      return id >= 27 && id <= 65 && id !== B.cobblestone || (id >= 180 && id <= 200);
    };
    const topId = (x, z) => {
      for (let y = 120; y > 0; y--) { const id = w.getBlockId(x, y, z); if (id !== 0) return { id, y }; }
      return { id: 0, y: 0 };
    };
    const R = 55;
    const paths = [];      // {x,z,y,id, plantAbove}
    const doors = [];      // {x,y,z, facing}
    let plantyPaths = 0, cleanPaths = 0;
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const x = p.VX + dx, z = p.VZ + dz;
        // scan column for doors + path surface
        for (let y = 100; y > 20; y--) {
          const id = w.getBlockId(x, y, z);
          if (id === 0) continue;
          // door cells
          if (id === B.oakDoorLowerClosed || id === B.oakDoorLowerOpen) {
            doors.push({ x, y, z });
          }
        }
        const t = topId(x, z);
        if (PATH.has(t.id)) {
          // check what's directly above the path top cell (should be air, not plant/grass/snow)
          const above1 = w.getBlockId(x, t.y + 1, z);
          const above2 = w.getBlockId(x, t.y + 2, z);
          const planty = isPlant(above1) || isPlant(above2) || above1 === B.snow || above1 === 1 /*grass block on path = wrong*/;
          if (planty) plantyPaths++; else cleanPaths++;
          paths.push({ x, z, y: t.y, id: t.id, above1, above2, planty });
        }
      }
    }
    // dedupe doors by (x,z) keeping lower cell
    const doorMap = new Map();
    for (const d of doors) { const k = d.x + ',' + d.z; if (!doorMap.has(k) || d.y < doorMap.get(k).y) doorMap.set(k, d); }
    const uniqDoors = [...doorMap.values()];
    return {
      pathCount: paths.length, cleanPaths, plantyPaths,
      plantySamples: paths.filter(pp => pp.planty).slice(0, 12),
      doors: uniqDoors,
      // a representative path tile near the centre with neighbors also path (a road, not stray)
      roadTile: (() => {
        const set = new Set(paths.map(pp => pp.x + ',' + pp.z));
        for (const pp of paths) {
          let n = 0;
          for (const [a,b] of [[1,0],[-1,0],[0,1],[0,-1]]) if (set.has((pp.x+a)+','+(pp.z+b))) n++;
          if (n >= 2) return pp;
        }
        return paths[0] || null;
      })(),
    };
  }, { VX, VZ });
  log('PROBE:', JSON.stringify({ pathCount: probe.pathCount, cleanPaths: probe.cleanPaths, plantyPaths: probe.plantyPaths, doors: probe.doors.length }));
  log('  planty samples:', JSON.stringify(probe.plantySamples));
  log('  doors:', JSON.stringify(probe.doors));
  log('  roadTile:', JSON.stringify(probe.roadTile));

  // ---- 2) PATH shot: eye level on a road tile, looking along the road ----
  if (probe.roadTile) {
    const rt = probe.roadTile;
    // look toward plaza centre (village origin) along the road
    const eyeY = rt.y + 1.6;
    // direction from road tile toward plaza
    const dirx = VX - rt.x, dirz = VZ - rt.z;
    const len = Math.hypot(dirx, dirz) || 1;
    const tx = rt.x + (dirx/len) * 12, tz = rt.z + (dirz/len) * 12;
    await tp(rt.x - (dirx/len)*2, eyeY, rt.z - (dirz/len)*2, tx, rt.y + 1.2, tz);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${SHOT_DIR}/village-path.png` });
    log('village-path.png ✔ at', rt.x, rt.z);
  } else {
    log('NO road tile found for path shot!');
  }

  // ---- 3) DOORS: 3 different houses, eye level outside the door looking at it ----
  // doors carved into -z wall facing -z; approach runs toward -z. Stand a few
  // blocks on the -z side and look toward +z at the door.
  const chosen = [];
  for (const d of probe.doors) {
    if (chosen.length >= 3) break;
    if (chosen.some(c => Math.abs(c.x - d.x) < 8 && Math.abs(c.z - d.z) < 8)) continue;
    chosen.push(d);
  }
  log('chosen doors:', JSON.stringify(chosen));
  for (let i = 0; i < chosen.length; i++) {
    const d = chosen[i];
    // stand outside, on the -z approach side, eye level at door height
    const standZ = d.z - 5;
    const sg = await groundH(d.x, standZ);
    const eyeY = Math.max(sg, d.y - 1) + 1.6;
    await tp(d.x, eyeY, standZ, d.x, d.y + 0.5, d.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOT_DIR}/village-door${i+1}.png` });
    log(`village-door${i+1}.png ✔ door@(${d.x},${d.y},${d.z}) stand z=${standZ} eyeY=${eyeY.toFixed(1)}`);
  }
  // if fewer than 3 doors found, note it
  if (chosen.length < 3) log(`WARNING: only ${chosen.length} distinct doors found`);

  // ---- 4) WELL: it's at the plaza centre (VX,VZ). Shot looking at it. ----
  const wellGround = await groundH(VX, VZ);
  // sample the well column to confirm shaft + cobble rim
  const wellInfo = await page.evaluate((p) => {
    const w = window.__mcDebug.world;
    const B = window.__mcDebug.BLOCK_IDS;
    const col = [];
    for (let y = wellTopScan(); y > wellTopScan() - 14; y--) col.push([y, w.getBlockId(p.VX, y, p.VZ)]);
    function wellTopScan(){ for (let y=110;y>20;y--){ if (w.getBlockId(p.VX,y,p.VZ)!==0) return y+2; } return 80; }
    // rim ids around well
    const rim = [];
    for (const [a,b] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      for (let y=110;y>20;y--){ const id=w.getBlockId(p.VX+a,y,p.VZ+b); if(id!==0){ rim.push([a,b,y,id]); break; } }
    }
    return { col, rim };
  }, { VX, VZ });
  log('WELL col(centre):', JSON.stringify(wellInfo.col));
  log('WELL rim:', JSON.stringify(wellInfo.rim));
  await tp(VX - 6, wellGround + 3, VZ - 6, VX, wellGround + 1, VZ);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOT_DIR}/village-well.png` });
  log('village-well.png ✔');

  // ---- 5) WATCHTOWER: scan for the tower (tall stone column ~42 out) ----
  const tower = await page.evaluate((p) => {
    const w = window.__mcDebug.world;
    // find tallest non-air column in a ring 35..50 from centre
    let best = null;
    for (let a = 0; a < 64; a++) {
      const ang = a / 64 * Math.PI * 2;
      for (let rad = 35; rad <= 50; rad += 2) {
        const x = Math.round(p.VX + Math.cos(ang) * rad), z = Math.round(p.VZ + Math.sin(ang) * rad);
        let top = 0; for (let y = 120; y > 20; y--) { if (w.getBlockId(x, y, z) !== 0) { top = y; break; } }
        if (!best || top > best.top) best = { x, z, top };
      }
    }
    return best;
  }, { VX, VZ });
  log('tallest outskirt column (tower?):', JSON.stringify(tower));
  if (tower) {
    const tg = await groundH(tower.x, tower.z);
    await tp(tower.x - 14, tg + 8, tower.z - 14, tower.x, tg + (tower.top - tg) * 0.5, tower.z);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${SHOT_DIR}/village-tower.png` });
    log('village-tower.png ✔');
  }

  // dump terrain flatness for the slope verdict
  const flatness = await page.evaluate((p) => {
    const w = window.__mcDebug.world;
    let lo = 1e9, hi = -1e9;
    for (let dx = -40; dx <= 40; dx += 4) for (let dz = -40; dz <= 40; dz += 4) {
      const h = w.sampler(p.VX + dx, p.VZ + dz).height;
      if (h < lo) lo = h; if (h > hi) hi = h;
    }
    return { lo, hi, relief: hi - lo };
  }, { VX, VZ });
  log('VILLAGE TERRAIN relief over 80x80:', JSON.stringify(flatness));

  log('DONE');
} finally {
  await browser.close();
}
