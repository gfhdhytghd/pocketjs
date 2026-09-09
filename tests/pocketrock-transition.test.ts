import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  POCKETROCK_TRANSITION_MS,
  transitionDeadline,
  transitionExpired,
} from "../apps/pocketrock/transition-timing.ts";

const root = join(import.meta.dir, "..");
const shell = readFileSync(join(root, "apps/pocketrock/app.tsx"), "utf8");

describe("PocketRock page transitions", () => {
  test("unlocks from elapsed time at both 30 Hz and 60 Hz", () => {
    const deadline = transitionDeadline(1_000);
    expect(deadline).toBe(1_000 + POCKETROCK_TRANSITION_MS);

    const frames60 = Array.from({ length: 8 }, (_, frame) => 1_000 + frame * (1000 / 60));
    const frames30 = Array.from({ length: 5 }, (_, frame) => 1_000 + frame * (1000 / 30));
    expect(frames60.filter((now) => transitionExpired(deadline, now))).toEqual([frames60[7]]);
    expect(frames30.filter((now) => transitionExpired(deadline, now))).toEqual([frames30[4]]);
    expect(transitionExpired(deadline, 1_109)).toBe(false);
    expect(transitionExpired(deadline, 1_110)).toBe(true);
  });

  test("starts synchronously with a permanently mounted transition panel", () => {
    expect(shell).not.toContain("queueMicrotask(() =>");
    expect(shell).not.toContain("TRANSITION_FRAMES");
    expect(shell).not.toContain("<Show when={page()} keyed>");
    expect(shell).toContain("<Show when={transitionSnapshot()} keyed>");
    expect(shell).toContain("setTransitionSnapshot(null)");
    expect(shell).toContain('setTransitionDirection(direction)');
    expect(shell).toContain('transitionDirection() === "push" ? 2 : 1');
    expect(shell).toContain('transitionDirection() === "push" ? 1 : 2');
    expect(shell).toContain('style={{ translateX: 320, zIndex:');
    expect(shell).toContain('if (transitionPanel) jump(transitionPanel, "translateX", 320)');
    expect(shell).toContain('prepareTransition(snapshot, "push")');
    expect(shell).toContain('runTransition("push")');
  });

  test("preserves specialized outgoing pages and defers library IO", () => {
    expect(shell).toContain('props.page === "Now Playing"');
    expect(shell).toContain("playback: playbackState()");
    expect(shell.indexOf("libraryRows: []"))
      .toBeLessThan(shell.indexOf("function loadPendingLibrary"));
    expect(shell).not.toContain("正在载入音乐资料库");
    expect(shell).toContain('pending: page() === "Library" && pendingLibraryKind !== null');
    expect(shell).toContain("loadPendingLibrary();");
  });

  test("starts a Tagcache track through the native Rockbox queue", () => {
    expect(shell).toContain("action: item.path ? () => playLibraryTrack(item.path!) : undefined");
    expect(shell).toContain("queue.replace([path], 0)");
    expect(shell).toContain('push({ page: "Now Playing" })');
  });

  test("keeps the full Tagcache result virtualized in 64-track pages", () => {
    expect(shell).toContain("libraryRows = new Array<Row>(result.total)");
    expect(shell).toContain("const offset = Math.floor(Math.max(0, index) / 64) * 64");
    expect(shell).toContain("ensureLibraryPage(wheelTargetIndex)");
    expect(shell).toContain("while (pagesByDistance.length > 3)");
    expect(shell).toContain("ensureLibraryPage(selected())");
    expect(shell).not.toContain("libraryRows = result.items.map");
  });
});
