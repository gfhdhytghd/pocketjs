// wild/damage.ts — hits in, substitutions out.
//
// A Hit carries a physical kind (chop/blunt), an optional element, an
// impulse, and a tag bonus (SpHitTag): the axe def says "×7 against
// tree-tagged actors", the tree's life table says how much chop hurts it.
// Death is never deletion — it is substitution per the def's breakInto
// (standing tree → felled trunk; trunk → firewood), with attached children
// released to physics. The same shake that fells a tree knocks its apples
// loose first, so "chop the tree, catch the apples" needs no code of its own.

import { Vector3 } from "../lib/math/vector3.ts";
import { ignite } from "./chemistry.ts";
import { TAG, type Hit } from "./types.ts";
import type { Actor, World } from "./world.ts";

/** Heat injected per point of power by a fire-element blow (torch swing). */
const FIRE_HIT_HEAT = 9;
/** Apples shaken loose per landed hit on a tree that still holds some. */
const SHAKE_DETACH = 2;

const tmp = new Vector3();

export function resolveHits(world: World, hits: Hit[]): void {
  for (const hit of hits) {
    const a = world.get(hit.target);
    if (!a) continue;

    // Impulse: dynamics get shoved (and woken).
    if (hit.impulse && a.def.body.kind === "dynamic" && a.carriedBy === 0) {
      if (a.attachedTo !== 0) {
        world.detach(a, 0.4); // a struck hanging apple just comes off
      }
      a.asleep = false;
      a.vel.addScaledVector(hit.impulse, 1 / Math.max(a.def.body.mass, 0.05));
    }

    // Element rides the blow (rule 1 applied at contact strength).
    if (hit.element === "fire" && a.def.fuel && !a.burning && a.wet <= 0) {
      a.heat += hit.power * FIRE_HIT_HEAT;
      if (a.heat >= a.def.fuel.ignition) ignite(world, a);
    }

    // Shake: a landed hit on a tree drops a few of its apples.
    if (a.def.tags & TAG.tree) {
      const children = world.attachedChildren(a);
      for (let i = 0; i < Math.min(SHAKE_DETACH, children.length); i++) {
        world.detach(children[world.rng.pick(children.length)], 1.4);
      }
    }

    // Hp: kind multiplier × tag bonus, then substitution on death.
    if (a.def.life && a.hp > 0) {
      const mult = a.def.life.vulner?.[hit.kind] ?? 1;
      const sp = a.def.tags & hit.spTag ? hit.spRatio : 1;
      const damage = hit.power * mult * sp;
      if (damage > 0) {
        a.hp -= damage;
        world.emit({ kind: "hit", id: a.id, def: a.def.name, at: a.pos.clone(), damage: hit.kind });
        if (a.hp <= 0) {
          breakActor(world, a, hit);
        }
      }
    }
  }
}

function breakActor(world: World, a: Actor, hit: Hit): void {
  // Whatever was hanging on it falls free.
  for (const child of world.attachedChildren(a)) {
    world.detach(child, 1.6);
  }

  const spawns = a.def.life?.breakInto ?? [];
  const dir = hit.impulse && hit.impulse.lengthSq() > 1e-6
    ? tmp.copy(hit.impulse).setY(0).normalize()
    : tmp.set(1, 0, 0);

  // A standing tree tips: one born actor laid along the fall direction —
  // presentation reads the `felled` event to animate the tip-over.
  const felled = (a.def.tags & TAG.tree) !== 0 && a.def.body.kind === "static";
  if (felled && spawns.length === 1 && spawns[0].count === 1) {
    const born = spawns[0].def;
    world.queueSpawn({
      def: born,
      pos: a.pos.clone().addScaledVector(dir, 1.1),
      yaw: Math.atan2(dir.x, dir.z),
    });
    world.emit({
      kind: "felled",
      id: a.id,
      def: a.def.name,
      at: a.pos.clone(),
      dir: dir.clone(),
      born,
    });
  } else {
    for (const s of spawns) {
      for (let i = 0; i < s.count; i++) {
        const ang = world.rng.range(0, Math.PI * 2);
        const speed = world.rng.range(0.8, 1.8);
        world.queueSpawn({
          def: s.def,
          pos: a.pos.clone().add(
            new Vector3(Math.sin(ang) * 0.3, 0.25 + 0.1 * i, Math.cos(ang) * 0.3),
          ),
          vel: new Vector3(
            Math.sin(ang) * speed + dir.x * 0.6,
            world.rng.range(1.2, 2.2),
            Math.cos(ang) * speed + dir.z * 0.6,
          ),
          yaw: ang,
        });
      }
    }
    world.emit({ kind: "broke", id: a.id, def: a.def.name, at: a.pos.clone() });
  }

  world.despawn(a);
}
