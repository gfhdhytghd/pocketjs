// The `mon` guest SDK — the surface expressed in its domain's own algebra.
//
// RUNTIMES.md discipline #4: raw surfaces are wire protocols, and each one
// ships an SDK in the shape its domain actually wants. A creature RPG's shape
// is *registries and hooks*: content you declare, and facts you react to. So
// the API here is `mon.on("encounter", …)` and `mon.party()`, not
// `mon.op(115)`.
//
// ## What this binds to
//
// `globalThis.mon` is installed by whichever host is running the guest, and is
// a thin marshalling shim over the core's single op dispatcher
// (`pocketmon-core/src/surface.rs`). One function on the Rust side, one object
// here — no hand-written trampoline per op to keep in sync.
//
// ## Law 1
//
// Reads are mirrored. `party()` and `world()` decode a packed snapshot the
// core hands over on request; anything drawn every frame is drawn by the core
// from its own state, and the guest never touches it. A guest that polled a
// view per frame would be paying the boundary cost the whole design exists to
// avoid.

import { MON_BTN, MON_EVENT, MON_OP, VIEW } from "../../contracts/spec/mon-spec.ts";

// ---------------------------------------------------------------------------
// The host object
// ---------------------------------------------------------------------------

/** The raw surface a host installs. Every call is one op. */
export interface MonHost {
  op(code: number, ...args: Array<number | string | ArrayBuffer>): unknown;
}

declare const globalThis: { mon?: MonHost } & Record<string, unknown>;

function host(): MonHost {
  const h = globalThis.mon;
  if (!h) throw new Error("the `mon` surface is not mounted on this host");
  return h;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A decoded fact from the core. */
export interface MonEventRecord {
  kind: number;
  a: number;
  b: number;
  c: number;
  d: number;
}

/** Event names, in the shape a handler registration wants. */
export type EventName = keyof typeof MON_EVENT;

const EVENT_BY_CODE = new Map<number, EventName>(
  Object.entries(MON_EVENT).map(([name, code]) => [code, name as EventName]),
);

/** Bytes per packed event record — mirrors `spec::EVENT_SIZE`. */
const EVENT_SIZE = 16;

/** Decode the packed batch `events()` returns. */
export function decodeEvents(buffer: ArrayBuffer): MonEventRecord[] {
  const dv = new DataView(buffer);
  const out: MonEventRecord[] = [];
  for (let at = 0; at + EVENT_SIZE <= buffer.byteLength; at += EVENT_SIZE) {
    out.push({
      kind: dv.getUint16(at, true),
      a: dv.getUint16(at + 2, true),
      b: dv.getInt32(at + 4, true),
      c: dv.getInt32(at + 8, true),
      d: dv.getInt32(at + 12, true),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface WorldView {
  map: number;
  x: number;
  y: number;
  dir: number;
  mode: number;
  steps: number;
  lastOutdoor: number;
}

export interface PartyMember {
  species: number;
  level: number;
  status: number;
  hp: number;
  maxHp: number;
}

export interface BattleView {
  active: boolean;
  phase: number;
  own: { species: number; hp: number; maxHp: number; level: number };
  foe: { species: number; hp: number; maxHp: number; level: number };
}

function decodeWorld(buffer: ArrayBuffer): WorldView {
  const dv = new DataView(buffer);
  return {
    map: dv.getUint16(0, true),
    x: dv.getInt16(2, true),
    y: dv.getInt16(4, true),
    dir: dv.getUint8(6),
    mode: dv.getUint8(7),
    steps: dv.getUint32(8, true),
    lastOutdoor: dv.getUint16(12, true),
  };
}

function decodeParty(buffer: ArrayBuffer): PartyMember[] {
  const dv = new DataView(buffer);
  const n = buffer.byteLength > 0 ? dv.getUint8(0) : 0;
  const out: PartyMember[] = [];
  for (let i = 0; i < n; i++) {
    const at = 1 + i * 8;
    if (at + 8 > buffer.byteLength) break;
    out.push({
      species: dv.getUint16(at, true),
      level: dv.getUint8(at + 2),
      status: dv.getUint8(at + 3),
      hp: dv.getUint16(at + 4, true),
      maxHp: dv.getUint16(at + 6, true),
    });
  }
  return out;
}

function decodeBattle(buffer: ArrayBuffer): BattleView {
  const empty = { species: 0, hp: 0, maxHp: 0, level: 0 };
  if (buffer.byteLength === 0) {
    return { active: false, phase: 0, own: empty, foe: empty };
  }
  const dv = new DataView(buffer);
  if (dv.getUint8(0) === 0) return { active: false, phase: 0, own: empty, foe: empty };
  return {
    active: true,
    phase: dv.getUint8(1),
    own: {
      species: dv.getUint16(2, true),
      hp: dv.getUint16(4, true),
      maxHp: dv.getUint16(6, true),
      level: dv.getUint8(14),
    },
    foe: {
      species: dv.getUint16(8, true),
      hp: dv.getUint16(10, true),
      maxHp: dv.getUint16(12, true),
      level: dv.getUint8(15),
    },
  };
}

// ---------------------------------------------------------------------------
// The SDK
// ---------------------------------------------------------------------------

type Handler = (event: MonEventRecord) => void;

/**
 * A guest program: content plus reactions.
 *
 * Construct one, register handlers, and call [`Mon.pump`] once per tick. The
 * base game is written against exactly this — RUNTIMES.md discipline #5, "let
 * the base game be the first mod": if the shipped game needs something the SDK
 * cannot say, the surface is too weak and the surface is what gets fixed.
 */
export class Mon {
  private readonly handlers = new Map<EventName, Handler[]>();

  /** Register a reaction. Several handlers per event run in order. */
  on(event: EventName, handler: Handler): this {
    const list = this.handlers.get(event);
    if (list) list.push(handler);
    else this.handlers.set(event, [handler]);
    return this;
  }

  /**
   * Drain this tick's facts and run their handlers.
   *
   * Call once per frame, before anything else: the core has already acted on
   * its own events by now (a wild encounter has already opened a battle), so a
   * handler is reacting to something that happened, not vetoing it.
   */
  pump(): MonEventRecord[] {
    const raw = host().op(MON_OP.events) as ArrayBuffer | undefined;
    if (!raw || raw.byteLength === 0) return [];
    const events = decodeEvents(raw);
    for (const event of events) {
      const name = EVENT_BY_CODE.get(event.kind);
      if (!name) continue; // a fact from a newer core: ignore, do not throw
      for (const handler of this.handlers.get(name) ?? []) handler(event);
    }
    return events;
  }

  // --- content ------------------------------------------------------------

  /** Upload a cooked MONPAK. */
  loadContent(pak: ArrayBuffer): boolean {
    return Boolean(host().op(MON_OP.loadContent, pak));
  }

  // --- world --------------------------------------------------------------

  enterMap(map: number, x: number, y: number, dir = 0): void {
    host().op(MON_OP.enterMap, map, x, y, dir);
  }

  warpTo(map: number, x: number, y: number, dir = 0, fade = true): void {
    host().op(MON_OP.warpTo, map, x, y, dir, fade ? 1 : 0);
  }

  /** Push a dialogue box. Returns a handle that comes back as `textDone`. */
  say(text: string): number {
    return Number(host().op(MON_OP.showText, text));
  }

  /** Ask a question. Returns a handle that comes back as `choiceDone`. */
  ask(prompt: string, options: string[] = ["YES", "NO"]): number {
    return Number(host().op(MON_OP.showChoice, prompt, options.join("\n")));
  }

  flag(id: number): boolean {
    return Boolean(host().op(MON_OP.getFlag, id));
  }

  setFlag(id: number, value = true): void {
    host().op(MON_OP.setFlag, id, value ? 1 : 0);
  }

  playMusic(id: number): void {
    host().op(MON_OP.playMusic, id);
  }

  stopMusic(): void {
    host().op(MON_OP.stopMusic);
  }

  // --- party --------------------------------------------------------------

  give(species: number, level: number): number {
    return Number(host().op(MON_OP.givemon, species, level));
  }

  heal(): void {
    host().op(MON_OP.healParty);
  }

  giveItem(item: number, qty = 1): boolean {
    return Boolean(host().op(MON_OP.giveItem, item, qty));
  }

  takeItem(item: number, qty = 1): boolean {
    return Boolean(host().op(MON_OP.takeItem, item, qty));
  }

  // --- battle -------------------------------------------------------------

  startWild(species: number, level: number): boolean {
    return Boolean(host().op(MON_OP.startWild, species, level));
  }

  startTrainer(id: number): boolean {
    return Boolean(host().op(MON_OP.startTrainer, id));
  }

  chooseAction(action: number): void {
    host().op(MON_OP.chooseAction, action);
  }

  chooseMove(index: number): void {
    host().op(MON_OP.chooseMove, index);
  }

  // --- reads (cold path; never per-frame) ---------------------------------

  world(): WorldView {
    return decodeWorld((host().op(MON_OP.view, VIEW.world) as ArrayBuffer) ?? new ArrayBuffer(0));
  }

  party(): PartyMember[] {
    return decodeParty((host().op(MON_OP.view, VIEW.party) as ArrayBuffer) ?? new ArrayBuffer(0));
  }

  battle(): BattleView {
    return decodeBattle((host().op(MON_OP.view, VIEW.battle) as ArrayBuffer) ?? new ArrayBuffer(0));
  }

  /** A string from the content's table. */
  text(key: number): string {
    return String(host().op(MON_OP.text, key) ?? "");
  }

  // --- system --------------------------------------------------------------

  save(): ArrayBuffer {
    return (host().op(MON_OP.save) as ArrayBuffer) ?? new ArrayBuffer(0);
  }

  load(blob: ArrayBuffer): boolean {
    return Boolean(host().op(MON_OP.load, blob));
  }

  seed(lo: number, hi = 0): void {
    host().op(MON_OP.seed, lo, hi);
  }
}

/** Button bits, re-exported so a guest need not reach into the spec. */
export const BTN = MON_BTN;
