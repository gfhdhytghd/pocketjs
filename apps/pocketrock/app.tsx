import { For, Show, createMemo, createSignal } from "solid-js";
import { animate, jump } from "@pocketjs/framework/animation";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { appTable, launchNativePlugin, launchPackage } from "@pocketjs/framework/launcher";
import { onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";
import {
  library,
  playback,
  queue,
  system,
  type LibraryKind,
  type PlaybackSnapshot,
} from "@pocketjs/framework/rockbox";

type Page = "Home" | "Now Playing" | "Music" | "Queue" | "Files" |
  "Pocket Apps" | "Rockbox Apps" | "Settings" | "Library";

interface Row {
  title: string;
  subtitle?: string;
  action?: () => void;
}

const HOME: readonly Page[] = [
  "Now Playing", "Music", "Queue", "Files", "Pocket Apps", "Rockbox Apps", "Settings",
];
const MUSIC: readonly LibraryKind[] = ["artists", "albums", "tracks", "playlists"];
const SETTINGS = [
  "Sound", "Playback", "Display", "Power", "Storage", "System Information",
];
const ROW_H = 30;
const LIST_TOP = 36;
const VISIBLE_ROWS = 6;
const WHEEL_IDLE = 6;

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function TopBar(props: { title: string; back: boolean }) {
  return (
    <View class="absolute left-0 top-0 w-[320] h-[36] flex-row items-center justify-center bg-gradient-to-b from-[#b9c5d7] via-[#8394ad] to-[#63758f] border-b border-[#3d4e66]">
      <Show when={props.back}>
        <Text class="absolute left-[8] top-[10] text-xs text-white font-bold">MENU</Text>
      </Show>
      <Text class="text-base text-white font-bold">{props.title}</Text>
      <Text class="absolute right-[8] top-[10] text-xs text-[#e7edf5]">PocketRock</Text>
    </View>
  );
}

function Shell() {
  const [stack, setStack] = createSignal<Page[]>(["Home"]);
  const [selected, setSelected] = createSignal(0);
  const [libraryKind, setLibraryKind] = createSignal<LibraryKind>("artists");
  const [libraryRows, setLibraryRows] = createSignal<Row[]>([]);
  const [notice, setNotice] = createSignal("");
  let pageNode: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelIdle = WHEEL_IDLE;
  let pendingPopFrames = 0;

  const page = createMemo(() => stack()[stack().length - 1]);
  const serviceActive = () => typeof getOps().pocketrockCall === "function";

  const safePlayback = (): PlaybackSnapshot | null => {
    if (!serviceActive()) return null;
    try { return playback.snapshot(); } catch { return null; }
  };

  const rows = createMemo<Row[]>(() => {
    switch (page()) {
    case "Home": return HOME.map((title) => ({ title, action: () => push(title) }));
    case "Music": return MUSIC.map((kind) => ({
      title: titleCase(kind),
      action: () => openLibrary(kind),
    }));
    case "Library": return libraryRows();
    case "Queue": {
      if (!serviceActive()) return [{ title: "Queue unavailable", subtitle: "Host ABI 10 required" }];
      try {
        return queue.page(0, 64).items.map((item) => ({
          title: item.title || item.path,
          subtitle: item.artist,
          action: () => queue.play(item.index),
        }));
      } catch (error) { return [{ title: "Queue unavailable", subtitle: String(error) }]; }
    }
    case "Pocket Apps": return (appTable()?.apps ?? [])
      .filter((app) => !app.kind || app.kind === "pocket")
      .map((app) => ({ title: app.title, subtitle: app.id, action: () => launchPackage(app.id) }));
    case "Rockbox Apps": return (appTable()?.apps ?? [])
      .filter((app) => app.kind === "rockbox" && app.path)
      .map((app) => ({
        title: app.title,
        subtitle: app.path,
        action: () => launchNativePlugin(app.path!),
      }));
    case "Settings": return SETTINGS.map((title) => ({ title, subtitle: settingValue(title) }));
    case "Files": return [{ title: "/", subtitle: "Full-volume browser" }, { title: ".rockbox" }, { title: "Music" }];
    default: return [];
    }
  });

  function settingValue(name: string): string | undefined {
    if (!serviceActive()) return undefined;
    try {
      const snapshot = system.snapshot();
      if (name === "Power") return `${snapshot.batteryPercent}%`;
      if (name === "Storage") return `${Math.floor(snapshot.freeBytes / 1048576)} MiB free`;
      if (name === "Display") return snapshot.backlight ? "Backlight on" : "Backlight off";
    } catch { /* keep the settings page usable during USB transitions */ }
    return undefined;
  }

  function animateIn(): void {
    if (!pageNode) return;
    jump(pageNode, "translateX", 320);
    animate(pageNode, "translateX", 0, { dur: 95, easing: "out" });
  }

  function push(next: Page): void {
    setSelected(0);
    setStack((value) => [...value, next]);
    queueMicrotask(animateIn);
  }

  function pop(): void {
    if (stack().length <= 1 || pendingPopFrames > 0) return;
    if (pageNode) animate(pageNode, "translateX", 320, { dur: 90, easing: "out" });
    pendingPopFrames = 6;
  }

  function openLibrary(kind: LibraryKind): void {
    setLibraryKind(kind);
    if (!serviceActive()) {
      setLibraryRows([{ title: "Library unavailable", subtitle: "Tagcache service is offline" }]);
    } else {
      try {
        const result = library.page(kind, 0, 64);
        setLibraryRows(result.items.map((item) => ({ title: item.title, subtitle: item.subtitle })));
        if (result.scanning) setNotice("Tagcache scanning");
      } catch (error) {
        setLibraryRows([{ title: "Library unavailable", subtitle: String(error) }]);
      }
    }
    push("Library");
  }

  function wheelMove(direction: -1 | 1): void {
    if (wheelDirection !== direction || wheelIdle >= WHEEL_IDLE) {
      wheelDirection = direction;
      wheelBurst = 0;
    } else wheelBurst = Math.min(10, wheelBurst + 1);
    wheelIdle = 0;
    const multiplier = 1 << wheelBurst;
    const max = Math.max(0, rows().length - 1);
    setSelected((value) => Math.max(0, Math.min(max, value + direction * multiplier)));
  }

  onFrame((buttons) => {
    if (pendingPopFrames > 0 && --pendingPopFrames === 0) {
      setStack((value) => value.slice(0, -1));
      setSelected(0);
      if (pageNode) jump(pageNode, "translateX", 0);
      return;
    }
    if ((buttons & BTN.UP) !== 0) wheelMove(-1);
    else if ((buttons & BTN.DOWN) !== 0) wheelMove(1);
    else {
      wheelIdle = Math.min(WHEEL_IDLE, wheelIdle + 1);
      if (wheelIdle === WHEEL_IDLE) { wheelDirection = 0; wheelBurst = 0; }
    }
  });
  onButtonPress(BTN.CIRCLE, () => rows()[selected()]?.action?.(), { latched: true });
  onButtonPress(BTN.TRIANGLE, pop, { latched: true });
  onButtonPress(BTN.START, () => { if (serviceActive()) playback.toggle(); }, { latched: true });
  onButtonPress(BTN.LEFT, () => { if (serviceActive()) playback.previous(); }, { latched: true });
  onButtonPress(BTN.RIGHT, () => { if (serviceActive()) playback.next(); }, { latched: true });

  const first = createMemo(() => Math.max(0, selected() - (VISIBLE_ROWS - 1)));
  const visible = createMemo(() => rows().slice(first(), first() + VISIBLE_ROWS));
  const now = createMemo(safePlayback);

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View ref={(node) => (pageNode = node)} class="absolute left-0 top-0 w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
        <Show when={page() === "Now Playing"} fallback={
          <View class="absolute left-0 top-[36] w-[320] h-[204] overflow-hidden">
            <View class="absolute left-0 top-0 w-[320] h-[30] bg-[#247bd5]" style={{ translateY: (selected() - first()) * ROW_H }} />
            <View class="absolute left-0 top-0 w-[320] flex-col">
              <For each={visible()}>{(row, index) =>
                <View class="relative w-[320] h-[30] flex-col justify-center pl-[12] pr-[9]">
                  <Text class="text-sm text-[#18202a] font-bold">{row.title}</Text>
                  <Show when={row.subtitle}><Text class="absolute right-[9] top-[9] text-xs text-[#687484]">{row.subtitle}</Text></Show>
                  <Show when={index() !== selected() - first() && index() + 1 !== selected() - first() && index() + first() + 1 < rows().length}>
                    <View class="absolute left-[12] right-0 bottom-0 h-[1] bg-[#d5d9df]" />
                  </Show>
                </View>
              }</For>
            </View>
          </View>
        }>
          <View class="absolute left-0 top-[36] w-[320] h-[204] flex-col items-center pt-[20] bg-[#18212e]">
            <View class="w-[112] h-[112] rounded-[8] bg-gradient-to-b from-[#3a4658] to-[#202938] border border-[#586579]" />
            <Text class="mt-[9] text-base text-white font-bold">{now()?.title ?? "Nothing Playing"}</Text>
            <Text class="text-xs text-[#aeb9c8]">{now()?.artist ?? "SELECT a track"}</Text>
          </View>
        </Show>
        <TopBar title={page() === "Library" ? titleCase(libraryKind()) : page()} back={stack().length > 1} />
        <Show when={notice()}><Text class="absolute left-[8] bottom-[5] text-xs text-[#697586]">{notice()}</Text></Show>
      </View>
    </View>
  );
}

mount(() => <Shell />);
