// apps/term/protocol.ts — the terminal wire protocol, shared verbatim by the
// guest app (this directory) and the Mac companion daemon (host/serve.ts).
//
// The shape follows the svc mailbox contract (spec ops 30..32): JSON lines
// both ways over one ordered connection. The companion holds the PTYs and an
// authoritative terminal state machine per session; the device renders a
// passive cell-grid replica. Attach delivers a full grid snapshot, everything
// after arrives as ordered row diffs — reconnect/resync repeats the snapshot,
// so the device never reconstructs terminal state from history.
//
// One line must stay under the svc poll buffer (spec SVC_POLL_BUF, 8192
// bytes); the host chunks large grid updates across lines (`more: 1` on every
// chunk but the last).

/** The pocket-svc app id (manifest `companions`, PKNT handshake, beacon). */
export const TERM_APP = "term";
export const TERM_PROTO = 2;

/** Keep every emitted line comfortably under SVC_POLL_BUF. */
export const LINE_BUDGET = 6144;

/** Theme defaults, shared so host-resolved inverse video (which swaps
 *  concrete colors) matches what the device paints for -1. 0xRRGGBB. */
export const THEME_FG = 0xd8dee9;
export const THEME_BG = 0x10151c;
export const THEME_CURSOR = 0x9fb6d8;

/** Box-drawing + block glyphs TUI apps (htop, vim, tmux) paint. This literal
 *  doubles as the font-atlas charset: the pass-1 AST scan collects every
 *  string literal's codepoints into the baked atlases. */
export const TERM_GLYPHS =
  "│┃─━┌┐└┘├┤┬┴┼╭╮╰╯═║╔╗╚╝╡╞▀▄█▌▐░▒▓■□▪▫▲►▼◄◆●○∙·•‾⌐¬½¼«»≈≠≤≥±÷×→←↑↓↔⏻…—–‘’“”➜❯❮✔✗λ";

/** One run of same-styled cells: start column, text, fg, bg (0xRRGGBB ints,
 *  -1 = the theme default), and an optional font marker — 1 means the run's
 *  codepoints live in the dynamic atlas (DYNAMIC_FONT_SLOT) the companion
 *  bakes at runtime, not in the app's baked mono slot. */
export type Run = [col: number, text: string, fg: number, bg: number, dyn?: 1];

/** Spare font slot (0..18 are the app's baked sizes, MAX_FONT_SLOTS is 24)
 *  that carries the runtime-baked atlas for codepoints the build never saw —
 *  CJK, and anything else a session prints. The device loads it through the
 *  spec `loadFontAtlas` op, the same reload path the note widget's runtime
 *  glyph coverage uses (docs/WIDGET.md, docs/BACKENDS.md
 *  `text.glyphs.runtime`); here the rasterizing happens on the companion and
 *  travels as atlas chunks, because the console has neither a font file nor
 *  a rasterizer. */
export const DYNAMIC_FONT_SLOT = 19;

/** Cells a dynamic-atlas glyph occupies. Terminals give CJK two columns, and
 *  the companion rewrites the baked advances to match so a run of them lands
 *  on the grid exactly. */
export const DYNAMIC_CELL_COLUMNS = 2;

/** One replaced row: y, then the row's runs (empty = a blank row). */
export type RowUpdate = [y: number, ...runs: Run[]];

/** Cursor: column, row, visible. Hidden while scrolled into history. */
export type Cursor = [x: number, y: number, on: 0 | 1];

export interface SessionInfo {
  sid: number;
  title: string;
}

/** A replica's role. A `device` drives the sessions: its grid sets their
 *  size and its input reaches the PTYs. A `mirror` is the read-only window
 *  the companion opens on the desktop beside each session — it never writes
 *  to a PTY and never resizes one, so plugging one in cannot disturb what
 *  the console sees. */
export type Role = "device" | "mirror";

/** device -> host */
export type ClientLine =
  | {
      t: "hello";
      proto: number;
      cols: number;
      rows: number;
      /** The replica's measured cell box in px, [width, height]. The
       *  companion bakes dynamic glyph advances against it, so a run of them
       *  lands on the same column boundaries as the baked text beside it. */
      cell?: [number, number];
      role?: Role;
      /** Reattach to this session if it still exists (the console remembers
       *  what it was looking at across a reconnect); mirrors pass the one
       *  session they were opened for and follow nothing else. */
      want?: number;
    }
  | { t: "new" }
  | { t: "kill"; sid: number }
  | { t: "attach"; sid: number }
  | { t: "ch"; s: string }
  | { t: "key"; k: string; ctrl?: 1; alt?: 1 }
  | { t: "scroll"; d: number }
  | { t: "resync" };

/** host -> device */
export type HostLine =
  | { t: "hello"; proto: number; name: string; sid?: number }
  | { t: "sessions"; list: SessionInfo[]; active: number }
  | {
      /** One chunk of the runtime-baked atlas for DYNAMIC_FONT_SLOT. `gen`
       *  identifies the bake (it grows as sessions print new codepoints);
       *  chunks of one gen arrive in order and the device loads the slot
       *  when the last one lands. A device that joins mid-gen discards the
       *  partial and waits for the next complete one. */
      t: "atlas";
      gen: number;
      seq: number;
      more?: 1;
      /** Base64 of this chunk of the FONT ATLAS blob. */
      b64: string;
    }
  | {
      t: "grid";
      sid: number;
      /** Bumped by attach/resize/resync; a full snapshot starts the gen. */
      gen: number;
      /** Strictly +1 per line within a gen; a gap means dropped lines and
       *  the device asks for a resync. */
      seq: number;
      /** Present on the gen's opening snapshot chunks: every row is (re)sent
       *  and the device drops any local rows the snapshot does not repeat. */
      full?: 1;
      /** More chunks of this update follow; cursor/scrollback land on the
       *  last chunk. */
      more?: 1;
      rows: RowUpdate[];
      cur?: Cursor;
      /** Lines currently scrolled back into history (0 = live bottom). */
      sb?: number;
    }
  | { t: "exit"; sid: number }
  | { t: "bell"; sid: number };

/** Named keys the host encodes into PTY bytes (host/keys.ts). */
export type KeyName =
  | "Enter"
  | "Backspace"
  | "Tab"
  | "Escape"
  | "Up"
  | "Down"
  | "Left"
  | "Right"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Delete"
  | "Space";
