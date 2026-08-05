# voxelmon data interfaces

The three stages hand off through `dist/voxelmon/` (git-ignored — every byte
under it derives from the player's ROM):

```
ROM + rom_manifest.json --import--> dist/voxelmon/gen/   --cook--> dist/voxelmon/voxelmon.vxpak
                                    (JSON + gfx.bin)               (VXPK, includes GAME section)
```

Inputs are resolved by `tools/voxel.ts`:

- `VOXELMON_ROM` — the canonical US Red ROM (1 MiB, SHA-1
  `ea9bcae617fdf159b045185467ae58b2e4a48b9a`). No default is committed;
  the local developer default lives in `tools/voxel.ts`.
- `VOXELMON_G1R` — a gen1recomp checkout (default `~/code/gen1recomp`);
  supplies `tools/rom_manifest.json` and the parity reference
  (`data/generated/` built by its `tools/build_rom_data.py`).
- `VOXELMON_VOXELMOD` — a DramaticShapeVoxelMod checkout (default
  `~/code/DramaticShapeVoxelMod`); supplies `data/voxel_heights.lua` and
  `data/battle_arenas.lua` for the cooker.

Anything needing these inputs **skips with a printed reason** when they are
absent. CI never sees them.

## `dist/voxelmon/gen/` — the imported dataset

One JSON file per gen1recomp `data/generated` module, **same field names and
record shapes as the Lua tables** so parity diffing is mechanical:

`constants.json, tilesets.json, maps.json, font.json, sprites.json,
moves.json, items.json, type_chart.json, palettes.json, pokemon.json,
trainers.json, encounters.json, text.json, text_pointers.json,
trainer_headers.json, field.json`

Normalization rules (Lua → JSON):

- Lua arrays (dense 1..n) become JSON arrays, order preserved. **Every index
  shifts down by one**; consumers index 0-based.
- Map-shaped tables become objects; numeric keys become strings.
- Absent optional fields are omitted, never `null`.
- No floats are introduced; everything the Lua stored as integers stays
  integer.

Graphics do not become PNGs. `gen/gfx.bin` is a single blob of indexed
bitmaps — **1 byte per pixel**: `0..3` = GB shade (0 = white/lightest),
`0xff` = transparent. `gen/gfx.json` is the directory:

```json
{ "tilesets/overworld": { "off": 0, "w": 128, "h": 48 },
  "sprites/red":        { "off": 6144, "w": 16, "h": 96, "walker": true },
  "battle/front/pikachu": { "off": ..., "w": 56, "h": 56 }, ... }
```

Keys mirror the upstream `assets/generated/` relative paths (without
extension). `tools/voxel.ts shots --gen` can dump any entry to a local PNG
for eyeballing; PNGs never land in `gen/`.

## Parity

`tools/voxel.ts parity` deep-compares `gen/*.json` against the reference
`$VOXELMON_G1R/data/generated/*.lua` (dumped to JSON through a LuaJIT
one-shot, `apps/voxelmon/import/lua-dump.lua`, applying the same
normalization). Field-for-field equality is the bar; the diff prints the
first N mismatching paths.

## `gamedata` — what the guest parses at boot

The cooker packs the gameplay subset of `gen/` into the pak's GAME section as
JSON bytes: constants, maps (layout + collision-relevant tileset fields +
warps/signs/objects/connections), encounters, moves, pokemon, items,
type_chart, trainers, text, text_pointers, trainer_headers, field, plus two
cook-time products: `atlas` (the page-index maps) and `mapPalette` (map id →
SGB palette index into the pak's SGB set — the static port of pokered's
SetPal_Overworld rule; the guest emits `palette(mapPalette[map] ?? -1)` at
map entry). The guest
calls `voxel.gamedata()` once, `JSON.parse`s, and never crosses the boundary
for data again. In Bun (headless sim) the same object is loaded straight from
`gen/` by `apps/voxelmon/game/data.ts` — one loader, two transports.

## UI tile ids — the GB VRAM convention

`uiTile`/`uiFill` tile ids and the CMAP section's values ARE the GB tile
codes: the cooker packs the UI atlas so `fonts/font` glyphs sit at their
charmap codes (`mainBase 0x80..0xff`) and `fonts/font_extra`
(textbox borders, arrows, HP bar) at `extraBase 0x60..0x7f`. Tile id 0 is
transparent (UI cell unset). Guest-side names for the border/arrow tiles
live in `apps/voxelmon/game/ui/tiles.ts`; the cooker owns the packing and
must satisfy this mapping.

## `.tape` — intent tapes

`apps/voxelmon/tapes/*.tape` describe intent, never frame counts (the
Pocket Mon lesson): one command per line, `#` comments.

```
walk <u|d|l|r> <cells>     # hold the direction until that many steps LAND
press <a|b|start|select|u|d|l|r>   # tap: one tick down, then released
wait <ticks>
mark <name>                # checkpoint: the sim renders + hashes here
```

A turn-in-place is not a step; `walk` counts landed steps and releases the
direction when `landed + in_flight == target` so walks never overshoot.

## `.vtrace` — the op trace, one tape on every host

The Bun headless run records everything that crossed the boundary;
`pocketvoxel-sim` replays it through the real core and rasterizer. Text,
line-oriented, `dist/voxelmon/trace/<name>.vtrace`:

```
voxtrace 1
t <tick> <buttons>          # starts a tick; buttons = VOX_BTN mask that tick
o <code> <i32> <i32> ...    # one op, numeric args in order
s <code> <i32> <i32> <json-string>   # the op forms carrying a string arg
m <name>                    # checkpoint marker: sim renders + hashes here
```

Ticks are contiguous from 0. The sim renders at every `m`, appends
`<name> <fnv1a64-of-rgba>` to its hash report, and `--shots` writes the PNG
locally. Committed goldens are the hash lines only
(`tests/goldens/voxel/<tape>.hashes`).
