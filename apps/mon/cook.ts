// The SPARKWOOD content cooker: TypeScript game data + procedural art -> one
// MONPAK blob the Rust core parses in a single linear pass.
//
// Run:  bun apps/mon/cook.ts [out.monpak]
//
// This file is the whole "content pipeline" the upstream project spends its
// `src/import/` directory on — except the input is source, not a ROM, so
// there is no verification gate, no private cache, and no first-boot wizard
// (docs/MON.md §1).
//
// Determinism is a hard requirement: the same checkout must produce a
// byte-identical pak on every machine, because the PSP goldens hash it.
// Nothing here reads the clock, the environment or an unseeded RNG.

import {
  MONPAK_ALIGN,
  MONPAK_HEADER_SIZE,
  MONPAK_MAGIC,
  MONPAK_TAG,
  MONPAK_VERSION,
  SCRIPT_VERSION,
  SLOT_COUNT,
} from "../../contracts/spec/mon-spec.ts";
import { CAST, drawCast, SPRITE_PX } from "./art/actors.ts";
import { encodeTrack, SFX, SONGS } from "./content/music.ts";
import { drawCreature, PORTRAIT_PX } from "./art/creatures.ts";
import { advanceOf, CELL as FONT_CELL, characters, rasterize } from "./art/font.ts";
import { PAL, packPalette } from "./art/palette.ts";
import { Surface } from "./art/raster.ts";
import { behaviorTable, BLOCK_TILES, rasterizeTile, TILE_ART } from "./art/tiles.ts";
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
  TYPE_CATEGORY,
  TYPE_NAMES,
  VERB,
  type MapSpec,
  type Row,
} from "./content/game.ts";
import type { TextTable } from "./content/text.ts";

const PAGE_PX = 256;

/** Atlas page assignments. `scene.rs` hard-codes 0, 1 and 2+; the font page
 *  travels in the FONT header, so it only has to agree with itself. */
const PAGE = { tiles: 0, actors: 1, portraitFirst: 2, portraitCount: 2, font: 4 } as const;

// ---------------------------------------------------------------------------
// Byte writer
// ---------------------------------------------------------------------------

class Writer {
  private buf: Uint8Array;
  private view: DataView;
  private len = 0;

  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private need(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  get length(): number {
    return this.len;
  }

  u8(v: number): this {
    this.need(1);
    this.view.setUint8(this.len, v & 0xff);
    this.len += 1;
    return this;
  }

  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.len, v & 0xffff, true);
    this.len += 2;
    return this;
  }

  i16(v: number): this {
    this.need(2);
    this.view.setInt16(this.len, v, true);
    this.len += 2;
    return this;
  }

  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.len, v >>> 0, true);
    this.len += 4;
    return this;
  }

  i32(v: number): this {
    this.need(4);
    this.view.setInt32(this.len, v | 0, true);
    this.len += 4;
    return this;
  }

  bytes(b: Uint8Array): this {
    this.need(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
    return this;
  }

  /** Pad to a multiple of `n`. */
  align(n: number): this {
    while (this.len % n !== 0) this.u8(0);
    return this;
  }

  /** Overwrite a u32 already written (offset back-patching). */
  patchU32(at: number, v: number): void {
    this.view.setUint32(at, v >>> 0, true);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.len).slice();
  }
}

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

/** Build every atlas page, in page order. */
function buildPages(): Surface[] {
  const pages: Surface[] = [];

  // --- page 0: terrain tiles, 32 per row -------------------------------
  const tiles = new Surface(PAGE_PX, PAGE_PX);
  for (const key of Object.keys(TILE_ART)) {
    const id = Number(key);
    const px = rasterizeTile(id);
    const ox = (id % 32) * 8;
    const oy = Math.floor(id / 32) * 8;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) tiles.set(ox + x, oy + y, px[y * 8 + x]!);
    }
  }
  pages.push(tiles);

  // --- page 1: actor walk sheets ---------------------------------------
  pages.push(drawCast());

  // --- pages 2..: creature portraits, 4x4 per page ----------------------
  const portraits: Surface[] = [];
  for (let i = 0; i < PAGE.portraitCount; i++) portraits.push(new Surface(PAGE_PX, PAGE_PX));
  SPECIES.forEach((s, i) => {
    for (const [view, back] of [
      [0, false],
      [1, true],
    ] as const) {
      const index = i * 2 + view;
      const page = Math.floor(index / 16);
      if (page >= portraits.length) return;
      const within = index % 16;
      const ox = (within % 4) * PORTRAIT_PX;
      const oy = Math.floor(within / 4) * PORTRAIT_PX;
      drawCreature({ plan: s.plan, type: s.type1, size: s.size }, back).blitInto(
        portraits[page]!,
        ox,
        oy,
      );
    }
  });
  pages.push(...portraits);

  // --- page 4: the font -------------------------------------------------
  const font = new Surface(PAGE_PX, PAGE_PX);
  const chars = characters();
  chars.forEach((ch, i) => {
    const ox = (i % 32) * FONT_CELL;
    const oy = Math.floor(i / 32) * FONT_CELL;
    const cell = rasterize(ch, PAL.ink);
    for (let y = 0; y < FONT_CELL; y++) {
      for (let x = 0; x < FONT_CELL; x++) font.set(ox + x, oy + y, cell[y * FONT_CELL + x]!);
    }
  });
  pages.push(font);

  return pages;
}

function sectionAtlas(pages: Surface[]): Uint8Array {
  const w = new Writer(1 << 19);
  w.u16(pages.length).u16(0);
  for (const p of pages) {
    w.u16(p.w).u16(p.h).u32(p.px.length).bytes(p.px).align(4);
  }
  return w.finish();
}

function sectionFont(): Uint8Array {
  const w = new Writer();
  const chars = characters();
  w.u16(chars.length).u8(FONT_CELL).u8(PAGE.font);
  chars.forEach((ch, i) => {
    const ox = (i % 32) * FONT_CELL;
    const oy = Math.floor(i / 32) * FONT_CELL;
    w.u32(ch.codePointAt(0) ?? 32)
      .u16(ox)
      .u16(oy)
      .u8(FONT_CELL)
      .u8(FONT_CELL)
      .u8(advanceOf(ch))
      .u8(0);
  });
  return w.finish();
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function sectionTilesets(): Uint8Array {
  const w = new Writer();
  w.u16(1).u16(0); // one tileset
  const ids = Object.keys(BLOCK_TILES).map(Number).sort((a, b) => a - b);
  const count = (ids[ids.length - 1] ?? 0) + 1;
  w.u16(count).u16(0);
  for (let id = 0; id < count; id++) {
    const tiles = BLOCK_TILES[id] ?? Array.from({ length: 16 }, () => 0);
    for (let i = 0; i < 16; i++) w.u8(tiles[i] ?? 0);
  }
  w.bytes(behaviorTable());
  return w.finish();
}

function sectionTypes(text: TextTable): Uint8Array {
  const w = new Writer();
  w.u16(TYPE_NAMES.length).u16(MATCHUPS.length);
  for (let i = 0; i < TYPE_NAMES.length; i++) {
    w.u8(TYPE_CATEGORY[i] ?? 0).u8(0).u16(text.key(TYPE_NAMES[i]!));
  }
  for (const [atk, def, mult] of MATCHUPS) w.u8(atk).u8(def).u16(mult);
  return w.finish();
}

function sectionSpecies(text: TextTable): Uint8Array {
  // The learnset pool is shared: every species points at a slice of it.
  const pool: Array<[number, number]> = [];
  const offsets: number[] = [];
  for (const s of SPECIES) {
    offsets.push(pool.length);
    for (const entry of s.learnset) pool.push(entry);
  }

  const w = new Writer();
  w.u16(SPECIES.length).u16(pool.length);
  SPECIES.forEach((s, i) => {
    w.u16(s.id)
      .u8(s.hp)
      .u8(s.atk)
      .u8(s.def)
      .u8(s.spd)
      .u8(s.spc)
      .u8(s.type1)
      .u8(s.type2 ?? s.type1)
      .u8(s.catchRate)
      .u16(s.baseExp)
      .u8(s.growth)
      .u8(i * 2) // front portrait index
      .u8(i * 2 + 1) // back portrait index
      .u8(i * 2) // icon reuses the front cell
      .u16(text.key(s.name))
      .u16(text.key(s.dex))
      .u8(s.learnset.length)
      .u8(s.evolveInto ? 1 : 0) // evolve::LEVEL
      .u16(s.evolveLevel ?? 0)
      .u16(s.evolveInto ?? 0)
      .u16(offsets[i]!)
      .u32(0);
  });
  for (const [level, move] of pool) w.u16(level).u16(move);
  return w.finish();
}

function sectionMoves(text: TextTable): Uint8Array {
  const w = new Writer();
  w.u16(MOVES.length).u16(0);
  for (const m of MOVES) {
    w.u16(m.id)
      .u8(m.type)
      .u8(m.power)
      .u8(m.accuracy)
      .u8(m.pp)
      // No explicit category means "decide by type", which the core spells as
      // the type's own category — so write that rather than a sentinel.
      .u8(m.category ?? TYPE_CATEGORY[m.type] ?? 0)
      .u8(m.effect ?? 0)
      .u8(m.chance ?? 0)
      .u8(m.flags ?? 0)
      .u16(text.key(m.name))
      .u16(text.key(m.desc))
      .u16(0);
  }
  return w.finish();
}

function sectionItems(text: TextTable): Uint8Array {
  const w = new Writer();
  w.u16(ITEMS.length).u16(0);
  for (const it of ITEMS) {
    w.u16(it.id)
      .u16(text.key(it.name))
      .u16(text.key(it.desc))
      .u8(it.kind)
      .u8(it.param)
      .u16(it.price)
      .u16(0);
  }
  return w.finish();
}

function sectionMaps(text: TextTable, scriptKeys: Map<string, number>): Uint8Array {
  const w = new Writer(1 << 16);
  w.u16(MAPS.length).u16(0);
  const tableAt = w.length;
  for (let i = 0; i < MAPS.length; i++) w.u32(0); // patched below

  MAPS.forEach((m, i) => {
    w.align(4);
    w.patchU32(tableAt + i * 4, w.length);
    const { w: bw, h: bh, blocks } = blocksOf(m);
    const warps = m.warps ?? [];
    const signs = m.signs ?? [];
    const actors = m.actors ?? [];
    const slots = m.slots ?? [];
    if (slots.length !== 0 && slots.length !== SLOT_COUNT) {
      throw new Error(`map ${m.name}: needs exactly ${SLOT_COUNT} encounter slots`);
    }
    const conn = m.conn ?? [-1, -1, -1, -1];
    const connOff = m.connOff ?? [0, 0, 0, 0];

    w.u16(m.id)
      .u8(bw)
      .u8(bh)
      .u8(m.tileset ?? 0)
      .u8(m.border)
      .u8(m.indoor ? 1 : 0)
      .u8(m.encounterRate ?? 0)
      .u16(text.key(m.name))
      .u16(m.music ?? 0)
      .u8(warps.length)
      .u8(signs.length)
      .u8(actors.length)
      .u8(slots.length);
    for (const c of conn) w.i16(c);
    for (const o of connOff) w.i16(o);

    for (const b of blocks) w.u8(b);
    for (const p of warps) w.u8(p.x).u8(p.y).u16(p.destMap).u8(p.destWarp).u8(p.dir).u16(0);
    for (const s of signs) w.u8(s.x).u8(s.y).u16(text.key(s.text));
    for (const a of actors) {
      // An actor's text key doubles as its script key: the core's talk
      // dispatch looks for a script filed under exactly this id first.
      const key = a.script
        ? scriptKeys.get(a.script) ??
          (() => {
            throw new Error(`actor references unknown script '${a.script}'`);
          })()
        : a.text
          ? text.key(a.text)
          : 0;
      w.u8(a.x)
        .u8(a.y)
        .u8(a.dir)
        .u8(a.behavior)
        .u8(a.sprite)
        .u8(0)
        .u16(key)
        .i16(a.trainer ?? -1)
        .u16(a.flagGate ?? 0xffff);
    }
    for (const [species, level] of slots) w.u16(species).u8(level).u8(0);
  });
  return w.finish();
}

function sectionTrainers(text: TextTable): Uint8Array {
  const w = new Writer();
  w.u16(TRAINERS.length).u16(0);
  const tableAt = w.length;
  for (let i = 0; i < TRAINERS.length; i++) w.u32(0);
  TRAINERS.forEach((t, i) => {
    w.align(4);
    w.patchU32(tableAt + i * 4, w.length);
    w.u16(t.id).u16(text.key(t.name)).u8(t.aiClass).u8(t.party.length).u16(t.reward);
    for (const p of t.party) {
      w.u16(p.species).u8(p.level).u8(0);
      for (let k = 0; k < 4; k++) w.u16(p.moves[k] ?? 0);
    }
  });
  return w.finish();
}

/**
 * Assemble one script into the VM's bytecode.
 *
 * Two passes: the first sizes every row so labels can resolve to byte offsets,
 * the second emits. Label *rows* are emitted too (as a zero-argument no-op) so
 * a row index maps one-to-one onto an instruction, which keeps the offsets
 * honest and the disassembly readable.
 */
export function assembleScript(rows: Row[], text: TextTable): Uint8Array {
  const labelNames: string[] = [];
  const labelRow = new Map<string, number>();
  rows.forEach((row, i) => {
    if (row[0] === VERB.label) {
      const name = row[1];
      if (typeof name !== "string") throw new Error("label rows need a name");
      if (labelRow.has(name)) throw new Error(`duplicate label '${name}'`);
      labelRow.set(name, i);
      labelNames.push(name);
    }
  });
  const labelIndex = new Map(labelNames.map((n, i) => [n, i]));

  // Resolve arguments now so both passes agree on the row widths.
  const resolved: Array<{ verb: number; args: number[] }> = rows.map((row) => {
    const verb = row[0];
    const args: number[] = [];
    for (let i = 1; i < row.length; i++) {
      const a = row[i]!;
      if (typeof a === "number") args.push(a);
      else if (typeof a === "string") {
        // A label row's name is metadata, not an argument.
        if (verb === VERB.label) continue;
        args.push(text.key(a));
      } else {
        const idx = labelIndex.get(a.label);
        if (idx === undefined) throw new Error(`jump to unknown label '${a.label}'`);
        args.push(idx);
      }
    }
    return { verb, args };
  });

  const headerSize = 8;
  const offsets: number[] = [];
  let at = headerSize + labelNames.length * 4;
  for (const r of resolved) {
    offsets.push(at);
    at += 2 + r.args.length * 4;
  }

  const w = new Writer(at + 16);
  w.u16(SCRIPT_VERSION).u16(resolved.length).u16(labelNames.length).u16(0);
  for (const name of labelNames) {
    const row = labelRow.get(name)!;
    w.u32(offsets[row]!);
  }
  for (const r of resolved) {
    w.u8(r.verb).u8(r.args.length);
    for (const a of r.args) w.i32(a);
  }
  return w.finish();
}

function sectionScripts(text: TextTable, scriptKeys: Map<string, number>): Uint8Array {
  const bodies = SCRIPTS.map((s) => ({
    key: scriptKeys.get(s.name)!,
    bytes: assembleScript(s.rows, text),
  }));
  const w = new Writer(1 << 14);
  w.u16(bodies.length).u16(0);
  const tableAt = w.length;
  for (let i = 0; i < bodies.length; i++) w.u16(0).u16(0).u32(0).u32(0);
  bodies.forEach((b, i) => {
    w.align(4);
    const at = w.length;
    w.bytes(b.bytes);
    const entry = tableAt + i * 12;
    // u16 nameKey | u16 reserved | u32 offset | u32 length
    new DataView(new ArrayBuffer(0)); // (no-op; kept for symmetry with reads)
    w.patchU32(entry + 4, at);
    w.patchU32(entry + 8, b.bytes.length);
    // The key halves are patched by hand since Writer only back-patches u32.
    patchU16(w, entry, b.key);
  });
  return w.finish();
}

/** Writer has no u16 back-patch; scripts are the only caller that needs one. */
function patchU16(w: Writer, at: number, v: number): void {
  // Read-modify-write the containing u32 so we do not need a second accessor.
  const buf = (w as unknown as { buf: Uint8Array }).buf;
  buf[at] = v & 0xff;
  buf[at + 1] = (v >> 8) & 0xff;
}

/**
 * AUDO: `songCount + sfxCount + 1` offsets (the extra one bounds the last
 * track), then the tracks back to back.
 */
function sectionAudio(): Uint8Array {
  const tracks = [...SONGS, ...SFX].map(encodeTrack);
  const w = new Writer(1 << 14);
  w.u16(SONGS.length).u16(SFX.length);
  const tableAt = w.length;
  for (let i = 0; i <= tracks.length; i++) w.u32(0);
  const starts: number[] = [];
  for (const bytes of tracks) {
    starts.push(w.length);
    w.bytes(bytes);
  }
  const end = w.length;
  starts.forEach((at, i) => w.patchU32(tableAt + i * 4, at));
  w.patchU32(tableAt + tracks.length * 4, end);
  return w.finish();
}

function sectionText(text: TextTable): Uint8Array {
  const strings = text.all();
  const encoder = new TextEncoder();
  const encoded = strings.map((s) => encoder.encode(s));
  const w = new Writer(1 << 15);
  w.u16(encoded.length).u16(0);
  const tableAt = w.length;
  for (let i = 0; i < encoded.length; i++) w.u32(0).u32(0);
  encoded.forEach((bytes, i) => {
    const at = w.length;
    w.bytes(bytes);
    w.patchU32(tableAt + i * 8, at);
    w.patchU32(tableAt + i * 8 + 4, bytes.length);
  });
  return w.finish();
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

interface Section {
  tag: number;
  count: number;
  payload: Uint8Array;
}

/** Cook the whole game into one MONPAK. */
export function cook(): Uint8Array {
  const built = buildText();
  const { text, scriptKeys } = built;

  // Sections that intern text must run before TEXT is serialized.
  const sections: Section[] = [
    { tag: MONPAK_TAG.palette, count: 256, payload: packPalette() },
    { tag: MONPAK_TAG.atlas, count: 0, payload: sectionAtlas(buildPages()) },
    { tag: MONPAK_TAG.tileset, count: 1, payload: sectionTilesets() },
    { tag: MONPAK_TAG.types, count: TYPE_NAMES.length, payload: sectionTypes(text) },
    { tag: MONPAK_TAG.species, count: SPECIES.length, payload: sectionSpecies(text) },
    { tag: MONPAK_TAG.moves, count: MOVES.length, payload: sectionMoves(text) },
    { tag: MONPAK_TAG.items, count: ITEMS.length, payload: sectionItems(text) },
    { tag: MONPAK_TAG.trainers, count: TRAINERS.length, payload: sectionTrainers(text) },
    { tag: MONPAK_TAG.scripts, count: SCRIPTS.length, payload: sectionScripts(text, scriptKeys) },
    { tag: MONPAK_TAG.maps, count: MAPS.length, payload: sectionMaps(text, scriptKeys) },
    { tag: MONPAK_TAG.font, count: characters().length, payload: sectionFont() },
    { tag: MONPAK_TAG.audio, count: SONGS.length + SFX.length, payload: sectionAudio() },
  ];
  // TEXT goes last so every key interned above is included.
  sections.push({ tag: MONPAK_TAG.text, count: text.size, payload: sectionText(text) });

  const tableBytes = sections.length * 16;
  let cursor = MONPAK_HEADER_SIZE + tableBytes;
  const placed = sections.map((s) => {
    cursor = align(cursor, MONPAK_ALIGN);
    const at = cursor;
    cursor += s.payload.length;
    return { ...s, offset: at };
  });
  const total = align(cursor, MONPAK_ALIGN);

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MONPAK_MAGIC, true);
  dv.setUint16(4, MONPAK_VERSION, true);
  dv.setUint16(6, sections.length, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, 0, true);
  placed.forEach((s, i) => {
    const at = MONPAK_HEADER_SIZE + i * 16;
    dv.setUint32(at, s.tag, true);
    dv.setUint32(at + 4, s.offset, true);
    dv.setUint32(at + 8, s.payload.length, true);
    dv.setUint32(at + 12, s.count, true);
    out.set(s.payload, s.offset);
  });
  return out;
}

function align(v: number, n: number): number {
  return v % n === 0 ? v : v + (n - (v % n));
}

/** A short summary of what was cooked, for the build log. */
export function summary(pak: Uint8Array): string {
  const kb = (n: number) => `${(n / 1024).toFixed(1)} kB`;
  return [
    `SPARKWOOD content: ${kb(pak.length)}`,
    `  ${SPECIES.length} species, ${MOVES.length} moves, ${TYPE_NAMES.length} types`,
    `  ${MAPS.length} maps, ${TRAINERS.length} trainers, ${SCRIPTS.length} scripts`,
    `  ${CAST.length} actor sheets (${SPRITE_PX}px), ${SPECIES.length * 2} portraits (${PORTRAIT_PX}px)`,
    `  ${SONGS.length} songs, ${SFX.length} sound effects`,
  ].join("\n");
}

if (import.meta.main) {
  const out = Bun.argv[2] ?? new URL("../../dist/sparkwood.monpak", import.meta.url).pathname;
  const pak = cook();
  await Bun.write(out, pak);
  console.log(summary(pak));
  console.log(`wrote ${out}`);
}
