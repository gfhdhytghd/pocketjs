// The voxel-surface drift guard: contracts/spec/voxel-spec.ts is the single
// source of truth, gen-voxel-rust.ts is deterministic, and the committed
// engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs must byte-match what
// the generator produces today. If this fails, run
// `bun contracts/spec/gen-voxel-rust.ts` and commit the result.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { generateVoxelRust } from "../contracts/spec/gen-voxel-rust.ts";
import {
  CHUNK_DRAW_DIST_PX,
  CHUNK_PX,
  MESH_KIND,
  MESH_KINDS,
  QUALITY,
  QUALITY_TIER,
  QUALITY_TIER_DEFAULT,
  QUALITY_UNBOUNDED,
  VOX_OP,
  VXPK_CHUNK_RECORD_SIZE,
  VXPK_META_FLAG_TREE_LOD,
  VXPK_META_SIZE,
  VXPK_TAG,
} from "../contracts/spec/voxel-spec.ts";

const root = join(import.meta.dir, "..");

test("committed spec.rs matches the generator byte-for-byte", async () => {
  const committed = await Bun.file(
    join(root, "engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs"),
  ).text();
  expect(committed).toBe(generateVoxelRust() + "\n");
});

test("op codes are unique and never use 0", () => {
  const codes = Object.values(VOX_OP);
  expect(new Set(codes).size).toBe(codes.length);
  expect(codes.includes(0 as never)).toBe(false);
});

// The quality ladder's structural rules. Every one of these is a claim the
// core, the hosts and the goldens all lean on; none of them is checkable by
// reading a single number.
test("the quality ladder is a table indexed by its own tier ids", () => {
  const ids: number[] = Object.values(QUALITY_TIER);
  expect(new Set(ids).size).toBe(ids.length);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids.map((_, i) => i));
  expect(QUALITY.length as number).toBe(ids.length);
});

test("the default rung is the weakest one", () => {
  expect(QUALITY_TIER_DEFAULT).toBe(0);
  expect(QUALITY_TIER.psp).toBe(0);
});

test("climbing the ladder never draws less", () => {
  for (let i = 1; i < QUALITY.length; i++) {
    const below = QUALITY[i - 1]!;
    const above = QUALITY[i]!;
    expect(above.grassDist).toBeGreaterThanOrEqual(below.grassDist);
    expect(above.flowerDist).toBeGreaterThanOrEqual(below.flowerDist);
    expect(above.treeHullDist).toBeGreaterThanOrEqual(below.treeHullDist);
    expect(above.chunkDist).toBeGreaterThanOrEqual(below.chunkDist);
  }
});

// The regression anchor: the top rung draws the pre-ladder picture. The
// detail dials are unbounded there, and the chunk cap — which the pre-ladder
// runtime already applied as draw.rs's CULL_DIST — is unchanged at EVERY
// rung, because widening it at the top would make the top rung draw more than
// the runtime it is supposed to reproduce.
test("the top rung is the identity", () => {
  const top = QUALITY.at(-1)!;
  expect(top.grassDist).toBe(QUALITY_UNBOUNDED);
  expect(top.flowerDist).toBe(QUALITY_UNBOUNDED);
  // Unbounded here means every tree carved, which is what the pre-ladder
  // runtime drew: the box level of detail exists only for lower rungs.
  expect(top.treeHullDist).toBe(QUALITY_UNBOUNDED);
  // The mod's own pull is geometric — per-vertex, along each eye ray. The
  // depth-bias substitute exists only below the top.
  expect(top.pullDepthBias).toBe(0);
  for (const rung of QUALITY) expect(rung.chunkDist).toBe(CHUNK_DRAW_DIST_PX);
});

// The bias mode is a HOW, not a how-much: it must never appear on a rung
// above one that draws geometrically, because climbing the ladder is allowed
// to add fidelity but never to swap exact for approximate.
test("depth-bias pull never rides above a geometric rung", () => {
  let seenGeometric = false;
  for (const rung of QUALITY) {
    if (rung.pullDepthBias === 0) seenGeometric = true;
    if (seenGeometric) expect(rung.pullDepthBias).toBe(0);
  }
});

// The GB grass-over-feet trick lives at the player's own cell, so the chunk
// the view centre stands in must survive every rung's detail dials — and so
// must the tree the player is standing next to, which is what makes tree LOD
// a distance dial rather than the global VOXEL_TREE_BOXES switch it replaces.
// The farthest a point inside a chunk can be from that chunk's centre is
// half*sqrt(2), and a dial's limit is widened by that same half.
test("no rung fades the chunk underfoot", () => {
  const half = CHUNK_PX / 2;
  const worst = half * Math.SQRT2;
  for (const [i, rung] of QUALITY.entries()) {
    expect(rung.grassDist + half).toBeGreaterThan(worst);
    expect(rung.flowerDist + half).toBeGreaterThan(worst);
    expect(rung.treeHullDist + half).toBeGreaterThan(worst);
    expect(i).toBeGreaterThanOrEqual(0);
  }
});

// Tree LOD is the one dial whose geometry lives in the pak, so the pak has
// to be able to SAY what it carries. A flag word — not a version bump, not a
// mesh-kind count — is what lets a pak cooked without the box level load and
// draw its carved hulls at every rung instead of losing its trees.
test("the pak declares the levels of detail it carries", () => {
  expect(VXPK_META_FLAG_TREE_LOD).toBeGreaterThan(0);
  // The record has room for the flags word and its pad, and both writers
  // size the META payload from this constant.
  expect(VXPK_META_SIZE).toBe(40);
  // Both tree levels are real mesh kinds with ranges of their own, so the
  // chunk record grew and every reader must size it from the spec.
  expect(MESH_KIND.treeHull).not.toBe(MESH_KIND.treeBox);
  expect(MESH_KINDS).toBe(Object.keys(MESH_KIND).length);
  expect(VXPK_CHUNK_RECORD_SIZE).toBe(16 + MESH_KINDS * 12);
});

// Mesh kinds ARE the draw order (voxel-spec.ts §MESH_KIND), and the two tree
// levels are alternatives inside the terrain pass: whichever a chunk draws,
// it draws right after that chunk's own terrain.
test("mesh kinds are a dense 0..n range in draw order", () => {
  const ids: number[] = Object.values(MESH_KIND);
  expect([...ids].sort((a, b) => a - b)).toEqual(ids.map((_, i) => i));
  expect(MESH_KIND.terrain).toBe(0);
  expect(MESH_KIND.treeHull as number).toBe(MESH_KIND.terrain + 1);
  expect(MESH_KIND.treeBox as number).toBe(MESH_KIND.treeHull + 1);
});

test("section tags are unique 4CCs", () => {
  const tags = Object.values(VXPK_TAG);
  expect(new Set(tags).size).toBe(tags.length);
  for (const t of tags) {
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(0xffffffff);
  }
});
