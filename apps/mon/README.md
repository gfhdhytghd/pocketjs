# SPARKWOOD

An original creature-collecting adventure, and the content half of the Pocket
Mon runtime ([docs/MON.md](../../docs/MON.md)).

Everything here is source. There is no ROM, no importer, and no asset pipeline
that reads one — the creatures, the world, the words and the art are all
written or generated in this directory and cooked into a single `.monpak`.

```
content/game.ts     species, moves, types, items, maps, trainers, scripts
content/text.ts     the string table (a key IS an index; no runtime hashing)
art/font.ts         a 5x7 pixel face, hand-authored
art/tiles.ts        8x8 terrain tiles, the 4x4-tile blocks, tile behaviours
art/actors.ts       procedural 16x16 walk sheets, twelve poses each
art/creatures.ts    procedural 64x64 portraits, front and back
art/palette.ts      the one 256-entry CLUT the whole game shares
cook.ts             all of the above -> dist/sparkwood.monpak
sdk.ts              the guest-side algebra over the `mon` surface
tapes/story.tape    the acceptance run
```

## Working on it

```sh
bun tools/mon.ts cook      # rebuild the pak
bun tools/mon.ts check     # play the acceptance tape, assert the frame hashes
bun tools/mon.ts shots     # write a PNG per checkpoint, and the atlas pages
bun tools/mon.ts psp       # build the PSP EBOOT with the pak baked in
bun tools/mon.ts run       # …and launch it in PPSSPP
```

`shots` is the one to reach for first: content bugs are visual, and a
screenshot per checkpoint plus the atlas pages tells you in one look whether
the art is wrong or the drawing is.

## Adding to the world

The content tests (`tests/mon-content.test.ts`) enforce the things that are
easy to get wrong and hard to notice:

- a warp must sit on a cell whose block actually has a door under it — the
  bottom-left-tile rule means a door drawn in the wrong quarter of a block is
  scenery;
- map connections must be declared from both sides with mirrored offsets, or
  walking across a seam and back lands you somewhere else;
- every species needs a move learnable by level 5, or a starter stands there
  doing nothing;
- the font must cover every character the content writes, because a missing
  glyph is invisible rather than loud.

Cooking is deterministic: the same checkout produces byte-identical output, and
a test asserts it. If a change makes the pak non-reproducible, that is a bug in
the cooker, not a quirk to work around.
