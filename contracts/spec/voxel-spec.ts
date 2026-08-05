// Pocket Voxel spec — THE single source of truth for the `voxel` surface.
//
// Same contract discipline as contracts/spec/spec.ts and mon-spec.ts:
// everything the Rust core (engine/pocketvoxel/crates/pocketvoxel-core/), the
// cooker (apps/voxelmon/cook/), the guest (apps/voxelmon/game/) and the PSP
// EBOOT agree on is pinned HERE, in plain data.
// `contracts/spec/gen-voxel-rust.ts` deterministically generates
// `engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs` from this file;
// `tests/voxel-contract.test.ts` regenerates it in-memory and byte-compares
// against the committed file, so TS and Rust can never drift.
//
// Conventions (inherited, non-negotiable):
//   - Little-endian everywhere.
//   - Colors are u32 ABGR (0xAABBGGRR) — the PSP GE COLOR_8888 layout.
//   - Op codes are append-only: never renumber, never reuse. 0 is reserved.
//
// See docs/VOXEL.md for the architecture this contract serves, including the
// content boundary (ROM-fed like upstream gen1recomp; nothing ROM-derived is
// ever committed).

// ---------------------------------------------------------------------------
// Geometry — coordinate units (upstream contract: docs/VOXEL.md §5)
// ---------------------------------------------------------------------------

/** Graphics unit: an 8x8 pixel tile — also one voxel footprint. */
export const TILE_PX = 8;
/** Walk-grid unit: a 16x16 pixel cell = 2x2 tiles. Every actor/warp coord. */
export const CELL_PX = 16;
/** Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles. */
export const BLOCK_PX = 32;
/** Tiles per block edge. */
export const BLOCK_TILES = 4;
/** Chunk edge in tiles — the mesh/cull/stream granularity. */
export const CHUNK_TILES = 16;
/** Chunk edge in world pixels (128). */
export const CHUNK_PX = CHUNK_TILES * TILE_PX;

/**
 * World space is world pixels, matching the upstream mod: +X east, +Y up,
 * +Z south, right-handed; a resting character faces +Z (south). Tile (tx,ty)
 * occupies x in [tx*8, tx*8+8), z in [ty*8, ty*8+8). Height is world px.
 */
export const WORLD_AXES = "y-up +z-south right-handed" as const;

/** The GB UI layer, in GB pixels and tiles. Composited over the diorama. */
export const GB_W = 160;
export const GB_H = 144;
export const UI_COLS = 20;
export const UI_ROWS = 18;

/** The PSP framebuffer the diorama renders at. */
export const VIEW_W = 480;
export const VIEW_H = 272;

/**
 * The world view in world pixels: the diorama frames 240x136 and renders 2x
 * into 480x272 (the Pocket Mon viewport choice — no integer scale fits
 * 160x144 on 480x272, so the view widens instead of blurring). Camera
 * distance = WORLD_VIEW_H, so rung 0 frames exactly these world pixels.
 */
export const WORLD_VIEW_W = 240;
export const WORLD_VIEW_H = 136;

/** Fixed simulation step: 60 Hz. The tick index is the only clock. */
export const TICK_HZ = 60;

// ---------------------------------------------------------------------------
// Input — one abstract button set for every host and every tape
// ---------------------------------------------------------------------------

export const VOX_BTN = {
  up: 1 << 0,
  down: 1 << 1,
  left: 1 << 2,
  right: 1 << 3,
  a: 1 << 4,
  b: 1 << 5,
  start: 1 << 6,
  select: 1 << 7,
} as const;

/** Facing / movement direction. Matches the walk-sheet frame order. */
export const DIR = {
  down: 0,
  up: 1,
  left: 2,
  right: 3,
} as const;

// ---------------------------------------------------------------------------
// Camera — the pitch ladder (upstream VoxelState, minus the FULL preset)
// ---------------------------------------------------------------------------

/**
 * Orbit pitch rungs in degrees measured from straight down: rung 0 frames
 * identically to the flat 2D game. The projection derives fov so a
 * straight-down camera at dist = vh frames exactly vh world pixels
 * (fov = 2*atan(1/(2*FOCAL)), FOCAL = 1).
 */
export const PITCH_RUNGS = [0, 15, 35, 50, 75] as const;
/** Camera tween between rungs, in ticks (0.25 s at 60 Hz), smoothstep. */
export const PITCH_TWEEN_TICKS = 15;
export const CAM_FOCAL = 1;

// ---------------------------------------------------------------------------
// Diorama constants — baked at cook time, pinned here so cooker and any
// future on-device mesher can never disagree (upstream Voxel3D/ChunkMesher)
// ---------------------------------------------------------------------------

/** Per-face shade multipliers, sun in the southeast. Index = face id. */
export const FACE_SHADE = {
  east: 0.84, // +X
  west: 0.72, // -X
  up: 1.0, // +Y
  down: 0.55, // -Y
  south: 0.9, // +Z (the drawing itself, full brightness on volume runs)
  north: 0.68, // -Z
} as const;
export const VOLUME_TOP_SHADE = 0.85;
export const GABLE_TOP_SHADE = 0.95;

/** Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded). */
export const AO = {
  step: 0.216, // per crowding neighbour on a top corner, max 3
  edge: 0.664, // crease multiplier on a side face
  corner: 0.441, // inside-corner multiplier (edge^2, floored)
  ground: 0.288, // prop ground-contact term
  risePx: 6, // px over which the ground term releases
  floor: 0.25, // shade never drops below this
} as const;

/** Water surface sits below ground; the -2 px lip is the shoreline. */
export const WATER_DROP_PX = 2;
/** Grass tuft slabs: thickness and per-cell placement (two rows per cell). */
export const GRASS_THICK_PX = 2;

/**
 * Tile-class fallback heights in world px (upstream voxel_heights defaults).
 * Profile pins from the reference checkout override per tileset at cook time.
 */
export const CLASS_HEIGHT = {
  ground: 0,
  water: -2,
  void: 0,
  ledge: 6,
  fence: 10,
  sign: 12,
  wall: 16,
  cliff: 32,
  tree: 16,
  roof: 28,
  counter: 8,
  table: 12,
  desk: 24,
  prop: 16,
  cylinder: 16,
  canopy: 32,
  stump: 16,
  grass: 0,
  flower: 0,
} as const;

/** Volume measurement caps (upstream Structures MAX_ROWS). */
export const VOLUME_MAX_ROWS = 6;

/**
 * Billboard camera-ward pull, world px: pull(a) = PULL_BASE +
 * max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN).
 * Applied along each vertex's own eye ray — a pure depth bias.
 */
export const PULL_BASE = 6;
export const PULL_NUM = 16;
export const PULL_SUB = 8;
export const PULL_MIN_SIN = 0.2;
/** Flowers give up one tile row of depth advantage vs the cards. */
export const FLOWER_PULL_SUB_PX = 8;

/** Ghost silhouette: flat color + alpha, drawn with inverted depth test. */
export const GHOST_ABGR = 0x80484242;

// ---------------------------------------------------------------------------
// Battle staging (upstream BattleArena/BattleCam, solved constants)
// ---------------------------------------------------------------------------

/** Arena footprints in cells; mons stand 3 cells = 48 px apart. */
export const ARENA_SHAPE = {
  /** 3x6 cells, enemy at (1,1), player at (1,4), 1-cell apron. */
  wide: 0,
  /** 1x4 cells, enemy at (0,0), player at (0,3). */
  narrow: 1,
} as const;
export const ARENA_GAP_CELLS = 3;
/** Clearance walk: sample step and the three sight lines per mon (px). */
export const CLEAR_STEP_PX = 4;
export const CLEAR_LINES_Y = [1, 8, 16] as const;
export const CLEAR_EPS = 1.5;
/** Off-map ground height during clearance — the border ring is trees. */
export const CLEAR_OFFMAP_H = 32;

/** The two solved over-the-shoulder rigs (offsets in world px). */
export const RIG = {
  tele: {
    side: 78.79,
    back: 144.96,
    height: 37.88,
    lookX: -0.26,
    lookY: 0.34,
    frameH: 34.11,
  },
  wide: {
    side: 41.98,
    back: 41.16,
    height: 28.48,
    lookX: -3.24,
    lookY: -1.35,
    frameH: 55.62,
  },
} as const;
/** Idle drift: yaw ±2° over 26 s, dolly ±2% over 37 s (in ticks). */
export const RIG_PAN_YAW_DEG = 2;
export const RIG_PAN_TICKS = 1560;
export const RIG_DOLLY = 0.02;
export const RIG_DOLLY_TICKS = 2220;
/** Player steering clamps. */
export const RIG_PITCH_MAX_DEG = 45;
export const RIG_ZOOM_MIN = 0.45;
export const RIG_ZOOM_MAX = 2.0;
/** Battle shadow decals darken harder than free-roam (cards need grounding). */
export const SHADOW_ALPHA_FIELD = 0.4;
export const SHADOW_ALPHA_BATTLE = 0.68;

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Max simultaneously shown entity billboards (player is slot 0). */
export const ENTS_MAX = 16;

export const ENT_FLAG = {
  /** Mirror the card on X (right-facing / alternating walk step). */
  mirror: 1 << 0,
  /** Draw the ghost silhouette pass for this entity (the player). */
  ghost: 1 << 1,
  /** Card is a 16x16 grass-occluded walker (draw before grass mesh). */
  walker: 1 << 2,
} as const;

/** Emote bubble kinds (upstream field.emotionBubbles order for Red). */
export const EMOTE = {
  none: 0,
  shock: 1,
  question: 2,
  happy: 3,
} as const;

// ---------------------------------------------------------------------------
// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.
// ---------------------------------------------------------------------------
//
// All args are i32 unless noted. String args exist only where marked (the
// QuickJS host passes them as interned C strings; ops stay synchronous).
//
//   system
//     gamedata() -> ArrayBuffer            the pak GAME section (boot, cold)
//     stats() -> ArrayBuffer               frame counters (debug)
//     reset()                              drop scene state to boot
//   world
//     mapShow(slot, mapId, ox, oy)         slot 0 current, 1..4 neighbours;
//                                          ox/oy = seam offset in world px
//     mapHide(slot)
//     cam(x, y)                            view centre, world px (Q4 fixed:
//                                          value = px*16, so scroll is smooth)
//     pitch(rung)                          PITCH_RUNGS index; tweens
//     tint(abgr)                           global day tint (CLUT rewrite)
//     stamp(mapId, cx, cy, on)             toggle a removable stamp
//     palette(index)                       selects the SGB palette for the
//                                          terrain/sprites/pics CLUTs: index
//                                          into the pak's SGB set (sampled
//                                          from VPAL[4 + index]); -1 restores
//                                          the GB grayscale ramp; ui always
//                                          keeps the raw ramp
//   entities
//     ent(slot, sheet, frame, x, y, lift, flags)   x/y world px Q4; lift px
//     entHide(slot)
//     emote(slot, kind)                    EMOTE; kind 0 clears
//   ui (the GB tile layer; tile ids index the cooked UI atlas)
//     uiTile(x, y, tile)
//     uiFill(x, y, w, h, tile)
//     uiText(x, y, str)                    STRING arg; charmap-resolved.
//                                          THE one live typewriter run: the
//                                          core retains only the last, gated
//                                          by uiReveal — static labels go
//                                          into the grid via uiTile instead
//     uiReveal(n)                          glyphs of the last uiText shown
//     uiClear()
//   battle
//     arena(mapId, x, y, shape, rig)       stage at cell (x,y); ARENA_SHAPE,
//                                          rig = 0 tele, 1 wide
//     card(side, pic, x, y)                side 0 player, 1 enemy; pic =
//                                          atlas page; cell coords
//     cardHide(side)
//     battleCam(orbit, pitch, zoom)        Q8 fixed 0..256 = 0..1 (zoom Q8 x)
//     arenaEnd()

export const VOX_OP = {
  gamedata: 1,
  stats: 2,
  reset: 3,

  mapShow: 10,
  mapHide: 11,
  cam: 12,
  pitch: 13,
  tint: 14,
  stamp: 15,
  palette: 16,

  ent: 30,
  entHide: 31,
  emote: 32,

  uiTile: 50,
  uiFill: 51,
  uiText: 52,
  uiReveal: 53,
  uiClear: 54,

  arena: 70,
  card: 71,
  cardHide: 72,
  battleCam: 73,
  arenaEnd: 74,
} as const;

/** Fixed-point scales used by op args. */
export const Q4 = 16;
export const Q8 = 256;

// ---------------------------------------------------------------------------
// Events — core -> guest facts, drained as one batch per tick. APPEND ONLY.
// ---------------------------------------------------------------------------
//
// Wire layout: a u32 count, then `count` records of EVENT_SIZE bytes:
//   u16 kind | u16 a | i32 b | i32 c | i32 d
// No kinds are defined yet: the core currently states no fact the guest does
// not already know. The channel is pinned so streaming/timing facts can
// append later without a wire change.

export const VOX_EVENT = {} as const;

export const EVENT_SIZE = 16;
export const EVENT_CAP = 64;

// ---------------------------------------------------------------------------
// VXPK — the cooked content container
// ---------------------------------------------------------------------------
//
// Layout (MONPAK discipline):
//   0   u32  MAGIC ('VXPK' LE)
//   4   u16  VERSION
//   6   u16  section count
//   8   u32  total byte length
//   12  u32  reserved (0)
//   16  section table: `count` entries of VXPK_ENTRY_SIZE bytes:
//              u32 tag | u32 offset | u32 length | u32 count
//   ..  section payloads, each aligned to VXPK_ALIGN
//
// Every offset is from the start of the blob. Sections appear in tag order.
// The core is the only untrusted-byte reader: it validates every range and
// never indexes unchecked.

export const VXPK_MAGIC = 0x4b505856; // 'VXPK'
export const VXPK_VERSION = 1;
export const VXPK_HEADER_SIZE = 16;
export const VXPK_ENTRY_SIZE = 16;
export const VXPK_ALIGN = 16;

/** Section tags (4CC, LE u32). */
export const VXPK_TAG = {
  /** u32 counts + view meta; see cook/pak.ts for the packed shape. */
  meta: 0x4154454d, // 'META'
  /**
   * CLUT palettes: u16 count, then count * 256 u32 ABGR entries. The list
   * is the 4 ATLAS_KIND default (GB grayscale) palettes followed by the SGB
   * set; the `palette` op selects an SGB entry that REPLACES the color ramp
   * for non-ui kinds (ui always samples its own default).
   */
  palette: 0x4c415056, // 'VPAL'
  /**
   * Atlas pages: u16 count, then per page a 16-byte header
   * (u16 w | u16 h | u16 kind | u16 frames | u32 offset | u32 len) with
   * pre-swizzled CLUT8 texels; animated pages store `frames` variants
   * back-to-back.
   */
  atlas: 0x534c5441, // 'ATLS'
  /**
   * Per-map chunk meshes: map directory, then per chunk a header
   * (i16 cx | i16 cy | AABB i16[6] | per-mesh-kind vert/index ranges) over
   * shared 20-byte-vertex and u16-index pools. Mesh kinds: terrain, water,
   * grass, flower.
   */
  chunks: 0x4b4e4843, // 'CHNK'
  /** Removable stamps: per map, per (cx,cy) a small vert/index range. */
  stamps: 0x504d5453, // 'STMP'
  /** GB charmap -> UI atlas tile, u16 pairs (for uiText). */
  charmap: 0x50414d43, // 'CMAP'
  /** The gameplay dataset the guest parses at boot (JSON bytes). */
  game: 0x454d4147, // 'GAME'
} as const;

/** Atlas page kinds. */
export const ATLAS_KIND = {
  terrain: 0,
  sprites: 1,
  ui: 2,
  pics: 3,
} as const;

/**
 * The GE world vertex, byte-identical to pocket3d's cooked format:
 *   f32 u | f32 v | u32 abgr | i16 x | i16 y | i16 z | i16 pad  = 20 bytes.
 * i16 positions are countered by a x32768 model scale on the GE.
 */
export const VERTEX_STRIDE = 20;
/** A batch seals before u16 index overflow. */
export const MAX_VERTS_PER_CHUNK_MESH = 65532;

// ---------------------------------------------------------------------------
// Mesh kinds inside a chunk — draw order is their numeric order
// ---------------------------------------------------------------------------

export const MESH_KIND = {
  terrain: 0,
  water: 1,
  grass: 2,
  flower: 3,
} as const;
export const MESH_KINDS = 4;
