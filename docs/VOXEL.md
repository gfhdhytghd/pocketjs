# Pocket Voxel

A specialized PocketJS runtime that presents a Game Boy creature-RPG as a
voxelized 3D diorama on PSP-class hardware. The gameplay is a TypeScript port
of the [gen1recomp](https://github.com/bryanthaboi/gen1recomp) Lua engine; the
presentation is a Rust reimplementation of the
[DramaticShape Voxel Mod](https://github.com/DramaticShape/DramaticShapeVoxelMod)
diorama renderer. Both upstreams are MIT-licensed; both serve here as
executable specifications, not vendored code.

The runtime instance is `⟨ pocketvoxel-core, the voxel surface, the voxelmon
guest ⟩` in the RUNTIMES.md sense. What is new relative to every prior
instance: **the game state lives in the guest**, and the core owns only the
presentation domain. Pocket Mon put world+battle in Rust and authored content
in TS; Pocket Voxel puts world+battle in TypeScript and gives Rust the scene.
That is the same relationship the `ui` surface has with its guest — a retained
scene core-side, intent ops guest-side — applied to a 3D diorama.

## 1. The content boundary

This runtime takes the **opposite legal stance from Pocket Mon**, and the two
must never blur:

- `engine/pocketmon` (branch `feat/pocketmon-runtime`) is clean-room: no ROM
  path exists, and a test enforces it. Its content is original.
- `engine/pocketvoxel` is **ROM-fed, exactly like upstream gen1recomp**: the
  only game-content input is a canonical US Gen-1 ROM the player already owns.
  The importer verifies SHA-1 (`ea9bcae617fdf159b045185467ae58b2e4a48b9a` for
  Red) before decoding one byte. Everything decoded lands under `dist/` and is
  **git-ignored — no ROM-derived byte is ever committed**: no cooked pak, no
  extracted art, no decoded text, and no golden PNG (goldens are frame hashes;
  PNG dumps stay local).

Reference checkouts are inputs the same way the ROM is. `tools/voxel.ts`
resolves them from `VOXELMON_G1R` (default `~/code/gen1recomp`) and
`VOXELMON_VOXELMOD` (default `~/code/DramaticShapeVoxelMod`):

- the gen1recomp checkout supplies `tools/rom_manifest.json` — the symbol
  table (3274 name→[bank,addr] entries), charmap, and per-map metadata the
  importer is driven by. The importer is **manifest-driven, not
  offset-hardcoded**; we consume that manifest verbatim rather than
  transcribing a megabyte of addresses.
- the VoxelMod checkout supplies `data/voxel_heights.lua` (tile class
  profiles, 55 building templates) and `data/battle_arenas.lua` (94 authored
  arena entries), converted at cook time.

Tests that need the ROM or a reference checkout skip when absent — the
`POCKET3D_TEST_MAPS` convention. CI never sees any of it.

## 2. Layout

```
engine/pocketvoxel/crates/
  pocketvoxel-core/   scene core: VXPK reader, chunk registry, entities,
                      camera rungs, battle staging, GB UI tile layer, draw
                      list. no_std + alloc, f32 (libm on PSP), zero deps.
  pocketvoxel-sim/    headless host: software rasterizer, PNG out, op-trace
                      replay, frame hashes. (desktop workspace member)
  pocketvoxel-gu/     sceGu backend. Consumes the draw list; never touches
                      list lifecycle (the pocket3d-gu contract). (standalone)
  pocketvoxel-psp/    the EBOOT: QuickJS realm + voxel surface + gu backend.
                      (standalone, hosts/psp toolchain pins)
apps/voxelmon/
  import/             ROM importer (TS): manifest-driven decode of tilesets,
                      maps, sprites, species, moves, text, encounters, pics.
  cook/               voxelizer + atlas packer + VXPK writer (TS).
  game/               the gameplay port (TS): world, script VM, text, menus,
                      battle. Runs in Bun headless and in QuickJS on device.
  tapes/              intent tapes (walk/press/wait — never frame counts).
contracts/spec/voxel-spec.ts     the surface, single source of truth
contracts/spec/gen-voxel-rust.ts → engine/pocketvoxel/.../spec.rs (drift-guarded)
tools/voxel.ts                   import | cook | sim | check | record | shots
                                 | psp | run | parity
docs/VOXEL.md                    this file
tests/voxel-*.test.ts            contract drift + importer parity + gameplay
tests/goldens/voxel/             frame HASHES only
```

## 3. The split

**Guest (TypeScript)** — the entire gen1recomp gameplay surface, ported
module-for-module with the Lua as executable spec: fixed 60 Hz step,
edge-per-step input, map loading and connections, grid movement and collision
(bottom-left-tile rule), ledges, warps, doors, NPC wander and scripted moves,
trainer sight, encounters, the script runner and its verbs, text pagination,
menus, party/bag/save, and the battle engine (damage, crit, accuracy, type
chart, status, catch, exp — each formula carrying a provenance citation to the
Lua it ports). The guest owns the RNG and the save. One guest turn per host
tick: `frame(buttons)`, exactly once.

**Core (Rust)** — presentation only, zero gameplay:

- loads the VXPK, owns chunk meshes zero-copy in place, culls per frame
  (frustum over chunk AABBs — the `pocket3d-gu` world path with chunks in
  place of PVS faces);
- retains the scene the guest drives through ops: camera, pitch rung, tint,
  up to 16 entity billboards, removable stamps, emotes, the battle stage, and
  a retained GB UI tile grid (20×18) with a reveal counter for typewriter
  text;
- builds one ordered draw list per frame. Draw order (from the mod, minus
  shader-bound passes): sky bands → terrain chunks → water (flat, animated
  atlas) → shadow decals → player ghost (inverted depth, no write) → entity
  cards → grass mesh → flower mesh → GB UI quads.

Per-frame boundary traffic is **~10–40 ops** (camera + moving entities +
a reveal counter); menu opens burst a few hundred `ui*` ops once. Against the
measured QuickJS wall (~1.7 µs/op, ~8k ops/frame at 333 MHz) that is noise.

## 4. The voxel surface

Pinned in `contracts/spec/voxel-spec.ts`, codegen'd to Rust, byte-compare
drift guard — the `mon-spec.ts` discipline unchanged. Op groups:

- **world** — `mapShow(slot, mapId, ox, oy)` / `mapHide(slot)` (slot 0 =
  current, 1..4 = connected neighbours at their seam offsets), `cam(x, y)`,
  `pitch(rung)`, `tint(abgr)`, `stamp(mapId, cx, cy, on)` (cut tree, moved
  boulder — pre-cooked removable sub-meshes toggled at runtime).
- **entities** — `ent(slot, sheet, frame, x, y, lift, flags)`, `entHide`,
  `emote(slot, kind)`. Billboards lean back by camera pitch and pull toward
  the eye along each vertex's own ray — the mod's projection-invariant depth
  bias, ported exactly.
- **ui** — `uiTile(x, y, tile)`, `uiFill(x, y, w, h, tile)`,
  `uiText(x, y, str)` (glyphs resolved core-side through the cooked charmap),
  `uiReveal(n)`, `uiClear()`. The GB UI is a retained tile layer composited
  over the diorama, scaled to fit 480×272.
- **battle** — `arena(mapId, x, y, shape, rig)`, `card(side, pic, x, y)`,
  `cardHide(side)`, `battleCam(orbit, pitch, zoom)`, `arenaEnd()`. The two
  solved camera rigs (tele / wide) and the spread correction come from the
  mod's constants. Battles stage on the map; **nothing moves the player** —
  the camera goes to the arena, exactly as upstream.
- **system** — `gamedata()` (returns the pak's GAME section to the guest at
  boot: one cold JSON parse, then the guest never crosses for data again),
  `stats()` (frame counters), `reset()`.

Events are the standard packed batch wire (`u16 kind | u16 a | i32 b | i32 c
| i32 d`) with **no kinds defined yet** — the core currently states no fact
the guest does not already know. The channel exists so mesh-streaming or
host-side timing facts can append later without a wire change.

## 5. The asset pipeline

`bun tools/voxel.ts import` — TS port of the gen1recomp extractor, driven by
the same `rom_manifest.json`: SHA-1 gate, bank arithmetic, 2bpp/1bpp tile
decode, the Gen-1 pic RLE+delta decompressor, text-command VM, the lot.
Output: `dist/voxelmon/gen/*.json` + raw indexed bitmaps. **Parity is
testable**: the reference checkout's `tools/build_rom_data.py` produces the
same datasets independently, and `tools/voxel.ts parity` deep-compares.

`bun tools/voxel.ts cook` — the VoxelMod's analysis, run once on the Mac
instead of every session on the handheld:

1. classify every tile position (profile pins → cell rules → wall fallback;
   the class/height table ported verbatim);
2. measure volumes (repeat-aware column heights, region consensus, roof
   split), match building templates, place pinned props;
3. mesh per **16×16-tile chunk** into GE-ready buffers: 20-byte vertices
   (`u,v f32 | color u32 | x,y,z i16 + pad`), u16 indices, face shade ×
   baked AO folded into vertex color, grass/flower/water split into their
   own meshes, side faces cut into 8 px bands with cropped (never stretched)
   art;
4. pack atlases as pre-swizzled CLUT8 — one terrain atlas copy per animation
   frame (water, flowers), so tile animation on device is a texture bind, not
   a texel write; day tint is a CLUT rewrite, the GB's own trick;
5. write `dist/voxelmon/voxelmon.vxpak` (MONPAK-style container: magic,
   section table, 16-byte alignment, validated zero-copy reader in the core)
   including the GAME section the guest reads at boot.

## 6. What renders on PSP, and what deliberately does not

Kept from the mod, verbatim where possible: the class/height tables, volume
measurement, gables and hips, band-cropped side art, `FACE_SHADE` and the AO
constants, billboard lean + camera-ward pull, the ghost silhouette (inverted
depth test), the arena shapes + three-line clearance walk + authored arena
table, both battle rigs, the horizon-at-infinity derivation, the orbit
projection (framing-identical to the flat view at every zoom).

Substituted or dropped, per the mod's own fallbacks: shadow **decals** instead
of the shadow map; **flat animated water** instead of screen-space
reflections; hardware alpha test (`sceGuAlphaFunc`) for sprite cutouts; no
world curve, no wireframe, no supersampling, no glass glints, no tilt-shift
in v1. First/third-person free-roam and the detected-object segmentation pass
(flood-fill standee discovery) are later rungs; v1 ships the orbit pitch
ladder (0/15/35/50/75) and pinned props only.

GE discipline inherited from pocket3d-gu, const-asserted: 20-byte world
vertex, i16 positions countered by a ×32768 model scale, inverted 16-bit
depth (`GreaterOrEqual`, clear 0), GL-style −1..1 projection, dcache
writeback after every CPU write the GE reads, pool reset only after
`sceGuSync`, 333 MHz set explicitly at boot.

## 7. Determinism and verification

The frame is a pure function of (tick index, buttons). The tick clock is the
only clock; tile animation and menu cursors derive from it.

1. **Importer parity** — TS output deep-compared against the Python reference
   extractor's output for the same ROM (`tools/voxel.ts parity`).
2. **Gameplay tests** — bun tests port the reference suite semantics
   (`tests/engine/formulas.lua`, timing budgets, collision/ledge/warp parity
   cases) against the ROM-decoded dataset, plus the fixture dataset for
   ROM-free CI.
3. **Oracle runs** — the Lua reference executes headless under LuaJIT
   (verified: 110/110 engine suites, 832/837 content checks on this ROM;
   the 5 failures are one audio-dependent suite the Python extractor does not
   feed). Targeted modules are driven with identical inputs and compared
   trace-for-trace.
4. **One tape, every host** — intent tapes drive the Bun headless sim, which
   records the per-frame op stream + input. `pocketvoxel-sim` replays that op
   stream through the real core + software rasterizer into frame hashes
   (committed) and PNGs (local only). The capture EBOOT replays the same
   recorded input under PPSSPP and must agree with the rasterizer — the
   Pocket Mon `--emit-psp` pattern.

## 8. Budgets

16.7 ms/frame at 60 Hz. Guest JS ≤ 2 ms typical (measured OpenStrike idle is
1.4 ms with a far chattier HUD); chunk splice + draw well under the GE's
measured sub-30 µs world cost at OpenStrike scale; a route-scale map cooks to
~1.5–2.5 MB of vertex data (indexed, 20 B/vertex — the mod's 10–20 MB is
unindexed f32 at window resolution and not comparable). Per-map + neighbours
stream from the pak into one reused aligned buffer, the OpenStrike map-swap
pattern. VRAM: 512×272 double-buffered 8888 + 16-bit Z ≈ 1.39 MB; textures
sample swizzled from main RAM.

## 9. Scope ladder

v1 (this tree, delivered): Red only. Import (16 datasets at field-level
parity with the reference extractor) + cook (42/42 non-desk building
templates, carved tree hulls, 8 baked tile-animation frames) + the overworld
slice — walk, collide, ledges, grass, warps, doors, signs, NPCs, an 8-verb
script runner, the textbox typewriter — and the wild-battle core (damage /
accuracy / crit / status / catch / run / exp through the oracle-verified
rules; the early-route effect set; unknown effects degrade via the
reference's own fallbacks) staged in the voxel arena with the classic GB
battle screen composited over it. One tape drives Bun, the Rust rasterizer
(committed hash goldens: 11 story + 4 battle marks) and the PSP capture
EBOOT.

Later rungs, in dependency order: pak slimming for the PSP-1000's 24 MB
(stamp instancing over the tree-wall boxes; per-map streaming); the arena
clearance walk (needs cook-time heights in gamedata) and the authored arena
table; the full script verb set and story flags; trainer battles + AI
layers; the desk-set templates, stairs, and detected props; battle move
animations; the box system, marts, and the start menu; audio through the
`audio` module (the chip synth is a channel-program interpreter — the
importer already reserves the program banks); Blue/Yellow manifests;
first/third person; link play never.

Stadium battle models are **permanently out of scope** — they require an N64
ROM this pipeline does not accept.
