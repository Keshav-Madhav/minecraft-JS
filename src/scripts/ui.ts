import GUI from "three/examples/jsm/libs/lil-gui.module.min.js";
import { World } from "./world";

export function createGUI(world: World) {
  const gui = new GUI();
  
  gui.add(world.size, 'width', 4, 128, 1).name('Width')
  gui.add(world.size, 'height', 1, 64, 1).name('Height')

  gui.onChange(() => {
    world.generate();
  });
}