import GUI from "three/examples/jsm/libs/lil-gui.module.min.js";
import { resources } from "./blocks";
import { Player } from "./player";
import { World } from "./world";
import { Scene } from "three";

export function createGUI(world: World, player: Player, scene: Scene) {
  const gui = new GUI();

  const sceneFolder = gui.addFolder('Scene');
  sceneFolder.add(scene.fog, 'near', 0, 100).name('Fog Near');
  sceneFolder.add(scene.fog, 'far', 0, 100).name('Fog Far');

  const playerFolder = gui.addFolder('Player');
  playerFolder.add(player, 'maxSpeed', 1, 40).name('Max Speed');
  playerFolder.add(player.cameraHelper, 'visible').name('Camera Helper');
  
  
  const terrainFolder = gui.addFolder('Terrain');
  terrainFolder.add(world, 'asyncLoading').name('Async Loading');
  terrainFolder.add(world, 'drawDistance', 0, 10, 1).name('Draw Distance');
  terrainFolder.add(world.params, 'seed', 0, 10000).name('Seed');
  terrainFolder.add(world.params.terrain, 'scale', 10, 100).name('Scale');
  terrainFolder.add(world.params.terrain, 'magnitude', 0, 1).name('Magnitude');
  terrainFolder.add(world.params.terrain, 'offset', 0, 1).name('Offset');

  const resourcesFolder = gui.addFolder('Resources');

  resources.forEach(resource => {
    resourcesFolder.add(resource, 'scarcity', 0, 1).name(resource.name);

    const scaleFolder = resourcesFolder.addFolder(resource.name + ' Scale');
    scaleFolder.add(resource.scale, 'x', 10, 100).name('X');
    scaleFolder.add(resource.scale, 'y', 10, 100).name('Y');
    scaleFolder.add(resource.scale, 'z', 10, 100).name('Z');
  })

  gui.onChange(() => {
    world.generate();
  });
}