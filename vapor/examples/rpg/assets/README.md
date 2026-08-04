# Vapor Quest pixel art

This folder is the reviewed visual source for the GBA RPG POC. PixelLab creates
the source PNGs; the offline asset compiler fixes their dimensions, transparent
anchors and GBA palettes before emitting the two sheets in `final/` and
`vapor/runtime/gba/vapor_rpg_assets.generated.h`.

## Art bible

- Bright field, deep-navy information layer, compact chibi silhouettes.
- Native hard pixels, no antialiasing, gradients, dithering or partial alpha.
- Lighting always comes from the top left; visible outlines use `#181821`.
- BG cells are 8x8. World OBJ frames are 16x16 with a shared y=15 foot
  line; battle reuses the same source art as readable 32x32 frames.
- World/UI, hero, elder and slime each have one fixed 4bpp palette bank.
- Flowers remain low-contrast walkable decoration; walls, water and trees read
  as barriers. UI texture remains quieter and higher contrast than the world.

`generation.json` records the exact PixelLab endpoints, prompts, seeds, IDs and
source hashes. It intentionally contains no API token.

## Rebuild

Source generation is opt-in because it consumes PixelLab quota and replaces
reviewed art:

```sh
set -a
source ~/code/.env
set +a
bun run vapor:rpg:assets:generate --force --only=all
```

The normal build and CI paths are entirely offline:

```sh
bun run vapor:rpg:assets:build
bun run vapor:rpg:assets:check
```

Do not hand-edit the generated header. Review the two 1x PNG sheets and the
world, dialog and battle mGBA captures after changing any source image.

Use `--only=style`, `--only=world`, `--only=tree`, `--only=flower`,
`--only=characters`, `--only=hero`, `--only=elder` or `--only=slime` with
`--force` for a targeted iteration. Without `--force`, generation only fills
missing sources.
