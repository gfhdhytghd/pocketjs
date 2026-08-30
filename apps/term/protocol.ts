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
export const TERM_PROTO = 1;

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
 *  -1 = the theme default). */
export type Run = [col: number, text: string, fg: number, bg: number];

/** One replaced row: y, then the row's runs (empty = a blank row). */
export type RowUpdate = [y: number, ...runs: Run[]];

/** Cursor: column, row, visible. Hidden while scrolled into history. */
export type Cursor = [x: number, y: number, on: 0 | 1];

export interface SessionInfo {
  sid: number;
  title: string;
}

/** device -> host */
export type ClientLine =
  | { t: "hello"; proto: number; cols: number; rows: number }
  | { t: "new" }
  | { t: "kill"; sid: number }
  | { t: "attach"; sid: number }
  | { t: "ch"; s: string }
  | { t: "key"; k: string; ctrl?: 1; alt?: 1 }
  | { t: "scroll"; d: number }
  | { t: "resync" };

/** host -> device */
export type HostLine =
  | { t: "hello"; proto: number; name: string }
  | { t: "sessions"; list: SessionInfo[]; active: number }
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
