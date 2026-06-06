// CPU profile of real gameplay: HEADED Chrome (real GPU via ANGLE/Metal) at
// user-like settings (RD 64 + LOD 160), flying forward while turning — capture
// a CDP CPU profile + live fps, report the top self-time functions.
import { chromium } from 'playwright-core';
import os from 'os';
import fs from 'fs';

const URL = process.env.APP_URL || 'http://localhost:5199/';
const HEADED = process.env.HEADED !== '0';
const RD = Number(process.env.RD || 64);
const LOD = Number(process.env.LOD || 160);

const EXE_HEADLESS = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
// Headed: prefer real Chrome on macOS for a real GPU stack.
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const browser = await chromium.launch(HEADED && fs.existsSync(CHROME)
  ? { executablePath: CHROME, headless: false, args: ['--window-size=1280,760'] }
  : { executablePath: EXE_HEADLESS, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 180000, polling: 500 });

  // Settings → Balanced baseline, then drive the REAL sliders (fires the real setters).
  await page.evaluate(({ rd, lod }) => {
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Settings')).click();
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Balanced').click();
    // open the Advanced drawer so slider rows exist & sync
    const adv = [...document.querySelectorAll('.ui-section__header')].find((h) => h.textContent === 'Advanced');
    adv?.closest('.ui-section')?.classList.remove('ui-section--collapsed');
    const sliders = [...document.querySelectorAll('input[type=range]')];
    const set = (input, v) => { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
    const viewInput = sliders.find((i) => i.min === '4' && i.max === '256');
    if (viewInput) set(viewInput, lod);   // unified: lod = v, chunks = v/4
    // VSync OFF (uncapped) like the user
    const vsyncRow = [...document.querySelectorAll('.ui-row')].find((r) => r.textContent.includes('VSync'));
    const cb = vsyncRow?.querySelector('input[type=checkbox]');
    if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('.menu__resume').click();
    return { rd, lod };
  }, { rd: RD, lod: LOD });
  console.log(`settings: RD=${RD} LOD=${LOD}, vsync off, playing`);

  // Let initial streaming settle.
  await page.waitForFunction(() => window.__mcDebug.world.chunkCount > 400, null, { timeout: 240000, polling: 1000 });
  await page.waitForTimeout(20000);
  console.log('streamed:', await page.evaluate(() => {
    const w = window.__mcDebug.world;
    return JSON.stringify({ chunks: w.chunkCount, lod: w.lodTileCount, meshes: w.lodGroup.children.length });
  }));

  // Wrap hot entry points with timers + start gameplay motion (fly forward + turn).
  await page.evaluate(() => {
    const { world, player } = window.__mcDebug;
    const acc = { update: 0, queues: 0, frames: 0 };
    (window).__prof = acc;
    const u = world.update.bind(world), q = world.processQueues.bind(world);
    world.update = (p) => { const t = performance.now(); u(p); acc.update += performance.now() - t; acc.frames++; };
    world.processQueues = () => { const t = performance.now(); q(); acc.queues += performance.now() - t; };
    // motion: forward flight + slow yaw, like real play
    let yaw = 0;
    (window).__motion = setInterval(() => {
      yaw += 0.06;
      const dx = Math.cos(yaw) * 6, dz = Math.sin(yaw) * 6;
      player.position.x += dx; player.position.z += dz;
      const surf = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z)).height;
      player.position.y = Math.max(surf + 20, world.params.terrain.waterOffset + 20);
      player.camera.position.copy(player.position);
      player.camera.lookAt(player.position.x + Math.cos(yaw) * 100, player.position.y - 6, player.position.z + Math.sin(yaw) * 100);
    }, 50);
  });

  // CDP CPU profile for 12s of "gameplay".
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await page.waitForTimeout(12000);
  const { profile } = await cdp.send('Profiler.stop');
  const sec = await page.evaluate(() => {
    clearInterval((window).__motion);
    const a = (window).__prof;
    const el = document.getElementById('stats-overlay');
    return { ...a, overlay: (el?.textContent || '').replace(/\n/g, ' | ') };
  });

  // Aggregate self time per function.
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const selfMs = new Map();
  const total = profile.samples.length;
  const interval = (profile.endTime - profile.startTime) / 1000 / total;   // ms per sample
  for (const s of profile.samples) {
    const n = nodes.get(s);
    if (!n) continue;
    const f = n.callFrame;
    const name = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').pop()}:${f.lineNumber}`;
    selfMs.set(name, (selfMs.get(name) ?? 0) + interval);
  }
  const top = [...selfMs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
  const wallMs = (profile.endTime - profile.startTime) / 1000;
  console.log(`\n=== CPU PROFILE (${Math.round(wallMs)}ms wall, ${total} samples) — top self-time ===`);
  for (const [name, ms] of top) console.log(`${ms.toFixed(0).padStart(6)}ms  ${(100 * ms / wallMs).toFixed(1).padStart(5)}%  ${name}`);
  console.log(`\nper-frame instrumentation over ${sec.frames} frames: world.update avg ${(sec.update / sec.frames).toFixed(2)}ms, processQueues avg ${(sec.queues / sec.frames).toFixed(2)}ms`);
  console.log('overlay:', sec.overlay);
} finally {
  await browser.close();
}
