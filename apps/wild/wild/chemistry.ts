// wild/chemistry.ts — the rule engine over state. Three rules, verbatim
// from the BotW chemistry-engine design:
//
//   1. elements change materials  — heat ignites fuel, cooks food
//   2. elements change elements   — water kills fire; wind stretches it
//   3. materials never change materials — that interaction is physics
//
// Heat is the only quantity: burning actors and one-tick bursts radiate it;
// fuel-bearing actors accumulate it toward ignition, food accumulates it
// toward substitution. No rule ever names a def — a campfire, a burning
// grass tuft and a carried burning branch are all just "a burning actor",
// which is why carrying fire to a meadow works without a line of code
// about torches.

import { Vector3 } from "../lib/math/vector3.ts";
import type { Actor, World } from "./world.ts";

export interface HeatBurst {
  at: Vector3;
  radius: number;
  amount: number;
}

/** Heat lost per second when nothing feeds an actor's accumulator. */
const COOL_RATE = 26;
/** Wetness applied by water contact, seconds. */
const WET_SECONDS = 6;

const tmp = new Vector3();

export function stepChemistry(world: World, bursts: HeatBurst[], dt: number): void {
  const actors = world.actors;

  // -- rule 2a: water beats fire (and wets materials) -------------------------
  for (const a of actors) {
    if (!a.alive) continue;
    if (world.inWater(a.pos)) {
      if (a.wet <= 0) {
        world.emit({ kind: "splash", id: a.id, def: a.def.name, at: a.pos.clone() });
      }
      a.wet = WET_SECONDS;
      a.heat = 0;
      if (a.burning) {
        a.burning = false;
        world.emit({ kind: "extinguished", id: a.id, def: a.def.name, at: a.pos.clone() });
      }
    } else if (a.wet > 0) {
      a.wet -= dt;
    }
  }

  // -- rule 1 (+2b): heat flows from sources to materials ---------------------
  // Sources: burning actors + one-tick bursts. Wind (an element) stretches
  // every fire's reach downwind by displacing the source's effective center.
  const gain = new Map<number, number>();
  const addHeat = (target: Actor, amount: number) => {
    gain.set(target.id, (gain.get(target.id) ?? 0) + amount);
  };

  for (const src of actors) {
    if (!src.alive || !src.burning || !src.def.fuel) continue;
    const f = src.def.fuel;
    radiate(
      world,
      tmp.set(
        src.pos.x + world.wind.x * f.heatRadius * 0.35,
        src.pos.y,
        src.pos.z + world.wind.z * f.heatRadius * 0.35,
      ),
      f.heatRadius,
      f.heatOutput * dt,
      src.id,
      addHeat,
    );
  }
  for (const b of bursts) {
    radiate(world, b.at, b.radius, b.amount, 0, addHeat);
  }

  // -- apply accumulated heat: ignition, cooking, cooling ----------------------
  for (const a of actors) {
    if (!a.alive) continue;
    const g = gain.get(a.id) ?? 0;

    // Wet materials refuse heat entirely (rule 2 wins over rule 1).
    const heated = g > 0 && a.wet <= 0;

    if (a.def.fuel && !a.burning) {
      a.heat = heated ? a.heat + g : Math.max(0, a.heat - COOL_RATE * dt);
      if (a.heat >= a.def.fuel.ignition) {
        ignite(world, a);
      }
    }

    if (a.def.cook) {
      // Food transforms under sustained heat; it never ignites.
      if (heated) {
        a.cookTime += dt;
        if (a.cookTime >= a.def.cook.heatSeconds) {
          const into = a.def.cook.into;
          world.emit({ kind: "cooked", id: a.id, def: a.def.name, at: a.pos.clone(), into });
          world.queueSpawn({ def: into, pos: a.pos, vel: a.vel, yaw: a.yaw });
          world.despawn(a);
          continue;
        }
      } else if (a.cookTime > 0) {
        a.cookTime = Math.max(0, a.cookTime - dt * 0.5);
      }
    }

    // Burning: consume fuel, then substitute (IsBurnOutBorn, generalized).
    if (a.burning) {
      a.fuelLeft -= dt;
      if (a.fuelLeft <= 0) {
        const born = a.def.fuel?.burnOutBorn ?? null;
        world.emit({ kind: "burnedOut", id: a.id, def: a.def.name, at: a.pos.clone(), born });
        if (born) {
          world.queueSpawn({ def: born, pos: a.pos, yaw: a.yaw });
        }
        world.despawn(a);
      }
    }
  }
}

/** Ignition is public to chemistry and damage (a fire-element hit ignites). */
export function ignite(world: World, a: Actor): void {
  if (a.burning || !a.def.fuel || !a.alive) return;
  a.burning = true;
  a.heat = 0;
  a.fuelLeft = a.def.fuel.burnSeconds;
  world.emit({ kind: "ignited", id: a.id, def: a.def.name, at: a.pos.clone() });
  // A tree catching fire shakes its fruit loose immediately — attached
  // children of a burning parent detach (they may then cook on the ground
  // beside it; the kernel doesn't special-case that, rule 1 just applies).
  for (const child of world.attachedChildren(a)) {
    world.detach(child, 1.2);
  }
}

/** Linear-falloff radiation to every heat-accepting actor in range. */
function radiate(
  world: World,
  from: Vector3,
  radius: number,
  amount: number,
  excludeId: number,
  addHeat: (target: Actor, amount: number) => void,
): void {
  const r2 = radius * radius;
  for (const t of world.actors) {
    if (!t.alive || t.id === excludeId) continue;
    if (!t.def.fuel && !t.def.cook) continue;
    if (t.burning) continue;
    const d2 = t.pos.distanceToSquared(from);
    if (d2 >= r2) continue;
    const falloff = 1 - Math.sqrt(d2) / radius;
    addHeat(t, amount * falloff);
  }
}
