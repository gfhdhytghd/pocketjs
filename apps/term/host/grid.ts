// apps/term/host/grid.ts — cell resolution, run building and row chunking:
// how the authoritative xterm buffer becomes the wire's Run/RowUpdate shapes.
// Dependency-free on purpose — serve.ts feeds it real IBufferCells through
// the structural XtermCellLike interface, tests feed it fakes, and the repo
// typecheck gate never needs the daemon's native modules.

import { LINE_BUDGET, THEME_BG, THEME_FG, type Run, type RowUpdate } from "../protocol.ts";

/** The slice of @xterm/headless's IBufferCell this module reads. The is*
 *  predicates return numbers there (0 = false). */
export interface XtermCellLike {
  getChars(): string;
  getWidth(): number;
  getFgColor(): number;
  getBgColor(): number;
  isFgDefault(): number | boolean;
  isBgDefault(): number | boolean;
  isFgPalette(): number | boolean;
  isBgPalette(): number | boolean;
  isBold(): number | boolean;
  isDim(): number | boolean;
  isInverse(): number | boolean;
  isInvisible(): number | boolean;
}

/** One resolved cell: concrete 0xRRGGBB colors (or -1 = theme default).
 *
 *  `width` is the terminal's own column count for the character — 2 for the
 *  full-width forms, and 0 for the continuation cell that follows one. A
 *  continuation carries no ink and must not be treated as a blank column
 *  either: the wide glyph before it already covers that column, and inserting
 *  a space there would push the rest of the row off the grid.
 *
 *  `dyn` marks a character the device cannot draw from its baked atlas and
 *  the companion can supply at runtime (see host/glyphs.ts). Runs never mix
 *  the two — they select different font slots. */
export interface Cell {
  ch: string;
  fg: number;
  bg: number;
  width?: 0 | 1 | 2;
  dyn?: boolean;
}

/** The 256-color table: 16 themed ANSI colors, the 6x6x6 cube, 24 grays. */
export const PALETTE_256: readonly number[] = (() => {
  const base = [
    0x1c2230, 0xe06c75, 0x61c16d, 0xe0b060, 0x5296e0, 0xc678dd, 0x56b6c2, 0xb8c2cf,
    0x55617a, 0xef7d86, 0x7ed88a, 0xedc07a, 0x6faaf0, 0xd78fe8, 0x6cc9d5, 0xe6ecf5,
  ];
  const steps = [0, 95, 135, 175, 215, 255];
  const table = [...base];
  for (let r = 0; r < 6; r += 1) {
    for (let g = 0; g < 6; g += 1) {
      for (let b = 0; b < 6; b += 1) {
        table.push((steps[r] << 16) | (steps[g] << 8) | steps[b]);
      }
    }
  }
  for (let i = 0; i < 24; i += 1) {
    const v = 8 + i * 10;
    table.push((v << 16) | (v << 8) | v);
  }
  return table;
})();

function halve(rgb: number): number {
  return (((rgb >> 16) & 0xff) >> 1 << 16) | ((((rgb >> 8) & 0xff) >> 1) << 8) | ((rgb & 0xff) >> 1);
}

/** SGR attributes resolve HERE, on the authority side: bold brightens the
 *  low palette, dim halves, inverse swaps concrete colors (defaults resolve
 *  through the shared theme first), invisible paints fg as bg. The device
 *  renders exactly what it is told. */
export function resolveCell(cell: XtermCellLike): Cell {
  const width = cell.getWidth() as 0 | 1 | 2;
  const ch = width === 0 ? "" : cell.getChars();
  let fg = -1;
  let bg = -1;
  if (!cell.isFgDefault()) {
    const raw = cell.getFgColor();
    fg = cell.isFgPalette()
      ? PALETTE_256[cell.isBold() && raw < 8 ? raw + 8 : raw] ?? -1
      : raw;
  } else if (cell.isBold()) {
    fg = PALETTE_256[15];
  }
  if (!cell.isBgDefault()) {
    const raw = cell.getBgColor();
    bg = cell.isBgPalette() ? PALETTE_256[raw] ?? -1 : raw;
  }
  if (cell.isDim()) fg = halve(fg < 0 ? THEME_FG : fg);
  if (cell.isInverse()) {
    const rf = fg < 0 ? THEME_FG : fg;
    const rb = bg < 0 ? THEME_BG : bg;
    fg = rb;
    bg = rf;
  }
  if (cell.isInvisible()) fg = bg < 0 ? THEME_BG : bg;
  return { ch, fg, bg, width };
}

/** Merge a row of resolved cells into runs. Blank cells (spaces or wide-char
 *  continuations on the default background) become gaps; blanks inside a
 *  same-styled stretch are kept so `foo bar` stays one run. */
export function rowRuns(cells: readonly Cell[]): Run[] {
  const runs: Run[] = [];
  let run: { col: number; text: string; fg: number; bg: number; dyn: boolean } | null = null;
  let pendingBlanks = 0;
  const close = () => {
    if (run !== null) {
      runs.push(run.dyn ? [run.col, run.text, run.fg, run.bg, 1] : [run.col, run.text, run.fg, run.bg]);
    }
    run = null;
    pendingBlanks = 0;
  };
  for (let col = 0; col < cells.length; col += 1) {
    const cell = cells[col];
    // The trailing half of a wide character: already covered, never a gap.
    if (cell.width === 0) continue;
    const blank = (cell.ch === " " || cell.ch === "") && cell.bg < 0;
    if (blank) {
      if (run !== null) pendingBlanks += 1;
      continue;
    }
    const ch = cell.ch === "" ? " " : cell.ch;
    const dyn = cell.dyn === true;
    // Blanks are only ever folded into a baked run: the dynamic atlas holds
    // exactly the codepoints the companion was asked to bake, and a space is
    // not one of them — folding one in would leave a hole mid-run.
    if (
      run !== null &&
      run.fg === cell.fg &&
      run.bg === cell.bg &&
      run.dyn === dyn &&
      (pendingBlanks === 0 || (!dyn && pendingBlanks <= 4))
    ) {
      run.text += " ".repeat(pendingBlanks) + ch;
      pendingBlanks = 0;
      continue;
    }
    close();
    run = { col, text: ch, fg: cell.fg, bg: cell.bg, dyn };
  }
  close();
  return runs;
}

/** Stable cache key for a serialized row. */
export function rowKey(runs: Run[]): string {
  return JSON.stringify(runs);
}

/** Greedy-pack row updates so each emitted line stays under the svc poll
 *  budget (the JSON wrapper around `rows` is what the margin absorbs). */
export function chunkRows(updates: RowUpdate[], budget = LINE_BUDGET): RowUpdate[][] {
  const chunks: RowUpdate[][] = [];
  let chunk: RowUpdate[] = [];
  let size = 0;
  for (const update of updates) {
    const updateSize = JSON.stringify(update).length + 1;
    if (chunk.length > 0 && size + updateSize > budget - 200) {
      chunks.push(chunk);
      chunk = [];
      size = 0;
    }
    chunk.push(update);
    size += updateSize;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks.length === 0 ? [[]] : chunks;
}
