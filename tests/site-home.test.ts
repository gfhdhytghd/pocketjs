import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;

test("homepage tells the dual-execution, multi-device PocketJS story", () => {
  const home = readFileSync(ROOT + "site/home.html", "utf8");
  expect(home).toContain("Build modern apps");
  expect(home).toContain("for impossible devices.");
  expect(home).toContain("Pocket Guest");
  expect(home).toContain("Pocket Vapor");
  expect(home).toContain("data-device-deck");
  expect(home).toContain("data-deck-toggle");
  expect(home).toContain("data-target-tab");
  expect(home).toContain('role="tabpanel"');
  expect(home).toContain('aria-labelledby="lp-device-tab-psp"');
  expect(home).toContain('aria-labelledby="lp-target-tab-psp"');
  expect(home).toContain('id="lp-device-tab-e7" type="button" role="tab" aria-selected="false" aria-controls="lp-device-e7" tabindex="-1"');
  expect(home).toContain('"@pocketjs/framework/vue-vapor/components"');
  expect(home).toContain('from</span> <span class="lp-code__str">"vue"');
  expect(home).toContain("Private experimental profile");
  expect(home).not.toContain("data-pocket-stage");
  expect(home).not.toContain("Bare Metal Modern Web");
  expect(home).not.toContain("One software world for every device");

  const homeCss = readFileSync(ROOT + "site/assets/home.css", "utf8");
  expect(homeCss).toContain("--acid: #c8ff5a");
  expect(homeCss).toContain(".has-js .lp-nav__links");
  expect(homeCss).toContain("html:not(.has-js) .lp-nav");
  expect(homeCss).toContain("@media (prefers-reduced-motion: reduce)");

  const build = readFileSync(ROOT + "site/build.ts", "utf8");
  expect(build).not.toContain("dist/launcher-registry.json");
  expect(build).not.toContain("emitSingleLodStagePackage");

  const behavior = readFileSync(ROOT + "site/assets/home.js", "utf8");
  expect(behavior).toContain("setupDeviceDeck");
  expect(behavior).toContain("setupTargetTabs");
  expect(behavior).toContain("inViewport");
  expect(behavior).toContain("motionOverride");
  expect(behavior).toContain("syncPauseControl");
  expect(behavior).toContain("IntersectionObserver");
  expect(behavior).not.toContain("pocket-stage-web");

  const verifier = readFileSync(ROOT + "site/verify.ts", "utf8");
  expect(verifier).toContain("activeDevicePanels");
  expect(verifier).toContain("horizontalOverflow");
  expect(verifier).not.toContain("SwiftShader");
  expect(verifier).not.toContain("querySelectorAll('canvas')");

  const siteBuild = readFileSync(ROOT + "tools/site-build.ts", "utf8");
  expect(siteBuild).not.toContain('run("tools/launcher.ts", "pack")');
  expect(siteBuild).toContain('run("tools/build.ts", "hero")');

  for (const workflow of ["deploy.yml", "release.yml"]) {
    const source = readFileSync(ROOT + ".github/workflows/" + workflow, "utf8");
    expect(source).toContain("bun run site:build");
  }
});
