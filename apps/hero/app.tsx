// Demo app + the jsx.d.ts typecheck fixture (bunx tsc --noEmit must pass).
// Uses all three public primitives, class literals, a dynamic style object,
// focus + onPress, and a signal in text — the exact surface phase v1 supports.

import { createSignal, onCleanup, onMount, Show } from "solid-js";
import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate } from "@pocketjs/framework/animation";
import { enableTouchPress } from "@pocketjs/framework/input";
import { createSpriteAnimation } from "@pocketjs/framework/lifecycle";
import { platform } from "@pocketjs/framework/platform";
import { frameworkName } from "@pocketjs/framework/solid";

const SPINNER_FRAME_STEP = 3;
const SPINNER_FRAMES = [
  "spinner-00.svg",
  "spinner-01.svg",
  "spinner-02.svg",
  "spinner-03.svg",
  "spinner-04.svg",
  "spinner-05.svg",
  "spinner-06.svg",
  "spinner-07.svg",
];

function Stat(props: { label: string; value: string; cls: string }) {
  return (
    <View class="flex-col items-end">
      <Text class={props.cls}>{props.value}</Text>
      <Text class="text-xs text-slate-500 tracking-wide">{props.label}</Text>
    </View>
  );
}

export default function Hero() {
  const isKindle = platform.target === "kindle-pw5";
  const [count, setCount] = createSignal(0);
  const disableTouchPress = isKindle ? enableTouchPress() : undefined;
  onCleanup(() => disableTouchPress?.());
  const spinnerSrc = isKindle
    ? () => SPINNER_FRAMES[0]
    : createSpriteAnimation(SPINNER_FRAMES, { frameStep: SPINNER_FRAME_STEP });
  let underline: NodeMirror | undefined;
  onMount(() => {
    // Underline sweeps in once on mount — native tween, zero steady-state JS.
    // Kindle keeps it static so the panel reaches its quiet cleanup window.
    if (!isKindle && underline) {
      animate(underline, "width", 210, { dur: 700, easing: "out", delay: 150 });
    }
  });
  return (
    <View
      debugName="HeroScreen"
      class={isKindle
        ? "w-full h-full flex-col justify-between p-5 bg-white"
        : "w-full h-full flex-col justify-between p-5 bg-gradient-to-b from-slate-50 to-slate-100"}
    >
      <View
        debugName="Header"
        class={isKindle
          ? "flex-col gap-4"
          : "flex-row flex-wrap items-center justify-between"}
      >
        <View class="flex-row items-center gap-3">
          <Image class="w-10 h-10 rounded-lg shadow" src="logo.png" />
          <View class="flex-col">
            <Text class="text-base text-slate-950 font-bold tracking-wide">PocketJS</Text>
            <Text class="text-xs text-slate-500 tracking-wide">
              {isKindle ? `${frameworkName()} + RUST + FBINK` : `${frameworkName()} + RUST + SCEGU`}
            </Text>
          </View>
        </View>
        <View class={isKindle ? "w-full flex-row justify-between" : "flex-row gap-4"}>
          <Stat
            label={isKindle ? "LOGIC" : "FPS"}
            value="60"
            cls={isKindle
              ? "text-lg text-slate-950 font-bold"
              : "text-lg text-emerald-600 font-bold"}
          />
          <Stat
            label={isKindle ? "WAVE" : "NODES"}
            value={isKindle ? "DU" : "42"}
            cls={isKindle
              ? "text-lg text-slate-950 font-bold"
              : "text-lg text-blue-600 font-bold"}
          />
          <Stat
            label="DRAWS"
            value="9"
            cls={isKindle
              ? "text-lg text-slate-950 font-bold"
              : "text-lg text-amber-600 font-bold"}
          />
        </View>
      </View>

      <View class={isKindle ? "flex-col gap-4" : "flex-col gap-2"}>
        <Text
          class={isKindle
            ? "text-xs text-slate-950 tracking-wide"
            : "text-xs text-blue-600 tracking-wide"}
        >
          ONE RUST CORE · ONE JSX APP
        </Text>
        <View
          class={isKindle
            ? "flex-col gap-2"
            : "flex-row flex-wrap items-center justify-between"}
        >
          <Text
            class={isKindle
              ? "text-3xl text-slate-950 font-bold"
              : "text-4xl text-slate-950 font-bold"}
          >
            {isKindle ? "JSX on e-ink." : "JSX at 60 FPS."}
          </Text>
          <Show
            when={isKindle}
            fallback={<Image class="w-10 h-10" src={spinnerSrc()} />}
          >
            <View class="self-start px-3 py-1 rounded-lg border-[1] border-slate-950 bg-white">
              <Text class="text-xs text-slate-950 font-bold tracking-wide">E-INK NATIVE</Text>
            </View>
          </Show>
        </View>
        <Show
          when={isKindle}
          fallback={
            <View
              ref={underline}
              class="h-1 w-0 rounded-full shadow bg-gradient-to-r from-blue-500 to-cyan-500"
              style={{ translateX: count() * 2 }}
            />
          }
        >
          <View class="w-full h-1 bg-slate-950" />
        </Show>
        <Show
          when={isKindle}
          fallback={
            <View debugName="Description" class="flex-row flex-wrap gap-1">
              <Text class="text-sm text-slate-600">Flexbox, springs and baked type —</Text>
              <Text class="text-sm text-slate-600">running on a 2005 handheld.</Text>
            </View>
          }
        >
          <View debugName="Description" class="flex-col gap-1">
            <Text class="text-sm text-slate-700">Flexbox + Solid signals.</Text>
            <Text class="text-sm text-slate-700">Rendered through Rust + FBInk.</Text>
          </View>
        </Show>
      </View>

      <View class={isKindle ? "flex-col gap-3" : "flex-row flex-wrap items-center gap-4"}>
        <View
          class={isKindle
            ? "w-full h-[52] flex-row items-center justify-center rounded-xl border-[2] border-slate-950 bg-slate-950 focus:bg-slate-800 active:bg-slate-600"
            : "px-4 py-2 rounded-xl shadow-md bg-blue-600 border-blue-500 focus:bg-blue-500 active:bg-blue-700 transition-colors duration-150"}
          focusable
          onPress={() => setCount(count() + 1)}
        >
          <Text class="text-base text-white font-bold">
            {isKindle ? "Tap to increment" : "Press Circle"}
          </Text>
        </View>
        <Text class="text-sm text-slate-600">Count: {count()}</Text>
        <Show when={count() > 3}>
          <Text
            class={isKindle
              ? "text-sm text-slate-950 font-bold"
              : "text-sm text-emerald-600"}
          >
            {isKindle ? "Reactive on e-ink hardware." : "Reactive on real hardware."}
          </Text>
        </Show>
      </View>
    </View>
  );
}
