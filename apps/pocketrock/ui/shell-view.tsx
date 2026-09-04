import { For, Show, createMemo } from "solid-js";
import { Text, View } from "@pocketjs/framework/components";
import { contactSelectionY } from "../../../framework/src/ipod-list-motion.ts";

export const SHELL_WIDTH = 320;
export const SHELL_HEIGHT = 240;
export const SHELL_BAR_HEIGHT = 36;
export const SHELL_BODY_HEIGHT = 204;
export const SHELL_ROW_HEIGHT = 30;

const SHELL_WINDOW_ROWS = Math.ceil(SHELL_BODY_HEIGHT / SHELL_ROW_HEIGHT) + 2;

export interface ShellRow {
  title: string;
  value?: string;
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
  const visible = createMemo(() => props.rows.slice(first(), first() + SHELL_WINDOW_ROWS));
  const translateY = createMemo(() => first() * SHELL_ROW_HEIGHT - Math.max(0, props.offset));
  const selectionY = createMemo(() => contactSelectionY(props.selected, Math.max(0, props.offset)));

  return (
    <View class="relative w-[320] h-[204] bg-[#f4f6f8] overflow-hidden">
      <View class="absolute left-0 top-0 w-[320] flex-col" style={{ translateY: translateY() }}>
        <For each={visible()}>{(_, slot) => {
          const index = () => first() + slot();
          const showDivider = () =>
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
        <For each={visible()}>{(row, slot) => {
          const index = () => first() + slot();
          const selected = () => index() === props.selected;
          return (
            <View class="relative w-[320] h-[30] overflow-hidden">
              <Show when={row.glyph}>
                <View
                  class={selected()
                    ? "absolute left-[8] top-[6] w-[18] h-[18] rounded-[4] flex-row items-center justify-center bg-[#0d57a6]"
                    : "absolute left-[8] top-[6] w-[18] h-[18] rounded-[4] flex-row items-center justify-center bg-[#e1e6ec]"}
                >
                  <Text class={selected()
                    ? "text-xs text-white font-bold"
                    : "text-xs text-[#526274] font-bold"}>
                    {row.glyph}
                  </Text>
                </View>
              </Show>
              <Text
                class={row.glyph
                  ? selected()
                    ? "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-white font-bold overflow-hidden"
                    : row.danger
                      ? "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-[#a63c38] font-bold overflow-hidden"
                      : "absolute left-[34] top-[7] w-[180] h-[18] text-sm text-[#17212b] font-bold overflow-hidden"
                  : selected()
                    ? "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-white font-bold overflow-hidden"
                    : row.danger
                      ? "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-[#a63c38] font-bold overflow-hidden"
                      : "absolute left-[12] top-[7] w-[202] h-[18] text-sm text-[#17212b] font-bold overflow-hidden"}
              >
                {row.title}
              </Text>
              <Show when={row.value}>
                <Text
                  class={selected()
                    ? "absolute right-[10] top-[8] w-[96] h-[16] text-xs text-[#e7f2ff] font-bold text-right overflow-hidden"
                    : "absolute right-[10] top-[8] w-[96] h-[16] text-xs text-[#687584] font-bold text-right overflow-hidden"}
                >
                  {row.value}
                </Text>
              </Show>
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
          <EmptyList
            title={props.emptyTitle ?? "这里没有内容"}
            detail={props.emptyDetail}
          />
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
}

/** A low-node, cover-art-independent playback surface. */
export function NowPlayingScreen(props: NowPlayingScreenProps) {
  const progress = createMemo(() => props.durationSeconds > 0
    ? Math.max(0, Math.min(1, props.elapsedSeconds / props.durationSeconds))
    : 0);
  const progressWidth = createMemo(() => Math.round(progress() * 170));

  return (
    <View class="relative w-[320] h-[240] bg-[#101923] overflow-hidden">
      <View class="absolute left-0 top-[36] w-[320] h-[204] bg-[#101923] overflow-hidden">
        <View class="absolute left-[12] top-[15] w-[112] h-[112] rounded-[8] bg-gradient-to-b from-[#33465a] via-[#243548] to-[#172433] border border-[#53677b]">
          <View class="absolute left-[20] top-[20] w-[72] h-[72] rounded-full bg-[#17212b] border border-[#667789]">
            <View class="absolute left-[28] top-[28] w-[16] h-[16] rounded-full bg-[#176fce]" />
          </View>
          <Text class="absolute left-[8] bottom-[8] w-[96] text-xs text-[#c9d5e1] font-bold text-center overflow-hidden">POCKETROCK</Text>
        </View>

        <View class="absolute left-[138] top-[17] w-[170] h-[104] overflow-hidden">
          <Text class="w-[170] h-[44] text-lg text-white font-bold overflow-hidden">{props.title}</Text>
          <Text class="mt-[4] w-[170] h-[18] text-sm text-[#9ec9f1] font-bold overflow-hidden">{props.artist}</Text>
          <Show when={props.album}>
            <Text class="mt-[2] w-[170] h-[16] text-xs text-[#94a2b1] overflow-hidden">{props.album}</Text>
          </Show>
        </View>

        <View class="absolute left-[138] top-[132] w-[170] h-[5] rounded-[3] bg-[#354352] overflow-hidden">
          <View class="absolute left-0 top-0 h-[5] rounded-[3] bg-[#176fce]" style={{ width: progressWidth() }} />
        </View>
        <Text class="absolute left-[138] top-[143] w-[66] text-xs text-[#aab6c3]">{formatTime(props.elapsedSeconds)}</Text>
        <Text class="absolute right-[12] top-[143] w-[66] text-xs text-[#aab6c3] text-right">{formatTime(props.durationSeconds)}</Text>

        <View class="absolute left-[12] bottom-[13] w-[296] h-[31] rounded-[5] flex-row items-center justify-between px-[12] bg-[#1c2a39] border border-[#394a5b]">
          <Text class="text-sm text-[#9ec9f1] font-bold">‹‹</Text>
          <Text class="text-xs text-white font-bold">{props.playing ? "播放键：暂停" : "播放键：播放"}</Text>
          <Text class="text-sm text-[#9ec9f1] font-bold">››</Text>
        </View>
      </View>
      <ShellChrome title="正在播放" back={props.back} />
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
          <View class="absolute left-[44] top-[22] w-[4] h-[54] rounded-[2] bg-[#176fce]" />
          <View class="absolute left-[28] top-[52] w-[36] h-[4] rounded-[2] bg-[#176fce] rotate-45" />
          <View class="absolute left-[44] top-[52] w-[36] h-[4] rounded-[2] bg-[#176fce] rotate-45" />
          <View class="absolute left-[34] bottom-[18] w-[24] h-[24] rounded-[4] bg-[#17212b]" />
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
