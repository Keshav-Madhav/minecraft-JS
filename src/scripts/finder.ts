// Biome / structure FINDER — locate the nearest occurrence of a biome or structure
// from the player, with direction + distance. Everything here is a PURE function of
// the world seed/params (structInfo + the column sampler are deterministic), so it
// scans arbitrary regions client-side without loading any chunks.
import {
  structInfo, structureFitsBiome, STRUCT_CELL, BIOME,
  ST_TOWER, ST_PYRAMID, ST_VILLAGE, ST_MANSION, ST_IGLOO, ST_CAMPSITE,
  ST_RUINS, ST_OUTPOST, ST_LIGHTHOUSE, ST_WITCH_HUT,
  type WorldSampler,
} from './chunkGen';

export type FindResult = { x: number, z: number, dist: number } | null;

// Nearest structure of `kind` that actually fits its column's biome. Scans the
// deterministic STRUCT_CELL region grid out to `maxRings` cells (~maxRings*144 blocks)
// and returns the closest match. structInfo is a cheap hash; the (rarer) biome check
// only runs for matching-kind cells.
export function findNearestStructure(sampler: WorldSampler, seed: number, px: number, pz: number, kind: number, maxRings = 48): FindResult {
  const cx0 = Math.floor(px / STRUCT_CELL), cz0 = Math.floor(pz / STRUCT_CELL);
  let best: FindResult = null, bestD = Infinity;
  for (let dx = -maxRings; dx <= maxRings; dx++) {
    for (let dz = -maxRings; dz <= maxRings; dz++) {
      const s = structInfo(cx0 + dx, cz0 + dz, seed);
      if (!s || s.kind !== kind) continue;
      if (!structureFitsBiome(kind, sampler(s.ox, s.oz).biome)) continue;
      const d = (s.ox - px) ** 2 + (s.oz - pz) ** 2;
      if (d < bestD) { bestD = d; best = { x: s.ox, z: s.oz, dist: Math.sqrt(d) }; }
    }
  }
  return best;
}

// Nearest column of biome `biomeId`. Expanding shell scan at `step` (coarse — a
// biome is a large region, so a 48-block grid finds it), returning the closest hit;
// stops once the searched disc fully covers the best find, and caps total samples so
// a far/absent target can't hang the click.
export function findNearestBiome(sampler: WorldSampler, px: number, pz: number, biomeId: number, maxR = 9000, step = 48): FindResult {
  let best: FindResult = null, bestD = Infinity, samples = 0;
  const cap = 70000, maxRing = Math.ceil(maxR / step);
  for (let r = 0; r <= maxRing; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;   // shell only (don't re-scan the interior)
        if (++samples > cap) return best;
        const wx = px + dx * step, wz = pz + dz * step;
        if (sampler(wx, wz).biome === biomeId) {
          const d = (wx - px) ** 2 + (wz - pz) ** 2;
          if (d < bestD) { bestD = d; best = { x: wx, z: wz, dist: Math.sqrt(d) }; }
        }
      }
    }
    if (best && (r + 1) * step * (r + 1) * step > bestD) break;   // disc of radius (r+1)*step covers the best find
  }
  return best;
}

const DIRS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
// 8-point compass bearing from (0,0) to (dx,dz). World: +x = East, -z = North
// (matches the map's yaw = atan2(camDir.x, -camDir.z)).
export function compass(dx: number, dz: number): string {
  return DIRS[((Math.round(Math.atan2(dx, -dz) / (Math.PI / 4)) % 8) + 8) % 8];
}

// Curated findable targets (label + id/kind) surfaced in the Finder UI.
export const BIOME_TARGETS: ReadonlyArray<{ id: number, label: string }> = [
  { id: BIOME.mountains, label: 'Mountain Range' }, { id: BIOME.cherry, label: 'Cherry Grove' },
  { id: BIOME.jungle, label: 'Jungle' }, { id: BIOME.mushroom, label: 'Mushroom Isle' },
  { id: BIOME.badlands, label: 'Badlands' }, { id: BIOME.iceSpikes, label: 'Ice Spikes' },
  { id: BIOME.darkForest, label: 'Dark Forest' }, { id: BIOME.swamp, label: 'Swamp' },
  { id: BIOME.desert, label: 'Desert' }, { id: BIOME.savanna, label: 'Savanna' },
];
export const STRUCTURE_TARGETS: ReadonlyArray<{ kind: number, label: string }> = [
  { kind: ST_VILLAGE, label: 'Village' }, { kind: ST_MANSION, label: 'Mansion' },
  { kind: ST_PYRAMID, label: 'Pyramid' }, { kind: ST_TOWER, label: 'Tower' },
  { kind: ST_LIGHTHOUSE, label: 'Lighthouse' }, { kind: ST_WITCH_HUT, label: 'Witch Hut' },
  { kind: ST_IGLOO, label: 'Igloo' }, { kind: ST_OUTPOST, label: 'Outpost' },
  { kind: ST_RUINS, label: 'Ruins' }, { kind: ST_CAMPSITE, label: 'Campsite' },
];
