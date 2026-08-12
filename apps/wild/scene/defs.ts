// scene/defs.ts — the content table: every KIND of thing in the meadow as
// one data record, plus the fixed scene layout. No code here decides
// behavior; the kernel's systems read these numbers.
//
// The heat numbers form a deliberate ladder (what a flint strike can and
// cannot light): flint burst 70 > woodPile 42 ≈ grass 40, but < log 85 <
// fallenTrunk 110 < standing appleTree 150 — kindling catches from a spark,
// timber needs a sustained fire next to it. Grass output (55 over 2.3 m)
// against its own ignition (40) is what makes a meadow chain tuft-to-tuft.
// tests/wild.test.ts pins every rung.

import { Vector3 } from "../lib/math/vector3.ts";
import { TAG } from "../wild/types.ts";
import type { World } from "../wild/world.ts";
import { POND } from "./terrain.ts";

export function registerDefs(world: World): void {
  const d = world.defs;

  d.add({
    name: "player",
    tags: TAG.player,
    body: { kind: "dynamic", radius: 0.34, mass: 60, friction: 1e-8, restitution: 0, roll: 0 },
    visual: "player",
  });

  d.add({
    name: "appleTree",
    tags: TAG.tree,
    body: { kind: "static", radius: 0.45, mass: 0, friction: 0, restitution: 0, roll: 0 },
    life: { hp: 40, vulner: { chop: 1, blunt: 0.25 }, breakInto: [{ def: "fallenTrunk", count: 1 }] },
    fuel: { ignition: 150, burnSeconds: 10, heatOutput: 60, heatRadius: 3.4, burnOutBorn: "charredStump" },
    visual: "appleTree",
  });

  d.add({
    name: "fallenTrunk",
    tags: TAG.tree,
    body: { kind: "dynamic", radius: 0.32, mass: 40, friction: 0.02, restitution: 0.1, roll: 0.12 },
    life: { hp: 24, vulner: { chop: 1, blunt: 0.3 }, breakInto: [{ def: "log", count: 3 }] },
    fuel: { ignition: 110, burnSeconds: 12, heatOutput: 50, heatRadius: 2.8, burnOutBorn: "ashPile" },
    visual: "fallenTrunk",
  });

  d.add({
    name: "log",
    tags: TAG.item,
    body: { kind: "dynamic", radius: 0.16, mass: 5, friction: 0.05, restitution: 0.15, roll: 0.3 },
    fuel: { ignition: 85, burnSeconds: 9, heatOutput: 42, heatRadius: 2.2, burnOutBorn: "ashPatch" },
    visual: "log",
  });

  d.add({
    name: "apple",
    tags: TAG.item,
    body: { kind: "dynamic", radius: 0.11, mass: 0.3, friction: 0.05, restitution: 0.35, roll: 0.85 },
    cook: { heatSeconds: 3.2, into: "bakedApple" },
    visual: "apple",
  });

  d.add({
    name: "bakedApple",
    tags: TAG.item,
    body: { kind: "dynamic", radius: 0.11, mass: 0.3, friction: 0.05, restitution: 0.3, roll: 0.8 },
    visual: "bakedApple",
  });

  d.add({
    name: "grass",
    tags: 0,
    body: { kind: "none", radius: 0.25, mass: 0, friction: 0, restitution: 0, roll: 0 },
    life: { hp: 1, breakInto: [] },
    fuel: { ignition: 40, burnSeconds: 3.4, heatOutput: 55, heatRadius: 2.3, burnOutBorn: "scorch" },
    visual: "grass",
  });

  d.add({
    name: "woodPile",
    tags: 0,
    body: { kind: "static", radius: 0.75, mass: 0, friction: 0, restitution: 0, roll: 0 },
    fuel: { ignition: 42, burnSeconds: 90, heatOutput: 72, heatRadius: 2.5, burnOutBorn: "emberPit" },
    visual: "woodPile",
  });

  // Inert set dressing + substitution results.
  const inert = (name: string, radius: number, solid: boolean) =>
    d.add({
      name,
      tags: 0,
      body: {
        kind: solid ? "static" : "none",
        radius,
        mass: 0,
        friction: 0,
        restitution: 0,
        roll: 0,
      },
      visual: name,
    });
  inert("scorch", 0.4, false);
  inert("ashPile", 0.35, false);
  inert("ashPatch", 0.2, false);
  inert("charredStump", 0.4, true);
  inert("emberPit", 0.45, false);
  inert("stoneRing", 0.55, false);
  inert("rock", 0.75, true);
}

/** The authored meadow. Everything else that ever exists is substitution. */
export function populate(world: World): void {
  const at = (x: number, z: number, y = world.terrain.height(x, z)) => new Vector3(x, y, z);

  world.water = POND;

  // The orchard rise (NE): three apple trees, apples hung in the canopy.
  const trees: [number, number][] = [
    [9, -8],
    [13, -10.5],
    [7.5, -12.5],
  ];
  const hang: [number, number, number][] = [
    [1.15, 3.55, 0.4],
    [-1.0, 3.8, 0.9],
    [0.2, 4.3, -1.15],
    [-0.75, 3.5, -0.8],
    [0.9, 4.0, -0.55],
  ];
  for (const [tx, tz] of trees) {
    const tree = world.spawn({ def: "appleTree", pos: at(tx, tz), yaw: world.rng.range(0, 6.28) });
    for (const [hx, hy, hz] of hang) {
      world.spawn({
        def: "apple",
        pos: at(tx + hx, tz, world.terrain.height(tx, tz) + hy),
        attachedTo: tree.id,
        attachLocal: new Vector3(hx, hy, hz),
      });
    }
  }
  // Two loose apples on the slope — they tumble toward camp as the scene
  // opens (the sampler's downhill runs orchard → origin).
  world.spawn({ def: "apple", pos: at(6.4, -6.2).setY(world.terrain.height(6.4, -6.2) + 0.2) });
  world.spawn({ def: "apple", pos: at(7.8, -5.4).setY(world.terrain.height(7.8, -5.4) + 0.2) });

  // Camp (origin): stone ring + wood pile, unlit until the player flints it.
  world.spawn({ def: "stoneRing", pos: at(1.8, 0.6) });
  world.spawn({ def: "woodPile", pos: at(1.8, 0.6) });
  world.spawn({ def: "log", pos: at(0.5, 1.7).setY(world.terrain.height(0.5, 1.7) + 0.2) });
  world.spawn({ def: "log", pos: at(-0.5, 1.1).setY(world.terrain.height(-0.5, 1.1) + 0.2) });

  // Grass: a kindling trail camp → orchard, clusters under the trees, a few
  // strays. Spacing ~1.3 m sits inside grass heatRadius (2.3 m) so a lit
  // tuft hands fire to the next one — but the trail HEAD stays outside the
  // campfire's heatRadius (2.5 m from (1.8, 0.6)), so burning the meadow is
  // a deliberate act, not a side effect of lighting camp (pinned by
  // tests/wild.test.ts "a lit campfire does not torch the meadow").
  const tufts: [number, number][] = [
    [3.4, -2.0],
    [4.0, -2.9],
    [4.4, -3.2],
    [5.3, -4.2],
    [6.1, -5.3],
    [6.9, -6.3],
    [7.6, -7.2],
    [8.3, -7.9],
    // under the orchard
    [10.2, -9.3],
    [11.5, -9.0],
    [12.2, -10.0],
    [8.6, -11.2],
    [9.9, -12.1],
    [11.0, -11.4],
    // strays
    [-4.5, -5.5],
    [-2.0, 5.0],
    [4.0, 4.5],
    [-7.5, 1.5],
    [-11.0, -4.0],
    [3.0, 8.5],
  ];
  for (const [gx, gz] of tufts) {
    world.spawn({ def: "grass", pos: at(gx, gz), yaw: world.rng.range(0, 6.28) });
  }

  // Rocks.
  const rocks: [number, number][] = [
    [-6, -3],
    [5, 6],
    [-3.5, -10],
    [14, 2],
    [-13.5, 4.5],
    [16, -14],
  ];
  for (const [rx, rz] of rocks) {
    world.spawn({ def: "rock", pos: at(rx, rz), yaw: world.rng.range(0, 6.28) });
  }
}
