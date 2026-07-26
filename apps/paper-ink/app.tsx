import { For, createSignal } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { touches } from "@pocketjs/framework/input";

interface InkPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly shade: string;
  readonly size: number;
}

const TRAIL_SHADES = ["#161616", "#303030", "#505050", "#747474", "#9a9a9a", "#bcbcbc"];
const TRAIL_SIZES = [14, 12, 10, 8, 7, 6];

export default function PaperInk() {
  const [points, setPoints] = createSignal<readonly InkPoint[]>([]);
  const [samples, setSamples] = createSignal(0);
  let nextId = 1;
  let previous = "";

  onFrame(() => {
    const contact = touches()[0];
    if (!contact) {
      previous = "";
      return;
    }
    const key = `${contact.x}:${contact.y}`;
    if (key === previous) return;
    previous = key;
    setSamples((value) => value + 1);
    setPoints((current) => {
      const head = {
        id: nextId++,
        x: contact.x,
        y: contact.y,
        shade: TRAIL_SHADES[0],
        size: TRAIL_SIZES[0],
      };
      return [head, ...current.slice(0, TRAIL_SHADES.length - 1)].map((point, index) => ({
        ...point,
        shade: TRAIL_SHADES[index],
        size: TRAIL_SIZES[index],
      }));
    });
  });

  return (
    <View
      debugName="PaperInkLab"
      class="relative w-full h-full overflow-hidden"
      style={{ bgColor: "#f4f1e8" }}
    >
      <View class="absolute left-[18] top-[18] right-[18] flex-col gap-1">
        <Text class="text-xl font-bold" style={{ textColor: "#161616" }}>
          PAPER / INK
        </Text>
        <Text class="text-xs tracking-wide" style={{ textColor: "#66625b" }}>
          TOUCH TO DRAW A PARTIAL-REFRESH TRACE
        </Text>
        <View class="mt-2 w-full h-[1]" style={{ bgColor: "#b8b2a7" }} />
      </View>

      <For each={[112, 152, 192, 232, 272, 312, 352]}>
        {(top) => (
          <View
            class="absolute left-[18] right-[18] h-[1]"
            style={{ insetT: top, bgColor: "#d8d2c7" }}
          />
        )}
      </For>

      <For each={points()}>
        {(point) => (
          <View
            debugName="InkPoint"
            class="absolute"
            style={{
              insetL: point.x - point.size / 2,
              insetT: point.y - point.size / 2,
              width: point.size,
              height: point.size,
              borderRadius: point.size / 2,
              bgColor: point.shade,
            }}
          />
        )}
      </For>

      <View
        class="absolute left-[18] right-[18] bottom-[18] flex-row justify-between items-center px-3 py-2 border-[1]"
        style={{ bgColor: "#ebe7dd", borderColor: "#b8b2a7" }}
      >
        <Text class="text-xs font-bold" style={{ textColor: "#2c2a27" }}>
          AUTO PARTIAL
        </Text>
        <Text class="text-xs" style={{ textColor: "#66625b" }}>
          SAMPLES {samples()}
        </Text>
      </View>
    </View>
  );
}
