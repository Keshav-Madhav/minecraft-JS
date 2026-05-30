import * as Three from 'three';
import { Player } from './player';
import { blocks } from './blocks';
import { isPlant, isSlippery, collisionBoxes } from './blockTypes';
import { World } from './world';

// Auto-step: a moving, grounded player is lifted onto a ledge no taller than this
// so slabs/stairs (and structure steps) are walked up smoothly, not jumped.
const STEP_HEIGHT = 0.6;

// --- swimming tuning --------------------------------------------------------
const SWIM_RISE = 6;        // blocks/s upward while holding Space underwater
const SWIM_SINK = 1.8;      // blocks/s gentle sink with no input (lets you dive)
const SWIM_RESPONSE = 9;    // how fast vertical velocity eases to the swim target
const WATER_DRAG = 3.2;     // horizontal damping in water (weighty, slower swimming)

type Candidate = { x: number, y: number, z: number, id: number };
type collisionType = {
  block: Candidate,
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
      // Are we in open water? (body centre below sea level AND the column at sea
      // level is air over a sub-sea floor — i.e. real ocean, not a land hill).
      const bodyCenterY = player.position.y - player.height * 0.5;
      const inWater = !player.flying && bodyCenterY < sea &&
        world.getBlockId(Math.floor(player.position.x), sea, Math.floor(player.position.z)) === blocks.air.id;

      // Flight (Creative / Survival-flight): no gravity, vertical from input.
      if (!player.flying) {
        if (inWater) {
          // Swimming: gravity is cancelled and replaced by a controlled vertical
          // glide — hold Space to rise, otherwise sink gently — with heavy drag so
          // it feels weighty, not bouncy (no buoyancy spring → no surface bobbing).
          const target = player.wantsUp ? SWIM_RISE : -SWIM_SINK;
          player.velocity.y += (target - player.velocity.y) * Math.min(1, SWIM_RESPONSE * this.timeStep);
          // Ease to a stop right at the waterline when surfacing, so the head rests
          // at the surface (you can breathe / walk out) instead of launching out.
          if (player.velocity.y > 0) {
            const room = Math.max(0, sea - bodyCenterY);
            player.velocity.y = Math.min(player.velocity.y, room / this.timeStep * 0.5);
          }
          // Water resistance on horizontal motion (slower, weightier swimming).
          const hdamp = Math.exp(-WATER_DRAG * this.timeStep);
          player.velocity.x *= hdamp; player.velocity.z *= hdamp;
        } else {
          player.velocity.y -= this.gravity * this.timeStep;
        }
      }

      // Slippery footing: standing on ice/packed ice makes the player slide
      // (player.#updateMovement reads onIce to cut friction + acceleration).
      const footY = Math.floor(player.position.y - player.height - 0.2);
      player.onIce = !player.flying && player.onGround &&
        isSlippery(world.getBlockId(Math.floor(player.position.x), footY, Math.floor(player.position.z)));

      player.applyInputs(this.timeStep);
      player.updateBounds();

      this.detectCollisions(player, world);

      this.accumulator -= this.timeStep;
    }
  }

  detectCollisions(player: Player, world: World){
    player.onGround = false;
    const collisions = this.narrowPhase(player, this.broadPhase(player, world));
    const horizontal = collisions.filter(c => Math.abs(c.normal.y) < 0.5 && c.overlap > 0.001);
    const preSpeed = Math.hypot(player.worldVelocity.x, player.worldVelocity.z);

    if(collisions.length > 0){
      this.resolveCollisions(collisions, player);
    }

    // Auto-step: a moving, grounded player stopped by a low ledge is lifted to sit
    // EXACTLY on top of it (slabs/stairs/structure steps). The ledge height is read
    // from the blocking block's own collision boxes and snapped to — the old code
    // always lifted a fixed STEP_HEIGHT, overshooting a 0.5 slab by 0.1 so the
    // player visibly "popped". Full blocks (top > feet + STEP_HEIGHT) don't qualify,
    // so they still need a jump. Reverted if the lifted body has no headroom (a
    // taller wall or a low ceiling), so we never clip into geometry. Never while
    // flying — the player controls Y directly there, so snapping onto a ledge would
    // fight the input and make low passes jerky.
    if(horizontal.length > 0 && player.onGround && preSpeed > 0.4 && !player.flying){
      const feet = player.position.y - player.height;
      let stepTop = -Infinity;
      for(const c of horizontal){
        for(const box of collisionBoxes(c.block.id)){
          const top = c.block.y - 0.5 + box[4];   // world Y of this box's top face
          if(top > feet + 0.02 && top <= feet + STEP_HEIGHT + 1e-3 && top > stepTop) stepTop = top;
        }
      }
      if(stepTop > -Infinity){
        const savedY = player.position.y;
        player.position.y = stepTop + player.height + 1e-3;   // feet rest just on the ledge
        const blocked = this.narrowPhase(player, this.broadPhase(player, world))
          .some(c => c.overlap > 0.02);                       // any wall/ceiling intrusion at the new height
        if(blocked) player.position.y = savedY;               // not a valid step → stay put (needs a jump)
        player.onGround = true;                               // grounded either way (probe's side effect overwritten)
      }
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

  broadPhase(player: Player, world: World): Candidate[] {
    const candidates: Candidate[] = [];

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
          // Plants (grass/flowers/vines/…) are decorative — walk straight through.
          const id = world.getBlockId(x, y, z);
          if(id !== blocks.air.id && !isPlant(id)){
            candidates.push({x, y, z, id});
          }
        }
      }
    }

    return candidates;
  }

  narrowPhase(player: Player, candidates: Candidate[]){
    const collisions: collisionType[] = [];
    const p = player.position;
    const bodyY = p.y - (player.height / 2);

    for(const candidate of candidates){
      // Each block contributes one or more AABBs (full cube by default; slab/stair/
      // fence/door give partial boxes). Full cube → identical to the old behaviour.
      for(const box of collisionBoxes(candidate.id)){
        const bx0 = candidate.x - 0.5 + box[0], by0 = candidate.y - 0.5 + box[1], bz0 = candidate.z - 0.5 + box[2];
        const bx1 = candidate.x - 0.5 + box[3], by1 = candidate.y - 0.5 + box[4], bz1 = candidate.z - 0.5 + box[5];
        const closestPoint = {
          x: Math.max(bx0, Math.min(p.x, bx1)),
          y: Math.max(by0, Math.min(bodyY, by1)),
          z: Math.max(bz0, Math.min(p.z, bz1)),
        };
        const dx = closestPoint.x - p.x;
        const dy = closestPoint.y - bodyY;
        const dz = closestPoint.z - p.z;

        if(this.pointInPlayerBoundingCylinder(closestPoint, player)){
          const overlapY = (player.height / 2) - Math.abs(dy);
          const overlapXZ = player.radius - Math.sqrt(dx * dx + dz * dz);

          let overlap, normal;
          if(overlapY < overlapXZ){
            overlap = overlapY;
            normal = new Three.Vector3(0, -Math.sign(dy), 0);
            // Ground only when supported from BELOW (contact point under the body
            // centre → normal points up). A ceiling contact (dy > 0) must NOT count
            // as grounded — otherwise bonking your head resets coyote/jump, and a
            // flying player grazing a ceiling would read as "on the ground".
            if(dy < 0) player.onGround = true;
          } else {
            overlap = overlapXZ;
            normal = new Three.Vector3(-dx, 0, -dz).normalize();
          }

          collisions.push({ block: candidate, contactPoint: closestPoint, normal, overlap });
        }
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