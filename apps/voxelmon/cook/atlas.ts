// apps/voxelmon/cook/atlas.ts — CLUT8 atlas pages + palettes.
//
// Pages are pre-swizzled (16-byte x 8-row blocks, engine pak.rs
// swizzle_stride/swizzle_rows — mirrored byte-for-byte from
// pocketvoxel-core/src/pak/builder.rs swizzle()). Palettes: one per
// ATLAS_KIND; entries 0..3 are the GB shades, 0xff transparent, rest black.
//
// TERRAIN is ONE combined page: every tileset sheet the cooked maps use,
// stacked vertically — the core binds `page_of_kind(TERRAIN)` for every
// chunk mesh (draw.rs), so all chunk UVs must live in one page. Animated
// tilesets bake the full 8-step water/flower cycle as whole-page frame
// variants (gen1recomp TileRenderer.lua:74-92): water tile rows rotate by
// WATER_OFFSETS per step, the flower tile cycles flower1-3.

import { ATLAS_KIND } from "../../../contracts/spec/voxel-spec.ts";
import { ANIM_STEPS, FLOWER_FRAMES, WATER_OFFSETS, defaultAnimatedTiles } from "./classify.ts";
import { type Art, artOf, type GenData, PX_CLEAR, sheetKeyOf, type TilesetDef } from "./data.ts";

// ---------------------------------------------------------------------------
// swizzle (builder.rs:27 — the exact transform the reader inverts)
// ---------------------------------------------------------------------------

export const swizzleStride = (w: number): number => Math.ceil(w / 16) * 16;
export const swizzleRows = (h: number): number => Math.ceil(h / 8) * 8;
export const swizzledLen = (w: number, h: number): number => swizzleStride(w) * swizzleRows(h);

export function swizzle(w: number, h: number, linear: Uint8Array): Uint8Array {
  if (linear.length !== w * h) throw new Error("linear texel size mismatch");
  const stride = swizzleStride(w);
  const rows = swizzleRows(h);
  const out = new Uint8Array(stride * rows);
  let dst = 0;
  for (let blockY = 0; blockY < rows / 8; blockY++) {
    for (let blockX = 0; blockX < stride / 16; blockX++) {
      for (let row = 0; row < 8; row++) {
        const y = blockY * 8 + row;
        for (let column = 0; column < 16; column++) {
          const x = blockX * 16 + column;
          if (x < w && y < h) out[dst + column] = linear[y * w + x];
        }
        dst += 16;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// palettes
// ---------------------------------------------------------------------------

/** GB shade -> opaque ABGR gray (0 lightest). */
const SHADE_ABGR = [0xffffffff, 0xffaaaaaa, 0xff555555, 0xff000000];

export function gbPalette(): Uint32Array {
  const pal = new Uint32Array(256).fill(0xff000000);
  for (let i = 0; i < 4; i++) pal[i] = SHADE_ABGR[i];
  pal[PX_CLEAR] = 0x00000000; // transparent
  return pal;
}

/** One palette per ATLAS_KIND (page kind indexes the palette list). */
export function buildPalettes(): Uint32Array[] {
  return Object.keys(ATLAS_KIND).map(() => gbPalette());
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

export interface PageDef {
  w: number;
  h: number;
  kind: number;
  /** LINEAR frames (swizzled at pack time). */
  frames: Uint8Array[];
  /** Debug name (not packed). */
  name: string;
}

export interface TerrainLayout {
  page: PageDef;
  /** sheet gfx key -> y offset of that sheet inside the combined page. */
  baseY: Map<string, number>;
}

function blitArt(dst: Uint8Array, dstW: number, art: Art, dx: number, dy: number): void {
  for (let y = 0; y < art.h; y++) {
    for (let x = 0; x < art.w; x++) {
      dst[(dy + y) * dstW + (dx + x)] = art.px(x, y);
    }
  }
}

/** The combined terrain page over the tilesets the cooked maps use. */
export function buildTerrainPage(gen: GenData, tilesets: TilesetDef[]): TerrainLayout {
  // distinct sheets, sorted by key for determinism
  const sheets = [...new Set(tilesets.map(sheetKeyOf))].sort();
  const baseY = new Map<string, number>();
  let h = 0;
  for (const key of sheets) {
    const e = gen.gfx[key];
    if (!e) throw new Error(`missing tileset sheet: ${key}`);
    baseY.set(key, h);
    h += e.h;
  }
  const w = 128;

  // which sheets animate (any using tileset declares water/flower cycles)
  const animated = new Map<string, TilesetDef>();
  for (const ts of tilesets) {
    if (defaultAnimatedTiles(ts.animation).length > 0) animated.set(sheetKeyOf(ts), ts);
  }
  const frameCount = animated.size > 0 ? ANIM_STEPS : 1;

  const frames: Uint8Array[] = [];
  for (let step = 0; step < frameCount; step++) {
    const linear = new Uint8Array(w * h).fill(PX_CLEAR);
    for (const key of sheets) {
      const art = artOf(gen, key)!;
      const y0 = baseY.get(key)!;
      blitArt(linear, w, art, 0, y0);
      const ts = animated.get(key);
      if (!ts) continue;
      const perRow = ts.tilesPerRow || 16;
      for (const spec of defaultAnimatedTiles(ts.animation)) {
        const tx = (spec.tile % perRow) * 8;
        const ty = Math.floor(spec.tile / perRow) * 8 + y0;
        if (spec.kind === "hshift") {
          // rotate the tile's rows right by the step's cumulative offset
          // (TileRenderer.lua:201-208: setPixel((x + o) % 8, y, src[x]))
          const o = WATER_OFFSETS[step % WATER_OFFSETS.length];
          for (let yy = 0; yy < 8; yy++) {
            for (let xx = 0; xx < 8; xx++) {
              linear[(ty + yy) * w + tx + ((xx + o) % 8)] = art.px(tx + xx, ty - y0 + yy);
            }
          }
        } else {
          const n = FLOWER_FRAMES[step % FLOWER_FRAMES.length];
          const frame = artOf(gen, `tilesets/flower${n}`);
          if (frame) {
            for (let yy = 0; yy < 8; yy++) {
              for (let xx = 0; xx < 8; xx++) {
                linear[(ty + yy) * w + tx + xx] = frame.px(xx, yy);
              }
            }
          }
        }
      }
    }
    frames.push(linear);
  }

  return {
    page: { w, h, kind: ATLAS_KIND.terrain, frames, name: "terrain" },
    baseY,
  };
}

/** One sprite page per walk sheet (16x16 cells stacked vertically). */
export function buildSpritePage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing sprite sheet: ${key}`);
  const linear = new Uint8Array(art.w * art.h);
  blitArt(linear, art.w, art, 0, 0);
  return { w: art.w, h: art.h, kind: ATLAS_KIND.sprites, frames: [linear], name: key };
}

/** The emote page: gen's 48x16 horizontal strip restacked 16x48 vertical
 *  (the core's sheet_uv stacks 16x16 cells vertically). */
export function buildEmotePage(gen: GenData): PageDef | null {
  const art = artOf(gen, "emotes");
  if (!art) return null;
  const cells = Math.floor(art.w / 16);
  const linear = new Uint8Array(16 * cells * 16);
  for (let i = 0; i < cells; i++) {
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        linear[(i * 16 + y) * 16 + x] = art.px(i * 16 + x, y);
      }
    }
  }
  return { w: 16, h: cells * 16, kind: ATLAS_KIND.sprites, frames: [linear], name: "emotes" };
}

/**
 * The UI page: ONE 128x128 page, tile id = GB tile code (SCHEMA.md §UI):
 * font_extra tiles at extraBase (0x60..0x7f), font glyphs at mainBase
 * (0x80..0xff), 16 tiles per row, 8x8 tiles, tile 0 transparent.
 */
export function buildUiPage(gen: GenData): PageDef {
  const w = 128;
  const h = 128; // 256 tiles / 16 per row * 8 px
  const linear = new Uint8Array(w * h).fill(PX_CLEAR);
  const place = (art: Art, base: number): void => {
    // Source rows are the sheet's own width in tiles (font sheets are 16
    // wide, the battle HUD pages 15 and 3).
    const glyphsPerRow = Math.floor(art.w / 8);
    const count = Math.floor(art.w / 8) * Math.floor(art.h / 8);
    for (let g = 0; g < count; g++) {
      const sx = (g % glyphsPerRow) * 8;
      const sy = Math.floor(g / glyphsPerRow) * 8;
      const tile = base + g;
      if (tile > 0xff) break;
      const dx = (tile % 16) * 8;
      const dy = Math.floor(tile / 16) * 8;
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          // GB UI tiles are opaque white-backed (the textbox interior must
          // cover the world); only the unset tile 0 stays transparent.
          const px = art.px(sx + x, sy + y);
          linear[(dy + y) * w + dx + x] = px === PX_CLEAR ? 0 : px;
        }
      }
    }
  };
  const extra = artOf(gen, "fonts/font_extra");
  if (extra) place(extra, gen.font.extraBase);
  const font = artOf(gen, "fonts/font");
  if (font) place(font, gen.font.mainBase);
  // The in-battle HUD overlay (gen1recomp HudTiles.lua PAGES): pokered
  // overlays the $62-$78 font area — font_battle_extra at $62, then the
  // three HUD line pages on top of its tail ($6D/$73/$76). The textbox
  // borders at $79-$7F survive; battle and overworld share one UI page.
  for (const [key, base] of [
    ["battle/font_battle_extra", 0x62],
    ["battle/battle_hud_1", 0x6d],
    ["battle/battle_hud_2", 0x73],
    ["battle/battle_hud_3", 0x76],
  ] as const) {
    const sheet = artOf(gen, key);
    if (sheet) place(sheet, base);
  }
  return { w, h, kind: ATLAS_KIND.ui, frames: [linear], name: "ui" };
}

/** One pics page per battle pic gfx key. */
export function buildPicPage(gen: GenData, key: string): PageDef {
  const art = artOf(gen, key);
  if (!art) throw new Error(`missing pic: ${key}`);
  const linear = new Uint8Array(art.w * art.h);
  blitArt(linear, art.w, art, 0, 0);
  return { w: art.w, h: art.h, kind: ATLAS_KIND.pics, frames: [linear], name: key };
}
