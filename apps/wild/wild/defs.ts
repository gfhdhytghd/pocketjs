// wild/defs.ts — ActorDef: one data record per KIND of thing.
//
// The BotW mapping, field by field:
//   body      → .bphysics        (rigid body / static collider shape)
//   fuel      → .bchemical + General.IsBurnOutBorn/BurnOutBornName
//   cook      → the heat-substitution rule (Item_Fruit_A → Item_Roast_03)
//   life      → General.Life + .bdmgparam (per-kind reaction multipliers)
//   spHit     → Attack.SpHitTag/SpHitRatio (on weapon-shaped defs)
//   attachTo  → child-actor attachment (apples on the tree)
//   tags      → .bxml Tag%d entries
//
// A def never contains code. Everything an actor DOES falls out of which
// fields its def fills in, evaluated by the kernel's systems.

import type { DamageKind } from "./types.ts";

export interface BodyDef {
  /** `dynamic` integrates and collides; `static` only pushes others away;
   *  `none` is a pure marker in space (grass, decals). */
  kind: "dynamic" | "static" | "none";
  /** Collision sphere radius (static trunks collide as vertical columns). */
  radius: number;
  mass: number;
  /** 0..1 velocity kept on ground contact per second (1 = ice). */
  friction: number;
  /** Bounce: fraction of vertical speed kept on landing. */
  restitution: number;
  /** How strongly slopes accelerate it while grounded (apples ≈ 1, logs ≈
   *  0.15, crates 0). The BotW "apples roll downhill" number. */
  roll: number;
}

export interface FuelDef {
  /** Accumulated heat needed to ignite. */
  ignition: number;
  /** Burn duration once lit, seconds. */
  burnSeconds: number;
  /** Heat radiated per second while burning. */
  heatOutput: number;
  /** Heat reach while burning, meters. */
  heatRadius: number;
  /** Def spawned in place when the fuel runs out (null = just vanish). */
  burnOutBorn: string | null;
}

export interface CookDef {
  /** Seconds of sustained heat that transform it (never ignites). */
  heatSeconds: number;
  /** The def it substitutes into. */
  into: string;
}

export interface LifeDef {
  hp: number;
  /** Per-damage-kind multipliers; unlisted kinds take ×1. */
  vulner?: Partial<Record<DamageKind, number>>;
  /** Substitution on death: defs spawned at the corpse (scattered). */
  breakInto?: { def: string; count: number }[];
}

export interface ActorDef {
  name: string;
  /** TAG bits. */
  tags: number;
  body: BodyDef;
  fuel?: FuelDef;
  cook?: CookDef;
  life?: LifeDef;
  /** Weapon-shaped defs: bonus vs tag-matching targets (axe ×N vs tree). */
  spHit?: { tag: number; ratio: number };
  /** Visual + shadow footprint hint for presentation (not used by rules). */
  visual: string;
}

/** The def registry — content (scene/defs.ts) fills it, systems read it. */
export class DefTable {
  private byName = new Map<string, ActorDef>();

  add(def: ActorDef): ActorDef {
    if (this.byName.has(def.name)) throw new Error(`duplicate def ${def.name}`);
    this.byName.set(def.name, def);
    return def;
  }

  get(name: string): ActorDef {
    const d = this.byName.get(name);
    if (!d) throw new Error(`unknown def ${name}`);
    return d;
  }
}
