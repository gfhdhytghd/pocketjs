// apps/voxelmon/game/psp-main.ts — the QuickJS entry for the PSP EBOOT.
//
// Bundled by `bun tools/voxel.ts psp` (iife, browser target, no Bun/node in
// the import graph — data.ts only touches Bun inside fromGenDir, which this
// entry never calls) and evaled once at boot by pocketvoxel-psp. The host
// side registers `globalThis.voxel` (engine/pocketvoxel/crates/
// pocketvoxel-psp/src/voxel.rs), one function per VOX_OP.
//
// Boot: one cold JSON.parse of the pak's GAME section (docs/VOXEL.md §4),
// then the game runs entirely guest-side; per tick the host calls
// `globalThis.frame(buttons)` exactly once (§3). The Bun sim loads the SAME
// cooked gamedata (data.ts loadRuntimeData prefers dist/voxelmon/
// gamedata.json — the GAME section verbatim), so a Bun run records exactly
// what this entry replays on device.

import { fromObject } from "./data.ts";
import { VoxelmonGame } from "./game.ts";
import type { VoxelHost } from "./host.ts";

/** The story seed — apps/voxelmon/tapes/story.tape is plotted against it
 * (tools/voxel.ts STORY_SEED). A save system picks its own seed later. */
const SEED = 17;

/** The native surface pocketvoxel-psp registers before evaling this file. */
interface VoxelNative {
  gamedata(): string;
  stats(): void;
  reset(): void;
  mapShow(slot: number, mapId: number, ox: number, oy: number): void;
  mapHide(slot: number): void;
  cam(x: number, y: number): void;
  pitch(rung: number): void;
  tint(abgr: number): void;
  stamp(mapId: number, cx: number, cy: number, on: number): void;
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void;
  entHide(slot: number): void;
  emote(slot: number, kind: number): void;
  uiTile(x: number, y: number, tile: number): void;
  uiFill(x: number, y: number, w: number, h: number, tile: number): void;
  uiText(x: number, y: number, str: string): void;
  uiReveal(n: number): void;
  uiClear(): void;
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void;
  card(side: number, pic: number, x: number, y: number): void;
  cardHide(side: number): void;
  battleCam(orbit: number, pitch: number, zoom: number): void;
  arenaEnd(): void;
}

const native = (globalThis as unknown as { voxel: VoxelNative }).voxel;

/**
 * VoxelHost over the native surface: every op forwards 1:1. `frameDone` is
 * a no-op — the host advances the core Scene's tick clock itself, after
 * `frame(buttons)` returns (one guest turn per host tick).
 */
class QuickJsHost implements VoxelHost {
  gamedata(): ArrayBuffer | null {
    // The boot path below reads the GAME string directly; the game never
    // crosses for data again after construction.
    return null;
  }
  stats(): ArrayBuffer | null {
    native.stats();
    return null;
  }
  reset(): void {
    native.reset();
  }
  mapShow(slot: number, mapId: number, ox: number, oy: number): void {
    native.mapShow(slot, mapId, ox, oy);
  }
  mapHide(slot: number): void {
    native.mapHide(slot);
  }
  cam(x: number, y: number): void {
    native.cam(x, y);
  }
  pitch(rung: number): void {
    native.pitch(rung);
  }
  tint(abgr: number): void {
    native.tint(abgr);
  }
  stamp(mapId: number, cx: number, cy: number, on: number): void {
    native.stamp(mapId, cx, cy, on);
  }
  ent(
    slot: number,
    sheet: number,
    frame: number,
    x: number,
    y: number,
    lift: number,
    flags: number,
  ): void {
    native.ent(slot, sheet, frame, x, y, lift, flags);
  }
  entHide(slot: number): void {
    native.entHide(slot);
  }
  emote(slot: number, kind: number): void {
    native.emote(slot, kind);
  }
  uiTile(x: number, y: number, tile: number): void {
    native.uiTile(x, y, tile);
  }
  uiFill(x: number, y: number, w: number, h: number, tile: number): void {
    native.uiFill(x, y, w, h, tile);
  }
  uiText(x: number, y: number, str: string): void {
    native.uiText(x, y, str);
  }
  uiReveal(n: number): void {
    native.uiReveal(n);
  }
  uiClear(): void {
    native.uiClear();
  }
  arena(mapId: number, x: number, y: number, shape: number, rig: number): void {
    native.arena(mapId, x, y, shape, rig);
  }
  card(side: number, pic: number, x: number, y: number): void {
    native.card(side, pic, x, y);
  }
  cardHide(side: number): void {
    native.cardHide(side);
  }
  battleCam(orbit: number, pitch: number, zoom: number): void {
    native.battleCam(orbit, pitch, zoom);
  }
  arenaEnd(): void {
    native.arenaEnd();
  }
  frameDone(_tick: number, _buttons: number): void {
    // host-side: the EBOOT ticks the scene after frame() returns
  }
}

// ---- boot: one cold parse, then the guest owns the game ----
const source = JSON.parse(native.gamedata()) as Record<string, unknown>;
const game = new VoxelmonGame(fromObject(source), new QuickJsHost(), SEED);
game.newGame();

(globalThis as unknown as { frame: (buttons: number) => void }).frame = (
  buttons: number,
): void => {
  game.tick(buttons);
};
