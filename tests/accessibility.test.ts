import { expect, test } from "bun:test";
import { encodeAccessibility } from "../framework/src/accessibility.ts";

test("semantics encoding preserves absence, false states, Unicode and action bits", () => {
  expect(encodeAccessibility({}, false)).toEqual([null,-1,null,null,0,0]);
  expect(encodeAccessibility({accessibilityLabel:"",accessibilityRole:"checkbox",accessibilityState:{checked:false,expanded:false}},false))
    .toEqual(["",5,null,null,192,0]);
  expect(encodeAccessibility({accessibilityLabel:"批准😀",accessibilityRole:"button",accessibilityState:{disabled:true,selected:true,checked:"mixed"},accessibilityActions:["activate","increment","decrement"]},true))
    .toEqual(["批准😀",1,null,null,587,7]);
});
test("semantics rejects invalid values instead of coercing a different meaning", () => {
  for (const props of [
    {accessibilityRole:"heading"},{accessibilityState:{checked:1}},
    {accessibilityState:{unknown:true}},{accessibilityState:[]},{accessibilityHidden:"false"},
    {accessibilityActions:["activate","activate"]},{accessibilityActions:["launch"]},
    {accessibilityLabel:"😀".repeat(1025)},{accessibilityValue:7},{onAccessibilityAction:1},
  ]) expect(()=>encodeAccessibility(props,false)).toThrow();
  expect(encodeAccessibility({accessibilityLabel:"😀".repeat(1024)},false)[0]?.length).toBe(2048);
});
