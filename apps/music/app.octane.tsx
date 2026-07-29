import { useState } from "octane";
import { Text, View } from "@pocketjs/framework/octane/components";
import { useButtonPress, useFrame } from "@pocketjs/framework/octane/lifecycle";
import { BTN } from "@pocketjs/framework/octane/input";

interface Track {
  title: string;
  artist: string;
  coverCls: string;
}

const TRACKS: Track[] = [
  {
    title: "MIDNIGHT REPLAY",
    artist: "SYNC PULSE",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-blue-500 to-blue-700 border-blue-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "GLASS HORIZON",
    artist: "AMBER TIDE",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-amber-400 to-amber-700 border-amber-300 focus:border-slate-900 transition-colors duration-150",
  },
  {
    title: "STATIC BLOOM",
    artist: "NEON DRIFTERS",
    coverCls:
      "w-16 h-16 rounded-xl shadow-md items-center justify-center bg-gradient-to-b from-cyan-500 to-cyan-700 border-cyan-300 focus:border-slate-900 transition-colors duration-150",
  },
];

const TRACK_FRAMES = 300;
const PROGRESS_TRACK_W = 160;

// Per-frame state lives in leaf components so each tick re-renders a handful
// of nodes, not the whole screen. Octane re-renders allocate their garbage up
// front; keeping the always-animating state small keeps the PSP QuickJS
// arena's GC pressure proportional to the equalizer + progress line only.

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
        <View
          key={i}
          class="w-2 rounded-md shadow bg-gradient-to-b from-emerald-500 to-emerald-600"
          style={{ height: barHeight(i) }}
        />
      ))}
    </View>
  );
}

function ProgressLine(props: { playing: boolean; onTrackEnd: () => void; key?: number }) {
  const [position, setPosition] = useState(0);
  const pct = Math.round((position / TRACK_FRAMES) * 100);
  useFrame(() => {
    if (!props.playing) return;
    if (position + 1 >= TRACK_FRAMES) props.onTrackEnd();
    else setPosition((v) => v + 1);
  });
  return (
    <View class="flex-row items-center gap-2">
      <View class="w-[160] h-2 rounded-full shadow bg-slate-200 overflow-hidden">
        <View
          class="h-2 w-0 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600"
          style={{ width: (position / TRACK_FRAMES) * PROGRESS_TRACK_W }}
        />
      </View>
      <Text class="text-xs text-slate-500">{`${pct}%`}</Text>
    </View>
  );
}

export default function Music() {
  const [trackIndex, setTrackIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  // Bumped on every select/skip: ProgressLine is keyed on it, so its position
  // state remounts to 0 exactly where the other variants reset it — including
  // re-selecting the current track.
  const [session, setSession] = useState(0);
  const track = TRACKS[trackIndex];

  const selectTrack = (i: number) => {
    setTrackIndex(i);
    setSession((s) => s + 1);
    setPlaying(true);
  };
  const nextTrack = () => {
    setTrackIndex((i) => (i + 1) % TRACKS.length);
    setSession((s) => s + 1);
  };
  const prevTrack = () => {
    setTrackIndex((i) => (i - 1 + TRACKS.length) % TRACKS.length);
    setSession((s) => s + 1);
  };

  useButtonPress(BTN.LTRIGGER, prevTrack);
  useButtonPress(BTN.RTRIGGER, nextTrack);

  return (
    <View class="flex-col w-full h-full p-3 gap-2 bg-gradient-to-b from-slate-50 to-slate-100">
      <View class="flex-row items-end justify-between">
        <View class="flex-col">
          <Text class="text-xs text-blue-600 tracking-wide">POCKETJS SHOWCASE</Text>
          <Text class="text-2xl text-slate-950 font-bold">Now Playing</Text>
        </View>
        <Text class="text-xs text-slate-500">{`TRACK ${trackIndex + 1} / ${TRACKS.length}`}</Text>
      </View>

      <View class="flex-row items-center gap-3">
        <View class={track.coverCls} focusable onPress={() => setPlaying(!playing)}>
          <Text class="text-base text-white font-bold">{playing ? ">" : "II"}</Text>
        </View>

        <View class="flex-col grow gap-1">
          <Text class="text-base text-slate-950 font-bold">{track.title}</Text>
          <Text class="text-xs text-slate-600">{track.artist}</Text>
          <ProgressLine key={session} playing={playing} onTrackEnd={nextTrack} />
        </View>

        <Equalizer playing={playing} />
      </View>

      <View class="flex-col gap-1">
        {TRACKS.map((t, i) => (
          <View
            key={t.title}
            class={
              trackIndex === i
                ? "flex-row items-center justify-between p-1 rounded-lg shadow bg-blue-50 border-blue-500 focus:border-blue-600 transition-colors duration-150"
                : "flex-row items-center justify-between p-1 rounded-lg shadow bg-white border-slate-200 focus:border-blue-500 transition-colors duration-150"
            }
            focusable
            onPress={() => selectTrack(i)}
          >
            <Text class="text-xs text-slate-900">{t.title}</Text>
            <Text class="text-xs text-slate-500">{t.artist}</Text>
          </View>
        ))}
      </View>

      <Text class="text-xs text-slate-500">UP / DOWN focus - CIRCLE play/select - L/R skip track</Text>
    </View>
  );
}
