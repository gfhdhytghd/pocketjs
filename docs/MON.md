# Pocket Mon — the creature-collection RPG runtime

*A specialized PocketJS runtime for grid-world, turn-battle monster RPGs —
the fourth instance of the [RUNTIMES.md](RUNTIMES.md) pattern, after the 2D UI
runtime, the widget runtime and OpenStrike.*

This runtime is a **clean-room port of the architecture** of
[`bryanthaboi/pokemon-gen1-recomp-project`](https://github.com/bryanthaboi/pokemon-gen1-recomp-project)
(Gen1Recomp) — a 44 kLOC Lua/LÖVE2D hand-written recreation of a Gen 1
creature RPG. What is ported is that project's *engine decomposition and
its documented Gen-1 behavioral rules*. What is **not** ported, and never
will be, is its content path.

## 1. The clean-room boundary

Gen1Recomp is a *shell*: it ships no game content and reconstructs everything
— graphics, maps, species tables, text, audio programs — by decoding a
player-supplied Game Boy ROM at first boot (`src/import/RomImporter.lua`,
`src/import/RomExtractor.lua`). Its whole first-boot pipeline exists to turn
copyrighted ROM bytes into a private cache.

Pocket Mon deliberately has **no counterpart to that layer**. There is no ROM
reader, no SHA-1 gate, no importer, no extracted cache, and no code path that
can consume a ROM. Instead:

| Gen1Recomp | Pocket Mon |
| --- | --- |
| `src/import/*` — ROM → private cache | *(absent)* `apps/mon/content/*.ts` — hand-authored TS |
| extracted species/moves/maps | original species, moves, maps, dialogue |
| extracted 2bpp tile graphics | original art, procedurally generated at cook time |
| extracted GB channel programs | original chiptune scores, authored as note data |

The result is **SPARKWOOD**, an original creature-collecting adventure: our
own world, our own creatures, our own art and music. It is playable from a
clean checkout with nothing else supplied.

What legitimately crosses over is **mechanics** — the damage formula, the stat
formula, growth curves, the encounter roll, the catch algorithm, the
bottom-left-tile collision rule. Game mechanics are not copyrightable, these
are exhaustively documented in public references, and Gen1Recomp itself cites
its provenance per formula. Every ported rule keeps that citation in the Rust
source so the lineage stays auditable.

No trademarked names, characters, sprites, maps, music, or text are used.

## 2. The ontology

Per RUNTIMES.md, `Runtime = ⟨ Cores, Surfaces, Guest ⟩`:

```
pocketmon-psp (EBOOT)          engine/pocketmon/crates/pocketmon-psp
  = pocketmon-core             the RPG core: world, battle, script VM, save,
  |                            text, the scene builder and the `mon` surface
  + pocketmon-gu               the GE backend for the core's draw list
  + an arena allocator         one static block; see the crate's arena.rs

pocketmon-sim (headless)       engine/pocketmon/crates/pocketmon-sim
  = pocketmon-core
  + a software rasterizer      the reference the PSP backend is checked against

SPARKWOOD (the game)           apps/mon
  = content in TypeScript      species, moves, maps, scripts, trainers, text
  + procedural art             tiles, walk sheets, portraits, a 5x7 font
  -> one cooked MONPAK         embedded in the EBOOT at build time
```

**What is wired today.** The core is complete and the EBOOT runs it: the
console boots, parses the embedded pak, and plays the game. The `mon` surface
is specified in the contract and *implemented* as `Game::op` — one dispatcher
covering every op, exercised by `cargo test` — and `apps/mon/sdk.ts` is the
guest-side algebra over it.

**What is not wired yet.** No QuickJS realm is mounted in the EBOOT, so
`Game::op` currently has no JS caller on the console: the shipped game's
behaviour comes from its cooked content plus the native script VM. Mounting
`pocket-mod` (or the raw QuickJS embedding `pocketjs-psp` already carries) and
binding the dispatcher is a thin layer over a surface that is already written
and tested — but it is not done, and this document will not pretend otherwise.
The same goes for mounting the `ui` surface for menus: the core draws its own
battle UI and dialogue today.

The base game is meant to be the first mod (RUNTIMES.md discipline #5), and
the content path already honours it — every species, move, map, script and
trainer is data, and the core ships none of it. What is missing is only the
realm that would let that data arrive from a running JS program rather than a
cooked file.

### Where the upstream Lua modules land

| Gen1Recomp | Layer | Pocket Mon |
| --- | --- | --- |
| `world/Map`, `Collision`, `Warp` | **core** | `world/map.rs` — cell queries, the bottom-left-tile rule, connections |
| `world/Player`, `NPC` | **core** | `world/actor.rs` — grid movement, walk cycle, scripted walks |
| `world/OverworldController`, `Encounter` | **core** | `world/overworld.rs` — input, interaction, warps, the encounter roll |
| `render/TileRenderer`, `SpriteRenderer`, `Camera` | **core** | `scene.rs` → `MonDrawList` |
| `render/Font`, `TextBox` | **core** | `text.rs` — charmap, wrapping, typewriter, `\n` `\v` `\f` |
| `battle/Damage`, `TypeChart` | **core** | `battle/damage.rs` + the matchup table in `content.rs` |
| `battle/BattleState`, `TurnOrder`, `Status` | **core** | `battle/mod.rs` |
| `battle/MoveEffects` | **core** | `battle/effects.rs` — 30 effects natively, the rest as guest hooks |
| `battle/Catching` | **core** | `battle/catching.rs` |
| `battle/TrainerAI` | **core** | `battle/ai.rs` — the AI class is a smartness dial |
| `battle/Experience` | **core** | `mon/growth.rs` |
| `pokemon/Stats`, `Growth`, `Party`, `Boxes` | **core** | `mon/stats.rs`, `mon/growth.rs`, `mon/mod.rs` |
| `core/SaveData`, `script/Flags` | **core** | `save.rs` — flat binary, checksummed, versioned |
| `script/ScriptRunner`, `Commands` | **core** | `script.rs` — a resumable 41-verb VM |
| `core/FixedStep`, `Input`, `StateStack` | **host** | the one-turn-per-tick frame loop (Law 3) |
| `ui/*` (~40 menu modules) | **core** | `scene.rs` draws the battle UI and dialogue from core state |
| `data/scripts/*.lua` | **guest** | `apps/mon/content/game.ts` `SCRIPTS`, compiled by the cooker |
| `mods/*` | **guest** | the surface *is* the mod API (`apps/mon/sdk.ts`) |
| `import/*` | — | *(deliberately absent — see §1)* |
| `core/ChipSynth`, `ChipAudio`, `Music` | — | **not implemented.** The core states what should be sounding (`Game::music`, `sfx`, `cry`) and no host acts on it yet |
| `link/*` (UDP link play) | — | out of scope for v1 |

### Why the split falls where it does

The [QuickJS PSP perf wall](DETERMINISM.md) is the forcing function: measured
at ~1.7 µs/op on a 333 MHz PSP, a guest gets ~8 k boundary ops per frame. So
everything per-entity and per-frame — tile emission, sprite animation,
collision, camera, the whole battle turn — is Rust. The guest runs once per
tick to answer events and drive menus, and its content upload happens once at
boot. Overworld frames cost the guest **zero** ops.

## 3. The `mon` surface

Pinned in `contracts/spec/mon-spec.ts`, codegen'd to
`engine/pocketmon/crates/pocketmon-core/src/spec.rs`, byte-compared in
`tests/mon-contract.test.ts`. Append-only: codes are never renumbered.

**Ops** (guest → core) fall in five groups:

- **content** — `loadContent` takes a cooked MONPAK. The per-record `defineX`
  ops are reserved in the contract for the mod path and are not implemented
  yet; a mod today ships a second pak and merges it.
- **world** — `enterMap`, `warpTo`, `moveActor`, `faceActor`, `showActor`,
  `hideActor`, `setFlag`, `getFlag`, `setBlock`, `showText`, `showChoice`,
  `closeText`, `setMode`, `playMusic`, `stopMusic`, `playSfx`, `playCry`.
- **party** — `givemon`, `healParty`, `giveItem`, `takeItem`, `setPartyMove`.
- **battle** — `startWild`, `startTrainer`, `chooseAction`, `chooseMove`,
  `chooseItem`, `chooseSwitch`, `advance`, `endBattle`.
- **query** — `view(kind)` returns a packed snapshot (world, party, battle,
  bag, player, dex); `partySlot(i)` and `text(key)` for the rest. Cold path
  only: nothing here is meant to be called per frame.
- **system** — `save`, `load`, `hasSave`, `seed`, `viewport`, `events`,
  `frameStats`.

All of them route through one dispatcher, `Game::op(code, args)` in
`surface.rs`, so a host binding is a marshalling shim over a single function
rather than fifty trampolines. An unknown code is a no-op, not a panic: codes
are append-only and a guest built against a newer spec has to degrade.

**Events** (core → guest) are drained once per tick as a batch:
`talk`, `sign`, `warped`, `encounter`, `battleEnded`, `scriptDone`,
`textDone`, `menuRequest`, `levelUp`, `evolve`, `caught`, `faint`.

The frame contract is Law 3 exactly: the host calls `tick(buttons)` once per
fixed 60 Hz tick, then `render()`. Frame content is a pure function of tick
index + inputs + seed, which is what makes both the sim hashes and the PSP
frame goldens byte-exact.

## 4. Coordinates and the viewport

Inherited wholesale from the upstream engine, because they are what make the
collision rules legible:

- **block** — 32×32 px, the unit of a map's layout array
- **cell** — 16×16 px, the walk grid; every actor, warp and sign coordinate
- **tile** — 8×8 px, the graphics unit. A cell is 2×2 tiles, a block 4×4.

A cell's behavior — passable, grass, door, warp, water — is decided by its
**bottom-left 8×8 tile**, matching the original engine's "tile at the
sprite's feet" check. This one rule is why the upstream project's collision
matches; it is ported verbatim.

**Viewport.** The GB screen is 160×144. The PSP is 480×272, which is 3.0× the
width but only 1.889× the height — no integer scale fits. Rather than
letterbox to 1× (wasting three-quarters of the panel) or blur to a fractional
scale, Pocket Mon renders at **2× into a 240×136 logical view**: sharp doubled
pixels, the full panel used, and 30×17 tiles visible instead of the GB's
20×18. The core takes the logical view size as a parameter, so a 1× host (or
a future 160×144 e-ink host) is a config change, not a fork.

## 5. The three laws

- **Law 1 — state in cores, mirrors in guests.** The party, bag, flags, world
  and battle live in Rust. A guest holds a mirror it refreshes from events and
  from the packed `view()` snapshots; nothing reads the boundary per frame.
- **Law 2 — intent as ops, facts as events.** No callbacks from native
  mid-tick, no shared memory. A script's `show_text` is a core→guest `talk`
  event; the guest answers with `showText` ops.
- **Law 3 — one guest turn per host tick.** The script VM is a resumable
  state machine, not a coroutine, precisely so a blocking `show_text` costs
  no thread and stays replayable.

## 6. Verification

A runtime without a headless story is not done (discipline #4):

- **`cargo test`** in `engine/pocketmon/crates/pocketmon-core` — 245 tests over
  the rules: damage across the crit / STAB / dual-type / stat-scaling matrix,
  the crit and accuracy roll distributions, stat and growth curves, the
  encounter roll's bucket boundaries, catch rates, turn order including speed
  ties, collision and the bottom-left-tile rule, seam crossing, the script
  VM's blocking verbs, save round-trip and corruption rejection, and the whole
  `mon` surface.
- **`bun test tests/mon-contract.test.ts tests/mon-content.test.ts`** — the
  spec drift guard, and 29 content-integrity checks: every learnset move
  exists, every warp lands on a cell that actually has a door under it, every
  connection is declared from both sides with mirrored offsets, the font
  covers every character the game writes, cooking twice is byte-identical, and
  the runtime has no code path that reads a ROM.
- **`bun tools/mon.ts check`** — the deterministic playthrough: out of the
  house, across the village, take a starter from the professor, north to Route
  One, and win two wild battles, asserted against recorded frame hashes.
  `bun tools/mon.ts shots` writes a PNG per checkpoint to look at.
- **`bun tests/e2e/mon-ppsspp.ts`** — the same journey **on the console**.
  There is no second tape: `pocketmon-sim --emit-psp` replays the intent tape
  above and writes out the per-frame input it produced, which the capture
  EBOOT then replays verbatim under PPSSPPHeadless's software renderer. That
  works because the core is identical and deterministic on both hosts, which
  is the runtime's whole premise being cashed in rather than a trick.

  Three things are asserted: **liveness** (all 14 checkpoints reached — 2877
  frames, boot through two won battles, so a boot hang, a content-parse halt
  or a wedged loop all fail loudly), **byte-exact PNG goldens**, and
  **backend agreement** — every checkpoint is compared pixel for pixel against
  the software rasterizer's own output. The GE path and the reference
  rasterizer are separate implementations of one draw list; if they disagree,
  the sim goldens are describing a picture the console never shows.
- Real hardware, over PSPLINK — **not yet run**.

## 7. Out of scope for v1

Link play (upstream's UDP `src/link/*`), the save editor, Discord presence,
the mod manager UI, and the slot-machine minigame. None of them are load
bearing for the runtime thesis; all of them are expressible through the
surface later, by a guest, without touching the core.
