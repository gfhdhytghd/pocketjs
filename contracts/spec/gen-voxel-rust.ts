// Deterministic codegen: contracts/spec/voxel-spec.ts ->
// engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs
//
// Run from PocketJS/:  bun contracts/spec/gen-voxel-rust.ts
//
// tests/voxel-contract.test.ts imports generateVoxelRust() and byte-compares
// its output against the committed spec.rs, so the generated file can never
// drift from voxel-spec.ts. Keep this generator free of anything
// non-deterministic (no dates, no env, insertion order only).

import {
  AO,
  ARENA_GAP_CELLS,
  ARENA_SHAPE,
  ATLAS_KIND,
  BLOCK_PX,
  BLOCK_TILES,
  CAM_FOCAL,
  CELL_PX,
  CHUNK_PX,
  CHUNK_TILES,
  CLASS_HEIGHT,
  CLEAR_EPS,
  CLEAR_LINES_Y,
  CLEAR_OFFMAP_H,
  CLEAR_STEP_PX,
  DIR,
  EMOTE,
  ENTS_MAX,
  ENT_FLAG,
  EVENT_CAP,
  EVENT_SIZE,
  FACE_SHADE,
  FLOWER_PULL_SUB_PX,
  GABLE_TOP_SHADE,
  GB_H,
  GB_W,
  GHOST_ABGR,
  GRASS_THICK_PX,
  MAX_VERTS_PER_CHUNK_MESH,
  MESH_KIND,
  MESH_KINDS,
  PITCH_RUNGS,
  PITCH_TWEEN_TICKS,
  PULL_BASE,
  PULL_MIN_SIN,
  PULL_NUM,
  PULL_SUB,
  Q4,
  Q8,
  RIG,
  RIG_DOLLY,
  RIG_DOLLY_TICKS,
  RIG_PAN_TICKS,
  RIG_PAN_YAW_DEG,
  RIG_PITCH_MAX_DEG,
  RIG_ZOOM_MAX,
  RIG_ZOOM_MIN,
  SHADOW_ALPHA_BATTLE,
  SHADOW_ALPHA_FIELD,
  TICK_HZ,
  TILE_PX,
  UI_COLS,
  UI_ROWS,
  VERTEX_STRIDE,
  VIEW_H,
  VIEW_W,
  WORLD_VIEW_H,
  WORLD_VIEW_W,
  VOLUME_MAX_ROWS,
  VOLUME_TOP_SHADE,
  VOX_BTN,
  VOX_OP,
  VXPK_ALIGN,
  VXPK_AUDIO_HEADER_SIZE,
  VXPK_ENTRY_SIZE,
  VXPK_HEADER_SIZE,
  VXPK_MAGIC,
  VXPK_TAG,
  VXPK_VERSION,
  WATER_DROP_PX,
} from "./voxel-spec.ts";

function hex(n: number, pad = 8): string {
  return "0x" + (n >>> 0).toString(16).padStart(pad, "0");
}

/** Rust f32 literal — always carries a decimal point. */
function f32(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
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
    const lit = ty === "f32" ? f32(v) : `${v}`;
    put(`    pub const ${screaming(k)}: ${ty} = ${lit};`);
  }
  put("}");
  put("");
}

export function generateVoxelRust(): string {
  const L: string[] = [];
  const put = (s = "") => L.push(s);

  put(
    "//! GENERATED — do not edit; run `bun contracts/spec/gen-voxel-rust.ts` (from PocketJS/).",
  );
  put("//!");
  put(
    "//! Source of truth: contracts/spec/voxel-spec.ts — every constant here mirrors it.",
  );
  put(
    "//! tests/voxel-contract.test.ts regenerates this file in-memory and byte-compares;",
  );
  put(
    "//! if that fails, run `bun contracts/spec/gen-voxel-rust.ts` and commit the result.",
  );
  put("//!");
  put("//! See docs/VOXEL.md for the architecture this contract serves.");
  put("");
  put("#![allow(dead_code)]");
  put("#![allow(clippy::all)]");
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Geometry");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Graphics unit: an 8x8 pixel tile — also one voxel footprint.");
  put(`pub const TILE_PX: i32 = ${TILE_PX};`);
  put("/// Walk-grid unit: a 16x16 pixel cell = 2x2 tiles.");
  put(`pub const CELL_PX: i32 = ${CELL_PX};`);
  put("/// Layout unit: a 32x32 pixel block = 2x2 cells = 4x4 tiles.");
  put(`pub const BLOCK_PX: i32 = ${BLOCK_PX};`);
  put(`pub const BLOCK_TILES: usize = ${BLOCK_TILES};`);
  put("/// Chunk edge in tiles — the mesh/cull/stream granularity.");
  put(`pub const CHUNK_TILES: i32 = ${CHUNK_TILES};`);
  put(`pub const CHUNK_PX: i32 = ${CHUNK_PX};`);
  put("/// The GB UI layer, in GB pixels and tiles.");
  put(`pub const GB_W: i32 = ${GB_W};`);
  put(`pub const GB_H: i32 = ${GB_H};`);
  put(`pub const UI_COLS: usize = ${UI_COLS};`);
  put(`pub const UI_ROWS: usize = ${UI_ROWS};`);
  put("/// The PSP framebuffer the diorama renders at.");
  put(`pub const VIEW_W: i32 = ${VIEW_W};`);
  put(`pub const VIEW_H: i32 = ${VIEW_H};`);
  put("/// The world view in world px, rendered 2x; camera dist = WORLD_VIEW_H.");
  put(`pub const WORLD_VIEW_W: i32 = ${WORLD_VIEW_W};`);
  put(`pub const WORLD_VIEW_H: i32 = ${WORLD_VIEW_H};`);
  put("/// Fixed simulation step; the tick index is the only clock.");
  put(`pub const TICK_HZ: u32 = ${TICK_HZ};`);
  put("");
  constMod(put, "btn", "u32", VOX_BTN, [
    "The abstract button set; hosts map their physical buttons onto it, so",
    "one input tape replays on every host.",
  ]);
  constMod(put, "dir", "u8", DIR, [
    "Facing / movement direction. Matches the walk-sheet frame order.",
  ]);

  put("// ---------------------------------------------------------------------------");
  put("// Camera — the pitch ladder");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Orbit pitch rungs in degrees from straight down; rung 0 frames");
  put("/// identically to the flat 2D game.");
  put(
    `pub const PITCH_RUNGS: [f32; ${PITCH_RUNGS.length}] = [${PITCH_RUNGS.map(f32).join(", ")}];`,
  );
  put("/// Camera tween between rungs, in ticks (smoothstep).");
  put(`pub const PITCH_TWEEN_TICKS: u32 = ${PITCH_TWEEN_TICKS};`);
  put(
    "/// fov = 2*atan(1/(2*FOCAL)): a straight-down camera at dist = vh frames vh px.",
  );
  put(`pub const CAM_FOCAL: f32 = ${f32(CAM_FOCAL)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Diorama constants — baked at cook time, pinned so cooker and core agree");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "face_shade", "f32", FACE_SHADE, [
    "Per-face shade multipliers, sun in the southeast.",
  ]);
  put(`pub const VOLUME_TOP_SHADE: f32 = ${f32(VOLUME_TOP_SHADE)};`);
  put(`pub const GABLE_TOP_SHADE: f32 = ${f32(GABLE_TOP_SHADE)};`);
  put("");
  constMod(put, "ao", "f32", AO as unknown as Record<string, number>, [
    "Baked ambient-occlusion terms (upstream AO_* with AO_STRENGTH folded).",
  ]);
  put("/// Water surface sits below ground; the 2 px lip is the shoreline.");
  put(`pub const WATER_DROP_PX: i32 = ${WATER_DROP_PX};`);
  put(`pub const GRASS_THICK_PX: i32 = ${GRASS_THICK_PX};`);
  put("");
  constMod(put, "class_height", "i32", CLASS_HEIGHT, [
    "Tile-class fallback heights in world px; profile pins override per",
    "tileset at cook time.",
  ]);
  put("/// Volume measurement cap, in 8 px rows (48 px max).");
  put(`pub const VOLUME_MAX_ROWS: i32 = ${VOLUME_MAX_ROWS};`);
  put("");
  put("/// Billboard camera-ward pull, world px: PULL_BASE +");
  put("/// max(0, PULL_NUM*cos(a) - PULL_SUB) / max(sin(a), PULL_MIN_SIN),");
  put("/// applied along each vertex's own eye ray — a pure depth bias.");
  put(`pub const PULL_BASE: f32 = ${f32(PULL_BASE)};`);
  put(`pub const PULL_NUM: f32 = ${f32(PULL_NUM)};`);
  put(`pub const PULL_SUB: f32 = ${f32(PULL_SUB)};`);
  put(`pub const PULL_MIN_SIN: f32 = ${f32(PULL_MIN_SIN)};`);
  put("/// Flowers give up one tile row of depth advantage vs the cards.");
  put(`pub const FLOWER_PULL_SUB_PX: f32 = ${f32(FLOWER_PULL_SUB_PX)};`);
  put("");
  put("/// Ghost silhouette color (drawn with inverted depth test, no write).");
  put(`pub const GHOST_ABGR: u32 = ${hex(GHOST_ABGR)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Battle staging — solved rig constants");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "arena_shape", "u8", ARENA_SHAPE, [
    "Arena footprints; mons stand ARENA_GAP_CELLS apart.",
  ]);
  put(`pub const ARENA_GAP_CELLS: i32 = ${ARENA_GAP_CELLS};`);
  put(`pub const CLEAR_STEP_PX: f32 = ${f32(CLEAR_STEP_PX)};`);
  put(
    `pub const CLEAR_LINES_Y: [f32; ${CLEAR_LINES_Y.length}] = [${CLEAR_LINES_Y.map(f32).join(", ")}];`,
  );
  put(`pub const CLEAR_EPS: f32 = ${f32(CLEAR_EPS)};`);
  put(`pub const CLEAR_OFFMAP_H: f32 = ${f32(CLEAR_OFFMAP_H)};`);
  put("");
  constMod(
    put,
    "rig_tele",
    "f32",
    RIG.tele as unknown as Record<string, number>,
    ["The solved long-lens rig (offsets in world px from the arena midpoint)."],
  );
  constMod(
    put,
    "rig_wide",
    "f32",
    RIG.wide as unknown as Record<string, number>,
    ["The solved wide rig, for rooms the long lens cannot stand back from."],
  );
  put(`pub const RIG_PAN_YAW_DEG: f32 = ${f32(RIG_PAN_YAW_DEG)};`);
  put(`pub const RIG_PAN_TICKS: u32 = ${RIG_PAN_TICKS};`);
  put(`pub const RIG_DOLLY: f32 = ${f32(RIG_DOLLY)};`);
  put(`pub const RIG_DOLLY_TICKS: u32 = ${RIG_DOLLY_TICKS};`);
  put(`pub const RIG_PITCH_MAX_DEG: f32 = ${f32(RIG_PITCH_MAX_DEG)};`);
  put(`pub const RIG_ZOOM_MIN: f32 = ${f32(RIG_ZOOM_MIN)};`);
  put(`pub const RIG_ZOOM_MAX: f32 = ${f32(RIG_ZOOM_MAX)};`);
  put(`pub const SHADOW_ALPHA_FIELD: f32 = ${f32(SHADOW_ALPHA_FIELD)};`);
  put(`pub const SHADOW_ALPHA_BATTLE: f32 = ${f32(SHADOW_ALPHA_BATTLE)};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Entities");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Max simultaneously shown entity billboards (player is slot 0).");
  put(`pub const ENTS_MAX: usize = ${ENTS_MAX};`);
  put("");
  constMod(put, "ent_flag", "u32", ENT_FLAG, ["Entity billboard flags."]);
  constMod(put, "emote", "u8", EMOTE, ["Emote bubble kinds."]);

  put("// ---------------------------------------------------------------------------");
  put("// Ops — guest -> core intent. APPEND ONLY. 0 is reserved.");
  put("// ---------------------------------------------------------------------------");
  put("");
  constMod(put, "op", "u32", VOX_OP, [
    "Op codes. See contracts/spec/voxel-spec.ts for the argument contract.",
  ]);
  put("/// Fixed-point scales used by op args.");
  put(`pub const Q4: i32 = ${Q4};`);
  put(`pub const Q8: i32 = ${Q8};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// Events — core -> guest facts. No kinds defined yet; wire pinned.");
  put("// ---------------------------------------------------------------------------");
  put("");
  put("/// Bytes per packed event record: u16 kind | u16 a | i32 b | i32 c | i32 d.");
  put(`pub const EVENT_SIZE: usize = ${EVENT_SIZE};`);
  put(`pub const EVENT_CAP: usize = ${EVENT_CAP};`);
  put("");

  put("// ---------------------------------------------------------------------------");
  put("// VXPK — the cooked content container");
  put("// ---------------------------------------------------------------------------");
  put("");
  put(`pub const VXPK_MAGIC: u32 = ${hex(VXPK_MAGIC)}; // 'VXPK'`);
  put(`pub const VXPK_VERSION: u16 = ${VXPK_VERSION};`);
  put(`pub const VXPK_HEADER_SIZE: usize = ${VXPK_HEADER_SIZE};`);
  put(`pub const VXPK_ENTRY_SIZE: usize = ${VXPK_ENTRY_SIZE};`);
  put(`pub const VXPK_ALIGN: usize = ${VXPK_ALIGN};`);
  put("/// The AUDI payload's own header (json_len, program_len, two pad words).");
  put(`pub const VXPK_AUDIO_HEADER_SIZE: usize = ${VXPK_AUDIO_HEADER_SIZE};`);
  put("");
  constMod(put, "tag", "u32", VXPK_TAG, ["Section tags (4CC, LE u32)."]);
  constMod(put, "atlas_kind", "u16", ATLAS_KIND, ["Atlas page kinds."]);
  put("/// The GE world vertex: f32 u | f32 v | u32 abgr | i16 x,y,z | i16 pad.");
  put(`pub const VERTEX_STRIDE: usize = ${VERTEX_STRIDE};`);
  put("/// A batch seals before u16 index overflow.");
  put(`pub const MAX_VERTS_PER_CHUNK_MESH: usize = ${MAX_VERTS_PER_CHUNK_MESH};`);
  put("");
  constMod(put, "mesh_kind", "u16", MESH_KIND, [
    "Mesh kinds inside a chunk — draw order is their numeric order.",
  ]);
  put(`pub const MESH_KINDS: usize = ${MESH_KINDS};`);
  put("");

  return L.join("\n");
}

if (import.meta.main) {
  const out = new URL(
    "../../engine/pocketvoxel/crates/pocketvoxel-core/src/spec.rs",
    import.meta.url,
  );
  await Bun.write(out, generateVoxelRust() + "\n");
  console.log(`wrote ${out.pathname}`);
}
