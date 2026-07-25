// The string table.
//
// Every piece of text in the game — creature names, move names, dialogue,
// signs — is interned here and referenced everywhere else by its u16 key.
// That is what keeps the `mon` surface's records fixed-size and the runtime
// free of any hashing: a key IS an index into this array.
//
// Key 0 is always the empty string, which the core treats as "no text" (a
// `show_text` on key 0 opens no box, so a script cannot deadlock on it).

export class TextTable {
  private readonly list: string[] = [""];
  private readonly index = new Map<string, number>([["", 0]]);

  /** Intern a string, returning its key. Repeats share one entry. */
  key(s: string): number {
    const hit = this.index.get(s);
    if (hit !== undefined) return hit;
    const id = this.list.length;
    if (id > 0xffff) throw new Error("text table overflow: keys are u16");
    this.list.push(s);
    this.index.set(s, id);
    return id;
  }

  /** Every string, in key order. */
  all(): readonly string[] {
    return this.list;
  }

  get size(): number {
    return this.list.length;
  }
}

/**
 * Control characters, spelled out because TS string escapes do not cover them
 * and the core's text engine looks for exactly these code points.
 */
export const CTRL = {
  /** Hard line break inside a page. */
  line: "\n",
  /** `\v` in the upstream engine: scroll one line. */
  scroll: "\u000b",
  /** `\f` in the upstream engine: page break, waits for A then clears. */
  page: "\u000c",
} as const;
