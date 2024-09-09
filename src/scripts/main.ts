import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { createGUI } from './ui';
import { Player } from './player';
import { Physics } from './physics';
import { World } from './world';
import { blocks } from './blocks';
import { ModelLoader } from './ModelLoader';

// Get window size
let winWidth = window.innerWidth;
let winHeight = window.innerHeight;
window.addEventListener('resize', () => {
  winWidth = window.innerWidth;
  winHeight = window.innerHeight;

  OrbitCam.aspect = winWidth / winHeight;
  OrbitCam.updateProjectionMatrix();

  player.camera.aspect = winWidth / winHeight;
  player.camera.updateProjectionMatrix();

  renderer.setSize(winWidth, winHeight);
})

let previousTime = performance.now();


// Stats = FPS monitor
const stats = new Stats();
document.body.appendChild(stats.dom);

// Setup for renderer
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(winWidth, winHeight);
renderer.setClearColor(0x80a0e0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Setup for OrbitCam
const OrbitCam = new THREE.PerspectiveCamera(70, winWidth / winHeight);
OrbitCam.position.set(-32, 16, -32); 
OrbitCam.layers.enable(1);
OrbitCam.lookAt(0, 0, 0);

// Setup for controls
const controls = new OrbitControls(OrbitCam, renderer.domElement);
controls.target.set(16, 0, 16);
controls.update();

// Setup for scene
const scene = new THREE.Scene();
const world = new World();
world.params.seed = Math.floor(Math.random() * 10000);
scene.fog = new THREE.Fog(0x80a0e0, 20, 50);
world.generate();
scene.add(world);


// Setup for player
const player = new Player(scene);

const physics = new Physics(scene);

const modelLoader = new ModelLoader();
modelLoader.loadModels((models) => {
  player.tool.setMesh(models.pickaxe);
})

// light
const sun = new THREE.DirectionalLight();

function setUpLights() {
  sun.position.set(50, 50, 50);
  sun.castShadow = true;
  sun.shadow.camera.left = -100;
  sun.shadow.camera.right = 100;
  sun.shadow.camera.top = 100;
  sun.shadow.camera.bottom = -100;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 200;
  sun.shadow.bias = -0.00001;
  sun.shadow.mapSize = new THREE.Vector2(2048, 2048);
  scene.add(sun);
  scene.add(sun.target)

  const shadowHelper = new THREE.CameraHelper(sun.shadow.camera);
  shadowHelper.visible = false;
  scene.add(shadowHelper);

  const ambient = new THREE.AmbientLight();
  ambient.intensity = 0.1
  scene.add(ambient);
}

function onMouseDown(event: MouseEvent) {
  if(player.controls.isLocked && player.selectedCoords){
    if(event.button === 0){
      if(player.activeBlockId === blocks.air.id){
        world.removeBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z);
        player.tool.startAnimation();
      } else {
        world.setBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z, player.activeBlockId);
      }
    } else if(event.button === 2){
      player.activeBlockId = world.getBlock(player.selectedCoords.x, player.selectedCoords.y, player.selectedCoords.z)?.id ?? blocks.air.id;
    }
  }
}
document.addEventListener('mousedown', onMouseDown);

//draw loop
function animate() {
  const currentTime = performance.now(); 
  const delta = (currentTime - previousTime) / 1000;

  requestAnimationFrame(animate);
  
  if(player.controls.isLocked) {
    player.update(world);
    physics.update(delta, player, world);
    world.update(player)
    
    sun.position.copy(player.position);
    sun.position.sub(new THREE.Vector3(-50, -50, -50));
    sun.target.position.copy(player.position);
  }
  
  renderer.render(scene, player.controls.isLocked ? player.camera : OrbitCam);
  stats.update();

  previousTime = currentTime;
}

setUpLights();
createGUI(world, player);
animate();