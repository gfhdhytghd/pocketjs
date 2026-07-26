// Direct-touch activation contract: a touch-only host must drive the same
// focus/active/onPress path as CIRCLE and the virtual cursor.
//
// Run: bun test --conditions=browser tests/touch-press.test.ts

import { beforeEach, describe, expect, test } from "bun:test";

import { installHost, type Host, type HostOps } from "../framework/src/host.ts";
import {
  enableTouchPress,
  getFocused,
  handleFrame,
  isTouchPressEnabled,
  notifyDetached,
  resetInput,
  setHitRoot,
  setInputRoot,
} from "../framework/src/input.ts";
import type { NodeMirror } from "../framework/src/renderer.ts";
import { __packTouch, __resetTouches, __setTouches } from "../framework/src/touch.ts";
import { BTN, NODE_TYPE, ROOT_ID } from "../contracts/spec/spec.ts";

type Call = [string, ...unknown[]];

interface TouchMockHost extends Host {
  calls: Call[];
  hitResult: number;
}

function makeHost(): TouchMockHost {
  const calls: Call[] = [];
  const host: TouchMockHost = {
    kind: "injected",
    target: "test",
    strict: true,
    calls,
    hitResult: 0,
    ops: {} as HostOps,
  };
  host.ops = {
    createNode: () => 0,
    destroyNode: () => {},
    insertBefore: () => {},
    removeChild: () => {},
    setStyle: () => {},
    setProp: () => {},
    setText: () => {},
    replaceText: () => {},
    uploadTexture: () => 0,
    setImage: () => {},
    setSprite: () => {},
    animate: () => 0,
    cancelAnim: () => {},
    setFocus: (id) => calls.push(["setFocus", id]),
    setActive: (id, active) => calls.push(["setActive", id, active]),
    measureText: () => 0,
    hitTest: () => host.hitResult,
  };
  return host;
}

function node(
  id: number,
  parent: NodeMirror | null,
  extra: Partial<NodeMirror> = {},
): NodeMirror {
  const value: NodeMirror = {
    id,
    type: NODE_TYPE.view,
    parent,
    children: [],
    ...extra,
  };
  parent?.children.push(value);
  return value;
}

let host: TouchMockHost;
let root: NodeMirror;
let disableTouchPress: () => void;

function frame(contacts: readonly number[], buttons = 0): void {
  __setTouches(contacts);
  handleFrame(buttons);
}

beforeEach(() => {
  host = makeHost();
  installHost(host);
  resetInput();
  __resetTouches();
  root = node(ROOT_ID, null);
  setInputRoot(root);
  setHitRoot(root);
  disableTouchPress = enableTouchPress();
});

describe("direct touch press", () => {
  test("is inert until an app explicitly opts in", () => {
    resetInput();
    setInputRoot(root);
    setHitRoot(root);
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;

    frame([__packTouch(1, 20, 20)]);
    frame([]);

    expect(getFocused()).toBeNull();
    expect(presses).toBe(0);
  });

  test("focuses and activates on down, then bubbles onPress on release", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    const label = node(6, button, { type: NODE_TYPE.text });
    host.hitResult = label.id;

    frame([__packTouch(2, 100, 200)]);
    expect(getFocused()).toBe(button);
    expect(host.calls).toContainEqual(["setActive", button.id, 1]);
    expect(presses).toBe(0);

    frame([]);
    expect(host.calls).toContainEqual(["setActive", button.id, 0]);
    expect(presses).toBe(1);
  });

  test("leaving the armed target cancels release; re-enter restores active", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    frame([__packTouch(1, 20, 20)]);

    host.hitResult = ROOT_ID;
    frame([__packTouch(1, 200, 200)]);
    expect(host.calls.at(-1)).toEqual(["setActive", button.id, 0]);
    frame([]);
    expect(presses).toBe(0);

    host.hitResult = button.id;
    frame([__packTouch(2, 20, 20)]);
    host.hitResult = ROOT_ID;
    frame([__packTouch(2, 200, 200)]);
    host.hitResult = button.id;
    frame([__packTouch(2, 20, 20)]);
    expect(host.calls.at(-1)).toEqual(["setActive", button.id, 1]);
    frame([]);
    expect(presses).toBe(1);
  });

  test("a detached target cancels the contact and cannot fire later", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    frame([__packTouch(1, 20, 20)]);
    notifyDetached(button);
    frame([]);
    expect(presses).toBe(0);
  });

  test("touch ownership suppresses a simultaneous CIRCLE double press", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    frame([__packTouch(1, 20, 20)]);
    frame([], BTN.CIRCLE);
    frame([], BTN.CIRCLE);
    expect(presses).toBe(1);
  });

  test("keeps OSK arbitration enabled until the final touch owner disposes", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;
    const disableNestedOwner = enableTouchPress();

    frame([__packTouch(1, 20, 20)]);
    disableTouchPress();
    expect(isTouchPressEnabled()).toBe(true);
    frame([]);
    expect(presses).toBe(1);

    // Disposers are idempotent and cannot release somebody else's token.
    disableTouchPress();
    expect(isTouchPressEnabled()).toBe(true);
    disableNestedOwner();
    expect(isTouchPressEnabled()).toBe(false);

    frame([__packTouch(2, 20, 20)]);
    frame([]);
    expect(presses).toBe(1);
  });

  test("a stale disposer cannot cancel an owner registered after reset", () => {
    const staleDisposer = disableTouchPress;
    resetInput();
    setInputRoot(root);
    setHitRoot(root);
    const currentDisposer = enableTouchPress();

    staleDisposer();
    expect(isTouchPressEnabled()).toBe(true);
    currentDisposer();
    expect(isTouchPressEnabled()).toBe(false);
  });

  test("the final owner still cancels an in-flight single-owner press", () => {
    let presses = 0;
    const button = node(5, root, { focusable: true, onPress: () => presses++ });
    host.hitResult = button.id;

    frame([__packTouch(1, 20, 20)]);
    disableTouchPress();
    frame([]);

    expect(isTouchPressEnabled()).toBe(false);
    expect(host.calls.at(-1)).toEqual(["setActive", button.id, 0]);
    expect(presses).toBe(0);
  });
});
