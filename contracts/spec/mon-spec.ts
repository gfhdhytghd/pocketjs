// Pocket Mon spec — THE single source of truth for the `mon` surface.
//
// Same contract discipline as contracts/spec/spec.ts: everything the Rust core
// (engine/pocketmon/crates/pocketmon-core/), the content cooker
// (apps/mon/cook.ts), the guest SDK (apps/mon/sdk/) and the PSP EBOOT agree on
// is pinned HERE, in plain data. `contracts/spec/gen-mon-rust.ts` deterministically
// generates `engine/pocketmon/crates/pocketmon-core/src/spec.rs` from this file;
// `tests/mon-contract.test.ts` regenerates it in-memory and byte-compares against
// the committed file, so TS and Rust can never drift.
//
// Conventions (inherited, non-negotiable):
//   - Little-endian everywhere.
//   - Colors are u32 ABGR (0xAABBGGRR) — the PSP GE COLOR_8888 layout.
//   - Op codes are append-only: never renumber, never reuse. 0 is reserved.
//
// See docs/MON.md for the architecture this contract serves, including the
// clean-room boundary (no ROM, no extracted content, ever).

// ---------------------------------------------------------------------------
// Geometry — the three coordinate units (docs/MON.md §4)
// ---------------------------------------------------------------------------

/** Graphics unit: an 8x8 pixel tile. */
export const TILE_PX = 8;
/** Walk-grid unit: a 16x16 pixel cell = 2x2 tiles. Every actor/warp/sign coord. */
export const CELL_PX = 16;
/** Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles. */
export const BLOCK_PX = 32;
/** Tiles per block edge (4) — a block's tile array is BLOCK_TILES^2 entries. */
export const BLOCK_TILES = 4;
/** Cells per block edge (2). */
export const BLOCK_CELLS = 2;

/**
 * The logical view, in GB-scale pixels. The PSP host renders this 2x into
 * 480x272 (docs/MON.md §4: no integer scale fits 160x144 on 480x272, so we
 * widen the view instead of blurring or letterboxing). 240x136 = 30x17 tiles.
 */
export const VIEW_W = 240;
export const VIEW_H = 136;
/** The original handheld framing, kept for reference and for 1x hosts. */
export const GB_W = 160;
export const GB_H = 144;

/** Fixed simulation step: 60 Hz, matching the UI runtime's FIXED_DT. */
export const TICK_HZ = 60;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/**
 * The core's abstract button set. Hosts map their physical buttons onto this
 * (the PSP host maps CROSS->a, CIRCLE->b to match the console's confirm
 * convention); the core, the tapes and the goldens only ever see these bits,
 * which is what lets one input tape replay on every host.
 */
export const MON_BTN = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7,
} as const;

// ---------------------------------------------------------------------------
// Party / bag / box limits
// ---------------------------------------------------------------------------

export const PARTY_MAX = 6;
export const MOVES_MAX = 4;
export const BOX_COUNT = 8;
export const BOX_SIZE = 20;
export const BAG_MAX = 20;
/** Max simultaneously-loaded actors on a map (player is index 0). */
export const ACTORS_MAX = 16;
/** Level cap — growth curves are evaluated up to this. */
export const LEVEL_MAX = 100;
/** Stat stages clamp to +-6. */
export const STAGE_MIN = -6;
export const STAGE_MAX = 6;

// ---------------------------------------------------------------------------
// Enums — closed vocabularies the core and guest share
// ---------------------------------------------------------------------------

/** Facing / movement direction. Matches the walk-sheet frame order. */
export const DIR = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
} as const;

/** What a cell does, derived from its bottom-left 8x8 tile. */
export const CELL = {
  wall: 0,
  floor: 1,
  grass: 2,
  water: 3,
  door: 4,
  warp: 5,
  ledgeDown: 6,
  counter: 7,
} as const;

/** Persistent status conditions. `none` must stay 0 (save-format default). */
export const STATUS = {
  none: 0,
  sleep: 1,
  poison: 2,
  burn: 3,
  freeze: 4,
  paralysis: 5,
  badPoison: 6,
} as const;

/**
 * Damage category. Gen 1 splits physical/special by the move's TYPE, not per
 * move; a type record carries its category and a move may override it.
 */
export const CATEGORY = {
  physical: 0,
  special: 1,
  status: 2,
} as const;

/** Experience growth curves (see growth.rs for the polynomial of each). */
export const GROWTH = {
  mediumFast: 0,
  slightlyFast: 1,
  slightlySlow: 2,
  mediumSlow: 3,
  fast: 4,
  slow: 5,
} as const;

/** The overworld/battle top-level mode the core is in. */
export const MODE = {
  overworld: 0,
  text: 1,
  battle: 2,
  menu: 3,
  transition: 4,
} as const;

/** Battle phase — what the core is waiting for. */
export const PHASE = {
  intro: 0,
  chooseAction: 1,
  chooseMove: 2,
  resolving: 3,
  message: 4,
  chooseSwitch: 5,
  ended: 6,
} as const;

/** The player's battle action, as chosen through `chooseAction`. */
export const ACTION = {
  fight: 0,
  bag: 1,
  swap: 2,
  run: 3,
} as const;

/** How a battle finished (payload of the `battleEnded` event). */
export const OUTCOME = {
  win: 0,
  loss: 1,
  ran: 2,
  caught: 3,
  draw: 4,
} as const;

/** Actor movement behavior for NPCs. */
export const BEHAVIOR = {
  still: 0,
  wander: 1,
  paceH: 2,
  paceV: 3,
  spin: 4,
} as const;

// ---------------------------------------------------------------------------
// Ops — guest -> core intent. APPEND ONLY.
// ---------------------------------------------------------------------------
//
// Signatures (authoritative; the host marshals them as QuickJS C functions
// under `globalThis.mon`):
//
//   -- content (boot-time upload; see MONPAK below) ------------------------
//   loadContent(blob: ArrayBuffer) -> bool     cooked MONPAK, parsed core-side
//   defineType(id, name, category, matchups: ArrayBuffer) -> i32
//   defineSpecies(id, blob: ArrayBuffer) -> i32       (SPECIES record layout)
//   defineMove(id, blob: ArrayBuffer) -> i32          (MOVE record layout)
//   defineItem(id, blob: ArrayBuffer) -> i32
//   defineMap(id, blob: ArrayBuffer) -> i32           (MAP record layout)
//   defineScript(key: string, blob: ArrayBuffer) -> i32   (compiled SCRIPT)
//   defineText(key: string, s: string) -> i32
//   defineTrainer(id, blob: ArrayBuffer) -> i32
//
//   -- world ---------------------------------------------------------------
//   enterMap(mapId, cellX, cellY, dir)         hard placement (new game/load)
//   warpTo(mapId, cellX, cellY, dir, style)    fade + placement
//   setActor(slot, blob)                       spawn/update an NPC
//   hideActor(slot) / showActor(slot)
//   moveActor(slot, dir, cells)                queued scripted walk
//   faceActor(slot, dir)
//   setFlag(id, value) / getFlag(id) -> i32
//   setBlock(mapId, blockX, blockY, blockId)   replace_block
//   showText(s: string, opts) -> i32           push a textbox; returns handle
//   showChoice(s: string, opts) -> i32         yes/no or list
//   closeText()
//   setMode(mode)
//   playMusic(id) / stopMusic() / playSfx(id) / playCry(speciesId)
//
//   -- party / bag ---------------------------------------------------------
//   givemon(speciesId, level, flags) -> slot | -1
//   healParty()
//   giveItem(itemId, qty) -> bool / takeItem(itemId, qty) -> bool
//   setPartyMove(slot, moveIdx, moveId)
//
//   -- battle --------------------------------------------------------------
//   startWild(speciesId, level, flags)
//   startTrainer(trainerId, flags)
//   chooseAction(action) / chooseMove(idx) / chooseItem(itemId)
//   chooseSwitch(slot) / advance()             advance() = "A" on a message
//   endBattle()
//
//   -- query (cold path: menu rendering reads these, never per-frame) ------
//   view(kind) -> ArrayBuffer                  packed snapshot (VIEW_* below)
//   partySlot(i) -> ArrayBuffer
//   text(key) -> string
//
//   -- system --------------------------------------------------------------
//   save() -> bool / load() -> bool / hasSave() -> bool
//   seed(lo, hi)                               deterministic RNG seed
//   viewport(w, h)                             logical view size
//   events() -> ArrayBuffer                    drain the per-tick event batch
//   frameStats() -> ArrayBuffer                debug counters

export const MON_OP = {
  loadContent: 1,
  defineType: 2,
  defineSpecies: 3,
  defineMove: 4,
  defineItem: 5,
  defineMap: 6,
  defineScript: 7,
  defineText: 8,
  defineTrainer: 9,

  enterMap: 20,
  warpTo: 21,
  setActor: 22,
  hideActor: 23,
  showActor: 24,
  moveActor: 25,
  faceActor: 26,
  setFlag: 27,
  getFlag: 28,
  setBlock: 29,
  showText: 30,
  showChoice: 31,
  closeText: 32,
  setMode: 33,
  playMusic: 34,
  stopMusic: 35,
  playSfx: 36,
  playCry: 37,

  givemon: 50,
  healParty: 51,
  giveItem: 52,
  takeItem: 53,
  setPartyMove: 54,

  startWild: 70,
  startTrainer: 71,
  chooseAction: 72,
  chooseMove: 73,
  chooseItem: 74,
  chooseSwitch: 75,
  advance: 76,
  endBattle: 77,

  view: 90,
  partySlot: 91,
  text: 92,

  save: 110,
  load: 111,
  hasSave: 112,
  seed: 113,
  viewport: 114,
  events: 115,
  frameStats: 116,
} as const;

// ---------------------------------------------------------------------------
// Events — core -> guest facts, drained as one batch per tick. APPEND ONLY.
// ---------------------------------------------------------------------------
//
// Wire layout: a u32 count, then `count` records of EVENT_SIZE bytes:
//   u16 kind | u16 a | i32 b | i32 c | i32 d
// String payloads are interned: `d` indexes the event string table, read back
// with `mon.text("$evt:<d>")`. Numeric-only events keep the boundary cheap.

export const MON_EVENT = {
  /** Player pressed A facing an actor. a = actor slot, b = text key id. */
  talk: 1,
  /** Player pressed A facing a sign. b = text key id. */
  sign: 2,
  /** Arrived on a new map. a = mapId, b = cellX, c = cellY, d = dir. */
  warped: 3,
  /** Wild encounter rolled. a = speciesId, b = level. */
  encounter: 4,
  /** Battle finished. a = OUTCOME, b = trainerId or -1. */
  battleEnded: 5,
  /** A script ran to completion. a = script handle. */
  scriptDone: 6,
  /** A textbox the guest pushed was dismissed. a = handle. */
  textDone: 7,
  /** A choice box resolved. a = handle, b = chosen index. */
  choiceDone: 8,
  /** The core wants the guest to open a menu. a = menu kind. */
  menuRequest: 9,
  /** a = party slot, b = new level. */
  levelUp: 10,
  /** a = party slot, b = from species, c = to species. */
  evolve: 11,
  /** a = speciesId, b = level, c = party slot or -1 when boxed. */
  caught: 12,
  /** a = side (0 = player), b = party slot. */
  faint: 13,
  /** A script asked the guest to run a verb it does not implement natively. */
  scriptHook: 14,
  /** Battle message queue drained; guest may render the next prompt. */
  battlePrompt: 15,
} as const;

/** Bytes per packed event record: 2 + 2 + 4 + 4 + 4 (see the wire layout above). */
export const EVENT_SIZE = 16;
/** Max events buffered in one tick; overflow drops the tail and sets a stat. */
export const EVENT_CAP = 64;

// ---------------------------------------------------------------------------
// View snapshots — `view(kind)` packed reads for menu rendering
// ---------------------------------------------------------------------------

export const VIEW = {
  world: 0,
  party: 1,
  battle: 2,
  bag: 3,
  player: 4,
  dex: 5,
} as const;

// ---------------------------------------------------------------------------
// MONPAK — the cooked content container
// ---------------------------------------------------------------------------
//
// Layout:
//   0   u32  MAGIC ('MONP' LE)
//   4   u16  VERSION
//   6   u16  section count
//   8   u32  total byte length
//   12  u32  reserved (0)
//   16  section table: `count` entries of MONPAK_ENTRY_SIZE bytes:
//              u32 tag | u32 offset | u32 length | u32 count
//   ..  section payloads, each aligned to MONPAK_ALIGN
//
// Every offset is from the start of the blob. Sections appear in tag order.

export const MONPAK_MAGIC = 0x504e4f4d; // 'MONP'
export const MONPAK_VERSION = 1;
export const MONPAK_HEADER_SIZE = 16;
export const MONPAK_ENTRY_SIZE = 16;
export const MONPAK_ALIGN = 16;

/** Section tags (4CC, LE u32). */
export const MONPAK_TAG = {
  /** CLUT8 atlas pages: u16 pageCount, then per page u16 w,h + pixels. */
  atlas: 0x534c5441, // 'ATLS'
  /** 256-entry u32 ABGR palette (the whole game shares one; FX rewrite it). */
  palette: 0x4c415041, // 'APAL'
  /** Tilesets: block tile arrays + per-tile behavior. */
  tileset: 0x53454c54, // 'TLES'
  /** Maps: block layout, warps, signs, actors, connections, encounters. */
  maps: 0x5350414d, // 'MAPS'
  /** Species records. */
  species: 0x43455053, // 'SPEC'
  /** Move records. */
  moves: 0x564f4d53, // 'SMOV'
  /** Type records + the matchup table. */
  types: 0x50595453, // 'STYP'
  /** Item records. */
  items: 0x4d455449, // 'ITEM'
  /** Trainer records (party rosters + AI class + reward). */
  trainers: 0x4e525254, // 'TRRN'
  /** Compiled scripts, keyed by name. */
  scripts: 0x54504353, // 'SCPT'
  /** The string table (UTF-8, length-prefixed), keyed by name. */
  text: 0x54584554, // 'TEXT'
  /** The font: charmap + glyph metrics into the atlas. */
  font: 0x544e4f46, // 'FONT'
  /** Music + SFX: channel programs for the chip synth. */
  audio: 0x4f445541, // 'AUDO'
} as const;

// ---------------------------------------------------------------------------
// Section payload layouts
// ---------------------------------------------------------------------------
//
// Every section payload starts with a 4-byte header — `u16 count` plus two
// bytes whose meaning is per-section (mostly reserved) — so the core can size
// its registries in one read before touching records. Variable-length sections
// (maps, trainers, scripts, text) follow the header with a u32 offset table
// relative to the payload start.

/** Bytes of per-section header preceding every payload's records. */
export const SECTION_HEADER_SIZE = 4;

/** ATLS page header: u16 w, u16 h, u32 byteLen, then w*h CLUT8 pixels. */
export const ATLAS_PAGE_HEADER_SIZE = 8;
/** APAL is exactly 256 u32 ABGR entries. */
export const PALETTE_ENTRIES = 256;
export const PALETTE_BYTES = 1024;

/**
 * TLES per-tileset: u16 blockCount, u16 reserved, then blockCount block
 * records of BLOCK_TILES^2 (=16) tile ids, then a 256-byte table mapping tile
 * id -> CELL behavior. The behavior table is what makes the bottom-left-tile
 * rule a single array read per collision query.
 */
export const TILESET_HEADER_SIZE = 4;
export const TILESET_BLOCK_SIZE = 16;
export const TILE_BEHAVIOR_BYTES = 256;

/** SPEC header: u16 count, u16 learnPoolCount; learnset pairs follow records. */
export const SPECIES_SECTION_HEADER_SIZE = 4;
/** One learnset entry: u16 level, u16 moveId. */
export const LEARN_SIZE = 4;

/** STYP header: u16 typeCount, u16 matchupCount. */
export const TYPE_SECTION_HEADER_SIZE = 4;
/** TYPE record, 4 bytes: u8 category, u8 reserved, u16 nameKey. */
export const TYPE_SIZE = 4;
/** MATCHUP record, 4 bytes: u8 attacker, u8 defender, u16 multiplier (x10). */
export const MATCHUP_SIZE = 4;

/**
 * ITEM record, 12 bytes:
 *   0 u16 id | 2 u16 nameKey | 4 u16 descKey | 6 u8 kind | 7 u8 param
 *   8 u16 price | 10 u16 reserved
 */
export const ITEM_SIZE = 12;

/** What an item does when used. */
export const ITEM_KIND = {
  none: 0,
  ball: 1,
  heal: 2,
  status: 3,
  revive: 4,
  boost: 5,
  key: 6,
  escape: 7,
  repel: 8,
} as const;

/**
 * FONT header: u16 glyphCount, u8 lineHeight, u8 page; then glyph records of
 * GLYPH_SIZE bytes: u32 codepoint, u16 u, u16 v, u8 w, u8 h, u8 advance,
 * u8 reserved.
 */
export const FONT_HEADER_SIZE = 4;
export const GLYPH_SIZE = 12;

/**
 * SCPT header: u16 count, u16 reserved; then `count` directory entries of
 * SCRIPT_ENTRY_SIZE bytes: u16 nameKey, u16 reserved, u32 offset, u32 length.
 */
export const SCRIPT_ENTRY_SIZE = 12;

/**
 * TEXT header: u16 count, u16 reserved; then `count` entries of
 * TEXT_ENTRY_SIZE bytes: u32 offset, u32 length (UTF-8, not NUL-terminated).
 * A string's index IS its key id — scripts and records reference strings by
 * that u16, so no hashing happens at runtime.
 */
export const TEXT_ENTRY_SIZE = 8;

/**
 * AUDO header: u16 songCount, u16 sfxCount; then a u32 offset table with
 * `songCount + sfxCount + 1` entries (the extra one bounds the last track),
 * then the tracks.
 *
 * A track is a tracker pattern — the compact shape a four-channel chip wants,
 * and the one a human can actually author by hand:
 *
 *   0  u16 rowsPerMinute   tempo, in rows (not beats) per minute
 *   2  u16 rows            pattern length
 *   4  u8  channels        always AUDIO_CHANNELS
 *   5  u8  loopRow         row to jump back to at the end; 0xff = play once
 *   6  u16 reserved
 *   8  rows * channels cells of AUDIO_CELL_SIZE bytes:
 *        u8 note      0 = hold, 1 = note off, else a semitone index where
 *                     69 is A4 (the MIDI convention, so a tuner agrees)
 *        u8 param     pulse: duty 0..3 | wave: table 0..3 | noise: period
 *        u8 volume    0..15, the chip's four-bit range
 *        u8 flags     bit 0 = restart the envelope even on a held note
 */
export const AUDIO_ENTRY_SIZE = 4;
export const AUDIO_HEADER_SIZE = 8;
export const AUDIO_CELL_SIZE = 4;
/** Pulse 1, pulse 2, wave, noise — the classic four. */
export const AUDIO_CHANNELS = 4;
/** Output rate. The PSP's audio hardware wants 44.1 kHz. */
export const SAMPLE_RATE = 44100;
/** Samples per host buffer; the PSP's channel granularity is 64. */
export const AUDIO_BUFFER = 1024;
/** Cell `note` values with a meaning other than "play this semitone". */
export const NOTE_HOLD = 0;
export const NOTE_OFF = 1;

// ---------------------------------------------------------------------------
// Record layouts (fixed-size, LE) — the cooker writes these, the core reads them
// ---------------------------------------------------------------------------

/**
 * SPECIES, 32 bytes:
 *   0  u16 id            2  u8 baseHp        3  u8 baseAtk
 *   4  u8  baseDef       5  u8 baseSpd       6  u8 baseSpc
 *   7  u8  type1         8  u8 type2         9  u8 catchRate
 *   10 u16 baseExp      12  u8 growth       13  u8 frontTile (atlas slot)
 *   14 u8  backTile     15  u8 iconTile
 *   16 u16 nameKey      18  u16 dexKey
 *   20 u8  learnCount   21  u8 evolveKind   22 u16 evolveParam
 *   24 u16 evolveInto   26  u16 learnOffset (index into the learnset pool)
 *   28 u32 reserved
 */
export const SPECIES_SIZE = 32;

/**
 * MOVE, 16 bytes:
 *   0  u16 id            2  u8 type          3  u8 power
 *   4  u8  accuracy      5  u8 pp            6  u8 category
 *   7  u8  effect        8  u8 effectChance  9  u8 flags (bit0 highCrit)
 *   10 u16 nameKey      12  u16 descKey     14  u16 animId
 */
export const MOVE_SIZE = 16;

/** Move `flags` bits. */
export const MOVE_FLAG_HIGH_CRIT = 1 << 0;
export const MOVE_FLAG_MULTI_HIT = 1 << 1;
export const MOVE_FLAG_CHARGE = 1 << 2;
export const MOVE_FLAG_RECHARGE = 1 << 3;
/**
 * Moves first regardless of speed. One bit rather than a signed priority
 * field because the record has no spare byte and this covers the whole
 * "quick attack" class; a future spec bump can widen it.
 */
export const MOVE_FLAG_PRIORITY = 1 << 4;

/**
 * Move effects the core implements natively. Anything else is a `scriptHook`
 * event for the guest. Append-only.
 */
export const EFFECT = {
  none: 0,
  burnChance: 1,
  freezeChance: 2,
  paralyzeChance: 3,
  poisonChance: 4,
  sleep: 5,
  confuse: 6,
  flinchChance: 7,
  atkDown: 8,
  defDown: 9,
  spdDown: 10,
  spcDown: 11,
  accDown: 12,
  atkUp: 13,
  defUp: 14,
  spdUp: 15,
  spcUp: 16,
  drain: 17,
  recoil: 18,
  multiHit: 19,
  twoHit: 20,
  ohko: 21,
  highCrit: 22,
  charge: 23,
  hyperBeam: 24,
  reflect: 25,
  lightScreen: 26,
  haze: 27,
  heal: 28,
  rest: 29,
  explode: 30,
  fixedDamage: 31,
  levelDamage: 32,
  superFang: 33,
  swift: 34,
  trap: 35,
  payDay: 36,
  mist: 37,
  focusEnergy: 38,
  substitute: 39,
  transform: 40,
  conversion: 41,
  metronome: 42,
  mirrorMove: 43,
  disable: 44,
  leechSeed: 45,
  dreamEater: 46,
} as const;

/**
 * MAP header, 32 bytes, followed by the block array and the variable sections:
 *   0  u16 id            2  u8 width (blocks)   3  u8 height (blocks)
 *   4  u8  tileset       5  u8 borderBlock      6  u8 flags
 *   7  u8  encounterRate
 *   8  u16 nameKey      10  u16 musicId
 *   12 u8  warpCount    13  u8 signCount       14 u8 actorCount   15 u8 slotCount
 *   16 i16 connNorth    18 i16 connSouth       20 i16 connWest    22 i16 connEast
 *   24 i16 connNorthOff 26 i16 connSouthOff    28 i16 connWestOff 30 i16 connEastOff
 */
export const MAP_HEADER_SIZE = 32;
/** Map `flags` bits. */
export const MAP_FLAG_INDOOR = 1 << 0;
export const MAP_FLAG_DARK = 1 << 1;
export const MAP_FLAG_NO_ESCAPE = 1 << 2;

/** WARP, 8 bytes: u8 x, u8 y, u16 destMap, u8 destWarp, u8 dir, u16 reserved. */
export const WARP_SIZE = 8;
/** SIGN, 4 bytes: u8 x, u8 y, u16 textKey. */
export const SIGN_SIZE = 4;
/**
 * ACTOR, 12 bytes:
 *   0 u8 x | 1 u8 y | 2 u8 dir | 3 u8 behavior
 *   4 u8 sprite | 5 u8 flags | 6 u16 textKey
 *   8 i16 trainerId | 10 u16 flagGate (hidden while this flag is set; 0xffff = none)
 */
export const ACTOR_SIZE = 12;
/** ENCOUNTER SLOT, 4 bytes: u16 species, u8 level, u8 reserved. */
export const SLOT_SIZE = 4;
/** Encounter slots per map (the classic bucket count). */
export const SLOT_COUNT = 10;
/**
 * Cumulative slot thresholds out of 256. rand(0..255) picks the first bucket
 * it falls under. Ported from the upstream engine's wild-encounter buckets.
 */
export const ENCOUNTER_BUCKETS = [51, 102, 141, 166, 191, 212, 233, 243, 253, 256];

/**
 * TRAINER header, 8 bytes + roster:
 *   0 u16 id | 2 u16 nameKey | 4 u8 aiClass | 5 u8 partyCount
 *   6 u16 rewardBase
 * followed by `partyCount` TRAINER_MON records of 12 bytes:
 *   u16 species | u8 level | u8 flags | u16 move0..move3 (8 bytes)
 */
export const TRAINER_HEADER_SIZE = 8;
export const TRAINER_MON_SIZE = 12;
export const TRAINER_PARTY_MAX = 6;

// ---------------------------------------------------------------------------
// Script VM — the compiled command list
// ---------------------------------------------------------------------------
//
// A compiled script is a header + an instruction stream:
//   0 u16 version | 2 u16 opCount | 4 u16 labelCount | 6 u16 reserved
//   then `labelCount` u32 label offsets, then the stream.
// Each instruction: u8 verb | u8 argCount | then `argCount` i32 args.
// String arguments are text-table key ids (u16 widened to i32).
//
// The verb set is the upstream `src/script/Commands.lua` vocabulary, trimmed to
// what the core implements natively; unknown verbs raise `scriptHook`.

export const SCRIPT_VERSION = 1;
export const SCRIPT_HEADER_SIZE = 8;

export const VERB = {
  end: 0,
  showText: 1,
  ask: 2,
  jump: 3,
  jumpIfTrue: 4,
  jumpIfFalse: 5,
  setFlag: 6,
  clearFlag: 7,
  checkFlag: 8,
  checkItem: 9,
  giveItem: 10,
  takeItem: 11,
  startBattle: 12,
  warp: 13,
  wait: 14,
  movePlayer: 15,
  moveNpc: 16,
  faceNpc: 17,
  facePlayer: 18,
  showObject: 19,
  hideObject: 20,
  playSound: 21,
  playCry: 22,
  playMusic: 23,
  stopMusic: 24,
  healParty: 25,
  givemon: 26,
  giveMoney: 27,
  checkBattleResult: 28,
  trainerBattle: 29,
  openMart: 30,
  replaceBlock: 31,
  fade: 32,
  panCamera: 33,
  emote: 34,
  label: 35,
  hook: 36,
  setField: 37,
  choice: 38,
  waitFlag: 39,
  textOpts: 40,
} as const;

// ---------------------------------------------------------------------------
// Draw list — the backend-independent frame output (mirrors DrawList in core)
// ---------------------------------------------------------------------------
//
// The core emits one MonDrawList per frame in LOGICAL view pixels
// (VIEW_W x VIEW_H); the host scales it. Two arrays, drawn in order:
//   quads: textured, from the CLUT8 atlas pages
//   rects: solid ABGR fills (text boxes, fades, HP bars)
//
// QUAD, 16 bytes: i16 x | i16 y | u16 u | u16 v | u8 w | u8 h | u8 page |
//                 u8 flags | u32 tint
// RECT, 12 bytes: i16 x | i16 y | u16 w | u16 h | u32 color

export const QUAD_SIZE = 16;
export const RECT_SIZE = 12;
export const QUAD_FLAG_FLIP_X = 1 << 0;
export const QUAD_FLAG_FLIP_Y = 1 << 1;
/** Tint is modulated per-vertex; 0xffffffff is untinted. */
export const TINT_NONE = 0xffffffff;
/** Atlas page edge, in pixels (CLUT8, so one page is PAGE_PX^2 bytes). */
export const PAGE_PX = 256;
export const PAGE_MAX = 8;

// ---------------------------------------------------------------------------
// Save format
// ---------------------------------------------------------------------------
//
//   0  u32 MAGIC ('MSAV') | 4 u16 VERSION | 6 u16 flags
//   8  u32 byte length    | 12 u32 FNV-1a checksum of everything after byte 16
//   16 payload: player, party, boxes, bag, flags, world position, RNG state
//
// The checksum is the same FNV-1a the pak uses, so hosts share one helper.

export const SAVE_MAGIC = 0x5641534d; // 'MSAV'
export const SAVE_VERSION = 1;
export const SAVE_HEADER_SIZE = 16;
/** FNV-1a 32-bit, the same constants the .pak container uses. */
export const FNV1A_OFFSET_BASIS = 0x811c9dc5;
export const FNV1A_PRIME = 0x01000193;
/** Event flags addressable by scripts. */
export const FLAG_COUNT = 512;

// ---------------------------------------------------------------------------
// Battle tuning constants (the ruleset the core defaults to)
// ---------------------------------------------------------------------------

/** Damage randomization range: d = d * rand(217..255) / 255. */
export const RAND_MIN = 217;
export const RAND_MAX = 255;
/** Stat-stage multipliers x100, indexed stage + 6 (so index 6 = stage 0). */
export const STAGE_MULT = [25, 28, 33, 40, 50, 66, 100, 150, 200, 250, 300, 350, 400];
/** Stats clamp to this after a stage multiplication. */
export const STAT_MAX = 999;
/** Damage before the random factor clamps here, then +2. */
export const DAMAGE_CLAMP = 997;
/** Both stats are quartered when either exceeds this (the byte-overflow rule). */
export const STAT_SCALE_LIMIT = 255;
/** STAB numerator/denominator (x1.5). */
export const STAB_NUM = 3;
export const STAB_DEN = 2;
/** Type multipliers are x10 fixed point. */
export const TYPE_SCALE = 10;

/** Ball modifiers for the catch algorithm, indexed by item ball tier. */
export const BALL_RATE = [255, 200, 150, 100];
/** Status bonus to the catch roll. */
export const CATCH_STATUS_BONUS = { none: 0, sleepFreeze: 25, other: 12 } as const;
