// apps/term/app.tsx — a remote terminal multiplexer for the 3ds-dev host.
//
// The Mac companion (host/serve.ts) owns the PTYs and an authoritative
// terminal state machine per session; this app is a passive replica in the
// zhongduan sense: attach delivers a full cell-grid snapshot, then ordered
// row diffs. The two screens split the terminal the way the contacts demo
// split the phone app: the top screen is the grid — 12 px monospace cells
// snapped to an integer advance — and the touch screen holds the session
// tabs and the keyboard.
//
// Physical controls: D-pad = arrow keys (with repeat), A = Enter,
// B = Backspace, X = Tab, Y = Space, L/R = previous/next session,
// START = Ctrl-C, SELECT = new session, circle pad = scrollback.

import { createSignal, For, Show } from "solid-js";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { analogY, onButtonPress, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework";
import { KB_H, Keyboard } from "./keyboard.tsx";
import { THEME_CURSOR, THEME_FG, type Run } from "./protocol.ts";
import { connectSvc } from "./svc.ts";
import { createTermStore, rgbToAbgr, type TermStore } from "./store.ts";

/* Grid geometry. The 12 px mono atlas is slot 16 (spec MONO_FONT_PX);
 * `font-mono text-xs` below is what makes the build bake it. The natural
 * advance (~7.2 px) is snapped down to a 7 px integer cell with negative
 * tracking so every column lands on a pixel. */
const MONO_SLOT = 16;
const STATUS_H = 14;
const CELL_H = 13;

const TAB_H = 26;
const KB_TOP = 240 - KB_H;

const DPAD_KEYS: readonly [number, "Up" | "Down" | "Left" | "Right"][] = [
  [BTN.UP, "Up"],
  [BTN.DOWN, "Down"],
  [BTN.LEFT, "Left"],
  [BTN.RIGHT, "Right"],
];
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

function connectionLabel(store: TermStore): string {
  switch (store.conn()) {
    case "no-svc":
      return "this host has no companion channel";
    case "search":
      return "searching for the companion beacon (UDP 8621)…";
    case "link":
      return "companion linked — waiting for a session…";
    case "live":
      return "";
  }
}

export default function TermApp() {
  const ops = getOps();
  const advance = ops.measureText("M", MONO_SLOT);
  const CELL_W = advance > 0 ? Math.max(6, Math.round(advance)) : 7;
  const TRACK = advance > 0 ? CELL_W - advance : 0;
  const COLS = Math.floor(400 / CELL_W);
  const ROWS = Math.floor((240 - STATUS_H) / CELL_H);

  const svc = connectSvc();
  const store = createTermStore(COLS, ROWS, svc);
  const [ctrlArmed, setCtrlArmed] = createSignal(false);

  const dpadHeld = new Map<number, number>();
  let scrollCarry = 0;

  onFrame((buttons) => {
    store.frame();

    for (const [mask, keyName] of DPAD_KEYS) {
      if (buttons & mask) {
        const held = (dpadHeld.get(mask) ?? 0) + 1;
        dpadHeld.set(mask, held);
        if (held === 1 || (held > DPAD_DELAY && (held - DPAD_DELAY) % DPAD_REPEAT === 0)) {
          store.sendKey(keyName);
        }
      } else {
        dpadHeld.set(mask, 0);
      }
    }

    // Circle pad Y scrubs scrollback: up = into history (positive delta).
    const pad = analogY();
    if (Math.abs(pad) > 0.25) {
      scrollCarry += -pad * 0.5;
      const lines = Math.trunc(scrollCarry);
      if (lines !== 0) {
        scrollCarry -= lines;
        store.scroll(lines);
      }
    } else {
      scrollCarry = 0;
    }
  });

  onButtonPress(BTN.CIRCLE, () => store.sendKey("Enter")); // A
  onButtonPress(BTN.CROSS, () => store.sendKey("Backspace")); // B
  onButtonPress(BTN.TRIANGLE, () => store.sendKey("Tab")); // X
  onButtonPress(BTN.SQUARE, () => store.sendText(" ")); // Y
  onButtonPress(BTN.LTRIGGER, () => store.attachSibling(-1));
  onButtonPress(BTN.RTRIGGER, () => store.attachSibling(1));
  onButtonPress(BTN.START, () => store.sendKey("c", true));
  onButtonPress(BTN.SELECT, () => store.newSession());

  const activeTitle = () => {
    const sid = store.activeSid();
    return store.sessions().find((s) => s.sid === sid)?.title ?? "";
  };

  // Session tab strip on the touch screen.
  let tabsNode: NodeMirror | undefined;
  const TAB_W = 72;
  createGesture({
    surface: "auxiliary",
    region: { node: () => tabsNode },
    onDown: (contact) => {
      const list = store.sessions();
      const index = Math.floor(contact.x / TAB_W);
      if (index < list.length) {
        store.attach(list[index].sid);
      } else if (index === list.length) {
        store.newSession();
      }
    },
  });

  const cursorLeft = () => (store.cursor()?.[0] ?? 0) * CELL_W;
  const cursorTop = () => STATUS_H + (store.cursor()?.[1] ?? 0) * CELL_H;
  const cursorOn = () => store.cursor()?.[2] === 1 && store.conn() === "live";

  return (
    <>
      {/* Primary display: the grid replica. */}
      <View debugName="TermScreen" class="relative w-full h-full bg-[#10151c] overflow-hidden">
        <View
          debugName="TermStatus"
          class={
            store.bell()
              ? "absolute left-0 right-0 top-0 h-[14] bg-[#7a4a1d]"
              : "absolute left-0 right-0 top-0 h-[14] bg-[#1a2230]"
          }
        >
          <Text class="absolute left-[6] top-0 text-xs text-[#9fb6d8] font-bold">POCKET TERM</Text>
          <Text class="absolute left-[92] top-0 text-xs text-[#5d708c]">{activeTitle()}</Text>
          <Show when={store.scrollback() > 0}>
            <Text class="absolute right-[56] top-0 text-xs text-[#e0b060]">{`↟${store.scrollback()}`}</Text>
          </Show>
          <Text class="absolute right-[18] top-0 text-xs text-[#5d708c]">{`${COLS}×${ROWS}`}</Text>
          <Text
            class={
              store.conn() === "live"
                ? "absolute right-[6] top-0 text-xs text-[#61c16d]"
                : "absolute right-[6] top-0 text-xs text-[#c95c5c]"
            }
          >
            ●
          </Text>
        </View>

        <Show when={cursorOn()}>
          <View
            class="absolute"
            style={{
              insetL: cursorLeft(),
              insetT: cursorTop(),
              width: CELL_W,
              height: CELL_H,
              // Translucent block under the glyphs (rows paint after this).
              bgColor: ((0x66 << 24) | (rgbToAbgr(THEME_CURSOR) & 0xffffff)) >>> 0,
            }}
          />
        </Show>

        {Array.from({ length: ROWS }, (_, y) => (
          <View class="absolute left-0 right-0" style={{ insetT: STATUS_H + y * CELL_H, height: CELL_H }}>
            <For each={store.row(y)()}>
              {(run: Run) => (
                <>
                  <Show when={run[3] >= 0}>
                    <View
                      class="absolute top-0"
                      style={{
                        insetL: run[0] * CELL_W,
                        width: run[1].length * CELL_W,
                        height: CELL_H,
                        bgColor: rgbToAbgr(run[3]),
                      }}
                    />
                  </Show>
                  <Text
                    class="absolute top-0 font-mono text-xs"
                    style={{
                      insetL: run[0] * CELL_W,
                      lineHeight: CELL_H,
                      tracking: TRACK,
                      textColor: rgbToAbgr(run[2] >= 0 ? run[2] : THEME_FG),
                    }}
                  >
                    {run[1]}
                  </Text>
                </>
              )}
            </For>
          </View>
        ))}

        <Show when={store.conn() !== "live"}>
          <View class="absolute left-0 right-0 top-0 bottom-0 flex-col items-center justify-center gap-[6] bg-[#10151cf0]">
            <Text class="text-lg text-[#9fb6d8] font-bold">pocket term</Text>
            <Text class="text-xs text-[#5d708c]">{connectionLabel(store)}</Text>
            <Text class="text-xs text-[#3d4c63]">on the Mac: node apps/term/host/serve.ts</Text>
          </View>
        </Show>
      </View>

      {/* Touch screen: tabs, status, keyboard. */}
      <AuxiliarySurface>
        <View debugName="TermAux" class="relative w-full h-full bg-[#0d1117] overflow-hidden">
          <View
            debugName="TermTabs"
            ref={(node) => (tabsNode = node)}
            class="absolute left-0 right-0 top-0 flex-row bg-[#141a24]"
            style={{ height: TAB_H }}
          >
            <For each={store.sessions()}>
              {(session) => (
                <View
                  class={
                    session.sid === store.activeSid()
                      ? "relative h-full items-center justify-center overflow-hidden bg-[#31394a]"
                      : "relative h-full items-center justify-center overflow-hidden"
                  }
                  style={{ width: TAB_W }}
                >
                  <Text
                    class={
                      session.sid === store.activeSid()
                        ? "text-xs text-[#dfe6f2]"
                        : "text-xs text-[#5d708c]"
                    }
                  >
                    {session.title}
                  </Text>
                  <Show when={session.sid === store.activeSid()}>
                    <View class="absolute left-0 right-0 bottom-0 h-[2] bg-[#4c9bf5]" />
                  </Show>
                </View>
              )}
            </For>
            <View class="h-full items-center justify-center" style={{ width: TAB_W }}>
              <Text class="text-sm text-[#5d708c]">+</Text>
            </View>
          </View>

          <View
            class="absolute left-0 right-0 flex-row items-center px-[8] gap-[10]"
            style={{ insetT: TAB_H, height: KB_TOP - TAB_H }}
          >
            <View class="flex-col gap-[2]">
              <Text class={store.conn() === "live" ? "text-xs text-[#61c16d]" : "text-xs text-[#c95c5c]"}>
                {store.conn() === "live" ? "connected" : store.conn()}
              </Text>
              <Text class="text-xs text-[#5d708c]">{store.hostName() || "—"}</Text>
            </View>
            <View class="grow" />
            <View class="flex-col gap-[2] items-end">
              <Text class="text-xs text-[#3d4c63]">SELECT new · L/R switch · START ^C</Text>
              <Text class="text-xs text-[#3d4c63]">pad scrolls history · A ⏎ · B ⌫</Text>
            </View>
          </View>

          <Keyboard
            top={KB_TOP}
            onChar={(ch) => store.sendText(ch)}
            onKey={(name, ctrl) => store.sendKey(name, ctrl)}
            ctrlArmed={ctrlArmed}
            setCtrlArmed={setCtrlArmed}
          />
        </View>
      </AuxiliarySurface>
    </>
  );
}
