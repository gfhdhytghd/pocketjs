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
- the same checkout supplies `data/palettes_gbc.lua` — the RED++ colour
  pack: 239 named SuperPalettes, 151 species→name entries, and the
  `world` table (per-tileset tile→palette-group vectors, per-group colours,
  the per-town roof pairs, 8 OBJ palettes and their ROM-picture-id
  assignment). It is **pokered-gbc-derived, not ROM-derived**: Pokémon Red
  ships no CGB code, so **there is no `CGBBasePalettes` for Red at all** —
  every colour in this file comes from the pokered-gbc source tree, and
  gen1recomp commits the generated table under its own MIT licence. It
  converts at cook time exactly like the VoxelMod tables, into git-ignored
  `dist/voxelmon/gen/palettes_gbc.json`.
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
                      list, chip synth. no_std + alloc, f32 (libm on PSP),
                      zero deps.
  pocketvoxel-sim/    headless host: software rasterizer, PNG out, op-trace
                      replay, frame hashes. (desktop workspace member)
  pocketvoxel-gu/     sceGu backend. Consumes the draw list; never touches
                      list lifecycle (the pocket3d-gu contract). (standalone)
  pocketvoxel-psp/    the EBOOT: QuickJS realm + voxel surface + gu backend.
                      (standalone, hosts/psp toolchain pins)
apps/voxelmon/
  import/             ROM importer (TS): manifest-driven decode of tilesets,
                      maps, sprites, species, moves, text, encounters, pics,
                      sound programs.
  cook/               voxelizer + atlas packer + VXPK writer (TS).
  game/               the gameplay port (TS): world, script VM, text, menus,
                      battle, audio. Runs in Bun headless and in QuickJS on
                      device.
  tapes/              intent tapes (walk/press/wait — never frame counts).
contracts/spec/voxel-spec.ts     the surface, single source of truth
contracts/spec/gen-voxel-rust.ts → engine/pocketvoxel/.../spec.rs (drift-guarded)
tools/voxel.ts                   import | cook | sim | check | record | shots
                                 | wav | psp | run | parity
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
- interprets the ROM's sound programs and renders PCM on demand (§8): the
  guest names a song, an effect or a cry in numbers and the core does the
  synthesis, because the same interpreter in QuickJS costs 2.3 s of CPU per
  second of audio on this part;
- resolves every textured draw's CLUT through one function,
  `draw::resolve_pal` — the pak's per-map world palette, then the page's own
  palette, then the `palette` op's SGB selection, then the page kind's GB
  ramp. Both backends call it, so the software rasterizer and the GE can
  never bind different colours for the same draw;
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
  boulder — pre-cooked removable sub-meshes toggled at runtime),
  `palette(index)` (the SGB SuperPalette for the map, index into the pak's
  SGB set). On a pak cooked with the RED++ pack the per-map and per-page
  bindings in the `VCOL` section outrank `palette(index)` entirely, and
  **the guest emits the identical op stream either way** — no op, no flag
  and no gamedata field differs between the two colour models. Which model
  a build uses is decided by the cook, not by the guest.
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
- **audio** — `music(bank, addr, engine, flags)`, `musicStop()`,
  `musicFade(ticks)`, `sfx(bank, addr, engine, pitch, tempo, flags)`,
  `cry(bank, addr, engine, pitch, length)`, plus the two boot-time table
  pins `audioWaves(engine, bank, addr)` and
  `audioDrum(engine, drum, bank, addr)`. Every argument is a number the guest
  resolved out of the AUDI manifest: `bank` is a **bank slot** (that ROM
  bank's index in the manifest's `bankOrder`) and `addr` the program's GB
  address inside its 0x4000-byte window. **The core parses no JSON and knows
  no name; the guest reads no sample.**
- **system** — `gamedata()` (returns the pak's GAME section to the guest at
  boot: one cold JSON parse, then the guest never crosses for data again),
  `audiodata()` (the pak's AUDI section; the guest parses only its JSON half,
  and the program half stays in the pak, where the core reads it),
  `stats()` (frame counters), `reset()`, `quality(tier)` (§4a).

### 4a. The quality ladder

This runtime is ported to machines an order of magnitude apart in
throughput, so fidelity is a **ladder a machine climbs, not a build flag**.
The rungs and their dials are pinned in `voxel-spec.ts` (`QUALITY_TIER`,
`QUALITY`); a host names its rung once with `quality(tier)` and the core
applies that rung's dials while it builds every frame.

Two rules make it a ladder and not a pile of switches:

- **Every dial here is a RUNTIME dial.** One cooked pak serves every rung, so
  the rung is a host decision and never a re-cook — no op stream and no pak
  byte differs between a PSP and a desktop. Geometry that must itself differ
  per machine belongs in the cook, and the pak then declares which rungs it
  carries so a runtime asking for one it does not hold degrades instead of
  misrendering. The `VOXEL_TREE_BOXES=1` cook flag is the shape this replaces.
- **The top rung is the identity.** It draws exactly what this runtime drew
  before the ladder existed. `tests/goldens/voxel/*-max.hashes` are the
  pre-ladder frame hashes and `bun tools/voxel.ts check` replays both tapes at
  the top rung against them byte-for-byte, so no later dial edit can quietly
  move the picture the ladder is supposed to preserve.

v1's dials, all distances in world px from the view centre to a chunk's own
centre, widened by the chunk's half-extent — one function, `draw::within_dist`,
so a dial added later cannot measure differently from these:

| rung | `grassDist` | `flowerDist` | `chunkDist` |
| --- | --- | --- | --- |
| `psp` (default) | 96 | 96 | 340 |
| `vita` | 192 | 192 | 340 |
| `desktop` | unbounded | unbounded | 340 |

`chunkDist` is 2.5 view-heights at **every** rung including the top: it is
`draw.rs`'s old hard-coded `CULL_DIST` folded in, a pre-existing frame-budget
cap rather than a new fidelity dial, and widening it at the top would draw
*more* than the pre-ladder runtime instead of the same.

**Why the grass and flower distances are what they are.** The GE measures
~1.1 M triangles/s, so 60 fps budgets ≈18 k triangles a frame. The cooker
emits two standing slabs per grass cell and a cutout per flower cell across
the whole field, and on ROUTE_1 at pitch rung 2 those two meshes are **40 226
of the frame's 80 428 triangles** — half the frame spent below the ankle.

Culling is chunk-granular (128 px chunks), and that quantises the dial hard.
Measured over the story trace at the three ROUTE_1 checkpoints, grass+flower
cost is **flat from 48 px to 96 px and jumps at 112 px**: at `mid-route` it is
27 686 triangles anywhere in 48..96 and 34 130 at 112; at `route-1` it is
22 632 anywhere in 64..96 and the full 32 224 at 112. **96 px is the largest
distance that still buys the whole first-ring saving**, which is why it is the
shipped number — every larger value costs picture and buys nothing. It takes
30–34% off the two detail meshes at the ROUTE_1 checkpoints and 5–17% off
those whole frames.

It does not reach 18 k, and **no distance dial can**: ROUTE_1's terrain alone
is 40 202 triangles at rung 2 and Pallet Town's is 89 k with its neighbours
loaded, so even deleting grass and flowers outright leaves the worst story
frame at 99 176 triangles against 131 432 today. This rung takes the largest
bite a runtime dial can take; closing the budget needs the cook-time rungs
(tree LOD, stamp instancing, per-map streaming).

The `vita` rung is a placeholder, not a measurement: at 192 px it is
pixel-identical to the top rung across both tapes on the v1 maps, because
128 px chunks inside a 340 px cap leave room for only two distinct settings
here. It is a labelled rung owed a number from the machine itself.

PCM leaves through the PocketJS `audio` module (`contracts/spec/audio.ts`,
capability `audio.pcm`), not through this surface: the host pumps
`Scene::render_audio` for exactly the frames its ring wants and writes them
under credit. A host that pumps nothing runs the identical op stream silent.

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
5. bake RED++ colour into the terrain page and resolve the bindings
   (`cook/redpp.ts`, below);
6. drop the faces no camera can reach (below);
7. write `dist/voxelmon/voxelmon.vxpak` (MONPAK-style container: magic,
   section table, 16-byte alignment, validated zero-copy reader in the core)
   including the GAME section the guest reads at boot, the AUDI section
   carrying `audio.json` + `programs.bin` verbatim, and the VCOL section
   naming each map's and each page's CLUT.

### The hidden-face cull

Every quad the cooker emits names the direction its front points in
(`cook/geom.ts` `FACE`, the mesher's own `SIDES` numbering), and one rule —
`visibleFacing` — decides which of them no camera can reach. The rule is
applied at exactly one site, `runGeometry`'s return, after the shading and
ground votes have read the full face set. `VOXEL_KEEP_HIDDEN=1` restores
every face and re-cooks a byte-identical pre-cull pak, which is how the rule
is A/B'd.

The rule is **-Y faces topping out at or below 24 world px are dropped**. A
downward face is front-facing only when the eye is under it, and eye height
depends on the rung or rig alone, never on where the player stands:
`WORLD_VIEW_H * cos 75°` = 35.20 px for the field camera, 37.12 px for the
tele rig, 27.91 px for the wide rig at minimum dolly and zero pitch steer
(steer only raises it). **This cuts 5.2% of the cooked quads and 4.6% of the
pak — 210143 → 199175 quads, 21809312 → 20797312 bytes over the seven v1
maps — with all 11 story and 4 battle hash goldens byte-identical.**

Two neighbouring ideas were measured and rejected, and stay rejected:

- **North-facing (-Z) quads are not hidden.** A north wall is front-facing
  wherever `z > eye.z = cy + dist·sin a`, and at rung 0 `eye.z` is the middle
  of the frame — the southern half of a top-down frame shows the north walls
  of everything in it. Dropping them moves 16 of a 30-frame pitch-ladder
  sweep (20916 pixels, 7076 in the worst frame) and breaks the `route-1`
  story golden.
- **The pulled streams keep every face.** GRASS and FLOWER draw with a
  camera-ward `pull` (46 px at rung 0) that displaces each vertex along its
  OWN eye ray — not a rigid transform, so a quad's cooked facing is not its
  drawn facing. Culling them costs 4380 (grass) and 415 (flower) pixels over
  the same sweep and breaks six story and two battle goldens. TERRAIN, WATER
  and the stamps draw with `pull = 0.0` and are the streams the rule acts on.

**The cull is not pixel-exact, by 6 pixels in 3916800.** The rasterizer draws
double-sided with no top-left tie-break, so both triangles sharing an edge
cover a pixel centre that lands on it, and the depth test is strict: a
back-facing underside that ties with the flank it shares an edge with can win
that pixel. Removing the underside hands those 6 pixels — 4 frames of the
30-frame sweep, all at rungs 0 and 1, all single isolated pixels on a
building eave or a tree-hull rim — to the neighbouring face. This is a
property of the renderer, not of the height threshold: a threshold of 2 px,
which drops almost nothing, still leaves 3 of them.

**A free-roam or orbiting field camera deletes this optimisation, it does not
work around it.** Anything that lowers a camera's eye below 24 px — a new
rig, a smaller `RIG.*.height`, a sixth pitch rung past 75° — invalidates the
cooked pak, not just `cook/geom.ts`.

### Per-tile colour (RED++ / pokered-gbc)

pokered-gbc assigns one of **8 four-colour palettes to every tile GRAPHIC
id** of a tileset — by tile id, not by map position — and swaps only the
ROOF slot per town. gen1recomp's ADVANCED mode CPU-recolours the whole
tileset atlas per map from that data. We reach the same colours without
recolouring anything, by moving the group into the texel index:

```
texel = group * 4 + shade     // 0..31
0xff  = transparent           // unchanged
```

8 groups × 4 shades = **32 of the CLUT's 256 entries**, and a tileset's
whole RED++ colour set is 18–20 distinct colours (measured), so the entire
per-tile assignment fits inside the byte the page already stored: **zero
delta in page dimensions, texel count, texture format, fill rate, vertex
count, draw calls and guest ops**. The CLUT bound for a chunk mesh becomes
the shown map's world palette, so Pallet Town's white roofs and Viridian's
green roofs share one terrain page and cost one CLUT load each. The runtime
cost is a few extra 1 KB pool-staged CLUTs per frame.

The roof swap replaces **only colours 1 and 2** of the ROOF group;
colour 0 (sky through the gaps) and colour 3 (outline black) keep the
tileset's own base, exactly as `LoadTownPalette` writes
`W2_BgPaletteData + $32`. Sprites take one of 8 OBJ palettes keyed by ROM
picture id, and battle pics take their species' named palette — both
per-page bindings the backends resolve at bind time, so no entity op
changes. **v1 measures 3 world CLUTs, 4 OBJ and 10 pic over the seven
cooked maps: +17 KB of VPAL and 824 bytes of VCOL on a 13.9 MB pak.**

Parity is claimed **at the CLUT, not at the framebuffer**: our terrain
modulates the CLUT colour by baked AO × face shade, so no pixel can match a
flat 2D reference. `tests/voxel-cook.test.ts` runs gen1recomp's own
`PaletteFX.worldGroupAt`/`worldGroupColors` under LuaJIT and compares all
2688 resolved colours (7 maps × 96 tile ids × 4 shades) against the cook.

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

Two more GE rules this runtime bisected on real hardware (PPSSPP's software
renderer agrees on the second — both draw plausible-looking garbage, never
crash): **textured TRANSFORM_3D draws must use the i16+indexed WORLD
vertex** (a textured `VERTEX_32BITF` card samples noise; every card and
pull-displaced mesh re-stages through the pak's own 20-byte format), and
**CLUT8 atlas pages must be at least 64 px wide** (a 16-px-wide sprite
sheet missamples into vertical-strip noise; the cooker pads sprite and
emote pages and the card U normalizes by page width).

### What per-tile colour does NOT reproduce in v1

Every item here is a deliberate limit with a stated reason:

- **The GB UI, menus, textboxes and the battle screen stay grayscale.**
  RED++ colours them through named SuperPalettes over SGB zones, which needs
  a `uiPal(x, y, w, h, pal)` op — a new op, so a new spec round. HP-bar
  colour by fill (`GetHealthBarColor`) waits on the same op.
- **Dark caves.** `wMapPalOffset`/`FadePal2` shifts the palettes feeding the
  bake, not a shader. v1's seven maps contain no dark map.
- **The Celadon Mart tile exceptions and the `$37 → $5a` alias tiles.** v1
  bakes ONE terrain page shared by every map, so a per-map tile-id exception
  cannot apply; `cook/redpp.ts` carries the reference's tables and the
  cooker **refuses to cook** a map that needs one rather than mis-colouring
  it silently.
- **The Route 6 / Saffron roof y-split.** The reference's own atlas path
  skips it too, so skipping it *is* parity with RED++ as implemented.
- **Per-NPC `"random"` sprite palettes.** The reference resolves the
  `"random"` sentinel from a stable per-instance seed; the CLUT here belongs
  to the sprite PAGE, so v1 resolves it once per sheet at cook time (seeded
  by the sheet key, through the reference's own `h = h*31 + byte` hash).
  Individual NPCs may therefore draw a different one of the four colours
  than gen1recomp does on the same map.
- **Per-tileset terrain page splitting.** Two tilesets may share a sheet only
  if their 96-entry group vectors agree — 0 of v1's 4 sheets disagree, 2 of
  the whole game's 19 do (`gate.png`, `pokecenter.png`). A disagreement is a
  cook-time error; the VCOL map record already reserves a `terrain_page`
  field so the splitter lands without a format change.
- **No user-facing colour mode.** The pak carries one colour model; changing
  it is a re-cook, not a toggle.

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
5. **Two rungs, one tape** — a tape is a guest op stream and the quality rung
   is a host decision, so `bun tools/voxel.ts check` replays each recorded
   trace twice through `pocketvoxel-sim --quality`. `story.hashes` /
   `battle.hashes` are recorded at the **shipped `psp` rung**, so they carry
   that rung's grass and flower distance fade (§4a) and legitimately moved
   when the ladder landed: 5 of 11 story marks and all 4 battle marks changed,
   every one of them in the far field. `story-max.hashes` / `battle-max.hashes`
   are the pre-ladder hashes, asserted at the top rung and **never
   re-recorded** — a mismatch there means the top rung stopped being the
   identity, and the fix is the dials, not the file.

## 8. Audio

Sound is the ROM's own **channel programs** — short bytecode streams the GB's
sound driver interprets a frame at a time — run by an interpreter in the
**Rust core** (`pocketvoxel-core/src/audio.rs`, a port of gen1recomp's
`ChipSynth.lua`) that renders straight to PCM. There is no register-level
emulation: the interpreter tracks each channel's note, envelope, duty,
vibrato, slide, sweep and noise LFSR itself, and the four channels sum,
divide by four and clamp.

The split is the same one the rest of this runtime uses. The guest owns
names, the core owns bytes:

- `game/audio/banks.ts` — the manifest. It resolves a song label, an sfx name
  or a species into the numbers an audio op carries, including the **bank
  slot**: the index of that ROM bank in `bankOrder`, which is where the
  core's 0x4000-byte program window starts. Two transports, one loader (the
  `data.ts` discipline): Bun reads `gen/audio.json`, the device takes the
  JSON half of the pak's AUDI section from the `audiodata` op.
- `game/audio/music.ts` — the policy (a port of `Music.lua` + `Sound.lua`):
  one op per state transition, and nothing else.
- `pocketvoxel-core/src/audio.rs` — the interpreter, the mixer and the
  program bytes, read in place out of the pak's AUDI section. The host pumps
  `Scene::render_audio(pak, frames, out)` for exactly the frames its ring
  wants; rendering is a pure function of (the ops applied so far, the frames
  asked for), so splitting a tick's frames across two calls writes the same
  bytes.

**Why it moved.** Measured on real PSP hardware, one PCM frame of the
four-channel interpreter cost **~0.21 ms** in QuickJS, so 11.025 kHz wanted
**~2.3 seconds of CPU per second of audio**: the guest could never reach the
ring's lead and the frame collapsed to ~9 fps while the music played slow and
gapped. Compiled, the same interpreter renders a whole tick's 184 frames in
**~6.5 µs on a desktop** (measured over 600 s of audio at 11.025 kHz), which
extrapolates to a few hundred microseconds on the Allegrex — **~2% of the
16.7 ms frame**, not 230% of it.

The arithmetic is integer wherever the reference's doubles are integer
underneath: the envelope, the noise LFSR and its clock divider, the NR10
sweep, the durations, the tick snapping, and the whole mix. Two places keep
the reference's double on purpose and both are off the per-sample path — the
60 Hz frame index, where the reference's double disagrees with the exact
rational and the ROM is timed against the reference, and the frequency, which
is recomputed only when the register moves (≤128 times a second per channel)
and lands in a 64-bit fixed-point phase accumulator that advances by integer
addition.

The synth runs at whatever rate the host sets (`Audio::set_rate`), and every
`AUDIO_RATES` value divides 44.1 kHz exactly, so a host resamples with
integer math. The highest note the ROM's pitch table reaches (~2 kHz) sits
inside Nyquist at **11.025 kHz**, the device rate; the cost of a tick is
linear in the rate.

**The pump on device.** The EBOOT is the audio module's client, not the
guest: `pocketvoxel-psp/src/main.rs::audio_pump` runs once per tick, between
`frame(buttons)` and `scene.tick()`, so no PCM crosses the JS boundary at
all. It drains the module's event batch (a `credit` event resets its
free-frame mirror), asks for this tick's `audioFramesForTick` frames plus
whatever it takes to reach a **100 ms lead**, caps that at **three ticks
(552 frames)** so one catch-up cannot blow the frame budget, renders into a
bss buffer sized for that worst tick, and writes it with one `write_pcm`.
The stream opens on the first audio op the guest emits and plays only after
the first accepted write, so a guest with audio off (`setAudio(null)` in
`psp-main.ts`) never reserves a hardware channel. The sim pumps the same
`Scene::render_audio` on its virtual clock (`--wav`), which is what makes a
recorded `.wav` and a device run the same sequence.

What plays where, straight from the reference's own call sites: the map's
theme on map entry (`Music.lua:339`), the wild-battle theme and the enemy's
cry on an encounter (`BattleState.lua:1458`, `:1496`), the victory theme the
moment the win is decided (`:370`), the map theme again when the battle
closes (`:407`), and the `Press_AB` beep on a textbox advance or close
(`TextBox.lua:269`, `:284`).

`bun tools/voxel.ts wav` renders any song, sfx or cry to
`dist/voxelmon/audio/*.wav` with its peak and RMS printed, so "it renders"
and "it is audible" stay two different claims. It goes through the same core
synth as the game does: a one-program `.vtrace` replayed by
`pocketvoxel-sim --wav`.

### Verification: the reference is the oracle

`tests/voxel-audio.test.ts` renders the same program twice — once through the
REFERENCE `ChipSynth.lua` under LuaJIT (`tests/fixtures/voxelmon/oracle/
chipsynth-oracle.lua`, a two-function `love` stub around the unmodified
file), once through the core over the real op stream — and requires the PCM
to be **sample-exact**, not within a tolerance. It also asserts the level:
sample-exact silence would still be a bug, so music has to clear 30% of full
scale.

Measured over the whole ROM at 44.1 kHz, five seconds each: **45 songs, 104
sound effects and 154 cries, all sample-exact** — ~200 million samples, zero
differences. Reaching that took three fixes the sweep found and no unit test
would have: the quantizer's tie at exactly ±2.0 channel-sum, where the
reference's double falls off the boundary its own rounding chose; the phase
step, which must be the reference's double rather than the exact rational,
because a register like 1920 is 1024 Hz exactly and lands ON a duty boundary
every 11025 samples; and the phase accumulator's own rounding, reproduced by
normalizing and rounding the fixed-point sum to 53 significant bits.

## 9. Budgets

16.7 ms/frame at 60 Hz. Guest JS ≤ 2 ms typical (measured OpenStrike idle is
1.4 ms with a far chattier HUD); chunk splice + draw well under the GE's
measured sub-30 µs world cost at OpenStrike scale; a route-scale map cooks to
~1.5–2.5 MB of vertex data (indexed, 20 B/vertex — the mod's 10–20 MB is
unindexed f32 at window resolution and not comparable). Per-map + neighbours
stream from the pak into one reused aligned buffer, the OpenStrike map-swap
pattern. VRAM: 512×272 double-buffered 8888 + 16-bit Z ≈ 1.39 MB; textures
sample swizzled from main RAM.

## 10. Scope ladder

v1 (this tree, delivered): Red only. Import (16 datasets at field-level
parity with the reference extractor) + cook (42/42 non-desk building
templates, carved tree hulls, 8 baked tile-animation frames) + the overworld
slice — walk, collide, ledges, grass, warps, doors, signs, NPCs, an 8-verb
script runner, the textbox typewriter — and the wild-battle core (damage /
accuracy / crit / status / catch / run / exp through the oracle-verified
rules; the early-route effect set; unknown effects degrade via the
reference's own fallbacks) staged in the voxel arena with the classic GB
battle screen composited over it. One tape drives Bun, the Rust rasterizer
(committed hash goldens: 11 story + 4 battle marks, at two quality rungs
each — §4a) and the PSP capture EBOOT. Sound is the ROM's own channel programs, interpreted and rendered to
PCM core-side (`pocketvoxel-core/src/audio.rs`, sample-exact against the
reference over all 303 of them): map themes, the wild-battle and victory
themes, the textbox beep and species cries. Colour is RED++ / pokered-gbc
**per tile**, baked into the terrain texel index and bound per map (§5),
oracle-checked against the reference's own `PaletteFX`; the GB UI layer
stays grayscale.

Later rungs, in dependency order: the next quality-ladder rung, tree LOD —
the first dial the geometry itself must carry, so it is cooked into the pak
and declared there (§4a); the GB UI colour layer (a `uiPal` op — the
one piece of RED++ parity that needs a new op); pak slimming for the
PSP-1000's 24 MB
(stamp instancing over the tree-wall boxes; per-map streaming); the arena
clearance walk (needs cook-time heights in gamedata) and the authored arena
table; the full script verb set and story flags; trainer battles + AI
layers; the desk-set templates, stairs, and detected props; battle move
animations; the box system, marts, and the start menu; Blue/Yellow manifests;
first/third person; link play never.

Stadium battle models are **permanently out of scope** — they require an N64
ROM this pipeline does not accept.
