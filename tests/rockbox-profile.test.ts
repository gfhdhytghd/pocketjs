import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROCKBOX_IPOD_CLASSIC_HOST_ABI,
  ROCKBOX_IPOD_CLASSIC_TARGET_ID,
  resolveRockboxBuildPlan,
} from "../tools/rockbox-profile.ts";

const root = join(import.meta.dir, "..");
const manifest = JSON.parse(
  readFileSync(join(root, "hosts/rockbox/demo.pocket.json"), "utf8"),
);
const nativeHost = readFileSync(join(root, "hosts/rockbox/main.c"), "utf8");

describe("Rockbox iPod classic development profile", () => {
  test("resolves the embedded 320x240 demo", () => {
    const plan = resolveRockboxBuildPlan(manifest);
    expect(plan.target).toEqual({
      id: ROCKBOX_IPOD_CLASSIC_TARGET_ID,
      hostAbi: ROCKBOX_IPOD_CLASSIC_HOST_ABI,
    });
    expect(plan.viewport.logical).toEqual([320, 240]);
    expect(plan.features["input.buttons"]).toBe(true);
    expect(plan.features["text.glyphs.baked"]).toBe(true);
  });

  test("rejects a non-native logical viewport", () => {
    const changed = structuredClone(manifest);
    changed.app.viewport.fixed.logical = [176, 132];
    expect(() => resolveRockboxBuildPlan(changed)).toThrow();
  });

  test("uses Rockbox's audio buffer for the QuickJS heap", () => {
    expect(nativeHost).toContain("rb->audio_stop();");
    expect(nativeHost).toContain("rb->plugin_get_audio_buffer(&heap_size)");
    expect(nativeHost).not.toContain("rb->plugin_get_buffer(&heap_size)");
  });
});
