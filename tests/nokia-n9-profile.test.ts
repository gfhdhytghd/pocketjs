import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  NOKIA_N9_DEFAULT_VIEWPORT,
  NOKIA_N9_DEV_CONTRACTS,
  NOKIA_N9_DEV_HOST_ABI,
  NOKIA_N9_DEV_TARGET_ID,
  NOKIA_N9_MAX_VIEWPORT,
  NOKIA_N9_MIN_VIEWPORT,
  NOKIA_N9_PHYSICAL_VIEWPORT,
  resolveNokiaN9BuildPlan,
} from "../tools/nokia-n9-profile.ts";

const root = resolve(import.meta.dir, "..");
const demoManifest = () => JSON.parse(
  readFileSync(resolve(root, "apps/nokia-n9-demo/pocket.json"), "utf8"),
);

describe("private Nokia N9 build profile", () => {
  test("stays private and describes the live native Harmattan viewport", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(NOKIA_N9_DEV_TARGET_ID);
    expect(NOKIA_N9_DEV_CONTRACTS.targets[NOKIA_N9_DEV_TARGET_ID]).toEqual({
      hostAbi: NOKIA_N9_DEV_HOST_ABI,
      platform: "harmattan",
      form: "window",
      display: {
        physicalViewport: NOKIA_N9_PHYSICAL_VIEWPORT,
        logicalViewports: [NOKIA_N9_DEFAULT_VIEWPORT],
        dynamicViewport: {
          min: NOKIA_N9_MIN_VIEWPORT,
          max: NOKIA_N9_MAX_VIEWPORT,
        },
        presentations: ["native"],
        rasterDensity: 1,
      },
      capabilities: [
        "input.touch",
        "display.viewport.live",
        "text.glyphs.baked",
      ],
    });
  });

  test("resolves the dedicated touch Hero at 854x480", () => {
    const plan = resolveNokiaN9BuildPlan(demoManifest());
    expect(plan.target).toEqual({
      id: NOKIA_N9_DEV_TARGET_ID,
      hostAbi: NOKIA_N9_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [854, 480],
      physical: [854, 480],
      presentation: "native",
      rasterDensity: 1,
    });
    expect(plan.features).toEqual({
      "input.touch": true,
      "display.viewport.live": true,
      "text.glyphs.baked": true,
    });
  });

  test("rejects button-only and fixed-viewport applications", () => {
    const buttons = demoManifest();
    buttons.engine.capabilities.requires = ["input.buttons", "text.glyphs.baked"];
    expect(() => resolveNokiaN9BuildPlan(buttons)).toThrow("input.buttons");

    const fixed = demoManifest();
    fixed.app.viewport = {
      fixed: { logical: [854, 480], presentation: "native" },
    };
    expect(() => resolveNokiaN9BuildPlan(fixed)).toThrow();
  });

  test("keeps the shared Hero device-neutral", () => {
    const shared = readFileSync(resolve(root, "apps/hero/app.tsx"), "utf8");
    const wrapper = readFileSync(resolve(root, "apps/nokia-n9-demo/app.tsx"), "utf8");
    expect(shared).not.toContain("Nokia N9");
    expect(wrapper).toContain('headline="JSX on Harmattan."');
    expect(wrapper).toContain("compactHeadline");
    expect(wrapper).toContain('reportAppAction("hero_tap", count)');
    expect(wrapper).toContain("presentationHz={60}");
  });
});
