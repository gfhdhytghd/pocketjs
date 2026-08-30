// tests/term-host.test.ts — the pure halves of the term companion daemon
// (apps/term/host): PKNT framing against the spec constants, SGR resolution
// and run building, chunk budgets, and key encoding. The daemon's PTY/xterm
// wiring itself is runtime-only (node-pty) and stays out of the unit stage.

import { describe, expect, test } from "bun:test";
import {
  SVC_POLL_BUF,
  WIRE_HEADER_SIZE,
  WIRE_MAGIC,
  WIRE_MSG,
  WIRE_VERSION,
} from "../contracts/spec/spec.ts";
import { LINE_BUDGET, THEME_BG, THEME_FG, type RowUpdate } from "../apps/term/protocol.ts";
import {
  FrameParser,
  encodeBeacon,
  encodeCtrl,
  encodeFrame,
  encodeHelloAck,
  parseHello,
} from "../apps/term/host/wire.ts";
import {
  PALETTE_256,
  chunkRows,
  resolveCell,
  rowRuns,
  type Cell,
  type XtermCellLike,
} from "../apps/term/host/grid.ts";
import { encodeKey } from "../apps/term/host/keys.ts";

// ---------------------------------------------------------------------------
// wire
// ---------------------------------------------------------------------------

describe("PKNT wire (host side)", () => {
  test("frame header layout matches the spec", () => {
    const frame = encodeFrame(WIRE_MSG.ctrl, new TextEncoder().encode("{}"));
    expect(frame.length).toBe(WIRE_HEADER_SIZE + 2);
    expect(frame[0]).toBe(WIRE_MSG.ctrl);
    expect(frame[1]).toBe(0);
    expect(new DataView(frame.buffer).getUint32(4, true)).toBe(2);
  });

  test("hello ack carries the wire magic + version", () => {
    const ack = encodeHelloAck();
    expect(new DataView(ack.buffer).getUint32(0, true)).toBe(WIRE_MAGIC);
    expect(ack[4]).toBe(WIRE_VERSION);
  });

  test("device hello roundtrip, incremental and with trailing bytes", () => {
    const app = "term";
    const hello = new Uint8Array(7 + app.length + 3);
    new DataView(hello.buffer).setUint32(0, WIRE_MAGIC, true);
    hello[4] = WIRE_VERSION;
    hello[6] = app.length;
    hello.set(new TextEncoder().encode(app), 7);
    expect(parseHello(hello.subarray(0, 5))).toBeNull(); // still short
    const parsed = parseHello(hello);
    expect(parsed).toEqual({ app: "term", consumed: 7 + app.length });
    expect(() => parseHello(new Uint8Array([1, 2, 3, 4, 5, 6, 7]))).toThrow("magic");
  });

  test("beacon layout: magic, version, port, app, name", () => {
    const beacon = encodeBeacon("term", "Mac", 8622);
    const view = new DataView(beacon.buffer);
    expect(view.getUint32(0, true)).toBe(0x42444b50);
    expect(beacon[4]).toBe(WIRE_VERSION);
    expect(view.getUint16(6, true)).toBe(8622);
    expect(beacon[8]).toBe(4);
    expect(new TextDecoder().decode(beacon.subarray(9, 13))).toBe("term");
    expect(beacon[13]).toBe(3);
  });

  test("FrameParser reassembles split and coalesced frames", () => {
    const a = encodeCtrl('{"t":"hello"}');
    const b = encodeFrame(WIRE_MSG.ping, new Uint8Array([1, 2, 3, 4]));
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a);
    stream.set(b, a.length);
    const parser = new FrameParser();
    expect(parser.push(stream.subarray(0, 3))).toEqual([]);
    const frames = [...parser.push(stream.subarray(3, a.length + 5)), ...parser.push(stream.subarray(a.length + 5))];
    expect(frames.length).toBe(2);
    expect(frames[0].type).toBe(WIRE_MSG.ctrl);
    expect(new TextDecoder().decode(frames[0].payload)).toBe('{"t":"hello"}');
    expect(frames[1].type).toBe(WIRE_MSG.ping);
    expect([...frames[1].payload]).toEqual([1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// grid
// ---------------------------------------------------------------------------

function fakeCell(over: Partial<Record<keyof XtermCellLike, unknown>> = {}): XtermCellLike {
  const base = {
    getChars: () => "x",
    getWidth: () => 1,
    getFgColor: () => -1,
    getBgColor: () => -1,
    isFgDefault: () => 1,
    isBgDefault: () => 1,
    isFgPalette: () => 0,
    isBgPalette: () => 0,
    isBold: () => 0,
    isDim: () => 0,
    isInverse: () => 0,
    isInvisible: () => 0,
  };
  return { ...base, ...over } as XtermCellLike;
}

describe("cell resolution (authority-side SGR)", () => {
  test("defaults stay -1", () => {
    expect(resolveCell(fakeCell())).toEqual({ ch: "x", fg: -1, bg: -1 });
  });

  test("bold brightens the low palette", () => {
    const cell = fakeCell({
      isFgDefault: () => 0,
      isFgPalette: () => 1,
      getFgColor: () => 1,
      isBold: () => 1,
    });
    expect(resolveCell(cell).fg).toBe(PALETTE_256[9]);
  });

  test("inverse swaps resolved theme colors", () => {
    const cell = fakeCell({ isInverse: () => 1 });
    expect(resolveCell(cell)).toEqual({ ch: "x", fg: THEME_BG, bg: THEME_FG });
  });

  test("truecolor passes through; wide-char continuations blank out", () => {
    const rgb = fakeCell({ isFgDefault: () => 0, getFgColor: () => 0x123456 });
    expect(resolveCell(rgb).fg).toBe(0x123456);
    expect(resolveCell(fakeCell({ getWidth: () => 0 })).ch).toBe("");
  });
});

describe("run building", () => {
  const cell = (ch: string, fg = -1, bg = -1): Cell => ({ ch, fg, bg });

  test("merges same-styled cells and interior blanks, drops the margins", () => {
    const cells = [
      cell(" "),
      cell("f", 1),
      cell("o", 1),
      cell(" "),
      cell("o", 1),
      cell(" "),
      cell(" "),
    ];
    expect(rowRuns(cells)).toEqual([[1, "fo o", 1, -1]]);
  });

  test("style changes split runs; background spaces stay runs", () => {
    const cells = [cell("a", 1), cell("b", 2), cell(" ", -1, 3)];
    expect(rowRuns(cells)).toEqual([
      [0, "a", 1, -1],
      [1, "b", 2, -1],
      [2, " ", -1, 3],
    ]);
  });

  test("an all-blank row is an empty update", () => {
    expect(rowRuns([cell(""), cell(" "), cell("")])).toEqual([]);
  });
});

describe("chunking", () => {
  test("keeps every emitted line under the svc poll buffer", () => {
    const updates: RowUpdate[] = Array.from({ length: 40 }, (_, y) => [
      y,
      [0, "x".repeat(120), 0x123456, 0x654321],
      [130, "y".repeat(120), 0xabcdef, -1],
    ]);
    const chunks = chunkRows(updates);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat()).toEqual(updates);
    for (const chunk of chunks) {
      const line = JSON.stringify({ t: "grid", sid: 1, gen: 2, seq: 3, rows: chunk, cur: [0, 0, 1], sb: 0 });
      expect(line.length).toBeLessThan(LINE_BUDGET);
      expect(line.length).toBeLessThan(SVC_POLL_BUF);
    }
  });
});

// ---------------------------------------------------------------------------
// keys
// ---------------------------------------------------------------------------

describe("key encoding", () => {
  test("named keys", () => {
    expect(encodeKey("Enter", false, false, false)).toBe("\r");
    expect(encodeKey("Backspace", false, false, false)).toBe("\x7f");
    expect(encodeKey("PageUp", false, false, false)).toBe("\x1b[5~");
  });

  test("DECCKM flips the arrows", () => {
    expect(encodeKey("Up", false, false, false)).toBe("\x1b[A");
    expect(encodeKey("Up", false, false, true)).toBe("\x1bOA");
  });

  test("control characters", () => {
    expect(encodeKey("c", true, false, false)).toBe("\x03");
    expect(encodeKey("d", true, false, false)).toBe("\x04");
    expect(encodeKey(" ", true, false, false)).toBe("\x00");
  });

  test("alt prefixes ESC; ctrl-modified arrows use CSI 1;5", () => {
    expect(encodeKey("b", false, true, false)).toBe("\x1bb");
    expect(encodeKey("Right", true, false, false)).toBe("\x1b[1;5C");
  });

  test("unknown multi-char names encode to nothing", () => {
    expect(encodeKey("F13", false, false, false)).toBe("");
  });
});
