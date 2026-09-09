import { For, Show, createMemo } from "solid-js";
import { Image, Text, View } from "@pocketjs/framework/components";
import { contactSelectionY } from "../../../framework/src/ipod-list-motion.ts";

export const SHELL_WIDTH = 320;
export const SHELL_HEIGHT = 240;
export const SHELL_BAR_HEIGHT = 36;
export const SHELL_BODY_HEIGHT = 204;
export const SHELL_ROW_HEIGHT = 30;

const SHELL_WINDOW_ROWS = Math.ceil(SHELL_BODY_HEIGHT / SHELL_ROW_HEIGHT) + 2;
const SHELL_SLOTS = Object.freeze(
  Array.from({ length: SHELL_WINDOW_ROWS }, (_, index) => index),
);

export interface ShellRow {
  title: string;
  value?: string;
  /** Shell routes use `subtitle`; accepting it directly avoids a per-render map. */
  subtitle?: string;
  glyph?: string;
  danger?: boolean;
}

export interface ShellListScreenProps {
  title: string;
  back?: boolean;
  rows: readonly ShellRow[];
  selected: number;
  offset: number;
  emptyTitle?: string;
  emptyDetail?: string;
  hideEmpty?: boolean;
}

/**
 * PocketRock's only system chrome.  The light metal strip deliberately echoes
 * the iPod body without copying Rockbox's themed status bar.  It is one fixed
 * 320px layer, so long page titles can never push the content viewport aside.
 */
export function ShellChrome(props: { title: string; back?: boolean }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] bg-gradient-to-b from-[#f6f8fa] via-[#dce2e8] to-[#b9c3cd]">
      <Show when={props.back}>
        <View class="absolute left-[8] top-0 w-[64] h-[35] flex-row items-center">
          <Text class="text-sm text-[#176fce] font-bold">‹ MENU</Text>
        </View>
      </Show>
      <Text
        class={props.back
          ? "absolute left-[74] top-[8] w-[238] h-[20] text-base text-[#17212b] font-bold text-center overflow-hidden"
          : "absolute left-[12] top-[8] w-[296] h-[20] text-base text-[#17212b] font-bold text-center overflow-hidden"}
      >
        {props.title}
      </Text>
      <View class="absolute left-0 right-0 top-0 h-[1] bg-white" />
      <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#7d8996]" />
    </View>
  );
}

function EmptyList(props: { title: string; detail?: string }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[204] flex-col items-center justify-center bg-[#f4f6f8]">
      <View class="w-[38] h-[4] rounded-[2] bg-[#176fce]" />
      <Text class="mt-[10] w-[280] text-base text-[#17212b] font-bold text-center">{props.title}</Text>
      <Show when={props.detail}>
        <Text class="mt-[4] w-[280] text-xs text-[#687584] text-center">{props.detail}</Text>
      </Show>
    </View>
  );
}

/**
 * The list has three paint layers, in the same order as the contacts demo:
 * separators, the independent blue focus sheet, and finally the text.  Only a
 * nine-row window exists even for a 10,000 item library.
 */
export function ShellList(props: {
  rows: readonly ShellRow[];
  selected: number;
  offset: number;
}) {
  const first = createMemo(() => Math.max(
    0,
    Math.min(
      Math.max(0, props.rows.length - SHELL_WINDOW_ROWS),
      Math.floor(Math.max(0, props.offset) / SHELL_ROW_HEIGHT) - 1,
    ),
  ));
  const translateY = createMemo(() => first() * SHELL_ROW_HEIGHT - Math.max(0, props.offset));
  const selectionY = createMemo(() => contactSelectionY(props.selected, Math.max(0, props.offset)));

  return (
    <View class="relative w-[320] h-[204] bg-[#f4f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
        <For each={SHELL_SLOTS}>{(slot) => {
          const index = () => first() + slot;
          const row = () => props.rows[index()];
          const showDivider = () =>
            row() !== undefined &&
            index() + 1 < props.rows.length &&
            index() !== props.selected &&
            index() + 1 !== props.selected;
          return (
            <View class="relative w-[320] h-[30]">
              <Show when={showDivider()}>
                <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d7dde4]" />
              </Show>
            </View>
          );
        }}</For>
      </View>

      <Show when={props.rows.length > 0}>
        <View
          class="absolute left-0 top-0 w-[320] h-[30] bg-[#176fce]"
          style={{ translateY: selectionY() }}
        >
          <View class="absolute left-0 top-0 w-[4] h-[30] bg-[#0d57a6]" />
        </View>
      </Show>

      <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
        <For each={SHELL_SLOTS}>{(slot) => {
          const index = () => first() + slot;
          const row = () => props.rows[index()];
          const selected = () => index() === props.selected;
          return (
            <View class="relative w-[320] h-[30] overflow-hidden">
              <Show when={row()}>{(visibleRow) => <>
              <Show when={visibleRow().glyph}>
                <View
                  class={selected()
                    ? "absolute left-[8] top-[6] w-[18] h-[18] rounded-[4] flex-row items-center justify-center bg-[#0d57a6]"
                    : "absolute left-[8] top-[6] w-[18] h-[18] rounded-[4] flex-row items-center justify-center bg-[#e1e6ec]"}
                >
                  <Text class={selected()
                    ? "text-xs text-white font-bold"
                    : "text-xs text-[#526274] font-bold"}>
                    {visibleRow().glyph}
                  </Text>
                </View>
              </Show>
              <Text
                class={visibleRow().glyph
                  ? selected()
                    ? "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-white font-bold overflow-hidden"
                    : visibleRow().danger
                      ? "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-[#a63c38] font-bold overflow-hidden"
                      : "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-[#17212b] font-bold overflow-hidden"
                  : selected()
                    ? "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-white font-bold overflow-hidden"
                    : visibleRow().danger
                      ? "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-[#a63c38] font-bold overflow-hidden"
                      : "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-[#17212b] font-bold overflow-hidden"}
              >
                {visibleRow().title}
              </Text>
              <Show when={visibleRow().value ?? visibleRow().subtitle}>
                <Text
                  class={selected()
                    ? "absolute right-[10] top-[8] w-[96] h-[16] text-xs text-[#e7f2ff] font-bold text-right overflow-hidden"
                    : "absolute right-[10] top-[8] w-[96] h-[16] text-xs text-[#687584] font-bold text-right overflow-hidden"}
                >
                  {visibleRow().value ?? visibleRow().subtitle}
                </Text>
              </Show>
              </>}</Show>
            </View>
          );
        }}</For>
      </View>
    </View>
  );
}

export function ShellListScreen(props: ShellListScreenProps) {
  return (
    <View class="relative w-[320] h-[240] bg-[#f4f6f8] overflow-hidden">
      <View class="absolute left-0 top-[36] w-[320] h-[204] overflow-hidden">
        <Show when={props.rows.length > 0} fallback={
          <Show when={!props.hideEmpty}>
            <EmptyList
              title={props.emptyTitle ?? "这里没有内容"}
              detail={props.emptyDetail}
            />
          </Show>
        }>
          <ShellList rows={props.rows} selected={props.selected} offset={props.offset} />
        </Show>
      </View>
      <ShellChrome title={props.title} back={props.back} />
    </View>
  );
}

function formatTime(value: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export interface NowPlayingScreenProps {
  title: string;
  artist: string;
  album?: string;
  elapsedSeconds: number;
  durationSeconds: number;
  playing: boolean;
  back?: boolean;
  shuffle?: boolean;
  /** Repeat mode from the host: "off" | "all" | "one" | "shuffle" (raw "0".."3" tolerated). */
  repeat?: string;
  /** 0-based position of the current track within its sequence. */
  trackIndex?: number;
  /** Total number of tracks in the current sequence. */
  trackTotal?: number;
  /** Battery level 0..100 for the top-right indicator. */
  battery?: number;
  charging?: boolean;
  /** Transient volume popup value, shown for a moment after wheel input. */
  volumeFlash?: number | null;
  /** Optional cover-art asset; a vinyl placeholder renders when absent. */
  artwork?: string;
}

const NP_TRACK_LIMIT = 24;
const NP_META_LIMIT = 26;
const NP_BAR_X = 56;
const NP_BAR_W = 198;
const NP_VOLUME_BAR_W = 112;

/** CJK codepoints count as two width units, Latin as one, for overflow-safe clipping. */
function npUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
  return units;
}

function npClip(value: string | undefined, fallback: string, limit: number): string {
  const text = value?.trim() || fallback;
  if (npUnits(text) <= limit) return text;
  let out = "";
  let units = 0;
  for (const ch of text) {
    const width = (ch.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1;
    if (units + width > limit - 1) break;
    out += ch;
    units += width;
  }
  return `${out}…`;
}

function npRemaining(elapsedSeconds: number, durationSeconds: number): string {
  return `-${formatTime(Math.max(0, durationSeconds - elapsedSeconds))}`;
}

function npRepeatActive(repeat: string | undefined): boolean {
  const value = (repeat ?? "").trim().toLowerCase();
  return value === "all" || value === "one" || value === "shuffle" || value === "1" || value === "2" || value === "3";
}

/** Apple-style battery readout pinned to the top-right of the status strip. */
function Battery(props: { level?: number; charging?: boolean }) {
  const level = Number.isFinite(props.level) ? Math.max(0, Math.min(100, Math.round(props.level!))) : 100;
  const fill = Math.max(1, Math.round((11 * level) / 100));
  return (
    <View class="flex-row items-center">
      <View class="relative w-[13] h-[7] rounded-[2] border border-[#4a5568] bg-[#eef1f4]">
        <View class="absolute left-[1] top-[1] h-[5] rounded-[1] bg-[#43a047]" style={{ width: fill, bgColor: props.charging ? "#7ed957" : "#43a047" }} />
      </View>
      <View class="ml-[1] w-[2] h-[3] rounded-[1] bg-[#4a5568]" />
    </View>
  );
}

/** Vinyl placeholder shown when no cover art is available. */
function VinylPlaceholder() {
  return (
    <>
      <View class="absolute left-[16] top-[16] w-[64] h-[64] rounded-full bg-[#1b2634] border border-[#3a4a5c]" />
      <View class="absolute left-[26] top-[26] w-[44] h-[44] rounded-full border border-[#33445a]" />
      <View class="absolute left-[34] top-[34] w-[28] h-[28] rounded-full border border-[#2c3a49]" />
      <View class="absolute left-[38] top-[38] w-[20] h-[20] rounded-full bg-[#2f8fdd]" />
      <View class="absolute left-[44] top-[44] w-[8] h-[8] rounded-full bg-[#0f1720]" />
    </>
  );
}

/**
 * Now-playing surface modelled on the stock iPod Classic screen: a thin silver
 * menu strip (title left, play state and battery right), shuffle/repeat
 * glyphs top-right, cover art on the left, left-aligned metadata, and a
 * bottom scrubber with a diamond handle plus elapsed/remaining times.
 * Back stays on the physical MENU button, so no on-screen back pill is drawn.
 */
export function NowPlayingScreen(props: NowPlayingScreenProps) {
  const duration = () => (Number.isFinite(props.durationSeconds) ? Math.max(0, props.durationSeconds) : 0);
  const position = () => Math.min(duration(), Math.max(0, Number.isFinite(props.elapsedSeconds) ? props.elapsedSeconds! : 0));
  const fillWidth = createMemo(() => Math.round(NP_BAR_W * (duration() > 0 ? position() / duration() : 0)));
  const handleX = createMemo(() => Math.max(NP_BAR_X, Math.min(NP_BAR_X + NP_BAR_W - 3, NP_BAR_X + fillWidth() - 3)));
  const repeatOn = createMemo(() => npRepeatActive(props.repeat));
  const sequence = createMemo(() => {
    const index = props.trackIndex;
    if (index === undefined || index < 0) return "";
    return props.trackTotal !== undefined && props.trackTotal > 1
      ? `${index + 1} / ${props.trackTotal}`
      : `${index + 1}`;
  });
  const volumeFlashValue = (): number | null => {
    const value = props.volumeFlash;
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    return Math.max(0, Math.min(100, Math.round(value)));
  };
  const volumeFlashWidth = createMemo(() =>
    volumeFlashValue() === null ? 0 : Math.round(NP_VOLUME_BAR_W * volumeFlashValue()! / 100),
  );

  return (
    <View class="relative w-[320] h-[240] bg-white overflow-hidden">
      {/* Stock-style menu strip: title left, play state + battery right. */}
      <View class="absolute left-0 top-0 w-[320] h-[22] bg-gradient-to-b from-[#f7f8fa] via-[#dfe4e9] to-[#b6bfc9]">
        <Text class="absolute left-[8] top-[5] text-xs text-[#1f2733] font-bold">正在播放</Text>
        <Show when={props.playing} fallback={
          <Text class="absolute right-[34] top-[4] text-sm text-[#98a4b0] font-bold">‖</Text>
        }>
          <Text class="absolute right-[34] top-[4] text-sm text-[#2f8fdd] font-bold">▶</Text>
        </Show>
        <View class="absolute right-[8] top-[8]">
          <Battery level={props.battery} charging={props.charging} />
        </View>
        <View class="absolute left-0 right-0 bottom-0 h-[1] bg-[#6a7480]" />
      </View>

      <View class="absolute left-0 top-[23] w-[320] h-[217] bg-white overflow-hidden">
        {/* Shuffle / repeat indicators, top-right, only when active. */}
        <View class="absolute left-0 top-[10] w-[320] h-[14] flex-row items-center justify-end pr-[8]">
          <Show when={props.shuffle}>
            <Text class="text-sm text-[#2f8fdd] font-bold">↔</Text>
          </Show>
          <Show when={repeatOn()}>
            <Text class={props.shuffle ? "ml-[8] text-sm text-[#2f8fdd] font-bold" : "text-sm text-[#2f8fdd] font-bold"}>↻</Text>
          </Show>
        </View>

        {/* Cover art block with reflection fade. */}
        <View class="absolute left-[10] top-[12] w-[96] h-[96] rounded-[2] bg-gradient-to-b from-[#2b3a4d] via-[#202f3f] to-[#15202d] border border-[#8a95a3] overflow-hidden">
          <Show when={props.artwork} fallback={<VinylPlaceholder />}>
            <Image class="w-[96] h-[96]" src={props.artwork} />
          </Show>
        </View>
        <View class="absolute left-[10] top-[108] w-[96] h-[14] bg-gradient-to-b from-[#e3e7eb] to-transparent" />

        {/* Metadata column beside the art. */}
        <View class="absolute left-[116] top-[14] w-[196] h-[96] flex-col overflow-hidden">
          <Text class="w-[196] h-[18] text-base text-[#18202a] font-bold overflow-hidden">{npClip(props.title, "暂无播放", NP_TRACK_LIMIT)}</Text>
          <Text class="mt-[3] w-[196] h-[15] text-sm text-[#405166] overflow-hidden">{npClip(props.artist, "请选择一首歌曲", NP_META_LIMIT)}</Text>
          <Show when={props.album}>
            <Text class="mt-[2] w-[196] h-[14] text-xs text-[#687484] overflow-hidden">{npClip(props.album, "", NP_META_LIMIT)}</Text>
          </Show>
          <Show when={sequence() !== ""}>
            <Text class="mt-[3] w-[196] h-[13] text-xs text-[#8a95a3] overflow-hidden">{sequence()}</Text>
          </Show>
        </View>

        {/* Scrubber: elapsed left, diamond handle, -remaining right. */}
        <Text class="absolute left-[12] top-[177] w-[40] h-[13] text-xs text-[#405166] font-bold text-right overflow-hidden">{formatTime(position())}</Text>
        <View class="absolute left-[56] top-[179] w-[200] h-[6] rounded-[3] bg-[#dfe4ea] border border-[#b9c2cc] overflow-hidden">
          <View class="absolute left-0 top-0 h-[4] rounded-[2] bg-gradient-to-b from-[#7cc0f5] to-[#1d6fc2]" style={{ width: fillWidth() }} />
        </View>
        <View class="absolute w-[7] h-[7] bg-white border border-[#3f79b5] rotate-45" style={{ insetL: handleX(), insetT: 178 }} />
        <Text class="absolute right-[12] top-[177] w-[44] h-[13] text-xs text-[#405166] font-bold overflow-hidden">{npRemaining(position(), duration())}</Text>

        {/* Transient volume popup, mirroring the stock iPod wheel feedback. */}
        <Show when={volumeFlashValue() !== null}>
          <View class="absolute left-[56] top-[76] w-[208] h-[40] rounded-[6] bg-white border border-[#b9c3cf] shadow-md flex-row items-center px-[10] gap-[8]">
            <Text class="text-xs text-[#405166] font-bold">音量</Text>
            <View class="relative w-[112] h-[6] rounded-[3] bg-[#d5dce4] overflow-hidden">
              <View class="absolute left-0 top-0 h-[6] rounded-[3] bg-[#2f8fdd]" style={{ width: volumeFlashWidth() }} />
            </View>
            <Text class="w-[24] text-xs text-[#18202a] font-bold text-right">{volumeFlashValue()}</Text>
          </View>
        </Show>
      </View>
    </View>
  );
}

export interface UsbScreenProps {
  mode: "mass-storage" | "charging" | "idle";
}

/** USB owns the screen while connected and intentionally has no perpetual animation. */
export function UsbScreen(props: UsbScreenProps) {
  const connected = () => props.mode !== "idle";
  const modeLabel = () => props.mode === "mass-storage" ? "磁盘模式" : props.mode === "charging" ? "正在充电" : "未连接";
  return (
    <View class="relative w-[320] h-[240] bg-[#f4f6f8] overflow-hidden">
      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#f4f6f8] overflow-hidden">
        <View class="absolute left-[20] top-[24] w-[92] h-[116] rounded-[8] bg-[#e1e6ec] border border-[#b7c1cb]">
          <Image class="absolute left-[14] top-[26] w-[64] h-[64]" src="assets/icons/usb-64.png" />
        </View>
        <View class="absolute left-[128] top-[28] w-[172] h-[112] overflow-hidden">
          <Text class="absolute left-0 top-0 w-[172] h-[16] text-xs text-[#687584] font-bold">设备状态</Text>
          <Text class="absolute left-0 top-[22] w-[172] h-[24] text-lg text-[#17212b] font-bold overflow-hidden">{connected() ? "已连接" : "未连接"}</Text>
          <View class="absolute left-0 top-[54] w-[172] h-[1] bg-[#d1d8df]" />
          <Text class="absolute left-0 top-[66] w-[172] h-[16] text-xs text-[#687584]">连接模式</Text>
          <Text class="absolute left-0 top-[86] w-[172] h-[20] text-sm text-[#176fce] font-bold overflow-hidden">{modeLabel()}</Text>
        </View>
        <View class="absolute left-[20] bottom-[18] w-[280] h-[32] rounded-[5] flex-row items-center justify-center bg-[#e7edf3] border border-[#c0cad4]">
          <Text class="text-xs text-[#526274] font-bold">{props.mode === "mass-storage" ? "拔线前请先在电脑上安全弹出" : "充电时请保持线缆连接"}</Text>
        </View>
      </View>
      <ShellChrome title="USB 连接" />
    </View>
  );
}
