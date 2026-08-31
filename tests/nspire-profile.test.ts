import { describe, expect, test } from "bun:test";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  NSPIRE_CX2_DEV_HOST_ABI,
  NSPIRE_CX2_DEV_CONTRACTS,
  NSPIRE_CX2_DEV_TARGET_ID,
  NSPIRE_CX2_VIEWPORT,
  resolveNspireCx2BuildPlan,
} from "../tools/nspire-profile.ts";

function manifest(requires: string[] = ["input.buttons", "text.glyphs.baked"]) {
  return {
    $schema: "https://pocketjs.dev/schema/pocket-2.json",
    pocket: 2,
    id: "dev.pocket-stack.nspire-test",
    name: "nspire-test",
    title: "Nspire Test",
    version: "0.1.0",
    engine: { capabilities: { requires } },
    app: {
      entry: "apps/hero/main.tsx",
      output: "nspire-test",
      framework: "solid",
      viewport: { fixed: { logical: [320, 240], presentation: "native" } },
    },
  };
}

describe("TI-Nspire CX II development profile", () => {
  test("is not promoted before hardware acceptance", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(NSPIRE_CX2_DEV_TARGET_ID);
  });

  test("resolves the fixed RGB565 takeover surface", () => {
    const plan = resolveNspireCx2BuildPlan(manifest());
    expect(plan.target).toMatchObject({
      id: NSPIRE_CX2_DEV_TARGET_ID,
      hostAbi: NSPIRE_CX2_DEV_HOST_ABI,
    });
    expect(NSPIRE_CX2_DEV_CONTRACTS.targets[NSPIRE_CX2_DEV_TARGET_ID]).toMatchObject({
      platform: "nspire-cx2",
      form: "takeover",
    });
    expect(plan.viewport.logical).toEqual(NSPIRE_CX2_VIEWPORT);
    expect(plan.viewport.rasterDensity).toBe(1);
  });

  test.each(["audio.pcm", "input.touch", "net.http"])(
    "rejects unsupported capability %s",
    (capability) => {
      expect(() => resolveNspireCx2BuildPlan(manifest([capability]))).toThrow(
        "manifest did not resolve",
      );
    },
  );
});
