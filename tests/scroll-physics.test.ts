import { afterEach, beforeEach, expect, test } from 'bun:test';
import { scrollConfiguration, splineFling, splineSample } from '../framework/src/scroll-physics.ts';
import { createScrollerWith, plainCell } from '../framework/src/kinetics-core.ts';
import { attachGesture, __runGestures, resetGestures, cancelActiveTouches } from '../framework/src/gesture-core.ts';
import { __packTouch, __setTouches, __resetTouches } from '../framework/src/touch.ts';
import { resetClock, __advanceClock } from '../framework/src/clock.ts';
const globals = globalThis as { pod?: unknown; __simHz?: number };
let originalHost: unknown;
beforeEach(() => { originalHost = globals.pod; delete globals.pod; delete globals.__simHz; resetClock(); resetGestures(); __resetTouches(); });
afterEach(() => { globals.pod = originalHost; delete globals.__simHz; resetClock(); resetGestures(); __resetTouches(); });
function pump(y?: number, x = 100) {
  __advanceClock(); __setTouches(y === undefined ? [] : [__packTouch(1, x, y)]); __runGestures();
}
function list() {
  const s = createScrollerWith(plainCell, { max: () => 100000, initial: 500 });
  let taps = 0, cancels = 0;
  attachGesture({ onTap: () => taps++, onCancel: () => cancels++ });
  attachGesture({ axis: 'y', onDown: () => s.stop(), onPanStart: () => s.beginDrag(),
    onPanMove: c => s.drag(-c.fdy), onPanEnd: c => s.endDrag(-c.vy), onCancel: () => s.endDrag(0) });
  return { s, taps: () => taps, cancels: () => cancels };
}
test('slop jitter keeps content still and row click alive, including exact threshold', () => {
  const l = list(); pump(100); pump(103); pump(98); pump(108);
  expect(l.s.offset()).toBe(500); expect(l.cancels()).toBe(0);
  pump(); expect(l.taps()).toBe(1); expect(l.s.state()).toBe('idle');
});
test('crossing slop consumes only over-slop motion in either direction', () => {
  for (const sign of [-1, 1]) {
    resetGestures(); __resetTouches(); const l = list();
    pump(100); pump(100 + sign * 7); pump(100 + sign * 10);
    expect(l.s.offset()).toBeCloseTo(500 - sign * 2, 10);
    expect(l.cancels()).toBe(1);
    pump(100 + sign * 13); expect(l.s.offset()).toBeCloseTo(500 - sign * 5, 10);
    pump(); expect(l.taps()).toBe(0);
  }
});
test('slow 30 dp/s drag releases without fling at 30 Hz', () => {
  globals.__simHz = 30; resetClock(); const l = list();
  for (let y = 100; y <= 120; y++) pump(y);
  pump(); expect(l.s.state()).toBe('idle');
  const rest = l.s.offset(); for (let i = 0; i < 60; i++) l.s.step();
  expect(l.s.offset()).toBe(rest);
});
test('100 ms hold clears stale fling velocity; cancel never flings', () => {
  const l = list(); pump(100); pump(120); pump(140);
  for (let i = 0; i < 8; i++) pump(140);
  pump(); expect(l.s.state()).toBe('idle');
  pump(100); pump(120); cancelActiveTouches(); expect(l.s.state()).toBe('idle');
});
test('linear least squares rejects single-frame position noise', () => {
  let velocity = 0;
  attachGesture({ onPanEnd: c => velocity = c.vy });
  [100, 105, 112, 118, 125, 129, 136].forEach(y => pump(y)); pump();
  // Independent OLS fit for these samples: 362.142857 dp/s.
  expect(velocity).toBeCloseTo(362.14285714285717, 7);
});
test('native physical metrics convert to logical units without confusing density and raster scale', () => {
  globals.pod = { displayMetrics: () => JSON.stringify({ logicalHeight: 233, physicalHeight: 466, density: 2,
    scrollConfiguration: { touchSlopPx: 20, minimumFlingVelocityPx: 140, maximumFlingVelocityPx: 12000 } }) };
  expect(scrollConfiguration()).toEqual({ touchSlop: 10, minimumFlingVelocity: 70, maximumFlingVelocity: 6000, logicalPixelsPerDp: 1 });
  const l = list(); pump(100); pump(109); expect(l.s.offset()).toBe(500); pump(112); expect(l.s.offset()).toBe(498);
  l.s.endDrag(69); expect(l.s.state()).toBe('idle');
  l.s.beginDrag(); l.s.endDrag(9000); expect(l.s.velocity()).toBe(6000);
});
test('old hosts use density-aware dp defaults; malformed hosts and absent hosts use safe defaults', () => {
  globals.pod = { displayMetrics: () => JSON.stringify({ logicalHeight: 466, physicalHeight: 466, density: 2 }) };
  expect(scrollConfiguration().touchSlop).toBe(16);
  expect(scrollConfiguration().minimumFlingVelocity).toBe(100);
  globals.pod = { displayMetrics: () => 'invalid' }; expect(scrollConfiguration().touchSlop).toBe(8);
  delete globals.pod; expect(scrollConfiguration().maximumFlingVelocity).toBe(8000);
});
// Independently calculated AOSP distance and time, v in dp/s, density=1.
const oracle = [
  [50, 1.0704515336379243, 61.16865906502422],
  [100, 3.5664458860093675, 101.89845388598191],
  [500, 58.32229635721353, 333.270264898363],
  [1000, 194.3136212798958, 555.1817750854167],
  [2000, 647.3987783959533, 924.8553977085047],
  [8000, 7186.362753988745, 2566.558126424552],
];
test('Android numerical oracle: fling projection, final distance and frame-quantized duration', () => {
  for (const [velocity, distance, ms] of oracle) {
    for (const hz of [30, 60]) {
      globals.__simHz = hz; resetClock();
      const model = splineFling(velocity);
      expect(model.distance).toBeCloseTo(distance, 8); expect(model.duration * 1000).toBeCloseTo(ms, 8);
      const s = createScrollerWith(plainCell, { max: () => 100000 });
      expect(s.projectFling(velocity)).toBeCloseTo(distance, 8);
      s.beginDrag(); s.endDrag(velocity); let frames = 0;
      while (s.state() !== 'idle' && frames < 1000) { s.step(); frames++; }
      expect(frames).toBe(Math.ceil(ms / 1000 * hz));
      expect(Math.abs(s.offset() - distance)).toBeLessThanOrEqual(1 / 128);
    }
    expect(splineFling(-velocity).distance).toBeCloseTo(-distance, 8);
    expect(splineFling(velocity * 2, 2).distance).toBeCloseTo(distance * 2, 8);
  }
});
test('minimum threshold, maximum clamp and hard bounds are enforced', () => {
  const s = createScrollerWith(plainCell, { max: () => 100000, initial: 100 });
  for (const v of [0, 49.999, -49.999, NaN, Infinity]) {
    s.beginDrag(); s.endDrag(v); expect(s.state()).toBe('idle'); expect(s.projectFling(v)).toBe(100);
  }
  s.beginDrag(); s.endDrag(99999); expect(s.velocity()).toBe(8000);
  expect(s.projectFling(99999)).toBe(s.projectFling(8000));
  const bounded = createScrollerWith(plainCell, { max: () => 10, overscroll: 0 });
  bounded.beginDrag(); bounded.endDrag(2000);
  for (let i = 0; i < 120; i++) { bounded.step(); expect(bounded.offset()).toBeLessThanOrEqual(10); }
  expect(bounded.state()).toBe('idle');
});
test('spline samples follow the independent Bezier time inversion oracle', () => {
  for (const time of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 60; i++) {
      const u = (lo + hi) / 2;
      const t = 0.525 * u + 0.475 * u * u * u;
      if (t < time) lo = u; else hi = u;
    }
    const u = (lo + hi) / 2, distance = 1.5 * u - 0.5 * u * u * u;
    expect(Math.abs(splineSample(time).position - distance)).toBeLessThan(0.0001);
  }
});
