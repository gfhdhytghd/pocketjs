import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const guest = readFileSync(join(root, "hosts/iphone2g/pocket_runtime.c"), "utf8");
const adapter = readFileSync(
  join(root, "../rockbox/apps/pocketrock/runtime.c"),
  "utf8",
);
const shell = readFileSync(
  join(root, "../rockbox/apps/pocketrock/pocketrock.c"),
  "utf8",
);

describe("PocketRock memory diagnostics", () => {
  test("samples QuickJS and exact native-node counts without allocating", () => {
    expect(guest).toContain("JS_ComputeMemoryUsage(runtime, &usage)");
    expect(guest).toContain("if (run_gc) JS_RunGC(runtime)");
    expect(guest).toContain("native_nodes_peak");
    expect(guest).toContain("pocket_runtime_native_node_count");
    expect(guest).toContain("int pocket_runtime_memory_snapshot(");
  });

  test("logs only lifecycle checkpoints and never writes during USB ownership", () => {
    expect(adapter).toContain('pocketrock_guest_log_memory("usb-connect", true)');
    expect(adapter).toContain('pocketrock_guest_log_memory("usb-disconnect", false)');
    expect(adapter).toContain('"frame-exception", true');
    expect(adapter).toContain('"render-exception", true');
    expect(adapter).toContain('"release", true');
    expect(adapter).toContain('"ui-tree-settled", false');
    expect(adapter).toContain("if (!runtime_ready || pocketrock_usb_active()) return;");
    expect(shell).toContain("if (pocketrock_usb_active())");
    expect(adapter).not.toContain("largest-free");
  });
});
