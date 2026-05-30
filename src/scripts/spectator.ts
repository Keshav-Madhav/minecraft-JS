import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';

// SPECTATOR / free-cam — the repurposed orbital camera. OrbitControls still drives
// looking (drag to orbit) and zoom (scroll); on top of that, WASD + Space/Shift
// fly the WHOLE rig (camera AND its orbit target, moved together) through the
// world. Because both move by the same vector the orbit offset is preserved, so
// it dollies smoothly rather than snapping. No gravity, no collision (ghosts
// through blocks), no block editing — a true spectator.
export class Spectator {
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  enabled = false;          // gated by mode + pause
  speed = 22;               // base fly speed (blocks/sec); Ctrl boosts it

  private keys = { w: false, a: false, s: false, d: false, up: false, down: false, fast: false };
  private fwd = new THREE.Vector3();
  private right = new THREE.Vector3();
  private move = new THREE.Vector3();
  private readonly worldUp = new THREE.Vector3(0, 1, 0);

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement) {
    this.camera = camera;
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.enablePan = false;        // WASD handles translation; reserve drag for orbit
    this.controls.enableZoom = false;       // scroll adjusts FLY SPEED instead of dollying
    this.controls.minDistance = 1;
    this.controls.maxDistance = 600;
    this.controls.enabled = false;          // off until spectator mode activates

    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    // Scroll = fly-speed (faster up, slower down), exponential so it ranges widely.
    dom.addEventListener('wheel', (e) => {
      if (!this.enabled) return;
      e.preventDefault();
      this.speed = Math.min(240, Math.max(4, this.speed * Math.exp(-e.deltaY * 0.0015)));
    }, { passive: false });
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.enabled) return;
    const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    switch (k) {
      case 'w': this.keys.w = down; break;
      case 'a': this.keys.a = down; break;
      case 's': this.keys.s = down; break;
      case 'd': this.keys.d = down; break;
      case ' ': this.keys.up = down; e.preventDefault(); break;     // ascend
      case 'Shift': this.keys.down = down; break;                   // descend
      case 'Control': this.keys.fast = down; break;                 // boost
    }
  }

  setEnabled(v: boolean) {
    this.enabled = v;
    this.controls.enabled = v;
    if (!v) this.keys = { w: false, a: false, s: false, d: false, up: false, down: false, fast: false };
  }

  // Drop the rig at `pos` looking along `dir` (used when entering spectator from
  // a first-person mode so the view is continuous).
  placeAt(pos: THREE.Vector3, dir: THREE.Vector3) {
    this.camera.position.copy(pos);
    this.controls.target.copy(pos).addScaledVector(dir, 8);
    this.controls.update();
  }

  // `frozen` (paused / map open) keeps the camera still but still ticks
  // OrbitControls damping so a release doesn't snap.
  update(delta: number, frozen: boolean) {
    if (this.enabled && !frozen) {
      const kx = (this.keys.d ? 1 : 0) - (this.keys.a ? 1 : 0);
      const kf = (this.keys.w ? 1 : 0) - (this.keys.s ? 1 : 0);
      const ky = (this.keys.up ? 1 : 0) - (this.keys.down ? 1 : 0);
      if (kx || kf || ky) {
        // Forward follows the FULL look direction (with pitch) so flying forward
        // while looking down descends, like a real free-cam. Strafe stays
        // horizontal (camera's right axis, flattened), and Space/Shift are pure
        // vertical — so you always have clean up/down regardless of pitch.
        this.camera.getWorldDirection(this.fwd).normalize();
        this.right.setFromMatrixColumn(this.camera.matrixWorld, 0);
        this.right.y = 0;
        if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
        this.right.normalize();
        this.move.set(0, 0, 0)
          .addScaledVector(this.fwd, kf)
          .addScaledVector(this.right, kx)
          .addScaledVector(this.worldUp, ky);
        if (this.move.lengthSq() > 0) {
          this.move.normalize().multiplyScalar(this.speed * (this.keys.fast ? 3.2 : 1) * delta);
          this.camera.position.add(this.move);
          this.controls.target.add(this.move);   // move both → orbit offset preserved
        }
      }
    }
    this.controls.update();
  }
}
