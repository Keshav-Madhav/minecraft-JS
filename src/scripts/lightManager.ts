import * as THREE from 'three';
import { LIGHT_SOURCES } from './blockTypes';
import { World } from './world';

// Localized block lighting WITHOUT a full voxel light-propagation engine: a small
// FIXED pool of THREE point lights that, every frame, snaps to the N nearest
// light-emitter blocks around the camera (torches, lanterns, glowstone, sea
// lanterns, campfires, magma…). The pool is created once and only its
// position/colour/intensity change — so the light count never varies and three
// never recompiles shaders. Emitter positions come from each chunk's
// `lightEmitters` (filled by the worker / edit rescan), so this is just a cheap
// gather over the handful of nearby chunks. Emitter blocks ALSO render emissive
// (self-glow) via the material — this adds the surrounding illumination.
const POOL = 24;            // max simultaneous dynamic lights (nearest to camera). Sized so a
                            // whole lamp-lit village stays lit at once — the previous 12 dropped
                            // sources as you walked (they appeared to "turn off"); 24 covers a
                            // typical cluster so lights stay on as you move.
const RADIUS_CHUNKS = 3;    // gather emitters from chunks within this radius (≈48 blocks)
const MAX_DIST = 48;        // ignore emitters farther than this (blocks)

export class LightManager {
  enabled = true;
  private lights: THREE.PointLight[] = [];
  // Preallocated nearest-K buffers (parallel arrays) — the per-frame gather does
  // NO allocation: each candidate within range competes for one of the POOL slots,
  // evicting the current farthest. Order within the kept set is irrelevant (each
  // gets its own light), so no sort is needed either.
  private bd2 = new Float64Array(POOL);   // squared distance held in each slot
  private bx = new Float64Array(POOL);
  private by = new Float64Array(POOL);
  private bz = new Float64Array(POOL);
  private bid = new Int32Array(POOL);

  constructor(scene: THREE.Scene) {
    for (let i = 0; i < POOL; i++) {
      // decay=1 (not the physical 2) so light reaches most of its range instead of
      // collapsing near the source — a torch lights a decent area, not just itself.
      const L = new THREE.PointLight(0xffffff, 0, 16, 1);  // colour, intensity, distance(range), decay
      L.castShadow = false;     // dynamic point shadows are far too expensive at this count
      scene.add(L);
      this.lights.push(L);
    }
  }

  // Disable the whole pool (quality preset): zero every light once and stop
  // gathering. Re-enabling resumes the per-frame snap.
  setEnabled(v: boolean) {
    if (this.enabled === v) return;
    this.enabled = v;
    if (!v) for (const L of this.lights) L.intensity = 0;
  }

  // Re-aim the pool at the nearest emitters. `time` (seconds) drives torch/campfire flicker.
  update(world: World, cam: THREE.Vector3, time: number) {
    if (!this.enabled) return;
    const { bd2, bx, by, bz, bid } = this;
    for (let i = 0; i < POOL; i++) bd2[i] = Infinity;
    let filled = 0, worst = Infinity, worstSlot = 0;
    const maxD2 = MAX_DIST * MAX_DIST;

    for (const c of world.getNearbyChunks(cam, RADIUS_CHUNKS)) {
      const e = c.lightEmitters;
      for (let i = 0; i + 3 < e.length; i += 4) {
        const x = e[i], y = e[i + 1], z = e[i + 2];
        const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > maxD2) continue;
        let slot = -1;
        if (filled < POOL) slot = filled++;       // fill empty slots first
        else if (d2 < worst) slot = worstSlot;     // else evict the current farthest
        if (slot < 0) continue;
        bd2[slot] = d2; bx[slot] = x; by[slot] = y; bz[slot] = z; bid[slot] = e[i + 3];
        if (filled === POOL) {                     // recompute the farthest kept slot
          worst = -1;
          for (let k = 0; k < POOL; k++) if (bd2[k] > worst) { worst = bd2[k]; worstSlot = k; }
        }
      }
    }

    for (let i = 0; i < POOL; i++) {
      const L = this.lights[i];
      const s = i < filled ? LIGHT_SOURCES[bid[i]] : undefined;
      if (!s) { L.intensity = 0; continue; }
      L.position.set(bx[i], by[i] + 0.2, bz[i]);   // block centre, lifted toward the flame
      L.color.setRGB(s.r, s.g, s.b);
      L.distance = s.range;
      // flicker: a cheap per-light wobble (phase varied by position) for torch/campfire
      const flick = s.flicker > 0
        ? 1 - s.flicker * (0.5 + 0.5 * Math.sin(time * 9 + bx[i] * 1.3 + bz[i] * 0.7))
        : 1;
      // Distance rolloff near the gather edge: an emitter leaving MAX_DIST (or
      // the nearest-24 set) used to snap to zero — walking through a lamp-lit
      // village made torches visibly pop on/off. Fade over the last ~25% of
      // range so they dim out instead.
      const edge = Math.min(1, Math.max(0, (maxD2 - bd2[i]) / (maxD2 * 0.45)));
      L.intensity = s.intensity * flick * edge;
    }
  }
}
