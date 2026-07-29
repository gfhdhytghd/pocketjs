# Frameworks

PocketJS supports three first-class app frameworks over the same native tree
and Rust core:

| Framework | Build id | JSX transform | Runtime renderer | Output suffix |
|---|---|---|---|---|
| Solid | `solid` | `babel-preset-solid` universal mode | `renderer-solid.ts` | none |
| Vue Vapor | `vue-vapor` | `vue-jsx-vapor` | `renderer-vue-vapor.ts` | `.vue-vapor` |
| Octane | `octane` | Octane universal compiler (host plans + slots) | `renderer-octane.ts` (pocket universal driver over the native tree) | `.octane` |

Solid is the default so existing apps keep building to `dist/<app>.js` and
`dist/<app>.pak`. Vue Vapor and Octane build next to it:

```sh
bun tools/build.ts hero-main                    # dist/hero-main.js
bun tools/build.ts hero-vue-vapor-main --framework=vue-vapor
# dist/hero-vue-vapor-main.vue-vapor.js
bun tools/build.ts hero-main --framework=octane
# dist/hero-main.octane.js
```

Sibling variant files select automatically: an `app.octane.tsx` (or
`app.vue-vapor.tsx`) next to `app.tsx` is picked up when building with the
matching `--framework`, which is how one demo directory carries all of its
ports — all eight showcase demos (`hero`, `cards`, `stats`, `library`,
`settings`, `notifications`, `music`, `gallery`) ship an `app.octane.tsx` and
`main.octane.tsx` beside the Solid originals.

There is no environment-variable switch for framework selection. Product
builds declare it in `pocket.json`; low-level compiler work can still use a
project config or one-command override.

## Manifest selection

```json
{
  "app": {
    "framework": "solid"
  }
}
```

Use `"vue-vapor"` for the Vue adapter and `"octane"` for Octane.
`pocket check|compile|build --target …`
resolves this value once and all framework/compiler/native stages consume the same plan.
Do not also put `framework` in `pocket.config.ts` for a manifest build.

## Low-level project config

`pocket.config.ts` is the low-level script default:

```ts
import { definePocketConfig } from "@pocketjs/framework/config";

export default definePocketConfig({
  framework: "solid",
});
```

Use Vue Vapor or Octane by changing the file:

```ts
export default definePocketConfig({
  framework: "vue-vapor",
});
```

```ts
export default definePocketConfig({
  framework: "octane",
});
```

The direct framework/compiler/dev scripts read the config by default. Use
`--framework=solid`, `--framework=vue-vapor`, or `--framework=octane` to
override it for one invocation. `--config=<path>` selects a different config
file, and `--no-config` ignores config entirely.

The same flag works through the dev and PSP entry points:

```sh
bun tools/dev.ts --framework=vue-vapor hero-vue-vapor-main
bun tools/dev.ts --framework=octane hero-main
bun tools/psp.ts hero-vue-vapor --framework=vue-vapor --release
```

## Framework app imports

Apps import state and component lifecycle from the selected framework directly.
PocketJS does not wrap `createSignal`, `ref`, `useState`, `onMount`,
`onMounted`, or `useEffect`.

Solid app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/solid";
import { View, Text, type NodeMirror } from "@pocketjs/framework/solid/components";
import { createSignal, onMount, Show } from "solid-js";

export default function App() {
  const [count, setCount] = createSignal(0);
  let marker: NodeMirror | undefined;

  onMount(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => setCount(count() + 1)}>
        <Text class="text-sm text-blue-600">Count: {count()}</Text>
      </View>
      <Show when={count() > 2}>
        <Text class="text-sm text-emerald-600">Solid, native tree.</Text>
      </Show>
    </View>
  );
}

mount(() => <App />);
```

Vue Vapor app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/vue-vapor";
import { View, Text, type NodeMirror } from "@pocketjs/framework/vue-vapor/components";
import { onMounted, ref } from "vue";

export default function App() {
  const count = ref(0);
  let marker: NodeMirror | undefined;

  onMounted(() => {
    console.log(frameworkName(), marker?.id);
  });

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">Framework: {frameworkName()}</Text>
      <View nodeRef={(node) => (marker = node ?? undefined)} focusable onPress={() => count.value++}>
        <Text class="text-sm text-blue-600">Count: {count.value}</Text>
      </View>
      {count.value > 2 ? (
        <Text class="text-sm text-emerald-600">Vue Vapor, native tree.</Text>
      ) : null}
    </View>
  );
}

mount(App);
```

Octane app:

```tsx
import { mount, frameworkName } from "@pocketjs/framework/octane";
import { View, Text, type NodeMirror } from "@pocketjs/framework/octane/components";
import { useEffect, useRef, useState } from "octane";

export default function App() {
  const [count, setCount] = useState(0);
  const marker = useRef<NodeMirror | null>(null);

  useEffect(() => {
    console.log(frameworkName(), marker.current?.id);
  }, []);

  return (
    <View class="p-4 flex-col gap-2">
      <Text class="text-base text-slate-950">{`Framework: ${frameworkName()}`}</Text>
      <View
        nodeRef={(node: NodeMirror | null) => {
          marker.current = node;
        }}
        focusable
        onPress={() => setCount(count + 1)}
      >
        <Text class="text-sm text-blue-600">{`Count: ${count}`}</Text>
      </View>
      {count > 2 ? (
        <Text class="text-sm text-emerald-600">Octane, native tree.</Text>
      ) : null}
    </View>
  );
}

mount(App);
```

The generic public subpaths remain Solid-first defaults. Use explicit framework
subpaths when an example or app is tied to a framework:

| Import | Solid build | Vue Vapor build | Octane build |
|---|---|---|---|
| `@pocketjs/framework` | `framework/src/index.ts` | `framework/src/index-vue-vapor.ts` | `framework/src/index-octane.ts` |
| `@pocketjs/framework/components` | `framework/src/components.ts` | `framework/src/components-vue-vapor.ts` | `framework/src/components-octane.tsx` |
| `@pocketjs/framework/lifecycle` | Solid lifecycle hooks | Vue Vapor lifecycle hooks | Octane lifecycle hooks (`useFrame`, `useButtonPress`, `useSpriteAnimation`) |

Use `nodeRef` when a component should look similar across framework examples. Solid still supports
`ref`, but `nodeRef` avoids framework-specific ref semantics.

## Explicit framework subpaths

When you intentionally want one framework, import it directly:

```tsx
import { mount } from "@pocketjs/framework/solid";
import { View } from "@pocketjs/framework/solid/components";
```

```tsx
import { mount } from "@pocketjs/framework/vue-vapor";
import { View } from "@pocketjs/framework/vue-vapor/components";
```

```tsx
import { mount } from "@pocketjs/framework/octane";
import { View } from "@pocketjs/framework/octane/components";
```

Explicit subpaths are useful for framework-specific examples, tests, and
integration code. Most apps should prefer the generic PocketJS subpaths and keep
framework state imports native.

## Octane notes

Octane is React's programming model, compiled: hooks and JSX, no VDOM. Hooks
(`useState`, `useEffect`, `useMemo`, `useRef`, `useLayoutEffect`,
`useEffectEvent`, …) import from `octane`. Dependency arrays may be omitted —
the compiler infers them from captures. Hooks are tracked by call site, so a
hook inside an `if` block is fine, but hooks in loops are not. PocketJS's
per-frame hooks follow the same rule: they are `useFrame`, `useButtonPress`,
and `useSpriteAnimation` (from `@pocketjs/framework/octane/lifecycle` or the
generic `lifecycle` subpath), use-prefixed because the Octane compiler
slot-keys custom hooks by the `use[A-Z]` naming convention.
(`pushButtonHandlerBlock` is not a hook and keeps its name.)

At build time, Octane's universal compiler lowers JSX to static host plans
plus dynamic slots against the "pocket" renderer; at runtime the compiled
imports retarget to `@pocketjs/framework/octane/renderer`, whose driver maps
host command batches onto the native `ui.*` tree. There is no DOM shim
(unlike Vue Vapor). PocketJS's frame loop flushes Octane's microtask-scheduled
re-renders synchronously inside each frame, so a state write in a handler
commits in that same frame.

Authoring rules specific to Octane apps:

- **The entry passes the component itself.** `main.octane.tsx` must call
  `mount(App)` — JSX inside a call-argument arrow (`mount(() => <App />)`) is
  a universal-target compile error.
- **Mixed static + dynamic text is one template literal.** Write
  ``<Text>{`Count: ${count}`}</Text>``, not `<Text>Count: {count}</Text>` —
  the compiler drops trailing whitespace on a static segment that precedes an
  expression.
- **`class` stays full literals or ternaries of full literals**, exactly as in
  the other frameworks.
- **Counters driven from `useFrame` use functional updates**
  (`setX((v) => v + 1)`): a same-frame handler's state write would otherwise
  be clobbered by a stale read.
- **Keep natively `animate()`d properties out of a `style` object whose value
  changes across re-renders.** Re-applying a changed style value cancels the
  running tween (unchanged values are diffed away and are safe); drive such
  properties from an effect with `animate()`/`jump()` and a `nodeRef` instead.
- **Keep always-animating state in leaf components.** A per-frame `setState`
  re-renders its owning component; putting the counter in a small leaf (the
  music demo's `Equalizer`/`ProgressLine`, the stats demo's `StatTiles`)
  keeps each tick's re-render to a handful of nodes instead of the whole
  screen. On the PSP's fixed QuickJS arena this matters twice over: the
  pinned engine retains a sliver of every render, and its slab allocator
  pins whole chunks around it (the host runs an arena-pressure collection,
  but less garbage is always better). If the rendered value only changes on
  step boundaries, commit state on the step, not the raw frame — see
  `StatTiles` in `apps/stats/app.octane.tsx`.
- **Frequently re-rendering apps have a session memory horizon on PSP**
  until the pinned QuickJS is upgraded: each render retains a small residue
  the collector cannot reclaim on this engine revision (~80–115 KB/frame
  measured for the per-frame-state demos), so an always-animating screen
  outlives its showcase capture window but not an unbounded session. The
  growing live set also inflates engine GC time, which is why the PSP
  benchmark's per-frame-work numbers for those demos are dominated by GC
  rather than by Octane's own render work (`cards`, which has no per-frame
  state, shows the steady-state cost). Solid and Vue Vapor apps, and Octane
  apps without per-frame state, are unaffected. The engine fix (quickjs-rs
  GC repair + repin) is tracked as a follow-up.

## What stays shared

All three frameworks use the same Tailwind-subset compiler, generated style table,
font atlas baker, `.pak` asset container, host detection, input/focus system,
overlay layer, animation API, PSP/Vita native build paths, browser dev host, and
PPSSPP/Vita3K capture paths. Switching frameworks changes only the JS
component/reactivity layer and renderer adapter.
