export const CONTACT_ROW_HEIGHT = 30;
export const CONTACT_LIST_HEIGHT = 204;
export const CONTACT_UP_ANCHOR_Y = CONTACT_ROW_HEIGHT;
export const CONTACT_DOWN_ANCHOR_Y =
  CONTACT_LIST_HEIGHT - 2 * CONTACT_ROW_HEIGHT;
export const CONTACT_SPRING_OVERSHOOT = 12;
export const CONTACT_SPRING_STIFFNESS = 480;
export const CONTACT_SPRING_DAMPING = 44;
export const CONTACT_MAX_OFFSCREEN_ROWS = 1.5;
export const CONTACT_MAX_OFFSCREEN_PX =
  CONTACT_ROW_HEIGHT * CONTACT_MAX_OFFSCREEN_ROWS;

export function wheelMultiplier(burst: number): number {
  const gear = Math.min(10, Math.floor(Math.max(0, burst) / 3));
  return 1 << gear;
}

/** Keep the painted selection no farther than maxOffscreenPx beyond either
 * viewport edge while its accelerated logical destination may remain far
 * ahead. The row's nearest edge is used symmetrically. */
export function boundedVisualContactIndex(
  destinationIndex: number,
  offset: number,
  count: number,
  maxOffscreenPx = CONTACT_MAX_OFFSCREEN_PX,
): number {
  const first = Math.max(
    0,
    Math.ceil(
      (offset - maxOffscreenPx - CONTACT_ROW_HEIGHT) / CONTACT_ROW_HEIGHT,
    ),
  );
  const last = Math.min(
    count - 1,
    Math.floor(
      (offset + CONTACT_LIST_HEIGHT + maxOffscreenPx) / CONTACT_ROW_HEIGHT,
    ),
  );
  return Math.max(first, Math.min(last, destinationIndex));
}

/** Final list offset required to bring a selected row back into the resting
 * band. null means the row can move inside the band without moving the list. */
export function contactScrollTarget(
  selectedIndex: number,
  currentIntent: number,
  maxOffset: number,
): number | null {
  const rowTop = selectedIndex * CONTACT_ROW_HEIGHT;
  const screenY = rowTop - currentIntent;
  let target: number;
  if (screenY > CONTACT_DOWN_ANCHOR_Y) {
    target = rowTop - CONTACT_DOWN_ANCHOR_Y;
  } else if (screenY < CONTACT_UP_ANCHOR_Y) {
    target = rowTop - CONTACT_UP_ANCHOR_Y;
  } else {
    return null;
  }
  return Math.max(0, Math.min(maxOffset, target));
}
