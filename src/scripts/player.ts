import * as Three from 'three';
import { PointerLockControls } from 'three/examples/jsm/Addons.js';

export class Player {
  camera = new Three.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  controls = new PointerLockControls(this.camera, document.body);
  boundsHelper: Three.Mesh;

  radius = 0.5;

  height = 1.8;
  jumpSpeed = 10;
  onGround = false;

  maxSpeed = 8;
  velocity = new Three.Vector3();
  #worldVelocity = new Three.Vector3();

  input = new Three.Vector3();
  cameraHelper = new Three.CameraHelper(this.camera);

  constructor(scene: Three.Scene) {
    this.camera.position.set(32, 16, 32);    
    scene.add(this.camera);
    scene.add(this.cameraHelper);

    document.addEventListener('keydown', this.onkeydown.bind(this))
    document.addEventListener('keyup', this.onkeyup.bind(this))

    this.boundsHelper = new Three.Mesh(
      new Three.CylinderGeometry(this.radius, this.radius, this.height, 16),
      new Three.MeshBasicMaterial({ wireframe: true})
    )
    scene.add(this.boundsHelper);
  }

  get position() {
    return this.camera.position;
  }

  get worldVelocity() {
    this.#worldVelocity.copy(this.velocity);
    this.#worldVelocity.applyEuler(new Three.Euler(0, this.camera.rotation.y, 0));
    return this.#worldVelocity;
  }

  applyInputs(delta: number) {
    if(this.controls.isLocked) {
      this.velocity.x = this.velocity.x;
      this.velocity.z = this.velocity.z;

      this.controls.moveRight(this.input.x * delta);
      this.controls.moveForward(this.input.y * delta);

      this.position.y += this.velocity.y * delta;

      const infoElement = document.getElementById('player-pos');
      if (infoElement) {
        infoElement.innerText = this.toString();
      }
    }
  }

  updateBounds() {
    this.boundsHelper.position.copy(this.position);
    this.boundsHelper.position.y -= this.height / 2;
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
      case 'r':
        this.camera.position.set(32, 16, 32);
        this.velocity.set(0, 0, 0);
        break
      case ' ':
        if(this.onGround) {
          this.velocity.y += this.jumpSpeed;
        }
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

  applyWorldDeltaVelocity(dv: Three.Vector3){
    dv.applyEuler(new Three.Euler(0, -this.camera.rotation.y, 0));
    this.velocity.add(dv)
  }

  toString(){
    return `Player: (X:${this.position.x.toFixed(3)}  Y:${this.position.y.toFixed(3)}  Z:${this.position.z.toFixed(3)})`;
  }
}