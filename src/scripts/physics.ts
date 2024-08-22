import * as Three from 'three';
import { Player } from './player';
import { blocks } from './blocks';
import { World } from './world';

const collisionMaterial = new Three.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity:0.2 });
const collisionGeometry = new Three.BoxGeometry(1.0001, 1.001, 1.001);
const contactMaterial = new Three.MeshBasicMaterial({ color: 0x00ff00, wireframe: true });
const contactGeometry = new Three.SphereGeometry(0.05, 6, 6);

type collisionType = {
  block: {x: number, y: number, z: number},
  contactPoint: {x: number, y: number, z: number},
  normal: Three.Vector3,
  overlap: number
}

export class Physics {
  helpers: Three.Group;

  simRate = 200;
  timeStep = 1 / this.simRate;
  accumulator = 0;

  gravity = 32;

  constructor(scene: Three.Scene){
    this.helpers = new Three.Group();
    scene.add(this.helpers);
  }

  update(delta: number, player: Player, world: World){
    this.accumulator += delta;

    while(this.accumulator >= this.timeStep){
      this.helpers.clear();
      player.velocity.y -= this.gravity * this.timeStep;
  
      player.applyInputs(this.timeStep);
      player.updateBounds();
  
      this.detectCollisions(player, world);

      this.accumulator -= this.timeStep;
    }
  }

  detectCollisions(player: Player, world: World){
    player.onGround = false;
    const candidates = this.broadPhase(player, world);
    const collisions = this.narrowPhase(player, candidates);

    if(collisions.length > 0){
      this.resolveCollisions(collisions, player);
    }
  }

  resolveCollisions(collisions: collisionType[], player: Player){
    collisions.sort((a, b) => a.overlap - b.overlap);

    for(const collision of collisions){
      if(!this.pointInPlaayerBoundingCylinder(collision.contactPoint, player)) continue;

      let deltaPos = collision.normal.clone()
      deltaPos.multiplyScalar(collision.overlap);
      player.position.add(deltaPos);

      let magnitude = player.worldVelocity.dot(collision.normal);
      let velocityAdjustment = collision.normal.clone().multiplyScalar(magnitude);

      player.applyWorldDeltaVelocity(velocityAdjustment.negate());
    }
  }

  broadPhase(player: Player, world: World){
    const candidates = [];

    const extents = {
      x: {
        min: Math.floor(player.position.x - player.radius),
        max: Math.ceil(player.position.x + player.radius),
      },
      y: {
        min: Math.floor(player.position.y - player.height),
        max: Math.ceil(player.position.y),
      },
      z: {
        min: Math.floor(player.position.z - player.radius),
        max: Math.ceil(player.position.z + player.radius),
      }
    }

    for(let x = extents.x.min; x <= extents.x.max; x++){
      for(let y = extents.y.min; y <= extents.y.max; y++){
        for(let z = extents.z.min; z <= extents.z.max; z++){
          const block = world.getBlock(x, y, z);
          if(block && block.id !== blocks.air.id){
            const blockPos = {x, y, z};
            candidates.push(blockPos);
            this.addCollisonHelper(blockPos);
          }
        }
      }
    }

    return candidates;
  }

  narrowPhase(player: Player, candidates: {x: number, y: number, z: number}[]){
    const collisions: collisionType[] = [];

    for(const candidate of candidates){
      const p = player.position;
      const closestPoint ={
        x: Math.max(candidate.x - 0.5, Math.min(p.x, candidate.x + 0.5)),
        y: Math.max(candidate.y - 0.5, Math.min(p.y - (player.height / 2), candidate.y + 0.5)),
        z: Math.max(candidate.z - 0.5, Math.min(p.z, candidate.z + 0.5)),
      }

      const dx = closestPoint.x - p.x;
      const dy = closestPoint.y - (p.y - (player.height / 2));
      const dz = closestPoint.z - p.z;

      if(this.pointInPlaayerBoundingCylinder(closestPoint, player)){
        const overlapY = (player.height / 2) - Math.abs(dy);
        const overlapXZ = player.radius - Math.sqrt(dx * dx + dz * dz);

        let overlap, normal;
        if(overlapY < overlapXZ){
          overlap = overlapY;
          normal = new Three.Vector3(0, -Math.sign(dy), 0);
          player.onGround = true;
        } else {
          overlap = overlapXZ;
          normal = new Three.Vector3(-dx, 0, -dz).normalize();
        }

        collisions.push({
          block: candidate, 
          contactPoint: closestPoint,
          normal,
          overlap,
        })

        this.addContactHelper(closestPoint);
      }
    }

    return collisions;
  }

  pointInPlaayerBoundingCylinder(point: {x: number, y: number, z: number}, player: Player){
    const dx = point.x - player.position.x;
    const dy = point.y - (player.position.y - (player.height / 2));
    const dz = point.z - player.position.z;
    const r_sq = dx * dx + dz * dz;

    return (Math.abs(dy) < player.height / 2) && (r_sq < player.radius * player.radius);
  }

  addCollisonHelper(block: {x: number, y: number, z: number}){
    const helper = new Three.Mesh(collisionGeometry, collisionMaterial);
    helper.position.copy(block);
    this.helpers.add(helper);
  }

  addContactHelper(contactPoint: {x: number, y: number, z: number}){
    const helper = new Three.Mesh(contactGeometry, contactMaterial);
    helper.position.copy(contactPoint);
    this.helpers.add(helper);
  }
}