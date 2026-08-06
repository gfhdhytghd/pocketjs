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
  QUALITY,
  QUALITY_TIER,
  QUALITY_TIER_DEFAULT,
  QUALITY_UNBOUNDED,
  VOX_OP,
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
  for (const rung of QUALITY) expect(rung.chunkDist).toBe(CHUNK_DRAW_DIST_PX);
});

// The GB grass-over-feet trick lives at the player's own cell, so the chunk
// the view centre stands in must survive every rung's detail dials. The
// farthest a point inside a chunk can be from that chunk's centre is
// half*sqrt(2), and a dial's limit is widened by that same half.
test("no rung fades the chunk underfoot", () => {
  const half = CHUNK_PX / 2;
  const worst = half * Math.SQRT2;
  for (const [i, rung] of QUALITY.entries()) {
    expect(rung.grassDist + half).toBeGreaterThan(worst);
    expect(rung.flowerDist + half).toBeGreaterThan(worst);
    expect(i).toBeGreaterThanOrEqual(0);
  }
});

test("section tags are unique 4CCs", () => {
  const tags = Object.values(VXPK_TAG);
  expect(new Set(tags).size).toBe(tags.length);
  for (const t of tags) {
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(0xffffffff);
  }
});
