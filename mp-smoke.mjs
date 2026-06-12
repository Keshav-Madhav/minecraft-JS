// Two-tab multiplayer smoke test: host in page A, join from page B, assert the
// PeerJS handshake + world-snapshot handoff completes.
import { chromium } from 'playwright-core';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5173/';


const domClick = (page, text) => page.evaluate((t) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes(t));
  if (!btn) throw new Error('no button: ' + t);
  btn.click();
}, text);

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

async function openGame(name) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[${name}][console.error] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`[${name}][pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  // Menu opens on boot; switch to the Multiplayer tab.
  // Poll until the menu tabs have layout (SwiftShader boot can take a while).
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 180000, polling: 1000 });
  await domClick(page, 'Multiplayer');
  return page;
}

try {
  const host = await openGame('host');
  const guest = await openGame('guest');

  // HOST: click "Host This World", wait for the room code.
  await domClick(host, 'Host This World');
  await host.waitForFunction(() => {
    const el = document.querySelector('.mp-code');
    return el && el.textContent && el.textContent.trim().length >= 4;
  }, null, { timeout: 60000, polling: 500 });
  const code = (await host.textContent('.mp-code')).trim();
  console.log('room code:', code);

  // GUEST: type the code, join.
  await guest.evaluate((c) => {
    const i = document.querySelector('input.mp-code-input');
    i.value = c;
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Join')).click();
  }, code);

  // Both sides should reach "connected".
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    await page.waitForFunction(() => {
      const el = document.querySelector('.mp-status');
      return el && /connected/i.test(el.textContent || '');
    }, null, { timeout: 60000, polling: 500 });
    console.log(`${name}: ${(await page.textContent('.mp-status')).trim()}`);
  }

  // Guest should now have the host's seed: compare the World→Seed slider values
  // (slider rows expose _sync to refresh the displayed value from the live getter).
  const readSeed = (p) => p.evaluate(() => {
    const sliders = [...document.querySelectorAll('input[type=range]')];
    // Seed is the World section's first slider (min 0 max 10000 step 1)
    const s = sliders.find((i) => i.min === '0' && i.max === '10000' && i.step === '1');
    if (!s) return null;
    s.closest('.ui-row')?._sync?.();
    return s.value;
  });
  await host.waitForTimeout(1500);   // let the guest's init → regenerate apply
  const hostSeed = await readSeed(host), guestSeed = await readSeed(guest);
  console.log('host seed:', hostSeed, '| guest seed:', guestSeed, '| match:', hostSeed === guestSeed);

  if (hostSeed !== guestSeed) throw new Error('guest did not adopt host seed');
  console.log('world handoff ✔  (guest adopted host seed)');

  // ==== GAMEPLAY SYNC (drives real game paths via the __mcDebug handle) =====
  // Common spot near spawn: surface at the host player's XZ.
  const spot = await host.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const px = Math.floor(player.position.x), pz = Math.floor(player.position.z);
    const surf = Math.max(world.sampler(px, pz).height, world.params.terrain.waterOffset);
    return { px, pz, surf };
  });
  console.log('test spot:', JSON.stringify(spot));

  // Both clients must have that chunk streamed in before edits can be asserted.
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    await page.waitForFunction(
      ({ px, pz }) => window.__mcDebug.world.isLoadedAt(px, pz),
      spot, { timeout: 180000, polling: 1000 });
    console.log(`${name}: spawn chunk loaded ✔`);
  }

  // Place STONE — a known solid id (must be nonzero or the placement tests
  // assert air==air and prove nothing).
  const groundId = await host.evaluate(() => window.__mcDebug.BLOCK_IDS.stone);
  if (!groundId) throw new Error('stone id is 0/undefined — placement test would be vacuous');
  const y = spot.surf + 20;   // high above the canopy — guaranteed air

  // Sanity: the cell must START as air on both sides (otherwise place is a no-op).
  for (const [name, page] of [['host', host], ['guest', guest]]) {
    const v = await page.evaluate(([x, y, z]) => window.__mcDebug.world.getBlockId(x, y, z), [spot.px, y, spot.pz]);
    if (v !== 0) throw new Error(`${name}: test cell not air (id ${v})`);
  }

  // 1) HOST places a block → GUEST must see it.
  await host.evaluate(([x, y, z, id]) => window.__mcDebug.world.setBlock(x, y, z, id), [spot.px, y, spot.pz, groundId]);
  await guest.waitForFunction(
    ([x, y, z, id]) => window.__mcDebug.world.getBlockId(x, y, z) === id,
    [spot.px, y, spot.pz, groundId], { timeout: 15000, polling: 250 });
  console.log(`host→guest place ✔  (id ${groundId} at ${spot.px},${y},${spot.pz})`);

  // 2) GUEST places a block → HOST must see it.
  await guest.evaluate(([x, y, z, id]) => window.__mcDebug.world.setBlock(x, y, z, id), [spot.px + 1, y, spot.pz, groundId]);
  await host.waitForFunction(
    ([x, y, z, id]) => window.__mcDebug.world.getBlockId(x, y, z) === id,
    [spot.px + 1, y, spot.pz, groundId], { timeout: 15000, polling: 250 });
  console.log('guest→host place ✔');

  // 3) HOST removes its block → GUEST must see air (id 0).
  await host.evaluate(([x, y, z]) => window.__mcDebug.world.removeBlock(x, y, z), [spot.px, y, spot.pz]);
  await guest.waitForFunction(
    ([x, y, z]) => window.__mcDebug.world.getBlockId(x, y, z) === 0,
    [spot.px, y, spot.pz], { timeout: 15000, polling: 250 });
  console.log('host→guest remove ✔');

  // 4) DOOR TOGGLE: the third edit path (interactBlock → setOne broadcast).
  //    Host builds a door, both sides see it closed; host opens it; the guest
  //    must converge on the host's resulting (open) ids without double-toggling.
  const dx = spot.px + 3;
  const doorLower = await host.evaluate(() => window.__mcDebug.BLOCK_IDS.oakDoorLowerClosed);
  const doorUpper = await host.evaluate(() => window.__mcDebug.BLOCK_IDS.oakDoorUpperClosed);
  await host.evaluate(([x, y, z, lo, up]) => {
    window.__mcDebug.world.setBlock(x, y, z, lo);
    window.__mcDebug.world.setBlock(x, y + 1, z, up);
  }, [dx, y, spot.pz, doorLower, doorUpper]);
  await guest.waitForFunction(
    ([x, y, z, lo]) => window.__mcDebug.world.getBlockId(x, y, z) === lo,
    [dx, y, spot.pz, doorLower], { timeout: 15000, polling: 250 });
  const toggled = await host.evaluate(([x, y, z]) => {
    const w = window.__mcDebug.world;
    if (!w.interactBlock(x, y, z)) throw new Error('door was not interactive');
    return { lower: w.getBlockId(x, y, z), upper: w.getBlockId(x, y + 1, z) };
  }, [dx, y, spot.pz]);
  if (toggled.lower === doorLower) throw new Error('door did not toggle on host');
  await guest.waitForFunction(
    ([x, y, z, lo, up]) => window.__mcDebug.world.getBlockId(x, y, z) === lo
      && window.__mcDebug.world.getBlockId(x, y + 1, z) === up,
    [dx, y, spot.pz, toggled.lower, toggled.upper], { timeout: 15000, polling: 250 });
  console.log('door toggle sync ✔  (both halves, resulting ids — no double-toggle)');

  // 5) POSITION SYNC: move the host's camera; the guest's remote avatar must
  //    follow (interpolated, feet at y − 1.8) and be visible.
  const target = { x: spot.px + 5, y: spot.surf + 10, z: spot.pz + 5 };
  await host.evaluate((t) => { window.__mcDebug.player.position.set(t.x, t.y, t.z); }, target);
  await guest.waitForFunction((t) => {
    const r = window.__mcDebug.remote;
    if (!r.group.visible) return false;
    const p = r.group.position;
    return Math.abs(p.x - t.x) < 1.5 && Math.abs(p.y - (t.y - 1.8)) < 1.5 && Math.abs(p.z - t.z) < 1.5;
  }, target, { timeout: 15000, polling: 250 });
  console.log('avatar position sync ✔  (visible, tracking host camera)');

  console.log('SMOKE TEST PASSED ✔  (connect + handoff + edits both ways + remove + avatar)');
} finally {
  await browser.close();
}
