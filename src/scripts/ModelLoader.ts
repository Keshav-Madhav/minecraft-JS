import { GLTFLoader } from "three/examples/jsm/Addons.js"
import { assetUrl } from "./assetBase"

export class ModelLoader {
  loader = new GLTFLoader();

  models:{ [key: string]: any } = {
    pickaxe: undefined
  }

  loadModels(onLoad: (models: { [key: string]: any }) => void){
    // assetUrl resolves against vite's BASE_URL ('/' in dev, './' in the build)
    // so the model loads under whatever path the app is DEPLOYED at (domain root
    // on Vercel, a sub-path on Pages) while staying immune to the PAGE path — a
    // bare-relative path here got the SPA index.html fallback ("<!doctype" JSON
    // error) whenever the dev tab sat at a non-root URL.
    this.loader.load(assetUrl('pickaxe.glb'), (gltf) => {
      const mesh = gltf.scene;
      this.models.pickaxe = mesh;

      onLoad(this.models);
    }, undefined, (err) => {
      // The pickaxe model failed to load — log it instead of failing silently.
      // Tool.setMesh is never called, but the game still runs (Tool guards undefined).
      console.warn('failed to load pickaxe model', err);
    })
  }
}