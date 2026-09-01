import { describe, expect, test } from "bun:test";
import { createScroller } from "../framework/src/kinetics.ts";
import {
  CONTACT_DOWN_ANCHOR_Y,
  CONTACT_LIST_HEIGHT,
  CONTACT_MAX_OFFSCREEN_PX,
  CONTACT_ROW_HEIGHT,
  CONTACT_UP_ANCHOR_Y,
  boundedVisualContactIndex,
  contactScrollTarget,
  wheelMultiplier,
} from "../hosts/rockbox/demo/contact-motion.ts";

const COUNT = 10_000;
const MAX_OFFSET = COUNT * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT;

describe("Rockbox contact wheel motion", () => {
  test("keeps slow downward selection inside the viewport before scrolling", () => {
    for (let index = 1; index <= 4; index++) {
      expect(contactScrollTarget(index, 0, MAX_OFFSET)).toBeNull();
    }
    const target = contactScrollTarget(5, 0, MAX_OFFSET);
    expect(target).toBe(6);
    expect(5 * CONTACT_ROW_HEIGHT - target!).toBe(CONTACT_DOWN_ANCHOR_Y);
  });

  test("uses mirrored one-row resting anchors", () => {
    const down = contactScrollTarget(20, 0, MAX_OFFSET)!;
    expect(20 * CONTACT_ROW_HEIGHT - down).toBe(CONTACT_DOWN_ANCHOR_Y);

    const up = contactScrollTarget(10, 600, MAX_OFFSET)!;
    expect(10 * CONTACT_ROW_HEIGHT - up).toBe(CONTACT_UP_ANCHOR_Y);
  });

  test("lets a 1024-row destination leave the screen before the list follows", () => {
    expect(wheelMultiplier(30)).toBe(1024);
    expect(wheelMultiplier(300)).toBe(1024);
    const index = 1024;
    expect(index * CONTACT_ROW_HEIGHT).toBeGreaterThan(CONTACT_LIST_HEIGHT);
    const target = contactScrollTarget(index, 0, MAX_OFFSET)!;
    expect(index * CONTACT_ROW_HEIGHT - target).toBe(CONTACT_DOWN_ANCHOR_Y);
  });

  test("keeps the painted selection within 1.5 rows beyond either edge", () => {
    const down = boundedVisualContactIndex(1024, 0, COUNT);
    const downNearEdge = down * CONTACT_ROW_HEIGHT - CONTACT_LIST_HEIGHT;
    expect(downNearEdge).toBeGreaterThanOrEqual(0);
    expect(downNearEdge).toBeLessThanOrEqual(CONTACT_MAX_OFFSCREEN_PX);

    const offset = 3000;
    const up = boundedVisualContactIndex(0, offset, COUNT);
    const upNearEdge = offset - (up + 1) * CONTACT_ROW_HEIGHT;
    expect(upNearEdge).toBeGreaterThanOrEqual(0);
    expect(upNearEdge).toBeLessThanOrEqual(CONTACT_MAX_OFFSCREEN_PX);
  });

  test("clamps at real data edges instead of creating blank contacts", () => {
    expect(contactScrollTarget(0, 500, MAX_OFFSET)).toBe(0);
    expect(contactScrollTarget(COUNT - 1, 0, MAX_OFFSET)).toBe(MAX_OFFSET);
  });

  test("release discards wheel velocity and leaves only the anchor spring", () => {
    const scroller = createScroller({ max: () => 2000 });
    scroller.springTo(900, {
      overshootPx: 12,
      stiffness: 480,
      damping: 44,
    });
    for (let frame = 0; frame < 4; frame++) scroller.step();
    const releasedAt = scroller.offset();

    scroller.stop();
    scroller.springTo(900, { stiffness: 480, damping: 44 });
    const trace = [releasedAt];
    for (let frame = 0; frame < 240 && scroller.state() !== "idle"; frame++) {
      scroller.step();
      trace.push(scroller.offset());
    }

    expect(trace[1]).toBeGreaterThan(releasedAt);
    expect(Math.max(...trace)).toBeLessThanOrEqual(900);
    expect(trace.at(-1)).toBe(900);
  });
});
