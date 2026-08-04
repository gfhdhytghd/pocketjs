// Pocket Vapor RPG POC: compiler contract + a complete native GBA play tape.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";
import { compileVaporApp, type CompiledApp, VaporCompileError } from "../compiler/compile.ts";
import { buildGbaRom } from "../compiler/rom.ts";
import { Button } from "../host/input.ts";
import { defineRpgMap, rpgBlocked, rpgEventAt } from "../host/rpg.ts";

const HERE = import.meta.dir;
const ENTRY = join(HERE, "..", "examples", "rpg", "rpg.tsx");
const OUT = join(HERE, "..", "..", "dist", "vapor");
const ROM = join(OUT, "rpg.gba");
const RUNNER = join(HERE, "harness", "mgba_runner");
const ASSET_HEADER = join(HERE, "..", "runtime", "gba", "vapor_rpg_assets.generated.h");
const DEBUG_STATE = 0x02000010;

let source = "";
let app: CompiledApp;
let runReads: Record<string, string | number>;
let holdReads: Record<string, string | number>;
let repeatBoundaryX: number[];

function press(button: number): string {
  return `P ${(1 << button).toString(16)} 2 4`;
}

function stateAddress(name: string): number {
  const slot = app.debugSlots.find((candidate) => candidate.name === name);
  if (!slot) throw new Error(`missing debug slot ${name}`);
  return DEBUG_STATE + slot.offset;
}

function readState(lines: string[], label: string, names: readonly string[]): void {
  for (const name of names) {
    lines.push(`R ${label}_${name} 0x${stateAddress(name).toString(16)} 4`);
  }
}

function value(label: string, name: string): number {
  return runReads[`${label}_${name}`] as number;
}

function generatedWords(name: string): number[] {
  const header = readFileSync(ASSET_HEADER, "utf8");
  const match = header.match(new RegExp(`static const u16 ${name}\\[\\d+\\] = \\{([\\s\\S]*?)\\n\\};`));
  if (!match) throw new Error(`missing generated asset array ${name}`);
  return [...match[1].matchAll(/0x([0-9a-f]{4})/g)].map((word) => Number.parseInt(word[1], 16));
}

function littleEndianHex(words: number[]): string {
  return words.map((word) => `${(word & 0xff).toString(16).padStart(2, "0")}${(word >> 8).toString(16).padStart(2, "0")}`).join("");
}

async function countPpmColors(path: string): Promise<number> {
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const head = new TextDecoder().decode(bytes.slice(0, 64));
  const match = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!match) throw new Error(`not a P6 screenshot: ${path}`);
  const offset = match[0].length;
  const colors = new Set<string>();
  for (let i = offset; i + 2 < bytes.length; i += 3) {
    colors.add(`${bytes[i]},${bytes[i + 1]},${bytes[i + 2]}`);
  }
  return colors.size;
}

beforeAll(async () => {
  source = await Bun.file(ENTRY).text();
  app = compileVaporApp(ENTRY, source, "VAPOR QUEST", "gba");
  await buildGbaRom(app, ROM);
  if (!existsSync(RUNNER)) await $`bun ${join(HERE, "harness", "build.ts")}`.quiet();

  const state = [
    "mode",
    "playerX",
    "playerY",
    "facing",
    "quest",
    "dialog",
    "choice",
    "heroHp",
    "enemyHp",
    "battleCursor",
  ] as const;
  const worldShot = join(OUT, "rpg-world.ppm");
  const dialogShot = join(OUT, "rpg-dialog.ppm");
  const battleShot = join(OUT, "rpg-battle.ppm");
  const lines: string[] = ["A 8"];

  readState(lines, "boot", state);
  lines.push(`S ${worldShot}`);
  lines.push("D world_bg1 0x06004800 2048");
  lines.push("D world_oam 0x07000000 24");
  lines.push("D asset_bg_tiles 0x06008000 768");
  lines.push("D asset_obj_tiles 0x06010000 1792");
  lines.push("D asset_bg_palette 0x050001e0 32");
  lines.push("D asset_obj_palettes 0x05000200 96");

  // Walk into the north wall, then restore the spawn row.
  lines.push(press(Button.Up), press(Button.Up));
  readState(lines, "wall", ["playerX", "playerY", "facing"]);
  lines.push(press(Button.Down));

  // Stand west of the elder. Right is blocked by N but still turns the hero;
  // A then talks to the facing cell.
  lines.push(press(Button.Right), press(Button.Down), press(Button.Right), press(Button.A));
  readState(lines, "offer", ["mode", "playerX", "playerY", "facing", "quest", "dialog", "choice"]);
  lines.push(`S ${dialogShot}`);

  // Exercise NO with a long hold: repeats are world-only, so the two-choice
  // dialog must not toggle back and forth. Close, talk again, then accept YES.
  lines.push(`P ${(1 << Button.Down).toString(16)} 20 4`);
  readState(lines, "offerHeld", ["choice"]);
  lines.push(press(Button.A));
  readState(lines, "declined", ["mode", "quest", "dialog", "choice"]);
  lines.push(press(Button.A), press(Button.A), press(Button.A));
  readState(lines, "accepted", ["mode", "quest", "dialog", "choice"]);
  lines.push(press(Button.A));

  // Return to y=2 and walk east onto S at (8,2).
  lines.push(press(Button.Up));
  for (let i = 0; i < 5; i++) lines.push(press(Button.Right));
  readState(lines, "battle", ["mode", "playerX", "playerY", "quest", "heroHp", "enemyHp", "battleCursor"]);
  lines.push(`S ${battleShot}`);
  lines.push("D battle_bg1 0x06004800 2048");
  lines.push("D battle_oam 0x07000000 24");

  // HEAL once after another long hold; battle selection also ignores repeats.
  // Then ATTACK three times. Victory is a reactive dialog state.
  lines.push(`P ${(1 << Button.Down).toString(16)} 25 4`, press(Button.A));
  readState(lines, "healed", ["mode", "heroHp", "enemyHp", "battleCursor"]);
  lines.push(press(Button.Up), press(Button.A), press(Button.A), press(Button.A));
  readState(lines, "won", ["mode", "quest", "dialog", "heroHp", "enemyHp"]);
  lines.push(press(Button.A));

  // Return to the elder, turn into the solid NPC, report, and close.
  for (let i = 0; i < 5; i++) lines.push(press(Button.Left));
  lines.push(press(Button.Down), press(Button.Right), press(Button.A));
  readState(lines, "completeDialog", ["mode", "playerX", "playerY", "facing", "quest", "dialog"]);
  lines.push(press(Button.A));
  readState(lines, "complete", ["mode", "quest", "dialog"]);
  lines.push("R trips 0x0200000c 1");

  const scenario = join(OUT, "rpg-play-tape.txt");
  await Bun.write(scenario, `${lines.join("\n")}\n`);
  const output = await $`${RUNNER} ${ROM} ${scenario}`.text();
  const parsed = JSON.parse(output) as { ok: boolean; reads: Record<string, string | number> };
  expect(parsed.ok).toBe(true);
  runReads = parsed.reads;

  // A single held direction must move immediately, wait for the normalized
  // delay, then continue at the fixed repeat cadence. Releasing must stop it.
  const holdScenario = join(OUT, "rpg-hold-tape.txt");
  await Bun.write(
    holdScenario,
    [
      "A 8",
      `P ${(1 << Button.Right).toString(16)} 25 4`,
      `R held_x 0x${stateAddress("playerX").toString(16)} 4`,
      `R held_y 0x${stateAddress("playerY").toString(16)} 4`,
      `R held_facing 0x${stateAddress("facing").toString(16)} 4`,
      "A 30",
      `R released_x 0x${stateAddress("playerX").toString(16)} 4`,
      "R hold_trips 0x0200000c 1",
      "",
    ].join("\n"),
  );
  const holdOutput = await $`${RUNNER} ${ROM} ${holdScenario}`.text();
  const holdParsed = JSON.parse(holdOutput) as {
    ok: boolean;
    reads: Record<string, string | number>;
  };
  expect(holdParsed.ok).toBe(true);
  holdReads = holdParsed.reads;

  // Host video scheduling means setKeys() and the runtime input loop do not
  // share a frame boundary. Adjacent holds pin the first two observed repeats.
  repeatBoundaryX = [];
  for (const hold of [14, 15, 22, 23]) {
    const boundaryScenario = join(OUT, `rpg-hold-${hold}-tape.txt`);
    await Bun.write(
      boundaryScenario,
      [
        "A 8",
        `P ${(1 << Button.Right).toString(16)} ${hold} 4`,
        `R x 0x${stateAddress("playerX").toString(16)} 4`,
        "R trips 0x0200000c 1",
        "",
      ].join("\n"),
    );
    const boundaryOutput = await $`${RUNNER} ${ROM} ${boundaryScenario}`.text();
    const boundaryParsed = JSON.parse(boundaryOutput) as {
      ok: boolean;
      reads: Record<string, string | number>;
    };
    expect(boundaryParsed.ok).toBe(true);
    expect(boundaryParsed.reads.trips).toBe(0);
    repeatBoundaryX.push(boundaryParsed.reads.x as number);
  }
}, 120000);

describe("Pocket Vapor RPG host", () => {
  test("JS host queries share the map's collision and event semantics", () => {
    const map = defineRpgMap({
      rows: ["###", "#N#", "###"],
      solid: "#N",
      events: { N: 7 },
      dialogs: [],
    });
    expect(rpgBlocked(map, 1, 1)).toBe(true);
    expect(rpgBlocked(map, -1, 1)).toBe(true);
    expect(rpgEventAt(map, 1, 1)).toBe(7);
    expect(rpgEventAt(map, 1, 0)).toBe(0);
    expect(() =>
      defineRpgMap({ rows: ["..."], solid: "#", events: { N: 1 }, dialogs: [] }),
    ).toThrow("does not appear");
  });

  test("compiler emits ROM assets, pure queries, and one reactive native effect", () => {
    const again = compileVaporApp(ENTRY, source, "VAPOR QUEST", "gba");
    expect(again.c).toBe(app.c);
    expect(app.rpgEnabled).toBe(true);
    expect(app.c).toContain("const u8 vp_rpg_enabled = 1");
    expect(app.c).toContain("vp_rpg_blocked(&RPG_RPG_MAP");
    expect(app.c).toContain("vp_rpg_event_at(&RPG_RPG_MAP");
    expect(app.c).toContain("vp_rpg_render(&RPG_RPG_MAP");
    expect(app.c).toContain("SLIME BLOCKS EAST ROAD.");
    expect(app.graph).toContain("mode (num)");
    expect(app.graph).toContain("questActive:");
    expect(app.plan).toContain("RPG host RAM: 3076 B");
    expect(app.plan).toContain("RPG art: 24 BG tiles + 6 world and 2 battle OBJ frames, 4 palette banks; 2688 B ROM");
  });

  test("pixel RPG host is explicitly GBA-only", () => {
    expect(() => compileVaporApp(ENTRY, source, "VAPOR QUEST", "gb")).toThrow(VaporCompileError);
    expect(() => compileVaporApp(ENTRY, source, "VAPOR QUEST", "gb")).toThrow(/GBA/i);
  });

  test("compiler rejects malformed map assets and an incomplete screen contract", () => {
    const ragged = source.replace(
      '"##############################",',
      '"#############################",',
    );
    expect(() => compileVaporApp(ENTRY, ragged, "VAPOR QUEST", "gba")).toThrow(/equal width/);

    const missingEventTile = source.replace("N: Event.Elder,", "Z: Event.Elder,");
    expect(() => compileVaporApp(ENTRY, missingEventTile, "VAPOR QUEST", "gba")).toThrow(
      /does not occur/,
    );

    const missingProp = source.replace("        battleCursor={battleCursor.value}\n", "");
    expect(() => compileVaporApp(ENTRY, missingProp, "VAPOR QUEST", "gba")).toThrow(
      /missing required prop "battleCursor"/,
    );
  });
});

describe("native GBA RPG play tape", () => {
  test("holding a direction repeats world movement and release stops it", () => {
    expect([holdReads.held_x, holdReads.held_y, holdReads.held_facing]).toEqual([5, 2, 3]);
    expect(holdReads.released_x).toBe(5);
    expect(holdReads.hold_trips).toBe(0);
  });

  test("libmGBA pacing crosses the first two held-movement repeat boundaries", () => {
    expect(repeatBoundaryX).toEqual([3, 4, 4, 5]);
  });

  test("collision turns without moving and A opens the elder offer", () => {
    expect([value("boot", "mode"), value("boot", "playerX"), value("boot", "playerY")]).toEqual([0, 2, 2]);
    expect([value("wall", "playerX"), value("wall", "playerY"), value("wall", "facing")]).toEqual([2, 1, 1]);
    expect([
      value("offer", "mode"),
      value("offer", "playerX"),
      value("offer", "playerY"),
      value("offer", "facing"),
      value("offer", "quest"),
      value("offer", "dialog"),
    ]).toEqual([1, 3, 3, 3, 0, 1]);
  });

  test("choice, quest gate, heal, battle, and report form one complete loop", () => {
    expect(value("offerHeld", "choice")).toBe(1);
    expect([value("declined", "quest"), value("declined", "dialog")]).toEqual([0, 3]);
    expect([value("accepted", "mode"), value("accepted", "quest"), value("accepted", "dialog")]).toEqual([1, 1, 2]);
    expect([
      value("battle", "mode"),
      value("battle", "playerX"),
      value("battle", "playerY"),
      value("battle", "quest"),
      value("battle", "heroHp"),
      value("battle", "enemyHp"),
    ]).toEqual([2, 8, 2, 1, 30, 18]);
    expect([value("healed", "heroHp"), value("healed", "enemyHp"), value("healed", "battleCursor")]).toEqual([26, 18, 1]);
    expect([
      value("won", "mode"),
      value("won", "quest"),
      value("won", "dialog"),
      value("won", "heroHp"),
      value("won", "enemyHp"),
    ]).toEqual([1, 2, 4, 18, 0]);
    expect([
      value("completeDialog", "mode"),
      value("completeDialog", "playerX"),
      value("completeDialog", "playerY"),
      value("completeDialog", "facing"),
      value("completeDialog", "quest"),
      value("completeDialog", "dialog"),
    ]).toEqual([1, 3, 3, 3, 3, 5]);
    expect([value("complete", "mode"), value("complete", "quest"), value("complete", "dialog")]).toEqual([0, 3, 0]);
    expect(runReads.trips).toBe(0);
  });

  test("world, dialog, and battle produce distinct multi-color hardware frames", async () => {
    const paths = ["rpg-world.ppm", "rpg-dialog.ppm", "rpg-battle.ppm"].map((name) => join(OUT, name));
    const frames = await Promise.all(paths.map((path) => Bun.file(path).arrayBuffer()));
    expect(new Set(frames.map((bytes) => Bun.hash(new Uint8Array(bytes)).toString())).size).toBe(3);
    for (const path of paths) expect(await countPpmColors(path)).toBeGreaterThanOrEqual(8);
    expect(runReads.world_bg1).not.toBe(runReads.battle_bg1);
    expect(runReads.world_oam).not.toBe(runReads.battle_oam);
  });

  test("generated 4bpp art and palettes arrive in the exact GBA VRAM banks", () => {
    expect(runReads.asset_bg_tiles).toBe(littleEndianHex(generatedWords("vp_rpg_bg_tiles")));
    expect(runReads.asset_obj_tiles).toBe(littleEndianHex(generatedWords("vp_rpg_obj_tiles")));
    expect(runReads.asset_bg_palette).toBe(littleEndianHex(generatedWords("vp_rpg_bg_palette")));
    expect(runReads.asset_obj_palettes).toBe(littleEndianHex(generatedWords("vp_rpg_obj_palettes")));
  });
});
