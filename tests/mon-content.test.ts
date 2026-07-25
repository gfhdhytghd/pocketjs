// SPARKWOOD content integrity (docs/MON.md).
//
// The cooker turns TypeScript into a binary the Rust core reads in one linear
// pass with no validation beyond bounds checks. Anything wrong with the
// content therefore shows up on a PSP as a creature with no moves or a door
// that goes nowhere — a long way from the edit that caused it. These tests
// close that distance.
//
// The first test is the one that matters most: the runtime is a clean-room
// port, and nothing in it may grow a path that reads a ROM.

import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { assembleScript, cook } from "../apps/mon/cook.ts";
import { CAST } from "../apps/mon/art/actors.ts";
import { characters, FONT, GLYPH_H, GLYPH_W } from "../apps/mon/art/font.ts";
import { BLOCK_TILES, TILE_ART, TILE_BEHAVIOR } from "../apps/mon/art/tiles.ts";
import {
  blocksOf,
  buildText,
  ITEMS,
  MAPS,
  MATCHUPS,
  MOVES,
  SCRIPTS,
  SPECIES,
  TRAINERS,
  TYPE_NAMES,
  VERB,
} from "../apps/mon/content/game.ts";
import { MONPAK_HEADER_SIZE, MONPAK_MAGIC, SLOT_COUNT } from "../contracts/spec/mon-spec.ts";
import { TextTable } from "../apps/mon/content/text.ts";

const root = new URL("..", import.meta.url).pathname;

// ---------------------------------------------------------------------------
// The clean-room boundary
// ---------------------------------------------------------------------------

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

test("the runtime has no path that reads a ROM", () => {
  // docs/MON.md §1: the upstream project reconstructs its content by decoding
  // a Game Boy ROM. This port has no counterpart to that layer and must never
  // grow one — the whole legal and design premise rests on it.
  const sources = [
    ...walk(join(root, "apps/mon")),
    ...walk(join(root, "engine/pocketmon")),
  ].filter((p) => /\.(ts|rs)$/.test(p) && !p.includes("/target/"));

  expect(sources.length).toBeGreaterThan(10);

  // Patterns that would indicate a ROM path. Prose in comments is allowed —
  // the docs discuss the boundary — so this looks for code shapes.
  const forbidden: Array<[RegExp, string]> = [
    [/\.gb['"`]/, "a .gb file extension"],
    [/\.gbc['"`]/, "a .gbc file extension"],
    [/sha1|sha-1/i, "a SHA-1 check (the upstream ROM gate)"],
    [/\bpokered\b/i, "a reference to a disassembly source tree"],
  ];
  const findings: string[] = [];
  for (const path of sources) {
    const text = readFileSync(path, "utf8");
    for (const [pattern, what] of forbidden) {
      if (pattern.test(text)) findings.push(`${path.replace(root, "")}: ${what}`);
    }
  }
  expect(findings).toEqual([]);
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("cooking twice produces identical bytes", () => {
  // The PSP goldens hash a pak built on whatever machine ran CI. Procedural
  // art plus an interning text table gives plenty of room for iteration order
  // to leak in; this is the guard.
  const a = cook();
  const b = cook();
  expect(a.length).toBe(b.length);
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
});

test("the pak has a well-formed header and section table", () => {
  const pak = cook();
  const dv = new DataView(pak.buffer, pak.byteOffset, pak.byteLength);
  expect(dv.getUint32(0, true)).toBe(MONPAK_MAGIC);
  const sections = dv.getUint16(6, true);
  expect(sections).toBeGreaterThan(5);
  expect(dv.getUint32(8, true)).toBe(pak.length);

  // Every section must lie inside the blob and not overlap the table.
  const tableEnd = MONPAK_HEADER_SIZE + sections * 16;
  for (let i = 0; i < sections; i++) {
    const at = MONPAK_HEADER_SIZE + i * 16;
    const offset = dv.getUint32(at + 4, true);
    const length = dv.getUint32(at + 8, true);
    expect(offset).toBeGreaterThanOrEqual(tableEnd);
    expect(offset + length).toBeLessThanOrEqual(pak.length);
  }
});

// ---------------------------------------------------------------------------
// Referential integrity
// ---------------------------------------------------------------------------

test("every learnset move exists", () => {
  const known = new Set(MOVES.map((m) => m.id));
  for (const s of SPECIES) {
    for (const [level, move] of s.learnset) {
      expect(known.has(move)).toBe(true);
      expect(level).toBeGreaterThan(0);
      expect(level).toBeLessThanOrEqual(100);
    }
  }
});

test("every species can act at level five", () => {
  // A starter with no level-1 move would stand there doing nothing, which is
  // the least debuggable possible first impression.
  for (const s of SPECIES) {
    const early = s.learnset.filter(([level]) => level <= 5);
    expect(early.length).toBeGreaterThan(0);
  }
});

test("evolutions point at real species and go forward", () => {
  const byId = new Map(SPECIES.map((s) => [s.id, s]));
  for (const s of SPECIES) {
    if (s.evolveInto === undefined) continue;
    const into = byId.get(s.evolveInto);
    expect(into).toBeDefined();
    expect(s.evolveLevel).toBeGreaterThan(1);
    // An evolution that is not an improvement is a content bug, not a design.
    const before = s.hp + s.atk + s.def + s.spd + s.spc;
    const after = into!.hp + into!.atk + into!.def + into!.spd + into!.spc;
    expect(after).toBeGreaterThan(before);
  }
});

test("no species evolves into itself, directly or in a cycle", () => {
  const byId = new Map(SPECIES.map((s) => [s.id, s]));
  for (const start of SPECIES) {
    const seen = new Set<number>([start.id]);
    let cur = start;
    while (cur.evolveInto !== undefined) {
      expect(seen.has(cur.evolveInto)).toBe(false);
      seen.add(cur.evolveInto);
      const next = byId.get(cur.evolveInto);
      if (!next) break;
      cur = next;
    }
  }
});

test("every type matchup names a real type", () => {
  for (const [atk, def, mult] of MATCHUPS) {
    expect(atk).toBeLessThan(TYPE_NAMES.length);
    expect(def).toBeLessThan(TYPE_NAMES.length);
    // x10 fixed point: 0 (immune), 5 (resisted), 20 (super effective).
    expect([0, 5, 20]).toContain(mult);
  }
});

test("the type chart is not one-sided", () => {
  // Every type should be able to hit something hard and take something badly,
  // or it is either useless or an auto-pick.
  for (let t = 0; t < TYPE_NAMES.length; t++) {
    const strongAgainst = MATCHUPS.some(([a, , m]) => a === t && m > 10);
    const weakTo = MATCHUPS.some(([, d, m]) => d === t && m > 10);
    if (TYPE_NAMES[t] === "NORMAL") continue; // deliberately plain
    expect(strongAgainst || weakTo).toBe(true);
  }
});

test("every move a trainer fields is real and learnable-shaped", () => {
  const moves = new Set(MOVES.map((m) => m.id));
  const species = new Set(SPECIES.map((s) => s.id));
  for (const t of TRAINERS) {
    expect(t.party.length).toBeGreaterThan(0);
    for (const p of t.party) {
      expect(species.has(p.species)).toBe(true);
      expect(p.level).toBeGreaterThan(0);
      const real = p.moves.filter((m) => m !== 0);
      expect(real.length).toBeGreaterThan(0);
      for (const m of real) expect(moves.has(m)).toBe(true);
    }
  }
});

test("every encounter slot names a real species", () => {
  const species = new Set(SPECIES.map((s) => s.id));
  for (const m of MAPS) {
    if (!m.slots) continue;
    expect(m.slots.length).toBe(SLOT_COUNT);
    for (const [id, level] of m.slots) {
      expect(species.has(id)).toBe(true);
      expect(level).toBeGreaterThan(0);
    }
  }
});

test("a map with encounter slots has a non-zero rate, and vice versa", () => {
  for (const m of MAPS) {
    const hasSlots = (m.slots?.length ?? 0) > 0;
    const hasRate = (m.encounterRate ?? 0) > 0;
    expect(hasSlots).toBe(hasRate);
  }
});

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

test("every map is rectangular and uses known blocks", () => {
  for (const m of MAPS) {
    const widths = new Set(m.rows.map((r) => r.length));
    expect(widths.size).toBe(1);
    const { w, h, blocks } = blocksOf(m);
    expect(blocks.length).toBe(w * h);
    for (const b of blocks) expect(BLOCK_TILES[b]).toBeDefined();
  }
});

test("every warp lands on a real map and a real warp index", () => {
  const byId = new Map(MAPS.map((m) => [m.id, m]));
  for (const m of MAPS) {
    for (const warp of m.warps ?? []) {
      const dest = byId.get(warp.destMap);
      expect(dest).toBeDefined();
      const destWarps = dest!.warps ?? [];
      expect(destWarps.length).toBeGreaterThan(warp.destWarp);
    }
  }
});

test("every warp sits on a cell whose block actually has a door", () => {
  // The bottom-left-tile rule means a door tile only counts if it is at the
  // block-relative position the collision check reads. A warp on a cell with
  // no door under it is a player standing on solid ground wondering why
  // nothing happens.
  const doorTiles = new Set(
    Object.entries(TILE_BEHAVIOR)
      .filter(([, behavior]) => behavior === 4 /* door */ || behavior === 5 /* warp */)
      .map(([id]) => Number(id)),
  );
  for (const m of MAPS) {
    const { w, blocks } = blocksOf(m);
    for (const warp of m.warps ?? []) {
      const bx = Math.floor(warp.x / 2);
      const by = Math.floor(warp.y / 2);
      const block = blocks[by * w + bx];
      expect(block).toBeDefined();
      const tiles = BLOCK_TILES[block!]!;
      // Cell (cx % 2, cy % 2) reads tile (2 * (cx % 2), 2 * (cy % 2) + 1).
      const tx = 2 * (warp.x % 2);
      const ty = 2 * (warp.y % 2) + 1;
      const tile = tiles[ty * 4 + tx]!;
      expect(doorTiles.has(tile)).toBe(true);
    }
  }
});

test("map connections are declared from both sides", () => {
  const byId = new Map(MAPS.map((m) => [m.id, m]));
  // north/south and west/east are indices 0/1 and 2/3.
  const opposite = [1, 0, 3, 2];
  for (const m of MAPS) {
    const conn = m.conn ?? [-1, -1, -1, -1];
    for (let side = 0; side < 4; side++) {
      const id = conn[side]!;
      if (id < 0) continue;
      const other = byId.get(id);
      expect(other).toBeDefined();
      const back = (other!.conn ?? [-1, -1, -1, -1])[opposite[side]!];
      expect(back).toBe(m.id);
    }
  }
});

test("connection offsets are mirrored, so a seam does not drift", () => {
  const byId = new Map(MAPS.map((m) => [m.id, m]));
  const opposite = [1, 0, 3, 2];
  for (const m of MAPS) {
    const conn = m.conn ?? [-1, -1, -1, -1];
    const off = m.connOff ?? [0, 0, 0, 0];
    for (let side = 0; side < 4; side++) {
      if (conn[side]! < 0) continue;
      const other = byId.get(conn[side]!)!;
      const back = (other.connOff ?? [0, 0, 0, 0])[opposite[side]!]!;
      // Walking across and back must land on the cell you left. Summing
      // rather than negating: JavaScript's -0 is not `toBe` 0.
      expect(back + off[side]!).toBe(0);
    }
  }
});

test("every actor that names a script has one", () => {
  const names = new Set(SCRIPTS.map((s) => s.name));
  for (const m of MAPS) {
    for (const a of m.actors ?? []) {
      if (a.script) expect(names.has(a.script)).toBe(true);
      // An actor is either a talker, a script, or a trainer — never silent.
      const speaks = Boolean(a.script || a.text || (a.trainer ?? -1) >= 0);
      expect(speaks).toBe(true);
    }
  }
});

test("every actor sprite exists in the cast", () => {
  for (const m of MAPS) {
    for (const a of m.actors ?? []) {
      expect(a.sprite).toBeLessThan(CAST.length);
    }
  }
});

test("every trainer an actor references exists", () => {
  const ids = new Set(TRAINERS.map((t) => t.id));
  for (const m of MAPS) {
    for (const a of m.actors ?? []) {
      if ((a.trainer ?? -1) >= 0) expect(ids.has(a.trainer!)).toBe(true);
    }
  }
});

// ---------------------------------------------------------------------------
// Scripts
// ---------------------------------------------------------------------------

test("every script assembles and ends", () => {
  const text = new TextTable();
  for (const s of SCRIPTS) {
    const bytes = assembleScript(s.rows, text);
    expect(bytes.length).toBeGreaterThan(8);
    // The last reachable instruction of every branch should be `end`; at
    // minimum the script must contain one, or the VM runs off the end.
    expect(s.rows.some((r) => r[0] === VERB.end)).toBe(true);
  }
});

test("every jump names a label the script declares", () => {
  for (const s of SCRIPTS) {
    const labels = new Set(
      s.rows.filter((r) => r[0] === VERB.label).map((r) => r[1] as string),
    );
    for (const row of s.rows) {
      for (const arg of row.slice(1)) {
        if (typeof arg === "object" && arg !== null && "label" in arg) {
          expect(labels.has((arg as { label: string }).label)).toBe(true);
        }
      }
    }
  }
});

test("assembling is deterministic", () => {
  const a = assembleScript(SCRIPTS[0]!.rows, new TextTable());
  const b = assembleScript(SCRIPTS[0]!.rows, new TextTable());
  expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
});

// ---------------------------------------------------------------------------
// Art
// ---------------------------------------------------------------------------

test("every tile is eight by eight characters", () => {
  for (const [id, rows] of Object.entries(TILE_ART)) {
    expect(rows.length).toBe(8);
    for (const row of rows) {
      expect(row.length).toBe(8);
    }
    // Every drawn tile needs a behaviour, or it silently becomes a wall.
    expect(TILE_BEHAVIOR[Number(id)]).toBeDefined();
  }
});

test("every block references drawn tiles", () => {
  const drawn = new Set(Object.keys(TILE_ART).map(Number));
  for (const tiles of Object.values(BLOCK_TILES)) {
    expect(tiles.length).toBe(16);
    for (const t of tiles) expect(drawn.has(t)).toBe(true);
  }
});

test("every font glyph is the declared size", () => {
  for (const [ch, rows] of Object.entries(FONT)) {
    expect(rows.length).toBe(GLYPH_H);
    for (const row of rows) {
      expect(row.length).toBe(GLYPH_W);
      expect(/^[.#]*$/.test(row)).toBe(true);
    }
    expect(ch.length).toBeGreaterThan(0);
  }
});

test("the font covers everything the content writes", () => {
  // A missing glyph is invisible on screen and impossible to spot in a diff.
  const covered = new Set(characters());
  const strings: string[] = [
    ...SPECIES.flatMap((s) => [s.name, s.dex]),
    ...MOVES.flatMap((m) => [m.name, m.desc]),
    ...ITEMS.flatMap((i) => [i.name, i.desc]),
    ...TYPE_NAMES,
    ...MAPS.map((m) => m.name),
    ...MAPS.flatMap((m) => (m.signs ?? []).map((s) => s.text)),
    ...MAPS.flatMap((m) => (m.actors ?? []).map((a) => a.text ?? "")),
    ...TRAINERS.flatMap((t) => [t.name, t.intro, t.defeat]),
    ...SCRIPTS.flatMap((s) =>
      s.rows.flatMap((r) => r.slice(1).filter((a): a is string => typeof a === "string")),
    ),
  ];
  const missing = new Set<string>();
  for (const s of strings) {
    for (const ch of s) {
      // Control codes are handled by the text engine, not the font.
      if (ch === "\n" || ch === "" || ch === "") continue;
      if (!covered.has(ch)) missing.add(ch);
    }
  }
  expect([...missing].sort()).toEqual([]);
});

test("the text table interns and never hands out a duplicate key", () => {
  const t = new TextTable();
  expect(t.key("")).toBe(0);
  const a = t.key("HELLO");
  expect(t.key("HELLO")).toBe(a);
  expect(t.key("WORLD")).not.toBe(a);
  expect(t.all()[a]).toBe("HELLO");
});

test("the built text table covers every id the records reference", () => {
  const built = buildText();
  const size = built.text.size;
  const keys = [
    ...built.speciesNameKeys,
    ...built.speciesDexKeys,
    ...built.moveNameKeys,
    ...built.itemNameKeys,
    ...built.mapNameKeys,
    ...built.trainerNameKeys,
    ...built.scriptKeys.values(),
  ];
  for (const k of keys) {
    expect(k).toBeGreaterThanOrEqual(0);
    expect(k).toBeLessThan(size);
  }
  expect(new Set(built.scriptKeys.values()).size).toBe(SCRIPTS.length);
});
