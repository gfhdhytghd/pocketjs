// tests/wild.test.ts — the wild kernel, headless: the chemistry ladder, the
// grass fire chain, cooking, water, chopping, rolling, and determinism.
// These are the playtest: every gameplay-tuning number in
// apps/wild/scene/defs.ts is pinned by an assertion here.

import { describe, expect, test } from "bun:test";
import { Vector3 } from "../apps/wild/lib/math/vector3.ts";
import { TAG, type WorldEvent } from "../apps/wild/wild/types.ts";
import { World } from "../apps/wild/wild/world.ts";
import { registerDefs, populate } from "../apps/wild/scene/defs.ts";
import { makeTerrain } from "../apps/wild/scene/terrain.ts";

const DT = 1 / 60;

function makeWorld(seed = 0x57494c44): World {
  const world = new World(seed, makeTerrain());
  registerDefs(world);
  return world;
}

function run(world: World, seconds: number, drained?: WorldEvent[]): WorldEvent[] {
  const all = drained ?? [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    world.step(DT);
    all.push(...world.drainEvents());
  }
  return all;
}

// Mirrors game.ts FLINT (the strike the player actually gets).
const FLINT = { radius: 2.2, amount: 70 };

describe("chemistry ladder", () => {
  test("a flint strike lights kindling but not timber", () => {
    const world = makeWorld();
    const pile = world.spawn({ def: "woodPile", pos: new Vector3(0, 0, 0) });
    const grass = world.spawn({ def: "grass", pos: new Vector3(1, 0, 0) });
    const log = world.spawn({ def: "log", pos: new Vector3(0.5, 0.16, 0.5) });
    world.heatBurst(new Vector3(0.3, 0, 0.1), FLINT.radius, FLINT.amount);
    const events = run(world, 0.2);
    expect(pile.burning).toBe(true);
    expect(grass.burning).toBe(true);
    expect(log.burning).toBe(false);
    expect(events.filter((e) => e.kind === "ignited").length).toBe(2);
  });

  test("a lit campfire ignites a log beside it, which outlives the pile as a fire source", () => {
    const world = makeWorld();
    const pile = world.spawn({ def: "woodPile", pos: new Vector3(0, 0, 0) });
    const log = world.spawn({ def: "log", pos: new Vector3(0.9, 0.16, 0) });
    world.heatBurst(new Vector3(0, 0, 0), 1, 60);
    run(world, 6);
    expect(pile.burning).toBe(true);
    expect(log.burning).toBe(true);
  });

  test("heat cools off when the source is removed", () => {
    const world = makeWorld();
    const log = world.spawn({ def: "log", pos: new Vector3(0, 0.16, 0) });
    world.heatBurst(new Vector3(0, 0, 0), 1, 60); // below log ignition (85)
    run(world, 0.1);
    const peak = log.heat;
    expect(peak).toBeGreaterThan(30);
    run(world, 3);
    expect(log.heat).toBe(0);
    expect(log.burning).toBe(false);
  });
});

describe("fire spreads through the meadow", () => {
  test("a lit campfire does not torch the meadow by itself", () => {
    const world = makeWorld();
    populate(world);
    const pile = world.actors.find((a) => a.def.name === "woodPile")!;
    world.heatBurst(pile.pos.clone(), 1, 60);
    const events = run(world, 40);
    expect(pile.burning).toBe(true);
    expect(events.some((e) => e.kind === "ignited" && e.def === "grass")).toBe(false);
  });

  test("the kindling trail chains tuft-to-tuft from camp to the orchard", () => {
    const world = makeWorld();
    populate(world);
    // Strike the first tuft of the trail (3.4, -2.0).
    world.heatBurst(new Vector3(3.4, world.terrain.height(3.4, -2.0), -2.0), 1.2, 70);
    const events = run(world, 30);
    const ignitions = events.filter((e) => e.kind === "ignited");
    const grassFires = ignitions.filter((e) => e.def === "grass").length;
    expect(grassFires).toBeGreaterThanOrEqual(6); // the fire traveled
    // Burned-out tufts substitute into scorch decals.
    expect(events.some((e) => e.kind === "burnedOut" && e.def === "grass")).toBe(true);
    expect(world.actors.some((a) => a.def.name === "scorch")).toBe(true);
  });

  test("a burning tree drops its apples and burns down to a charred stump", () => {
    const world = makeWorld();
    const tree = world.spawn({ def: "appleTree", pos: new Vector3(0, 0, 0) });
    for (let i = 0; i < 3; i++) {
      world.spawn({
        def: "apple",
        pos: new Vector3(0, 3.8, 0),
        attachedTo: tree.id,
        attachLocal: new Vector3(0.6 * i - 0.6, 3.8, 0.3),
      });
    }
    // A big sustained fire under the canopy (several burning logs' worth).
    for (let i = 0; i < 20; i++) world.heatBurst(new Vector3(0.3, 0.5, 0), 2.5, 30);
    const events = run(world, 14);
    expect(events.some((e) => e.kind === "ignited" && e.def === "appleTree")).toBe(true);
    const detached = events.filter((e) => e.kind === "detached" && e.def === "apple");
    expect(detached.length).toBe(3);
    expect(events.some((e) => e.kind === "burnedOut" && e.def === "appleTree")).toBe(true);
    expect(world.actors.some((a) => a.def.name === "charredStump")).toBe(true);
  });
});

describe("cooking (rule 1 as substitution)", () => {
  test("an apple beside a lit campfire becomes a baked apple", () => {
    const world = makeWorld();
    world.spawn({ def: "woodPile", pos: new Vector3(0, 0, 0) });
    world.spawn({ def: "apple", pos: new Vector3(1.0, 0.11, 0) });
    world.heatBurst(new Vector3(0, 0, 0), 1, 60);
    const events = run(world, 8);
    const cooked = events.find((e) => e.kind === "cooked");
    expect(cooked).toBeDefined();
    expect(cooked!.kind === "cooked" && cooked!.into).toBe("bakedApple");
    const baked = world.actors.find((a) => a.def.name === "bakedApple");
    expect(baked).toBeDefined();
    // The apple never ignites — food cooks, it doesn't burn.
    expect(events.some((e) => e.kind === "ignited" && e.def === "apple")).toBe(false);
  });

  test("a baked apple is inert to further heat", () => {
    const world = makeWorld();
    world.spawn({ def: "woodPile", pos: new Vector3(0, 0, 0) });
    const baked = world.spawn({ def: "bakedApple", pos: new Vector3(0.9, 0.11, 0) });
    world.heatBurst(new Vector3(0, 0, 0), 1, 60);
    run(world, 8);
    expect(baked.alive).toBe(true);
    expect(baked.burning).toBe(false);
  });
});

describe("water beats fire (rule 2)", () => {
  test("a burning log thrown in the pond goes out, wet blocks reignition", () => {
    const world = makeWorld();
    world.water = { x: 0, z: 0, radius: 3, surfaceY: -0.2 };
    const log = world.spawn({ def: "log", pos: new Vector3(10, 0.16, 0) });
    run(world, 0.5); // let it settle onto the terrain
    world.heatBurst(log.pos.clone(), 1.5, 120); // force-light it
    let events = run(world, 0.2);
    expect(log.burning).toBe(true);
    // Fly it into the pond.
    log.pos.set(0, -0.2, 0);
    events = run(world, 0.2);
    expect(log.burning).toBe(false);
    expect(events.some((e) => e.kind === "extinguished")).toBe(true);
    expect(events.some((e) => e.kind === "splash")).toBe(true);
    // Wet: the same burst that lit it dry now does nothing.
    world.heatBurst(new Vector3(0, -0.2, 0), 1.5, 120);
    run(world, 0.2);
    expect(log.burning).toBe(false);
  });
});

describe("chopping (damage + substitution)", () => {
  const AXE = { kind: "chop" as const, power: 4, spTag: TAG.tree, spRatio: 3 };

  function chop(world: World, id: number): WorldEvent[] {
    world.queueHit({
      target: id,
      ...AXE,
      impulse: new Vector3(3, 1, 0),
      element: null,
    });
    return run(world, 0.5);
  }

  test("four axe chops fell a tree; the trunk chops into firewood", () => {
    const world = makeWorld();
    const tree = world.spawn({ def: "appleTree", pos: new Vector3(0, 0, 0) });
    world.spawn({
      def: "apple",
      pos: new Vector3(0.8, 3.8, 0),
      attachedTo: tree.id,
      attachLocal: new Vector3(0.8, 3.8, 0),
    });

    let events: WorldEvent[] = [];
    for (let i = 0; i < 4; i++) events = events.concat(chop(world, tree.id));
    expect(events.some((e) => e.kind === "felled" && e.born === "fallenTrunk")).toBe(true);
    // The shake dropped the apple before the tree died.
    expect(events.some((e) => e.kind === "detached" && e.def === "apple")).toBe(true);

    const trunk = world.actors.find((a) => a.def.name === "fallenTrunk");
    expect(trunk).toBeDefined();
    events = [];
    for (let i = 0; i < 2; i++) events = events.concat(chop(world, trunk!.id));
    expect(events.some((e) => e.kind === "broke" && e.def === "fallenTrunk")).toBe(true);
    expect(world.actors.filter((a) => a.def.name === "log").length).toBe(3);
  });

  test("the axe bonus is the tag, not the tree: blunt shoves barely scratch it", () => {
    const world = makeWorld();
    const tree = world.spawn({ def: "appleTree", pos: new Vector3(0, 0, 0) });
    world.queueHit({
      target: tree.id,
      kind: "blunt",
      power: 4,
      impulse: null,
      spTag: 0,
      spRatio: 1,
      element: null,
    });
    run(world, 0.1);
    expect(tree.hp).toBe(39); // 4 × 0.25 blunt vulnerability, no tag bonus
  });
});

describe("physics", () => {
  test("a loose apple on the orchard slope rolls downhill and settles lower", () => {
    const world = makeWorld();
    const x0 = 6.4;
    const z0 = -6.2;
    const apple = world.spawn({
      def: "apple",
      pos: new Vector3(x0, world.terrain.height(x0, z0) + 0.2, z0),
    });
    run(world, 20);
    const traveled = Math.hypot(apple.pos.x - x0, apple.pos.z - z0);
    expect(traveled).toBeGreaterThan(1.2);
    expect(world.terrain.height(apple.pos.x, apple.pos.z)).toBeLessThan(
      world.terrain.height(x0, z0),
    );
    expect(apple.asleep).toBe(true); // it settles, it doesn't jitter forever
  });

  test("static trunks push dynamics out horizontally", () => {
    const world = makeWorld();
    world.spawn({ def: "appleTree", pos: new Vector3(0, 0, 0) });
    const apple = world.spawn({ def: "apple", pos: new Vector3(0.05, 2, 0) });
    run(world, 3);
    expect(Math.hypot(apple.pos.x, apple.pos.z)).toBeGreaterThan(0.45);
  });
});

describe("determinism", () => {
  test("two runs of one scripted journey are state-hash identical", () => {
    const journey = (world: World): number => {
      populate(world);
      world.heatBurst(new Vector3(2.6, 0, -1.2), 1.2, 55);
      run(world, 5);
      const tree = world.actors.find((a) => a.def.name === "appleTree")!;
      world.queueHit({
        target: tree.id,
        kind: "chop",
        power: 4,
        impulse: new Vector3(2, 0.5, 1),
        spTag: TAG.tree,
        spRatio: 3,
        element: null,
      });
      run(world, 5);
      return world.stateHash();
    };
    const a = journey(makeWorld());
    const b = journey(makeWorld());
    expect(a).toBe(b);
    // And a different seed is a different world.
    expect(journey(makeWorld(1234))).not.toBe(a);
  });
});
