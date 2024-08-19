import * as Three from 'three';
import { PointerLockControls } from 'three/examples/jsm/Addons.js';

export class Player {
  camera = new Three.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  controls = new PointerLockControls(this.camera, document.body);

  maxSpeed = 10;
  velocity = new Three.Vector3();
  input = new Three.Vector3();

  constructor(scene: Three.Scene) {
    this.camera.position.set(32, 16, 32);    
    scene.add(this.camera);

    document.addEventListener('keydown', this.onkeydown.bind(this))
    document.addEventListener('keyup', this.onkeyup.bind(this))
  }

  get position() {
    return this.camera.position;
  }

  applyInputs(delta: number) {
    if(this.controls.isLocked) {
      this.velocity.x = this.velocity.x;
      this.velocity.z = this.velocity.z;

      this.controls.moveRight(this.input.x * delta);
      this.controls.moveForward(this.input.y * delta);
    }
  }

  onkeydown(event: KeyboardEvent) {
    if(!this.controls.isLocked) {
      this.controls.lock();
    }

    switch(event.key) {
      case 'w':
        this.input.y = this.maxSpeed;
        break;
      case 's':
        this.input.y = -this.maxSpeed;
        break;
      case 'a':
        this.input.x = -this.maxSpeed;
        break;
      case 'd':
        this.input.x = this.maxSpeed;
        break;
    }
  }

  onkeyup(event: KeyboardEvent) {
    switch(event.key) {
      case 'w':
      case 's':
        this.input.y = 0;
        break;
      case 'a':
      case 'd':
        this.input.x = 0;
        break;
    }
  }
}