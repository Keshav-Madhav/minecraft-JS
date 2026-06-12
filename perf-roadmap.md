# Performance & Quality Roadmap — research synthesis (2026-06-06)

Sources: Sodium + Nvidium (cloned, read at source), Distant Horizons core (source),
Voxy (source), vanilla MC cave-culling (Checchi), three.js issues/discussions,
CDLOD/clipmaps/Chunked-LOD literature. Current state: draws collapsed 35-43× via
BatchedMesh pools; **GPU-bound at Ultra/MAX (19-25M drawn tris)**; RAM 2.6-2.9GB
at MAX; LOD band-edge pop; teleport gen bursts.

## ⚠ Gate first: fragment-bound or vertex-bound?
One measurement decides several items below: drop `resolutionScale` to 0.5 at
Ultra. **fps jumps a lot → fragment-bound** (ship z-prepass + face culling
first). **fps barely moves → vertex/triangle-bound** (ship vertex quantization
+ stair-smoothing + geomorph first).

## Tier 1 — drop-in / small, do these first
| # | Item | Attacks | Notes |
|---|------|---------|-------|
| 1 | **Quantized vertex format** (Sodium: 20B; Nvidium: 16B; ours 40B → ~16-20B): position 2×u16-packed (descale via the instance matrix we already set), normal → 3-bit face id + 6-entry shader LUT (plants keep real normals — separate format per pool is fine, pools are per-material), UV **derived in-shader** for full-cube faces (we already fract() world coords; keep stored u16 UV for slabs/stairs flag-gated), layer u16, tint u32 | RAM at MAX (~40-55% geometry shrink), vertex-fetch bandwidth, worker→main transfer | `attribute.gpuType = IntType` (r184) + unpack in onBeforeCompile. Switch chunkMesh+lodMesh finalize together (BatchedMesh layout fixed at first add) |
| 2 | **DH noise-texture on far LOD** (steps=4, intensity=0.05, dropoff≈1024): hash-brighten baked color, ~10 ALU, zero texture taps | GPU fragment cost on the 3km ring + hides flat-quad look | Could skip the 202-layer array fetch entirely on far cells (use per-layer 1×1 avg color) |
| 3 | **Bayer 4×4 screen-door dither fade** at LOD↔chunk handoff and ring edge | band-edge pop | DH's exact approach; no blending/sorting, drop into our LOD frag |
| 4 | **Aerial-perspective fog** (desaturate + blue-shift + black-lift instead of flat mix) | sells distance, masks LOD artifacts | 3-5 lines in CYL_FOG_FRAGMENT, shared by all fogged materials |
| 5 | **Stair-smoothing on stride-8/16 megatiles**: merge monotone step runs into slanted quads (no walls) | ~halves slope tris exactly where the far ring is heaviest | Pure lodMesh.ts mesher change; steps are sub-pixel at 700m+ anyway |
| 6 | **KHR_parallel_shader_compile + compileAsync warmup at boot** | first-frame + quality-toggle compile hitches | `material.parallelCompile=true`; r184 compileAsync is truly async |
| 7 | **Voxy mip fix for cutout textures**: flood-fill RGB under transparent texels + linear-space alpha-weighted mips; alpha-test from `textureLod(...,0).a` | black bleed on foliage/leaves at distance (our canopy darkening!) | Pure texture preprocessing in blockArrayMaterial load path |

## Tier 2 — medium effort, big payoffs
| # | Item | Attacks | Notes |
|---|------|---------|-------|
| 8 | **CDLOD whole-tile-Y geomorph**: 2nd height attr (coarse-stride sample), vertex morph `mix(y, hCoarse, α)` over outer ~⅓ of each band (Strugar morphStart 0.66) | kills stride pop entirely, smooths stairs at band edges free | Walls' top corners must carry hCoarse to stay welded; +~1.5× sampler calls/tile in worker; LOD pools only |
| 9 | **Z-prepass on the near chunk ring** (depth-only via existing depth material, then color with depthFunc EQUAL) | fragment cost (textureGrad aniso + pow + fog + caustics ×overdraw) | ONLY if fragment-bound (see gate); skip the LOD ring (low overdraw, doubles its vertex cost) |
| 10 | **6-way face-orientation buckets**: split greedy output by normal; hide the 2-3 back-facing buckets per chunk via setVisibleAt | ~halves submitted opaque tris | 3× geometry-id count → pair with #15 BVH culling; measured 23% frame win in literature |
| 11 | **Visibility-graph cave culling** (Checchi/Sodium): per-chunk 6×6 face-reachability (flood-fill at mesh time in the worker, 48-bit table) + camera BFS gating setVisibleAt | overdraw in hills/caves; 50-99% cull in caves | Composes with BatchedMesh; the BFS replaces nothing we have (we only frustum-cull) |
| 12 | **Velocity-based LOD pull (DH)**: when speed >10 b/s, pull the chunk ring in (up to 5×) and let the LOD ring cover | teleport/fast-flight gen bursts | CPU-only ladder tweak; pairs with our dd/lod decoupling |
| 13 | ~~**Raise worker cap**~~ SHIPPED 2026-06-07 (cap 4→8; probe: pipeline now worker-bound, applyQ≈0, ~300 chunks/s @ 8w — next fill lever is worker-side gen cost, not more workers) | teleport gen throughput | Keep ≤8: main-thread applies + per-worker sampler RAM stop paying beyond that |

## Tier 3 — bigger bets (after 1-2 land)
- **Shared quad index buffer + multiDrawElementsBaseVertexWEBGL custom path**
  (bypass BatchedMesh): kills per-geometry index storage (~6MB total shared
  buffer), fuses draws further. Custom GLBufferAttribute/RawShader path — real
  effort. Check baseVertex variant availability per browser.
- **BVH-over-instances culling in BatchPool** (InstancedMesh2 pattern): three's
  per-instance cull is O(n) per pass; BVH keeps it sublinear when #10 triples
  instance count.
- **Multi-slice vertical LOD columns** (DH verticalQuality): 2-4 RLE slices in
  the nearest LOD band only → overhangs/cave-mouth silhouettes at distance.
- **DH-style spiral SSAO for the LOD ring** (6 taps, depth-derived normals,
  fade by 1600 blocks) — makes flat LODs read 3D.
- **CPU coverage-buffer occlusion** on the LOD heightmap (64×32 software depth
  raster from the sampler; gate setVisibleAt) — speculative, prototype + measure.
- **SharedArrayBuffer chunk data** (needs COOP/COEP) — border reads without copies.
- **OffscreenCanvas render worker** — Safari blocker; only if main-thread contention shows.
- **WebGPU dual path** — deferred: our draws are already collapsed; the compute-culling
  prize demands a TSL shader rewrite.

## Shipped 2026-06-10 — exact-output worker + main-thread package
Full-audit round (frame loop / worker pipeline / mesher / streaming / GPU /
LOD / physics / UI / map / net). All worldgen+mesher changes are **byte-identical**
(bench-gen.mjs --compare over 40 mixed chunks + mesh-parity golden + rle-parity +
lod-smoke + mp-smoke all green). **Measured: full Ultra ring (3655 chunks)
18.4s → 7.1s = 2.6× fill throughput (198 → 515 chunks/s @ 8 workers, same-session
stash A/B); node pipeline bench 9.6 → 6.8 ms/chunk (mesher 5.5 → 3.2).**
- **fastSimplex.ts**: bit-identical SimplexNoise port (typed perm/permMod12, flat
  grad table, inlined dots, hoisted F2/G2; verified `Object.is`-equal over 15M
  samples × 5 seeds and through the full pipeline). chunkGen imports it now.
- **chunkMesh occupancy row-skip**: one linear pass marks per-Y "any cube" / "any
  non-occluder" / "any special"; the greedy sweep memsets provably-dead mask rows
  (the whole solid underground that caves dragged into the band) instead of
  running idAt+faceVisible per cell; plant pass skips dead Y levels; all column
  scans use incremental flat indices. Outside-facing border slices are exempt
  (apron unknown to occupancy).
- **generateTerrain segmented fill**: direct data[] writes (no set-closure), per-
  column deepslate boundary hoisted (deepRock re-hashed per cell), y-loop split
  into bedrock / no-cave / cave-band / sub-margin segments mirroring deepCell's
  early-outs exactly; caveAir cheese check reordered iso-band-first (P≈8% vs
  gate P≈27%, measured) — pure AND, same result, ~92% fewer gate noise calls.
- **generateResources**: direct data[] access (get/set closures + bounds checks
  were ~5% of gen).
- **Player pick = voxel DDA** over world.getBlockId (≤ ~14 lookups) replacing
  Raycaster.intersectObjects over the 3×3 chunk groups — three has no BVH, so
  every pick brute-forced thousands of ray-triangle tests/frame (320-tall chunk
  bounds always contain the 4-unit ray). Same break/place/targeted cells
  (verified against block data); plants/partial blocks now target as full cells
  (MC-like).
- **menu.refreshStats** gated to the existing 4 Hz stats tick (was 10+ DOM writes
  + MP-tab button flips every frame while paused).
- New harness: **bench-gen.mjs** (esbuild-bundles the real worker pipeline into
  node; per-phase ms/chunk + sha256 byte-parity vs a saved baseline). Use it to
  gate ANY future worldgen/mesher change: `node bench-gen.mjs --save base.json`
  before, `--compare base.json` after.
- Audited-and-rejected this round: lightManager worst-slot scan (only runs per
  accepted emitter — fine); batch-page "full re-upload per add" claim (partial
  updates verified earlier); ensureFlat "per-edit decode" (idempotent); fog/
  caustics shader micro-rewrites (visual risk ≫ gain at measured bounds).
- Deferred (real but niche): dataStore.forEachEdit scans ALL edits for chunks
  that have any (nested per-chunk map would fix; touches save/MP-init shape);
  mapWorker chunkTops not IDB-persisted (cold deep-zoom regen); worker sweep
  fusion (emitters+mapTile+top scans share one pass, ~0.3ms/chunk).
- Next fill-speed lever beyond this: **output-changing** coarse-lattice cave/ore
  noise (4×4×4 trilinear, MC-style) — would cut the remaining ~32% noise share
  several-fold but changes the world (saves/golden invalidated); decide as a
  product call, not a perf patch.

## Shipped 2026-06-10 (round 2) — cross-GPU render package (IMR/NVIDIA-targeted)
Apple TBDR gets overdraw-free opaque via hidden-surface removal; Windows/NVIDIA/AMD
(immediate-mode) do NOT — early-Z there is only as good as draw order. This round
ships universal wins that are at worst neutral on Apple (verified: deterministic
seed-4242 headed A/B, Balanced 357-360 vs baseline 359 fps, Ultra 93-94 vs 94 —
parity within launch noise) and structurally help IMR GPUs:
- **Cutout-after-opaque draw order**: leaf/plant/LOD-canopy pools + individual
  leaf/plant chunk meshes carry `renderOrder = 1` → ALL alpha-tested (discard)
  geometry draws after ALL solid terrain. IMR: terrain depth early-Z-kills hidden
  foliage fragments; TBDR: discard draws stop interleaving the opaque HSR stream
  (vendor ordering: opaque → alpha-test → blended). Depth-tested → image identical.
- **CulledBatchedMesh** (batchPool.ts): r184 BatchedMesh recomputed every visible
  instance's world bounding sphere EVERY pass (getMatrixAt + Sphere.applyMatrix4 =
  3 sqrts + 6 plane dots; three issue #28776). Instances never move → BatchPool.add
  caches the page-local sphere once (Float32Array xyzr) and the override loop is
  6 dots/instance. Also COUNTING-SORTS survivors near→far (64-block buckets, O(n))
  into the multi-draw list — intra-page order was ADD order = uncontrolled overdraw
  inside each page on IMR. Coupled to r184 privates (_instanceInfo/_geometryInfo/
  _multiDraw*/_indirectTexture) — re-verify on any three upgrade; falls back to
  stock for sortObjects/wireframe/ArrayCamera.
- **Rescan de-allocation**: visibleKeys is now Set<number> (numKey), getVisibleChunks
  fills a pooled coord array (valid until next rescan — pending is rebuilt within the
  same rescan), pending-filter + refreshLodVisibility use chunkNumMap, and
  applyFoliageVisibility reads chunk.batchEntry (mirrored handle on the chunk)
  instead of a string-key Map get. Kills ~15-20k allocs per rescan at dd64 (rescans
  fire per chunk-cross AND per ~8.5° yaw — was real GC pressure while mouselooking).
- **Anisotropy per preset** (setTextureAnisotropy): low 2× / balanced 4× / fancy+ 8×.
  AF multiplies grazing-angle texture taps — a real fragment lever on weak GPUs.
- **Water recolour time-sliced**: the 625-sampler coarse grid runs 7 rows/frame
  (~0.3ms) instead of one ~1-1.5ms synchronous spike per 24-block snap; bilinear
  fill + upload land at job end (≤4-frame colour lag on a smooth field).
- **God rays at half res** (ultraGraphics.ts): the 48-tap march renders to a
  half-res HalfFloat RT (¼ the taps), composite upsamples — shafts are soft, no
  visible difference; march skipped entirely when the sun is off-screen.
- **State-reset gaps**: generate() now resets demotionsDeferred + lodWorkerRetryTick.
- Verified: tsc, mesh-parity, rle-parity, lod-smoke, mp-smoke all green; lod-shots
  screenshots correct (no cull holes). NVIDIA-side gains NOT locally measurable
  (no Windows box) — re-run ab-fps.mjs there when available.
- Refuted this round (don't re-flag): physics getBlockId alloc claim (numeric path
  already), minimap idle heartbeat (epoch-gated), PostFX target leak (composer
  disposes), RemotePlayer avatar leak (singleton reuse), spectator damping-while-
  paused (deliberate, micro).

## Explicitly rejected (researched, wrong tool)
- **Geometry clipmaps as a structure** — fights worker meshing/blocky walls/tints/canopy.
- **Impostor/RTT horizon rings** — we're triangle-bound, not draw-bound; impostors trade
  tris for fill+RTT and break under terrain grazing-angle parallax.
- **Runtime skirts/stitching** — our deterministic-sampler apron walls already beat both.
- **Dynamic quadtree tile splitting** — fragments BatchedMesh pages (compaction churn).
