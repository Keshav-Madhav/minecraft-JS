import * as Three from 'three';
import { Player } from './player';
import { blocks } from './blocks';
import { World } from './world';

type collisionType = {
  block: {x: number, y: number, z: number},
  contactPoint: {x: number, y: number, z: number},
  normal: Three.Vector3,
  overlap: number
}

export class Physics {
  simRate = 200;
  timeStep = 1 / this.simRate;
  accumulator = 0;

  gravity = 32;

  constructor(_scene: Three.Scene){
    // (debug collision-helper rendering was removed — it was never enabled)
  }

  update(delta: number, player: Player, world: World){
    this.accumulator += delta;

    // If the chunk under the player hasn't streamed in yet (e.g. right after a
    // teleport), hold position instead of falling through it into the void.
    if(!world.isLoadedAt(player.position.x, player.position.z)){
      this.accumulator = 0;
      return;
    }

    const sea = world.params.terrain.waterOffset;

    while(this.accumulator >= this.timeStep){
      player.velocity.y -= this.gravity * this.timeStep;

      // Water: float/swim at the surface instead of sinking to the seabed. In
      // water when the body centre is below sea level AND the column there is open
      // water (block at sea level is air over a sub-sea floor — not a land hill).
      // A buoyancy spring toward the surface + weak gravity + drag settles the
      // player bobbing with their head right at the waterline.
      const depth = sea - (player.position.y - player.height * 0.5);
      if (depth > 0 &&
          world.getBlockId(Math.floor(player.position.x), sea, Math.floor(player.position.z)) === blocks.air.id) {
        player.velocity.y += this.gravity * this.timeStep * 0.82;     // weak gravity in water
        player.velocity.y += Math.min(depth, 3) * 8 * this.timeStep;  // buoyancy toward the surface
        player.velocity.y *= Math.exp(-4 * this.timeStep);            // water drag (settles the bob)
      }

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
      if(!this.pointInPlayerBoundingCylinder(collision.contactPoint, player)) continue;

      let deltaPos = collision.normal.clone()
      deltaPos.multiplyScalar(collision.overlap);
      player.position.add(deltaPos);

      // Only cancel the velocity component driving INTO the surface. Without this
      // guard, a floor contact that lingers for a substep after a jump impulse
      // (very common when jumping while pressed against a block) subtracts the
      // upward jump velocity and "eats" the jump. Velocity moving AWAY from the
      // surface (a fresh jump) is left intact; the position correction above
      // still separates the bodies.
      const magnitude = player.worldVelocity.dot(collision.normal);
      if (magnitude < 0) {
        const velocityAdjustment = collision.normal.clone().multiplyScalar(magnitude);
        player.applyWorldDeltaVelocity(velocityAdjustment.negate());
      }
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
          if(world.getBlockId(x, y, z) !== blocks.air.id){
            candidates.push({x, y, z});
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

      if(this.pointInPlayerBoundingCylinder(closestPoint, player)){
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
      }
    }

    return collisions;
  }

  pointInPlayerBoundingCylinder(point: {x: number, y: number, z: number}, player: Player){
    const dx = point.x - player.position.x;
    const dy = point.y - (player.position.y - (player.height / 2));
    const dz = point.z - player.position.z;
    const r_sq = dx * dx + dz * dz;

    return (Math.abs(dy) < player.height / 2) && (r_sq < player.radius * player.radius);
  }
}