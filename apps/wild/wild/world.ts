// wild/world.ts — the World: actor store, verb surface, and the fixed
// step pipeline.
//
// One `step(dt)` is one transaction, always dt = 1/60 (lib/loop.ts drives
// 60/hz of them per virtual frame): drain intents → physics → damage →
// chemistry → lifecycle. System order is part of the contract — a hit lands
// before the heat it may have carried, spawns from all systems apply
// together at the end of the step, and events read out in the order the
// facts happened. Two runs over one input tape are identical, state hash
// included (tests/wild.test.ts pins this).

import { Vector3 } from "../lib/math/vector3.ts";
import { Quaternion } from "../lib/math/quaternion.ts";
import { DefTable, type ActorDef } from "./defs.ts";
import { Rng } from "./rng.ts";
import { TAG, type Element, type Hit, type WorldEvent } from "./types.ts";
import { stepPhysics } from "./physics.ts";
import { stepChemistry, type HeatBurst } from "./chemistry.ts";
import { resolveHits } from "./damage.ts";

/** Terrain contract: pure height function (the sampler IS the ground truth —
 *  presentation bakes its heightfield from the same function). */
export interface Terrain {
  height(x: number, z: number): number;
  /** Outward normal, computed by central differences over `height`. */
  normal(x: number, z: number, out: Vector3): Vector3;
  /** Walkable bounds (actors clamp here). */
  extent: number;
}

/** A circular pond: inside it, water wins over fire (rule 2). */
export interface WaterBody {
  x: number;
  z: number;
  radius: number;
  surfaceY: number;
}

export interface Actor {
  id: number;
  def: ActorDef;
  pos: Vector3;
  vel: Vector3;
  quat: Quaternion;
  /** Facing yaw (radians) — player/trunk orientation without full rigid
   *  body rotation; rolling visuals derive spin from vel in presentation. */
  yaw: number;
  // chemistry state (materials carry state; elements change it)
  heat: number;
  burning: boolean;
  fuelLeft: number;
  cookTime: number;
  /** Seconds of wetness left; wet materials refuse heat (water beats fire). */
  wet: number;
  // damage state
  hp: number;
  // attachment / carrying
  attachedTo: number;
  attachLocal: Vector3 | null;
  carriedBy: number;
  grounded: boolean;
  asleep: boolean;
  alive: boolean;
}

export interface SpawnRequest {
  def: string;
  pos: Vector3;
  vel?: Vector3;
  yaw?: number;
  attachedTo?: number;
  attachLocal?: Vector3;
}

export class World {
  readonly defs = new DefTable();
  readonly rng: Rng;
  readonly actors: Actor[] = [];
  /** Slow world wind (m of heat-bias per heat-radius); chemistry rule 2:
   *  wind acts on fire by stretching every burning source's reach downwind. */
  readonly wind = new Vector3(0.6, 0, 0.25);
  terrain: Terrain;
  water: WaterBody | null = null;

  /** Virtual tick counter (60 per second, every hz). */
  tick = 0;

  private nextId = 1;
  private byId = new Map<number, Actor>();
  private hits: Hit[] = [];
  private bursts: HeatBurst[] = [];
  private spawns: SpawnRequest[] = [];
  private events: WorldEvent[] = [];

  constructor(seed: number, terrain: Terrain) {
    this.rng = new Rng(seed);
    this.terrain = terrain;
  }

  // -- store ------------------------------------------------------------------

  get(id: number): Actor | null {
    const a = this.byId.get(id);
    return a && a.alive ? a : null;
  }

  /** Immediate spawn (scene setup); in-step spawns go through `queueSpawn`. */
  spawn(req: SpawnRequest): Actor {
    const def = this.defs.get(req.def);
    const a: Actor = {
      id: this.nextId++,
      def,
      pos: req.pos.clone(),
      vel: req.vel ? req.vel.clone() : new Vector3(),
      quat: new Quaternion(),
      yaw: req.yaw ?? 0,
      heat: 0,
      burning: false,
      fuelLeft: def.fuel ? def.fuel.burnSeconds : 0,
      cookTime: 0,
      wet: 0,
      hp: def.life ? def.life.hp : 0,
      attachedTo: req.attachedTo ?? 0,
      attachLocal: req.attachLocal ? req.attachLocal.clone() : null,
      carriedBy: 0,
      grounded: false,
      asleep: def.body.kind !== "dynamic",
      alive: true,
    };
    this.actors.push(a);
    this.byId.set(a.id, a);
    return a;
  }

  queueSpawn(req: SpawnRequest): void {
    this.spawns.push(req);
  }

  despawn(a: Actor): void {
    a.alive = false;
  }

  emit(e: WorldEvent): void {
    this.events.push(e);
  }

  /** Presentation drains once per virtual frame (after the catch-up steps). */
  drainEvents(): WorldEvent[] {
    const out = this.events;
    this.events = [];
    return out;
  }

  // -- verbs (the whole outside-in surface) -------------------------------------

  queueHit(hit: Hit): void {
    this.hits.push(hit);
  }

  /** One-tick heat impulse at a point (flint strike, torch touch). The verb
   *  is "emit heat", never "light X" — chemistry decides what catches. */
  heatBurst(at: Vector3, radius: number, amount: number): void {
    this.bursts.push({ at: at.clone(), radius, amount });
  }

  /** Attach `item` to a carrier (kinematic follow until thrown/dropped). */
  pickUp(carrier: Actor, item: Actor): boolean {
    if (!(item.def.tags & TAG.item) || item.carriedBy !== 0) return false;
    item.carriedBy = carrier.id;
    item.vel.set(0, 0, 0);
    item.asleep = false;
    this.emit({ kind: "pickedUp", id: item.id, def: item.def.name, by: carrier.id });
    return true;
  }

  held(carrier: Actor): Actor | null {
    for (const a of this.actors) {
      if (a.alive && a.carriedBy === carrier.id) return a;
    }
    return null;
  }

  throwHeld(carrier: Actor, dir: Vector3, speed: number): Actor | null {
    const item = this.held(carrier);
    if (!item) return null;
    item.carriedBy = 0;
    item.vel.copy(dir).multiplyScalar(speed);
    item.vel.y += speed * 0.35;
    item.asleep = false;
    this.emit({ kind: "thrown", id: item.id, def: item.def.name, by: carrier.id });
    return item;
  }

  dropHeld(carrier: Actor): Actor | null {
    const item = this.held(carrier);
    if (!item) return null;
    item.carriedBy = 0;
    item.vel.copy(carrier.vel);
    item.asleep = false;
    return item;
  }

  /** Detach an attached child (apple off its tree) with a small scatter. */
  detach(a: Actor, scatter: number): void {
    if (a.attachedTo === 0) return;
    a.attachedTo = 0;
    a.attachLocal = null;
    a.asleep = false;
    a.vel.set(
      this.rng.range(-scatter, scatter),
      this.rng.range(0, scatter * 0.5),
      this.rng.range(-scatter, scatter),
    );
    this.emit({ kind: "detached", id: a.id, def: a.def.name, at: a.pos.clone() });
  }

  attachedChildren(parent: Actor): Actor[] {
    return this.actors.filter((a) => a.alive && a.attachedTo === parent.id);
  }

  inWater(pos: Vector3): boolean {
    const w = this.water;
    if (!w) return false;
    const dx = pos.x - w.x;
    const dz = pos.z - w.z;
    return dx * dx + dz * dz < w.radius * w.radius && pos.y < w.surfaceY + 0.15;
  }

  // -- step pipeline --------------------------------------------------------------

  step(dt: number): void {
    this.tick++;
    stepPhysics(this, dt);
    resolveHits(this, this.hits);
    this.hits = [];
    stepChemistry(this, this.bursts, dt);
    this.bursts = [];
    this.applyLifecycle();
  }

  private applyLifecycle(): void {
    if (this.spawns.length > 0) {
      const batch = this.spawns;
      this.spawns = [];
      for (const req of batch) this.spawn(req);
    }
    // Compact dead actors (stable order for determinism and iteration cost).
    let w = 0;
    for (const a of this.actors) {
      if (a.alive) {
        this.actors[w++] = a;
      } else {
        this.byId.delete(a.id);
      }
    }
    this.actors.length = w;
  }

  // -- queries -----------------------------------------------------------------------

  /** Nearest tag-matching actor within reach of `from` (pickup, prompts). */
  nearest(from: Vector3, reach: number, tags: number, exclude = 0): Actor | null {
    let best: Actor | null = null;
    let bestD = reach * reach;
    for (const a of this.actors) {
      if (!a.alive || a.id === exclude || a.carriedBy !== 0) continue;
      if (!(a.def.tags & tags)) continue;
      const d = a.pos.distanceToSquared(from);
      if (d < bestD) {
        bestD = d;
        best = a;
      }
    }
    return best;
  }

  /** FNV-1a over quantized actor state — the golden-trace probe. */
  stateHash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h ^= v & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 8) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 16) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
      h ^= (v >>> 24) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    };
    const q = (v: number) => mix(Math.round(v * 1024) | 0);
    for (const a of this.actors) {
      mix(a.id);
      q(a.pos.x);
      q(a.pos.y);
      q(a.pos.z);
      q(a.heat);
      q(a.fuelLeft);
      q(a.cookTime);
      q(a.hp);
      mix((a.burning ? 1 : 0) | (a.asleep ? 2 : 0) | (a.alive ? 4 : 0));
    }
    return h >>> 0;
  }
}
