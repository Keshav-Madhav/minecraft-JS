import * as THREE from 'three';

// Clouds are flat scrolling planes high in the sky (no voxels). Three layers at
// different heights/styles give depth. Each plane follows the player and fades
// out with DISTANCE FROM THE CAMERA in the shader (not via the plane edges) —
// the old radial-edge fade never showed because the camera far plane clipped the
// huge plane long before its edge, leaving a hard cut. The distance fade always
// completes just inside the far plane, so the boundary is invisible.

const TEX_SIZE = 256;

type LayerStyle = {
  height: number,      // world Y
  planeSize: number,
  repeat: number,      // texture tiling (higher = smaller puffs)
  opacity: number,
  speed: number,       // scroll speed
  color: number,
  puffs: number,       // blob clusters (fewer => more open sky)
  minR: number, maxR: number,
};

// Three layers: low cumulus, mid clumps, high thin cirrus. Opacity/coverage kept
// in check so three stacked layers read as full, fluffy clouds without washing
// the sky out solid white.
const LAYERS: LayerStyle[] = [
  { height: 236, planeSize: 4000, repeat: 7,  opacity: 0.62, speed: 0.004,  color: 0xffffff, puffs: 16, minR: 16, maxR: 34 },
  { height: 292, planeSize: 4500, repeat: 4,  opacity: 0.46, speed: 0.0026, color: 0xeef2ff, puffs: 10, minR: 26, maxR: 56 },
  { height: 352, planeSize: 5000, repeat: 11, opacity: 0.26, speed: 0.0065, color: 0xffffff, puffs: 26, minR: 7,  maxR: 16 },
];

// Cloud puff texture (white blobs on transparent, mostly empty), tiled.
function createCloudTexture(style: LayerStyle): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEX_SIZE;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);

  const blob = (x: number, y: number, r: number) => {
    for (const ox of [-TEX_SIZE, 0, TEX_SIZE]) {       // wrap-around copies => seamless tiling
      for (const oy of [-TEX_SIZE, 0, TEX_SIZE]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, 'rgba(255,255,255,0.92)');   // denser core
        g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  let s = 1337 + style.puffs * 7 + style.height;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < style.puffs; i++) {
    const cx = rand() * TEX_SIZE, cy = rand() * TEX_SIZE;
    const clump = 2 + Math.floor(rand() * 3);
    for (let p = 0; p < clump; p++) {
      blob(cx + (rand() - 0.5) * 70, cy + (rand() - 0.5) * 50, style.minR + rand() * (style.maxR - style.minR));
    }
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(style.repeat, style.repeat);
  return tex;
}

class CloudLayer extends THREE.Mesh {
  private speed: number;
  private cloudMap: THREE.Texture;
  private height: number;
  private shader: { uniforms: { [k: string]: THREE.IUniform } } | null = null;

  constructor(style: LayerStyle) {
    const map = createCloudTexture(style);
    const mat = new THREE.MeshBasicMaterial({
      map,
      color: style.color,
      transparent: true,
      opacity: style.opacity,
      depthWrite: false,
      fog: true,
    });
    // Distance-from-camera alpha fade (horizontal distance, since clouds sit
    // overhead). uFadeEnd is kept just inside the camera far plane.
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFadeStart = { value: 120 };
      shader.uniforms.uFadeEnd = { value: 480 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPos;\nuniform float uFadeStart;\nuniform float uFadeEnd;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n  float _d = distance(cameraPosition.xz, vWorldPos.xz);\n  gl_FragColor.a *= 1.0 - smoothstep(uFadeStart, uFadeEnd, _d);');
      this.shader = shader;
    };

    super(new THREE.PlaneGeometry(style.planeSize, style.planeSize), mat);
    this.cloudMap = map;
    this.speed = style.speed;
    this.height = style.height;
    // Face DOWN: underside seen looking up; culled looking down so clouds don't
    // obscure the top-down / orbit view.
    this.rotation.x = Math.PI / 2;
    this.frustumCulled = false;
  }

  setFade(end: number) {
    if (this.shader) {
      this.shader.uniforms.uFadeEnd.value = end;
      this.shader.uniforms.uFadeStart.value = end * 0.45;
    }
  }

  update(px: number, pz: number, elapsed: number) {
    this.position.set(px, this.height, pz);
    this.cloudMap.offset.x = elapsed * this.speed;
    this.cloudMap.offset.y = elapsed * this.speed * 0.3;
  }
}

export class Clouds extends THREE.Group {
  private cloudLayers: CloudLayer[];

  constructor() {
    super();
    this.cloudLayers = LAYERS.map(style => new CloudLayer(style));
    this.cloudLayers.forEach(l => this.add(l));
  }

  // Keep the fade just inside the camera far plane so clouds dissolve smoothly
  // instead of being hard-clipped.
  setViewDistance(cameraFar: number) {
    for (const l of this.cloudLayers) l.setFade(cameraFar * 0.92);
  }

  update(px: number, pz: number, elapsed: number) {
    for (const l of this.cloudLayers) l.update(px, pz, elapsed);
  }
}
