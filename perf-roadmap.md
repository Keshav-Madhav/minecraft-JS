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

## Explicitly rejected (researched, wrong tool)
- **Geometry clipmaps as a structure** — fights worker meshing/blocky walls/tints/canopy.
- **Impostor/RTT horizon rings** — we're triangle-bound, not draw-bound; impostors trade
  tris for fill+RTT and break under terrain grazing-angle parallax.
- **Runtime skirts/stitching** — our deterministic-sampler apron walls already beat both.
- **Dynamic quadtree tile splitting** — fragments BatchedMesh pages (compaction churn).
