// Deterministic art-pipeline checks for the PixelLab-backed GBA RPG assets.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { describe, expect, test } from "bun:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";

const ROOT = join(import.meta.dir, "..", "examples", "rpg", "assets");
const SOURCE = join(ROOT, "source");
const FINAL = join(ROOT, "final");
const SCRIPT = join(import.meta.dir, "..", "scripts", "rpg-assets.ts");
const HEADER = join(import.meta.dir, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");

const BG = [
  "0,0,0", "24,41,74", "33,123,66", "66,198,90", "132,90,41", "198,156,82",
  "74,82,99", "156,165,173", "24,74,148", "57,148,231", "33,82,41", "41,165,66",
  "255,214,66", "33,49,99", "239,222,148", "255,82,82",
];
const HERO = ["24,24,33", "255,173,99", "66,132,255", "255,123,74"];
const ELDER = ["24,24,33", "255,173,99", "148,148,148", "255,255,255"];
const SLIME = ["24,24,33", "0,173,173", "0,90,90", "255,255,255"];

async function rgba(path: string): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = await loadImage(path);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: context.getImageData(0, 0, image.width, image.height).data };
}

function generatedWordCount(name: string): number {
  const header = readFileSync(HEADER, "utf8");
  const match = header.match(new RegExp(`static const u16 ${name}\\[(\\d+)\\] = \\{([\\s\\S]*?)\\n\\};`));
  if (!match) throw new Error(`missing generated array ${name}`);
  expect([...match[2].matchAll(/0x[0-9a-f]{4}/g)]).toHaveLength(Number(match[1]));
  return Number(match[1]);
}

describe("Vapor Quest GBA art pipeline", () => {
  test("reviewed PNG inputs reproduce every committed output offline", async () => {
    await $`bun ${SCRIPT} check`.quiet();
    expect(generatedWordCount("vp_rpg_bg_palette")).toBe(16);
    expect(generatedWordCount("vp_rpg_obj_palettes")).toBe(48);
    expect(generatedWordCount("vp_rpg_bg_tiles")).toBe(24 * 16);
    expect(generatedWordCount("vp_rpg_obj_tiles")).toBe(56 * 16);
  });

  test("generation provenance is complete and contains no credential", () => {
    const text = readFileSync(join(ROOT, "generation.json"), "utf8");
    expect(text).not.toMatch(/PIXELLAB_API_KEY|Authorization|Bearer\s/i);
    const manifest = JSON.parse(text) as {
      provider: string;
      apiBase: string;
      records: { world: Record<string, unknown>; heroRotations: { characterId: string } };
      sourceHashes: Record<string, string>;
    };
    expect(manifest.provider).toBe("PixelLab");
    expect(manifest.apiBase).toBe("https://api.pixellab.ai/v2");
    expect(Object.keys(manifest.records.world).sort()).toEqual(["barriers", "field", "flower", "tree"]);
    expect(manifest.records.heroRotations.characterId).toMatch(/^[0-9a-f-]{36}$/);
    for (const [file, expected] of Object.entries(manifest.sourceHashes)) {
      const actual = createHash("sha256").update(readFileSync(join(SOURCE, file))).digest("hex");
      expect(actual, file).toBe(expected);
    }
  });

  test("the background sheet is exactly 24 opaque 8x8 tiles in one fixed bank", async () => {
    const image = await rgba(join(FINAL, "background.png"));
    expect([image.width, image.height]).toEqual([64, 24]);
    const allowed = new Set(BG);
    for (let at = 0; at < image.data.length; at += 4) {
      expect(image.data[at + 3]).toBe(255);
      expect(allowed.has(`${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`)).toBe(true);
    }
  });

  test("six actor frames share a foot line and stay inside their OBJ banks", async () => {
    const image = await rgba(join(FINAL, "actors.png"));
    expect([image.width, image.height]).toEqual([96, 16]);
    const frameHashes: string[] = [];
    const frameColors: Set<string>[] = [];
    for (let frame = 0; frame < 6; frame++) {
      const allowed = new Set(frame < 4 ? HERO : frame === 4 ? ELDER : SLIME);
      const colors = new Set<string>();
      let visible = 0;
      let grounded = false;
      const bytes: number[] = [];
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const at = (y * 96 + frame * 16 + x) * 4;
          const alpha = image.data[at + 3];
          expect(alpha === 0 || alpha === 255).toBe(true);
          bytes.push(image.data[at], image.data[at + 1], image.data[at + 2], alpha);
          if (alpha === 0) continue;
          visible++;
          if (y === 15) grounded = true;
          const color = `${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`;
          colors.add(color);
          expect(allowed.has(color)).toBe(true);
        }
      }
      expect(visible).toBeGreaterThanOrEqual(frame === 5 ? 20 : 30);
      expect(grounded).toBe(true);
      frameHashes.push(createHash("sha256").update(Uint8Array.from(bytes)).digest("hex"));
      frameColors.push(colors);
    }
    expect(new Set(frameHashes.slice(0, 4)).size).toBe(4);
    expect(frameColors[5]).toEqual(new Set(SLIME));
  });

  test("battle reuses the same actors and palettes at a readable 32x32 scale", async () => {
    const image = await rgba(join(FINAL, "battle-actors.png"));
    expect([image.width, image.height]).toEqual([64, 32]);
    for (let frame = 0; frame < 2; frame++) {
      const allowed = new Set(frame === 0 ? HERO : SLIME);
      let visible = 0;
      let grounded = false;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 32; x++) {
          const at = (y * 64 + frame * 32 + x) * 4;
          const alpha = image.data[at + 3];
          expect(alpha === 0 || alpha === 255).toBe(true);
          if (alpha === 0) continue;
          visible++;
          if (y === 31) grounded = true;
          expect(allowed.has(`${image.data[at]},${image.data[at + 1]},${image.data[at + 2]}`)).toBe(true);
        }
      }
      expect(visible).toBeGreaterThan(100);
      expect(grounded).toBe(true);
    }
  });
});
