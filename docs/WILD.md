# Wild: the playable-world kernel

`apps/wild/` is a proof of concept for open-world *systemic* gameplay on the
PocketJS runtime family: a small meadow where trees chop down into trunks and
firewood, apples detach, roll downhill and bake beside fires, and fire
spreads through grass — every interaction produced by a rule engine, none of
it scripted pairwise. The design distills the engine architecture documented
by Breath of the Wild research (the zeldaret/botw decompilation, the GDC 2017
chemistry-engine talk) onto the PocketJS determinism contract. This document
is the reference for the kernel's model and its boundaries.

## Where it sits

```
apps/wild/
├─ wild/        the kernel: defs, world, physics, chemistry, damage, rng
├─ scene/       content: def table, terrain sampler, visuals, vfx, palette
├─ lib/         vendored playset subset: scene3d client + math + loop
├─ game.ts      the first "mod": player verbs, camera, HUD state
└─ app.tsx      <Viewport3D> + HUD (Solid)
```

The kernel is plain TypeScript with no runtime dependencies beyond the
vendored math types. It follows the guest-owned-state split proven by Pocket
Voxel: **all world state lives in the guest; the host renders a retained
scene** through the `scene3d` surface (`globalThis.s3`), which this PR lands
on the desktop `uihost`. On hosts without `s3` the same world runs headless —
`<Viewport3D>` degrades to an empty box and the HUD stays live, which is what
the sim tests exercise.

## The model, in five rules

1. **Everything is an actor: one data record, one state record.** An
   `ActorDef` (wild/defs.ts) composes behavior from optional fields — `body`
   (physics shape), `fuel` (combustion), `cook` (heat substitution), `life`
   (damage reactions), `spHit` (tag bonus), `tags` — the shape of BotW's
   actor param file stack (`.bphysics`, `.bchemical`, `.bdmgparam`,
   `Tag%d`) reduced to one literal. **A def never contains code.**

2. **Chemistry is three rules over one quantity.** Elements change
   materials; elements change elements; materials never change materials
   (that interaction is physics). Heat is the quantity: burning actors and
   one-tick bursts radiate it with linear falloff; fuel-bearing actors
   accumulate it toward `ignition`; food accumulates it toward its `cook`
   substitution. Water zeroes heat, extinguishes, and applies a wet timer
   that refuses heat; wind stretches every fire's reach downwind by
   displacing the source's effective center. **No chemistry rule names a
   def** — a campfire, a burning tuft and a carried burning branch are all
   "a burning actor", which is why carrying fire around just works.

3. **Damage is a typed event, never a method call.** A `Hit` carries a
   physical kind (`chop`/`blunt`), a power, an impulse, an optional element,
   and a tag bonus — BotW's `SpHitTag`/`SpHitRatio`: the axe is not "the
   tree tool", it is a chop weapon with **×3 against tree-tagged actors**,
   and the tree's `life.vulner` table decides what chop does to it.

4. **Destruction and transformation are actor substitution.** The standing
   tree dies into a `fallenTrunk` laid along the fall direction; the trunk
   chops into three `log`s; anything burned out becomes its `burnOutBorn`
   (tree → charred stump, grass → scorch decal); an apple under sustained
   heat becomes `bakedApple`. Attached children (apples in the canopy)
   detach into free bodies whenever their parent is hit, ignites, or dies.

5. **The world is a pure fold.** `World.step(1/60)` runs a fixed pipeline —
   physics → hits → chemistry → lifecycle — with one seeded rng stream and
   no reads of wall time (DETERMINISM.md). The kernel emits typed events
   (`ignited`, `cooked`, `felled`, …) that presentation consumes; nothing
   feeds back. `tests/wild.test.ts` pins every tuning number
   (**the chemistry ladder: flint 70 lights woodPile 42 and grass 40, never
   log 85 / trunk 110 / standing tree 150**, and a lit campfire cannot
   torch the meadow by itself), and `tests/wild-sim.test.ts` proves the
   same journey produces the same world hash at 60 Hz and 20 Hz.

## The presentation split

`scene/visuals.ts` scans `world.actors` once per virtual frame: unseen ids
get a visual built from primitives (every mesh in the meadow is a cached
box/sphere/cylinder/cone or the terrain heightfield — no model files), dead
ids are destroyed, dynamic ids get pose writes batched through one
`scene.flush()`. Substitution needs no special handling: the old id
disappears, the new id gets built. Char and cook progress ride `nodeSetTint`
bucketed to 16 steps; fire, smoke and one-shot bursts are sprite pools whose
jitter is a **stateless hash of (actor id, tick)** — deterministic without
consuming world rng.

The terrain is one seeded height function (`scene/terrain.ts`) serving both
the kernel (contacts, slopes, rolling) and the baked heightfield the scene
renders, so **the drawn meadow and the simulated meadow cannot disagree**.
The BotW-register look comes from banded vertex colors, one warm sun, a
two-tone hemisphere ambient, and thick linear fog matched to the horizon of
the gradient sky — all within the scene3d surface's fixed-function
vocabulary (no textures, no shadow maps; contact shadows are transparent
discs).

## Scaling paths (what this POC is for)

- **Content scales as data.** New materials/foods/weapons are def rows; new
  interactions come from the rule matrix, not new systems. The next elements
  (electricity, ice) extend `Element` and add rules 1/2 entries without
  touching content.
- **The kernel is host-portable by construction** — it is exactly the
  guest-side half of the Pocket Voxel split. A PSP path means porting the
  branch's `scene3d` GE core; the kernel's per-tick cost (≈100 actors,
  O(n·k) separation, one heat pass) is sized for an interpreter budget, and
  hot loops can move behind a native `ps`-style core the way rally's did
  without changing the def table.
- **The verb surface is the mod surface.** game.ts drives the world only
  through `queueHit` / `heatBurst` / `pickUp` / `throwHeld` / `detach` — a
  future `wild` runtime spec would pin exactly these ops plus the event
  stream (RUNTIMES.md discipline: the base game is the first mod).

## Boundaries (deliberate, v1)

- Physics is spheres on a heightfield plus vertical static columns — no
  stacked rigid bodies, no constraints. The felled trunk *tips* in
  presentation, not in the solver.
- Chemistry has fire/water/wind only; electricity and ice are enum space,
  not code.
- One damage matrix (chop/blunt × vulner table); no HP for the player, no
  combat loop.
- The scene3d surface is desktop-only in this PR; PSP/Vita render paths for
  it stay on the research branch.
