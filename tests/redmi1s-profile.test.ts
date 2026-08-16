import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImage } from "@napi-rs/canvas";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import { checkAppTypes } from "../framework/compiler/app-check.ts";
import { verifyPlanHash } from "../framework/src/manifest/plan.ts";
import {
  REDMI1S_DEV_CONTRACTS,
  REDMI1S_DEV_HOST_ABI,
  REDMI1S_DEV_TARGET_ID,
  REDMI1S_LOGICAL_VIEWPORT,
  REDMI1S_PHYSICAL_VIEWPORT,
  REDMI1S_RASTER_DENSITY,
  resolveRedmi1SBuildPlan,
} from "../tools/redmi1s-profile.ts";
import {
  bakeRedmi1SArtwork,
  REDMI1S_ICON_OUTPUTS,
  REDMI1S_ICON_SOURCE,
} from "../tools/redmi1s-icon.ts";

const repository = join(import.meta.dir, "..");
const manifestPath = join(repository, "apps/redmi1s-demo/pocket.json");

function manifest(): Record<string, any> {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

describe("private Redmi 1S build profile", () => {
  test("pins the Android 4.3 ARMv7 takeover surface", () => {
    expect(POCKET_TARGETS).not.toHaveProperty(REDMI1S_DEV_TARGET_ID);
    expect(REDMI1S_DEV_CONTRACTS.targets[REDMI1S_DEV_TARGET_ID]).toEqual({
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
    });
  });

  test("resolves the Hero to the exact hardware plan", () => {
    const plan = resolveRedmi1SBuildPlan(manifest());
    expect(plan.target).toEqual({
      id: REDMI1S_DEV_TARGET_ID,
      hostAbi: REDMI1S_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: REDMI1S_LOGICAL_VIEWPORT,
      physical: REDMI1S_PHYSICAL_VIEWPORT,
      presentation: "native",
      rasterDensity: REDMI1S_RASTER_DENSITY,
    });
    expect(plan.app.entry).toBe("apps/redmi1s-demo/main.tsx");
    expect(plan.app.output).toBe("redmi1s-demo-main");
    expect(verifyPlanHash(plan)).toBe(true);
  });

  test("rejects unsupported buttons and a mismatched logical viewport", () => {
    const needsButtons = manifest();
    needsButtons.engine.capabilities.requires.push("input.buttons");
    expect(() => resolveRedmi1SBuildPlan(needsButtons)).toThrow(
      "input.buttons",
    );

    const stretched = manifest();
    stretched.app.viewport.fixed.logical = [720, 1280];
    expect(() => resolveRedmi1SBuildPlan(stretched)).toThrow("720x1280");
  });

  test("type-checks explicit PocketJS imports in the Solid demo", () => {
    const result = checkAppTypes({
      entry: join(repository, "apps/redmi1s-demo/main.tsx"),
      tsconfigPath: join(repository, "tsconfig.json"),
      declarationFiles: [join(repository, "framework/src/jsx.d.ts")],
    });
    expect(
      result.diagnostics
        .filter((diagnostic) => diagnostic.category === "error")
        .map((diagnostic) => diagnostic.message),
    ).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test("pins the connected phone and the API 18 build inputs", () => {
    const toolchain = JSON.parse(
      readFileSync(
        join(repository, "tools/cli/redmi1s-toolchain.json"),
        "utf8",
      ),
    );
    expect(toolchain).toMatchObject({
      toolchainVersion: "android-4.3-armv7-gles2-v1",
      device: {
        model: "HM 1S",
        codename: "armani",
        boardPlatform: "msm8226",
        androidRelease: "4.3",
        sdk: "18",
        abi: "armeabi-v7a",
        physicalViewport: [720, 1280],
        density: 320,
        gpuRenderer: "Adreno (TM) 305",
      },
      compiler: {
        compileSdk: "34",
        buildToolsVersion: "34.0.0",
        ndkVersion: "21.4.7075529",
        minimumSdk: "18",
        rustTarget: "armv7-linux-androideabi",
      },
    });
    expect(toolchain.compiler.quickJsRevision).toMatch(/^[0-9a-f]{40}$/);
  });

  test("requires an accelerated GLES2 NativeActivity with no software fallback", () => {
    const manifest = readFileSync(
      join(repository, "hosts/android-redmi1s/AndroidManifest.xml"),
      "utf8",
    );
    const runtime = readFileSync(
      join(repository, "hosts/android-redmi1s/runtime.c"),
      "utf8",
    );
    const rustAbort = readFileSync(
      join(repository, "hosts/android-redmi1s/rust_abort.c"),
      "utf8",
    );
    const tool = readFileSync(join(repository, "tools/redmi1s.ts"), "utf8");
    expect(manifest).toContain('android:minSdkVersion="18"');
    expect(manifest).toContain(
      'android:glEsVersion="0x00020000" android:required="true"',
    );
    expect(manifest).toContain('android:hardwareAccelerated="true"');
    expect(manifest).toContain('android:name="android.app.NativeActivity"');
    expect(runtime).toContain("EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT");
    expect(runtime).toContain("EGL_CONTEXT_CLIENT_VERSION, 2");
    expect(runtime).toContain("pocket_runtime_gl_initialize()");
    expect(runtime).toContain(
      "pocket_runtime_gl_render(host->surface_width, host->surface_height)",
    );
    expect(runtime).toContain(
      'copy_text(host->state, sizeof(host->state), "failed")',
    );
    expect(runtime).toContain('snprintf(path, capacity, "%s/%s", root, name)');
    expect(runtime).not.toContain(
      'snprintf(directory, sizeof(directory), "%s/files", root)',
    );
    expect(runtime).not.toContain("pocket_runtime_render(");
    expect(rustAbort).toContain("void rust_eh_personality(void)");
    expect(rustAbort).toContain("abort();");
    expect(tool).toContain('\"-Wl,--no-undefined\"');
  });

  test("bakes the high-resolution classic icon at every Android density", async () => {
    const output = mkdtempSync(join(tmpdir(), "pocket-redmi1s-icons-"));
    try {
      expect(REDMI1S_ICON_SOURCE).toBe(
        join(repository, "hosts/iphone4s/Icon.svg"),
      );
      const written = await bakeRedmi1SArtwork(output);
      expect(written).toHaveLength(Object.keys(REDMI1S_ICON_OUTPUTS).length);
      for (const [density, size] of Object.entries(REDMI1S_ICON_OUTPUTS)) {
        const icon = await loadImage(join(output, density, "icon.png"));
        expect([icon.width, icon.height]).toEqual([size, size]);
      }
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  test("ties hardware acceptance to GPU, frame, capture, and touch receipts", () => {
    const tool = readFileSync(join(repository, "tools/redmi1s.ts"), "utf8");
    for (const marker of [
      "verifyDeviceIdentity()",
      'second.renderer !== "gles2"',
      "second.gl_renderer.includes(TOOLCHAIN.device.gpuRenderer)",
      "/^OpenGL ES (\\d+)\\.(\\d+)/.exec(second.gl_version)",
      'numeric(second, "guest_frames") <= numeric(first, "guest_frames")',
      'numeric(second, "swaps") <= numeric(first, "swaps")',
      'numeric(second, "capture_successes") < 1',
      'second.action_name !== "hero_tap"',
    ]) {
      expect(tool).toContain(marker);
    }
  });
});
