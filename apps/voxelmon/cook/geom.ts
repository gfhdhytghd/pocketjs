// apps/voxelmon/cook/geom.ts — shared geometry types for the cook passes.
//
// Every pass emits QUADS in map-local world px (voxel-spec WORLD_AXES: +X
// east, +Y up, +Z south). UVs are carried in SHEET-PIXEL coordinates of the
// tileset atlas (texel units, insets included); cook/mesh.ts converts them
// into combined-page UV space when packing vertices.

import type { Shape } from "./classify.ts";

export interface Quad {
  /** Four corners, [x, y, z] world px. */
  c: [number, number, number][];
  /** Per-corner UV in sheet px, or a single point via u/v. */
  uv?: [number, number][];
  u?: number;
  v?: number;
  /** Flat shade, or per-corner shades (AO-folded). */
  shade: number | number[];
  /** A body-anchored building's own quad — exempt from edge keep-rules. */
  own?: boolean;
}

/** One measured volume run (VoxelMod Structures.lua:2208/2271). */
export interface Run {
  front: number;
  north: number;
  extent: number;
  unit: number;
  fromRepeat: boolean;
  door: boolean;
  roofRows: number;
  rise: number;
  peak: number;
  /** Facade height: what sides build to. */
  h: number;
}

/** Grid key (VoxelMod Structures.lua:133 keyOf). */
export function keyOf(tx: number, ty: number): number {
  return (ty + 64) * 4096 + (tx + 64);
}

export function txOf(key: number): number {
  return (key % 4096) - 64;
}

export function tyOf(key: number): number {
  return Math.floor(key / 4096) - 64;
}

export const DIRS4: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/** The per-map analysis state (VoxelMod Structures.forMap's `S`). */
export interface SGrid {
  shapeAt: Map<number, Shape>;
  tileAt: Map<number, number>;
  outdoor: boolean;
  hideBareRing: boolean;
  runs: Map<number, Run>;
  skip: Set<number>;
  /** Synthesized ground under claimed tiles; false = vote pending. */
  ground: Map<number, number | false>;
  doorFold: Set<number>;
  objectQuads: Quad[];
  grassQuads: Quad[];
  flowerQuads: Quad[];
  roundStamps: { quads: Quad[]; mx: number; mz: number; r?: number }[];
  /** Cut-tree stamps: "cx,cy" cell key -> quads (become STMP records). */
  stampQuads: Map<string, Quad[]>;
  /**
   * The border tree wall's tile set, when this map rings with trees. Wall
   * cells take the BOX path instead of the hull carve — replicating a
   * ~700-quad hull over hundreds of identical wall cells blows the §8
   * vertex budget (see cook/trees.ts).
   */
  wallTiles: Set<number> | null;
  /** Analysed tile range (body + ring), inclusive. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
