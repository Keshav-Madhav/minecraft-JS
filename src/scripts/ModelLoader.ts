import { GLTFLoader } from "three/examples/jsm/Addons.js"

export class ModelLoader {
  loader = new GLTFLoader();

  models:{ [key: string]: any } = {
    pickaxe: undefined
  }

  loadModels(onLoad: (models: { [key: string]: any }) => void){
    this.loader.load('/pickaxe.glb', (gltf) => {
      const mesh = gltf.scene;
      this.models.pickaxe = mesh;

      onLoad(this.models);
    })
  }
}