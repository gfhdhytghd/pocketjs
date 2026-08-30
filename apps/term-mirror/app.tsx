// apps/term-mirror/app.tsx — the read-only window the term companion opens
// on the desktop beside each session.
//
// It is the console's top screen and nothing else: the same grid component,
// the same store, the same protocol, drawn by PocketJS through the gpui
// backend instead of the PICA200. That is the whole point of the split in
// apps/term/grid.tsx — a mirror is not a second implementation of the
// terminal, it is the same one on another machine, which is also why it
// follows the console to Linux (`hosts/desktop` is the stock host of both
// `macos-app` and `linux-app`).
//
// The window never types: `role: "mirror"` makes the companion refuse input
// from this connection and keeps it from resizing anyone's PTY, so opening
// one cannot disturb what the console is doing.

import { onFrame } from "@pocketjs/framework/lifecycle";
import { getOps } from "@pocketjs/framework";
import { TermGrid } from "../term/grid.tsx";
import { connectSvc } from "../term/svc.ts";
import { createTermStore } from "../term/store.ts";

/** Matched to apps/term: the same viewport, font slot and cell box, so the
 *  mirror's grid is column-for-column what the console shows. */
const MONO_SLOT = 16;
const STATUS_H = 14;
const CELL_H = 13;

export default function TermMirror() {
  const ops = getOps();
  const advance = ops.measureText("M", MONO_SLOT);
  const CELL_W = advance > 0 ? Math.max(6, Math.round(advance)) : 7;
  const TRACK = advance > 0 ? CELL_W - advance : 0;
  const COLS = Math.floor(400 / CELL_W);
  const ROWS = Math.floor((240 - STATUS_H) / CELL_H);

  const store = createTermStore(
    { cols: COLS, rows: ROWS, cell: [CELL_W, CELL_H], role: "mirror", readOnly: true },
    connectSvc(),
  );
  onFrame(() => store.frame());

  return (
    <TermGrid
      store={store}
      metrics={{ cols: COLS, rows: ROWS, cellW: CELL_W, cellH: CELL_H, track: TRACK, statusH: STATUS_H }}
      badge="read-only"
      hint="this window is opened by the term companion"
      title="MIRROR"
    />
  );
}
