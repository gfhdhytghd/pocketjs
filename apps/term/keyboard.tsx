// apps/term/keyboard.tsx — the bottom-screen touch keyboard. The framework
// Osk renders through Portal, which sizes itself from the PRIMARY viewport,
// so a touch keyboard on the 3DS bottom screen is laid out by hand instead:
// a fixed grid of 26 px rows on a 32 px column unit (10 units = the 320 px
// panel), hit by one auxiliary-surface gesture on the keyboard root.
//
// Row 0 is the terminal action strip (Esc/Tab/Ctrl/^C/arrows/paging); rows
// 1..4 are the character layers. Shift and Ctrl are one-shot: they arm, the
// next key consumes them — the classic touch-phone convention, and the only
// one that works with a single resistive contact.

import { createSignal, For } from "solid-js";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { KeyName } from "./protocol.ts";

export const KEY_H = 26;
export const KB_ROWS = 5;
export const KB_H = KEY_H * KB_ROWS;
/** 10 column units of 32 px = the 320 px auxiliary panel. */
const UNIT = 32;

export type KeyAction =
  | { ch: string; ctrl?: boolean }
  | { key: KeyName }
  | { layer: LayerName }
  | { mod: "shift" | "ctrl" };

export type LayerName = "lower" | "upper" | "sym" | "sym2";

interface KeyDef {
  label: string;
  w: number;
  act: KeyAction;
  /** Painted darker, like the classic keyboard's function keys. */
  dark?: boolean;
}

const k = (label: string, w = 1): KeyDef => ({ label, w, act: { ch: label } });
const key = (label: string, name: KeyName, w = 1): KeyDef => ({
  label,
  w,
  act: { key: name },
  dark: true,
});
const layer = (label: string, target: LayerName, w = 1): KeyDef => ({
  label,
  w,
  act: { layer: target },
  dark: true,
});

/** The action strip is layer-independent. ^C rides the key path with the
 *  ctrl flag so the daemon encodes the control byte. */
const ACTION_ROW: KeyDef[] = [
  key("esc", "Escape"),
  key("tab", "Tab"),
  { label: "ctl", w: 1, act: { mod: "ctrl" }, dark: true },
  { label: "^C", w: 1, act: { ch: "c", ctrl: true }, dark: true },
  key("←", "Left"),
  key("↓", "Down"),
  key("↑", "Up"),
  key("→", "Right"),
  key("pgu", "PageUp"),
  key("pgd", "PageDown"),
];

function charRow(chars: string): KeyDef[] {
  return [...chars].map((ch) => k(ch));
}

const LAYERS: Record<LayerName, KeyDef[][]> = {
  lower: [
    charRow("qwertyuiop"),
    charRow("asdfghjkl'"),
    [{ label: "⇧", w: 1.5, act: { mod: "shift" }, dark: true }, ...charRow("zxcvbnm"), key("⌫", "Backspace", 1.5)],
    [layer("?123", "sym", 1.5), k("-"), { label: "space", w: 4, act: { ch: " " } }, k("/"), k("."), key("⏎", "Enter", 1.5)],
  ],
  upper: [
    charRow("QWERTYUIOP"),
    charRow("ASDFGHJKL\""),
    [{ label: "⬆", w: 1.5, act: { mod: "shift" }, dark: true }, ...charRow("ZXCVBNM"), key("⌫", "Backspace", 1.5)],
    [layer("?123", "sym", 1.5), k("_"), { label: "space", w: 4, act: { ch: " " } }, k("?"), k("!"), key("⏎", "Enter", 1.5)],
  ],
  sym: [
    charRow("1234567890"),
    charRow("!@#$%^&*()"),
    [layer("#{~", "sym2", 1.5), ...charRow("-_=+[];"), key("⌫", "Backspace", 1.5)],
    [layer("abc", "lower", 1.5), k(":"), { label: "space", w: 4, act: { ch: " " } }, k(","), k("."), key("⏎", "Enter", 1.5)],
  ],
  sym2: [
    charRow("~`|\\{}<>\"'"),
    charRow("/?*+-=%$#@"),
    [layer("?123", "sym", 1.5), ...charRow("&^!.,;"), k(":"), key("⌫", "Backspace", 1.5)],
    [layer("abc", "lower", 1.5), k("("), { label: "space", w: 4, act: { ch: " " } }, k(")"), k("."), key("⏎", "Enter", 1.5)],
  ],
};

interface KeyHit {
  row: number;
  index: number;
  def: KeyDef;
}

function rowsFor(name: LayerName): KeyDef[][] {
  return [ACTION_ROW, ...LAYERS[name]];
}

/** Key under a point in keyboard-local coordinates, or null in a gap. */
export function keyAt(layerName: LayerName, x: number, y: number): KeyHit | null {
  const row = Math.floor(y / KEY_H);
  const rows = rowsFor(layerName);
  if (row < 0 || row >= rows.length) return null;
  let at = 0;
  for (let index = 0; index < rows[row].length; index += 1) {
    const def = rows[row][index];
    const width = def.w * UNIT;
    if (x >= at && x < at + width) return { row, index, def };
    at += width;
  }
  return null;
}

export interface KeyboardProps {
  top: number;
  onChar: (ch: string) => void;
  /** `name` is a KeyName, or a single character when ctrl is held. */
  onKey: (name: string, ctrl: boolean) => void;
  /** One-shot Ctrl arms here; the next character key consumes it. */
  ctrlArmed: () => boolean;
  setCtrlArmed: (on: boolean) => void;
}

export function Keyboard(props: KeyboardProps) {
  const [layerName, setLayerName] = createSignal<LayerName>("lower");
  const [pressed, setPressed] = createSignal<string | null>(null);
  let rootNode: NodeMirror | undefined;
  let releaseTimer = 0;

  const press = (hit: KeyHit) => {
    setPressed(`${hit.row}:${hit.index}`);
    releaseTimer = 4;
    const act = hit.def.act;
    if ("ch" in act) {
      if (act.ctrl || props.ctrlArmed()) {
        props.onKey(act.ch, true);
        props.setCtrlArmed(false);
      } else {
        props.onChar(act.ch);
      }
      if (layerName() === "upper") setLayerName("lower"); // one-shot shift
    } else if ("key" in act) {
      props.onKey(act.key, props.ctrlArmed());
      props.setCtrlArmed(false);
    } else if ("layer" in act) {
      setLayerName(act.layer);
    } else if ("mod" in act) {
      if (act.mod === "shift") setLayerName(layerName() === "upper" ? "lower" : "upper");
      else props.setCtrlArmed(!props.ctrlArmed());
    }
  };

  createGesture({
    surface: "auxiliary",
    region: { node: () => rootNode },
    onDown: (contact) => {
      const hit = keyAt(layerName(), contact.x, contact.y - props.top);
      if (hit) press(hit);
    },
    onUp: () => {},
  });

  // The pressed flash decays on a frame budget.
  onFrame(() => {
    if (releaseTimer > 0 && --releaseTimer === 0) setPressed(null);
  });

  return (
    <View
      ref={(node) => (rootNode = node)}
      class="absolute left-0 right-0 bg-[#141a24]"
      style={{ insetT: props.top, height: KB_H }}
      debugName="TermKeyboard"
    >
      <For each={[0, 1, 2, 3, 4]}>
        {(row) => (
          <View class="absolute left-0 right-0" style={{ insetT: row * KEY_H, height: KEY_H }}>
            <KeyboardRow
              row={row}
              layer={layerName()}
              pressed={pressed()}
              ctrlArmed={props.ctrlArmed()}
            />
          </View>
        )}
      </For>
    </View>
  );
}

function KeyboardRow(props: {
  row: number;
  layer: LayerName;
  pressed: string | null;
  ctrlArmed: boolean;
}) {
  const defs = () => rowsFor(props.layer)[props.row];
  return (
    <For each={defs()}>
      {(def, index) => {
        const left = () =>
          defs()
            .slice(0, index())
            .reduce((x, d) => x + d.w * UNIT, 0);
        const isPressed = () => props.pressed === `${props.row}:${index()}`;
        const isArmedCtrl = () => "mod" in def.act && def.act.mod === "ctrl" && props.ctrlArmed;
        return (
          <View
            class="absolute"
            style={{ insetL: left() + 2, width: def.w * UNIT - 4, height: KEY_H - 4, insetT: 2 }}
          >
            <View
              class={
                isPressed() || isArmedCtrl()
                  ? "w-full h-full rounded-[4] bg-[#4c9bf5] items-center justify-center"
                  : def.dark
                    ? "w-full h-full rounded-[4] bg-[#232d3d] items-center justify-center"
                    : "w-full h-full rounded-[4] bg-[#31394a] items-center justify-center"
              }
            >
              <Text class="text-xs text-[#dfe6f2]">{def.label}</Text>
            </View>
          </View>
        );
      }}
    </For>
  );
}

/** All key labels, spelled once as literals for the atlas scan. */
export const KEYBOARD_GLYPHS =
  "qwertyuiopasdfghjkl'zxcvbnm-/.QWERTYUIOPASDFGHJKL\"ZXCVBNM_?!1234567890@#$%^&*()=+[];~`|\\{}<>,:esctabctl^Cpgupgdspaceabc⇧⬆⌫⏎←↑→↓";
