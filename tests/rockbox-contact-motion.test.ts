import { describe, expect, test } from "bun:test";
import {
  CONTACT_DOWN_ANCHOR_Y,
  CONTACT_LIST_HEIGHT,
  CONTACT_ROW_HEIGHT,
  CONTACT_UP_ANCHOR_Y,
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

  test("clamps at real data edges instead of creating blank contacts", () => {
    expect(contactScrollTarget(0, 500, MAX_OFFSET)).toBe(0);
    expect(contactScrollTarget(COUNT - 1, 0, MAX_OFFSET)).toBe(MAX_OFFSET);
  });
});
