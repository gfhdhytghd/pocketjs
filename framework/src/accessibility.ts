/** Additive retained semantic properties; host projection is capability-gated. */
export const ACCESSIBILITY_ROLES = ["text", "button", "image", "header", "link", "checkbox", "switch", "adjustable", "list", "listitem"] as const;
export type AccessibilityRole = typeof ACCESSIBILITY_ROLES[number];
export type AccessibilityAction = "activate" | "increment" | "decrement";
export interface AccessibilityState {
  disabled?: boolean;
  selected?: boolean;
  checked?: boolean | "mixed";
  expanded?: boolean;
  busy?: boolean;
}
export interface AccessibilityProps {
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  accessibilityValue?: string;
  accessibilityHint?: string;
  accessibilityHidden?: boolean;
  accessibilityState?: AccessibilityState;
  accessibilityActions?: readonly AccessibilityAction[];
  onAccessibilityAction?: (event: { actionName: AccessibilityAction }) => void;
}
export const ACCESSIBILITY_PROPS = new Set([
  "accessibilityLabel", "accessibilityRole", "accessibilityValue", "accessibilityHint",
  "accessibilityHidden", "accessibilityState", "accessibilityActions", "onAccessibilityAction",
]);
export type EncodedAccessibility = [string | null, number, string | null, string | null, number, number];
function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string") throw new TypeError("Accessibility text must be a string");
  let bytes = 0;
  for (const character of value) { const cp = character.codePointAt(0)!; bytes += cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4; }
  if (bytes > 4096) throw new RangeError("Accessibility text exceeds 4096 UTF-8 bytes");
  return value;
}
export function encodeAccessibility(props: Record<string, unknown>, pressable: boolean): EncodedAccessibility {
  const rawRole = props.accessibilityRole;
  const role = rawRole == null ? -1 : ACCESSIBILITY_ROLES.indexOf(rawRole as AccessibilityRole);
  if (rawRole != null && role < 0) throw new TypeError("Unknown accessibility role");
  const rawState = props.accessibilityState;
  if (rawState != null && (typeof rawState !== "object" || Array.isArray(rawState))) throw new TypeError("Accessibility state must be an object");
  let state = 0;
  for (const [key, value] of Object.entries(rawState ?? {})) {
    if (!["disabled", "selected", "checked", "expanded", "busy"].includes(key)) throw new TypeError("Unknown accessibility state");
    if (value == null) continue;
    if (typeof value !== "boolean" && !(key === "checked" && value === "mixed")) throw new TypeError("Invalid accessibility state");
    if (key === "disabled" && value) state |= 1;
    if (key === "selected" && value) state |= 2;
    if (key === "checked") state |= 64 | (value === "mixed" ? 8 : value ? 4 : 0);
    if (key === "expanded") state |= 128 | (value ? 16 : 0);
    if (key === "busy" && value) state |= 32;
  }
  if (props.accessibilityHidden != null && typeof props.accessibilityHidden !== "boolean") throw new TypeError("Accessibility hidden must be boolean");
  if (props.accessibilityHidden) state |= 256;
  let actions = 0;
  const declared = props.accessibilityActions;
  if (declared != null) {
    if (!Array.isArray(declared)) throw new TypeError("Accessibility actions must be an array");
    for (const action of declared) {
      const index = ["activate", "increment", "decrement"].indexOf(action);
      if (index < 0 || actions & (1 << index)) throw new TypeError("Unknown or duplicate accessibility action");
      actions |= 1 << index;
    }
  }
  if (props.onAccessibilityAction != null && typeof props.onAccessibilityAction !== "function") throw new TypeError("Accessibility action handler must be a function");
  return [text(props.accessibilityLabel), role, text(props.accessibilityValue), text(props.accessibilityHint), state | (pressable ? 512 : 0), actions];
}
