import type { AnimationTheme } from "../compiler/animation.ts";

export type PocketFramework = "solid" | "vue-vapor" | "octane";

export interface PocketFontConfig {
  /** Font file used by proportional, regular-weight slots. */
  regular?: string;
  /** Font file used by proportional, bold slots. */
  bold?: string;
  /** Font file used by monospace slots. */
  mono?: string;
  /**
   * Ordered fallback faces. Each codepoint stays in the first face that
   * covers it, so a Latin primary can be combined with a CJK fallback while
   * still producing one self-contained atlas per slot.
   */
  fallbacks?: readonly string[];
}

export interface PocketConfig {
  /**
   * JSX/runtime framework for application sources. Solid is the default for
   * existing apps; Vue Vapor or Octane can be selected here or with
   * --framework.
   */
  framework?: PocketFramework;
  /** Build-time font sources, resolved relative to this config file. */
  fonts?: PocketFontConfig;
  /**
   * Tailwind-config-shaped theme extensions. `keyframes` + `animation` feed
   * the build-time animation baker (framework/compiler/animation.ts): `animate-<name>`
   * class utilities resolve against these, and every referenced animation is
   * baked into the styles.bin ANIM TABLE as fixed-dt segment timelines.
   * An app directory may carry its own pocket.config.ts, which the build
   * prefers over the repo root one.
   */
  theme?: AnimationTheme;
}

export function definePocketConfig(config: PocketConfig): PocketConfig {
  return config;
}
