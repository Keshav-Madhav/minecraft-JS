// Golden byte-parity guard for the chunkMesh typed-Acc port. buildChunkGeometry
// must produce BYTE-IDENTICAL geometry before/after the refactor. We import the
// live modules through the Vite dev server, generate REAL terrain for several
// fixed chunks (ocean/mountain/cave/structure variety), and checksum every output
// buffer. First run with no golden → captures it; run again after editing → compares.
//   node mesh-parity.mjs            (capture golden from current code)
//   <edit chunkMesh.ts>
//   node mesh-parity.mjs            (assert identical)
// Pure computation (no GPU) → headless SwiftShader shell is fine. APP_URL must point
// at THIS project's vite (usually :5174 — :5173 is often the other project).
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5174/';
const GOLDEN = '/tmp/mesh-golden.json';

const browser = await chromium.launch({ executablePath: EXE, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => { if (!/pointer lock/i.test(e.message)) console.log(`[pageerror] ${e.message}`); });
  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => !!document.body, null, { timeout: 60000 });

  const sums = await page.evaluate(async () => {
    const cg = await import('/src/scripts/chunkGen.ts');
    const cm = await import('/src/scripts/chunkMesh.ts');
    const { resources } = await import('/src/scripts/blocks.ts');
    const size = { width: 16, height: 320 };
    const params = {                                  // world.ts defaults (fixed → deterministic)
      seed: 0,
      terrain: { scale: 260, magnitude: 60, offset: 10, waterOffset: 128 },
      trees: { trunk: { minHeight: 4, maxHeight: 7 }, canopy: { minRadius: 2, maxRadius: 3, density: 0.7 }, frequency: 0.04 },
      clouds: { scale: 20, density: 0.2 },
    };
    const getOutside = () => 0;                       // air apron → draw all borders (exercises accumulators hard)
    const tintAt = () => [0.4, 0.65, 0.35];
    const fnv = (arr) => { const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength); let h = 0x811c9dc5 >>> 0; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193) >>> 0; } return h; };
    const out = {};
    for (const [cx, cz] of [[0, 0], [16, 0], [160, 320], [-240, 128], [512, -512], [48, 2048], [1024, 1024], [-512, -16]]) {
      const data = cg.generateChunkData(size, params, cx, cz, resources);
      const geo = cm.buildChunkGeometry(data, size, getOutside, tintAt);
      for (const grp of ['casters', 'nonCasters', 'plants']) {
        const g = geo[grp];
        out[`${cx},${cz}:${grp}`] = g
          ? { v: g.positions.length / 3, i: g.indices.length, idxType: g.indices.constructor.name, pos: fnv(g.positions), uv: fnv(g.uvs), lay: fnv(g.layers), col: g.colors ? fnv(g.colors) : -1, idx: fnv(g.indices) }
          : null;
      }
    }
    return out;
  });

  const keys = Object.keys(sums);
  const nonNull = keys.filter((k) => sums[k]).length;
  console.log(`captured ${keys.length} group-checksums (${nonNull} non-empty)`);
  // sanity: the air-apron run must produce lots of geometry
  const totalV = keys.reduce((n, k) => n + (sums[k]?.v || 0), 0);
  console.log(`total vertices across sample: ${totalV.toLocaleString()}`);

  if (!existsSync(GOLDEN)) {
    writeFileSync(GOLDEN, JSON.stringify(sums, null, 2));
    console.log(`GOLDEN CAPTURED → ${GOLDEN} (run again after the edit to verify)`);
  } else {
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'));
    let mism = 0;
    for (const k of new Set([...keys, ...Object.keys(golden)])) {
      const a = JSON.stringify(golden[k]), b = JSON.stringify(sums[k]);
      if (a !== b) { mism++; console.error(`  ✗ ${k}\n      golden: ${a}\n      now:    ${b}`); }
    }
    if (mism === 0) console.log(`\nMESH PARITY PASS ✔ — byte-identical geometry across ${keys.length} groups`);
    else { console.error(`\nMESH PARITY FAIL ✗ — ${mism} group(s) diverged`); process.exitCode = 1; }
  }
} finally {
  await browser.close();
}
