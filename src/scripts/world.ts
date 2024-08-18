import * as THREE from 'three';

const goemetry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshLambertMaterial({ color: 0x00ff00 });

export class World extends THREE.Group {
  size: number;

  constructor(size: number = 32) {
    super();

    this.size = size;
  }

  generate(){
    for(let i = 0; i < this.size; i++) {
      for(let j = 0; j < this.size; j++) {
        const block = new THREE.Mesh(goemetry, material);
        block.position.set(i, 0, j);
        this.add(block);
      }
    }
  }
}