import { Show, createMemo, createSignal } from "solid-js";
import { animate, jump } from "@pocketjs/framework/animation";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { createScroller } from "@pocketjs/framework/kinetics";
import { appTable, launchNativePlugin, launchPackage } from "@pocketjs/framework/launcher";
import { onButtonPress, onFrame, wheelDelta } from "@pocketjs/framework/lifecycle";
import { mount } from "@pocketjs/framework/solid";
import {
  library,
  playback,
  queue,
  system,
  type LibraryKind,
  type PlaybackSnapshot,
  type SystemSnapshot,
} from "@pocketjs/framework/rockbox";
import {
  NowPlayingScreen,
  ShellListScreen,
  UsbScreen,
} from "./ui/shell-view.tsx";
import {
  CONTACT_LIST_HEIGHT,
  CONTACT_ROW_HEIGHT,
  CONTACT_SPRING_DAMPING,
  CONTACT_SPRING_OVERSHOOT,
  CONTACT_SPRING_STIFFNESS,
  contactScrollTarget,
  contactVisibleIndex,
  wheelMultiplier,
} from "../../framework/src/ipod-list-motion.ts";
import {
  POCKETROCK_TRANSITION_MS,
  transitionDeadline,
  transitionExpired,
} from "./transition-timing.ts";

type Page = "Home" | "Now Playing" | "Music" | "Queue" | "Files" |
  "Apps" | "Settings" | "Library" | "Sound" | "Equalizer" | "Playback" |
  "Display" | "Power" | "Storage" | "System Information";

interface Row {
  title: string;
  subtitle?: string;
  action?: () => void;
}

interface Route {
  page: Page;
  selected: number;
  offset: number;
  libraryKind?: LibraryKind;
  libraryRows?: Row[];
}

interface ScreenSnapshot {
  page: Page;
  title: string;
  rows: Row[];
  selected: number;
  offset: number;
  back: boolean;
  notice: string;
  playback: PlaybackSnapshot | null;
  system: SystemSnapshot | null;
  queueTotal: number;
  pending: boolean;
}

const MUSIC: readonly LibraryKind[] = ["artists", "albums", "tracks", "playlists"];
const POCKETROCK_HOME_DESTINATIONS = [
  "Now Playing", "Music", "Queue", "Files", "Apps", "Settings",
] as const;
const POCKETROCK_SETTINGS_DESTINATIONS = [
  "Sound", "Playback", "Display", "Power", "Storage", "System Information",
] as const;
const DEFAULT_EQ_PRESETS = ["Flat", "Rock", "Acoustic", "Bass Boost"] as const;
const DEFAULT_EQ_BANDS: readonly EqBand[] = [
  { frequency: "60 Hz", gain: 0 },
  { frequency: "250 Hz", gain: 0 },
  { frequency: "1 kHz", gain: 0 },
  { frequency: "4 kHz", gain: 0 },
  { frequency: "12 kHz", gain: 0 },
];
const DEFAULT_PLAYBACK_SETTINGS = [
  { label: "重复播放", value: "关闭" },
  { label: "随机播放", value: "关闭" },
  { label: "恢复播放", value: "开启" },
  { label: "交叉淡入淡出", value: "关闭" },
  { label: "ReplayGain", value: "Track" },
  { label: "跳过长度", value: "整首" },
  { label: "自动切换目录", value: "关闭" },
] as const;
const DEFAULT_DISPLAY_SETTINGS = [
  { label: "亮度", value: "68%" },
  { label: "背光超时", value: "10 秒" },
  { label: "充电时背光", value: "开启" },
  { label: "淡入淡出", value: "开启" },
  { label: "滚动速度", value: "快速" },
  { label: "屏幕休眠", value: "5 分钟" },
] as const;
const WHEEL_IDLE_FRAMES = 6;
const TRANSITION_MS = POCKETROCK_TRANSITION_MS;
const VOLUME_FLASH_MS = 1400;

interface AppsPageEntry {
  title?: string;
  id?: string;
  kind?: "pocket" | "rockbox";
  path?: string;
}

interface EqBand {
  frequency: string;
  gain: number;
}

interface SoundSettingsModel {
  volume: number;
  balance: number;
  bass: number;
  treble: number;
  channelMode: "Stereo" | "Mono" | "Custom";
  crossfeed: boolean;
}

const PAGE_TITLE: Record<Page, string> = {
  Home: "PocketRock",
  "Now Playing": "正在播放",
  Music: "音乐",
  Queue: "播放队列",
  Files: "文件",
  Apps: "应用",
  Settings: "设置",
  Library: "音乐资料库",
  Sound: "声音",
  Equalizer: "均衡器",
  Playback: "播放设置",
  Display: "显示",
  Power: "电源",
  Storage: "存储",
  "System Information": "系统信息",
};

const HOME_LABEL: Record<(typeof POCKETROCK_HOME_DESTINATIONS)[number], string> = {
  "Now Playing": "正在播放",
  Music: "音乐",
  Queue: "播放队列",
  Files: "文件",
  Apps: "应用",
  Settings: "设置",
};

const SETTINGS_LABEL: Record<(typeof POCKETROCK_SETTINGS_DESTINATIONS)[number], string> = {
  Sound: "声音",
  Playback: "播放设置",
  Display: "显示",
  Power: "电源",
  Storage: "存储",
  "System Information": "系统信息",
};

const LIBRARY_LABEL: Record<LibraryKind, string> = {
  artists: "艺术家",
  albums: "专辑",
  tracks: "歌曲",
  playlists: "播放列表",
};

function PageSurface(props: ScreenSnapshot) {
  return (
    <ShellListScreen
      title={props.title}
      back={props.back}
      rows={props.rows}
      selected={props.selected}
      offset={props.offset}
      emptyTitle={props.notice || "这里没有内容"}
      hideEmpty={props.pending}
    />
  );
}

function SnapshotSurface(props: ScreenSnapshot) {
  return (
    <Show when={props.page === "Now Playing"} fallback={<PageSurface {...props} />}>
      <NowPlayingScreen
        title={props.playback?.title || "暂无播放"}
        artist={props.playback?.artist || "请选择一首歌曲"}
        album={props.playback?.album}
        elapsedSeconds={(props.playback?.elapsedMs ?? 0) / 1000}
        durationSeconds={(props.playback?.durationMs ?? 0) / 1000}
        playing={props.playback?.status === "playing"}
        trackIndex={props.playback?.index}
        trackTotal={props.queueTotal}
        battery={props.system?.batteryPercent}
        charging={props.system?.charging}
        shuffle={props.playback?.shuffle}
        repeat={props.playback?.repeat}
        back
      />
    </Show>
  );
}

function Shell() {
  const [stack, setStack] = createSignal<Route[]>([{ page: "Home", selected: 0, offset: 0 }]);
  const [selected, setSelected] = createSignal(0);
  const [notice, setNotice] = createSignal("");
  const [soundModel, setSoundModel] = createSignal<SoundSettingsModel>({
    volume: -1800,
    balance: 0,
    bass: 0,
    treble: 0,
    channelMode: "Stereo",
    crossfeed: false,
  });
  const [eqEnabled, setEqEnabled] = createSignal(false);
  const [eqPreset, setEqPreset] = createSignal<string>(DEFAULT_EQ_PRESETS[0]);
  const [eqBands, setEqBands] = createSignal<EqBand[]>(DEFAULT_EQ_BANDS.map((band) => ({ ...band })));
  const [transitionSnapshot, setTransitionSnapshot] = createSignal<ScreenSnapshot | null>(null);
  const [transitionDirection, setTransitionDirection] = createSignal<"push" | "pop" | null>(null);
  const [playbackState, setPlaybackState] = createSignal<PlaybackSnapshot | null>(null);
  const [systemState, setSystemState] = createSignal<SystemSnapshot | null>(null);
  const [queueTotal, setQueueTotal] = createSignal(0);
  let activePanel: NodeMirror | undefined;
  let transitionPanel: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelTargetIndex = 0;
  let wheelIdleFrames = WHEEL_IDLE_FRAMES;
  let transitionDeadlineMs = 0;
  let pendingLibraryKind: LibraryKind | null = null;
  const loadedLibraryPages = new Set<number>();
  let playbackPollFrames = 0;
  let systemPollFrames = 0;
  const [volumeFlash, setVolumeFlash] = createSignal<number | null>(null);
  let volumeFlashUntilMs = 0;

  const route = createMemo(() => stack()[stack().length - 1]);
  const page = createMemo(() => route().page);
  const serviceActive = () => typeof getOps().pocketrockCall === "function";
  const usbSurfaceVisible = () => {
    const usb = systemState()?.usb;
    return usb !== undefined && usb !== "disconnected";
  };

  const readPlayback = (): PlaybackSnapshot | null => {
    if (!serviceActive()) return null;
    try { return playback.snapshot(); } catch { return null; }
  };

  const readSystem = (): SystemSnapshot | null => {
    if (!serviceActive()) return null;
    try { return system.snapshot(); } catch { return null; }
  };

  const refreshQueueTotal = (): void => {
    if (!serviceActive()) {
      setQueueTotal(0);
      return;
    }
    try {
      setQueueTotal(queue.page(0, 1).total);
    } catch {
      // Keep the last total rather than flashing an empty sequence label.
    }
  };

  const samePlayback = (left: PlaybackSnapshot | null, right: PlaybackSnapshot | null): boolean =>
    left === right || (!!left && !!right &&
      left.status === right.status && left.index === right.index && left.path === right.path &&
      left.title === right.title && left.artist === right.artist && left.album === right.album &&
      left.elapsedMs === right.elapsedMs && left.durationMs === right.durationMs &&
      left.volume === right.volume && left.repeat === right.repeat && left.shuffle === right.shuffle);
  const sameSystem = (left: SystemSnapshot | null, right: SystemSnapshot | null): boolean =>
    left === right || (!!left && !!right && left.batteryPercent === right.batteryPercent &&
      left.batteryMinutes === right.batteryMinutes && left.charging === right.charging &&
      left.freeBytes === right.freeBytes && left.totalBytes === right.totalBytes &&
      left.backlight === right.backlight && left.usb === right.usb);

  const refreshPlaybackState = (): void => {
    const next = readPlayback();
    setPlaybackState((current) => samePlayback(current, next) ? current : next);
  };
  const refreshSystemState = (): void => {
    const next = readSystem();
    setSystemState((current) => sameSystem(current, next) ? current : next);
  };
  refreshPlaybackState();
  refreshSystemState();
  refreshQueueTotal();

  const allApps = (): AppsPageEntry[] => (appTable()?.apps ?? []).map((app) => ({
    title: app.title,
    id: app.id,
    kind: app.kind ?? "pocket",
    path: app.path,
  }));

  const rows = createMemo<Row[]>(() => {
    switch (page()) {
    case "Home": {
      const now = playbackState();
      const device = systemState();
      const values: Record<(typeof POCKETROCK_HOME_DESTINATIONS)[number], string> = {
        "Now Playing": now?.title || "暂无播放",
        Music: "艺术家、专辑与歌曲",
        Queue: "当前播放列表",
        Files: "iPod 存储",
        Apps: `${allApps().length} 个应用`,
        Settings: device ? `电量 ${device.batteryPercent}%` : "声音、显示与系统",
      };
      return POCKETROCK_HOME_DESTINATIONS.map((title) => ({
        title: HOME_LABEL[title],
        subtitle: values[title],
        action: () => push({ page: title }),
      }));
    }
    case "Music": return MUSIC.map((kind) => ({
      title: LIBRARY_LABEL[kind],
      subtitle: kind === "artists" ? "按表演者浏览" : kind === "albums" ? "按发行专辑浏览" : kind === "tracks" ? "全部歌曲" : "已保存的播放列表",
      action: () => openLibrary(kind),
    }));
    case "Library": return route().libraryRows ?? [];
    case "Queue": {
      if (!serviceActive()) return [{ title: "播放队列不可用", subtitle: "需要 Host ABI 10" }];
      try {
        return queue.page(0, 64).items.map((item) => ({
          title: item.title || item.path,
          subtitle: item.artist,
          action: () => queue.play(item.index),
        }));
      } catch (error) { return [{ title: "播放队列不可用", subtitle: String(error) }]; }
    }
    case "Apps": return allApps().map((app) => ({
      title: app.title ?? "未命名应用",
      subtitle: app.path ?? app.id,
      action: () => app.kind === "rockbox" && app.path
        ? launchNativePlugin(app.path)
        : app.id ? launchPackage(app.id) : undefined,
    }));
    case "Settings": {
      const now = playbackState();
      const device = systemState();
      const values: Record<(typeof POCKETROCK_SETTINGS_DESTINATIONS)[number], string> = {
        Sound: now ? `${now.volume} dB` : "音量与音色",
        Playback: now?.shuffle ? "随机播放已开启" : "重复与恢复",
        Display: device?.backlight ? "背光已开启" : "背光已关闭",
        Power: device ? `电量 ${device.batteryPercent}%` : "休眠与关机",
        Storage: device ? `剩余 ${Math.floor(device.freeBytes / 1048576)} MiB` : "磁盘用量",
        "System Information": "PocketRock 0.1",
      };
      return POCKETROCK_SETTINGS_DESTINATIONS.map((title) => ({
        title: SETTINGS_LABEL[title],
        subtitle: values[title],
        action: () => push({ page: title }),
      }));
    }
    case "Sound": return [
      { title: "音量", subtitle: `${(soundModel().volume / 100).toFixed(1)} dB` },
      { title: "平衡", subtitle: `${soundModel().balance}` },
      { title: "低音", subtitle: `${soundModel().bass > 0 ? "+" : ""}${soundModel().bass} dB` },
      { title: "高音", subtitle: `${soundModel().treble > 0 ? "+" : ""}${soundModel().treble} dB` },
      { title: "声道", subtitle: soundModel().channelMode },
      { title: "交叉馈送", subtitle: soundModel().crossfeed ? "开启" : "关闭" },
      { title: "均衡器", subtitle: eqEnabled() ? eqPreset() : "关闭", action: () => push({ page: "Equalizer" }) },
    ];
    case "Equalizer": return [
      { title: "启用", subtitle: eqEnabled() ? "开启" : "关闭" },
      { title: "预设", subtitle: eqPreset() },
      ...eqBands().map((band) => ({
        title: band.frequency,
        subtitle: `${band.gain > 0 ? "+" : ""}${band.gain} dB`,
      })),
    ];
    case "Playback": {
      const now = playbackState();
      return DEFAULT_PLAYBACK_SETTINGS.map((row, index) => ({
        title: row.label,
        subtitle: index === 0
          ? now?.repeat === "one" ? "单曲" : now?.repeat === "all" ? "全部" : "关闭"
          : index === 1 ? now?.shuffle ? "开启" : "关闭" : row.value,
      }));
    }
    case "Display": return DEFAULT_DISPLAY_SETTINGS.map((row) => ({ title: row.label, subtitle: row.value }));
    case "Power": {
      const device = systemState();
      return [
      { title: "电池", subtitle: device ? `${device.batteryPercent}%` : "不可用" },
      { title: "休眠", subtitle: "停止播放并休眠" },
      { title: "关机", action: () => { if (serviceActive()) system.powerOff(); } },
      { title: "重新启动", action: () => { if (serviceActive()) system.reboot(); } },
      ];
    }
    case "Storage": {
      const device = systemState();
      if (!device) return [{ title: "存储不可用", subtitle: "系统服务离线" }];
      const used = Math.max(0, device.totalBytes - device.freeBytes);
      return [
        { title: "已使用", subtitle: `${Math.floor(used / 1048576)} MiB` },
        { title: "剩余", subtitle: `${Math.floor(device.freeBytes / 1048576)} MiB` },
        { title: "总计", subtitle: `${Math.floor(device.totalBytes / 1048576)} MiB` },
      ];
    }
    case "System Information": return [
      { title: "PocketRock", subtitle: "0.1.0" },
      { title: "Host ABI", subtitle: "10" },
      { title: "设备", subtitle: "iPod Classic 6/7G" },
      { title: "显示", subtitle: "320 x 240 RGB565" },
      { title: "运行时", subtitle: "QuickJS" },
    ];
    case "Files": return [
      { title: ".rockbox", subtitle: "系统文件" },
      { title: "Music", subtitle: "音频文件" },
      { title: "Playlists", subtitle: "保存的播放列表" },
    ];
    default: return [];
    }
  });

  const maxOffset = () => Math.max(0, rows().length * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT);
  const listScroller = createScroller({ max: maxOffset, extent: () => CONTACT_LIST_HEIGHT });
  const title = () => page() === "Library"
    ? LIBRARY_LABEL[route().libraryKind ?? "artists"]
    : PAGE_TITLE[page()];

  const activeSnapshot = (): ScreenSnapshot => ({
    page: page(),
    title: title(),
    rows: rows(),
    selected: selected(),
    offset: listScroller.offset(),
    back: stack().length > 1,
    notice: notice(),
    playback: playbackState(),
    system: systemState(),
    queueTotal: queueTotal(),
    pending: page() === "Library" && pendingLibraryKind !== null,
  });
  const saveCurrentRoute = (): Route => ({
    ...route(),
    selected: selected(),
    offset: listScroller.offset(),
  });

  function resetWheel(nextSelected: number): void {
    wheelDirection = 0;
    wheelBurst = 0;
    wheelTargetIndex = nextSelected;
    wheelIdleFrames = WHEEL_IDLE_FRAMES;
  }

  function restoreRoute(next: Route): void {
    listScroller.stop();
    listScroller.scrollTo(next.offset, { immediate: true });
    setSelected(next.selected);
    resetWheel(next.selected);
  }

  function transitionActive(): boolean {
    return transitionDeadlineMs !== 0;
  }

  function prepareTransition(snapshot: ScreenSnapshot, direction: "push" | "pop"): void {
    setTransitionDirection(direction);
    setTransitionSnapshot(snapshot);
    if (!activePanel || !transitionPanel) return;
    jump(activePanel, "translateX", direction === "push" ? 320 : -64);
    jump(transitionPanel, "translateX", 0);
  }

  function runTransition(direction: "push" | "pop"): void {
    if (!activePanel || !transitionPanel) return;
    transitionDeadlineMs = transitionDeadline(Date.now());
    if (direction === "push") {
      animate(transitionPanel, "translateX", -64, { dur: TRANSITION_MS, easing: "out" });
      animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
    } else {
      animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
      animate(transitionPanel, "translateX", 320, { dur: TRANSITION_MS, easing: "out" });
    }
  }

  function push(next: Pick<Route, "page"> & Partial<Route>): void {
    if (transitionActive()) return;
    const snapshot = activeSnapshot();
    const current = saveCurrentRoute();
    const destination: Route = {
      page: next.page,
      selected: next.selected ?? 0,
      offset: next.offset ?? 0,
      libraryKind: next.libraryKind,
      libraryRows: next.libraryRows,
    };
    prepareTransition(snapshot, "push");
    setStack((value) => [...value.slice(0, -1), current, destination]);
    restoreRoute(destination);
    runTransition("push");
  }

  function pop(): void {
    if (stack().length <= 1 || transitionActive()) return;
    const snapshot = activeSnapshot();
    const destination = stack()[stack().length - 2];
    prepareTransition(snapshot, "pop");
    setStack((value) => value.slice(0, -1));
    restoreRoute(destination);
    runTransition("pop");
  }

  function openLibrary(kind: LibraryKind): void {
    loadedLibraryPages.clear();
    pendingLibraryKind = kind;
    push({
      page: "Library",
      libraryKind: kind,
      libraryRows: [],
    });
  }

  function loadPendingLibrary(): void {
    const kind = pendingLibraryKind;
    if (kind === null) return;
    pendingLibraryKind = null;
    let libraryRows: Row[];
    if (!serviceActive()) {
      libraryRows = [{ title: "音乐资料库不可用", subtitle: "Tagcache 服务离线" }];
    } else {
      try {
        const result = library.page(kind, 0, 64);
        libraryRows = new Array<Row>(result.total);
        for (let index = 0; index < result.items.length; index++) {
          libraryRows[result.offset + index] = libraryRow(result.items[index]);
        }
        loadedLibraryPages.add(Math.floor(result.offset / 64));
        if (result.scanning) setNotice("正在扫描音乐资料库");
      } catch (error) {
        libraryRows = [{ title: "音乐资料库不可用", subtitle: String(error) }];
      }
    }
    setStack((value) => value.map((entry, index) => index === value.length - 1 &&
      entry.page === "Library" && entry.libraryKind === kind
      ? { ...entry, libraryRows }
      : entry));
  }

  function libraryRow(item: { title: string; subtitle?: string; path?: string }): Row {
    return {
      title: item.title,
      subtitle: item.subtitle,
      action: item.path ? () => playLibraryTrack(item.path!) : undefined,
    };
  }

  function ensureLibraryPage(index: number): void {
    if (page() !== "Library" || !serviceActive()) return;
    const kind = route().libraryKind;
    const currentRows = route().libraryRows;
    if (!kind || !currentRows || currentRows.length === 0) return;
    const offset = Math.floor(Math.max(0, index) / 64) * 64;
    const pageIndex = offset / 64;
    if (loadedLibraryPages.has(pageIndex)) return;
    loadedLibraryPages.add(pageIndex);
    try {
      const result = library.page(kind, offset, 64);
      const nextRows = currentRows.slice();
      for (let itemIndex = 0; itemIndex < result.items.length; itemIndex++) {
        nextRows[result.offset + itemIndex] = libraryRow(result.items[itemIndex]);
      }
      const pagesByDistance = [...loadedLibraryPages]
        .sort((left, right) => Math.abs(right - pageIndex) - Math.abs(left - pageIndex));
      while (pagesByDistance.length > 3) {
        const droppedPage = pagesByDistance.shift()!;
        loadedLibraryPages.delete(droppedPage);
        const droppedOffset = droppedPage * 64;
        for (let rowIndex = droppedOffset;
          rowIndex < Math.min(nextRows.length, droppedOffset + 64); rowIndex++) {
          delete nextRows[rowIndex];
        }
      }
      setStack((value) => value.map((entry, routeIndex) =>
        routeIndex === value.length - 1 && entry.page === "Library"
          ? { ...entry, libraryRows: nextRows }
          : entry));
    } catch (error) {
      loadedLibraryPages.delete(pageIndex);
      setNotice(`读取资料库失败：${String(error)}`);
    }
  }

  function playLibraryTrack(path: string): void {
    if (!serviceActive()) return;
    try {
      if (!queue.replace([path], 0)) {
        setNotice("无法播放所选歌曲");
        return;
      }
      refreshPlaybackState();
      push({ page: "Now Playing" });
    } catch (error) {
      setNotice(`播放失败：${String(error)}`);
    }
  }

  function moveSelection(delta: number): void {
    const count = rows().length;
    if (count === 0) return;
    const nextTarget = Math.max(0, Math.min(count - 1, wheelTargetIndex + delta));
    if (nextTarget === wheelTargetIndex) return;
    wheelTargetIndex = nextTarget;
    setSelected(contactVisibleIndex(nextTarget, listScroller.offset(), count));
    const target = contactScrollTarget(nextTarget, listScroller.intent(), maxOffset());
    if (target !== null) {
      listScroller.springTo(target, {
        overshootPx: CONTACT_SPRING_OVERSHOOT,
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  }

  function updateVisualSelection(): void {
    if (rows().length === 0) return;
    setSelected(contactVisibleIndex(wheelTargetIndex, listScroller.offset(), rows().length));
  }

  function settleReleasedSelection(): void {
    if (rows().length === 0) return;
    const nextSelected = contactVisibleIndex(wheelTargetIndex, listScroller.offset(), rows().length);
    wheelTargetIndex = nextSelected;
    setSelected(nextSelected);
    const target = contactScrollTarget(nextSelected, listScroller.offset(), maxOffset());
    listScroller.stop();
    if (target !== null) {
      listScroller.springTo(target, {
        stiffness: CONTACT_SPRING_STIFFNESS,
        damping: CONTACT_SPRING_DAMPING,
      });
    }
  }

  function acceleratedWheelDelta(direction: -1 | 1): number {
    if (wheelDirection !== direction || wheelIdleFrames >= WHEEL_IDLE_FRAMES) {
      wheelDirection = direction;
      wheelBurst = 0;
      wheelTargetIndex = selected();
    } else {
      wheelBurst += 1;
    }
    wheelIdleFrames = 0;
    return direction * wheelMultiplier(wheelBurst);
  }

  function cycleEqPreset(direction: -1 | 1): void {
    const presets = DEFAULT_EQ_PRESETS;
    const current = Math.max(0, presets.indexOf(eqPreset() as typeof presets[number]));
    setEqPreset(presets[(current + direction + presets.length) % presets.length]);
  }

  function adjustCurrent(direction: -1 | 1): void {
    if (page() === "Now Playing") {
      if (serviceActive()) direction < 0 ? playback.previous() : playback.next();
      return;
    }
    if (page() === "Sound") {
      const index = selected();
      setSoundModel((value) => {
        if (index === 0) return { ...value, volume: Math.max(-7400, Math.min(0, value.volume + direction * 100)) };
        if (index === 1) return { ...value, balance: Math.max(-100, Math.min(100, value.balance + direction * 5)) };
        if (index === 2) return { ...value, bass: Math.max(-24, Math.min(24, value.bass + direction)) };
        if (index === 3) return { ...value, treble: Math.max(-24, Math.min(24, value.treble + direction)) };
        if (index === 4) {
          const modes: SoundSettingsModel["channelMode"][] = ["Stereo", "Mono", "Custom"];
          const current = modes.indexOf(value.channelMode);
          return { ...value, channelMode: modes[(current + direction + modes.length) % modes.length] };
        }
        if (index === 5) return { ...value, crossfeed: !value.crossfeed };
        return value;
      });
      return;
    }
    if (page() === "Equalizer") {
      const index = selected();
      if (index === 0) setEqEnabled((value) => !value);
      else if (index === 1) cycleEqPreset(direction);
      else setEqBands((bands) => bands.map((band, bandIndex) => bandIndex === index - 2
        ? { ...band, gain: Math.max(-12, Math.min(12, band.gain + direction)) }
        : band));
      return;
    }
    if (page() === "Playback" && serviceActive()) {
      const now = playbackState();
      if (selected() === 0) {
        const values = ["off", "all", "one"];
        const current = Math.max(0, values.indexOf(now?.repeat ?? "off"));
        playback.setRepeat(values[(current + direction + values.length) % values.length]);
      } else if (selected() === 1) playback.setShuffle(!(now?.shuffle ?? false));
    }
  }

  /**
   * On the Now Playing surface the wheel and UP/DOWN change volume, mirroring
   * the stock iPod.  The magnitude is clamped per frame so a fast spin can not
   * leapfrog the 0..100 master range in a single pulse burst.
   */
  function adjustVolume(delta: number): void {
    if (!serviceActive()) return;
    const current = playbackState()?.volume ?? 0;
    const next = Math.max(0, Math.min(100, current + delta));
    if (next === current) return;
    if (!playback.setVolume(next)) return;
    refreshPlaybackState();
    volumeFlashUntilMs = Date.now() + VOLUME_FLASH_MS;
    setVolumeFlash(next);
  }

  function CurrentPage() {
    return (
      <Show
        when={usbSurfaceVisible()}
        fallback={
          <Show when={page() === "Now Playing"} fallback={<PageSurface {...activeSnapshot()} />}>
            <NowPlayingScreen
              title={playbackState()?.title || "暂无播放"}
              artist={playbackState()?.artist || "请选择一首歌曲"}
              album={playbackState()?.album}
              elapsedSeconds={(playbackState()?.elapsedMs ?? 0) / 1000}
              durationSeconds={(playbackState()?.durationMs ?? 0) / 1000}
              playing={playbackState()?.status === "playing"}
              trackIndex={playbackState()?.index}
              trackTotal={queueTotal()}
              battery={systemState()?.batteryPercent}
              charging={systemState()?.charging}
              volumeFlash={volumeFlash()}
              shuffle={playbackState()?.shuffle}
              repeat={playbackState()?.repeat}
              back
            />
          </Show>
        }
      >
        <UsbScreen mode={systemState()?.usb === "mass-storage" ? "mass-storage" : "charging"} />
      </Show>
    );
  }

  onFrame((buttons) => {
    if (volumeFlashUntilMs !== 0 && Date.now() >= volumeFlashUntilMs) {
      volumeFlashUntilMs = 0;
      setVolumeFlash(null);
    }
    const interacting = wheelDirection !== 0 || listScroller.state() !== "idle";
    if (!transitionActive() && !interacting) {
      const playbackInterval = page() === "Now Playing" ? 10
        : page() === "Home" || page() === "Settings" || page() === "Playback" ? 60
          : 180;
      const systemInterval = usbSurfaceVisible() ? 10
        : page() === "Home" || page() === "Settings" || page() === "Power" ||
            page() === "Storage" || page() === "Display" ? 60 : 180;
      if (++playbackPollFrames >= playbackInterval) {
        playbackPollFrames = 0;
        refreshPlaybackState();
        if (page() === "Now Playing") refreshQueueTotal();
      }
      if (++systemPollFrames >= systemInterval) {
        systemPollFrames = 0;
        refreshSystemState();
      }
    }
    if (usbSurfaceVisible()) {
      listScroller.stop();
      resetWheel(selected());
      return;
    }
    if (transitionActive()) {
      if (transitionExpired(transitionDeadlineMs, Date.now())) {
        transitionDeadlineMs = 0;
        if (activePanel) jump(activePanel, "translateX", 0);
        if (transitionPanel) jump(transitionPanel, "translateX", 320);
        setTransitionSnapshot(null);
        setTransitionDirection(null);
        loadPendingLibrary();
      }
      return;
    }
    listScroller.step();
    updateVisualSelection();
    ensureLibraryPage(selected());
    const nowPlaying = page() === "Now Playing";
    const pulses = wheelDelta();
    if (pulses !== 0) {
      if (nowPlaying) {
        adjustVolume(Math.max(-5, Math.min(5, pulses)));
      } else {
        const direction: -1 | 1 = pulses < 0 ? -1 : 1;
        for (let pulse = 0; pulse < Math.abs(pulses); pulse++) {
          moveSelection(acceleratedWheelDelta(direction));
        }
        ensureLibraryPage(wheelTargetIndex);
      }
    } else if ((buttons & BTN.UP) !== 0) {
      if (nowPlaying) adjustVolume(-1);
      else {
        moveSelection(acceleratedWheelDelta(-1));
        ensureLibraryPage(wheelTargetIndex);
      }
    } else if ((buttons & BTN.DOWN) !== 0) {
      if (nowPlaying) adjustVolume(1);
      else {
        moveSelection(acceleratedWheelDelta(1));
        ensureLibraryPage(wheelTargetIndex);
      }
    } else {
      wheelIdleFrames = Math.min(WHEEL_IDLE_FRAMES, wheelIdleFrames + 1);
      if (wheelDirection !== 0 && wheelIdleFrames === 1) settleReleasedSelection();
      if (wheelDirection !== 0 && wheelIdleFrames === WHEEL_IDLE_FRAMES) resetWheel(selected());
    }
  });

  onButtonPress(BTN.CIRCLE, () => {
    if (usbSurfaceVisible() || transitionActive()) return;
    if (page() === "Equalizer" && selected() < 2) adjustCurrent(1);
    else rows()[selected()]?.action?.();
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, () => { if (!usbSurfaceVisible()) pop(); }, { latched: true });
  onButtonPress(BTN.START, () => {
    if (!usbSurfaceVisible() && serviceActive()) playback.toggle();
  }, { latched: true });
  onButtonPress(BTN.LEFT, () => { if (!usbSurfaceVisible()) adjustCurrent(-1); }, { latched: true });
  onButtonPress(BTN.RIGHT, () => { if (!usbSurfaceVisible()) adjustCurrent(1); }, { latched: true });

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View
        ref={(node) => (activePanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden"
        style={{ zIndex: transitionDirection() === "push" ? 2 : 1 }}
      >
        <CurrentPage />
      </View>
      <View
        ref={(node) => (transitionPanel = node)}
        class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden"
        style={{ translateX: 320, zIndex: transitionDirection() === "push" ? 1 : 2 }}
      >
        <Show when={transitionSnapshot()} keyed>
          {(snapshot) => <SnapshotSurface {...snapshot} />}
        </Show>
      </View>
    </View>
  );
}

mount(() => <Shell />);
