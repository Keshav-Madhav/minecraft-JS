// HEAVY performance benchmark: presets × scenarios × biomes on a REAL GPU
// (headed Chrome). Fixed seed for reproducibility. Measures display frame-time
// percentiles (rAF deltas — what the player actually perceives), game-loop fps,
// draws/tris (renderer.info), JS heap, hitch counts, and streaming throughput.
//
//   node lod-bench.mjs                # full suite (~10-18 min)
//   SUITE=presets node lod-bench.mjs  # subset: presets | biomes | teleport
import { chromium } from 'playwright-core';
import fs from 'fs';

const URL = process.env.APP_URL || 'http://localhost:5199/';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SUITE = process.env.SUITE || 'all';
const OUT = process.env.OUT || '/tmp/lod-bench-results.json';

const results = { meta: { date: new Date().toISOString(), seed: 4242, viewport: '1280x720' }, runs: [] };

const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--window-size=1300,800'] });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 120000, polling: 500 });

  // Fixed seed + start playing (VSync OFF — the user's benchmark mode).
  await page.evaluate(() => {
    const { world } = window.__mcDebug;
    world.params.seed = 4242;
    world.generate(false);
    [...document.querySelectorAll('button')].find((b) => (b.textContent || '').includes('Settings')).click();
    const vsyncRow = [...document.querySelectorAll('.ui-row')].find((r) => r.textContent.includes('VSync'));
    const cb = vsyncRow?.querySelector('input[type=checkbox]');
    if (cb && cb.checked) { cb.checked = false; cb.dispatchEvent(new Event('change', { bubbles: true })); }
    document.querySelector('.menu__resume').click();
  });

  // ---- in-page instrumentation -----------------------------------------------
  await page.evaluate(() => {
    const { world } = window.__mcDebug;
    const B = { deltas: [], t0: 0, raf: 0, updN0: 0, updMs0: 0, pqMs0: 0, heap0: 0 };
    // wrap world.update / processQueues once for loop-fps + cost accounting
    if (!window.__benchWrapped) {
      window.__benchWrapped = { updN: 0, updMs: 0, pqMs: 0 };
      const W = window.__benchWrapped;
      const u = world.update.bind(world), q = world.processQueues.bind(world);
      world.update = (p) => { const t = performance.now(); u(p); W.updMs += performance.now() - t; W.updN++; };
      world.processQueues = () => { const t = performance.now(); q(); W.pqMs += performance.now() - t; };
    }
    window.__bench = {
      start() {
        B.deltas.length = 0;
        B.t0 = performance.now();
        const W = window.__benchWrapped;
        B.updN0 = W.updN; B.updMs0 = W.updMs; B.pqMs0 = W.pqMs;
        B.heap0 = performance.memory ? performance.memory.usedJSHeapSize : 0;
        let last = performance.now();
        const tick = (t) => { B.deltas.push(t - last); last = t; B.raf = requestAnimationFrame(tick); };
        B.raf = requestAnimationFrame(tick);
      },
      stop() {
        cancelAnimationFrame(B.raf);
        const dur = performance.now() - B.t0;
        const d = B.deltas.slice(1).sort((a, b) => a - b);   // drop the first (partial) delta
        const pct = (p) => d.length ? d[Math.min(d.length - 1, Math.floor(d.length * p))] : 0;
        const W = window.__benchWrapped;
        const r = window.__mcDebug.renderer.info.render;
        const m = window.__mcDebug.renderer.info.memory;
        const w = window.__mcDebug.world;
        return {
          durMs: Math.round(dur),
          displayFps: +(d.length / (dur / 1000)).toFixed(1),
          loopFps: +(((W.updN - B.updN0) / (dur / 1000))).toFixed(1),
          frameMs: { avg: +(d.reduce((a, b) => a + b, 0) / (d.length || 1)).toFixed(2), p50: +pct(0.5).toFixed(2), p95: +pct(0.95).toFixed(2), p99: +pct(0.99).toFixed(2), max: +(d[d.length - 1] ?? 0).toFixed(1) },
          hitches33: d.filter((x) => x > 33).length,
          hitches100: d.filter((x) => x > 100).length,
          updMsPerFrame: +(((W.updMs - B.updMs0) / Math.max(1, W.updN - B.updN0))).toFixed(3),
          pqMsPerFrame: +(((W.pqMs - B.pqMs0) / Math.max(1, W.updN - B.updN0))).toFixed(3),
          draws: r.calls, tris: r.triangles,
          chunks: w.chunkCount, lodTiles: w.lodTileCount, lodMeshes: w.lodGroup.children.length,
          geometries: m.geometries,
          heapMB: performance.memory ? +((performance.memory.usedJSHeapSize) / 1048576).toFixed(0) : 0,
          heapDeltaMB: performance.memory ? +((performance.memory.usedJSHeapSize - B.heap0) / 1048576).toFixed(1) : 0,
        };
      },
    };
  });

  const applyPreset = (label) => page.evaluate((l) => {
    [...document.querySelectorAll('.ui-seg__btn')].find((b) => (b.textContent || '').trim() === l)?.click();
  }, label);

  // settle: wait until chunk + lod mesh counts are stable for ~3s (or cap)
  const settle = async (capMs) => {
    const t0 = Date.now();
    await page.evaluate(() => { window.__settle = { c: -1, l: -1, stable: 0 }; });
    await page.waitForFunction(() => {
      const s = window.__settle, w = window.__mcDebug.world;
      const c = w.chunkCount, l = w.lodGroup.children.length;
      if (c === s.c && l === s.l) s.stable++; else { s.stable = 0; s.c = c; s.l = l; }
      return s.stable >= 3;   // 3 consecutive polls (1s apart) unchanged
    }, null, { timeout: capMs, polling: 1000 }).catch(() => console.log('  (settle cap hit)'));
    return Math.round((Date.now() - t0) / 1000);
  };

  const motion = {
    static: () => page.evaluate(() => { clearInterval(window.__motion); }),
    mouselook: () => page.evaluate(() => {
      clearInterval(window.__motion);
      const { player } = window.__mcDebug;
      let yaw = 0;
      window.__motion = setInterval(() => {
        yaw += 0.045;   // ~45°/s at 60Hz driver
        const p = player.position;
        player.camera.lookAt(p.x + Math.cos(yaw) * 100, p.y - 5, p.z + Math.sin(yaw) * 100);
      }, 16);
    }),
    traverse: () => page.evaluate(() => {
      clearInterval(window.__motion);
      const { world, player } = window.__mcDebug;
      window.__motion = setInterval(() => {
        player.position.x += 1.2;   // ~24 blocks/s sustained flight
        const surf = world.sampler(Math.floor(player.position.x), Math.floor(player.position.z)).height;
        player.position.y = Math.max(surf + 18, world.params.terrain.waterOffset + 18);
        player.camera.position.copy(player.position);
        player.camera.lookAt(player.position.x + 200, player.position.y - 8, player.position.z);
      }, 50);
    }),
  };

  const measure = async (name, scenario, ms) => {
    await motion[scenario]();
    await page.waitForTimeout(800);   // let the scenario reach steady state
    await page.evaluate(() => window.__bench.start());
    await page.waitForTimeout(ms);
    const m = await page.evaluate(() => window.__bench.stop());
    await motion.static();
    results.runs.push({ name, scenario, ...m });
    console.log(`  ${name} [${scenario}]  fps ${m.displayFps} (loop ${m.loopFps})  p95 ${m.frameMs.p95}ms p99 ${m.frameMs.p99}ms  hitch>33ms ${m.hitches33}  draws ${m.draws}  tris ${(m.tris / 1e6).toFixed(2)}M  chunks ${m.chunks}  lod ${m.lodMeshes}  heap ${m.heapMB}MB`);
    return m;
  };

  const goto = (x, z, dy = 20) => page.evaluate(({ x, z, dy }) => {
    const { world, player } = window.__mcDebug;
    const surf = Math.max(world.sampler(Math.floor(x), Math.floor(z)).height, world.params.terrain.waterOffset);
    player.position.set(x, surf + dy, z);
    player.velocity.set(0, 0, 0);
    player.camera.position.copy(player.position);
    player.camera.lookAt(x + 300, surf + dy - 12, z + 100);
  }, { x, z, dy });

  // deterministic biome spot finder (seed-fixed)
  const findSpot = (kinds, wantLand) => page.evaluate(({ kinds, wantLand }) => {
    const { world } = window.__mcDebug;
    const sea = world.params.terrain.waterOffset;
    for (let r = 1; r < 70; r++) {
      for (let a = 0; a < 12; a++) {
        const x = Math.round(Math.cos(a / 12 * Math.PI * 2) * r * 320);
        const z = Math.round(Math.sin(a / 12 * Math.PI * 2) * r * 320);
        let hit = 0, land = 0;
        for (let k = 0; k < 6; k++) {
          const s = world.sampler(x + Math.round(Math.cos(k / 6 * Math.PI * 2) * 300), z + Math.round(Math.sin(k / 6 * Math.PI * 2) * 300));
          if (kinds.includes(s.biome)) hit++;
          if (s.height > sea + 3) land++;
        }
        if (hit >= 4 && (wantLand ? land >= 5 : land <= 1)) return { x, z };
      }
    }
    return { x: 0, z: 0 };
  }, { kinds, wantLand });

  // ===========================================================================
  if (SUITE === 'all' || SUITE === 'presets') {
    console.log('\n=== PRESET SUITE (varied terrain, seed 4242) ===');
    const spot = await findSpot([5, 6, 7, 26], true);   // plains/forest/savanna mix
    console.log(`spot: ${JSON.stringify(spot)}`);
    for (const [label, cap] of [['Low', 60000], ['Balanced', 75000], ['Fancy', 110000], ['Ultra', 150000], ['MAX', 200000]]) {
      await applyPreset(label);
      await goto(spot.x, spot.z);
      const st = await settle(cap);
      console.log(`-- ${label} (settled in ${st}s)`);
      await measure(`preset:${label}`, 'static', 8000);
      await measure(`preset:${label}`, 'mouselook', 8000);
      await measure(`preset:${label}`, 'traverse', 10000);
      await goto(spot.x, spot.z);   // return for the next preset
    }
  }

  if (SUITE === 'all' || SUITE === 'biomes') {
    console.log('\n=== BIOME SUITE (Fancy preset) ===');
    await applyPreset('Fancy');
    const biomes = [
      ['ocean', await findSpot([0, 19, 20, 21, 22], false)],
      ['mountains', await findSpot([31, 2], true)],
      ['forest', await findSpot([6, 24, 25, 29], true)],
      ['snowy-taiga', await findSpot([2, 4, 23], true)],
    ];
    for (const [name, spot] of biomes) {
      console.log(`-- ${name} at ${JSON.stringify(spot)}`);
      await goto(spot.x, spot.z);
      await settle(110000);
      await measure(`biome:${name}`, 'static', 6000);
      await measure(`biome:${name}`, 'traverse', 8000);
    }
  }

  if (SUITE === 'all' || SUITE === 'teleport') {
    console.log('\n=== TELEPORT / STREAMING THROUGHPUT ===');
    for (const label of ['Balanced', 'Ultra']) {
      await applyPreset(label);
      await page.waitForTimeout(3000);
      const t = await page.evaluate(async () => {
        const { world, player } = window.__mcDebug;
        const x = player.position.x + 3000, z = player.position.z + 3000;
        const surf = Math.max(world.sampler(Math.floor(x), Math.floor(z)).height, world.params.terrain.waterOffset);
        player.position.set(x, surf + 20, z);
        player.velocity.set(0, 0, 0);
        player.camera.position.copy(player.position);
        player.camera.lookAt(x + 300, surf, z + 100);
        const t0 = performance.now();
        // ready = the playable bubble: every chunk within ±2 loaded + minimap ring mostly in
        await new Promise((res) => {
          const W = world.chunkSize.width;
          const check = () => {
            let ok = true;
            for (let dx = -2; dx <= 2 && ok; dx++) for (let dz = -2; dz <= 2; dz++) {
              if (!world.isLoadedAt(x + dx * W, z + dz * W)) { ok = false; break; }
            }
            if (ok) res(); else setTimeout(check, 100);
          };
          check();
        });
        const bubble = performance.now() - t0;
        // far ring: until LOD meshes reappear ahead
        await new Promise((res) => {
          const check = () => { if (world.lodGroup.children.length > 20) res(); else setTimeout(check, 250); };
          check();
        });
        return { bubbleMs: Math.round(bubble), lodMs: Math.round(performance.now() - t0) };
      });
      results.runs.push({ name: `teleport:${label}`, scenario: 'teleport', ...t });
      console.log(`  ${label}: playable bubble in ${(t.bubbleMs / 1000).toFixed(1)}s, LOD ring back in ${(t.lodMs / 1000).toFixed(1)}s`);
    }
  }

  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  console.log(`\nresults → ${OUT}`);
} finally {
  await browser.close();
}
