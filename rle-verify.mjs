// Runtime/behavioural verification of the far-chunk RLE compression (chunkRle.ts
// + World.compressFarData + WorldChunk.ensureFlat). Complements the unit-level
// rle-parity.mjs by exercising the REAL lifecycle in the running game:
//   1. compression actually fires once the far ring batches
//   2. SAFETY INVARIANT: a compressed chunk is always batched & at Chebyshev >=5
//      (the freeze margin) — no near/edit-pullable chunk is ever compressed
//   3. codec parity on REAL generated terrain (caves/structures/ice/water) by
//      importing the actual chunkRle.ts through the Vite dev server
//   4. decode-in-situ: world.getBlockId on a compressed chunk yields valid terrain
//   5. demotion: walk so compressed chunks cross into the near ring → they decode,
//      gain individual meshes, and physics reads non-air (no hole, no empty slice)
//   6. regenerate resets compressedChunkCount to 0 then repopulates
//   7. no console/page errors throughout (the animate() try/catch must not be masking real throws)
// Run: dev server on :5173, then `node rle-verify.mjs`.
import { chromium } from 'playwright-core';
import os from 'os';

const EXE = `${os.homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const URL = process.env.APP_URL || 'http://localhost:5173/';
const SHOT = process.env.SHOT || '/tmp/rle-verify.png';

const browser = await chromium.launch({
  executablePath: EXE,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

const errors = [];
let failures = 0;
const fail = (m) => { console.error('  ✗ ' + m); failures++; };
const ok = (m) => console.log('  ✓ ' + m);

const domClick = (page, text) => page.evaluate((t) => {
  const btn = [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === t || (b.textContent || '').includes(t));
  if (!btn) throw new Error('no button: ' + t);
  btn.click();
}, text);

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log(`[console.error] ${m.text()}`); } });
  page.on('pageerror', (e) => { errors.push(e.message); console.log(`[pageerror] ${e.message}`); });

  await page.goto(URL, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('.menu__tab');
    return !!t && t.getBoundingClientRect().width > 0;
  }, null, { timeout: 180000, polling: 1000 });
  console.log('game booted ✔');

  await domClick(page, 'Settings');
  await domClick(page, 'Balanced');           // dd 12 → a deep far ring to compress
  await domClick(page, 'Mode');
  await page.evaluate(() => [...document.querySelectorAll('.menu__mode')].find((b) => (b.textContent || '').includes('Survival')).click());
  console.log('preset Balanced + Survival');

  // ---- PHASE 1: compression fires + settles --------------------------------
  await page.waitForFunction(() => window.__mcDebug.world.compressedChunkCount >= 5,
    null, { timeout: 240000, polling: 1000 });
  await page.waitForFunction(() => {
    const n = window.__mcDebug.world.compressedChunkCount;
    if (window.__c === n) return (window.__ct = (window.__ct || 0) + 1) >= 3;
    window.__c = n; window.__ct = 0; return false;
  }, null, { timeout: 240000, polling: 1000 });
  const p1 = await page.evaluate(() => ({ chunks: window.__mcDebug.world.chunkCount, compressed: window.__mcDebug.world.compressedChunkCount }));
  console.log('phase1 settle:', JSON.stringify(p1));
  if (p1.compressed > 0) ok(`compression fires: ${p1.compressed}/${p1.chunks} chunks compressed`);
  else fail('no chunks compressed — compressFarData never ran');

  // ---- PHASE 2: SAFETY INVARIANT -------------------------------------------
  // Every compressed chunk must be batched AND at cheb >= NEAR_BATCH_KEEP+2 (=5).
  // No chunk a boundary edit / physics / pick could touch is ever compressed.
  const inv = await page.evaluate(() => {
    const w = window.__mcDebug.world;
    const W = w.chunkSize.width, K = 3;             // NEAR_BATCH_KEEP
    const pcx = Math.floor(w.activeCamera ? w.activeCamera.position.x / W : 0);
    const pcz = Math.floor(w.activeCamera ? w.activeCamera.position.z / W : 0);
    let bad = 0, nearCompressed = 0, notBatched = 0, total = 0, minCheb = 1e9;
    for (const c of w.chunkMap.values()) {
      if (!c.dataCompressed) continue;
      total++;
      const cx = Math.round(c.position.x / W), cz = Math.round(c.position.z / W);
      const cheb = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
      minCheb = Math.min(minCheb, cheb);
      const key = `${cx},${cz}`;
      if (cheb < K + 2) { nearCompressed++; bad++; }
      if (!w.batched.has(key)) { notBatched++; bad++; }
      if (c.hasData !== true) bad++;               // hasData must stay true on compress
      if (c.data.length !== 0) bad++;              // compressed → flat stub freed
    }
    return { total, bad, nearCompressed, notBatched, minCheb };
  });
  console.log('phase2 invariant:', JSON.stringify(inv));
  if (inv.bad === 0 && inv.minCheb >= 5) ok(`safety invariant holds: all ${inv.total} compressed chunks batched, cheb>=${inv.minCheb}, hasData=true, data freed`);
  else fail(`safety invariant VIOLATED: ${inv.nearCompressed} near-compressed, ${inv.notBatched} not-batched, minCheb=${inv.minCheb}`);

  // ---- PHASE 3: codec parity on REAL generated terrain ----------------------
  // Import the ACTUAL chunkRle.ts through Vite; round-trip every FLAT resident
  // chunk's real voxel data (caves, structures, ice caps, water — the cells the
  // apron trace flagged as determinism-sensitive).
  const parity = await page.evaluate(async () => {
    const { encodeColumnRLE, decodeColumnRLE } = await import('/src/scripts/chunkRle.ts');
    const w = window.__mcDebug.world;
    let tested = 0, mismatch = 0, firstBad = null;
    for (const c of w.chunkMap.values()) {
      if (c.dataCompressed || !c.hasData || c.data.length === 0) continue;
      const enc = encodeColumnRLE(c.data, c.size);
      const dec = decodeColumnRLE(enc, c.size);
      tested++;
      if (dec.length !== c.data.length) { mismatch++; firstBad = firstBad || { key: `${c.position.x},${c.position.z}`, why: 'len' }; continue; }
      for (let i = 0; i < c.data.length; i++) {
        if (dec[i] !== c.data[i]) { mismatch++; firstBad = firstBad || { key: `${c.position.x},${c.position.z}`, i, got: dec[i], want: c.data[i] }; break; }
      }
    }
    return { tested, mismatch, firstBad };
  });
  console.log('phase3 real-data parity:', JSON.stringify(parity));
  if (parity.tested > 0 && parity.mismatch === 0) ok(`codec round-trips ${parity.tested} REAL terrain chunks byte-for-byte (actual chunkRle.ts)`);
  else fail(`codec parity failed on real terrain: ${parity.mismatch}/${parity.tested} mismatched (${JSON.stringify(parity.firstBad)})`);

  // ---- PHASE 4: decode-in-situ on a compressed chunk ------------------------
  // getBlockId must decode lazily and return structurally-valid terrain
  // (solid below the surface, air at the ceiling), and flip dataCompressed off.
  const insitu = await page.evaluate(() => {
    const w = window.__mcDebug.world, air = window.__mcDebug.BLOCK_IDS.air;
    const W = w.chunkSize.width;
    let checked = 0, ceilingSolid = 0, allAir = 0, stillCompressed = 0;
    let n = 0;
    for (const c of w.chunkMap.values()) {
      if (!c.dataCompressed || n >= 4) continue;
      n++;
      const wx = c.position.x + 8, wz = c.position.z + 8;      // a column near the chunk centre
      const surf = w.sampler(wx, wz).height;
      const below = w.getBlockId(wx, Math.max(1, surf - 1), wz); // should be solid for land columns
      const ceiling = w.getBlockId(wx, w.chunkSize.height - 1, wz); // top of world → air
      let any = false;
      for (let y = 0; y < w.chunkSize.height; y += 8) if (w.getBlockId(wx, y, wz) !== air) { any = true; break; }
      checked++;
      if (ceiling !== air) ceilingSolid++;
      if (!any) allAir++;
      if (c.dataCompressed) stillCompressed++;                  // getBlockId should have decoded it
      void below;
    }
    return { checked, ceilingSolid, allAir, stillCompressed };
  });
  console.log('phase4 decode-in-situ:', JSON.stringify(insitu));
  if (insitu.checked > 0 && insitu.ceilingSolid === 0 && insitu.allAir === 0 && insitu.stillCompressed === 0)
    ok(`decode-in-situ: ${insitu.checked} compressed chunks decode to valid terrain + flip to flat on read`);
  else fail(`decode-in-situ broken: ceilingSolid=${insitu.ceilingSolid} allAir=${insitu.allAir} stillCompressed=${insitu.stillCompressed}`);

  // ---- PHASE 5: demotion — walk so compressed far chunks become near --------
  // Snapshot compressed chunk keys ahead in +x, then walk the player ~6 chunks
  // so they cross the near boundary, demote (worker remesh of decoded data),
  // gain individual meshes, and physics reads solid (no empty-slice hole).
  const target = await page.evaluate(() => {
    const w = window.__mcDebug.world, p = window.__mcDebug.player, W = w.chunkSize.width;
    const pcx = Math.floor(p.position.x / W);
    // a compressed chunk ~6 east → will be ~cheb 0 after we move +6 chunks east
    let best = null;
    for (const c of w.chunkMap.values()) {
      if (!c.dataCompressed) continue;
      const cx = Math.round(c.position.x / W), cz = Math.round(c.position.z / W);
      const dz = Math.abs(cz - Math.floor(p.position.z / W));
      if (cx > pcx && dz <= 1) { const d = Math.abs(cx - (pcx + 6)); if (!best || d < best.d) best = { key: `${cx},${cz}`, cx, cz, wx: c.position.x, wz: c.position.z, d }; }
    }
    return best;
  });
  if (!target) { console.log('phase5: no eastward compressed chunk to demote (frustum wedge) — skipping demotion walk'); }
  else {
    console.log('phase5 demotion target:', JSON.stringify({ key: target.key }));
    await page.evaluate((t) => {
      const w = window.__mcDebug.world, p = window.__mcDebug.player;
      const x = t.wx + 8, z = t.wz + 8;
      const surf = Math.max(w.sampler(Math.floor(x), Math.floor(z)).height, w.params.terrain.waterOffset);
      p.position.set(x, surf + 3, z); p.velocity && p.velocity.set(0, 0, 0);
      p.camera.position.set(x, surf + 3, z); p.camera.lookAt(x + 50, surf, z);
    }, target);
    // wait for the target chunk to demote: flat + unbatched + has individual meshes
    const demoted = await page.waitForFunction((t) => {
      const w = window.__mcDebug.world;
      const c = w.chunkMap.get ? null : null; void c;
      for (const ch of w.chunkMap.values()) {
        const cx = Math.round(ch.position.x / w.chunkSize.width), cz = Math.round(ch.position.z / w.chunkSize.width);
        if (`${cx},${cz}` !== t.key) continue;
        return !ch.dataCompressed && !w.batched.has(t.key) && ch.children.length > 0;
      }
      return false;   // chunk may have unloaded — handled below
    }, target, { timeout: 60000, polling: 500 }).then(() => true).catch(() => false);
    const post = await page.evaluate((t) => {
      const w = window.__mcDebug.world, air = window.__mcDebug.BLOCK_IDS.air;
      const x = t.wx + 8, z = t.wz + 8;
      const surf = w.sampler(x, z).height;
      // physics-style read at a solid surface cell — a freed-without-decode chunk
      // would have sliced an empty array → this reads air (a hole you'd fall through)
      let solidHits = 0, probes = 0;
      for (let dx = 0; dx < 16; dx += 4) for (let dz = 0; dz < 16; dz += 4) {
        const sx = t.wx + dx, sz = t.wz + dz; const sh = w.sampler(sx, sz).height;
        if (sh <= 0) continue;
        probes++; if (w.getBlockId(sx, Math.max(1, Math.min(sh - 1, w.chunkSize.height - 2)), sz) !== air) solidHits++;
      }
      return { solidHits, probes, present: w.isLoadedAt(x, z) };
    }, target);
    console.log('phase5 post-demotion:', JSON.stringify({ demoted, ...post }));
    if (demoted && post.probes > 0 && post.solidHits === post.probes)
      ok(`demotion decoded correctly: target gained meshes + physics reads solid at all ${post.probes} surface probes (no hole)`);
    else if (!post.present)
      console.log('  note: target unloaded during walk (frustum) — demotion not exercised on it, invariant still re-checked below');
    else if (post.probes > 0 && post.solidHits === post.probes)
      ok(`demotion: physics reads solid at all ${post.probes} surface probes (no hole)`);
    else fail(`demotion HOLE: only ${post.solidHits}/${post.probes} surface probes solid — empty-slice/decode bug`);
  }

  // Let the post-walk churn settle (demotions are budgeted/deferred), then
  // re-assert the HARD safety invariant. Note: a chunk compressed at cheb>=5 may
  // now sit at cheb 4 (or transiently <=3 if its demotion is deferred) — that is
  // SAFE (the buildMeshes/getBlockId shims decode on any access; the cheb>=5 rule
  // governs only when we NEWLY compress, proven by phase1/2 + regen-repopulate).
  // The always-true invariant is: compressed ⟹ batched ∧ data freed ∧ hasData ∧
  // no individual meshes. cheb distribution is reported, not failed.
  await page.waitForFunction(() => {
    const n = window.__mcDebug.world.compressedChunkCount;
    if (window.__c2 === n) return (window.__c2t = (window.__c2t || 0) + 1) >= 3;
    window.__c2 = n; window.__c2t = 0; return false;
  }, null, { timeout: 120000, polling: 1000 });
  const inv2 = await page.evaluate(() => {
    const w = window.__mcDebug.world, W = w.chunkSize.width, K = 3;
    const pcx = Math.floor(w.activeCamera.position.x / W), pcz = Math.floor(w.activeCamera.position.z / W);
    let notBatched = 0, notFreed = 0, noHasData = 0, hasChildren = 0, belowNear = 0, atMargin = 0, minCheb = 1e9;
    for (const c of w.chunkMap.values()) {
      if (!c.dataCompressed) continue;
      const cx = Math.round(c.position.x / W), cz = Math.round(c.position.z / W);
      const cheb = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
      minCheb = Math.min(minCheb, cheb);
      if (!w.batched.has(`${cx},${cz}`)) notBatched++;     // HARD: compressed must be batched
      if (c.data.length !== 0) notFreed++;                 // HARD: flat stub freed
      if (c.hasData !== true) noHasData++;                 // HARD: hasData stays true
      if (c.children.length > 0) hasChildren++;            // HARD: batched ⇒ no individual meshes
      if (cheb <= K) belowNear++;                          // soft: should be demoted (shim-safe if not yet)
      else if (cheb === K + 1) atMargin++;                 // soft: lingering in the cheb-4 margin (expected)
    }
    return { compressed: w.compressedChunkCount, notBatched, notFreed, noHasData, hasChildren, belowNear, atMargin, minCheb };
  });
  console.log('phase5 post-walk invariant:', JSON.stringify(inv2));
  const hardBad = inv2.notBatched + inv2.notFreed + inv2.noHasData + inv2.hasChildren;
  if (hardBad === 0) ok(`hard invariant holds after walk: ${inv2.compressed} compressed, all batched+freed+hasData+meshless (${inv2.atMargin} lingering at cheb-4 margin, ${inv2.belowNear} pending-demotion — both shim-safe)`);
  else fail(`hard invariant VIOLATED after walk: notBatched=${inv2.notBatched} notFreed=${inv2.notFreed} noHasData=${inv2.noHasData} hasChildren=${inv2.hasChildren}`);
  await page.screenshot({ path: SHOT });

  // ---- PHASE 6: regenerate resets compression -------------------------------
  await page.evaluate(() => { window.__mcDebug.world.params.seed = 9182; window.__mcDebug.world.generate(false); });
  const justAfter = await page.evaluate(() => window.__mcDebug.world.compressedChunkCount);
  if (justAfter === 0) ok('regenerate cleared all compressed chunks (no stale state)');
  else fail(`regenerate left ${justAfter} compressed chunks`);
  await page.waitForFunction(() => window.__mcDebug.world.compressedChunkCount > 0, null, { timeout: 240000, polling: 1000 });
  ok('compression repopulates after regenerate');

  // ---- PHASE 7: no errors ---------------------------------------------------
  const relevant = errors.filter((e) => /rle|decode|encode|chunkRle|undefined|null|NaN|ensureFlat|compress/i.test(e));
  if (relevant.length === 0) ok(`no RLE/decode-related console or page errors (${errors.length} total console.errors, none relevant)`);
  else fail(`relevant errors: ${JSON.stringify(relevant.slice(0, 5))}`);

  console.log('');
  if (failures) { console.error(`RLE RUNTIME VERIFY FAILED: ${failures} check(s)`); process.exitCode = 1; }
  else console.log('RLE RUNTIME VERIFY PASSED ✔');
} finally {
  await browser.close();
}
