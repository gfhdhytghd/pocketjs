// apps/voxelmon/cook/gamedata.ts — the GAME section + CMAP pairs.
//
// gamedata packs the gameplay subset of gen/ (apps/voxelmon/SCHEMA.md
// §gamedata) plus an `atlas` object carrying the page-index maps the guest
// needs: sprite sheet name -> page, species -> front-pic page, the player
// back page and the emote page. CMAP maps each single-char charmap entry's
// UTF-16 code point to its GB tile code (multi-char sequences like <PKMN>
// skip v1); the UI page lays glyphs at their GB codes, so tile id == code.

import type { GenData, TilesetDef } from "./data.ts";

export interface AtlasIndex {
  /** sprite sheet name ("red", "oak", ...) -> atlas page. */
  sprites: Record<string, number>;
  /** species id -> front-pic atlas page. */
  front: Record<string, number>;
  /** back-pic name ("redb") -> atlas page. */
  back: Record<string, number>;
  emotePage: number | null;
  uiPage: number;
  terrainPage: number;
}

/** The tileset subset the guest needs (collision + animation semantics). */
function tilesetSubset(ts: TilesetDef): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: ts.id,
    // blocks are collision-relevant: cell resolution needs block -> tiles
    blocks: ts.blocks,
    walkable: ts.walkable,
    counterTiles: ts.counterTiles ?? [],
    doorTiles: ts.doorTiles ?? [],
    warpTiles: ts.warpTiles ?? [],
    animation: ts.animation,
  };
  if (ts.grassTile !== undefined) out.grassTile = ts.grassTile;
  if (ts.waterTiles !== undefined) out.waterTiles = ts.waterTiles;
  if (ts.shoreTiles !== undefined) out.shoreTiles = ts.shoreTiles;
  return out;
}

export function buildGamedata(gen: GenData, atlas: AtlasIndex): Uint8Array {
  // pokemon minus pic paths
  const pokemon: Record<string, unknown> = {};
  for (const [id, def] of Object.entries(gen.pokemon)) {
    const { spriteFront: _f, spriteBack: _b, ...rest } = def;
    pokemon[id] = rest;
  }
  const tilesets: Record<string, unknown> = {};
  for (const [id, ts] of Object.entries(gen.tilesets)) tilesets[id] = tilesetSubset(ts);

  const game = {
    constants: gen.constants,
    maps: gen.maps,
    tilesets,
    encounters: gen.encounters,
    moves: gen.moves,
    pokemon,
    items: gen.items,
    type_chart: gen.typeChart,
    trainers: gen.trainers,
    text: gen.text,
    text_pointers: gen.textPointers,
    trainer_headers: gen.trainerHeaders,
    field: gen.field,
    atlas,
  };
  return new TextEncoder().encode(JSON.stringify(game));
}

/**
 * CMAP pairs: UTF-16 code point of each single-char glyph -> its GB tile
 * code, strictly ascending, first entry wins on duplicates.
 */
export function buildCharmap(gen: GenData): [number, number][] {
  const seen = new Map<number, number>();
  for (const entry of gen.font.charmap) {
    if (typeof entry.seq !== "string" || entry.seq.length !== 1) continue;
    const cp = entry.seq.charCodeAt(0);
    if (cp > 0xffff) continue;
    if (!seen.has(cp)) seen.set(cp, entry.code);
  }
  return [...seen.entries()].sort((a, b) => a[0] - b[0]);
}
