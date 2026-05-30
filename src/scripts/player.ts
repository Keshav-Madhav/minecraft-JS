import * as Three from 'three';
import { PointerLockControls } from 'three/examples/jsm/Addons.js';
import { World } from './world';
import { blocks } from './blocks';
import { Tool } from './tool';

const screeCenter=new Three.Vector2();
// Spawn above the tallest terrain (sea level 128, peaks ~180) so the player
// drops onto the surface instead of inside solid rock.
const SPAWN = new Three.Vector3(0, 200, 0);
// Scratch objects reused every frame to avoid per-frame allocations.
const _hitInside = new Three.Vector3();
const _hitOutside = new Three.Vector3();
const _selected = new Three.Vector3();
const _targeted = new Three.Vector3();

// ---- movement tuning -------------------------------------------------------
const SPRINT_MULT = 1.35;        // sprint speed = maxSpeed × this
const GROUND_ACCEL = 70;         // m/s² ramp toward target speed on the ground
const AIR_ACCEL = 26;            // limited air control (steer, don't fully redirect)
const GROUND_FRICTION = 13;      // exponential decel coeff when stopping on the ground
const ICE_ACCEL = 16;            // low traction on ice: slow to build/redirect speed
const ICE_FRICTION = 1.4;        // ice barely slows you → a long glide to a stop
const COYOTE_TIME = 0.10;        // s after walking off an edge you can still jump
const JUMP_BUFFER = 0.16;        // s a jump press is remembered (fires the instant you land)
const SPRINT_JUMP_BOOST = 1.18;  // forward-speed multiplier kicked in on a sprint-jump
const DOUBLE_TAP_MS = 280;       // double-tap-forward window to start sprinting
const BASE_FOV = 70, SPRINT_FOV = 78;
// --- flight (creative + survival's "enable flight") -------------------------
const FLY_BASE = 1.6;            // fly speed = maxSpeed × this (horizontal AND vertical)
const FLY_SPRINT = 3.0;          // fly-sprint multiplier (double-tap-forward while flying)
const FLY_ACCEL = 80;            // responsive full-control acceleration while flying
const FLY_TOGGLE_MS = 300;       // double-tap-space window to toggle flight on/off
// move cur toward target by at most maxStep (per-substep linear acceleration).
const approach = (cur: number, target: number, maxStep: number) => {
  const d = target - cur;
  return Math.abs(d) <= maxStep ? target : cur + Math.sign(d) * maxStep;
};

export class Player {
  // near=0.3 (not 0.1) reclaims most of the depth buffer's precision — the
  // hyperbolic distribution wastes ~90% of its range in the first few units —
  // which is what lets us drop logarithmicDepthBuffer (see main.ts) without
  // z-fighting. Kept at 0.3 (not higher) so it doesn't clip the held tool.
  camera = new Three.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.3, 200);
  controls = new PointerLockControls(this.camera, document.body);
  boundsHelper: Three.Mesh;

  radius = 0.4;

  height = 1.8;
  jumpSpeed = 10;
  onGround = false;
  onIce = false;   // set by Physics: standing on ice/packed ice → slide (low friction)

  maxSpeed = 8;   // walking speed (GUI "Speed" slider); sprint scales from this
  // velocity is camera-local: x = strafe/right, z = forward, y = vertical. The
  // collision system maps it to world space via #right/#fwd (the camera's own
  // horizontal basis), so wall contacts cancel the matching component exactly.
  velocity = new Three.Vector3();
  #worldVelocity = new Three.Vector3();
  #fwd = new Three.Vector3(0, 0, -1);   // camera horizontal forward (world), refreshed per substep
  #right = new Three.Vector3(1, 0, 0);  // camera horizontal right  (world)

  // movement input + state
  #kW = false; #kS = false; #kA = false; #kD = false;  // held direction keys
  #kUp = false; #kDown = false;  // ascend / descend (Space / Shift) while flying
  sprintKey = false;             // sprint modifier (Shift) held
  #doubleTapSprint = false;      // double-tap-forward sprint, sticky until forward released
  #lastTapW = 0;
  #lastTapSpace = 0;             // double-tap-space → toggle flight
  sprinting = false;             // resolved sprint state (drives the FOV kick)
  #coyote = COYOTE_TIME;         // time since last grounded (coyote window)
  #jumpBuffer = 0;               // remaining validity of a buffered jump press
  #fov = BASE_FOV;

  // Flight. `flying` = no gravity, free vertical movement (Space up / Shift down);
  // `canFly` gates the double-tap-space toggle (Creative + Survival both allow it).
  // Physics skips gravity/buoyancy while flying but STILL resolves collisions, so
  // you stop at walls instead of clipping (MC-style creative flight).
  flying = false;
  canFly = true;
  // Space held (regardless of flying) — read by Physics for swim-up while in water.
  wantsUp = false;

  cameraHelper = new Three.CameraHelper(this.camera);

  raycaster = new Three.Raycaster(undefined, undefined, 0, 4);
  selectedCoords:  Three.Vector3 | null = null;
  targetedBlock:   Three.Vector3 | null = null;   // the SOLID block under the crosshair (for right-click "use")
  selectionHelper: Three.Mesh;

  activeBlockId = blocks.air.id;

  // When false (e.g. the world map is open) keyboard input is ignored so the
  // pointer isn't re-grabbed and the player doesn't move.
  enabled = true;

  tool = new Tool();

  constructor(scene: Three.Scene) {
    this.camera.position.copy(SPAWN);
    this.camera.layers.enable(1);
    scene.add(this.camera);
    scene.add(this.cameraHelper);

    this.camera.add(this.tool)

    document.addEventListener('keydown', this.onkeydown.bind(this))
    document.addEventListener('keyup', this.onkeyup.bind(this))

    this.boundsHelper = new Three.Mesh(
      new Three.CylinderGeometry(this.radius, this.radius, this.height, 16),
      new Three.MeshBasicMaterial({ wireframe: true})
    )
    this.boundsHelper.visible = false;
    this.cameraHelper.visible = false;
    scene.add(this.boundsHelper);

    const selectionMaterial = new Three.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
    const selectionGeometry = new Three.BoxGeometry(1.001, 1.001, 1.001);
    this.selectionHelper = new Three.Mesh(selectionGeometry, selectionMaterial);
    scene.add(this.selectionHelper);

    this.raycaster.layers.set(0);
  }

  update(world: World) {
    this.updateRayCast(world)
    this.tool.update();
    this.#updateFov();
  }

  // Toggle flight (double-tap space, or set by the mode switch). Clears vertical
  // velocity so you don't keep a fall/jump impulse, and un-grounds on takeoff.
  setFlying(v: boolean) {
    if (this.flying === v) return;
    this.flying = v;
    this.velocity.y = 0;
    if (v) this.onGround = false;
  }

  // Subtle FOV widen while sprinting (sense of speed). Per-frame lerp; only
  // touches the projection matrix while actually changing.
  #updateFov() {
    const target = (this.sprinting && this.controls.isLocked) ? SPRINT_FOV : BASE_FOV;
    const next = this.#fov + (target - this.#fov) * 0.18;
    if (Math.abs(next - this.#fov) > 0.01) {
      this.#fov = next;
      this.camera.fov = next;
      this.camera.updateProjectionMatrix();
    }
  }

  updateRayCast(world: World) {
    this.raycaster.setFromCamera(screeCenter, this.camera);
    // The pick ray is only 4 units long, so only the player's own chunk and its
    // immediate neighbours can be hit — intersecting just those avoids walking
    // every chunk mesh in the world each frame.
    const candidates = world.getNearbyChunks(this.camera.position, 1);
    const intersects = this.raycaster.intersectObjects(candidates, true);

    if(intersects.length > 0){
      const intersection = intersects[0];
      const dir = this.raycaster.ray.direction; // normalized view direction

      // The hit point sits on the boundary between the targeted solid block and
      // the empty cell in front of it. Nudging a hair along the view direction
      // lands inside the block we're looking at; nudging back lands in the
      // empty neighbour cell where a new block would be placed. Blocks are
      // centred on integer coordinates, so rounding gives the cell.
      if(this.activeBlockId === blocks.air.id){
        _hitInside.copy(intersection.point).addScaledVector(dir, 0.01);
        this.selectedCoords = _selected.set(Math.round(_hitInside.x), Math.round(_hitInside.y), Math.round(_hitInside.z));
      } else {
        _hitOutside.copy(intersection.point).addScaledVector(dir, -0.01);
        this.selectedCoords = _selected.set(Math.round(_hitOutside.x), Math.round(_hitOutside.y), Math.round(_hitOutside.z));
      }

      // The SOLID block actually under the crosshair (nudge INTO the hit) — used
      // for right-click "use" (open a door/trapdoor) regardless of held block.
      _targeted.copy(intersection.point).addScaledVector(dir, 0.01);
      this.targetedBlock = _targeted.set(Math.round(_targeted.x), Math.round(_targeted.y), Math.round(_targeted.z));

      this.selectionHelper.position.copy(this.selectedCoords);
      this.selectionHelper.visible = true;
    } else {
      this.selectedCoords = null;
      this.targetedBlock = null;
      this.selectionHelper.visible = false;
    }
  }

  get position() {
    return this.camera.position;
  }

  // Camera-local velocity (x=right, z=forward, y=up) → world, using the camera's
  // own horizontal basis. This matches how moveRight/moveForward translate the
  // player, so a wall contact cancels exactly the component pushing into it.
  get worldVelocity() {
    this.#worldVelocity.set(0, this.velocity.y, 0)
      .addScaledVector(this.#right, this.velocity.x)
      .addScaledVector(this.#fwd, this.velocity.z);
    return this.#worldVelocity;
  }

  // Refresh the camera's horizontal forward/right (world). Cheap; called once
  // per physics substep before any worldVelocity read.
  #updateBasis() {
    this.camera.getWorldDirection(this.#fwd);
    this.#fwd.y = 0;
    if (this.#fwd.lengthSq() < 1e-6) return;  // looking straight up/down: keep last basis
    this.#fwd.normalize();
    this.#right.crossVectors(this.#fwd, this.camera.up).normalize();
  }

  applyInputs(delta: number) {
    this.#updateBasis();
    if(this.controls.isLocked) {
      this.#updateMovement(delta);
      // velocity is camera-local: x drives strafe, z drives forward, y is vertical.
      this.controls.moveRight(this.velocity.x * delta);
      this.controls.moveForward(this.velocity.z * delta);
      this.position.y += this.velocity.y * delta;
    }
  }

  // Per-substep horizontal acceleration with friction, sprint, limited air
  // control, and a buffered/coyote-time jump. Gives movement momentum: you ramp
  // up and coast down instead of snapping between full speed and a dead stop.
  #updateMovement(delta: number) {
    if (this.flying) { this.#updateFlying(delta); return; }
    // --- jump assist: coyote time + input buffer ---
    this.#coyote = this.onGround ? 0 : this.#coyote + delta;
    if (this.#jumpBuffer > 0) this.#jumpBuffer -= delta;
    if (this.#jumpBuffer > 0 && this.#coyote <= COYOTE_TIME) {
      this.velocity.y = this.jumpSpeed;
      this.#jumpBuffer = 0;
      this.#coyote = COYOTE_TIME + 1;        // don't re-fire until grounded again
      if (this.sprinting && this.velocity.z > 0) this.velocity.z *= SPRINT_JUMP_BOOST;  // sprint-jump hop
    }

    // --- wish direction (camera-local), normalized so diagonals aren't faster ---
    let wx = (this.#kD ? 1 : 0) - (this.#kA ? 1 : 0);
    let wf = (this.#kW ? 1 : 0) - (this.#kS ? 1 : 0);
    const wl = Math.hypot(wx, wf);
    if (wl > 0) { wx /= wl; wf /= wl; }

    // sprint only counts while actually pushing forward
    this.sprinting = (this.sprintKey || this.#doubleTapSprint) && wf > 0.1;
    const speed = this.sprinting ? this.maxSpeed * SPRINT_MULT : this.maxSpeed;

    if (wl > 0) {
      const groundAccel = this.onIce ? ICE_ACCEL : GROUND_ACCEL;
      const accel = (this.onGround ? groundAccel : AIR_ACCEL) * delta;
      this.velocity.x = approach(this.velocity.x, wx * speed, accel);
      this.velocity.z = approach(this.velocity.z, wf * speed, accel);
    } else if (this.onGround) {
      // no input on the ground: friction eases to a stop (a long glide on ice)
      const damp = Math.exp(-(this.onIce ? ICE_FRICTION : GROUND_FRICTION) * delta);
      this.velocity.x *= damp;
      this.velocity.z *= damp;
      if (Math.abs(this.velocity.x) < 0.05) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.05) this.velocity.z = 0;
    }
    // airborne with no input → momentum preserved (no friction): sprint-jumps glide
  }

  // Flight movement: full-control horizontal accel (no gravity, no ground/air
  // distinction) plus direct vertical from Space/Shift. While flying, Shift means
  // "descend" (not sprint), so fly-sprint is via double-tap-forward only.
  #updateFlying(delta: number) {
    let wx = (this.#kD ? 1 : 0) - (this.#kA ? 1 : 0);
    let wf = (this.#kW ? 1 : 0) - (this.#kS ? 1 : 0);
    const wl = Math.hypot(wx, wf);
    if (wl > 0) { wx /= wl; wf /= wl; }

    this.sprinting = this.#doubleTapSprint && wf > 0.1;
    const speed = this.maxSpeed * (this.sprinting ? FLY_SPRINT : FLY_BASE);
    const accel = FLY_ACCEL * delta;
    const damp = Math.exp(-GROUND_FRICTION * delta);

    if (wl > 0) {
      this.velocity.x = approach(this.velocity.x, wx * speed, accel);
      this.velocity.z = approach(this.velocity.z, wf * speed, accel);
    } else {
      this.velocity.x *= damp; this.velocity.z *= damp;
      if (Math.abs(this.velocity.x) < 0.05) this.velocity.x = 0;
      if (Math.abs(this.velocity.z) < 0.05) this.velocity.z = 0;
    }

    const vy = (this.#kUp ? 1 : 0) - (this.#kDown ? 1 : 0);
    if (vy !== 0) this.velocity.y = approach(this.velocity.y, vy * speed, accel);
    else { this.velocity.y *= damp; if (Math.abs(this.velocity.y) < 0.05) this.velocity.y = 0; }
  }

  updateBounds() {
    this.boundsHelper.position.copy(this.position);
    this.boundsHelper.position.y -= this.height / 2;
  }

  onkeydown(event: KeyboardEvent) {
    if(!this.enabled) return; // e.g. while the world map is open — don't grab the pointer
    if(!this.controls.isLocked && !(
      event.key === 'Control' ||
      event.key === 'Shift' ||
      event.key === 'Alt' ||
      event.key === 'Meta' ||
      event.key === 'CapsLock' ||
      event.key === 'Tab' ||
      event.key === 'Escape' ||
      event.key === 'Enter' ||
      event.key === 'Backspace' ||
      event.key === 'F1' ||
      event.key === 'F2' ||
      event.key === 'F3' ||
      event.key === 'F4' ||
      event.key === 'F5' ||
      event.key === 'F6' ||
      event.key === 'F7' ||
      event.key === 'F8' ||
      event.key === 'F9' ||
      event.key === 'F10' ||
      event.key === 'F11' ||
      event.key === 'F12'
    )) {
      this.controls.lock();
    }

    // Letters lowercased so Shift/CapsLock combos (e.g. Shift+W while sprinting,
    // which fires as 'W') still match; named keys like 'Shift'/' ' pass through.
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    switch(key) {
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
        document.getElementById(`toolbar-${this.activeBlockId}`)?.classList.remove('selected')
        this.activeBlockId = parseInt(key);
        document.getElementById(`toolbar-${this.activeBlockId}`)?.classList.add('selected')
        this.tool.visible = this.activeBlockId === blocks.air.id;
        break;
      case 'w':
        // double-tap forward starts sprinting (sticky until forward is released)
        if (!event.repeat) {
          const now = performance.now();
          if (now - this.#lastTapW < DOUBLE_TAP_MS) this.#doubleTapSprint = true;
          this.#lastTapW = now;
        }
        this.#kW = true;
        break;
      case 's': this.#kS = true; break;
      case 'a': this.#kA = true; break;
      case 'd': this.#kD = true; break;
      case 'Shift': this.sprintKey = true; this.#kDown = true; break;   // descend while flying
      case 'r':
        this.camera.position.copy(SPAWN);
        this.velocity.set(0, 0, 0);
        this.onGround = false;
        this.#coyote = COYOTE_TIME + 1;
        break;
      case ' ':
        // double-tap space toggles flight (Creative + Survival). While flying,
        // holding space ascends; otherwise buffer a jump (fires the moment it's
        // valid — a hair early, or while pressed against a block, still jumps).
        // wantsUp tracks the held key for swim-up in water (see Physics).
        this.wantsUp = true;
        if (!event.repeat && this.canFly) {
          const now = performance.now();
          if (now - this.#lastTapSpace < FLY_TOGGLE_MS) this.setFlying(!this.flying);
          this.#lastTapSpace = now;
        }
        if (this.flying) this.#kUp = true;
        else this.#jumpBuffer = JUMP_BUFFER;
        break;
    }
  }

  onkeyup(event: KeyboardEvent) {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    switch(key) {
      case 'w': this.#kW = false; this.#doubleTapSprint = false; break;
      case 's': this.#kS = false; break;
      case 'a': this.#kA = false; break;
      case 'd': this.#kD = false; break;
      case 'Shift': this.sprintKey = false; this.#kDown = false; break;
      case ' ': this.#kUp = false; this.wantsUp = false; break;
    }
  }

  applyWorldDeltaVelocity(dv: Three.Vector3){
    // world delta → camera-local (inverse of the worldVelocity getter)
    this.velocity.x += dv.dot(this.#right);
    this.velocity.z += dv.dot(this.#fwd);
    this.velocity.y += dv.y;
  }

  toString(){
    return `Player: (X:${this.position.x.toFixed(3)}  Y:${this.position.y.toFixed(3)}  Z:${this.position.z.toFixed(3)})`;
  }
}