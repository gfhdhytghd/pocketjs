import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the Nokia N9 running Harmattan. */
export const NOKIA_N9_DEV_TARGET_ID = "nokia-n9-dev";
export const NOKIA_N9_DEV_HOST_ABI = 9;
export const NOKIA_N9_PHYSICAL_VIEWPORT = [854, 480] as const;
export const NOKIA_N9_DEFAULT_VIEWPORT = [854, 480] as const;
export const NOKIA_N9_MIN_VIEWPORT = [480, 480] as const;
export const NOKIA_N9_MAX_VIEWPORT = [854, 854] as const;
export const NOKIA_N9_TICK_HZ = 60;

export const NOKIA_N9_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [NOKIA_N9_DEV_TARGET_ID]: {
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
    },
  }),
);

export function resolveNokiaN9BuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: NOKIA_N9_DEV_TARGET_ID },
    NOKIA_N9_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket nokia-n9: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
