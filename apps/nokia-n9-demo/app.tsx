import { reportAppAction } from "@pocketjs/framework/host";
import Hero from "../hero/app.tsx";

export default function NokiaN9Hero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      compactHeadline
      deviceLabel="running on a 2011 Nokia N9."
      headline="JSX on Harmattan."
      largeLayout
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + GLES2"
    />
  );
}
