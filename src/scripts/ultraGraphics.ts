import * as THREE from 'three';
import { EffectComposer, RenderPass, ShaderPass, OutputPass, UnrealBloomPass } from 'three/examples/jsm/Addons.js';

// ULTRA post-processing pipeline (opt-in). Built lazily the first time ultra
// graphics is enabled, then driven each frame via update()/render():
//   RenderPass (HDR + 4× MSAA) → God rays → Bloom → Output
// The HDR (HalfFloat) target keeps highlights >1 so bloom + the god-ray bright
// threshold work in linear light; MSAA on the target smooths the jaggy voxel edges
// (the #1 quality issue); OutputPass tone-maps (ACES) + sRGB once at the end.
// (Screen-space AO / GTAO was evaluated but it ~doubles the scene cost — too heavy
// for the "already taxing" concern — so it's intentionally left out.)

// Screen-space god rays (crepuscular light shafts): from each pixel, march toward
// the sun's screen position accumulating BRIGHT samples (sky/sun) with decay.
const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },   // sun screen pos (0..1)
    uIntensity: { value: 0.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform float uIntensity;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      if (uIntensity <= 0.001) { gl_FragColor = base; return; }
      const int N = 60;
      vec2 dir = (vUv - uSunPos) / float(N) * 0.9;
      vec2 uv = vUv;
      float illum = 1.0;
      vec3 acc = vec3(0.0);
      for (int i = 0; i < N; i++) {
        uv -= dir;
        vec3 s = texture2D(tDiffuse, uv).rgb;
        float l = max(0.0, dot(s, vec3(0.299, 0.587, 0.114)) - 0.38);   // bright sky/sun leaks
        acc += s * l * illum;
        illum *= 0.965;                                                 // decay along the ray
      }
      gl_FragColor = vec4(base.rgb + acc * uIntensity * 0.09, base.a);
    }
  `,
};

export class PostFX {
  readonly composer: EffectComposer;
  private renderPass: RenderPass;
  private godrays: ShaderPass;
  bloom: UnrealBloomPass;
  private _ndc = new THREE.Vector3();

  constructor(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera) {
    const size = renderer.getSize(new THREE.Vector2());
    // HDR + 4× MSAA render target (MSAA = primary anti-aliasing for the geometry).
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);
    this.godrays = new ShaderPass(GodRaysShader);
    this.composer.addPass(this.godrays);
    this.bloom = new UnrealBloomPass(size, 0.6 /*strength*/, 0.7 /*radius*/, 0.8 /*threshold*/);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());   // ACES tone-map + sRGB (reads renderer.toneMapping)
  }

  // composer.setSize already resizes every pass at the correct pixel ratio.
  setSize(w: number, h: number) { this.composer.setSize(w, h); }

  dispose() {
    for (const p of this.composer.passes) (p as unknown as { dispose?: () => void }).dispose?.();
    this.composer.dispose();
  }

  // Point the scene passes at the active camera (player/spectator) + place the
  // god-ray source at the sun's screen position (faded out when off-screen/night).
  update(camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, daylight: number) {
    this.renderPass.camera = camera;
    this._ndc.copy(sunWorld).project(camera);
    const onScreen = this._ndc.z < 1 && Math.abs(this._ndc.x) < 1.4 && Math.abs(this._ndc.y) < 1.4;
    this.godrays.uniforms.uSunPos.value.set(this._ndc.x * 0.5 + 0.5, this._ndc.y * 0.5 + 0.5);
    this.godrays.uniforms.uIntensity.value = onScreen ? Math.max(0, daylight) * 0.95 : 0;
  }

  render() { this.composer.render(); }
}
