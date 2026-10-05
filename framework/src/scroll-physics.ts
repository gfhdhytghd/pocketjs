/** Scroll configuration in logical viewport units. Optional Pod host metrics;
 * other targets use 8 dp / 50 dp/s / 8000 dp/s at one logical pixel per dp. */
export interface ScrollConfiguration { touchSlop: number; minimumFlingVelocity: number; maximumFlingVelocity: number; logicalPixelsPerDp: number }
const defaults: ScrollConfiguration = { touchSlop: 8, minimumFlingVelocity: 50, maximumFlingVelocity: 8000, logicalPixelsPerDp: 1 };
let cachedHost: unknown;
let cached: ScrollConfiguration = defaults;
export function scrollConfiguration(): ScrollConfiguration {
  const host = (globalThis as { pod?: { displayMetrics?: () => string } }).pod;
  if (!host?.displayMetrics) return defaults;
  if (cachedHost === host) return cached;
  try {
    const metrics = JSON.parse(host.displayMetrics());
    const scale = metrics.logicalHeight / metrics.physicalHeight;
    const dp = metrics.density * scale;
    if (!(Number.isFinite(dp) && dp > 0)) return defaults;
    const native = metrics.scrollConfiguration;
    const positive = (v: unknown, fallback: number) => typeof v === 'number' && Number.isFinite(v) && v > 0 ? v * scale : fallback;
    const min = positive(native?.minimumFlingVelocityPx, 50 * dp);
    cached = { logicalPixelsPerDp: dp, touchSlop: positive(native?.touchSlopPx, 8 * dp), minimumFlingVelocity: min,
      maximumFlingVelocity: Math.max(min, positive(native?.maximumFlingVelocityPx, 8000 * dp)) };
    cachedHost = host;
    return cached;
  } catch { return defaults; }
}

// Android OverScroller spline equations (AOSP, Apache-2.0):
// https://android.googlesource.com/platform/frameworks/base/+/refs/heads/main/core/java/android/widget/OverScroller.java
// Parameterize the Bezier by time, then tabulate distance at 100 equal times.
const SAMPLES = 100;
const positions = new Float64Array(SAMPLES + 1);
for (let i = 0; i < SAMPLES; i++) {
  let lo = 0, hi = 1, u = 0;
  for (let j = 0; j < 40; j++) {
    u = (lo + hi) / 2;
    const time = 3 * u * (1 - u) * ((1 - u) * 0.175 + u * 0.35) + u * u * u;
    if (Math.abs(time - i / SAMPLES) < 1e-5) break;
    if (time < i / SAMPLES) lo = u; else hi = u;
  }
  positions[i] = 3 * u * (1 - u) * ((1 - u) * 0.5 + u) + u * u * u;
}
positions[0] = 0;
positions[SAMPLES] = 1;
const rate = Math.log(0.78) / Math.log(0.9);
export function splineFling(velocity: number, logicalPixelsPerDp = 1): { distance: number; duration: number } {
  if (!Number.isFinite(velocity) || velocity === 0) return { distance: 0, duration: 0 };
  const friction = 0.015 * 9.80665 * 39.37 * 160 * 0.84 * logicalPixelsPerDp;
  const log = Math.log(0.35 * Math.abs(velocity) / friction);
  return { distance: Math.sign(velocity) * friction * Math.exp(rate * log / (rate - 1)), duration: Math.exp(log / (rate - 1)) };
}
/** Fraction of distance and derivative per normalized second. */
export function splineSample(fraction: number): { position: number; slope: number } {
  if (fraction >= 1) return { position: 1, slope: 0 };
  const x = Math.max(0, fraction) * SAMPLES;
  const i = Math.floor(x);
  const delta = positions[i + 1] - positions[i];
  return { position: positions[i] + delta * (x - i), slope: delta * SAMPLES };
}
