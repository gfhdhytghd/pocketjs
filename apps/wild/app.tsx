// apps/wild/app.tsx — "Wild": a BotW-style playable meadow on the wild
// kernel + the scene3d surface.
//
// The pure world lives in wild/ (kernel) + game.ts (content and controls);
// this component wires it to the runtime: createGameLoop steps the kernel at
// a fixed 1/60 s on the virtual clock, the render callback flushes the
// Scene3D, and the HUD composes as flex children over the <Viewport3D>.
// One field per signal, refreshed on the virtual 0.1 s grid (the rally
// pattern — measured on PSP hardware, object-signal HUDs are the expensive
// way).
//
// No bgColor anywhere over the viewport: the 3D scene composites UNDER the
// ui layer.

import { batch, createSignal, Show } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { createGameLoop } from "./lib/loop.ts";
import { Viewport3D } from "./lib/scene3d/viewport.ts";
import { WildGame } from "./game.ts";

const INK = "#f2f6ee";
const DIM = "#c8d4c2";
const GOLD = "#f4cf5e";

export default function Wild() {
  const game = new WildGame();

  const [prompt, setPrompt] = createSignal("");
  const [held, setHeld] = createSignal("");
  const [ticker, setTicker] = createSignal("");

  let stepCount = 0;
  createGameLoop({
    step: (dt, input) => {
      game.step(dt, input);
      stepCount += 1;
    },
    render: () => {
      game.render(1 / 60);
      if (stepCount % 6 === 0) {
        const s = game.hudState();
        batch(() => {
          setPrompt(s.prompt);
          setHeld(s.held);
          setTicker(s.ticker);
        });
      }
    },
  });

  return (
    <Viewport3D scene={game.scene} class="w-full h-full">
      <View class="w-full h-full flex-col justify-between px-3 py-2">
        <View class="flex-row items-start justify-between">
          <View class="flex-col">
            <Text class="text-sm font-bold tracking-wide" style={{ textColor: INK }}>
              WILD
            </Text>
            <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
              A POCKET PLAYABLE WORLD
            </Text>
          </View>
          <Show when={held() !== ""}>
            <Text class="text-xs font-bold tracking-wide" style={{ textColor: GOLD }}>
              {held()}
            </Text>
          </Show>
        </View>

        <View class="flex-col gap-1">
          <Show when={ticker() !== ""}>
            <Text class="text-sm font-bold tracking-wide" style={{ textColor: GOLD }}>
              {ticker()}
            </Text>
          </Show>
          <Text class="text-xs tracking-wide" style={{ textColor: INK }}>
            {prompt()}
          </Text>
          <Text class="text-xs tracking-wide" style={{ textColor: DIM }}>
            MOVE NUB - L/R CAMERA - [] SWING - X GRAB - /\ FLINT
          </Text>
        </View>
      </View>
    </Viewport3D>
  );
}
