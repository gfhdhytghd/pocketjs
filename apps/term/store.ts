// apps/term/store.ts — the device-side replica state. The companion daemon
// owns terminal truth; this store only applies ordered grid updates onto
// per-row signals and turns UI intents into protocol lines. gen/seq guard the
// one lossy hop (the svc line queue drops oldest under backlog): a gap asks
// the host for a fresh snapshot instead of rendering from a hole.

import { createSignal, type Accessor } from "solid-js";
import {
  TERM_PROTO,
  type Cursor,
  type HostLine,
  type KeyName,
  type Run,
  type SessionInfo,
} from "./protocol.ts";
import type { Svc } from "./svc.ts";

export type ConnState = "no-svc" | "search" | "link" | "live";

/** 0xRRGGBB -> the ABGR u32 the engine's color props carry. */
export function rgbToAbgr(rgb: number): number {
  return (0xff000000 | ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >>> 16) & 0xff)) >>> 0;
}

const RESYNC_COOLDOWN_FRAMES = 30;

export interface TermStore {
  conn: Accessor<ConnState>;
  hostName: Accessor<string>;
  sessions: Accessor<SessionInfo[]>;
  activeSid: Accessor<number>;
  row(y: number): Accessor<Run[]>;
  cursor: Accessor<Cursor | null>;
  scrollback: Accessor<number>;
  bell: Accessor<boolean>;
  /** Pump the channel — call exactly once per frame. */
  frame(): void;
  sendText(s: string): void;
  /** `k` is a KeyName, or a single character when ctrl/alt is held. */
  sendKey(k: KeyName | string, ctrl?: boolean, alt?: boolean): void;
  scroll(lines: number): void;
  newSession(): void;
  killActive(): void;
  attach(sid: number): void;
  attachSibling(step: 1 | -1): void;
}

export function createTermStore(cols: number, rows: number, svc: Svc | null): TermStore {
  const [conn, setConn] = createSignal<ConnState>(svc === null ? "no-svc" : "search");
  const [hostName, setHostName] = createSignal("");
  const [sessions, setSessions] = createSignal<SessionInfo[]>([]);
  const [activeSid, setActiveSid] = createSignal(-1);
  const [cursor, setCursor] = createSignal<Cursor | null>(null);
  const [scrollback, setScrollback] = createSignal(0);
  const [bell, setBell] = createSignal(false);
  const rowSignals = Array.from({ length: rows }, () => createSignal<Run[]>([]));

  let wasOpen = false;
  let gen = -1;
  let seq = -1;
  let sawGrid = false;
  let resyncCooldown = 0;
  let bellFrames = 0;

  const clearGrid = () => {
    for (const [, set] of rowSignals) set([]);
    setCursor(null);
    setScrollback(0);
  };

  const requestResync = () => {
    if (resyncCooldown > 0) return;
    resyncCooldown = RESYNC_COOLDOWN_FRAMES;
    svc?.send({ t: "resync" });
  };

  const applyGrid = (line: Extract<HostLine, { t: "grid" }>) => {
    if (line.sid !== activeSid() && activeSid() !== -1) return;
    if (line.gen < gen) return;
    if (line.gen > gen) {
      // A gen opens with a full snapshot at seq 0; joining later means the
      // head was dropped somewhere and only a fresh snapshot can help.
      if (line.seq !== 0 || !line.full) {
        gen = line.gen; // remember it so the resync's higher gen adopts
        requestResync();
        return;
      }
      gen = line.gen;
      seq = -1;
      clearGrid();
    }
    if (line.seq !== seq + 1) {
      if (line.seq <= seq) return; // duplicate; TCP makes this a host bug
      requestResync();
      return;
    }
    seq = line.seq;
    for (const update of line.rows) {
      const [y, ...runs] = update;
      if (y >= 0 && y < rows) rowSignals[y][1](runs);
    }
    if (line.cur) setCursor(line.cur);
    if (line.sb !== undefined) setScrollback(line.sb);
    sawGrid = true;
    setConn("live");
  };

  const apply = (line: HostLine) => {
    switch (line.t) {
      case "hello":
        setHostName(line.name);
        break;
      case "sessions":
        setSessions(line.list);
        if (line.active !== activeSid()) {
          setActiveSid(line.active);
          // The snapshot for the new session is already on the wire.
        }
        break;
      case "grid":
        applyGrid(line);
        break;
      case "exit":
        // The host follows with a sessions line; nothing to do locally.
        break;
      case "bell":
        bellFrames = 8;
        setBell(true);
        break;
    }
  };

  const attach = (sid: number) => {
    if (sid !== activeSid()) svc?.send({ t: "attach", sid });
  };

  return {
    conn,
    hostName,
    sessions,
    activeSid,
    row: (y) => rowSignals[y][0],
    cursor,
    scrollback,
    bell,
    frame() {
      if (svc === null) return;
      if (resyncCooldown > 0) resyncCooldown -= 1;
      if (bellFrames > 0 && --bellFrames === 0) setBell(false);
      const open = svc.open();
      if (open && !wasOpen) {
        // Fresh transport (first frame or reconnect): re-introduce ourselves.
        gen = -1;
        seq = -1;
        sawGrid = false;
        svc.send({ t: "hello", proto: TERM_PROTO, cols, rows });
      }
      wasOpen = open;
      if (!open) {
        setConn("search");
        return;
      }
      if (conn() !== "live" || !sawGrid) setConn(sawGrid ? "live" : "link");
      for (const line of svc.poll()) apply(line);
    },
    sendText(s) {
      if (s.length > 0) svc?.send({ t: "ch", s });
    },
    sendKey(k, ctrl, alt) {
      svc?.send({ t: "key", k, ...(ctrl ? { ctrl: 1 as const } : {}), ...(alt ? { alt: 1 as const } : {}) });
    },
    scroll(lines) {
      if (lines !== 0) svc?.send({ t: "scroll", d: lines });
    },
    newSession() {
      svc?.send({ t: "new" });
    },
    killActive() {
      const sid = activeSid();
      if (sid >= 0) svc?.send({ t: "kill", sid });
    },
    attach,
    attachSibling(step) {
      const list = sessions();
      if (list.length < 2) return;
      const at = list.findIndex((s) => s.sid === activeSid());
      const next = list[(at + step + list.length) % list.length];
      if (next) attach(next.sid);
    },
  };
}
