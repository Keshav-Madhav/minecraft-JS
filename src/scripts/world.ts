import * as THREE from 'three';

const goemetry = new THREE.BoxGeometry(1, 1, 1);
const material = new THREE.MeshLambertMaterial({ color: 0x00ff00 });

export class World extends THREE.Group {
  size: {width: number, height: number};

  constructor(size = {width: 64, height: 16}) {
    super();

    this.size = size;
  }

  generate(){
    const maxCount = this.size.width * this.size.height * this.size.width;
    const mesh = new THREE.InstancedMesh(goemetry, material, maxCount);
    mesh.count = 0;

    const matrix = new THREE.Matrix4();
    for(let i = 0; i < this.size.width; i++) {
      for(let k = 0; k < this.size.height; k++) {
        for(let j = 0; j < this.size.width; j++) {
          matrix.setPosition(i+0.5 , k+0.5, j+0.5);
          mesh.setMatrixAt(mesh.count++, matrix);
        }
      }
    }

    this.add(mesh);
  }
}