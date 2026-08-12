// wild/physics.ts — motion: gravity, terrain contact, slope roll, sphere
// separation, carrying. The calculator of movement; it never changes what
// an actor IS (that's chemistry/damage).
//
// Deliberately small: every dynamic body is a sphere, every static collider
// is a vertical column, the ground is the terrain sampler. That is enough
// for the classic loop — apples detach, bounce, and ROLL DOWNHILL into
// whatever is at the bottom (def.body.roll is the BotW-apple number).

import { Vector3 } from "../lib/math/vector3.ts";
import type { Actor, World } from "./world.ts";

const GRAVITY = 9.8;
/** Sleep when grounded and slower than this (m/s, squared). */
const SLEEP_SPEED_SQ = 0.0009;
/** Slope below this can't START a stationary roller moving (meadow grass
 *  holds an apple on anything but a real hillside). */
const SLEEP_SLOPE = 0.11;
/** Carried items ride here relative to the carrier. */
const CARRY_FWD = 0.55;
const CARRY_UP = 1.0;

const tmpN = new Vector3();
const tmpV = new Vector3();

export function stepPhysics(world: World, dt: number): void {
  const terrain = world.terrain;

  for (const a of world.actors) {
    if (!a.alive || a.def.body.kind !== "dynamic") continue;

    // Carried: kinematic follow (in front of the carrier, chest height).
    if (a.carriedBy !== 0) {
      const c = world.get(a.carriedBy);
      if (c) {
        a.pos.set(
          c.pos.x + Math.sin(c.yaw) * CARRY_FWD,
          c.pos.y + CARRY_UP,
          c.pos.z + Math.cos(c.yaw) * CARRY_FWD,
        );
        a.vel.set(0, 0, 0);
        a.grounded = false;
      }
      continue;
    }

    // Attached (apple on its branch): hold the parent-relative point.
    if (a.attachedTo !== 0) {
      const p = world.get(a.attachedTo);
      if (p && a.attachLocal) {
        a.pos.set(p.pos.x + a.attachLocal.x, p.pos.y + a.attachLocal.y, p.pos.z + a.attachLocal.z);
      } else {
        a.attachedTo = 0; // parent died without detaching us — fall free
        a.asleep = false;
      }
      continue;
    }

    if (a.asleep) continue;

    const r = a.def.body.radius;

    // Integrate.
    a.vel.y -= GRAVITY * dt;
    a.pos.x += a.vel.x * dt;
    a.pos.y += a.vel.y * dt;
    a.pos.z += a.vel.z * dt;

    // Water: drag + float toward the surface (items bob, nothing sinks far).
    if (world.inWater(a.pos)) {
      const keep = Math.pow(0.08, dt);
      a.vel.x *= keep;
      a.vel.z *= keep;
      const surf = world.water!.surfaceY;
      a.vel.y = a.vel.y * Math.pow(0.05, dt) + (surf - a.pos.y) * 2.5 * dt * 10;
    }

    // Terrain contact.
    const h = terrain.height(a.pos.x, a.pos.z);
    a.grounded = false;
    if (a.pos.y - r <= h) {
      a.pos.y = h + r;
      a.grounded = true;
      if (a.vel.y < -1.2) {
        a.vel.y = -a.vel.y * a.def.body.restitution;
      } else if (a.vel.y < 0) {
        a.vel.y = 0;
      }
      // Slope roll: downhill drive scaled by the def's roll factor.
      terrain.normal(a.pos.x, a.pos.z, tmpN);
      const slope = Math.hypot(tmpN.x, tmpN.z);
      if (slope > 0.02 && a.def.body.roll > 0) {
        const inv = 1 / Math.max(slope, 1e-6);
        const drive = GRAVITY * slope * a.def.body.roll * dt;
        a.vel.x += tmpN.x * inv * slope * drive;
        a.vel.z += tmpN.z * inv * slope * drive;
      }
      // Ground friction.
      const keep = Math.pow(a.def.body.friction, dt);
      a.vel.x *= keep;
      a.vel.z *= keep;

      // Sleep when settled on gentle ground (verbs wake actors explicitly).
      if (a.vel.lengthSq() < SLEEP_SPEED_SQ && slope * a.def.body.roll < SLEEP_SLOPE) {
        a.vel.set(0, 0, 0);
        a.asleep = true;
      }
    }

    // World bounds.
    const e = terrain.extent;
    if (a.pos.x < -e) a.pos.x = -e;
    if (a.pos.x > e) a.pos.x = e;
    if (a.pos.z < -e) a.pos.z = -e;
    if (a.pos.z > e) a.pos.z = e;
  }

  separate(world);
}

/** Sphere separation: dynamics push off statics (vertical columns) and each
 *  other. O(n·k) over a coarse XZ grid; the POC world is ~100 actors. */
function separate(world: World): void {
  const dynamics: Actor[] = [];
  const statics: Actor[] = [];
  for (const a of world.actors) {
    if (!a.alive || a.carriedBy !== 0 || a.attachedTo !== 0) continue;
    if (a.def.body.kind === "dynamic") dynamics.push(a);
    else if (a.def.body.kind === "static") statics.push(a);
  }

  for (const a of dynamics) {
    // vs static columns (trunks, rocks): horizontal push-out only.
    for (const s of statics) {
      const rr = a.def.body.radius + s.def.body.radius;
      const dx = a.pos.x - s.pos.x;
      const dz = a.pos.z - s.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      // Only collide near the column's body (a settled apple shouldn't hit
      // the canopy far above a stump).
      if (a.pos.y > s.pos.y + 4 || a.pos.y < s.pos.y - 1) continue;
      const d = Math.sqrt(d2);
      const push = (rr - d) / d;
      a.pos.x += dx * push;
      a.pos.z += dz * push;
      // Kill the inward velocity component.
      const vn = (a.vel.x * dx + a.vel.z * dz) / d2;
      if (vn < 0) {
        a.vel.x -= dx * vn;
        a.vel.z -= dz * vn;
      }
      a.asleep = a.asleep && push < 0.001;
    }
    // vs other dynamics: symmetric push, mass-weighted.
    for (const b of dynamics) {
      if (b.id <= a.id) continue;
      const rr = a.def.body.radius + b.def.body.radius;
      tmpV.copy(a.pos).sub(b.pos);
      const d2 = tmpV.lengthSq();
      if (d2 >= rr * rr || d2 < 1e-9) continue;
      const d = Math.sqrt(d2);
      const overlap = rr - d;
      const wa = b.def.body.mass / (a.def.body.mass + b.def.body.mass);
      tmpV.multiplyScalar(1 / d);
      a.pos.addScaledVector(tmpV, overlap * wa);
      b.pos.addScaledVector(tmpV, -overlap * (1 - wa));
      if (overlap > 0.005) {
        a.asleep = false;
        b.asleep = false;
      }
    }
  }
}
