import { GLTFLoader } from "three/examples/jsm/Addons.js"

export class ModelLoader {
  loader = new GLTFLoader();

  models:{ [key: string]: any } = {
    pickaxe: undefined
  }

  loadModels(onLoad: (models: { [key: string]: any }) => void){
    // RELATIVE path (no leading '/') so the model resolves under whatever path the
    // app is deployed at — domain root on Vercel/Netlify, a sub-path on Pages —
    // exactly like the textures (which also load via bare-relative URLs).
    this.loader.load('pickaxe.glb', (gltf) => {
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