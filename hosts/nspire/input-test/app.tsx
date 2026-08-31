import { createSignal, For } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import {
  analogRaw,
  onFrame,
} from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";

interface ButtonProbe {
  label: string;
  mask: number;
}

const BUTTONS: readonly ButtonProbe[] = [
  { label: "UP", mask: BTN.UP },
  { label: "RIGHT", mask: BTN.RIGHT },
  { label: "DOWN", mask: BTN.DOWN },
  { label: "LEFT", mask: BTN.LEFT },
  { label: "CIRCLE", mask: BTN.CIRCLE },
  { label: "CROSS", mask: BTN.CROSS },
  { label: "SQUARE", mask: BTN.SQUARE },
  { label: "TRIANGLE", mask: BTN.TRIANGLE },
  { label: "START", mask: BTN.START },
  { label: "SELECT", mask: BTN.SELECT },
] as const;

interface ProbeState {
  buttons: number;
  presses: readonly number[];
  releases: readonly number[];
  rawX: number;
  rawY: number;
  frame: number;
}

function hex16(value: number): string {
  return ("0000" + value.toString(16).toUpperCase()).slice(-4);
}

export default function InputTest() {
  const [state, setState] = createSignal<ProbeState>({
    buttons: 0,
    presses: BUTTONS.map(() => 0),
    releases: BUTTONS.map(() => 0),
    rawX: 128,
    rawY: 128,
    frame: 0,
  });
  let previousButtons = 0;
  let frame = 0;
  const presses = BUTTONS.map(() => 0);
  const releases = BUTTONS.map(() => 0);

  onFrame((buttons) => {
    frame += 1;
    const pressed = buttons & ~previousButtons;
    const released = previousButtons & ~buttons;
    let edge = false;
    BUTTONS.forEach((button, index) => {
      if (pressed & button.mask) {
        presses[index] += 1;
        edge = true;
      }
      if (released & button.mask) {
        releases[index] += 1;
        edge = true;
      }
    });
    previousButtons = buttons;
    if (!edge && (frame & 1) !== 0) return;
    const analog = analogRaw();
    setState({
      buttons,
      presses: [...presses],
      releases: [...releases],
      rawX: (analog >> 8) & 0xff,
      rawY: analog & 0xff,
      frame,
    });
  });

  const dotX = () => Math.round((state().rawX / 255) * 116);
  const dotY = () => Math.round((state().rawY / 255) * 90);

  return (
    <View class="w-[320] h-[240] bg-slate-950 p-2 flex-col gap-2 overflow-hidden">
      <View class="flex-row items-center justify-between">
        <Text class="text-sm font-bold text-white">CX II INPUT TEST</Text>
        <Text class="text-xs text-slate-400">FRAME {state().frame}</Text>
      </View>

      <View class="flex-row gap-2">
        <View class="w-[164] flex-col gap-1">
          <Text class="text-xs text-slate-400">
            BUTTON MASK 0x{hex16(state().buttons)}
          </Text>
          <View class="flex-row flex-wrap gap-1">
            <For each={BUTTONS}>
              {(button, index) => {
                const active = () => (state().buttons & button.mask) !== 0;
                return (
                  <View
                    class={active()
                      ? "w-[78] h-[31] px-1 py-[2] rounded bg-emerald-600 border-emerald-300"
                      : "w-[78] h-[31] px-1 py-[2] rounded bg-slate-800 border-slate-600"}
                  >
                    <Text class="text-xs font-bold text-white">{button.label}</Text>
                    <Text class="text-xs text-slate-300">
                      P{state().presses[index()]} R{state().releases[index()]}
                    </Text>
                  </View>
                );
              }}
            </For>
          </View>
        </View>

        <View class="w-[132] flex-col gap-1">
          <Text class="text-xs text-slate-400">ANALOG RAW</Text>
          <Text class="text-sm font-bold text-white">
            X {state().rawX}  Y {state().rawY}
          </Text>
          <View class="relative w-[124] h-[98] rounded bg-slate-900 border-slate-600 overflow-hidden">
            <View class="absolute w-[124] h-[1] bg-slate-700" style={{ translateY: 48 }} />
            <View class="absolute w-[1] h-[98] bg-slate-700" style={{ translateX: 61 }} />
            <View
              class="absolute w-2 h-2 rounded-full bg-amber-400"
              style={{ translateX: dotX(), translateY: dotY() }}
            />
          </View>
          <Text class="text-xs text-slate-400">LIFT = 128 / 128</Text>
          <Text class="text-xs text-slate-400">EXIT = CTRL + ESC</Text>
        </View>
      </View>
    </View>
  );
}
