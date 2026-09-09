export const POCKETROCK_TRANSITION_MS = 110;

/**
 * Page input is locked to the animation's wall-clock duration, not to a
 * number of guest frames. This keeps 30 Hz and 60 Hz hosts behaviorally
 * identical even when the Rockbox scheduler changes cadence mid-animation.
 */
export function transitionDeadline(startMs: number): number {
  return startMs + POCKETROCK_TRANSITION_MS;
}

export function transitionExpired(deadlineMs: number, nowMs: number): boolean {
  return deadlineMs !== 0 && nowMs >= deadlineMs;
}
