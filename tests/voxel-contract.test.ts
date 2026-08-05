// The voxel-surface drift guard: contracts/spec/voxel-spec.ts is the single
// source of truth, gen-voxel-rust.ts is deterministic, and the committed
// engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs must byte-match what
// the generator produces today. If this fails, run
// `bun contracts/spec/gen-voxel-rust.ts` and commit the result.

import { expect, test } from "bun:test";
import { join } from "node:path";
import { generateVoxelRust } from "../contracts/spec/gen-voxel-rust.ts";
import { VOX_OP, VXPK_TAG } from "../contracts/spec/voxel-spec.ts";

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

test("section tags are unique 4CCs", () => {
  const tags = Object.values(VXPK_TAG);
  expect(new Set(tags).size).toBe(tags.length);
  for (const t of tags) {
    expect(t).toBeGreaterThan(0);
    expect(t).toBeLessThanOrEqual(0xffffffff);
  }
});
