// Verify the hotbar + creative inventory: icons render, E opens the overlay,
// search/tabs filter, click/number-key assignment works, pick-block semantics,
// hotbar persistence. Headed Chrome against vite on :5174.
import { chromium } from 'playwright-core';
import { mkdirSync } from 'fs';

const EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL = 'http://localhost:5174/';
const DIR = '/tmp/mcjs-verify';
mkdirSync(DIR, { recursive: true });
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok) => { log(`${ok ? '✓' : '✗ FAIL'}  ${name}`); if (!ok) fails++; };

const browser = await chromium.launch({ executablePath: EXE, headless: false, args: ['--use-gl=angle'] });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => { log(`[pageerror] ${e.message}`); fails++; });
  page.on('console', (m) => { if (m.type() === 'error') log(`[console.error] ${m.text()}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => window.__mcDebug?.world?.chunkMap?.size > 0, null, { timeout: 60000, polling: 500 });
  await page.evaluate(() => document.querySelector('.menu__resume')?.click());
  await page.waitForTimeout(2500);

  // --- HUD hotbar: 9 slots, icons painted (canvas has non-transparent pixels) ---
  const hud = await page.evaluate(() => {
    const slots = [...document.querySelectorAll('#toolbar-container .hotbar-slot')];
    const painted = slots.map((s) => {
      const cv = s.querySelector('canvas');
      const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    });
    return { count: slots.length, painted };
  });
  check('hotbar has 9 slots', hud.count === 9);
  check('all 9 default slot icons painted', hud.painted.every(Boolean));
  await page.screenshot({ path: `${DIR}/20-hotbar.png` });

  // --- selection follows keys + scroll state ---
  const sel = await page.evaluate(() => {
    const { inventory, player, BLOCK_IDS } = window.__mcDebug;
    inventory.select(2);   // slot 3 = stone (default layout)
    const stoneOk = player.activeBlockId === BLOCK_IDS.stone;
    inventory.cycle(1);
    const cobbleOk = player.activeBlockId === BLOCK_IDS.cobblestone && inventory.selected === 3;
    inventory.cycle(-1);
    return { stoneOk, cobbleOk, backOk: inventory.selected === 2 };
  });
  check('hotbar select → player holds stone', sel.stoneOk);
  check('cycle(+1) → cobblestone in slot 4', sel.cobbleOk);
  check('cycle(-1) returns', sel.backOk);

  // --- pick block: jump-to-existing-slot, else replace selection ---
  const pick = await page.evaluate(() => {
    const { inventory, BLOCK_IDS } = window.__mcDebug;
    inventory.select(0);
    inventory.pickBlock(BLOCK_IDS.dirt);                    // dirt lives in slot 2
    const jumped = inventory.selected === 1;
    inventory.pickBlock(BLOCK_IDS.diamondBlock);            // not in hotbar → replaces slot 2
    const replaced = inventory.slots[1]?.key === 'diamondBlock';
    const stairAlias = (() => { inventory.pickBlock(BLOCK_IDS.oakStairsNZ); return inventory.slots.some((s) => s?.key === 'oakStairs'); })();
    return { jumped, replaced, stairAlias };
  });
  check('pick existing block jumps to its slot', pick.jumped);
  check('pick new block replaces selected slot', pick.replaced);
  check('pick stair variant maps to stair entry', pick.stairAlias);

  // --- E opens the overlay; grid + tabs + search work ---
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'e', bubbles: true })));
  await page.waitForTimeout(700);
  const overlay = await page.evaluate(() => {
    const open = document.querySelector('.inv')?.classList.contains('inv--open');
    const cells = document.querySelectorAll('.inv-cell').length;
    const tabs = document.querySelectorAll('.inv__tab').length;
    return { open, cells, tabs };
  });
  check('E opens inventory overlay', !!overlay.open);
  check(`catalog has 100+ entries (${overlay.cells})`, overlay.cells >= 100);
  check(`category tabs present (${overlay.tabs})`, overlay.tabs >= 8);
  await page.waitForTimeout(600);   // let icon textures decode
  await page.screenshot({ path: `${DIR}/21-inventory.png` });

  // search filter
  await page.fill('.inv__search', 'wool');
  await page.waitForTimeout(200);
  const woolCells = await page.evaluate(() => document.querySelectorAll('.inv-cell').length);
  check(`search "wool" filters to 16 (${woolCells})`, woolCells === 16);
  await page.screenshot({ path: `${DIR}/22-inventory-search.png` });

  // click a cell → goes to the selected hotbar slot
  await page.evaluate(() => { window.__mcDebug.inventory.select(8); });
  await page.click('.inv-cell');   // first wool cell
  const assigned = await page.evaluate(() => window.__mcDebug.inventory.slots[8]?.key);
  check(`click assigns to selected slot (${assigned})`, /^wool/.test(assigned ?? ''));

  // hover + number key assigns to that slot
  await page.fill('.inv__search', 'bookshelf');
  await page.waitForTimeout(200);
  await page.hover('.inv-cell');
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true })));
  const slot5 = await page.evaluate(() => window.__mcDebug.inventory.slots[4]?.key);
  check(`hover + "5" puts bookshelf in slot 5 (${slot5})`, slot5 === 'bookshelf');

  // Esc closes — pressed INSIDE the focused search input (the worst case: the
  // input must release keyboard focus or it swallows WASD after closing).
  await page.focus('.inv__search');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => !document.querySelector('.inv')?.classList.contains('inv--open'));
  check('Esc (while typing in search) closes overlay', closed);
  const unfocused = await page.evaluate(() => document.activeElement !== document.querySelector('.inv__search'));
  check('search input released keyboard focus on close', unfocused);

  // --- persistence: layout survives in localStorage ---
  const persisted = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('mcjs-prefs-v1') || '{}');
    return Array.isArray(p.hotbar) && p.hotbar[4] === 'bookshelf';
  });
  check('hotbar layout persisted to prefs', persisted);

  // --- placement entry resolution: door/bed/2-tall expand correctly ---
  const place = await page.evaluate(() => {
    const { world, inventory, BLOCK_IDS } = window.__mcDebug;
    const find = (k) => { inventory.pickBlock(BLOCK_IDS[k] ?? 0); return inventory.selectedEntry; };
    const door = find('oakDoorLowerClosed');
    const sunflower = find('sunflowerLower');
    const bed = find('bedFoot');
    // direct world write through the same ids the place path uses
    const x = 8, z = 8, y = world.sampler(8, 8).height + 5;
    world.setBlock(x, y, z, door.blockId);
    world.setBlock(x, y + 1, z, door.upperId);
    const doorOk = world.getBlockId(x, y, z) === BLOCK_IDS.oakDoorLowerClosed && world.getBlockId(x, y + 1, z) === BLOCK_IDS.oakDoorUpperClosed;
    return {
      doorEntry: door?.key === 'oakDoor' && door?.upperId === BLOCK_IDS.oakDoorUpperClosed,
      sunflowerEntry: sunflower?.key === 'sunflowerLower' && sunflower?.upperId === BLOCK_IDS.sunflowerUpper,
      bedEntry: bed?.key === 'bed' && bed?.bedPair === true,
      doorOk,
    };
  });
  check('door entry expands to lower+upper', place.doorEntry && place.doorOk);
  check('sunflower entry carries its upper half', place.sunflowerEntry);
  check('bed entry flags the head pair', place.bedEntry);

  log(fails === 0 ? '\nINVENTORY CHECKS: ALL PASS' : `\nINVENTORY CHECKS: ${fails} FAILURES`);
  process.exitCode = fails === 0 ? 0 : 1;
} finally {
  await browser.close();
}
