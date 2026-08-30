// apps/term/host/glyphs.ts — runtime glyph coverage for the device.
//
// The console's atlases are baked at build time from the app's own string
// literals, so a session that prints 你好 has nothing to draw with. This is
// the same problem the note widget solves in its `cjk.rs` (docs/WIDGET.md):
// rasterize the unseen codepoints from a system font, put them in a FONT
// ATLAS blob, and reload the slot through the spec `loadFontAtlas` op. The
// difference here is where the rasterizer lives — the 3DS has neither a font
// file nor a rasterizer, so the companion bakes and the blob travels over the
// svc channel.
//
// The baker is the repository's own `bakeSlot` (framework/compiler/bake-font.ts,
// opentype.js outlines + scanline coverage), so a glyph delivered at runtime
// goes through exactly the code path a baked one did. Two things are rewritten
// afterwards, both in the cmap (spec.ts FONT ATLAS v3):
//
//   * advance := columns * cellW — a terminal owns its grid, and the font's
//     natural advance would drift a run off the cell boundaries. xterm tells
//     us how many columns each codepoint occupies; that times the device's
//     measured cell width is the advance the device needs.
//   * the px size is chosen so the atlas cell is no taller than one terminal
//     row, otherwise a CJK glyph paints into the rows above and below it.

import { readFileSync } from "node:fs";
// Default import: opentype.js exposes its ESM build only through the
// bundler-only `module` field (see framework/compiler/bake-font.ts).
import opentype, { type Font } from "opentype.js";
import { bakeSlot } from "../../../framework/compiler/bake-font.ts";
import {
  FONT_CMAP_ENTRY_SIZE,
  FONT_HEADER_SIZE,
} from "../../../contracts/spec/spec.ts";
import { DYNAMIC_FONT_SLOT, TERM_GLYPHS } from "../protocol.ts";

/** Fonts to try, in order. A CJK face is ~20 MB of outlines; one is loaded
 *  lazily, the first time a session actually prints something unbaked. */
const FONT_CANDIDATES = [
  process.env.POCKET_TERM_CJK_FONT,
  "/System/Library/Fonts/Hiragino Sans GB.ttc",
  "/System/Library/Fonts/STHeiti Light.ttc",
  "/System/Library/Fonts/PingFang.ttc",
  // Linux, for when the companion runs there too.
  "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
  "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
].filter((path): path is string => typeof path === "string" && path.length > 0);

/** Codepoints the device can already draw from its baked mono atlas: ASCII
 *  plus the box-drawing set the app spells out as a literal. Anything else is
 *  the dynamic atlas's job. A codepoint that is in fact baked but sent
 *  dynamically still renders — it just comes from the other face — so this
 *  set is allowed to be conservative, never wrong. */
const BAKED = new Set<number>();
for (let cp = 0x20; cp <= 0x7e; cp += 1) BAKED.add(cp);
for (const ch of TERM_GLYPHS) BAKED.add(ch.codePointAt(0)!);

export function isBakedCodepoint(cp: number): boolean {
  return BAKED.has(cp);
}

// ---------------------------------------------------------------------------
// TrueType Collections
// ---------------------------------------------------------------------------

/** Every CJK face macOS ships is a .ttc, and opentype.js rejects the `ttcf`
 *  signature outright. Lifting one member out is a table copy: the collection
 *  header points at sfnt headers whose table records carry file-absolute
 *  offsets, so a standalone font is those tables rewritten against a fresh
 *  record table. */
export function extractFromCollection(bytes: Uint8Array, index = 0): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x74746366) return bytes; // not 'ttcf'
  const count = view.getUint32(8);
  if (index >= count) throw new Error(`font collection has ${count} faces, wanted #${index}`);
  const sfnt = view.getUint32(12 + index * 4);

  const numTables = view.getUint16(sfnt + 4);
  const records: { tag: number; checksum: number; offset: number; length: number }[] = [];
  for (let i = 0; i < numTables; i += 1) {
    const at = sfnt + 12 + i * 16;
    records.push({
      tag: view.getUint32(at),
      checksum: view.getUint32(at + 4),
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12),
    });
  }

  const directory = 12 + numTables * 16;
  let total = directory;
  for (const record of records) total += (record.length + 3) & ~3;
  const out = new Uint8Array(total);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, view.getUint32(sfnt)); // sfntVersion
  outView.setUint16(4, numTables);
  outView.setUint16(6, view.getUint16(sfnt + 6));
  outView.setUint16(8, view.getUint16(sfnt + 8));
  outView.setUint16(10, view.getUint16(sfnt + 10));

  let at = directory;
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i];
    const entry = 12 + i * 16;
    outView.setUint32(entry, record.tag);
    outView.setUint32(entry + 4, record.checksum);
    outView.setUint32(entry + 8, at);
    outView.setUint32(entry + 12, record.length);
    out.set(bytes.subarray(record.offset, record.offset + record.length), at);
    at += (record.length + 3) & ~3;
  }
  return out;
}

function loadFont(): { font: Font; path: string } | null {
  for (const path of FONT_CANDIDATES) {
    try {
      const raw = new Uint8Array(readFileSync(path));
      const sfnt = extractFromCollection(raw);
      const buffer = sfnt.buffer.slice(sfnt.byteOffset, sfnt.byteOffset + sfnt.byteLength);
      return { font: opentype.parse(buffer as ArrayBuffer), path };
    } catch {
      // Try the next candidate; a missing or unreadable face is not fatal.
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// the atlas
// ---------------------------------------------------------------------------

/** Glyphs kept in the atlas. The blob is re-sent whenever it grows, so this
 *  bounds both the bake and the transfer; least-recently-seen glyphs fall out
 *  when a session prints its way past the cap.
 *
 *  It also bounds device memory, which is the tighter constraint: the PICA200
 *  expands atlas coverage to RGBA8, so the glyph grid's power-of-two envelope
 *  costs 4 bytes per sample. 256 glyphs in a ~13x15 cell lands inside 256x256
 *  = 256 KiB; doubling the count would quadruple that. */
const MAX_GLYPHS = 256;

export interface BakedDynamicAtlas {
  gen: number;
  bytes: Uint8Array;
  glyphCount: number;
  px: number;
  cellH: number;
}

export class DynamicAtlas {
  #font: Font | null = null;
  #fontPath = "";
  #loaded = false;
  /** codepoint -> cell columns it occupies (1 or 2), in last-seen order. */
  #wanted = new Map<number, number>();
  #dirty = false;
  #gen = 0;
  #baked: BakedDynamicAtlas | null = null;

  get available(): boolean {
    this.#ensureFont();
    return this.#font !== null;
  }

  get fontPath(): string {
    return this.#fontPath;
  }

  get generation(): number {
    return this.#gen;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get current(): BakedDynamicAtlas | null {
    return this.#baked;
  }

  #ensureFont(): void {
    if (this.#loaded) return;
    this.#loaded = true;
    const found = loadFont();
    if (found) {
      this.#font = found.font;
      this.#fontPath = found.path;
    }
  }

  /** Whether this codepoint is one the companion can supply — unbaked on the
   *  device, and present in the loaded face. A caller that gets false must
   *  keep the grid honest itself (the device would draw nothing at all for a
   *  glyph the atlas never carries). */
  covers(cp: number): boolean {
    if (isBakedCodepoint(cp)) return false;
    this.#ensureFont();
    const font = this.#font;
    if (font === null) return false;
    return font.charToGlyphIndex(String.fromCodePoint(cp)) !== 0;
  }

  /** Record a codepoint the device needs, at the column width the terminal
   *  gives it. Re-insertion keeps the map ordered least-recently-seen first,
   *  which is what the cap evicts by. */
  want(cp: number, columns: number): void {
    const known = this.#wanted.get(cp);
    this.#wanted.delete(cp);
    this.#wanted.set(cp, columns);
    if (known !== columns) this.#dirty = true;
  }

  /** Bake the current charset into a blob whose advances land on `cellW`
   *  boundaries and whose cells fit one `cellH`-px terminal row. */
  bake(cellW: number, cellH: number): BakedDynamicAtlas | null {
    this.#ensureFont();
    const font = this.#font;
    if (font === null || this.#wanted.size === 0) return null;
    while (this.#wanted.size > MAX_GLYPHS) {
      const oldest = this.#wanted.keys().next();
      if (oldest.done) break;
      this.#wanted.delete(oldest.value);
    }
    const chars = [...this.#wanted.keys()].sort((a, b) => a - b);

    // A CJK face's ascent+descent runs past its em box, so the px that fits a
    // terminal row is found rather than assumed. Bake down from the row height
    // until the atlas cell fits; stop at 8 px, below which nothing is legible
    // anyway and an unreadable row beats a row that paints over its neighbours.
    let atlas = bakeSlot(font, DYNAMIC_FONT_SLOT, cellH, false, chars, 1);
    for (let px = cellH - 1; atlas.cellH > cellH && px >= 8; px -= 1) {
      atlas = bakeSlot(font, DYNAMIC_FONT_SLOT, px, false, chars, 1);
    }

    const bytes = atlas.bytes.slice();
    forceAdvances(bytes, this.#wanted, cellW);
    this.#gen += 1;
    this.#dirty = false;
    this.#baked = {
      gen: this.#gen,
      bytes,
      glyphCount: atlas.glyphCount,
      px: atlas.px,
      cellH: atlas.cellH,
    };
    return this.#baked;
  }
}

/** Rewrite every cmap entry's advance to `columns * cellW` (spec.ts FONT
 *  ATLAS v3 cmap: u32 codepoint, u16 gid, u8 advance, u8 xoff). gid 0 is the
 *  tofu box and has no cmap entry of its own beyond U+FFFD. */
export function forceAdvances(
  blob: Uint8Array,
  columnsFor: ReadonlyMap<number, number>,
  cellW: number,
): void {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  const glyphCount = view.getUint16(6, true);
  for (let i = 0; i < glyphCount; i += 1) {
    const at = FONT_HEADER_SIZE + i * FONT_CMAP_ENTRY_SIZE;
    if (at + FONT_CMAP_ENTRY_SIZE > blob.length) break;
    const cp = view.getUint32(at, true);
    const columns = columnsFor.get(cp) ?? 1;
    view.setUint8(at + 6, Math.min(255, columns * cellW));
  }
}
