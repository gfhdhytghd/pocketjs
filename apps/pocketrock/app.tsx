import { Show, createMemo, createSignal } from "solid-js";
import { animate, jump } from "@pocketjs/framework/animation";
import { View, type NodeMirror } from "@pocketjs/framework/components";
import { getOps } from "@pocketjs/framework/host";
import { BTN } from "@pocketjs/framework/input";
import { createScroller } from "@pocketjs/framework/kinetics";
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
const TRANSITION_FRAMES = 8;
const TRANSITION_MS = 110;

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
      rows={props.rows.map((row) => ({ title: row.title, value: row.subtitle }))}
      selected={props.selected}
      offset={props.offset}
      emptyTitle={props.notice || "这里没有内容"}
    />
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
  let activePanel: NodeMirror | undefined;
  let transitionPanel: NodeMirror | undefined;
  let wheelDirection = 0;
  let wheelBurst = 0;
  let wheelTargetIndex = 0;
  let wheelIdleFrames = WHEEL_IDLE_FRAMES;
  let transitionFrames = 0;

  const route = createMemo(() => stack()[stack().length - 1]);
  const page = createMemo(() => route().page);
  const serviceActive = () => typeof getOps().pocketrockCall === "function";

  const safePlayback = (): PlaybackSnapshot | null => {
    if (!serviceActive()) return null;
    try { return playback.snapshot(); } catch { return null; }
  };

  const safeSystem = (): SystemSnapshot | null => {
    if (!serviceActive()) return null;
    try { return system.snapshot(); } catch { return null; }
  };

  const allApps = (): AppsPageEntry[] => (appTable()?.apps ?? []).map((app) => ({
    title: app.title,
    id: app.id,
    kind: app.kind ?? "pocket",
    path: app.path,
  }));

  const rows = createMemo<Row[]>(() => {
    switch (page()) {
    case "Home": {
      const now = safePlayback();
      const device = safeSystem();
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
      const now = safePlayback();
      const device = safeSystem();
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
      const now = safePlayback();
      return DEFAULT_PLAYBACK_SETTINGS.map((row, index) => ({
        title: row.label,
        subtitle: index === 0
          ? now?.repeat === "one" ? "单曲" : now?.repeat === "all" ? "全部" : "关闭"
          : index === 1 ? now?.shuffle ? "开启" : "关闭" : row.value,
      }));
    }
    case "Display": return DEFAULT_DISPLAY_SETTINGS.map((row) => ({ title: row.label, subtitle: row.value }));
    case "Power": {
      const device = safeSystem();
      return [
      { title: "电池", subtitle: device ? `${device.batteryPercent}%` : "不可用" },
      { title: "休眠", subtitle: "停止播放并休眠" },
      { title: "关机", action: () => { if (serviceActive()) system.powerOff(); } },
      { title: "重新启动", action: () => { if (serviceActive()) system.reboot(); } },
      ];
    }
    case "Storage": {
      const device = safeSystem();
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

  function beginTransition(snapshot: ScreenSnapshot, direction: "push" | "pop"): void {
    setTransitionSnapshot(snapshot);
    transitionFrames = TRANSITION_FRAMES;
    queueMicrotask(() => {
      if (!activePanel || !transitionPanel) return;
      if (direction === "push") {
        jump(activePanel, "translateX", 320);
        jump(transitionPanel, "translateX", 0);
        animate(transitionPanel, "translateX", -64, { dur: TRANSITION_MS, easing: "out" });
        animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
      } else {
        jump(activePanel, "translateX", -64);
        jump(transitionPanel, "translateX", 0);
        animate(activePanel, "translateX", 0, { dur: TRANSITION_MS, easing: "out" });
        animate(transitionPanel, "translateX", 320, { dur: TRANSITION_MS, easing: "out" });
      }
    });
  }

  function push(next: Pick<Route, "page"> & Partial<Route>): void {
    if (transitionFrames > 0) return;
    const snapshot = activeSnapshot();
    const current = saveCurrentRoute();
    const destination: Route = {
      page: next.page,
      selected: next.selected ?? 0,
      offset: next.offset ?? 0,
      libraryKind: next.libraryKind,
      libraryRows: next.libraryRows,
    };
    setStack((value) => [...value.slice(0, -1), current, destination]);
    restoreRoute(destination);
    beginTransition(snapshot, "push");
  }

  function pop(): void {
    if (stack().length <= 1 || transitionFrames > 0) return;
    const snapshot = activeSnapshot();
    const destination = stack()[stack().length - 2];
    setStack((value) => value.slice(0, -1));
    restoreRoute(destination);
    beginTransition(snapshot, "pop");
  }

  function openLibrary(kind: LibraryKind): void {
    let libraryRows: Row[];
    if (!serviceActive()) {
      libraryRows = [{ title: "音乐资料库不可用", subtitle: "Tagcache 服务离线" }];
    } else {
      try {
        const result = library.page(kind, 0, 64);
        libraryRows = result.items.map((item) => ({ title: item.title, subtitle: item.subtitle }));
        if (result.scanning) setNotice("正在扫描音乐资料库");
      } catch (error) {
        libraryRows = [{ title: "音乐资料库不可用", subtitle: String(error) }];
      }
    }
    push({ page: "Library", libraryKind: kind, libraryRows });
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
      const now = safePlayback();
      if (selected() === 0) {
        const values = ["off", "all", "one"];
        const current = Math.max(0, values.indexOf(now?.repeat ?? "off"));
        playback.setRepeat(values[(current + direction + values.length) % values.length]);
      } else if (selected() === 1) playback.setShuffle(!(now?.shuffle ?? false));
    }
  }

  function CurrentPage() {
    const now = safePlayback();
    const device = safeSystem();
    if (device && device.usb !== "disconnected") {
      return <UsbScreen mode={device.usb === "mass-storage" ? "mass-storage" : "charging"} />;
    }
    if (page() === "Now Playing") {
      return <NowPlayingScreen
        title={now?.title || "暂无播放"}
        artist={now?.artist || "请选择一首歌曲"}
        album={now?.album}
        elapsedSeconds={(now?.elapsedMs ?? 0) / 1000}
        durationSeconds={(now?.durationMs ?? 0) / 1000}
        playing={now?.status === "playing"}
        back
      />;
    }
    return <PageSurface {...activeSnapshot()} />;
  }

  onFrame((buttons) => {
    if (transitionFrames > 0) {
      transitionFrames -= 1;
      if (transitionFrames === 0) {
        setTransitionSnapshot(null);
        if (activePanel) jump(activePanel, "translateX", 0);
      }
      return;
    }
    listScroller.step();
    updateVisualSelection();
    if ((buttons & BTN.UP) !== 0) moveSelection(acceleratedWheelDelta(-1));
    else if ((buttons & BTN.DOWN) !== 0) moveSelection(acceleratedWheelDelta(1));
    else {
      wheelIdleFrames = Math.min(WHEEL_IDLE_FRAMES, wheelIdleFrames + 1);
      if (wheelDirection !== 0 && wheelIdleFrames === 1) settleReleasedSelection();
      if (wheelDirection !== 0 && wheelIdleFrames === WHEEL_IDLE_FRAMES) resetWheel(selected());
    }
  });

  onButtonPress(BTN.CIRCLE, () => {
    if (transitionFrames !== 0) return;
    if (page() === "Equalizer" && selected() < 2) adjustCurrent(1);
    else rows()[selected()]?.action?.();
  }, { latched: true });
  onButtonPress(BTN.TRIANGLE, pop, { latched: true });
  onButtonPress(BTN.START, () => { if (serviceActive()) playback.toggle(); }, { latched: true });
  onButtonPress(BTN.LEFT, () => adjustCurrent(-1), { latched: true });
  onButtonPress(BTN.RIGHT, () => adjustCurrent(1), { latched: true });

  return (
    <View class="relative w-[320] h-[240] bg-[#f5f6f8] overflow-hidden">
      <View ref={(node) => (activePanel = node)} class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden">
        <Show when={page()} keyed>{(_currentPage) => <CurrentPage />}</Show>
      </View>
      <Show when={transitionSnapshot()} keyed>{(snapshot) =>
        <View ref={(node) => (transitionPanel = node)} class="absolute left-0 top-0 w-[320] h-[240] overflow-hidden">
          <PageSurface {...snapshot} />
        </View>
      }</Show>
    </View>
  );
}

mount(() => <Shell />);
