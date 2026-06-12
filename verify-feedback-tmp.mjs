// Verify: village door reachability, gable ends, lamp placement, night side-face lighting.
// Headed Chrome against the vite dev server on :5174. Shots → /tmp/mcjs-verify/.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5174/';
const DIR = '/tmp/mcjs-verify';
mkdirSync(DIR, { recursive: true });
const VX = -926, VZ = -931;   // seed-4242 village

const browser = await chromium.launch({ executablePath: EXE, headless: false, args: ['--use-gl=angle'] });
const log = (...a) => console.log(...a);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => log(`[pageerror] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000, polling: 500 });
  log('booted');

  await page.evaluate(() => { const w = window.__mcDebug.world; w.params.seed = 4242; w.generate(false); });
  await page.waitForTimeout(2500);

  // close the menu (click Play/Resume)
  await page.evaluate(() => { const r = document.querySelector('.menu__resume'); if (r) r.click(); });

  const settle = async (label) => {
    await page.waitForFunction(() => {
      const w = window.__mcDebug.world;
      return (w.pending?.length ?? 0) === 0 && (w.outstanding ?? 0) === 0;
    }, null, { timeout: 45000, polling: 500 }).catch(() => log(`  (settle timeout @ ${label})`));
    await page.waitForTimeout(1500);
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

  // ---- overview ----
  await tp(VX, 220, VZ, VX, 100, VZ);
  await settle('load');
  const gh = await groundH(VX, VZ);
  await tp(VX - 34, gh + 28, VZ - 34, VX, gh, VZ);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${DIR}/01-village-over.png` });
  log('01-village-over.png');

  // ---- DOOR PROBE: every door's two front cells must be passable ----
  const probe = await page.evaluate((p) => {
    const w = window.__mcDebug.world;
    const B = window.__mcDebug.BLOCK_IDS;
    const R = 60;
    const doors = [];
    for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
      const x = p.VX + dx, z = p.VZ + dz;
      for (let y = 185; y > 100; y--) {
        const id = w.getBlockId(x, y, z);
        if (id === B.oakDoorLowerClosed || id === B.oakDoorLowerOpen) doors.push({ x, y, z });
      }
    }
    // passable in front: foot cell may be air or a stair (walk-out run); head cell must be air
    const stairIds = new Set(Object.entries(B).filter(([k]) => /Stairs|Slab/.test(k)).map(([, v]) => v));
    const out = [];
    for (const d of doors) {
      const foot = w.getBlockId(d.x, d.y, d.z - 1);
      const head = w.getBlockId(d.x, d.y + 1, d.z - 1);
      const foot2 = w.getBlockId(d.x, d.y, d.z - 2);
      const head2 = w.getBlockId(d.x, d.y + 1, d.z - 2);
      const ok1 = (foot === 0 || stairIds.has(foot)) && head === 0;
      const ok2 = (foot2 === 0 || stairIds.has(foot2)) && head2 === 0;
      out.push({ ...d, foot, head, foot2, head2, blocked: !(ok1 && ok2) });
    }
    return out;
  }, { VX, VZ });
  const blocked = probe.filter((d) => d.blocked);
  log(`doors found: ${probe.length}, blocked: ${blocked.length}`);
  if (blocked.length) log('  BLOCKED:', JSON.stringify(blocked));

  // ---- door + gable close-ups for the first few doors ----
  let i = 0;
  for (const d of probe.slice(0, 3)) {
    i++;
    await tp(d.x + 1, d.y + 2, d.z - 7, d.x, d.y + 1, d.z);
    await settle(`door${i}`);
    await page.screenshot({ path: `${DIR}/0${i + 1}-door-${d.x}_${d.z}.png` });
    log(`door shot ${i} (${d.x},${d.z})`);
    // gable end view: from the side/above looking at the roof end
    await tp(d.x + 14, d.y + 9, d.z + 4, d.x, d.y + 5, d.z + 4);
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${DIR}/0${i + 1}-gable-${d.x}_${d.z}.png` });
  }

  // ---- night lighting: midnight via the Lighting menu ----
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    // open the Lighting section and set Time of Day = 0 (midnight)
    const rows = [...document.querySelectorAll('.ui-row')];
    for (const r of rows) {
      const lab = r.querySelector('.ui-label');
      if (lab && lab.textContent === 'Time of Day') {
        const inp = r.querySelector('input');
        inp.value = '0';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (lab && lab.textContent === 'Day/Night Cycle') {
        const inp = r.querySelector('input');
        if (inp.checked) { inp.checked = false; inp.dispatchEvent(new Event('change', { bubbles: true })); }
      }
    }
  });
  await page.evaluate(() => { const r = document.querySelector('.menu__resume'); if (r) r.click(); });
  await page.waitForTimeout(300);
  // Hmm: with dayNight OFF the sun elevation slider drives daylight. Re-enable cycle with time pinned instead.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.ui-row')];
    for (const r of rows) {
      const lab = r.querySelector('.ui-label');
      if (lab && lab.textContent === 'Day/Night Cycle') {
        const inp = r.querySelector('input');
        if (!inp.checked) { inp.checked = true; inp.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      if (lab && lab.textContent === 'Day Length (s)') {
        const inp = r.querySelector('input');
        inp.value = '1200';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (lab && lab.textContent === 'Time of Day') {
        const inp = r.querySelector('input');
        inp.value = '0';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    const res = document.querySelector('.menu__resume'); if (res) res.click();
  });
  await page.waitForTimeout(1500);
  const d0 = probe[0] ?? { x: VX, y: gh, z: VZ };
  await tp(d0.x - 6, d0.y + 4, d0.z - 14, d0.x + 6, d0.y - 2, d0.z);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${DIR}/09-night-sides.png` });
  log('09-night-sides.png (midnight)');

  log(blocked.length === 0 ? 'DOOR PROBE PASS' : 'DOOR PROBE FAIL');
} finally {
  await browser.close();
}
