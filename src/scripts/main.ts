import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { World } from './world';

// Get window size
let winWidth = window.innerWidth;
let winHeight = window.innerHeight;
window.addEventListener('resize', () => {
  winWidth = window.innerWidth;
  winHeight = window.innerHeight;

  camera.aspect = winWidth / winHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(winWidth, winHeight);
})

// Stats = FPS monitor
const stats = new Stats();
document.body.appendChild(stats.dom);

// Setup for renderer
const renderer = new THREE.WebGLRenderer();
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(winWidth, winHeight);
renderer.setClearColor(0x80a0e0);

document.body.appendChild(renderer.domElement);

// Setup for camera
const camera = new THREE.PerspectiveCamera(70, winWidth / winHeight);
camera.position.set(-32, 16, -32); 
camera.lookAt(0, 0, 0);

// Setup for controls
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(16, 0, 16);
controls.update();

// Setup for scene
const scene = new THREE.Scene();
const world = new World();
world.generate();
scene.add(world);

// light
function setUpLights() {
  const light1 = new THREE.DirectionalLight();
  light1.position.set(1, 1, 1);
  scene.add(light1);

  const light2 = new THREE.DirectionalLight();
  light2.position.set(-1, -1, -0.5);
  scene.add(light2);

  const light3 = new THREE.AmbientLight();
  light3.intensity = 0.1
  scene.add(light3);
}

//draw loop
function animate() {
  requestAnimationFrame(animate);
  renderer.render(scene, camera);

  stats.update();
}

setUpLights();
animate();