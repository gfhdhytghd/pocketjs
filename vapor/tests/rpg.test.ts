// Pocket Vapor RPG POC: compiler contract + a complete native GBA play tape.

import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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
const DEBUG_STATE = 0x02000010;

let source = "";
let app: CompiledApp;
let runReads: Record<string, string | number>;

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

  // Walk into the north wall, then restore the spawn row.
  lines.push(press(Button.Up), press(Button.Up));
  readState(lines, "wall", ["playerX", "playerY", "facing"]);
  lines.push(press(Button.Down));

  // Stand west of the elder. Right is blocked by N but still turns the hero;
  // A then talks to the facing cell.
  lines.push(press(Button.Right), press(Button.Down), press(Button.Right), press(Button.A));
  readState(lines, "offer", ["mode", "playerX", "playerY", "facing", "quest", "dialog", "choice"]);
  lines.push(`S ${dialogShot}`);

  // Exercise NO, close, talk again, then accept YES.
  lines.push(press(Button.Down), press(Button.A));
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

  // HEAL once, then ATTACK three times. Victory is a reactive dialog state.
  lines.push(press(Button.Down), press(Button.A));
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
    expect(app.c).toContain("SLIME BLOCKS THE EAST ROAD.");
    expect(app.graph).toContain("mode (num)");
    expect(app.graph).toContain("questActive:");
    expect(app.plan).toContain("RPG host RAM: 3076 B");
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
});
