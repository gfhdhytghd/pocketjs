import { useLayoutEffect, useMemo, useRef, useState } from "octane";
import { Text, View, type NodeMirror } from "@pocketjs/framework/octane/components";
import { animate, jump } from "@pocketjs/framework/octane/animation";
import { useButtonPress, useFrame } from "@pocketjs/framework/octane/lifecycle";
import { BTN } from "@pocketjs/framework/octane/input";

const COUNT_FRAMES = 75;
const COUNT_TEXT_STEP = 8;
const BAR_ANIM_FRAMES = 26;
const BAR_STAGGER_FRAMES = 4;
const SYSTEMS_REVEAL_FRAMES = 12;
const SYSTEMS_STAGGER_FRAMES = 5;
const SYSTEMS_MAX_FRAMES = SYSTEMS_REVEAL_FRAMES + SYSTEMS_STAGGER_FRAMES * 3;

interface Stat {
  label: string;
  target: number;
  delta: string;
  valueCls: string;
}

const STATS: Stat[] = [
  { label: "PLAYERS ONLINE", target: 12480, delta: "+318", valueCls: "text-2xl text-blue-600 font-bold" },
  { label: "SESSIONS TODAY", target: 3642, delta: "+9%", valueCls: "text-2xl text-emerald-600 font-bold" },
  { label: "DRAW CALLS", target: 268, delta: "-12", valueCls: "text-2xl text-amber-600 font-bold" },
];

interface Bar {
  label: string;
  pct: number;
  fill: string;
}

const BAR_W = 280;
const BAR_ANIM_MS = Math.round((BAR_ANIM_FRAMES / 60) * 1000);
const BAR_STAGGER_MS = Math.round((BAR_STAGGER_FRAMES / 60) * 1000);
const BARS: Bar[] = [
  { label: "CPU", pct: 42, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-blue-500 to-blue-600" },
  { label: "GPU", pct: 71, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600" },
  { label: "RAM", pct: 63, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-amber-500 to-amber-600" },
  { label: "I/O", pct: 28, fill: "h-2 w-[280] rounded-full bg-gradient-to-r from-sky-500 to-sky-600" },
];

interface Sys {
  name: string;
  status: string;
  led: string;
  statusCls: string;
}

const SYSTEMS: Sys[] = [
  { name: "GE PIPELINE", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
  { name: "AUDIO MIXER", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
  { name: "MEMORY ARENA", status: "87% USED", led: "w-2 h-2 rounded-full bg-amber-500", statusCls: "text-xs text-amber-600" },
  { name: "WIFI LINK", status: "ONLINE", led: "w-2 h-2 rounded-full bg-emerald-500", statusCls: "text-xs text-emerald-600" },
];

function fmt(n: number): string {
  const s = String(n);
  return s.length > 3 ? s.slice(0, -3) + "," + s.slice(-3) : s;
}

function easeOutCubic(x: number): number {
  const t = Math.max(0, Math.min(1, x));
  return 1 - (1 - t) * (1 - t) * (1 - t);
}

function barScale(bar: Bar): number {
  return bar.pct / 100;
}

function barFillOffset(scale: number): number {
  return -(BAR_W * (1 - scale)) / 2;
}

const Overview = () => {
  // scaleX/translateX are native tweens — they must stay OUT of the fills'
  // `style` prop (re-applied styles cancel running animations). Initial
  // values are jumped once in the pre-paint mount effect, then animated.
  const fills = useRef<Array<NodeMirror | null>>([]);

  useLayoutEffect(() => {
    BARS.forEach((bar, i) => {
      const fill = fills.current[i];
      if (!fill) return;
      const scale = barScale(bar);
      const delay = i * BAR_STAGGER_MS;
      jump(fill, "scaleX", 0);
      jump(fill, "translateX", barFillOffset(0));
      animate(fill, "scaleX", scale, { dur: BAR_ANIM_MS, delay, easing: "out" });
      animate(fill, "translateX", barFillOffset(scale), { dur: BAR_ANIM_MS, delay, easing: "out" });
    });
  }, []);

  return (
    <View class="flex-col gap-1">
      {BARS.map((bar, i) => (
        <View key={bar.label} class="flex-row items-center gap-2">
          <View class="w-9 flex-row justify-end">
            <Text class="text-xs text-slate-600">{bar.label}</Text>
          </View>
          <View class="w-[280] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
            <View
              nodeRef={(node: NodeMirror | null) => {
                fills.current[i] = node;
              }}
              class={bar.fill}
            />
          </View>
          <Text class="text-xs text-slate-500">{bar.pct + "%"}</Text>
        </View>
      ))}
    </View>
  );
};

// Per-frame counters live in leaf components so each tick re-renders a small
// subtree, not the whole screen (the same pattern as the music port): the
// count-up phase would otherwise re-render every node for 75 frames and the
// engine-arena churn exhausts the PSP's fixed arena mid-window.

const StatTiles = () => {
  // The rendered value only ever changes on COUNT_TEXT_STEP boundaries, so
  // track the raw frame in a ref and commit state only when the stepped
  // value moves: ~10 re-renders for the whole count-up instead of 75, with
  // byte-identical output per frame index.
  const raw = useRef(0);
  const [visibleFrame, setVisibleFrame] = useState(0);
  useFrame(() => {
    if (raw.current >= COUNT_FRAMES) return;
    raw.current += 1;
    const stepped =
      raw.current >= COUNT_FRAMES
        ? COUNT_FRAMES
        : Math.floor(raw.current / COUNT_TEXT_STEP) * COUNT_TEXT_STEP;
    if (stepped !== visibleFrame) setVisibleFrame(stepped);
  });
  const t = easeOutCubic(Math.min(1, visibleFrame / COUNT_FRAMES));
  return (
    <View class="flex-row gap-3">
      {STATS.map((stat) => (
        <View key={stat.label} class="flex-1 flex-col gap-1 p-2 rounded-xl shadow-md bg-white border-slate-200">
          <Text class="text-xs text-slate-500 tracking-wide">{stat.label}</Text>
          <View class="flex-row items-end gap-1">
            <Text class={stat.valueCls}>{fmt(Math.round(stat.target * t))}</Text>
            <Text class="text-xs text-emerald-600">{stat.delta}</Text>
          </View>
        </View>
      ))}
    </View>
  );
};

const Systems = () => {
  const [frame, setFrame] = useState(0);
  useFrame(() => {
    if (frame < SYSTEMS_MAX_FRAMES) setFrame((f) => f + 1);
  });
  const rowT = (i: number) => easeOutCubic((frame - i * SYSTEMS_STAGGER_FRAMES) / SYSTEMS_REVEAL_FRAMES);
  return (
    <View class="flex-col gap-1">
      {SYSTEMS.map((sys, i) => (
        <View
          key={sys.name}
          class="flex-row items-center justify-between px-2 py-[2] rounded-lg shadow bg-white border-slate-200"
          style={{ opacity: rowT(i), translateY: (1 - rowT(i)) * 8 }}
        >
          <View class="flex-row items-center gap-2">
            <View class={sys.led} />
            <Text class="text-xs text-slate-700 tracking-wide">{sys.name}</Text>
          </View>
          <Text class={sys.statusCls}>{sys.status}</Text>
        </View>
      ))}
    </View>
  );
};

export default function Stats() {
  const [tab, setTab] = useState(0);
  // Bumped on every RIGHT press: <Systems> is keyed on it, so re-entering the
  // tab remounts the reveal from frame 0, matching the other variants.
  const [epoch, setEpoch] = useState(0);

  useButtonPress(BTN.RIGHT, () => {
    setTab(1);
    setEpoch((e) => e + 1);
  });
  useButtonPress(BTN.LEFT, () => {
    setTab(0);
  });

  return (
    <View class="flex-col w-full h-full p-4 gap-3 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-emerald-600 tracking-wide">LIVE TELEMETRY</Text>
          <Text class="text-2xl text-slate-950 font-bold">Mission Control</Text>
        </View>
        <View class="flex-row gap-2">
          <View class={tab === 0 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab === 0 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>OVERVIEW</Text>
          </View>
          <View class={tab === 1 ? "px-2 py-1 rounded-lg shadow-md bg-blue-600 border-blue-500 transition-colors duration-150" : "px-2 py-1 rounded-lg shadow bg-white border-slate-200 transition-colors duration-150"}>
            <Text class={tab === 1 ? "text-xs text-white font-bold tracking-wide" : "text-xs text-slate-500 tracking-wide"}>SYSTEMS</Text>
          </View>
        </View>
      </View>

      <StatTiles />

      <View class="grow flex-col">
        {tab === 0 ? <Overview /> : null}
        {tab === 1 ? <Systems key={epoch} /> : null}
      </View>

      <Text class="text-xs text-slate-500">LEFT / RIGHT switch tab</Text>
    </View>
  );
}
