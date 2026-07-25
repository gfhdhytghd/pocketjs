//! GENERATED — do not edit; run `bun contracts/spec/gen-mon-rust.ts` (from PocketJS/).
//!
//! Source of truth: contracts/spec/mon-spec.ts — every constant here mirrors it.
//! tests/mon-contract.test.ts regenerates this file in-memory and byte-compares;
//! if that fails, run `bun contracts/spec/gen-mon-rust.ts` and commit the result.
//!
//! See docs/MON.md for the architecture this contract serves.

#![allow(dead_code)]
#![allow(clippy::all)]

// ---------------------------------------------------------------------------
// Geometry — the three coordinate units (docs/MON.md §4)
// ---------------------------------------------------------------------------

/// Graphics unit: an 8x8 pixel tile.
pub const TILE_PX: i32 = 8;
/// Walk-grid unit: a 16x16 pixel cell = 2x2 tiles.
pub const CELL_PX: i32 = 16;
/// Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles.
pub const BLOCK_PX: i32 = 32;
/// Tiles per block edge; a block's tile array is BLOCK_TILES^2 entries.
pub const BLOCK_TILES: usize = 4;
/// Cells per block edge.
pub const BLOCK_CELLS: i32 = 2;
/// The logical view, in GB-scale pixels (the PSP host renders it 2x).
pub const VIEW_W: i32 = 240;
pub const VIEW_H: i32 = 136;
/// The original handheld framing, for reference and 1x hosts.
pub const GB_W: i32 = 160;
pub const GB_H: i32 = 144;
/// Fixed simulation step.
pub const TICK_HZ: u32 = 60;

/// The core's abstract button set; hosts map their physical buttons onto
/// it, so one input tape replays on every host.
pub mod btn {
    pub const UP: u32 = 1;
    pub const DOWN: u32 = 2;
    pub const LEFT: u32 = 4;
    pub const RIGHT: u32 = 8;
    pub const A: u32 = 16;
    pub const B: u32 = 32;
    pub const START: u32 = 64;
    pub const SELECT: u32 = 128;
}

// ---------------------------------------------------------------------------
// Party / bag / box limits
// ---------------------------------------------------------------------------

pub const PARTY_MAX: usize = 6;
pub const MOVES_MAX: usize = 4;
pub const BOX_COUNT: usize = 8;
pub const BOX_SIZE: usize = 20;
pub const BAG_MAX: usize = 20;
/// Max simultaneously-loaded actors on a map (player is slot 0).
pub const ACTORS_MAX: usize = 16;
pub const LEVEL_MAX: u32 = 100;
pub const STAGE_MIN: i32 = -6;
pub const STAGE_MAX: i32 = 6;

// ---------------------------------------------------------------------------
// Enums — closed vocabularies the core and guest share
// ---------------------------------------------------------------------------

/// Facing / movement direction; matches walk-sheet frame order.
pub mod dir {
    pub const DOWN: u8 = 0;
    pub const UP: u8 = 1;
    pub const LEFT: u8 = 2;
    pub const RIGHT: u8 = 3;
}

/// What a cell does, derived from its bottom-left 8x8 tile.
pub mod cell {
    pub const WALL: u8 = 0;
    pub const FLOOR: u8 = 1;
    pub const GRASS: u8 = 2;
    pub const WATER: u8 = 3;
    pub const DOOR: u8 = 4;
    pub const WARP: u8 = 5;
    pub const LEDGE_DOWN: u8 = 6;
    pub const COUNTER: u8 = 7;
}

/// Persistent status conditions; `NONE` stays 0.
pub mod status {
    pub const NONE: u8 = 0;
    pub const SLEEP: u8 = 1;
    pub const POISON: u8 = 2;
    pub const BURN: u8 = 3;
    pub const FREEZE: u8 = 4;
    pub const PARALYSIS: u8 = 5;
    pub const BAD_POISON: u8 = 6;
}

/// Damage category. Gen 1 splits physical/special by the move's TYPE;
/// a type record carries its category and a move may override it.
pub mod category {
    pub const PHYSICAL: u8 = 0;
    pub const SPECIAL: u8 = 1;
    pub const STATUS: u8 = 2;
}

/// Experience growth curves (see growth.rs).
pub mod growth {
    pub const MEDIUM_FAST: u8 = 0;
    pub const SLIGHTLY_FAST: u8 = 1;
    pub const SLIGHTLY_SLOW: u8 = 2;
    pub const MEDIUM_SLOW: u8 = 3;
    pub const FAST: u8 = 4;
    pub const SLOW: u8 = 5;
}

/// The top-level mode the core is in.
pub mod mode {
    pub const OVERWORLD: u8 = 0;
    pub const TEXT: u8 = 1;
    pub const BATTLE: u8 = 2;
    pub const MENU: u8 = 3;
    pub const TRANSITION: u8 = 4;
}

/// Battle phase — what the core is waiting for.
pub mod phase {
    pub const INTRO: u8 = 0;
    pub const CHOOSE_ACTION: u8 = 1;
    pub const CHOOSE_MOVE: u8 = 2;
    pub const RESOLVING: u8 = 3;
    pub const MESSAGE: u8 = 4;
    pub const CHOOSE_SWITCH: u8 = 5;
    pub const ENDED: u8 = 6;
}

/// The player's battle action.
pub mod action {
    pub const FIGHT: u8 = 0;
    pub const BAG: u8 = 1;
    pub const SWAP: u8 = 2;
    pub const RUN: u8 = 3;
}

/// How a battle finished.
pub mod outcome {
    pub const WIN: u8 = 0;
    pub const LOSS: u8 = 1;
    pub const RAN: u8 = 2;
    pub const CAUGHT: u8 = 3;
    pub const DRAW: u8 = 4;
}

/// Actor movement behavior for NPCs.
pub mod behavior {
    pub const STILL: u8 = 0;
    pub const WANDER: u8 = 1;
    pub const PACE_H: u8 = 2;
    pub const PACE_V: u8 = 3;
    pub const SPIN: u8 = 4;
}

// ---------------------------------------------------------------------------
// The `mon` surface: ops (guest -> core) and events (core -> guest)
// ---------------------------------------------------------------------------

/// Guest -> core intent. APPEND ONLY: never renumber, never reuse.
/// Signatures are documented in contracts/spec/mon-spec.ts.
pub mod op {
    pub const LOAD_CONTENT: u32 = 1;
    pub const DEFINE_TYPE: u32 = 2;
    pub const DEFINE_SPECIES: u32 = 3;
    pub const DEFINE_MOVE: u32 = 4;
    pub const DEFINE_ITEM: u32 = 5;
    pub const DEFINE_MAP: u32 = 6;
    pub const DEFINE_SCRIPT: u32 = 7;
    pub const DEFINE_TEXT: u32 = 8;
    pub const DEFINE_TRAINER: u32 = 9;
    pub const ENTER_MAP: u32 = 20;
    pub const WARP_TO: u32 = 21;
    pub const SET_ACTOR: u32 = 22;
    pub const HIDE_ACTOR: u32 = 23;
    pub const SHOW_ACTOR: u32 = 24;
    pub const MOVE_ACTOR: u32 = 25;
    pub const FACE_ACTOR: u32 = 26;
    pub const SET_FLAG: u32 = 27;
    pub const GET_FLAG: u32 = 28;
    pub const SET_BLOCK: u32 = 29;
    pub const SHOW_TEXT: u32 = 30;
    pub const SHOW_CHOICE: u32 = 31;
    pub const CLOSE_TEXT: u32 = 32;
    pub const SET_MODE: u32 = 33;
    pub const PLAY_MUSIC: u32 = 34;
    pub const STOP_MUSIC: u32 = 35;
    pub const PLAY_SFX: u32 = 36;
    pub const PLAY_CRY: u32 = 37;
    pub const GIVEMON: u32 = 50;
    pub const HEAL_PARTY: u32 = 51;
    pub const GIVE_ITEM: u32 = 52;
    pub const TAKE_ITEM: u32 = 53;
    pub const SET_PARTY_MOVE: u32 = 54;
    pub const START_WILD: u32 = 70;
    pub const START_TRAINER: u32 = 71;
    pub const CHOOSE_ACTION: u32 = 72;
    pub const CHOOSE_MOVE: u32 = 73;
    pub const CHOOSE_ITEM: u32 = 74;
    pub const CHOOSE_SWITCH: u32 = 75;
    pub const ADVANCE: u32 = 76;
    pub const END_BATTLE: u32 = 77;
    pub const VIEW: u32 = 90;
    pub const PARTY_SLOT: u32 = 91;
    pub const TEXT: u32 = 92;
    pub const SAVE: u32 = 110;
    pub const LOAD: u32 = 111;
    pub const HAS_SAVE: u32 = 112;
    pub const SEED: u32 = 113;
    pub const VIEWPORT: u32 = 114;
    pub const EVENTS: u32 = 115;
    pub const FRAME_STATS: u32 = 116;
}

/// Core -> guest facts, drained as one batch per tick. APPEND ONLY.
pub mod event {
    pub const TALK: u16 = 1;
    pub const SIGN: u16 = 2;
    pub const WARPED: u16 = 3;
    pub const ENCOUNTER: u16 = 4;
    pub const BATTLE_ENDED: u16 = 5;
    pub const SCRIPT_DONE: u16 = 6;
    pub const TEXT_DONE: u16 = 7;
    pub const CHOICE_DONE: u16 = 8;
    pub const MENU_REQUEST: u16 = 9;
    pub const LEVEL_UP: u16 = 10;
    pub const EVOLVE: u16 = 11;
    pub const CAUGHT: u16 = 12;
    pub const FAINT: u16 = 13;
    pub const SCRIPT_HOOK: u16 = 14;
    pub const BATTLE_PROMPT: u16 = 15;
}

/// Bytes per packed event record: u16 kind | u16 a | i32 b | i32 c | i32 d.
pub const EVENT_SIZE: usize = 16;
/// Max events buffered in one tick; overflow drops the tail and sets a stat.
pub const EVENT_CAP: usize = 64;

/// `view(kind)` packed snapshots for menu rendering.
pub mod view {
    pub const WORLD: u32 = 0;
    pub const PARTY: u32 = 1;
    pub const BATTLE: u32 = 2;
    pub const BAG: u32 = 3;
    pub const PLAYER: u32 = 4;
    pub const DEX: u32 = 5;
}

// ---------------------------------------------------------------------------
// MONPAK — the cooked content container
// ---------------------------------------------------------------------------

pub mod monpak {
    pub const MAGIC: u32 = 0x504e4f4d; // 'MONP' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 16;
    pub const ENTRY_SIZE: usize = 16;
    pub const ALIGN: usize = 16;

    /// Section tags (4CC, LE u32).
    pub const TAG_ATLAS: u32 = 0x534c5441;
    pub const TAG_PALETTE: u32 = 0x4c415041;
    pub const TAG_TILESET: u32 = 0x53454c54;
    pub const TAG_MAPS: u32 = 0x5350414d;
    pub const TAG_SPECIES: u32 = 0x43455053;
    pub const TAG_MOVES: u32 = 0x564f4d53;
    pub const TAG_TYPES: u32 = 0x50595453;
    pub const TAG_ITEMS: u32 = 0x4d455449;
    pub const TAG_TRAINERS: u32 = 0x4e525254;
    pub const TAG_SCRIPTS: u32 = 0x54504353;
    pub const TAG_TEXT: u32 = 0x54584554;
    pub const TAG_FONT: u32 = 0x544e4f46;
    pub const TAG_AUDIO: u32 = 0x4f445541;
}

// ---------------------------------------------------------------------------
// Section payload layouts
// ---------------------------------------------------------------------------

/// Bytes of per-section header preceding every payload's records.
pub const SECTION_HEADER_SIZE: usize = 4;
/// ATLS page header: u16 w, u16 h, u32 byteLen, then w*h CLUT8 pixels.
pub const ATLAS_PAGE_HEADER_SIZE: usize = 8;
pub const PALETTE_ENTRIES: usize = 256;
pub const PALETTE_BYTES: usize = 1024;
/// TLES per-tileset header, block record size, and the tile behavior table.
pub const TILESET_HEADER_SIZE: usize = 4;
pub const TILESET_BLOCK_SIZE: usize = 16;
pub const TILE_BEHAVIOR_BYTES: usize = 256;
/// SPEC header: u16 count, u16 learnPoolCount.
pub const SPECIES_SECTION_HEADER_SIZE: usize = 4;
/// One learnset entry: u16 level, u16 moveId.
pub const LEARN_SIZE: usize = 4;
/// STYP header: u16 typeCount, u16 matchupCount.
pub const TYPE_SECTION_HEADER_SIZE: usize = 4;
pub const TYPE_SIZE: usize = 4;
pub const MATCHUP_SIZE: usize = 4;
pub const ITEM_SIZE: usize = 12;
pub const FONT_HEADER_SIZE: usize = 4;
pub const GLYPH_SIZE: usize = 12;
pub const SCRIPT_ENTRY_SIZE: usize = 12;
/// A string's index IS its key id; no hashing happens at runtime.
pub const TEXT_ENTRY_SIZE: usize = 8;
pub const AUDIO_ENTRY_SIZE: usize = 4;
/// A track is a tracker pattern; see mon-spec.ts for the cell layout.
pub const AUDIO_HEADER_SIZE: usize = 8;
pub const AUDIO_CELL_SIZE: usize = 4;
/// Pulse 1, pulse 2, wave, noise — the classic four.
pub const AUDIO_CHANNELS: usize = 4;
pub const SAMPLE_RATE: u32 = 44100;
pub const AUDIO_BUFFER: usize = 1024;
/// Cell `note` values that are not a semitone.
pub const NOTE_HOLD: u8 = 0;
pub const NOTE_OFF: u8 = 1;

/// What an item does when used.
pub mod item_kind {
    pub const NONE: u8 = 0;
    pub const BALL: u8 = 1;
    pub const HEAL: u8 = 2;
    pub const STATUS: u8 = 3;
    pub const REVIVE: u8 = 4;
    pub const BOOST: u8 = 5;
    pub const KEY: u8 = 6;
    pub const ESCAPE: u8 = 7;
    pub const REPEL: u8 = 8;
}

// ---------------------------------------------------------------------------
// Record layouts (fixed-size, LE) — the cooker writes, the core reads
// ---------------------------------------------------------------------------

/// SPECIES record byte size (layout in mon-spec.ts).
pub const SPECIES_SIZE: usize = 32;
/// MOVE record byte size.
pub const MOVE_SIZE: usize = 16;
/// Move `flags` bits.
pub const MOVE_FLAG_HIGH_CRIT: u8 = 1;
pub const MOVE_FLAG_MULTI_HIT: u8 = 2;
pub const MOVE_FLAG_CHARGE: u8 = 4;
pub const MOVE_FLAG_RECHARGE: u8 = 8;
/// Moves first regardless of speed (the "quick attack" class).
pub const MOVE_FLAG_PRIORITY: u8 = 16;

/// Move effects the core implements natively; anything else raises
/// a `scriptHook` event for the guest. Append-only.
pub mod effect {
    pub const NONE: u8 = 0;
    pub const BURN_CHANCE: u8 = 1;
    pub const FREEZE_CHANCE: u8 = 2;
    pub const PARALYZE_CHANCE: u8 = 3;
    pub const POISON_CHANCE: u8 = 4;
    pub const SLEEP: u8 = 5;
    pub const CONFUSE: u8 = 6;
    pub const FLINCH_CHANCE: u8 = 7;
    pub const ATK_DOWN: u8 = 8;
    pub const DEF_DOWN: u8 = 9;
    pub const SPD_DOWN: u8 = 10;
    pub const SPC_DOWN: u8 = 11;
    pub const ACC_DOWN: u8 = 12;
    pub const ATK_UP: u8 = 13;
    pub const DEF_UP: u8 = 14;
    pub const SPD_UP: u8 = 15;
    pub const SPC_UP: u8 = 16;
    pub const DRAIN: u8 = 17;
    pub const RECOIL: u8 = 18;
    pub const MULTI_HIT: u8 = 19;
    pub const TWO_HIT: u8 = 20;
    pub const OHKO: u8 = 21;
    pub const HIGH_CRIT: u8 = 22;
    pub const CHARGE: u8 = 23;
    pub const HYPER_BEAM: u8 = 24;
    pub const REFLECT: u8 = 25;
    pub const LIGHT_SCREEN: u8 = 26;
    pub const HAZE: u8 = 27;
    pub const HEAL: u8 = 28;
    pub const REST: u8 = 29;
    pub const EXPLODE: u8 = 30;
    pub const FIXED_DAMAGE: u8 = 31;
    pub const LEVEL_DAMAGE: u8 = 32;
    pub const SUPER_FANG: u8 = 33;
    pub const SWIFT: u8 = 34;
    pub const TRAP: u8 = 35;
    pub const PAY_DAY: u8 = 36;
    pub const MIST: u8 = 37;
    pub const FOCUS_ENERGY: u8 = 38;
    pub const SUBSTITUTE: u8 = 39;
    pub const TRANSFORM: u8 = 40;
    pub const CONVERSION: u8 = 41;
    pub const METRONOME: u8 = 42;
    pub const MIRROR_MOVE: u8 = 43;
    pub const DISABLE: u8 = 44;
    pub const LEECH_SEED: u8 = 45;
    pub const DREAM_EATER: u8 = 46;
}

/// MAP header byte size; the block array and variable sections follow.
pub const MAP_HEADER_SIZE: usize = 32;
pub const MAP_FLAG_INDOOR: u8 = 1;
pub const MAP_FLAG_DARK: u8 = 2;
pub const MAP_FLAG_NO_ESCAPE: u8 = 4;
pub const WARP_SIZE: usize = 8;
pub const SIGN_SIZE: usize = 4;
pub const ACTOR_SIZE: usize = 12;
pub const SLOT_SIZE: usize = 4;
/// Encounter slots per map.
pub const SLOT_COUNT: usize = 10;
/// Cumulative slot thresholds out of 256; rand(0..255) picks the first
/// bucket it falls under (ported from the upstream wild-encounter buckets).
pub const ENCOUNTER_BUCKETS: [u16; 10] = [51, 102, 141, 166, 191, 212, 233, 243, 253, 256];
pub const TRAINER_HEADER_SIZE: usize = 8;
pub const TRAINER_MON_SIZE: usize = 12;
pub const TRAINER_PARTY_MAX: usize = 6;

// ---------------------------------------------------------------------------
// Script VM — the compiled command list
// ---------------------------------------------------------------------------

pub const SCRIPT_VERSION: u16 = 1;
pub const SCRIPT_HEADER_SIZE: usize = 8;

/// The script verb set: the upstream Commands.lua vocabulary trimmed to
/// what the core implements natively. Unknown verbs raise `scriptHook`.
pub mod verb {
    pub const END: u8 = 0;
    pub const SHOW_TEXT: u8 = 1;
    pub const ASK: u8 = 2;
    pub const JUMP: u8 = 3;
    pub const JUMP_IF_TRUE: u8 = 4;
    pub const JUMP_IF_FALSE: u8 = 5;
    pub const SET_FLAG: u8 = 6;
    pub const CLEAR_FLAG: u8 = 7;
    pub const CHECK_FLAG: u8 = 8;
    pub const CHECK_ITEM: u8 = 9;
    pub const GIVE_ITEM: u8 = 10;
    pub const TAKE_ITEM: u8 = 11;
    pub const START_BATTLE: u8 = 12;
    pub const WARP: u8 = 13;
    pub const WAIT: u8 = 14;
    pub const MOVE_PLAYER: u8 = 15;
    pub const MOVE_NPC: u8 = 16;
    pub const FACE_NPC: u8 = 17;
    pub const FACE_PLAYER: u8 = 18;
    pub const SHOW_OBJECT: u8 = 19;
    pub const HIDE_OBJECT: u8 = 20;
    pub const PLAY_SOUND: u8 = 21;
    pub const PLAY_CRY: u8 = 22;
    pub const PLAY_MUSIC: u8 = 23;
    pub const STOP_MUSIC: u8 = 24;
    pub const HEAL_PARTY: u8 = 25;
    pub const GIVEMON: u8 = 26;
    pub const GIVE_MONEY: u8 = 27;
    pub const CHECK_BATTLE_RESULT: u8 = 28;
    pub const TRAINER_BATTLE: u8 = 29;
    pub const OPEN_MART: u8 = 30;
    pub const REPLACE_BLOCK: u8 = 31;
    pub const FADE: u8 = 32;
    pub const PAN_CAMERA: u8 = 33;
    pub const EMOTE: u8 = 34;
    pub const LABEL: u8 = 35;
    pub const HOOK: u8 = 36;
    pub const SET_FIELD: u8 = 37;
    pub const CHOICE: u8 = 38;
    pub const WAIT_FLAG: u8 = 39;
    pub const TEXT_OPTS: u8 = 40;
}

// ---------------------------------------------------------------------------
// Draw list — the backend-independent frame output
// ---------------------------------------------------------------------------

pub const QUAD_SIZE: usize = 16;
pub const RECT_SIZE: usize = 12;
pub const QUAD_FLAG_FLIP_X: u8 = 1;
pub const QUAD_FLAG_FLIP_Y: u8 = 2;
/// Per-vertex tint; this value is "untinted".
pub const TINT_NONE: u32 = 0xffffffff;
/// Atlas page edge in pixels (CLUT8: one page is PAGE_PX^2 bytes).
pub const PAGE_PX: u32 = 256;
pub const PAGE_MAX: usize = 8;

// ---------------------------------------------------------------------------
// Save format
// ---------------------------------------------------------------------------

pub mod save {
    pub const MAGIC: u32 = 0x5641534d; // 'MSAV' LE
    pub const VERSION: u16 = 1;
    pub const HEADER_SIZE: usize = 16;
    /// FNV-1a 32-bit, the same constants the .pak container uses.
    pub const FNV1A_OFFSET_BASIS: u32 = 0x811c9dc5;
    pub const FNV1A_PRIME: u32 = 0x01000193;
}

/// Event flags addressable by scripts.
pub const FLAG_COUNT: usize = 512;

// ---------------------------------------------------------------------------
// Battle tuning constants (the default ruleset)
// ---------------------------------------------------------------------------

/// Damage randomization: d = d * rand(RAND_MIN..=RAND_MAX) / 255.
pub const RAND_MIN: u32 = 217;
pub const RAND_MAX: u32 = 255;
/// Stat-stage multipliers x100, indexed `stage + 6` (index 6 = stage 0).
pub const STAGE_MULT: [u32; 13] = [25, 28, 33, 40, 50, 66, 100, 150, 200, 250, 300, 350, 400];
/// Stats clamp here after a stage multiplication.
pub const STAT_MAX: u32 = 999;
/// Damage clamps here before the +2, then the random factor applies.
pub const DAMAGE_CLAMP: u32 = 997;
/// Both stats are quartered when either exceeds this (byte-overflow rule).
pub const STAT_SCALE_LIMIT: u32 = 255;
/// STAB is x3/2.
pub const STAB_NUM: u32 = 3;
pub const STAB_DEN: u32 = 2;
/// Type multipliers are x10 fixed point.
pub const TYPE_SCALE: u32 = 10;
pub const BALL_RATE: [u32; 4] = [255, 200, 150, 100];
/// Status bonus added to the catch roll.
pub const CATCH_BONUS_NONE: u32 = 0;
pub const CATCH_BONUS_SLEEP_FREEZE: u32 = 25;
pub const CATCH_BONUS_OTHER: u32 = 12;
