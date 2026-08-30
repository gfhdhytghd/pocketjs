// apps/term/host/serve.ts — the Mac companion daemon for apps/term.
//
//   bun install    (once, in this directory — node-pty + @xterm/headless)
//   node serve.ts  [--port 8622] [--beacon-port 8621] [--name <picker name>]
//                  [--shell /bin/zsh] [--unicast <device-ip>] [--no-beacon]
//
// Node (>= 23.6, for native type stripping), NOT bun: under Bun this
// machine's node-pty never execs the child — its spawn-helper blocks forever
// in the slave-reattach open() — while the same call under Node works. The
// PTY is the one dependency that dictates the runtime; everything else here
// is runtime-neutral.
//
// Architecture (the zhongduan shape, collapsed to one process): this daemon
// holds the real PTYs and one authoritative @xterm/headless core per session
// — the role Ghostty WASM plays there — and 3DS clients attach as passive
// replicas over the SVC WIRE (PKNT) TCP transport. A UDP beacon on the LAN
// makes discovery zero-config; grid state flows as a full snapshot on attach
// plus ordered row diffs after, all inside gen/seq fences so a lossy device
// queue degrades into a resync, never into a wrong screen.

import { createServer, type Socket } from "node:net";
import { createSocket } from "node:dgram";
import { hostname } from "node:os";
import { chmodSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
// @xterm/headless is CJS; Node's ESM loader only offers its default export.
import xterm from "@xterm/headless";
import type { Terminal as TerminalType } from "@xterm/headless";

const { Terminal } = xterm;
import {
  LINE_BUDGET,
  TERM_APP,
  TERM_PROTO,
  type ClientLine,
  type Cursor,
  type HostLine,
  type RowUpdate,
  type Run,
  type SessionInfo,
} from "../protocol.ts";
import { chunkRows, resolveCell, rowKey, rowRuns, type Cell } from "./grid.ts";
import { encodeKey } from "./keys.ts";
import {
  FrameParser,
  WIRE_BEACON_PORT,
  WIRE_MSG,
  WIRE_PORT,
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "./wire.ts";

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

const options = {
  port: WIRE_PORT,
  beaconPort: WIRE_BEACON_PORT,
  name: hostname().replace(/\.local$/, ""),
  shell: process.env.SHELL ?? "/bin/zsh",
  cwd: process.env.HOME ?? process.cwd(),
  unicast: [] as string[],
  beacon: true,
};

{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") options.port = Number(argv[++i]);
    else if (a === "--beacon-port") options.beaconPort = Number(argv[++i]);
    else if (a === "--name") options.name = argv[++i];
    else if (a === "--shell") options.shell = argv[++i];
    else if (a === "--cwd") options.cwd = argv[++i];
    else if (a === "--unicast") options.unicast.push(argv[++i]);
    else if (a === "--no-beacon") options.beacon = false;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
}

// Bun's installer drops the executable bit on prebuilt binaries; node-pty's
// posix_spawn of its helper then fails with a bare "posix_spawnp failed".
for (const helper of [
  join(
    dirname(fileURLToPath(import.meta.url)),
    "node_modules/node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  ),
]) {
  if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
}

// ---------------------------------------------------------------------------
// sessions — PTY + authoritative terminal core
// ---------------------------------------------------------------------------

const SCROLLBACK = 2000;

class Session {
  readonly sid: number;
  title: string;
  readonly term: TerminalType;
  readonly pty: pty.IPty;
  /** Bumped on any parsed output; flush cycles reset it. */
  dirty = true;
  bellPending = false;
  disposed = false;

  constructor(sid: number, cols: number, rows: number) {
    this.sid = sid;
    this.title = `${options.shell.split("/").pop()} #${sid}`;
    this.term = new Terminal({ cols, rows, scrollback: SCROLLBACK, allowProposedApi: true });
    this.pty = pty.spawn(options.shell, ["-il"], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    this.pty.onData((data) => {
      this.term.write(data, () => {
        this.dirty = true;
      });
    });
    this.pty.onExit(() => hub.sessionExited(this.sid));
    this.term.onBell(() => {
      this.bellPending = true;
    });
    this.term.onTitleChange((title) => {
      if (title.trim() !== "") {
        this.title = `${title.slice(0, 24)} #${sid}`;
        hub.sessionsChanged();
      }
    });
  }

  resize(cols: number, rows: number) {
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
    this.pty.resize(cols, rows);
    this.dirty = true;
  }

  write(data: string) {
    if (data.length > 0) this.pty.write(data);
  }

  appCursor(): boolean {
    try {
      return this.term.modes.applicationCursorKeysMode === true;
    } catch {
      return false;
    }
  }

  cursorHidden(): boolean {
    const core = (
      this.term as unknown as {
        _core?: { coreService?: { isCursorHidden?: boolean; decPrivateModes?: { cursorHidden?: boolean } } };
      }
    )._core;
    return core?.coreService?.isCursorHidden ?? core?.coreService?.decPrivateModes?.cursorHidden ?? false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      /* already gone */
    }
    this.term.dispose();
  }
}

// ---------------------------------------------------------------------------
// connections — one attached replica each
// ---------------------------------------------------------------------------

const PING_INTERVAL_MS = 2000;
const SILENCE_TIMEOUT_MS = 10_000;
const FLUSH_INTERVAL_MS = 33;

class Conn {
  readonly socket: Socket;
  readonly parser = new FrameParser();
  hello: Uint8Array | null = new Uint8Array(0);
  cols = 80;
  rows = 24;
  attachedSid = -1;
  gen = 0;
  seq = 0;
  scrollback = 0;
  rowCache: string[] = [];
  lastCursor = "";
  lastRx = Date.now();
  sawClientHello = false;

  constructor(socket: Socket) {
    this.socket = socket;
  }

  sendLine(line: HostLine) {
    this.socket.write(encodeCtrl(JSON.stringify(line)));
  }

  /** Emit rows (+cursor/scrollback trailer) as ordered, chunked grid lines. */
  sendGrid(updates: RowUpdate[], cursor: Cursor, full: boolean) {
    const chunks = chunkRows(updates, LINE_BUDGET);
    for (let i = 0; i < chunks.length; i += 1) {
      const last = i === chunks.length - 1;
      this.sendLine({
        t: "grid",
        sid: this.attachedSid,
        gen: this.gen,
        seq: this.seq++,
        ...(full ? { full: 1 as const } : {}),
        ...(last ? {} : { more: 1 as const }),
        rows: chunks[i],
        ...(last ? { cur: cursor, sb: this.scrollback } : {}),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// the hub
// ---------------------------------------------------------------------------

class Hub {
  readonly sessions = new Map<number, Session>();
  readonly conns = new Set<Conn>();
  private nextSid = 1;

  create(cols: number, rows: number): Session {
    const session = new Session(this.nextSid++, cols, rows);
    this.sessions.set(session.sid, session);
    this.sessionsChanged();
    return session;
  }

  kill(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  sessionExited(sid: number) {
    const session = this.sessions.get(sid);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sid);
    for (const conn of this.conns) {
      if (conn.sawClientHello) conn.sendLine({ t: "exit", sid });
    }
    this.reattachOrphans(sid);
    this.sessionsChanged();
  }

  private reattachOrphans(gone: number) {
    for (const conn of this.conns) {
      if (conn.attachedSid !== gone) continue;
      const fallback = [...this.sessions.values()].at(-1) ?? this.create(conn.cols, conn.rows);
      attach(conn, fallback.sid);
    }
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({ sid: s.sid, title: s.title }));
  }

  sessionsChanged() {
    for (const conn of this.conns) {
      if (conn.sawClientHello) {
        conn.sendLine({ t: "sessions", list: this.list(), active: conn.attachedSid });
      }
    }
  }
}

const hub = new Hub();

// ---------------------------------------------------------------------------
// the replica view: serialize, diff, flush
// ---------------------------------------------------------------------------

/** Resolve the connection's visible window of the session buffer to runs. */
function viewRows(session: Session, conn: Conn): Run[][] {
  const buffer = session.term.buffer.active;
  const top = Math.max(0, buffer.baseY - conn.scrollback);
  const workCell = buffer.getNullCell();
  const rows: Run[][] = [];
  for (let y = 0; y < conn.rows; y += 1) {
    const line = buffer.getLine(top + y);
    const cells: Cell[] = [];
    if (line) {
      for (let x = 0; x < conn.cols; x += 1) {
        const cell = line.getCell(x, workCell);
        cells.push(cell ? resolveCell(cell) : { ch: "", fg: -1, bg: -1 });
      }
    }
    rows.push(rowRuns(cells));
  }
  return rows;
}

function cursorFor(session: Session, conn: Conn): Cursor {
  const buffer = session.term.buffer.active;
  const visible = conn.scrollback === 0 && !session.cursorHidden();
  return [buffer.cursorX, buffer.cursorY, visible ? 1 : 0];
}

/** Full snapshot: a new gen, every row sent (blank rows included). */
function snapshot(conn: Conn) {
  const session = hub.sessions.get(conn.attachedSid);
  if (!session) return;
  conn.gen += 1;
  conn.seq = 0;
  const rows = viewRows(session, conn);
  conn.rowCache = rows.map(rowKey);
  const cursor = cursorFor(session, conn);
  conn.lastCursor = JSON.stringify([cursor, conn.scrollback]);
  const updates: RowUpdate[] = rows.map((runs, y) => [y, ...runs]);
  conn.sendGrid(updates, cursor, true);
}

function flush(conn: Conn) {
  const session = hub.sessions.get(conn.attachedSid);
  if (!session || !conn.sawClientHello) return;
  if (session.bellPending) {
    // Bells are per-session; deliver once to every attached replica.
    for (const other of hub.conns) {
      if (other.attachedSid === session.sid && other.sawClientHello) {
        other.sendLine({ t: "bell", sid: session.sid });
      }
    }
    session.bellPending = false;
  }
  const rows = viewRows(session, conn);
  const updates: RowUpdate[] = [];
  for (let y = 0; y < rows.length; y += 1) {
    const key = rowKey(rows[y]);
    if (conn.rowCache[y] !== key) {
      conn.rowCache[y] = key;
      updates.push([y, ...rows[y]]);
    }
  }
  const cursor = cursorFor(session, conn);
  const cursorKey = JSON.stringify([cursor, conn.scrollback]);
  if (updates.length === 0 && cursorKey === conn.lastCursor) return;
  conn.lastCursor = cursorKey;
  conn.sendGrid(updates, cursor, false);
}

function attach(conn: Conn, sid: number) {
  if (!hub.sessions.has(sid)) return;
  conn.attachedSid = sid;
  conn.scrollback = 0;
  conn.sendLine({ t: "sessions", list: hub.list(), active: sid });
  snapshot(conn);
}

// ---------------------------------------------------------------------------
// client line handling
// ---------------------------------------------------------------------------

function handleLine(conn: Conn, line: ClientLine) {
  switch (line.t) {
    case "hello": {
      if (line.proto !== TERM_PROTO) return;
      conn.cols = Math.max(20, Math.min(120, line.cols));
      conn.rows = Math.max(5, Math.min(50, line.rows));
      conn.sawClientHello = true;
      conn.sendLine({ t: "hello", proto: TERM_PROTO, name: options.name });
      // The demo convention: every session tracks the replica's grid (the
      // tmux attach model, one window size at a time). Replicas that were
      // already attached at another size get a fresh snapshot at the new one.
      for (const session of hub.sessions.values()) session.resize(conn.cols, conn.rows);
      for (const other of hub.conns) {
        if (other === conn || !other.sawClientHello) continue;
        if (other.cols !== conn.cols || other.rows !== conn.rows) {
          other.cols = conn.cols;
          other.rows = conn.rows;
          snapshot(other);
        }
      }
      const target = [...hub.sessions.values()].at(-1) ?? hub.create(conn.cols, conn.rows);
      attach(conn, target.sid);
      break;
    }
    case "new": {
      const session = hub.create(conn.cols, conn.rows);
      attach(conn, session.sid);
      break;
    }
    case "kill":
      hub.kill(line.sid);
      break;
    case "attach":
      attach(conn, line.sid);
      break;
    case "ch": {
      const session = hub.sessions.get(conn.attachedSid);
      if (session && line.s.length <= 1024) {
        if (conn.scrollback !== 0) conn.scrollback = 0; // typing snaps to live
        session.write(line.s);
      }
      break;
    }
    case "key": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      if (conn.scrollback !== 0) conn.scrollback = 0;
      session.write(encodeKey(line.k, line.ctrl === 1, line.alt === 1, session.appCursor()));
      break;
    }
    case "scroll": {
      const session = hub.sessions.get(conn.attachedSid);
      if (!session) break;
      const max = session.term.buffer.active.baseY;
      conn.scrollback = Math.max(0, Math.min(max, conn.scrollback + line.d));
      break;
    }
    case "resync":
      snapshot(conn);
      break;
  }
}

// ---------------------------------------------------------------------------
// wire server + beacon
// ---------------------------------------------------------------------------

const server = createServer((socket) => {
  socket.setNoDelay(true);
  const conn = new Conn(socket);

  socket.on("data", (chunk: Buffer) => {
    conn.lastRx = Date.now();
    let bytes = new Uint8Array(chunk);
    try {
      if (conn.hello !== null) {
        const merged = new Uint8Array(conn.hello.length + bytes.length);
        merged.set(conn.hello);
        merged.set(bytes, conn.hello.length);
        const hello = parseHello(merged);
        if (hello === null) {
          conn.hello = merged;
          return;
        }
        if (hello.app !== TERM_APP) throw new Error(`unknown app "${hello.app}"`);
        conn.hello = null;
        socket.write(encodeHelloAck());
        hub.conns.add(conn);
        console.log(`[term] device connected (${socket.remoteAddress ?? "?"})`);
        bytes = merged.slice(hello.consumed);
        if (bytes.length === 0) return;
      }
      for (const frame of conn.parser.push(bytes)) {
        if (frame.type === WIRE_MSG.pong) continue;
        if (frame.type !== WIRE_MSG.ctrl) continue; // forward compatibility
        const text = new TextDecoder().decode(frame.payload);
        try {
          handleLine(conn, JSON.parse(text) as ClientLine);
        } catch {
          // A malformed device line is a device bug; skip it rather than drop.
        }
      }
    } catch (error) {
      console.log(`[term] dropping device: ${(error as Error).message}`);
      socket.destroy();
    }
  });

  const cleanup = () => {
    hub.conns.delete(conn);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);
});

let pingToken = 1;
setInterval(() => {
  const now = Date.now();
  for (const conn of hub.conns) {
    if (now - conn.lastRx > SILENCE_TIMEOUT_MS) {
      console.log("[term] device silent, dropping");
      conn.socket.destroy();
      hub.conns.delete(conn);
      continue;
    }
    const token = new Uint8Array(4);
    new DataView(token.buffer).setUint32(0, pingToken++ >>> 0, true);
    conn.socket.write(encodeFrame(WIRE_MSG.ping, token));
  }
}, PING_INTERVAL_MS);

setInterval(() => {
  for (const conn of hub.conns) flush(conn);
}, FLUSH_INTERVAL_MS);

function startBeacon(tcpPort: number) {
  const beacon = createSocket("udp4");
  beacon.bind(() => {
    beacon.setBroadcast(true);
    const datagram = Buffer.from(encodeBeacon(TERM_APP, options.name, tcpPort));
    const targets = ["255.255.255.255", "127.0.0.1", ...options.unicast];
    setInterval(() => {
      for (const target of targets) {
        beacon.send(datagram, options.beaconPort, target, () => {});
      }
    }, 1000);
    console.log(`[term] beacon on udp/${options.beaconPort} -> ${targets.join(", ")}`);
  });
}

const started = () => {
  const bound = (server.address() as { port: number }).port;
  console.log(`[term] PKNT listener on tcp/${bound} (app "${TERM_APP}")`);
  if (options.beacon) startBeacon(bound);
};

// Several companions can share one machine (the pocket-youtube host also
// speaks PKNT): the beacon advertises the actual TCP port, so when the
// default is taken we fall back to an ephemeral one.
server.once("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.log(`[term] tcp/${options.port} is taken — falling back to an ephemeral port`);
  server.listen(0);
});
server.once("listening", started);
server.listen(options.port);

console.log(`[term] shell ${options.shell}, host name "${options.name}"`);
