// tests/wild-sim.test.ts — the Wild app end-to-end in the deterministic sim
// host, with the renderless scene3d reference sim injected as globalThis.s3.
//
// One scripted journey: walk to camp, flint the woodpile, watch it catch.
// Assertions: (1) the journey actually happens (probe event counts + the HUD
// pixels change when the ticker fires), (2) two identical runs are
// byte-identical, (3) the WORLD trajectory is simulationHz-invariant — the
// same journey at 60 Hz and 20 Hz ends on the same world state hash at the
// same virtual tick (the kernel steps 60/hz fixed steps per frame; camera
// and HUD are presentation and are excluded by hashing world state, not
// pixels, across rates).
//
// Input timing lives on the virtual 0.05 s grid so every rate sees the same
// per-tick button stream (presses are held ≥ one coarse frame).

import { describe, expect, test } from "bun:test";
import { bootWorld } from "../hosts/sim/sim.ts";
import { createScene3dSim } from "../apps/wild/lib/scene3d/sim.ts";
import { BTN, ANALOG_CENTER } from "../contracts/spec/spec.ts";

interface Probe {
  counts: Record<string, number>;
  tick: () => number;
  hash: () => number;
}

function analogWord(x: number, y: number): number {
  const px = Math.round(128 + x * 127);
  const py = Math.round(128 + y * 127);
  return ((px & 0xff) << 8) | (py & 0xff);
}

/** The journey, in virtual seconds (inclusive start, exclusive end). */
const WALK = { from: 0.5, to: 1.55 }; // analog full-up: spawn → campfire
const FLINT_AT = 2.0; // TRIANGLE held 0.15 s
const END = 6.0;

function inputsFor(seconds: number): { buttons: number; analog: number } {
  let buttons = 0;
  let analog = ANALOG_CENTER;
  if (seconds >= WALK.from && seconds < WALK.to) analog = analogWord(0, -1);
  if (seconds >= FLINT_AT && seconds < FLINT_AT + 0.15) buttons |= BTN.TRIANGLE;
  return { buttons, analog };
}

async function runJourney(hz: number) {
  const sim = createScene3dSim();
  const world = await bootWorld("wild-main", hz, { s3: sim.ops });
  const frames = END * hz;
  const hashes: number[] = [];
  for (let f = 0; f < frames; f++) {
    const t = f / hz;
    const { buttons, analog } = inputsFor(t);
    world.frame(buttons, analog);
    for (let i = 0; i < world.ticksPerFrame; i++) world.tick();
    hashes.push(fnv(world.render()));
  }
  const probe = (globalThis as Record<string, unknown>).__wildProbe as Probe;
  return {
    hashes,
    counts: { ...probe.counts },
    worldTick: probe.tick(),
    worldHash: probe.hash(),
    scene: sim.ops.__serialize ? fnvStr(sim.ops.__serialize(1)) : 0,
  };
}

function fnv(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function fnvStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

describe("wild end-to-end (sim host + renderless s3)", () => {
  test("the flint journey lights the campfire, twice, identically", async () => {
    const a = await runJourney(60);

    // The journey happened: the woodpile ignited and its stones stayed put.
    expect(a.counts.ignited ?? 0).toBeGreaterThanOrEqual(1);
    expect(a.worldTick).toBe(END * 60);

    // The HUD reacted (ticker text) — pixels changed after the flint moment.
    const before = a.hashes[Math.round(FLINT_AT * 60) - 10];
    const after = a.hashes[Math.round(FLINT_AT * 60) + 12];
    expect(after).not.toBe(before);

    // Determinism: a second identical run is byte-identical, pixels and world.
    const b = await runJourney(60);
    expect(b.hashes).toEqual(a.hashes);
    expect(b.worldHash).toBe(a.worldHash);
    expect(b.scene).toBe(a.scene);
    expect(b.counts).toEqual(a.counts);
  }, 30000);

  test("the world trajectory is hz-invariant (60 Hz vs 20 Hz)", async () => {
    const fine = await runJourney(60);
    const coarse = await runJourney(20);
    expect(coarse.worldTick).toBe(fine.worldTick);
    expect(coarse.worldHash).toBe(fine.worldHash);
    expect(coarse.counts).toEqual(fine.counts);
  }, 30000);
});
