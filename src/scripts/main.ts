import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { WorldChunk } from './worldChunk';
import { createGUI } from './ui';
import { Player } from './player';
import { Physics } from './physics';
import { World } from './world';

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
OrbitCam.lookAt(0, 0, 0);

// Setup for controls
const controls = new OrbitControls(OrbitCam, renderer.domElement);
controls.target.set(16, 0, 16);
controls.update();

// Setup for scene
const scene = new THREE.Scene();
const world = new World();
world.generate();
scene.add(world);

// Setup for player
const player = new Player(scene);

const physics = new Physics(scene);

// light
function setUpLights() {
  const sun = new THREE.DirectionalLight();
  sun.position.set(50, 50, 50);
  sun.castShadow = true;
  sun.shadow.camera.left = -50;
  sun.shadow.camera.right = 50;
  sun.shadow.camera.top = 50;
  sun.shadow.camera.bottom = -50;
  sun.shadow.camera.near = 0.1;
  sun.shadow.camera.far = 100;
  sun.shadow.bias = -0.0005;
  sun.shadow.mapSize = new THREE.Vector2(1024, 1024);
  scene.add(sun);

  const shadowHelper = new THREE.CameraHelper(sun.shadow.camera);
  scene.add(shadowHelper);

  const ambient = new THREE.AmbientLight();
  ambient.intensity = 0.1
  scene.add(ambient);
}

//draw loop
function animate() {
  const currentTime = performance.now(); 
  const delta = (currentTime - previousTime) / 1000;

  requestAnimationFrame(animate);
  
  physics.update(delta, player, world);
  renderer.render(scene, player.controls.isLocked ? player.camera : OrbitCam);

  stats.update();

  previousTime = currentTime;
}

setUpLights();
createGUI(world, player);
animate();