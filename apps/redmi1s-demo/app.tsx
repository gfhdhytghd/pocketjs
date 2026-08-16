import { reportAppAction } from "@pocketjs/framework/host";
import Hero from "../hero/app.tsx";

export default function Redmi1SHero() {
  return (
    <Hero
      actionLabel="Tap Hero"
      deviceLabel="running on a 2014 Redmi 1S."
      headline="JSX on Redmi."
      onAction={(count) => reportAppAction("hero_tap", count)}
      presentationHz={60}
      runtimeLabel="RUST + QUICKJS + GLES2"
      spinnerFrameStep={6}
    />
  );
}
