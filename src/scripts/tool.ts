import * as THREE from 'three';

export class Tool extends THREE.Group {
  animate = false;
  animationStart = 0;
  animationSpeed = 0.025;
  animation = undefined;
  animationAmplitude = 0.5;
  animationDuration = 0.5;
  toolMesh: THREE.Mesh | undefined = undefined;

  get animationTime(){
    return performance.now() - this.animationStart;
  }

  setMesh(mesh: THREE.Mesh){
    this.clear();

    this.toolMesh = mesh;    
    this.add(mesh);
    mesh.receiveShadow = true;
    mesh.castShadow = true;

    this.position.set(0.6, -0.3, -0.5);
    this.scale.set(0.5, 0.5, 0.5);
    this.rotation.z = Math.PI / 2;
    this.rotation.y = Math.PI + 0.2;
  }

  startAnimation(){
    if(this.animate) return;
    this.animate = true;
    this.animationStart = performance.now();
    
    // @ts-ignore
    clearTimeout(this.animate);
    // @ts-ignore
    this.animation = setTimeout(()=>{
      this.animate = false;
      if(this.toolMesh) this.toolMesh.rotation.y = 0;
    }, this.animationDuration * 1000);
  }

  update(){
    if(this.animate && this.toolMesh){
      this.toolMesh.rotation.y = Math.sin(this.animationTime * this.animationSpeed) * this.animationAmplitude;
    }
  }
}