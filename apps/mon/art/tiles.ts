// Terrain: the 8x8 tiles, the 4x4-tile blocks maps are laid out in, and the
// tile -> behaviour table the bottom-left-tile collision rule reads.
//
// Tiles are written as eight 8-character rows so the art is editable in place.
// The character map below is the only place palette indices appear.

import { PAL } from "./palette.ts";

/** Painting characters -> palette indices. */
const CH: Record<string, number> = {
  " ": PAL.transparent,
  g: PAL.grassMid,
  G: PAL.grassDark,
  h: PAL.grassLight,
  p: PAL.pathMid,
  P: PAL.pathDark,
  q: PAL.pathLight,
  t: PAL.treeMid,
  T: PAL.treeDark,
  u: PAL.treeLight,
  w: PAL.waterMid,
  W: PAL.waterDark,
  v: PAL.waterLight,
  b: PAL.wallMid,
  B: PAL.wallDark,
  c: PAL.wallLight,
  f: PAL.floorMid,
  F: PAL.floorDark,
  e: PAL.floorLight,
  r: PAL.roofMid,
  R: PAL.roofDark,
  s: PAL.roofLight,
  d: PAL.doorDark,
  o: PAL.wood,
  l: PAL.ledge,
  y: PAL.sand,
  k: PAL.flower,
  x: PAL.glass,
  "#": PAL.ink,
  ".": PAL.paper,
  "-": PAL.shade,
  "*": PAL.hilite,
};

/** Tile ids. The behaviour table below is keyed by these. */
export const TILE = {
  void: 0,
  grass: 1,
  tallGrass: 2,
  path: 3,
  tree: 4,
  water: 5,
  wall: 6,
  floor: 7,
  door: 8,
  sign: 9,
  ledge: 10,
  counter: 11,
  roof: 12,
  window: 13,
  flower: 14,
  stairs: 15,
  sand: 16,
  fence: 17,
  table: 18,
  rug: 19,
} as const;

/** Tile art, indexed by tile id. */
export const TILE_ART: Record<number, string[]> = {
  [TILE.void]: ["########", "########", "########", "########", "########", "########", "########", "########"],
  [TILE.grass]: ["gggggggg", "gghggggg", "gggggggg", "ggggGggg", "gggggggg", "ghgggggg", "gggggggg", "ggggggGg"],
  [TILE.tallGrass]: ["gggggggg", "gGgggGgg", "hGghhGgh", "GGgGGGgG", "gGGggGGg", "hGghhGgh", "GGgGGGgG", "gGgggGgg"],
  [TILE.path]: ["pppppppp", "ppppqppp", "pppppppp", "ppPppppp", "pppppqpp", "pppppppp", "ppppppPp", "pqpppppp"],
  [TILE.tree]: ["TTuuuuTT", "TuuttuuT", "uuttttuu", "uttttttu", "uttttttu", "TuttttuT", "TTuTTuTT", "TTToTTTT"],
  [TILE.water]: ["wwwwwwww", "wwvwwwww", "Wwwwwwvw", "wwwwWwww", "wvwwwwww", "wwwwwwWw", "wwWwvwww", "wwwwwwww"],
  [TILE.wall]: ["BBBBBBBB", "BccccccB", "BcbbbbcB", "BcbbbbcB", "BcbbbbcB", "BcbbbbcB", "BccccccB", "BBBBBBBB"],
  [TILE.floor]: ["ffffffff", "ffffffff", "ffefffff", "ffffffff", "ffffffff", "fffffeff", "ffffffff", "FfffffFf"],
  [TILE.door]: ["BBBBBBBB", "BooooooB", "BoddddoB", "BoddddoB", "Bodd*doB", "BoddddoB", "BoddddoB", "BBBBBBBB"],
  [TILE.sign]: ["gggggggg", "oooooooo", "o......o", "o.####.o", "o.####.o", "o......o", "oooooooo", "ggoggogg"],
  [TILE.ledge]: ["gggggggg", "gggggggg", "llllllll", "llllllll", "PPPPPPPP", "PPPPPPPP", "pppppppp", "pppppppp"],
  [TILE.counter]: ["oooooooo", "oqqqqqqo", "oqqqqqqo", "oooooooo", "dddddddd", "dddddddd", "dddddddd", "dddddddd"],
  [TILE.roof]: ["rrrrrrrr", "rsrrrsrr", "RRRRRRRR", "rrrrrrrr", "rsrrrsrr", "RRRRRRRR", "rrrrrrrr", "RRRRRRRR"],
  [TILE.window]: ["cccccccc", "cBBBBBBc", "cBxxxxBc", "cBxxxxBc", "cBxxxxBc", "cBxxxxBc", "cBBBBBBc", "BBBBBBBB"],
  [TILE.flower]: ["gggggggg", "ggkggggg", "gkkkgggg", "ggkggkgg", "ggggkkkg", "gggggkgg", "gggggggg", "gggggggg"],
  [TILE.stairs]: ["BBBBBBBB", "cccccccc", "BBBBBBBB", "cccccccc", "BBBBBBBB", "cccccccc", "BBBBBBBB", "cccccccc"],
  [TILE.sand]: ["yyyyyyyy", "yyyPyyyy", "yyyyyyyy", "yPyyyyyy", "yyyyyyPy", "yyyyyyyy", "yyPyyyyy", "yyyyyyyy"],
  [TILE.fence]: ["gggggggg", "oooooooo", "gogggogg", "gogggogg", "oooooooo", "gogggogg", "gogggogg", "gggggggg"],
  [TILE.table]: ["oooooooo", "oqqqqqqo", "oqqqqqqo", "oqqqqqqo", "oooooooo", "fdffffdf", "fdffffdf", "fdffffdf"],
  [TILE.rug]: ["ffffffff", "frrrrrrf", "frssssrf", "frsRRsrf", "frsRRsrf", "frssssrf", "frrrrrrf", "ffffffff"],
};

/**
 * Cell behaviour per tile id, using `spec::cell::*` values. The core reads
 * this as a flat 256-byte table, so anything unlisted is a wall — the
 * fail-closed default that keeps a content bug from dropping the player
 * through the world.
 */
export const TILE_BEHAVIOR: Record<number, number> = {
  [TILE.void]: 0, // wall
  [TILE.grass]: 1, // floor
  [TILE.tallGrass]: 2, // grass
  [TILE.path]: 1,
  [TILE.tree]: 0,
  [TILE.water]: 3, // water
  [TILE.wall]: 0,
  [TILE.floor]: 1,
  [TILE.door]: 4, // door
  [TILE.sign]: 0,
  [TILE.ledge]: 6, // ledgeDown
  [TILE.counter]: 7, // counter
  [TILE.roof]: 0,
  [TILE.window]: 0,
  [TILE.flower]: 1,
  [TILE.stairs]: 5, // warp
  [TILE.sand]: 1,
  [TILE.fence]: 0,
  [TILE.table]: 0,
  [TILE.rug]: 1,
};

/** Block ids — the unit maps are laid out in. */
export const BLOCK = {
  grass: 0,
  tall: 1,
  path: 2,
  tree: 3,
  water: 4,
  house: 5,
  wall: 6,
  floor: 7,
  sign: 8,
  ledge: 9,
  flower: 10,
  fence: 11,
  counter: 12,
  stairs: 13,
  sand: 14,
  rug: 15,
  table: 16,
  lab: 17,
  void: 18,
  doorway: 19,
} as const;

/** A block filled with one tile. */
const solid = (t: number): number[] => Array.from({ length: 16 }, () => t);

/**
 * A composite block, written as four rows of four tile letters.
 *
 * Remember the collision rule while editing: cell (0,0) reads tile (0,1),
 * cell (1,0) reads (2,1), cell (0,1) reads (0,3) and cell (1,1) reads (2,3).
 * Those four positions are the ones that decide whether a cell is walkable.
 */
function grid(rows: [string, string, string, string], map: Record<string, number>): number[] {
  const out: number[] = [];
  for (const row of rows) {
    for (let x = 0; x < 4; x++) {
      const ch = row[x] ?? " ";
      out.push(map[ch] ?? TILE.void);
    }
  }
  return out;
}

const M = {
  ".": TILE.grass,
  "#": TILE.wall,
  R: TILE.roof,
  D: TILE.door,
  W: TILE.window,
  S: TILE.sign,
  f: TILE.floor,
  o: TILE.counter,
  T: TILE.table,
};

/** Block definitions, indexed by block id. */
export const BLOCK_TILES: Record<number, number[]> = {
  [BLOCK.grass]: solid(TILE.grass),
  [BLOCK.tall]: solid(TILE.tallGrass),
  [BLOCK.path]: solid(TILE.path),
  [BLOCK.tree]: solid(TILE.tree),
  [BLOCK.water]: solid(TILE.water),
  // Roof over a wall, with the door in the bottom-right cell.
  [BLOCK.house]: grid(["RRRR", "RRRR", "#W##", "##D#"], M),
  [BLOCK.wall]: solid(TILE.wall),
  [BLOCK.floor]: solid(TILE.floor),
  // A sign in the bottom-left cell, grass elsewhere.
  [BLOCK.sign]: grid(["....", "....", "SS..", "SS.."], M),
  [BLOCK.ledge]: solid(TILE.ledge),
  [BLOCK.flower]: solid(TILE.flower),
  [BLOCK.fence]: solid(TILE.fence),
  [BLOCK.counter]: solid(TILE.counter),
  [BLOCK.stairs]: solid(TILE.stairs),
  [BLOCK.sand]: solid(TILE.sand),
  [BLOCK.rug]: solid(TILE.rug),
  [BLOCK.table]: solid(TILE.table),
  // The lab: same silhouette, door on the left so it reads differently.
  [BLOCK.lab]: grid(["RRRR", "RRRR", "W##W", "##D#"], M),
  [BLOCK.void]: solid(TILE.void),
  // An indoor doorway: floor above, door below, so leaving a building is a
  // step down onto the mat.
  [BLOCK.doorway]: grid(["ffff", "ffff", "f##f", "fDDf"], M),
};

/** Highest tile id in use, for sizing the atlas row. */
export const TILE_COUNT = Object.keys(TILE_ART).length;

/** Rasterize one tile into 64 palette indices. */
export function rasterizeTile(id: number): Uint8Array {
  const out = new Uint8Array(64);
  const art = TILE_ART[id];
  if (!art) return out;
  for (let y = 0; y < 8; y++) {
    const row = art[y] ?? "";
    for (let x = 0; x < 8; x++) {
      out[y * 8 + x] = CH[row[x] ?? " "] ?? PAL.transparent;
    }
  }
  return out;
}

/** The 256-byte behaviour table the cooker writes into the TLES section. */
export function behaviorTable(): Uint8Array {
  const out = new Uint8Array(256); // 0 = wall everywhere by default
  for (const [id, behavior] of Object.entries(TILE_BEHAVIOR)) {
    out[Number(id)] = behavior;
  }
  return out;
}
