// tests/voxel-cook.test.ts — the voxelizer/cooker under test.
//
// Skips (with a printed reason) when dist/voxelmon/gen/ is absent — the
// POCKET3D_TEST_MAPS convention: everything here derives from the player's
// ROM and CI never sees it. When gen/ is present: the pak loads through the
// real Rust reader (`pocketvoxel-sim --validate`), two cooks are
// byte-identical, every cooked map has chunks and vertices, the CMAP covers
// A-Z a-z 0-9, and the UI page carries the font at its charmap codes.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildUiPage } from "../apps/voxelmon/cook/atlas.ts";
import { cook, DEFAULT_MAPS } from "../apps/voxelmon/cook/cli.ts";
import { GEN_DIR, genMissingReason, loadGen } from "../apps/voxelmon/cook/data.ts";
import { buildCharmap } from "../apps/voxelmon/cook/gamedata.ts";

const root = join(import.meta.dir, "..");
const scratch = join(root, "dist/voxelmon");

const reason = genMissingReason();
if (reason) {
  console.error(`voxel-cook tests skipped — ${reason}`);
}

describe.skipIf(reason !== null)("voxel cook", () => {
  const outA = join(scratch, "voxelmon.test-a.vxpak");
  const outB = join(scratch, "voxelmon.test-b.vxpak");
  let resultA: ReturnType<typeof cook>;

  test("cook produces a pak the Rust reader validates", () => {
    resultA = cook(DEFAULT_MAPS, outA);
    expect(resultA.pakBytes).toBeGreaterThan(0);

    // Smoke gate: the core's untrusted-byte reader accepts every section.
    const sim = join(root, "engine/target/release/pocketvoxel-sim");
    const proc = Bun.spawnSync(
      Bun.file(sim).size > 0
        ? [sim, outA, "--validate"]
        : ["cargo", "run", "--release", "-p", "pocketvoxel-sim", "--", outA, "--validate"],
      { cwd: join(root, "engine"), stdout: "pipe", stderr: "pipe" },
    );
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("valid:");
  }, 240000);

  test("cook is deterministic: two cooks, identical bytes", () => {
    cook(DEFAULT_MAPS, outB);
    const a = readFileSync(outA);
    const b = readFileSync(outB);
    expect(a.equals(b)).toBe(true);
  }, 240000);

  test("every cooked map has chunks and vertices", () => {
    expect(resultA.mapStats.length).toBe(DEFAULT_MAPS.length);
    for (const m of resultA.mapStats) {
      expect(m.chunks).toBeGreaterThan(0);
      expect(m.verts).toBeGreaterThan(0);
    }
  });

  test("CMAP covers A-Z a-z 0-9 and maps to GB codes", () => {
    const gen = loadGen(GEN_DIR);
    const glyphs = new Map(buildCharmap(gen));
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789") {
      expect(glyphs.has(ch.charCodeAt(0))).toBe(true);
    }
    // ascending, no duplicates (the reader binary-searches)
    const codes = buildCharmap(gen).map(([c]) => c);
    for (let i = 1; i < codes.length; i++) expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    // 'A' sits at the charmap's mainBase code (0x80)
    expect(glyphs.get("A".charCodeAt(0))).toBe(0x80);
  });

  test("the UI page has the font at 0x80 and font_extra at 0x60", () => {
    const gen = loadGen(GEN_DIR);
    const page = buildUiPage(gen);
    expect(page.w).toBe(128);
    expect(page.h).toBe(128);
    const linear = page.frames[0];
    // tile 0 is fully transparent (UI cell unset)
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) expect(linear[y * 128 + x]).toBe(0xff);
    }
    const tileHasInk = (tile: number): boolean => {
      const tx = (tile % 16) * 8;
      const ty = Math.floor(tile / 16) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          const b = linear[(ty + y) * 128 + tx + x];
          if (b !== 0xff && b !== 0) return true;
        }
      }
      return false;
    };
    // 'A' = 0x80 (mainBase), textbox border art lives in the extra bank
    expect(tileHasInk(0x80)).toBe(true);
    expect([0x60, 0x61, 0x62, 0x63, 0x79].some(tileHasInk)).toBe(true);
  });
});
