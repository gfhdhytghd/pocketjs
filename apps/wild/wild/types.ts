// wild/types.ts — the closed vocabulary of the wild kernel.
//
// The kernel is a deterministic playable-world simulation distilled from the
// architecture Breath of the Wild's engine research documents (zeldaret/botw,
// the GDC 2017 chemistry-engine talk), rebuilt from first principles on the
// PocketJS frame contract:
//
//   - Everything in the world is an ACTOR: one data definition (ActorDef,
//     BotW's actor param files in miniature) plus one runtime state record.
//     Behavior is composed from def FIELDS and TAGS, never from subclasses.
//   - CHEMISTRY is a rule engine over state, separate from physics
//     (motion). Three rules only: elements change materials, elements
//     change elements, materials never change materials directly — that
//     last interaction is physics' job.
//   - Damage events carry a physical KIND plus an optional ELEMENT plus a
//     tag-targeted bonus (BotW's SpHitTag: an axe is not "the tree tool",
//     it is a chop weapon with a ×N ratio against tree-tagged actors).
//   - Destruction and transformation are ACTOR SUBSTITUTION: a standing
//     tree dies into a felled trunk, a trunk chops into firewood, an apple
//     near heat becomes a baked apple, a burned-out anything becomes what
//     its def says (BotW's IsBurnOutBorn/BurnOutBornName).
//   - The kernel emits typed EVENTS (the SLink/ELink boundary in
//     miniature); presentation subscribes and never feeds back.
//
// No system in this directory ever names a specific actor pair. State lives
// on actors; rules live here; content lives in scene/defs.ts as data.

import type { Vector3 } from "../lib/math/vector3.ts";

/** Tag bits — what tag-matching systems (SpHit, pickup queries) see.
 *  Deliberately tiny; a tag earns its bit only when a rule matches on it. */
export const TAG = {
  /** Chop-bonus target class (standing trees, felled trunks). */
  tree: 1 << 0,
  /** Can be picked up and carried/thrown. */
  item: 1 << 1,
  /** The player avatar (excluded from pickup/heat-target queries). */
  player: 1 << 2,
} as const;

/** Physical damage classes. Fire rides separately as `element`. */
export type DamageKind = "chop" | "blunt";

/** Elements are carriers of state change (chemistry), not damage numbers. */
export type Element = "fire" | "water" | "wind";

/** A queued hit — the only way anything hurts anything. */
export interface Hit {
  target: number;
  kind: DamageKind;
  power: number;
  /** World-space push applied to dynamic targets (already scaled). */
  impulse: Vector3 | null;
  /** Bonus multiplier when (target.tags & spTag) != 0 — BotW SpHitRatio. */
  spTag: number;
  spRatio: number;
  /** Optional element carried by the blow (a torch strike carries fire). */
  element: Element | null;
}

/** Kernel → presentation facts, drained once per step by the host app. */
export type WorldEvent =
  | { kind: "ignited"; id: number; def: string; at: Vector3 }
  | { kind: "extinguished"; id: number; def: string; at: Vector3 }
  | { kind: "burnedOut"; id: number; def: string; at: Vector3; born: string | null }
  | { kind: "cooked"; id: number; def: string; at: Vector3; into: string }
  | { kind: "hit"; id: number; def: string; at: Vector3; damage: DamageKind }
  | { kind: "felled"; id: number; def: string; at: Vector3; dir: Vector3; born: string | null }
  | { kind: "broke"; id: number; def: string; at: Vector3 }
  | { kind: "detached"; id: number; def: string; at: Vector3 }
  | { kind: "pickedUp"; id: number; def: string; by: number }
  | { kind: "thrown"; id: number; def: string; by: number }
  | { kind: "splash"; id: number; def: string; at: Vector3 };
