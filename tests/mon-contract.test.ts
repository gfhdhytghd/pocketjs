// Pocket Mon spec drift guard (docs/MON.md §3).
//
// Regenerates pocketmon-core/src/spec.rs IN-MEMORY from contracts/spec/mon-spec.ts
// and byte-compares against the committed file: TS and Rust constants can never
// drift. Fix = `bun contracts/spec/gen-mon-rust.ts` + commit.
//
// Also pins the surface's append-only invariants, which no regeneration can
// catch: op/event codes are unique and never reused.

import { expect, test } from "bun:test";
import { generateMonRust } from "../contracts/spec/gen-mon-rust.ts";
import {
  ENCOUNTER_BUCKETS,
  MON_EVENT,
  MON_OP,
  MONPAK_TAG,
  STAGE_MULT,
  VERB,
} from "../contracts/spec/mon-spec.ts";

const specRsPath = new URL(
  "../engine/pocketmon/crates/pocketmon-core/src/spec.rs",
  import.meta.url,
).pathname;

test("pocketmon-core/src/spec.rs matches mon-spec.ts", async () => {
  const committed = await Bun.file(specRsPath).text();
  expect(committed).toBe(generateMonRust());
});

test("op codes are unique and non-zero", () => {
  const codes = Object.values(MON_OP);
  expect(new Set(codes).size).toBe(codes.length);
  expect(codes.every((c) => c > 0)).toBe(true);
});

test("event codes are unique and non-zero", () => {
  const codes = Object.values(MON_EVENT);
  expect(new Set(codes).size).toBe(codes.length);
  expect(codes.every((c) => c > 0)).toBe(true);
});

test("script verbs are unique and dense from 0", () => {
  const codes = Object.values(VERB);
  expect(new Set(codes).size).toBe(codes.length);
  expect(Math.min(...codes)).toBe(0);
  expect(Math.max(...codes)).toBe(codes.length - 1);
});

test("MONPAK section tags are unique 4CCs", () => {
  const tags = Object.values(MONPAK_TAG);
  expect(new Set(tags).size).toBe(tags.length);
  // every tag must be four printable ASCII bytes, so hexdumps stay readable
  for (const tag of tags) {
    for (let i = 0; i < 4; i++) {
      const b = (tag >>> (i * 8)) & 0xff;
      expect(b).toBeGreaterThanOrEqual(0x20);
      expect(b).toBeLessThan(0x7f);
    }
  }
});

test("stat stage table is symmetric around stage 0", () => {
  // 13 entries, stage -6..+6; index 6 is the identity.
  expect(STAGE_MULT.length).toBe(13);
  expect(STAGE_MULT[6]).toBe(100);
  expect(STAGE_MULT[0]).toBe(25);
  expect(STAGE_MULT[12]).toBe(400);
  // monotonic increasing
  for (let i = 1; i < STAGE_MULT.length; i++) {
    expect(STAGE_MULT[i]).toBeGreaterThan(STAGE_MULT[i - 1]);
  }
});

test("encounter buckets are cumulative and end at 256", () => {
  expect(ENCOUNTER_BUCKETS[ENCOUNTER_BUCKETS.length - 1]).toBe(256);
  for (let i = 1; i < ENCOUNTER_BUCKETS.length; i++) {
    expect(ENCOUNTER_BUCKETS[i]).toBeGreaterThan(ENCOUNTER_BUCKETS[i - 1]);
  }
});
