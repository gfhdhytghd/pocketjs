// SPARKWOOD — the game.
//
// Every creature, move, type, item, map, trainer and line of dialogue lives
// here, in TypeScript, and is cooked into one MONPAK. Nothing is derived from
// any existing game's data files: this is the clean-room half of docs/MON.md
// §1, and the whole reason the runtime ships playable from a fresh checkout.
//
// The *mechanics* the numbers feed into are the Gen-1 formulas ported in
// `pocketmon-core`; the numbers themselves, the creatures, the world and the
// words are ours.

import { CTRL, TextTable } from "./text.ts";
import { BLOCK } from "../art/tiles.ts";
import type { Plan } from "../art/creatures.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Type indices — the order also picks each type's colour ramp. */
export const TYPE = {
  normal: 0,
  ember: 1,
  tide: 2,
  leaf: 3,
  spark: 4,
  stone: 5,
  gale: 6,
  shade: 7,
} as const;

export const TYPE_NAMES = ["NORMAL", "EMBER", "TIDE", "LEAF", "SPARK", "STONE", "GALE", "SHADE"];

/** Damage category per type — the Gen-1 physical/special-by-type split. */
const PHYSICAL = 0;
const SPECIAL = 1;
const STATUS = 2;
export const TYPE_CATEGORY = [
  PHYSICAL, // normal
  SPECIAL, // ember
  SPECIAL, // tide
  SPECIAL, // leaf
  SPECIAL, // spark
  PHYSICAL, // stone
  PHYSICAL, // gale
  PHYSICAL, // shade
];

/**
 * The effectiveness table, in x10 fixed point. Only non-neutral rows appear;
 * the core applies each row separately with its own floor.
 *
 * The shape is a deliberate ring — ember beats leaf beats tide beats ember —
 * with stone and gale as a second ring and shade sitting outside both, so a
 * player can reason about a matchup they have never seen.
 */
export const MATCHUPS: Array<[number, number, number]> = [
  [TYPE.ember, TYPE.leaf, 20],
  [TYPE.ember, TYPE.tide, 5],
  [TYPE.ember, TYPE.stone, 5],
  [TYPE.ember, TYPE.ember, 5],
  [TYPE.tide, TYPE.ember, 20],
  [TYPE.tide, TYPE.stone, 20],
  [TYPE.tide, TYPE.tide, 5],
  [TYPE.tide, TYPE.leaf, 5],
  [TYPE.leaf, TYPE.tide, 20],
  [TYPE.leaf, TYPE.stone, 20],
  [TYPE.leaf, TYPE.leaf, 5],
  [TYPE.leaf, TYPE.ember, 5],
  [TYPE.leaf, TYPE.gale, 5],
  [TYPE.spark, TYPE.tide, 20],
  [TYPE.spark, TYPE.gale, 20],
  [TYPE.spark, TYPE.leaf, 5],
  [TYPE.spark, TYPE.stone, 0],
  [TYPE.stone, TYPE.ember, 20],
  [TYPE.stone, TYPE.gale, 20],
  [TYPE.stone, TYPE.leaf, 5],
  [TYPE.stone, TYPE.tide, 5],
  [TYPE.gale, TYPE.leaf, 20],
  [TYPE.gale, TYPE.spark, 5],
  [TYPE.gale, TYPE.stone, 5],
  [TYPE.shade, TYPE.shade, 20],
  [TYPE.shade, TYPE.normal, 0],
  [TYPE.normal, TYPE.shade, 0],
  [TYPE.normal, TYPE.stone, 5],
];

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

/** Effect ids, mirroring `spec::effect`. */
export const FX = {
  none: 0,
  burnChance: 1,
  paralyzeChance: 3,
  sleep: 5,
  confuse: 6,
  flinchChance: 7,
  atkDown: 8,
  defDown: 9,
  spdDown: 10,
  defUp: 14,
  drain: 17,
  recoil: 18,
  twoHit: 20,
  highCrit: 22,
  hyperBeam: 24,
  heal: 28,
  focusEnergy: 38,
  leechSeed: 45,
} as const;

/** Move flag bits, mirroring `spec::MOVE_FLAG_*`. */
export const MF = { highCrit: 1, multiHit: 2, charge: 4, recharge: 8, priority: 16 } as const;

export interface MoveDef {
  id: number;
  name: string;
  type: number;
  power: number;
  accuracy: number;
  pp: number;
  category?: number;
  effect?: number;
  chance?: number;
  flags?: number;
  desc: string;
}

export const MOVES: MoveDef[] = [
  { id: 1, name: "TACKLE", type: TYPE.normal, power: 40, accuracy: 100, pp: 35, desc: "A plain body check." },
  { id: 2, name: "SCRATCH", type: TYPE.normal, power: 40, accuracy: 100, pp: 35, desc: "Rakes with claws." },
  { id: 3, name: "GROWL", type: TYPE.normal, power: 0, accuracy: 100, pp: 40, category: STATUS, effect: FX.atkDown, desc: "Lowers ATTACK." },
  { id: 4, name: "HARDEN", type: TYPE.normal, power: 0, accuracy: 100, pp: 30, category: STATUS, effect: FX.defUp, desc: "Raises DEFENSE." },
  { id: 5, name: "QUICK JAB", type: TYPE.normal, power: 40, accuracy: 100, pp: 30, flags: MF.priority, desc: "Always strikes first." },
  { id: 6, name: "BITE", type: TYPE.shade, power: 60, accuracy: 100, pp: 25, effect: FX.flinchChance, chance: 30, desc: "May make the foe flinch." },
  { id: 7, name: "EMBER", type: TYPE.ember, power: 40, accuracy: 100, pp: 25, effect: FX.burnChance, chance: 10, desc: "May burn the foe." },
  { id: 8, name: "FLAME", type: TYPE.ember, power: 90, accuracy: 85, pp: 15, effect: FX.burnChance, chance: 10, desc: "A searing blast." },
  { id: 9, name: "WATERJET", type: TYPE.tide, power: 40, accuracy: 100, pp: 25, desc: "A jet of cold water." },
  { id: 10, name: "TORRENT", type: TYPE.tide, power: 90, accuracy: 85, pp: 15, desc: "A crashing wave." },
  { id: 11, name: "VINE WHIP", type: TYPE.leaf, power: 45, accuracy: 100, pp: 25, desc: "Lashes with a vine." },
  { id: 12, name: "LEAF BLADE", type: TYPE.leaf, power: 90, accuracy: 90, pp: 15, flags: MF.highCrit, desc: "Critical hits often." },
  { id: 13, name: "SPARK", type: TYPE.spark, power: 40, accuracy: 100, pp: 30, effect: FX.paralyzeChance, chance: 10, desc: "May paralyze." },
  { id: 14, name: "THUNDERCLAP", type: TYPE.spark, power: 90, accuracy: 85, pp: 15, effect: FX.paralyzeChance, chance: 10, desc: "A deafening bolt." },
  { id: 15, name: "ROCK TOSS", type: TYPE.stone, power: 50, accuracy: 90, pp: 20, desc: "Hurls a loose rock." },
  { id: 16, name: "BOULDER", type: TYPE.stone, power: 85, accuracy: 80, pp: 10, desc: "Drops a huge stone." },
  { id: 17, name: "GUST", type: TYPE.gale, power: 40, accuracy: 100, pp: 35, desc: "Whips up the air." },
  { id: 18, name: "CYCLONE", type: TYPE.gale, power: 85, accuracy: 85, pp: 15, desc: "A spiralling wind." },
  { id: 19, name: "DUSK TOUCH", type: TYPE.shade, power: 45, accuracy: 100, pp: 25, desc: "A chilling brush." },
  { id: 20, name: "LULLABY", type: TYPE.normal, power: 0, accuracy: 55, pp: 15, category: STATUS, effect: FX.sleep, desc: "Puts the foe to sleep." },
  { id: 21, name: "RECOVER", type: TYPE.normal, power: 0, accuracy: 100, pp: 10, category: STATUS, effect: FX.heal, desc: "Restores half HP." },
  { id: 22, name: "DRAIN SEED", type: TYPE.leaf, power: 0, accuracy: 90, pp: 10, category: STATUS, effect: FX.leechSeed, desc: "Saps HP each turn." },
  { id: 23, name: "FOCUS", type: TYPE.normal, power: 0, accuracy: 100, pp: 30, category: STATUS, effect: FX.focusEnergy, desc: "Gets pumped up." },
  { id: 24, name: "HAZE RAY", type: TYPE.shade, power: 0, accuracy: 100, pp: 10, category: STATUS, effect: FX.confuse, desc: "Confuses the foe." },
  { id: 25, name: "SIPHON", type: TYPE.leaf, power: 40, accuracy: 100, pp: 15, effect: FX.drain, desc: "Drains half the damage." },
  { id: 26, name: "DOUBLE KICK", type: TYPE.normal, power: 30, accuracy: 100, pp: 20, effect: FX.twoHit, desc: "Strikes twice." },
  { id: 27, name: "SAND SPRAY", type: TYPE.stone, power: 0, accuracy: 100, pp: 15, category: STATUS, effect: FX.spdDown, desc: "Lowers SPEED." },
];

// ---------------------------------------------------------------------------
// Species
// ---------------------------------------------------------------------------

export const GROWTH = {
  mediumFast: 0,
  slightlyFast: 1,
  slightlySlow: 2,
  mediumSlow: 3,
  fast: 4,
  slow: 5,
} as const;

export interface SpeciesDef {
  id: number;
  name: string;
  type1: number;
  type2?: number;
  hp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
  catchRate: number;
  baseExp: number;
  growth: number;
  plan: Plan;
  size: number;
  /** [level, moveId] pairs, in learn order. */
  learnset: Array<[number, number]>;
  evolveLevel?: number;
  evolveInto?: number;
  dex: string;
}

export const SPECIES: SpeciesDef[] = [
  {
    id: 1, name: "EMBERKIT", type1: TYPE.ember, hp: 39, atk: 52, def: 43, spd: 65, spc: 60,
    catchRate: 45, baseExp: 62, growth: GROWTH.mediumSlow, plan: "pup", size: 0.3,
    learnset: [[1, 2], [1, 3], [7, 7], [13, 5], [20, 6], [28, 8]],
    evolveLevel: 16, evolveInto: 2,
    dex: "A stray ember that learned\nto follow footprints home.",
  },
  {
    id: 2, name: "CINDERPUP", type1: TYPE.ember, hp: 58, atk: 64, def: 58, spd: 80, spc: 65,
    catchRate: 45, baseExp: 142, growth: GROWTH.mediumSlow, plan: "pup", size: 0.62,
    learnset: [[1, 2], [1, 7], [15, 5], [22, 6], [30, 8], [38, 23]],
    evolveLevel: 32, evolveInto: 3,
    dex: "Its coat smoulders when it\nis pleased. Mind the rugs.",
  },
  {
    id: 3, name: "BLAZEHOUND", type1: TYPE.ember, hp: 78, atk: 84, def: 78, spd: 100, spc: 85,
    catchRate: 45, baseExp: 240, growth: GROWTH.mediumSlow, plan: "pup", size: 0.95,
    learnset: [[1, 8], [1, 6], [34, 5], [42, 23], [50, 26]],
    dex: "Runs the ridge line at dusk\nand never once looks back.",
  },
  {
    id: 4, name: "DRIPFIN", type1: TYPE.tide, hp: 44, atk: 48, def: 65, spd: 43, spc: 50,
    catchRate: 45, baseExp: 63, growth: GROWTH.mediumSlow, plan: "fish", size: 0.3,
    learnset: [[1, 1], [1, 4], [7, 9], [16, 27], [22, 24], [30, 10]],
    evolveLevel: 16, evolveInto: 5,
    dex: "Keeps a bead of rain in its\nfin for a dry afternoon.",
  },
  {
    id: 5, name: "TIDEFIN", type1: TYPE.tide, hp: 59, atk: 63, def: 80, spd: 58, spc: 65,
    catchRate: 45, baseExp: 142, growth: GROWTH.mediumSlow, plan: "fish", size: 0.62,
    learnset: [[1, 1], [1, 9], [18, 27], [25, 24], [33, 10], [40, 21]],
    evolveLevel: 32, evolveInto: 6,
    dex: "Swims upstream out of habit,\neven across a wet floor.",
  },
  {
    id: 6, name: "MAELSTROM", type1: TYPE.tide, hp: 79, atk: 83, def: 100, spd: 78, spc: 85,
    catchRate: 45, baseExp: 240, growth: GROWTH.mediumSlow, plan: "fish", size: 0.95,
    learnset: [[1, 10], [1, 4], [36, 21], [44, 24], [52, 18]],
    dex: "The lake turns over once a\nyear. This is why.",
  },
  {
    id: 7, name: "SEEDLING", type1: TYPE.leaf, hp: 45, atk: 49, def: 49, spd: 45, spc: 65,
    catchRate: 45, baseExp: 64, growth: GROWTH.mediumSlow, plan: "sprout", size: 0.3,
    learnset: [[1, 1], [1, 3], [7, 11], [13, 22], [20, 25], [27, 12]],
    evolveLevel: 16, evolveInto: 8,
    dex: "Sleeps in the sun and calls\nit hard work. It is.",
  },
  {
    id: 8, name: "BRAMBLE", type1: TYPE.leaf, hp: 60, atk: 62, def: 63, spd: 60, spc: 80,
    catchRate: 45, baseExp: 142, growth: GROWTH.mediumSlow, plan: "sprout", size: 0.62,
    learnset: [[1, 11], [1, 22], [15, 25], [24, 12], [32, 4], [40, 21]],
    evolveLevel: 32, evolveInto: 9,
    dex: "Grows a thorn for every\nfight it did not start.",
  },
  {
    id: 9, name: "THORNWOOD", type1: TYPE.leaf, hp: 80, atk: 82, def: 83, spd: 80, spc: 100,
    catchRate: 45, baseExp: 240, growth: GROWTH.mediumSlow, plan: "sprout", size: 0.95,
    learnset: [[1, 12], [1, 25], [38, 21], [46, 22], [54, 26]],
    dex: "Old enough that the path\nbends politely around it.",
  },
  {
    id: 10, name: "PIPSQUEAK", type1: TYPE.normal, hp: 40, atk: 45, def: 40, spd: 56, spc: 35,
    catchRate: 255, baseExp: 55, growth: GROWTH.mediumFast, plan: "pup", size: 0.24,
    learnset: [[1, 1], [1, 3], [6, 5], [12, 26], [18, 6]],
    dex: "Everywhere. Cheerful about\nit. Impossible to dislike.",
  },
  {
    id: 11, name: "ZAPMOTE", type1: TYPE.spark, hp: 35, atk: 55, def: 40, spd: 90, spc: 50,
    catchRate: 190, baseExp: 82, growth: GROWTH.mediumFast, plan: "mote", size: 0.4,
    learnset: [[1, 13], [1, 5], [10, 3], [17, 23], [26, 14]],
    dex: "Static that decided it had\nsomewhere to be.",
  },
  {
    id: 12, name: "PEBBLET", type1: TYPE.stone, hp: 50, atk: 60, def: 80, spd: 30, spc: 30,
    catchRate: 190, baseExp: 73, growth: GROWTH.mediumFast, plan: "rock", size: 0.42,
    learnset: [[1, 15], [1, 4], [11, 27], [19, 16], [28, 26]],
    dex: "Sits very still and hopes\nyou will step around it.",
  },
  {
    id: 13, name: "GUSTLING", type1: TYPE.gale, hp: 40, atk: 45, def: 40, spd: 75, spc: 40,
    catchRate: 220, baseExp: 58, growth: GROWTH.mediumFast, plan: "bird", size: 0.4,
    learnset: [[1, 17], [1, 2], [9, 5], [16, 3], [25, 18]],
    dex: "Rides the draught over the\nvillage roofs all morning.",
  },
  {
    id: 14, name: "DUSKMOTH", type1: TYPE.shade, hp: 45, atk: 40, def: 45, spd: 60, spc: 70,
    catchRate: 150, baseExp: 88, growth: GROWTH.mediumFast, plan: "moth", size: 0.46,
    learnset: [[1, 19], [1, 20], [12, 24], [21, 6], [30, 21]],
    dex: "Wings dusted with the last\nlight of the day.",
  },
];

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const ITEM_KIND = {
  none: 0, ball: 1, heal: 2, status: 3, revive: 4, boost: 5, key: 6, escape: 7, repel: 8,
} as const;

export interface ItemDef {
  id: number;
  name: string;
  kind: number;
  param: number;
  price: number;
  desc: string;
}

export const ITEMS: ItemDef[] = [
  { id: 1, name: "SPARK BALL", kind: ITEM_KIND.ball, param: 0, price: 200, desc: "Catches a wild one." },
  { id: 2, name: "GREAT BALL", kind: ITEM_KIND.ball, param: 1, price: 600, desc: "A better ball." },
  { id: 3, name: "ULTRA BALL", kind: ITEM_KIND.ball, param: 2, price: 1200, desc: "A very good ball." },
  { id: 4, name: "POTION", kind: ITEM_KIND.heal, param: 2, price: 300, desc: "Restores 20 HP." },
  { id: 5, name: "TONIC", kind: ITEM_KIND.heal, param: 5, price: 700, desc: "Restores 50 HP." },
  { id: 6, name: "ANTIDOTE", kind: ITEM_KIND.status, param: 0, price: 100, desc: "Cures any condition." },
  { id: 7, name: "ROPE", kind: ITEM_KIND.escape, param: 0, price: 550, desc: "Flees a wild battle." },
  { id: 8, name: "GRIT", kind: ITEM_KIND.boost, param: 1, price: 500, desc: "Raises ATTACK in battle." },
];

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

/** Map ids. */
export const MAP = { home: 1, village: 2, lab: 3, route: 4, glade: 5 } as const;

/** Layout characters -> block ids. */
const B: Record<string, number> = {
  ".": BLOCK.grass,
  G: BLOCK.tall,
  P: BLOCK.path,
  T: BLOCK.tree,
  "~": BLOCK.water,
  H: BLOCK.house,
  L: BLOCK.lab,
  S: BLOCK.sign,
  F: BLOCK.flower,
  "=": BLOCK.fence,
  "#": BLOCK.wall,
  f: BLOCK.floor,
  r: BLOCK.rug,
  t: BLOCK.table,
  c: BLOCK.counter,
  D: BLOCK.doorway,
  " ": BLOCK.void,
};

export interface WarpDef { x: number; y: number; destMap: number; destWarp: number; dir: number }
export interface SignDef { x: number; y: number; text: string }
export interface ActorPlace {
  x: number;
  y: number;
  dir: number;
  behavior: number;
  sprite: number;
  text?: string;
  script?: string;
  trainer?: number;
  flagGate?: number;
}
export interface MapSpec {
  id: number;
  name: string;
  rows: string[];
  tileset?: number;
  border: number;
  indoor?: boolean;
  music?: number;
  encounterRate?: number;
  slots?: Array<[number, number]>; // [speciesId, level]
  warps?: WarpDef[];
  signs?: SignDef[];
  actors?: ActorPlace[];
  /** [north, south, west, east] map ids, -1 for none. */
  conn?: [number, number, number, number];
  connOff?: [number, number, number, number];
}

/** Sprite ids into the actor atlas (see `art/actors.ts` CAST order). */
export const SPRITE = { player: 0, mom: 1, professor: 2, rival: 3, hiker: 4, villager: 5 } as const;
const DIR = { down: 0, up: 1, left: 2, right: 3 } as const;
const BEHAVIOR = { still: 0, wander: 1, paceH: 2, paceV: 3, spin: 4 } as const;

/** Event flags the scripts use. */
export const FLAG = {
  gotStarter: 1,
  beatRival: 2,
  metMom: 3,
  hikerBeaten: 10,
  villagerBeaten: 11,
} as const;

export const MAPS: MapSpec[] = [
  {
    id: MAP.home,
    name: "HOME",
    indoor: true,
    border: BLOCK.void,
    rows: [
      "#####",
      "#rtf#",
      "#fff#",
      "#ffD#",
    ],
    // The doorway block sits at block (3,3); its door cell is (3*2+1, 3*2+1).
    warps: [{ x: 7, y: 7, destMap: MAP.village, destWarp: 0, dir: DIR.down }],
    actors: [
      {
        x: 2, y: 3, dir: DIR.down, behavior: BEHAVIOR.still, sprite: SPRITE.mom,
        script: "mom",
      },
    ],
  },
  {
    id: MAP.village,
    name: "SPARKWOOD",
    border: BLOCK.tree,
    music: 1,
    rows: [
      "TTTTPTTTTT",
      "T...P....T",
      "T.H..L...T",
      "T.PP.P...T",
      "T.PPPPP..T",
      "T...P....T",
      "T.S.P..F.T",
      "T......F.T",
      "T.=====..T",
      "TTTTTTTTTT",
    ],
    // Warp 0 is the arrival pad outside the player's house.
    warps: [
      { x: 5, y: 5, destMap: MAP.home, destWarp: 0, dir: DIR.up },
      { x: 11, y: 5, destMap: MAP.lab, destWarp: 0, dir: DIR.up },
    ],
    signs: [
      {
        x: 4, y: 13,
        text: "SPARKWOOD VILLAGE" + CTRL.line + "Where the road starts.",
      },
    ],
    actors: [
      {
        x: 14, y: 15, dir: DIR.down, behavior: BEHAVIOR.wander, sprite: SPRITE.villager,
        text: "The tall grass north of\nhere is full of critters." + CTRL.page +
          "Do not go in without a\npartner of your own.",
      },
    ],
    conn: [MAP.route, -1, -1, -1],
    connOff: [0, 0, 0, 0],
  },
  {
    id: MAP.lab,
    name: "LAB",
    indoor: true,
    border: BLOCK.void,
    rows: [
      "######",
      "#cttc#",
      "#ffff#",
      "#ffDf#",
    ],
    warps: [{ x: 7, y: 7, destMap: MAP.village, destWarp: 1, dir: DIR.down }],
    actors: [
      {
        x: 5, y: 4, dir: DIR.down, behavior: BEHAVIOR.still, sprite: SPRITE.professor,
        script: "professor",
      },
      {
        x: 3, y: 6, dir: DIR.right, behavior: BEHAVIOR.still, sprite: SPRITE.rival,
        script: "rival", flagGate: FLAG.beatRival,
      },
    ],
  },
  {
    id: MAP.route,
    name: "ROUTE ONE",
    border: BLOCK.tree,
    music: 2,
    encounterRate: 30,
    slots: [
      [10, 3], [10, 3], [13, 3], [10, 4], [13, 4],
      [11, 4], [7, 4], [1, 4], [4, 4], [14, 5],
    ],
    rows: [
      "TTTTPTTTTT",
      "T..GGG...T",
      "T.GGGGG..T",
      "T..GGG..=T",
      "T...P...=T",
      "T.GG.P.GGT",
      "T.GG.P.GGT",
      "T.S..P...T",
      "T..GGP...T",
      "T..GGP...T",
      "T....P...T",
      "TTTTPTTTTT",
    ],
    signs: [
      {
        x: 4, y: 15,
        text: "ROUTE ONE" + CTRL.line + "SPARKWOOD to the south." + CTRL.page +
          "Tall grass hides tall\ntempers. Step carefully.",
      },
    ],
    actors: [
      {
        x: 7, y: 9, dir: DIR.left, behavior: BEHAVIOR.spin, sprite: SPRITE.hiker,
        trainer: 2, flagGate: FLAG.hikerBeaten,
      },
      {
        x: 13, y: 17, dir: DIR.up, behavior: BEHAVIOR.still, sprite: SPRITE.villager,
        trainer: 3, flagGate: FLAG.villagerBeaten,
      },
    ],
    conn: [MAP.glade, MAP.village, -1, -1],
    connOff: [-1, 0, 0, 0],
  },
  {
    id: MAP.glade,
    name: "STILL GLADE",
    border: BLOCK.tree,
    music: 2,
    encounterRate: 22,
    slots: [
      [14, 6], [14, 6], [11, 6], [13, 7], [14, 7],
      [11, 7], [12, 7], [10, 8], [14, 8], [14, 9],
    ],
    rows: [
      "TTTPTTTT",
      "T..~~..T",
      "T.~~~~.T",
      "T..~~..T",
      "T...P..T",
      "TF..P.FT",
      "T...P..T",
      "TTTPTTTT",
    ],
    conn: [-1, MAP.route, -1, -1],
    connOff: [0, 1, 0, 0],
  },
];

// ---------------------------------------------------------------------------
// Trainers
// ---------------------------------------------------------------------------

export interface TrainerDef {
  id: number;
  name: string;
  aiClass: number;
  reward: number;
  party: Array<{ species: number; level: number; moves: number[] }>;
  /** Shown before the fight; the actor's talk line. */
  intro: string;
  /** Shown after losing. */
  defeat: string;
  /** Set once beaten. */
  flag: number;
}

export const TRAINERS: TrainerDef[] = [
  {
    id: 1, name: "RIVAL", aiClass: 1, reward: 12,
    party: [{ species: 10, level: 5, moves: [1, 3, 0, 0] }],
    intro: "Took you long enough!\nLet me see what you got.",
    defeat: "Fine. FINE. I will be\nready next time.",
    flag: FLAG.beatRival,
  },
  {
    id: 2, name: "HIKER RAB", aiClass: 2, reward: 20,
    party: [
      { species: 12, level: 7, moves: [15, 4, 0, 0] },
      { species: 12, level: 7, moves: [15, 27, 0, 0] },
    ],
    intro: "Rocks all the way up.\nRocks all the way down!",
    defeat: "Ha! Solid work.",
    flag: FLAG.hikerBeaten,
  },
  {
    id: 3, name: "WALKER INE", aiClass: 3, reward: 24,
    party: [{ species: 13, level: 9, moves: [17, 2, 5, 0] }],
    intro: "The wind said you were\ncoming up the road.",
    defeat: "It did not say you would\nwin, though.",
    flag: FLAG.villagerBeaten,
  },
];

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------
//
// Rows are `[verb, ...args]`, matching `spec::verb`. A string argument is
// interned into the text table by the cooker and replaced with its key. A
// `["label", name]` row is a jump target; jumps name the label.

export const VERB = {
  end: 0, showText: 1, ask: 2, jump: 3, jumpIfTrue: 4, jumpIfFalse: 5,
  setFlag: 6, clearFlag: 7, checkFlag: 8, checkItem: 9, giveItem: 10, takeItem: 11,
  startBattle: 12, warp: 13, wait: 14, movePlayer: 15, moveNpc: 16, faceNpc: 17,
  facePlayer: 18, showObject: 19, hideObject: 20, playSound: 21, playCry: 22,
  playMusic: 23, stopMusic: 24, healParty: 25, givemon: 26, giveMoney: 27,
  checkBattleResult: 28, trainerBattle: 29, openMart: 30, replaceBlock: 31,
  fade: 32, panCamera: 33, emote: 34, label: 35, hook: 36, setField: 37,
  choice: 38, waitFlag: 39, textOpts: 40,
} as const;

/** One script row. Strings are interned; `{ label: "x" }` targets a label. */
export type Row = [number, ...Array<number | string | { label: string }>];

export interface ScriptDef {
  /** The key an actor's `script` field refers to. */
  name: string;
  rows: Row[];
}

export const SCRIPTS: ScriptDef[] = [
  {
    name: "mom",
    rows: [
      [VERB.facePlayer, 1],
      [VERB.checkFlag, FLAG.gotStarter],
      [VERB.jumpIfTrue, { label: "after" }],
      [VERB.showText, "Off to see the PROFESSOR?" + CTRL.page +
        "Do not come home without\na partner!"],
      [VERB.setFlag, FLAG.metMom],
      [VERB.end],
      [VERB.label, "after"],
      [VERB.showText, "Look at you two." + CTRL.page + "Go on. The road is long\nand the light is good."],
      [VERB.end],
    ],
  },
  {
    name: "professor",
    rows: [
      [VERB.facePlayer, 1],
      [VERB.checkFlag, FLAG.gotStarter],
      [VERB.jumpIfTrue, { label: "already" }],
      [VERB.showText, "Ah, there you are." + CTRL.page +
        "Three of them hatched this\nweek. One should go with you."],

      [VERB.label, "offer_ember"],
      [VERB.ask, "EMBERKIT, then?"],
      [VERB.jumpIfFalse, { label: "offer_tide" }],
      [VERB.givemon, 1, 5],
      [VERB.playCry, 1],
      [VERB.showText, "EMBERKIT is yours."],
      [VERB.jump, { label: "given" }],

      [VERB.label, "offer_tide"],
      [VERB.ask, "DRIPFIN, perhaps?"],
      [VERB.jumpIfFalse, { label: "offer_leaf" }],
      [VERB.givemon, 4, 5],
      [VERB.playCry, 4],
      [VERB.showText, "DRIPFIN is yours."],
      [VERB.jump, { label: "given" }],

      [VERB.label, "offer_leaf"],
      [VERB.ask, "SEEDLING it is?"],
      [VERB.jumpIfFalse, { label: "offer_ember" }],
      [VERB.givemon, 7, 5],
      [VERB.playCry, 7],
      [VERB.showText, "SEEDLING is yours."],

      [VERB.label, "given"],
      [VERB.setFlag, FLAG.gotStarter],
      [VERB.giveItem, 1, 5],
      [VERB.giveItem, 4, 2],
      [VERB.showText, "Take these too. Five BALLS\nand a pair of POTIONS."],
      [VERB.end],

      [VERB.label, "already"],
      [VERB.showText, "Route One runs north out\nof the village." + CTRL.page +
        "Everything you need is\nalready walking beside you."],
      [VERB.end],
    ],
  },
  {
    name: "rival",
    rows: [
      [VERB.facePlayer, 2],
      [VERB.checkFlag, FLAG.gotStarter],
      [VERB.jumpIfFalse, { label: "wait" }],
      [VERB.checkFlag, FLAG.beatRival],
      [VERB.jumpIfTrue, { label: "done" }],
      [VERB.showText, "Took you long enough!" + CTRL.line + "Let me see what you got."],
      [VERB.trainerBattle, 1],
      [VERB.checkBattleResult],
      [VERB.jumpIfFalse, { label: "lost" }],
      [VERB.setFlag, FLAG.beatRival],
      [VERB.showText, "Fine. FINE. I will be\nready next time."],
      [VERB.end],
      [VERB.label, "lost"],
      [VERB.showText, "Better luck when you have\nput in the hours."],
      [VERB.end],
      [VERB.label, "wait"],
      [VERB.showText, "Pick one already. I am not\ngetting any younger."],
      [VERB.end],
      [VERB.label, "done"],
      [VERB.showText, "Go north. I will catch up."],
      [VERB.end],
    ],
  },
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Everything the cooker needs, with every string already interned. */
export interface BuiltContent {
  text: TextTable;
  typeNames: number[];
  speciesNameKeys: number[];
  speciesDexKeys: number[];
  moveNameKeys: number[];
  moveDescKeys: number[];
  itemNameKeys: number[];
  itemDescKeys: number[];
  mapNameKeys: number[];
  trainerNameKeys: number[];
  /** script name -> the text key it is filed under (an actor's `text_key`). */
  scriptKeys: Map<string, number>;
}

/**
 * Intern every string the game uses and hand back the keys.
 *
 * Scripts are filed under a synthetic key derived from their name, and an
 * actor that names a script gets that same key as its `text_key` — which is
 * how the core's talk dispatch finds "a script keyed by the actor's text id"
 * without a second lookup table.
 */
export function buildText(): BuiltContent {
  const text = new TextTable();
  const typeNames = TYPE_NAMES.map((n) => text.key(n));
  const speciesNameKeys = SPECIES.map((s) => text.key(s.name));
  const speciesDexKeys = SPECIES.map((s) => text.key(s.dex));
  const moveNameKeys = MOVES.map((m) => text.key(m.name));
  const moveDescKeys = MOVES.map((m) => text.key(m.desc));
  const itemNameKeys = ITEMS.map((i) => text.key(i.name));
  const itemDescKeys = ITEMS.map((i) => text.key(i.desc));
  const mapNameKeys = MAPS.map((m) => text.key(m.name));
  const trainerNameKeys = TRAINERS.map((t) => text.key(t.name));
  const scriptKeys = new Map<string, number>();
  for (const s of SCRIPTS) scriptKeys.set(s.name, text.key(`$script:${s.name}`));
  return {
    text,
    typeNames,
    speciesNameKeys,
    speciesDexKeys,
    moveNameKeys,
    moveDescKeys,
    itemNameKeys,
    itemDescKeys,
    mapNameKeys,
    trainerNameKeys,
    scriptKeys,
  };
}

/** Parse a map's ASCII rows into a flat block array. */
export function blocksOf(spec: MapSpec): { w: number; h: number; blocks: number[] } {
  const h = spec.rows.length;
  const w = Math.max(...spec.rows.map((r) => r.length));
  const blocks: number[] = [];
  for (let y = 0; y < h; y++) {
    const row = spec.rows[y] ?? "";
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? " ";
      const id = B[ch];
      if (id === undefined) throw new Error(`map ${spec.name}: unknown block char '${ch}'`);
      blocks.push(id);
    }
  }
  return { w, h, blocks };
}
