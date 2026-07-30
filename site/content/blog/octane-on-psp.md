<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-hero-jsx-60fps.png" alt="The PocketJS hero demo running through Octane on a PSP: a headline reading JSX at 60 FPS, a live FPS counter showing 60, 42 nodes, 9 draw calls, a Press Circle button with Count: 1, and a subtitle reading Flexbox, springs and baked type running through Octane" />

<p class="text-sm text-slate-500 -mt-4">The hero demo's "pressed" moment — a committed 480×272 PPSSPP golden from the Octane e2e suite, shown at 2×. The counter under the button is <code>useState</code>. The 60 in the corner is real.</p>

When we first benchmarked JavaScript frameworks on the PSP ([PR #6](https://github.com/pocket-stack/pocketjs/pull/6)), React was the one that didn't make it: after the measurements, the writeup's conclusion was that original React has no viable path on a 333 MHz MIPS handheld with 32 MB of RAM. Solid and Vue Vapor became PocketJS's two frameworks, and "React on a PSP" went into the drawer labeled *not with that runtime*.

[Octane](https://github.com/octanejs/octane) reopened the drawer. It is Dominic Gannaway's compiled implementation of the React programming model — `useState`, `useEffect`, JSX, the works — with no virtual DOM and no reconciler, because a compiler resolved the component tree's shape before the app ever shipped. That is not a performance detail. It is the difference between "React can't run here" and "the React *model* compiles to something that can."

So we ported it. If you are new here: [PocketJS](/blog/introducing-pocketjs/) runs real web-framework components on a 2004 Sony PSP at a locked 60 FPS, and lately on [Vitas](/blog/pocketjs-on-ps-vita/), [Nokias](/blog/pocketjs-on-symbian/), and e-readers. As of this release it supports three frameworks over one native tree and one Rust core: Solid, Vue Vapor, and Octane. Every demo Vue Vapor has, Octane now has; 15 of the 23 committed Octane PSP goldens are **byte-identical** to the Vue Vapor frame; and the three-way benchmark below is the complete comparative dataset PR #6 could not produce, including an honest 15.58× that took a memory hunt through a pinned JS engine to explain.

## A third dialect, not a third engine

An Octane PocketJS app reads exactly the way a React developer would write it — hooks from `octane`, host components from the framework:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/octane";
import { View, Text } from "@pocketjs/framework/octane/components";
import { useState } from "octane";

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">{`Framework: ${frameworkName()}`}</Text>
      <View focusable onPress={() => setCount(count + 1)}>
        <Text class="text-sm text-blue-600">{`Count: ${count}`}</Text>
      </View>
      {count > 2 ? <Text class="text-sm text-emerald-600">Octane, native tree.</Text> : null}
    </View>
  );
}

mount(App);
```

At build time, Octane's *universal* compiler lowers the JSX into static host plans plus dynamic slots, and infers effect dependency arrays from captures (you may still write them; you mostly don't). Hooks are tracked by call site rather than by array index, which is why an Octane hook is allowed inside an `if`. At runtime, the compiled output talks to whatever renderer the build named — and ours is `@pocketjs/framework/octane/renderer`, a driver that maps Octane's host command batches (create, update, insert, move, remove, destroy) directly onto the same native `ui.*` tree Solid and Vue Vapor render into.

<svg viewBox="0 0 760 430" width="100%" role="img" aria-label="Architecture diagram. Three framework boxes at the top: Solid with signals and JSX through the universal-mode renderer; Vue Vapor with refs through a small DOM shim; Octane with hooks and JSX compiled at build time to host plans and slot batches, no DOM shim. All three arrows converge on one native ui tree of NodeMirrors owning styles, focus and animation, which flows into pocketjs-core for layout, clipping and the DrawList, which flows into sceGu, the PSP's fixed-function graphics engine, at 480 by 272 and 60 hertz. Caption: a third framework is a third dialect, not a third engine" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#38bdf8" stroke-width="1.5"/>
  <text x="128" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Solid</text>
  <text x="128" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">signals · JSX</text>
  <text x="128" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">universal-mode renderer</text>
  <rect x="268" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="380" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Vue Vapor</text>
  <text x="380" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">refs · JSX</text>
  <text x="380" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">renderer + small DOM shim</text>
  <rect x="520" y="14" width="225" height="84" rx="10" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="632" y="40" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">Octane</text>
  <text x="632" y="60" fill="#94a3b8" font-size="11" text-anchor="middle">hooks · JSX · compiled</text>
  <text x="632" y="78" fill="#64748b" font-size="10.5" text-anchor="middle">universal driver · no DOM shim</text>
  <path d="M128 98 L128 130 L340 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M380 98 L380 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M632 98 L632 130 L420 158" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M380 158 l-5 -8 M380 158 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <text x="644" y="146" fill="#e8590c" font-size="10" text-anchor="middle">compiled to host plans + slot batches</text>
  <rect x="180" y="162" width="400" height="64" rx="10" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="188" fill="#f1f5f9" font-size="13" font-weight="700" text-anchor="middle">one native ui.* tree</text>
  <text x="380" y="208" fill="#22d3ee" font-size="11" text-anchor="middle">NodeMirrors · styles · focus · input · animation</text>
  <path d="M380 226 L380 262" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 262 l-5 -8 M380 262 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="205" y="266" width="350" height="58" rx="9" fill="#0c1a22" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="380" y="290" fill="#e2e8f0" font-size="13" font-weight="700" text-anchor="middle">pocketjs-core</text>
  <text x="380" y="310" fill="#22d3ee" font-size="11" text-anchor="middle">layout · clip · paint transforms · DrawList</text>
  <path d="M380 324 L380 358" stroke="#475569" stroke-width="1.5"/>
  <path d="M380 358 l-5 -8 M380 358 l5 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="230" y="362" width="300" height="44" rx="9" fill="#0b0f1a" stroke="#2b3a55"/>
  <text x="380" y="381" fill="#e2e8f0" font-size="12" text-anchor="middle">sceGu · fixed-function GE</text>
  <text x="380" y="398" fill="#64748b" font-size="10.5" text-anchor="middle">480×272 · 60 Hz</text>
  <text x="380" y="424" fill="#475569" font-size="11" text-anchor="middle">a third framework is a third dialect, not a third engine</text>
</svg>

The driver is deliberately boring: batches in, `NodeMirror` mutations out, text through the host's text nodes, portals as a driver capability that mints overlay hosts transactionally. Two details are less boring. Unlike Vue Vapor, there is **no DOM shim** — Octane's universal target never asks for a document, so the adapter is the thinnest of the three. And PocketJS's frame loop drains Octane's microtask-scheduled re-renders **synchronously inside each frame**, so a `setState` in a button handler commits in the same tick that pressed the button — the same latency contract Solid and Vue Vapor already keep, and the reason input tapes stay [deterministic](/blog/ui-runtime-that-cant-flake/) across all three.

Selecting it is one flag, or one manifest line:

```sh
bun tools/build.ts hero-main --framework=octane   # dist/hero-main.octane.js
bun tools/psp.ts hero --framework=octane --release  # a real EBOOT.PBP
```

An `app.octane.tsx` next to `app.tsx` is picked up automatically — which is how one demo directory carries all of its ports.

## Porting eight demos, and what the compiler taught us

All eight showcase demos — hero, cards, stats, library, settings, notifications, music, gallery — now ship an Octane twin beside their Solid original and Vue Vapor port, sim-verified against the Vue Vapor variants and pinned by 23 byte-exact PPSSPP goldens. Fifteen of those 23 goldens are byte-identical to the Vue Vapor frame: same input tape, same frame index, same pixels, different programming model. The eight that differ are all frames captured mid-animation — sprite phases, equalizer bars, spring tails — where the frameworks' schedulers land on slightly different phases of the same motion.

Porting produced a short list of authoring rules, each discovered the hard way and now in [the frameworks doc](/docs/frameworks/):

- **The entry passes the component itself.** `mount(App)`, not `mount(() => <App />)` — JSX inside a call-argument arrow is a fail-closed error in the universal target.
- **Mixed static and dynamic text is one template literal.** ``<Text>{`Count: ${count}`}</Text>`` — the compiler drops trailing whitespace on a static segment that precedes an expression, and `Count:0` is not a good look.
- **Frame-loop counters use functional updates.** `setX((v) => v + 1)`; a same-frame handler's write would otherwise be clobbered by a stale read.
- **Keep natively animated properties out of `style` objects whose values change across renders.** Re-applying a changed style value cancels the running tween; drive those from an effect with `animate()` and a `nodeRef`.
- **Keep always-animating state in leaf components.** This one turned out to be about memory, not CPU — the next section is why.

PocketJS's own per-frame hooks came along renamed: `useFrame`, `useButtonPress`, `useSpriteAnimation`. The `use` prefix is not a style choice — the Octane compiler slot-keys custom hooks by the `use[A-Z]` call-site convention, and an `onFrame`-style name compiles into a plain call whose internal slots silently collide. We found that out when a gallery demo's left trigger started acting as a +1 button.

## The memory hunt

The first full Octane demos did not survive their runs. The music demo died at frame 58 with `InternalError: out of memory` — while megabytes of the QuickJS arena sat free. Exceptions arrived as `null`. The frame loop wedged. Every one of those symptoms pointed somewhere different, and all of them were real.

The excavation went three layers down:

1. **Octane's profiler is on by default** — and its `trackedComponents` WeakMap keeps being written even after `profiler.stop()`, with per-render closures as values.
2. **The pinned QuickJS marks WeakMap values strongly.** Our engine is a 2026 QuickJS revision whose new GC is not ephemeron-aware: a ten-line repro (`wm.set(key, {back: key})`) never collects, and the same code is on bellard master today. Every render's owner graph was being pinned by a profiler nobody asked for.
3. **The engine's slab allocator amplifies whatever survives.** A few live objects pin whole chunks of `JSMallocArena`, so a small true leak carves the fixed arena 10–20× faster than its own size, and the engine's auto-GC threshold (live × 1.5) is far too lazy for a heap this small.

The fixes ship in this release: `framework=octane` builds alias `octane/profiling` to a no-op stub; the PSP frame loop gained an **arena-pressure GC** that runs a collection when a frame leaves the bump pointer more than 256 KiB past the last one (steady-state Solid and Vue Vapor guests never trigger it); and the Octane ports keep always-animating state in leaf components — the music demo's equalizer owns its own tick, so a re-render touches four bars instead of the screen:

```tsx
function Equalizer(props: { playing: boolean }) {
  const [barsFrame, setBarsFrame] = useState(0);
  useFrame(() => {
    if (props.playing) setBarsFrame((v) => v + 1);
  });
  const barHeight = (i: number): number => {
    if (!props.playing) return 6;
    const v = Math.abs(Math.sin(barsFrame * 0.15 + i * 1.7));
    return 6 + Math.round(v * 20);
  };
  return (
    <View class="flex-row items-end gap-1 h-16">
      {([0, 1, 2, 3] as const).map((i) => (
        <View key={i} class="w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600"
          style={{ height: barHeight(i) }} />
      ))}
    </View>
  );
}
```

What the fixes do **not** do is make frequent re-rendering free on this engine revision. Post-stub, each re-render still retains a residue the collector cannot reclaim — measured at ~80–115 KB per frame across the per-frame-state demos — so an always-animating Octane screen has a session memory horizon until the engine is repaired: it outlives its capture window, not an unbounded afternoon. The stats demo's benchmark window ends with the arena at 16.87 of 17.06 MiB. That is 98.9 % used, which its own screen almost predicted:

<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-stats-mission-control.png" alt="The stats demo running through Octane on a PSP: a Mission Control dashboard with tiles for players online 12,480, sessions today 3,642, draw calls 268, and a status list where GE PIPELINE, AUDIO MIXER and WIFI LINK read ONLINE while MEMORY ARENA reads 87 percent used in amber" />

<p class="text-sm text-slate-500 -mt-4">The stats demo's Mission Control screen — a committed Octane golden. Its telemetry is fictional demo copy, but "MEMORY ARENA: 87% USED" aged into near-documentary: at the end of the real benchmark window the real arena sat at 98.9 %.</p>

<svg viewBox="0 0 760 412" width="100%" role="img" aria-label="Cascade diagram of the memory pathology and its fixes. Top row: an always-animating screen calling setState every frame leads to roughly 80 to 115 kilobytes retained per re-render that the pinned engine cannot reclaim, which leads to the slab allocator pinning whole chunks around survivors, which leads to a live set that grows every frame — stats reaches 16.87 of 17.06 mebibytes by the window's last frame. That flows into: the engine's auto-GC walks the growing set, 254 milliseconds of stats' 280 millisecond frame is JS plus GC, which is why benchmark average frame work reads 15.58 times Solid — GC dominance, not render cost. Bottom row, what ships today: the profiler stubbed out, an arena-pressure GC in the host frame loop, and state kept in leaf components. Caption: the residue itself is an engine bug; the quickjs-rs GC repair and repin is the tracked follow-up, and apps without per-frame state are unaffected" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <rect x="16" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="100" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">always-animating screen</text>
  <text x="100" y="74" fill="#94a3b8" font-size="10.5" text-anchor="middle">setState every frame</text>
  <path d="M184 69 L200 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M200 69 l-7 -4 M200 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="202" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="286" y="50" fill="#eab308" font-size="11.5" font-weight="700" text-anchor="middle">~80–115 KB retained</text>
  <text x="286" y="68" fill="#eab308" font-size="11.5" font-weight="700" text-anchor="middle">per re-render</text>
  <text x="286" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">engine can't reclaim it</text>
  <path d="M370 69 L386 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M386 69 l-7 -4 M386 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="388" y="28" width="168" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="472" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">slab chunks pinned</text>
  <text x="472" y="74" fill="#94a3b8" font-size="10" text-anchor="middle">whole chunks stay alive</text>
  <text x="472" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">around each survivor</text>
  <path d="M556 69 L572 69" stroke="#475569" stroke-width="1.5"/>
  <path d="M572 69 l-7 -4 M572 69 l-7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="574" y="28" width="170" height="82" rx="9" fill="#0b0f1a" stroke="#854d0e" stroke-width="1.5"/>
  <text x="659" y="54" fill="#f1f5f9" font-size="11.5" font-weight="700" text-anchor="middle">live set grows every frame</text>
  <text x="659" y="74" fill="#94a3b8" font-size="10" text-anchor="middle">stats: 16.87 of 17.06 MiB</text>
  <text x="659" y="90" fill="#94a3b8" font-size="10" text-anchor="middle">by the window's last frame</text>
  <path d="M659 110 L659 142 L560 166" stroke="#475569" stroke-width="1.5" fill="none"/>
  <path d="M560 166 l9 -3 M560 166 l4 -8" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="376" y="170" width="368" height="66" rx="9" fill="#0b0f1a" stroke="#e8590c" stroke-width="1.5"/>
  <text x="560" y="194" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">engine auto-GC walks the growing set</text>
  <text x="560" y="216" fill="#94a3b8" font-size="10.5" text-anchor="middle">stats: 254 ms of a 280 ms frame is JS + GC</text>
  <path d="M376 203 L360 203" stroke="#475569" stroke-width="1.5"/>
  <path d="M360 203 l7 -4 M360 203 l7 4" stroke="#475569" stroke-width="1.5" fill="none"/>
  <rect x="16" y="170" width="342" height="66" rx="9" fill="#0e1626" stroke="#22d3ee" stroke-width="1.5"/>
  <text x="187" y="194" fill="#f1f5f9" font-size="12" font-weight="700" text-anchor="middle">benchmark: avg frame work 15.58× Solid</text>
  <text x="187" y="216" fill="#22d3ee" font-size="10.5" text-anchor="middle">GC dominance — not Octane's render cost</text>
  <text x="380" y="266" fill="#e2e8f0" font-size="11.5" font-weight="700" text-anchor="middle">what ships today</text>
  <rect x="16" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="132" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">profiler stubbed out</text>
  <text x="132" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">octane/profiling → no-op</text>
  <text x="132" y="338" fill="#64748b" font-size="10" text-anchor="middle">for framework=octane builds</text>
  <rect x="264" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="380" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">arena-pressure GC in the host</text>
  <text x="380" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">JS_RunGC when a frame leaves bump</text>
  <text x="380" y="338" fill="#64748b" font-size="10" text-anchor="middle">>256 KiB past the last collection</text>
  <rect x="512" y="278" width="232" height="72" rx="9" fill="#0b0f1a" stroke="#42b883" stroke-width="1.5"/>
  <text x="628" y="302" fill="#e2e8f0" font-size="11" font-weight="700" text-anchor="middle">state lives in leaf components</text>
  <text x="628" y="322" fill="#94a3b8" font-size="10" text-anchor="middle">a tick re-renders four bars,</text>
  <text x="628" y="338" fill="#64748b" font-size="10" text-anchor="middle">not the screen</text>
  <text x="380" y="380" fill="#475569" font-size="10.5" text-anchor="middle">the residue is an engine bug — the quickjs-rs GC repair + repin is the tracked follow-up</text>
  <text x="380" y="398" fill="#475569" font-size="10.5" text-anchor="middle">apps without per-frame state are unaffected</text>
</svg>

Along the way the PSP host's exception logger learned to print tag, message, and stack — a `null` exception, it turns out, is QuickJS telling you it had no room left to construct the Error object. And the debug rig that cracked the case was not on the PSP at all: a scratch Cargo probe pinned to the exact same QuickJS revision, evaluating the real bundle against a stubbed `ui`, with heap histograms and a GC root dump. It reproduced the handheld's memory behavior byte-for-byte on a desktop, which is the only reason a three-layer engine bug was findable in finite time.

## The benchmark PR #6 couldn't run

PR #6's React column was empty because nothing bootable existed to measure. This time all three columns are full: 7 apps × 3 frameworks × 7 samples on deterministic headless PPSSPP — repeated runs are byte-identical — with geomean-vs-Solid ratios and bootstrap CIs, archived in [`docs/bench/`](https://github.com/pocket-stack/pocketjs/tree/grass-responsibility/docs/bench).

| geomean vs Solid (lower is better) | Vue Vapor | Octane |
|---|---:|---:|
| bundle eval | 2.93× | 2.95× |
| boot → first frame | 2.30× | 2.32× |
| avg frame work | 1.24× | **15.58×** |
| bundle size | 2.41× | 2.96× |

<svg viewBox="0 0 760 468" width="100%" role="img" aria-label="Log-scale horizontal bar chart of average JS work per frame for seven demo apps in three frameworks on PPSSPP. Solid and Vue Vapor sit between 4.4 and 16.1 milliseconds for every app. Octane splits: cards at 9.7 milliseconds inside the 16.7 millisecond frame budget, settings at 27.4 and library at 50.8 above it, and the per-frame-state apps — hero 387.8, stats 279.9, notifications 271.2, music 282.7 milliseconds — an order of magnitude out, dominated by engine GC. A dashed line marks the 16.7 millisecond 60 FPS budget" font-family="ui-monospace,SFMono-Regular,Menlo,monospace">
  <text x="16" y="20" fill="#e2e8f0" font-size="13" font-weight="700">Average JS work per frame — log scale</text>
  <rect x="16" y="34" width="10" height="10" fill="#38bdf8"/><text x="30" y="43" fill="#e2e8f0" font-size="10">Solid</text>
  <rect x="86" y="34" width="10" height="10" fill="#42b883"/><text x="100" y="43" fill="#e2e8f0" font-size="10">Vue Vapor</text>
  <rect x="186" y="34" width="10" height="10" fill="#e8590c"/><text x="200" y="43" fill="#e2e8f0" font-size="10">Octane</text>
  <line x1="110" y1="60" x2="110" y2="402" stroke="#1e293b"/>
  <line x1="336" y1="60" x2="336" y2="402" stroke="#1e293b"/>
  <line x1="562" y1="60" x2="562" y2="402" stroke="#1e293b"/>
  <line x1="386" y1="56" x2="386" y2="402" stroke="#854d0e" stroke-dasharray="5 4"/>
  <text x="392" y="64" fill="#eab308" font-size="10">16.7 ms budget</text>
  <text x="100" y="92" fill="#cbd5e1" font-size="10.5" text-anchor="end">hero</text>
  <rect x="110" y="70" width="144" height="11" fill="#38bdf8"/><text x="259" y="79" fill="#94a3b8" font-size="9">4.4</text>
  <rect x="110" y="83" width="150" height="11" fill="#42b883"/><text x="265" y="92" fill="#94a3b8" font-size="9">4.6</text>
  <rect x="110" y="96" width="585" height="11" fill="#e8590c"/><text x="700" y="105" fill="#94a3b8" font-size="9">387.8</text>
  <text x="100" y="140" fill="#cbd5e1" font-size="10.5" text-anchor="end">cards</text>
  <rect x="110" y="118" width="162" height="11" fill="#38bdf8"/><text x="277" y="127" fill="#94a3b8" font-size="9">5.2</text>
  <rect x="110" y="131" width="170" height="11" fill="#42b883"/><text x="285" y="140" fill="#94a3b8" font-size="9">5.7</text>
  <rect x="110" y="144" width="223" height="11" fill="#e8590c"/><text x="338" y="153" fill="#22d3ee" font-size="9">9.7 — steady state, inside budget</text>
  <text x="100" y="188" fill="#cbd5e1" font-size="10.5" text-anchor="end">stats</text>
  <rect x="110" y="166" width="212" height="11" fill="#38bdf8"/><text x="327" y="175" fill="#94a3b8" font-size="9">8.6</text>
  <rect x="110" y="179" width="236" height="11" fill="#42b883"/><text x="351" y="188" fill="#94a3b8" font-size="9">11.1</text>
  <rect x="110" y="192" width="553" height="11" fill="#e8590c"/><text x="668" y="201" fill="#94a3b8" font-size="9">279.9</text>
  <text x="100" y="236" fill="#cbd5e1" font-size="10.5" text-anchor="end">library</text>
  <rect x="110" y="214" width="150" height="11" fill="#38bdf8"/><text x="265" y="223" fill="#94a3b8" font-size="9">4.6</text>
  <rect x="110" y="227" width="177" height="11" fill="#42b883"/><text x="292" y="236" fill="#94a3b8" font-size="9">6.1</text>
  <rect x="110" y="240" width="385" height="11" fill="#e8590c"/><text x="500" y="249" fill="#94a3b8" font-size="9">50.8</text>
  <text x="100" y="284" fill="#cbd5e1" font-size="10.5" text-anchor="end">settings</text>
  <rect x="110" y="262" width="201" height="11" fill="#38bdf8"/><text x="316" y="271" fill="#94a3b8" font-size="9">7.7</text>
  <rect x="110" y="275" width="213" height="11" fill="#42b883"/><text x="328" y="284" fill="#94a3b8" font-size="9">8.8</text>
  <rect x="110" y="288" width="325" height="11" fill="#e8590c"/><text x="440" y="297" fill="#94a3b8" font-size="9">27.4</text>
  <text x="100" y="332" fill="#cbd5e1" font-size="10.5" text-anchor="end">notifications</text>
  <rect x="110" y="310" width="168" height="11" fill="#38bdf8"/><text x="283" y="319" fill="#94a3b8" font-size="9">5.6</text>
  <rect x="110" y="323" width="216" height="11" fill="#42b883"/><text x="331" y="332" fill="#94a3b8" font-size="9">9.0</text>
  <rect x="110" y="336" width="550" height="11" fill="#e8590c"/><text x="665" y="345" fill="#94a3b8" font-size="9">271.2</text>
  <text x="100" y="380" fill="#cbd5e1" font-size="10.5" text-anchor="end">music</text>
  <rect x="110" y="358" width="252" height="11" fill="#38bdf8"/><text x="367" y="367" fill="#94a3b8" font-size="9">13.0</text>
  <rect x="110" y="371" width="273" height="11" fill="#42b883"/><text x="388" y="380" fill="#94a3b8" font-size="9">16.1</text>
  <rect x="110" y="384" width="554" height="11" fill="#e8590c"/><text x="669" y="393" fill="#94a3b8" font-size="9">282.7</text>
  <text x="110" y="416" fill="#64748b" font-size="10" text-anchor="middle">1 ms</text>
  <text x="336" y="416" fill="#64748b" font-size="10" text-anchor="middle">10 ms</text>
  <text x="562" y="416" fill="#64748b" font-size="10" text-anchor="middle">100 ms</text>
  <text x="380" y="448" fill="#475569" font-size="10.5" text-anchor="middle">PPSSPP software renderer · 7 deterministic samples per cell · byte-identical reruns · base 3c14b47</text>
</svg>

Read the 15.58× with the last section in mind: it is the engine pathology compounding, not Octane rendering slowly. In every per-frame-state app the growing live set hands the engine's auto-GC a bigger walk each collection, until GC **is** the frame. The honest steady-state number is `cards`, the one demo with no per-frame state: 9.66 ms, 1.86× Solid, comfortably inside the 16.7 ms budget of a 60 FPS frame. Boot, eval, and bundle are engine-pathology-free, and there Octane lands essentially on top of Vue Vapor — a compiled React model costs about what a compiled Vue costs to ship and start. These numbers are honest to the current pinned engine, and they should collapse toward the `cards` ratio when the quickjs-rs GC repair lands; we would rather publish the ugly column with its explanation than wait for the flattering one.

Two footnotes for the methodologically suspicious. The bench window and its input tape are baked into each EBOOT at build time, which is why runs are byte-identical — and why our first attempt to "reproduce" a number by rebuilding without the bake measured a completely different, idle window. And the report can be rebuilt from raw samples without re-running emulation, which mattered the day the report builder crashed *after* 147 emulator runs had already succeeded.

## In the playground, too

The [playground](/playground/) grew a third toggle. The real Octane universal compiler runs in the browser — it is pure JavaScript, so unlike some of our compilers it needed no WASM shim — and the docs' framework-switchable code blocks now carry all three variants, 29 blocks' worth. Same editor, same native-tree WASM host, third dialect.

<img class="w-full rounded-xl border border-line" src="/assets/blog/octane-music-leaf-state.png" alt="The music demo running through Octane on a PSP: a Now Playing screen for MIDNIGHT REPLAY by SYNC PULSE with a progress bar at one percent, a three-track playlist, a four-bar equalizer in the corner, and controller hints for focus, play and skip" />

<p class="text-sm text-slate-500 -mt-4">The music demo's Octane port mid-playback — the four equalizer bars in the corner are the <code>Equalizer</code> leaf component above, re-rendering alone at 60 Hz while the rest of the tree stays put.</p>

## What's named, what's next

The gaps, named, because that is house policy: the per-frame-state memory horizon is real until the quickjs-rs GC repair and repin land (the ten-line WeakMap repro also reproduces on bellard master, so an upstream report is owed); the benchmark numbers above are emulator numbers from PPSSPP's software renderer, and a real-hardware spot-check is the open checklist item — the release EBOOTs are built and PPSSPP-verified, and PR #6's samples say emulator-to-hardware variance is modest, but we will not caption an emulator as a Memory Stick; and `gallery`, the eighth demo, ports and builds like the rest but is not yet in the golden suite.

Everything here — adapter, compiler wiring, eight ports, playground, docs, benchmark — lands in [#203](https://github.com/pocket-stack/pocketjs/pull/203). Three frameworks now compile into the same native tree on the same 2004 handheld, and the newest one writes like React because, at the source level, it is: hooks, JSX, and a compiler that did the reconciler's job before the code left your machine.

Follow [@pocket_js](https://x.com/pocket_js) for what's next. The pocket keeps getting deeper.
