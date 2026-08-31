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
const runtimePort = readFileSync(
  join(root, "hosts/rockbox/runtime_port.c"),
  "utf8",
);
const demoMain = readFileSync(
  join(root, "hosts/rockbox/demo/main.tsx"),
  "utf8",
);
const inputPage = readFileSync(
  join(root, "hosts/rockbox/demo/input-test-page.tsx"),
  "utf8",
);
const contactsPage = readFileSync(
  join(root, "hosts/rockbox/demo/contacts-page.tsx"),
  "utf8",
);

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

  test("reserves a 16 MiB runtime stack before the QuickJS heap", () => {
    expect(nativeHost).toContain("rb->audio_stop();");
    expect(nativeHost).toContain("rb->plugin_get_audio_buffer(&audio_size)");
    expect(nativeHost).toContain(
      "#define POCKETJS_RUNTIME_STACK_SIZE (16u * 1024u * 1024u)",
    );
    expect(nativeHost).toContain("heap = audio_buffer + POCKETJS_RUNTIME_STACK_SIZE");
    expect(nativeHost).toContain("rb->create_thread(");
    expect(nativeHost).toContain("POCKETJS_RUNTIME_STACK_SIZE,");
    expect(runtimePort).toContain(
      "#define POCKET_RUNTIME_JS_STACK_SIZE (8 * 1024 * 1024)",
    );
  });

  test("ships three hardware-switchable acceptance pages", () => {
    expect(demoMain).toContain("const PAGE_COUNT = 3");
    expect(demoMain).toContain("buttons & BTN.CIRCLE");
    expect(demoMain).toContain("pressed & BTN.LEFT");
    expect(demoMain).toContain("pressed & BTN.RIGHT");
    expect(demoMain).toContain("<StandardPage />");
    expect(demoMain).toContain("<InputTestPage />");
    expect(demoMain).toContain("<ContactsPage />");
  });

  test("covers every iPod input and virtualizes 10,000 contacts", () => {
    for (const button of [
      "BTN.TRIANGLE",
      "BTN.LEFT",
      "BTN.CIRCLE",
      "BTN.RIGHT",
      "BTN.START",
      "BTN.UP",
      "BTN.DOWN",
    ]) {
      expect(inputPage).toContain(button);
    }
    expect(contactsPage).toContain("const CONTACT_COUNT = 10_000");
    expect(contactsPage).toContain("<VirtualList");
    expect(contactsPage).toContain("focusRow(0)");
  });
});
