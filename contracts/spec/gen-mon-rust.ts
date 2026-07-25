// Deterministic codegen: contracts/spec/mon-spec.ts ->
// engine/pocketmon/crates/pocketmon-core/src/spec.rs
//
// Run from PocketJS/:  bun contracts/spec/gen-mon-rust.ts
//
// tests/mon-contract.test.ts imports generateMonRust() and byte-compares its
// output against the committed spec.rs, so the generated file can never drift
// from mon-spec.ts. Keep this generator free of anything non-deterministic
// (no dates, no env, no object-key sorting surprises — insertion order only).

import {
  ACTION,
  ACTORS_MAX,
  ACTOR_SIZE,
  ATLAS_PAGE_HEADER_SIZE,
  AUDIO_BUFFER,
  AUDIO_CELL_SIZE,
  AUDIO_CHANNELS,
  AUDIO_ENTRY_SIZE,
  AUDIO_HEADER_SIZE,
  BAG_MAX,
  BALL_RATE,
  BEHAVIOR,
  BLOCK_CELLS,
  BLOCK_PX,
  BLOCK_TILES,
  BOX_COUNT,
  BOX_SIZE,
  CATCH_STATUS_BONUS,
  CATEGORY,
  CELL,
  CELL_PX,
  DAMAGE_CLAMP,
  DIR,
  EFFECT,
  ENCOUNTER_BUCKETS,
  EVENT_CAP,
  EVENT_SIZE,
  FLAG_COUNT,
  FNV1A_OFFSET_BASIS,
  FNV1A_PRIME,
  FONT_HEADER_SIZE,
  GB_H,
  GB_W,
  GLYPH_SIZE,
  GROWTH,
  ITEM_KIND,
  ITEM_SIZE,
  LEARN_SIZE,
  LEVEL_MAX,
  MATCHUP_SIZE,
  MON_BTN,
  MAP_FLAG_DARK,
  MAP_FLAG_INDOOR,
  MAP_FLAG_NO_ESCAPE,
  MAP_HEADER_SIZE,
  MODE,
  MONPAK_ALIGN,
  MONPAK_ENTRY_SIZE,
  MONPAK_HEADER_SIZE,
  MONPAK_MAGIC,
  MONPAK_TAG,
  MONPAK_VERSION,
  MON_EVENT,
  MON_OP,
  MOVES_MAX,
  MOVE_FLAG_CHARGE,
  MOVE_FLAG_HIGH_CRIT,
  MOVE_FLAG_MULTI_HIT,
  MOVE_FLAG_PRIORITY,
  MOVE_FLAG_RECHARGE,
  MOVE_SIZE,
  NOTE_HOLD,
  NOTE_OFF,
  OUTCOME,
  PAGE_MAX,
  PAGE_PX,
  PALETTE_BYTES,
  PALETTE_ENTRIES,
  PARTY_MAX,
  PHASE,
  QUAD_FLAG_FLIP_X,
  QUAD_FLAG_FLIP_Y,
  QUAD_SIZE,
  RAND_MAX,
  RAND_MIN,
  RECT_SIZE,
  SAVE_HEADER_SIZE,
  SAVE_MAGIC,
  SAMPLE_RATE,
  SAVE_VERSION,
  SCRIPT_ENTRY_SIZE,
  SCRIPT_HEADER_SIZE,
  SCRIPT_VERSION,
  SECTION_HEADER_SIZE,
  SIGN_SIZE,
  SLOT_COUNT,
  SLOT_SIZE,
  SPECIES_SECTION_HEADER_SIZE,
  SPECIES_SIZE,
  STAB_DEN,
  STAB_NUM,
  STAGE_MAX,
  STAGE_MIN,
  STAGE_MULT,
  STAT_MAX,
  STAT_SCALE_LIMIT,
  STATUS,
  TEXT_ENTRY_SIZE,
  TICK_HZ,
  TILESET_BLOCK_SIZE,
  TILESET_HEADER_SIZE,
  TILE_BEHAVIOR_BYTES,
  TILE_PX,
  TINT_NONE,
  TRAINER_HEADER_SIZE,
  TRAINER_MON_SIZE,
  TRAINER_PARTY_MAX,
  TYPE_SCALE,
  TYPE_SECTION_HEADER_SIZE,
  TYPE_SIZE,
  VERB,
  VIEW,
  VIEW_H,
  VIEW_W,
  WARP_SIZE,
} from "./mon-spec.ts";

function hex(n: number, pad = 8): string {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

/** SCREAMING_SNAKE from a camelCase spec key. */
function screaming(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

/** Emit a `pub mod <name> { pub const K: <ty> = v; }` block from a record. */
function constMod(
  put: (s?: string) => void,
  name: string,
  ty: string,
  table: Record<string, number>,
  doc: string[],
) {
  for (const line of doc) put(`/// ${line}`);
  put(`pub mod ${name} {`);
  for (const [k, v] of Object.entries(table)) {
    put(`    pub const ${screaming(k)}: ${ty} = ${v};`);
  }
  put("}");
  put("");
}

export function generateMonRust(): string {
  const L: string[] = [];
  const put = (s = "") => L.push(s);

  put("//! GENERATED — do not edit; run `bun contracts/spec/gen-mon-rust.ts` (from PocketJS/).");
  put("//!");
  put("//! Source of truth: contracts/spec/mon-spec.ts — every constant here mirrors it.");
  put("//! tests/mon-contract.test.ts regenerates this file in-memory and byte-compares;");
  put("//! if that fails, run `bun contracts/spec/gen-mon-rust.ts` and commit the result.");
  put("//!");
  put("//! See docs/MON.md for the architecture this contract serves.");
  put("");
  put("#![allow(dead_code)]");
  put("#![allow(clippy::all)]");
  put("");

  // --- geometry -------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Geometry — the three coordinate units (docs/MON.md §4)");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Graphics unit: an 8x8 pixel tile.");
  put(`pub const TILE_PX: i32 = ${TILE_PX};`);
  put("/// Walk-grid unit: a 16x16 pixel cell = 2x2 tiles.");
  put(`pub const CELL_PX: i32 = ${CELL_PX};`);
  put("/// Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles.");
  put(`pub const BLOCK_PX: i32 = ${BLOCK_PX};`);
  put("/// Tiles per block edge; a block's tile array is BLOCK_TILES^2 entries.");
  put(`pub const BLOCK_TILES: usize = ${BLOCK_TILES};`);
  put("/// Cells per block edge.");
  put(`pub const BLOCK_CELLS: i32 = ${BLOCK_CELLS};`);
  put("/// The logical view, in GB-scale pixels (the PSP host renders it 2x).");
  put(`pub const VIEW_W: i32 = ${VIEW_W};`);
  put(`pub const VIEW_H: i32 = ${VIEW_H};`);
  put("/// The original handheld framing, for reference and 1x hosts.");
  put(`pub const GB_W: i32 = ${GB_W};`);
  put(`pub const GB_H: i32 = ${GB_H};`);
  put("/// Fixed simulation step.");
  put(`pub const TICK_HZ: u32 = ${TICK_HZ};`);
  put("");
  constMod(put, "btn", "u32", MON_BTN, [
    "The core's abstract button set; hosts map their physical buttons onto",
    "it, so one input tape replays on every host.",
  ]);

  // --- limits ---------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Party / bag / box limits");
  put("// ---------------------------------------------------------------------------");
  put("");
  put(`pub const PARTY_MAX: usize = ${PARTY_MAX};`);
  put(`pub const MOVES_MAX: usize = ${MOVES_MAX};`);
  put(`pub const BOX_COUNT: usize = ${BOX_COUNT};`);
  put(`pub const BOX_SIZE: usize = ${BOX_SIZE};`);
  put(`pub const BAG_MAX: usize = ${BAG_MAX};`);
  put("/// Max simultaneously-loaded actors on a map (player is slot 0).");
  put(`pub const ACTORS_MAX: usize = ${ACTORS_MAX};`);
  put(`pub const LEVEL_MAX: u32 = ${LEVEL_MAX};`);
  put(`pub const STAGE_MIN: i32 = ${STAGE_MIN};`);
  put(`pub const STAGE_MAX: i32 = ${STAGE_MAX};`);
  put("");

  // --- enums ----------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Enums — closed vocabularies the core and guest share");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "dir", "u8", DIR, ["Facing / movement direction; matches walk-sheet frame order."]);
  constMod(put, "cell", "u8", CELL, ["What a cell does, derived from its bottom-left 8x8 tile."]);
  constMod(put, "status", "u8", STATUS, ["Persistent status conditions; `NONE` stays 0."]);
  constMod(put, "category", "u8", CATEGORY, [
    "Damage category. Gen 1 splits physical/special by the move's TYPE;",
    "a type record carries its category and a move may override it.",
  ]);
  constMod(put, "growth", "u8", GROWTH, ["Experience growth curves (see growth.rs)."]);
  constMod(put, "mode", "u8", MODE, ["The top-level mode the core is in."]);
  constMod(put, "phase", "u8", PHASE, ["Battle phase — what the core is waiting for."]);
  constMod(put, "action", "u8", ACTION, ["The player's battle action."]);
  constMod(put, "outcome", "u8", OUTCOME, ["How a battle finished."]);
  constMod(put, "behavior", "u8", BEHAVIOR, ["Actor movement behavior for NPCs."]);

  // --- ops / events ---------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// The `mon` surface: ops (guest -> core) and events (core -> guest)");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "op", "u32", MON_OP, [
    "Guest -> core intent. APPEND ONLY: never renumber, never reuse.",
    "Signatures are documented in contracts/spec/mon-spec.ts.",
  ]);
  constMod(put, "event", "u16", MON_EVENT, [
    "Core -> guest facts, drained as one batch per tick. APPEND ONLY.",
  ]);
  put("/// Bytes per packed event record: u16 kind | u16 a | i32 b | i32 c | i32 d.");
  put(`pub const EVENT_SIZE: usize = ${EVENT_SIZE};`);
  put("/// Max events buffered in one tick; overflow drops the tail and sets a stat.");
  put(`pub const EVENT_CAP: usize = ${EVENT_CAP};`);
  put("");
  constMod(put, "view", "u32", VIEW, ["`view(kind)` packed snapshots for menu rendering."]);

  // --- MONPAK ---------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// MONPAK — the cooked content container");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("pub mod monpak {");
  put(`    pub const MAGIC: u32 = ${hex(MONPAK_MAGIC)}; // 'MONP' LE`);
  put(`    pub const VERSION: u16 = ${MONPAK_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${MONPAK_HEADER_SIZE};`);
  put(`    pub const ENTRY_SIZE: usize = ${MONPAK_ENTRY_SIZE};`);
  put(`    pub const ALIGN: usize = ${MONPAK_ALIGN};`);
  put("");
  put("    /// Section tags (4CC, LE u32).");
  for (const [k, v] of Object.entries(MONPAK_TAG)) {
    put(`    pub const TAG_${screaming(k)}: u32 = ${hex(v)};`);
  }
  put("}");
  put("");

  // --- section payload layouts ----------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Section payload layouts");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Bytes of per-section header preceding every payload's records.");
  put(`pub const SECTION_HEADER_SIZE: usize = ${SECTION_HEADER_SIZE};`);
  put("/// ATLS page header: u16 w, u16 h, u32 byteLen, then w*h CLUT8 pixels.");
  put(`pub const ATLAS_PAGE_HEADER_SIZE: usize = ${ATLAS_PAGE_HEADER_SIZE};`);
  put(`pub const PALETTE_ENTRIES: usize = ${PALETTE_ENTRIES};`);
  put(`pub const PALETTE_BYTES: usize = ${PALETTE_BYTES};`);
  put("/// TLES per-tileset header, block record size, and the tile behavior table.");
  put(`pub const TILESET_HEADER_SIZE: usize = ${TILESET_HEADER_SIZE};`);
  put(`pub const TILESET_BLOCK_SIZE: usize = ${TILESET_BLOCK_SIZE};`);
  put(`pub const TILE_BEHAVIOR_BYTES: usize = ${TILE_BEHAVIOR_BYTES};`);
  put("/// SPEC header: u16 count, u16 learnPoolCount.");
  put(`pub const SPECIES_SECTION_HEADER_SIZE: usize = ${SPECIES_SECTION_HEADER_SIZE};`);
  put("/// One learnset entry: u16 level, u16 moveId.");
  put(`pub const LEARN_SIZE: usize = ${LEARN_SIZE};`);
  put("/// STYP header: u16 typeCount, u16 matchupCount.");
  put(`pub const TYPE_SECTION_HEADER_SIZE: usize = ${TYPE_SECTION_HEADER_SIZE};`);
  put(`pub const TYPE_SIZE: usize = ${TYPE_SIZE};`);
  put(`pub const MATCHUP_SIZE: usize = ${MATCHUP_SIZE};`);
  put(`pub const ITEM_SIZE: usize = ${ITEM_SIZE};`);
  put(`pub const FONT_HEADER_SIZE: usize = ${FONT_HEADER_SIZE};`);
  put(`pub const GLYPH_SIZE: usize = ${GLYPH_SIZE};`);
  put(`pub const SCRIPT_ENTRY_SIZE: usize = ${SCRIPT_ENTRY_SIZE};`);
  put("/// A string's index IS its key id; no hashing happens at runtime.");
  put(`pub const TEXT_ENTRY_SIZE: usize = ${TEXT_ENTRY_SIZE};`);
  put(`pub const AUDIO_ENTRY_SIZE: usize = ${AUDIO_ENTRY_SIZE};`);
  put("/// A track is a tracker pattern; see mon-spec.ts for the cell layout.");
  put(`pub const AUDIO_HEADER_SIZE: usize = ${AUDIO_HEADER_SIZE};`);
  put(`pub const AUDIO_CELL_SIZE: usize = ${AUDIO_CELL_SIZE};`);
  put("/// Pulse 1, pulse 2, wave, noise — the classic four.");
  put(`pub const AUDIO_CHANNELS: usize = ${AUDIO_CHANNELS};`);
  put(`pub const SAMPLE_RATE: u32 = ${SAMPLE_RATE};`);
  put(`pub const AUDIO_BUFFER: usize = ${AUDIO_BUFFER};`);
  put("/// Cell `note` values that are not a semitone.");
  put(`pub const NOTE_HOLD: u8 = ${NOTE_HOLD};`);
  put(`pub const NOTE_OFF: u8 = ${NOTE_OFF};`);
  put("");
  constMod(put, "item_kind", "u8", ITEM_KIND, ["What an item does when used."]);

  // --- record layouts -------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Record layouts (fixed-size, LE) — the cooker writes, the core reads");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// SPECIES record byte size (layout in mon-spec.ts).");
  put(`pub const SPECIES_SIZE: usize = ${SPECIES_SIZE};`);
  put("/// MOVE record byte size.");
  put(`pub const MOVE_SIZE: usize = ${MOVE_SIZE};`);
  put("/// Move `flags` bits.");
  put(`pub const MOVE_FLAG_HIGH_CRIT: u8 = ${MOVE_FLAG_HIGH_CRIT};`);
  put(`pub const MOVE_FLAG_MULTI_HIT: u8 = ${MOVE_FLAG_MULTI_HIT};`);
  put(`pub const MOVE_FLAG_CHARGE: u8 = ${MOVE_FLAG_CHARGE};`);
  put(`pub const MOVE_FLAG_RECHARGE: u8 = ${MOVE_FLAG_RECHARGE};`);
  put("/// Moves first regardless of speed (the \"quick attack\" class).");
  put(`pub const MOVE_FLAG_PRIORITY: u8 = ${MOVE_FLAG_PRIORITY};`);
  put("");
  constMod(put, "effect", "u8", EFFECT, [
    "Move effects the core implements natively; anything else raises",
    "a `scriptHook` event for the guest. Append-only.",
  ]);
  put("/// MAP header byte size; the block array and variable sections follow.");
  put(`pub const MAP_HEADER_SIZE: usize = ${MAP_HEADER_SIZE};`);
  put(`pub const MAP_FLAG_INDOOR: u8 = ${MAP_FLAG_INDOOR};`);
  put(`pub const MAP_FLAG_DARK: u8 = ${MAP_FLAG_DARK};`);
  put(`pub const MAP_FLAG_NO_ESCAPE: u8 = ${MAP_FLAG_NO_ESCAPE};`);
  put(`pub const WARP_SIZE: usize = ${WARP_SIZE};`);
  put(`pub const SIGN_SIZE: usize = ${SIGN_SIZE};`);
  put(`pub const ACTOR_SIZE: usize = ${ACTOR_SIZE};`);
  put(`pub const SLOT_SIZE: usize = ${SLOT_SIZE};`);
  put("/// Encounter slots per map.");
  put(`pub const SLOT_COUNT: usize = ${SLOT_COUNT};`);
  put("/// Cumulative slot thresholds out of 256; rand(0..255) picks the first");
  put("/// bucket it falls under (ported from the upstream wild-encounter buckets).");
  put(
    `pub const ENCOUNTER_BUCKETS: [u16; ${ENCOUNTER_BUCKETS.length}] = [${ENCOUNTER_BUCKETS.join(", ")}];`,
  );
  put(`pub const TRAINER_HEADER_SIZE: usize = ${TRAINER_HEADER_SIZE};`);
  put(`pub const TRAINER_MON_SIZE: usize = ${TRAINER_MON_SIZE};`);
  put(`pub const TRAINER_PARTY_MAX: usize = ${TRAINER_PARTY_MAX};`);
  put("");

  // --- script VM ------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Script VM — the compiled command list");
  put("// ---------------------------------------------------------------------------");
  put("");
  put(`pub const SCRIPT_VERSION: u16 = ${SCRIPT_VERSION};`);
  put(`pub const SCRIPT_HEADER_SIZE: usize = ${SCRIPT_HEADER_SIZE};`);
  put("");
  constMod(put, "verb", "u8", VERB, [
    "The script verb set: the upstream Commands.lua vocabulary trimmed to",
    "what the core implements natively. Unknown verbs raise `scriptHook`.",
  ]);

  // --- draw list ------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Draw list — the backend-independent frame output");
  put("// ---------------------------------------------------------------------------");
  put("");
  put(`pub const QUAD_SIZE: usize = ${QUAD_SIZE};`);
  put(`pub const RECT_SIZE: usize = ${RECT_SIZE};`);
  put(`pub const QUAD_FLAG_FLIP_X: u8 = ${QUAD_FLAG_FLIP_X};`);
  put(`pub const QUAD_FLAG_FLIP_Y: u8 = ${QUAD_FLAG_FLIP_Y};`);
  put("/// Per-vertex tint; this value is \"untinted\".");
  put(`pub const TINT_NONE: u32 = ${hex(TINT_NONE)};`);
  put("/// Atlas page edge in pixels (CLUT8: one page is PAGE_PX^2 bytes).");
  put(`pub const PAGE_PX: u32 = ${PAGE_PX};`);
  put(`pub const PAGE_MAX: usize = ${PAGE_MAX};`);
  put("");

  // --- save -----------------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Save format");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("pub mod save {");
  put(`    pub const MAGIC: u32 = ${hex(SAVE_MAGIC)}; // 'MSAV' LE`);
  put(`    pub const VERSION: u16 = ${SAVE_VERSION};`);
  put(`    pub const HEADER_SIZE: usize = ${SAVE_HEADER_SIZE};`);
  put("    /// FNV-1a 32-bit, the same constants the .pak container uses.");
  put(`    pub const FNV1A_OFFSET_BASIS: u32 = ${hex(FNV1A_OFFSET_BASIS)};`);
  put(`    pub const FNV1A_PRIME: u32 = ${hex(FNV1A_PRIME)};`);
  put("}");
  put("");
  put("/// Event flags addressable by scripts.");
  put(`pub const FLAG_COUNT: usize = ${FLAG_COUNT};`);
  put("");

  // --- battle tuning ---------------------------------------------------------
  put("// ---------------------------------------------------------------------------");
  put("// Battle tuning constants (the default ruleset)");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Damage randomization: d = d * rand(RAND_MIN..=RAND_MAX) / 255.");
  put(`pub const RAND_MIN: u32 = ${RAND_MIN};`);
  put(`pub const RAND_MAX: u32 = ${RAND_MAX};`);
  put("/// Stat-stage multipliers x100, indexed `stage + 6` (index 6 = stage 0).");
  put(`pub const STAGE_MULT: [u32; ${STAGE_MULT.length}] = [${STAGE_MULT.join(", ")}];`);
  put("/// Stats clamp here after a stage multiplication.");
  put(`pub const STAT_MAX: u32 = ${STAT_MAX};`);
  put("/// Damage clamps here before the +2, then the random factor applies.");
  put(`pub const DAMAGE_CLAMP: u32 = ${DAMAGE_CLAMP};`);
  put("/// Both stats are quartered when either exceeds this (byte-overflow rule).");
  put(`pub const STAT_SCALE_LIMIT: u32 = ${STAT_SCALE_LIMIT};`);
  put("/// STAB is x3/2.");
  put(`pub const STAB_NUM: u32 = ${STAB_NUM};`);
  put(`pub const STAB_DEN: u32 = ${STAB_DEN};`);
  put("/// Type multipliers are x10 fixed point.");
  put(`pub const TYPE_SCALE: u32 = ${TYPE_SCALE};`);
  put(`pub const BALL_RATE: [u32; ${BALL_RATE.length}] = [${BALL_RATE.join(", ")}];`);
  put("/// Status bonus added to the catch roll.");
  put(`pub const CATCH_BONUS_NONE: u32 = ${CATCH_STATUS_BONUS.none};`);
  put(`pub const CATCH_BONUS_SLEEP_FREEZE: u32 = ${CATCH_STATUS_BONUS.sleepFreeze};`);
  put(`pub const CATCH_BONUS_OTHER: u32 = ${CATCH_STATUS_BONUS.other};`);

  return L.join("\n") + "\n";
}

if (import.meta.main) {
  const out = new URL(
    "../../engine/pocketmon/crates/pocketmon-core/src/spec.rs",
    import.meta.url,
  ).pathname;
  await Bun.write(out, generateMonRust());
  console.log(`wrote ${out}`);
}
