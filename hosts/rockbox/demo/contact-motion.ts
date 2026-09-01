export const CONTACT_ROW_HEIGHT = 30;
export const CONTACT_LIST_HEIGHT = 204;
export const CONTACT_UP_ANCHOR_Y = CONTACT_ROW_HEIGHT;
export const CONTACT_DOWN_ANCHOR_Y =
  CONTACT_LIST_HEIGHT - 2 * CONTACT_ROW_HEIGHT;
export const CONTACT_SPRING_OVERSHOOT = 12;

export function wheelMultiplier(burst: number): number {
  const gear = Math.min(10, Math.floor(Math.max(0, burst) / 3));
  return 1 << gear;
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
