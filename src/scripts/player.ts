import * as Three from 'three';
import { PointerLockControls } from 'three/examples/jsm/Addons.js';
import { World } from './world';
import { blocks } from './blocks';
import { Tool } from './tool';

const screeCenter=new Three.Vector2();

export class Player {
  camera = new Three.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 200);
  controls = new PointerLockControls(this.camera, document.body);
  boundsHelper: Three.Mesh;

  radius = 0.4;

  height = 1.8;
  jumpSpeed = 10;
  onGround = false;

  maxSpeed = 8;
  velocity = new Three.Vector3();
  #worldVelocity = new Three.Vector3();

  input = new Three.Vector3();
  cameraHelper = new Three.CameraHelper(this.camera);

  raycaster = new Three.Raycaster(undefined, undefined, 0, 4);
  selectedCoords:  Three.Vector3 | null = null;
  selectionHelper: Three.Mesh;

  activeBlockId = blocks.air.id;

  tool = new Tool();

  constructor(scene: Three.Scene) {
    this.camera.position.set(0, 64, 0);    
    this.camera.layers.enable(1);
    scene.add(this.camera);
    scene.add(this.cameraHelper);

    this.camera.add(this.tool)

    document.addEventListener('keydown', this.onkeydown.bind(this))
    document.addEventListener('keyup', this.onkeyup.bind(this))

    this.boundsHelper = new Three.Mesh(
      new Three.CylinderGeometry(this.radius, this.radius, this.height, 16),
      new Three.MeshBasicMaterial({ wireframe: true})
    )
    this.boundsHelper.visible = false;
    this.cameraHelper.visible = false;
    scene.add(this.boundsHelper);

    const selectionMaterial = new Three.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3 });
    const selectionGeometry = new Three.BoxGeometry(1.001, 1.001, 1.001);
    this.selectionHelper = new Three.Mesh(selectionGeometry, selectionMaterial);
    scene.add(this.selectionHelper);

    this.raycaster.layers.set(0);
  }

  update(world: World) {
    this.updateRayCast(world)
    this.tool.update();
  }

  updateRayCast(world: World) {
    this.raycaster.setFromCamera(screeCenter, this.camera);   
    const intersects = this.raycaster.intersectObject(world, true);

    if(intersects.length > 0){
      const intersection = intersects[0];

      const chunk = intersection.object.parent!;

      const blockMatrix = new Three.Matrix4()
      // @ts-ignore: Method exists but is not in the type definition
      intersection.object.getMatrixAt(intersection.instanceId, blockMatrix);

      this.selectedCoords = chunk.position.clone();
      this.selectedCoords.applyMatrix4(blockMatrix);

      if(this.activeBlockId !== blocks.air.id){
        this.selectedCoords.add(intersection.normal!);
      }

      this.selectionHelper.position.copy(this.selectedCoords); 
      this.selectionHelper.visible = true;
    } else {
      this.selectedCoords = null;
      this.selectionHelper.visible = false;
    }
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
    if(!this.controls.isLocked && !(
      event.key === 'Control' || 
      event.key === 'Shift' ||
      event.key === 'Alt' ||
      event.key === 'Meta' ||
      event.key === 'CapsLock' ||
      event.key === 'Tab' ||
      event.key === 'Escape' ||
      event.key === 'Enter' ||
      event.key === 'Backspace' ||
      event.key === 'F1' ||
      event.key === 'F2' ||
      event.key === 'F3' ||
      event.key === 'F4' ||
      event.key === 'F5' ||
      event.key === 'F6' ||
      event.key === 'F7' ||
      event.key === 'F8' ||
      event.key === 'F9' ||
      event.key === 'F10' ||
      event.key === 'F11' ||
      event.key === 'F12'
    )) {
      this.controls.lock();
    }

    switch(event.key) {
      case '0':
      case '1':
      case '2':
      case '3':
      case '4':
      case '5':
      case '6':
      case '7':
      case '8':
        document.getElementById(`toolbar-${this.activeBlockId}`)?.classList.remove('selected')
        this.activeBlockId = parseInt(event.key);
        document.getElementById(`toolbar-${this.activeBlockId}`)?.classList.add('selected')
        this.tool.visible = this.activeBlockId === blocks.air.id;
        break;
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
        this.camera.position.set(0, 64, 0);
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