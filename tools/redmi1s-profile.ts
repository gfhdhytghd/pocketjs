import {
  POCKET_CAPABILITIES,
  definePlatformContractRegistry,
  defineTargetRegistry,
} from "../contracts/spec/platforms.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

/** Private exact-device profile for the Redmi 1S running MIUI V5/Android 4.3. */
export const REDMI1S_DEV_TARGET_ID = "android-redmi1s-dev";
export const REDMI1S_DEV_HOST_ABI = 9;
export const REDMI1S_LOGICAL_VIEWPORT = [360, 640] as const;
export const REDMI1S_PHYSICAL_VIEWPORT = [720, 1280] as const;
export const REDMI1S_RASTER_DENSITY = 2;

export const REDMI1S_DEV_CONTRACTS = definePlatformContractRegistry(
  POCKET_CAPABILITIES,
  defineTargetRegistry({
    [REDMI1S_DEV_TARGET_ID]: {
      hostAbi: REDMI1S_DEV_HOST_ABI,
      platform: "android",
      form: "takeover",
      display: {
        physicalViewport: REDMI1S_PHYSICAL_VIEWPORT,
        logicalViewports: [REDMI1S_LOGICAL_VIEWPORT],
        presentations: ["native"],
        rasterDensity: REDMI1S_RASTER_DENSITY,
      },
      capabilities: ["input.touch", "text.glyphs.baked"],
    },
  }),
);

export function resolveRedmi1SBuildPlan(input: unknown): ResolvedBuildPlan {
  const resolution = validateAndResolveBuildPlan(
    input,
    { target: REDMI1S_DEV_TARGET_ID },
    REDMI1S_DEV_CONTRACTS,
  );
  if (!resolution.ok) {
    throw new Error(
      `pocket redmi1s: manifest did not resolve: ${resolution.diagnostics
        .map((diagnostic) => `${diagnostic.path || "/"}: ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  return resolution.plan;
}
