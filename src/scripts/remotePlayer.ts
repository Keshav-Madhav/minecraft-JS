// ============================================================================
//  REMOTE PLAYER AVATAR — the other player's body in a multiplayer session.
//
//  - Blocky MC-proportioned humanoid (head/torso/arms/legs) with ORIGINAL
//    procedural pixel-art skins (canvas + NearestFilter — same ethos as the
//    block textures: palettes + math, no copied assets).
//  - Network position arrives at ~20 Hz; rendering INTERPOLATES ~120 ms in the
//    past between buffered snapshots so motion is smooth, not teleporty.
//  - The received position is the sender's CAMERA (top of their 1.8-unit
//    collider), so the avatar's feet sit at y − 1.8.
//  - Body follows yaw, head follows pitch; limbs swing with measured speed.
// ============================================================================
import * as THREE from 'three';

const INTERP_DELAY = 120;    // ms behind real time — must exceed one send interval
const SNAP_KEEP = 30;        // snapshot ring size (~1.5 s at 20 Hz)
const EYE_TO_FEET = 1.8;     // sender's camera sits at the top of their collider

type Snap = { t: number; x: number; y: number; z: number; yaw: number; pitch: number };

// Tiny procedural pixel texture: painter fills a w×h canvas; NearestFilter keeps
// the chunky voxel look at any scale.
function pixTexture(w: number, h: number, paint: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d')!;
  paint(g);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Flat colour + per-pixel brightness jitter — reads as cloth/skin, not plastic.
function speckle(g: CanvasRenderingContext2D, w: number, h: number, base: string, jitter: number) {
  g.fillStyle = base;
  g.fillRect(0, 0, w, h);
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const f = 1 + (Math.random() * 2 - 1) * jitter;
    d[i] = Math.min(255, d[i] * f); d[i + 1] = Math.min(255, d[i + 1] * f); d[i + 2] = Math.min(255, d[i + 2] * f);
  }
  g.putImageData(img, 0, 0);
}

const mat = (tex: THREE.CanvasTexture) => new THREE.MeshLambertMaterial({ map: tex });
const speckleMat = (w: number, h: number, base: string, jitter = 0.06) =>
  mat(pixTexture(w, h, (g) => speckle(g, w, h, base, jitter)));

export class RemotePlayer {
  readonly group = new THREE.Group();
  private head: THREE.Group;
  private armL: THREE.Group; private armR: THREE.Group;
  private legL: THREE.Group; private legR: THREE.Group;
  // Shirt-coloured meshes (torso + arms) with their texture dims, so the peer's
  // chosen shirt colour can re-speckle them live. Name tag floats above the head.
  private shirtParts: Array<{ mesh: THREE.Mesh, w: number, h: number }> = [];
  private tag: THREE.Sprite;

  private snaps: Snap[] = [];
  private swingPhase = 0;
  private speed = 0;          // smoothed horizontal speed, drives the limb swing
  private lastUpdate = 0;

  constructor() {
    const skin = '#c8997a', shirt = '#2fa39b', pants = '#3b4a8f', hair = '#3a2a1c', boots = '#6b6b6b';

    // HEAD — 6 faces: hair on top/back/sides, face (eyes + mouth) on the front (-z).
    const facesTex = (front: boolean) => pixTexture(8, 8, (g) => {
      speckle(g, 8, 8, skin, 0.05);
      g.fillStyle = hair; g.fillRect(0, 0, 8, 2);                       // fringe
      if (front) {
        g.fillStyle = '#ffffff'; g.fillRect(1, 3, 2, 1); g.fillRect(5, 3, 2, 1);   // eye whites
        g.fillStyle = '#3b6fd4'; g.fillRect(2, 3, 1, 1); g.fillRect(5, 3, 1, 1);   // pupils
        g.fillStyle = '#a06a50'; g.fillRect(3, 6, 2, 1);                           // mouth
      }
    });
    const hairTex = () => pixTexture(8, 8, (g) => speckle(g, 8, 8, hair, 0.10));
    const sideTex = () => pixTexture(8, 8, (g) => { speckle(g, 8, 8, skin, 0.05); g.fillStyle = hair; g.fillRect(0, 0, 8, 3); });
    // Box material order: +x, -x, +y, -y, +z, -z (model faces -z).
    const headMats = [mat(sideTex()), mat(sideTex()), mat(hairTex()), mat(facesTex(false)), mat(facesTex(false)), mat(facesTex(true))];

    const box = (w: number, h: number, d: number, m: THREE.Material | THREE.Material[], pivotY: number, geomYOffset: number) => {
      // Geometry shifted so the part rotates about its pivot (neck/shoulder/hip).
      const geo = new THREE.BoxGeometry(w, h, d);
      geo.translate(0, geomYOffset, 0);
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = true;
      const pivot = new THREE.Group();
      pivot.position.y = pivotY;
      pivot.add(mesh);
      return pivot;
    };

    // MC proportions on a 2.0-unit model, scaled ×0.9 → 1.8 units tall.
    this.head = box(0.5, 0.5, 0.5, headMats, 1.5, 0.25);                 // pivot at the neck
    const torso = box(0.5, 0.75, 0.25, speckleMat(8, 12, shirt), 0.75, 0.375);
    this.armL = box(0.22, 0.72, 0.22, speckleMat(4, 12, shirt), 1.46, -0.34);   // pivot at the shoulder
    this.armR = box(0.22, 0.72, 0.22, speckleMat(4, 12, shirt), 1.46, -0.34);
    this.armL.position.x = -0.37; this.armR.position.x = 0.37;
    const legTex = () => pixTexture(4, 12, (g) => { speckle(g, 4, 12, pants, 0.06); g.fillStyle = boots; g.fillRect(0, 10, 4, 2); });
    this.legL = box(0.24, 0.75, 0.24, mat(legTex()), 0.75, -0.375);             // pivot at the hip
    this.legR = box(0.24, 0.75, 0.24, mat(legTex()), 0.75, -0.375);
    this.legL.position.x = -0.125; this.legR.position.x = 0.125;

    this.group.add(this.head, torso, this.armL, this.armR, this.legL, this.legR);
    this.shirtParts.push(
      { mesh: torso.children[0] as THREE.Mesh, w: 8, h: 12 },
      { mesh: this.armL.children[0] as THREE.Mesh, w: 4, h: 12 },
      { mesh: this.armR.children[0] as THREE.Mesh, w: 4, h: 12 },
    );

    // NAME TAG: a billboarded sprite above the head, drawn by setIdentity.
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false }));
    this.tag.center.set(0.5, 0);   // anchor at the bottom → scales upward
    this.tag.position.y = 2.12;
    this.tag.visible = false;
    this.group.add(this.tag);

    this.group.scale.setScalar(0.9);
    this.group.visible = false;
  }

  // Apply the peer's identity card: name tag text + shirt colour (torso/arms).
  setIdentity(name: string, shirtHex: string) {
    for (const p of this.shirtParts) {
      const old = p.mesh.material;
      p.mesh.material = speckleMat(p.w, p.h, shirtHex);
      for (const m of Array.isArray(old) ? old : [old]) {
        (m as THREE.MeshLambertMaterial).map?.dispose();
        m.dispose();
      }
    }
    const c = document.createElement('canvas');
    c.width = 256; c.height = 56;
    const g = c.getContext('2d');
    if (g) {
      g.font = '600 30px ui-sans-serif, system-ui, sans-serif';
      const tw = Math.min(244, g.measureText(name).width);
      g.fillStyle = 'rgba(10, 12, 18, 0.55)';
      g.beginPath();
      g.roundRect(128 - tw / 2 - 9, 6, tw + 18, 44, 8);
      g.fill();
      g.fillStyle = '#ffffff';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(name, 128, 29, 244);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mtl = this.tag.material;
    mtl.map?.dispose();
    mtl.map = tex;
    mtl.needsUpdate = true;
    this.tag.scale.set(1.5, 1.5 * (56 / 256), 1);
    this.tag.visible = name.length > 0;
  }

  reset() { this.snaps.length = 0; this.speed = 0; }

  push(t: number, p: [number, number, number], yaw: number, pitch: number) {
    this.snaps.push({ t, x: p[0], y: p[1], z: p[2], yaw, pitch });
    if (this.snaps.length > SNAP_KEEP) this.snaps.shift();
  }

  // Interpolate the avatar to (now − INTERP_DELAY) between buffered snapshots.
  update(now: number) {
    const s = this.snaps;
    if (s.length === 0) return;
    const rt = now - INTERP_DELAY;
    // Bracketing pair (linear scan from the end — the buffer is tiny + sorted).
    let a = s[0], b = s[0];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].t <= rt) { a = s[i]; b = s[i + 1] ?? s[i]; break; }
      b = s[i];   // rt precedes the whole buffer → clamp to the oldest
    }
    const span = b.t - a.t;
    const k = span > 0 ? Math.min(1, (rt - a.t) / span) : 1;

    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    const z = a.z + (b.z - a.z) * k;
    // Shortest-arc yaw lerp (−π/π wrap), straight lerp for pitch.
    let dy = b.yaw - a.yaw;
    if (dy > Math.PI) dy -= Math.PI * 2; else if (dy < -Math.PI) dy += Math.PI * 2;
    const yaw = a.yaw + dy * k;
    const pitch = a.pitch + (b.pitch - a.pitch) * k;

    // Limb swing from measured horizontal speed (smoothed so it doesn't flicker).
    const dt = this.lastUpdate ? Math.min((now - this.lastUpdate) / 1000, 0.1) : 0;
    if (dt > 0) {
      const dist = Math.hypot(x - this.group.position.x, z - this.group.position.z);
      this.speed += (dist / dt - this.speed) * Math.min(1, dt * 8);
      this.swingPhase += this.speed * dt * 1.6;
      const swing = Math.min(1, this.speed / 4.3) * 0.7 * Math.sin(this.swingPhase * Math.PI);
      this.legL.rotation.x = swing; this.legR.rotation.x = -swing;
      this.armL.rotation.x = -swing * 0.8; this.armR.rotation.x = swing * 0.8;
    }
    this.lastUpdate = now;

    this.group.position.set(x, y - EYE_TO_FEET, z);
    this.group.rotation.y = yaw;          // model faces −z, matching yaw 0
    this.head.rotation.x = pitch;
  }
}
