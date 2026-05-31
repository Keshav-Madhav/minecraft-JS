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

// Screen-space god rays (crepuscular light shafts) + a faint OMNIPRESENT atmospheric
// scatter. The directional shafts march toward the sun's screen pos accumulating only
// the BRIGHT sun core (high threshold → not the whole sky → not blinding), at a much
// gentler strength, and fade SMOOTHLY as the sun leaves the screen (no hard pop). On
// top, a subtle sky-tinted airlight lifts the whole frame in daylight so the scene
// reads as atmospherically lit even when you're NOT looking at the sun.
const GodRaysShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uSunPos: { value: new THREE.Vector2(0.5, 0.5) },   // sun screen pos (0..1)
    uIntensity: { value: 0.0 },                        // directional shaft strength (0 = sun far off-screen)
    uAtmo: { value: 0.0 },                             // omnipresent airlight amount (daylight-scaled)
    uSky: { value: new THREE.Color(0.55, 0.72, 1.0) }, // airlight tint (live sky colour)
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uSunPos;
    uniform float uIntensity;
    uniform float uAtmo;
    uniform vec3 uSky;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(tDiffuse, vUv);
      vec3 col = base.rgb;
      if (uIntensity > 0.001) {
        const int N = 48;
        vec2 dir = (vUv - uSunPos) / float(N) * 0.85;
        vec2 uv = vUv;
        float illum = 1.0;
        vec3 acc = vec3(0.0);
        for (int i = 0; i < N; i++) {
          uv -= dir;
          vec3 s = texture2D(tDiffuse, uv).rgb;
          float l = max(0.0, dot(s, vec3(0.299, 0.587, 0.114)) - 0.62);  // ONLY the bright sun core
          acc += s * l * illum;
          illum *= 0.955;                                                // decay along the ray
        }
        col += acc * uIntensity * 0.03;                                  // gentle (was 0.09)
      }
      // omnipresent atmospheric airlight — a faint sky-tinted lift, present regardless
      // of where the sun is on screen.
      col += uSky * uAtmo;
      gl_FragColor = vec4(col, base.a);
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
  // god-ray source at the sun's screen position. The directional shafts fade SMOOTHLY
  // as the sun leaves the screen (no hard on/off pop), and the omnipresent airlight is
  // driven by daylight regardless of sun direction.
  update(camera: THREE.PerspectiveCamera, sunWorld: THREE.Vector3, daylight: number, sky?: THREE.Color) {
    this.renderPass.camera = camera;
    this._ndc.copy(sunWorld).project(camera);
    const day = Math.max(0, daylight);
    // smooth on-screen weight: 1 while the sun is within the frame, ramping to 0 by
    // ~0.6 NDC past the edge → shafts bleed in/out instead of snapping.
    const off = Math.max(Math.abs(this._ndc.x), Math.abs(this._ndc.y));
    const onScreen = this._ndc.z < 1 ? Math.max(0, Math.min(1, 1 - (off - 1) / 0.6)) : 0;
    this.godrays.uniforms.uSunPos.value.set(this._ndc.x * 0.5 + 0.5, this._ndc.y * 0.5 + 0.5);
    this.godrays.uniforms.uIntensity.value = onScreen * day * 0.8;
    this.godrays.uniforms.uAtmo.value = day * 0.016;            // subtle omnipresent airlight
    if (sky) this.godrays.uniforms.uSky.value.copy(sky);
  }

  render() { this.composer.render(); }
}
