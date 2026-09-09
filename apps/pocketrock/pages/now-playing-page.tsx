// The now-playing surface is defined once in ui/shell-view.tsx so the shell's
// live page and its frozen transition snapshot can never drift apart. This
// module re-exports it under the standalone-page naming convention.
import type { NowPlayingScreenProps } from "../ui/shell-view.tsx";
export {
  NowPlayingScreen,
  NowPlayingScreen as NowPlayingPage,
} from "../ui/shell-view.tsx";
export { NowPlayingScreen as default } from "../ui/shell-view.tsx";

export type NowPlayingPageProps = NowPlayingScreenProps;
export type RepeatMode = "off" | "all" | "one";
