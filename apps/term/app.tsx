// apps/term/app.tsx — a remote terminal multiplexer for the 3ds-dev host.
//
// The Mac companion (host/serve.ts) owns the PTYs and an authoritative
// terminal state machine per session; this app is a passive replica in the
// zhongduan sense: attach delivers a full cell-grid snapshot, then ordered
// row diffs. The two screens split the terminal the way the contacts demo
// split the phone app: the top screen is the grid (grid.tsx, shared with the
// desktop mirror window) and the touch screen holds the session tabs and the
// keyboard.
//
// Physical controls: D-pad = arrow keys (with repeat), A = Enter,
// B = Backspace, X = Tab, Y = Space, START = Ctrl-C, SELECT = new session,
// circle pad = scrollback.
//
// ZL is Ctrl: hold it and every key that follows carries the control
// modifier, with the on-screen keyboard lighting its Ctrl cap so the state is
// visible where the operator is already looking. ZL is New-3DS-only and
// reaches the guest through ir:rst rather than the ordinary HID pad
// (hosts/3ds/src/input.c); a console without it uses the keyboard's own Ctrl
// cap, which arms for one key.
//
// L and R step between sessions, and that is all they do. They briefly
// doubled as the modifier, which meant discriminating a tap from a hold —
// and a shoulder that only switches when released is a shoulder that feels
// broken. One button, one job.

import { createSignal, For, Show } from "solid-js";
import { AuxiliarySurface, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { analogY, onFrame } from "@pocketjs/framework/lifecycle";
import { BTN } from "@pocketjs/framework/input";
import { getOps } from "@pocketjs/framework";
import { TermGrid } from "./grid.tsx";
import { KB_H, Keyboard } from "./keyboard.tsx";
import { connectSvc } from "./svc.ts";
import { createTermStore } from "./store.ts";

/* Grid geometry. The 12 px mono atlas is slot 16 (spec MONO_FONT_PX);
 * `font-mono text-xs` in grid.tsx is what makes the build bake it. The
 * natural advance (~7.2 px) is snapped down to a 7 px integer cell with
 * negative tracking so every column lands on a pixel. */
const MONO_SLOT = 16;
const STATUS_H = 14;
const CELL_H = 13;

const TAB_H = 26;
const TAB_W = 72;
/** The close target on the active tab, measured from its right edge. */
const TAB_CLOSE_W = 18;
const KB_TOP = 240 - KB_H;

const DPAD_KEYS: readonly [number, "Up" | "Down" | "Left" | "Right"][] = [
  [BTN.UP, "Up"],
  [BTN.DOWN, "Down"],
  [BTN.LEFT, "Left"],
  [BTN.RIGHT, "Right"],
];
const DPAD_DELAY = 18;
const DPAD_REPEAT = 4;

export default function TermApp() {
  const ops = getOps();
  const advance = ops.measureText("M", MONO_SLOT);
  const CELL_W = advance > 0 ? Math.max(6, Math.round(advance)) : 7;
  const TRACK = advance > 0 ? CELL_W - advance : 0;
  const COLS = Math.floor(400 / CELL_W);
  const ROWS = Math.floor((240 - STATUS_H) / CELL_H);

  const svc = connectSvc();
  const store = createTermStore({ cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H] }, svc);
  /** The touch keyboard's one-shot Ctrl: armed by its cap, spent by the next
   *  key. Holding L is the other way in, and the cap lights for both. */
  const [ctrlArmed, setCtrlArmed] = createSignal(false);
  const [ctrlHeld, setCtrlHeld] = createSignal(false);
  const ctrlActive = () => ctrlArmed() || ctrlHeld();

  const dpadHeld = new Map<number, number>();
  let scrollCarry = 0;

  let prevButtons = 0;

  onFrame((buttons) => {
    store.frame();

    const pressed = buttons & ~prevButtons;
    prevButtons = buttons;
    setCtrlHeld((buttons & BTN.ZL) !== 0);

    let sentThisFrame = false;
    const send = (key: string, ctrl: boolean) => {
      store.sendKey(key, ctrl);
      sentThisFrame = true;
    };

    // The d-pad repeats; everything else fires on its press edge. All of it
    // is level-tested here rather than through onButtonPress so a key can
    // read the modifier held on the same frame.
    for (const [mask, keyName] of DPAD_KEYS) {
      if (buttons & mask) {
        const held = (dpadHeld.get(mask) ?? 0) + 1;
        dpadHeld.set(mask, held);
        if (held === 1 || (held > DPAD_DELAY && (held - DPAD_DELAY) % DPAD_REPEAT === 0)) {
          send(keyName, ctrlActive());
        }
      } else {
        dpadHeld.set(mask, 0);
      }
    }
    for (const [mask, key] of FACE_KEYS) {
      if (pressed & mask) send(key, ctrlActive());
    }
    if (pressed & BTN.START) send("c", true);
    if (pressed & BTN.SELECT) store.newSession();

    if (sentThisFrame && ctrlArmed()) setCtrlArmed(false);

    if (pressed & BTN.LTRIGGER) store.attachSibling(-1);
    if (pressed & BTN.RTRIGGER) store.attachSibling(1);

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

  // Session tab strip on the touch screen: tap a tab to attach, its × to
  // close that session, the trailing + to open one.
  let tabsNode: NodeMirror | undefined;
  createGesture({
    surface: "auxiliary",
    region: { node: () => tabsNode },
    onDown: (contact) => {
      const list = store.sessions();
      const index = Math.floor(contact.x / TAB_W);
      if (index >= list.length) {
        if (index === list.length) store.newSession();
        return;
      }
      const session = list[index];
      const withinTab = contact.x - index * TAB_W;
      if (session.sid === store.activeSid() && withinTab >= TAB_W - TAB_CLOSE_W) {
        store.kill(session.sid);
        return;
      }
      store.attach(session.sid);
    },
  });

  return (
    <>
      <TermGrid
        store={store}
        metrics={{ cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H }}
        badge={`${COLS}×${ROWS}`}
        hint="on the Mac: node apps/term/host/serve.ts"
        emptyHint="SELECT opens one · or tap + on the touch screen"
        title="POCKET TERM"
      />

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
                    <View
                      class="absolute top-0 bottom-0 items-center justify-center bg-[#3b4560]"
                      style={{ insetR: 0, width: TAB_CLOSE_W }}
                      debugName="TabClose"
                    >
                      <Text class="text-xs text-[#9fb6d8]">×</Text>
                    </View>
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
              <Text class="text-xs text-[#3d4c63]">SELECT new · L/R switch · hold ZL = ctrl</Text>
              <Text class="text-xs text-[#3d4c63]">
                {store.dynamicGlyphs() > 0
                  ? `pad scrolls · ${store.dynamicGlyphs()} runtime glyphs`
                  : "pad scrolls history · A ⏎ · B ⌫"}
              </Text>
            </View>
          </View>

          <Keyboard
            top={KB_TOP}
            onChar={(ch) => {
              store.sendText(ch);
              setCtrlArmed(false);
            }}
            onKey={(name, ctrl) => store.sendKey(name, ctrl || ctrlHeld())}
            ctrlArmed={ctrlActive}
            setCtrlArmed={setCtrlArmed}
          />
        </View>
      </AuxiliarySurface>
    </>
  );
}

/** Face buttons that send a key, level-tested so a held Ctrl applies. */
const FACE_KEYS: readonly [number, string][] = [
  [BTN.CIRCLE, "Enter"],
  [BTN.CROSS, "Backspace"],
  [BTN.TRIANGLE, "Tab"],
  [BTN.SQUARE, "Space"],
];
