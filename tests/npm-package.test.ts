import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

function packedFiles(cwd: string): string[] {
  const result = Bun.spawnSync({
    cmd: ["npm", "pack", "--dry-run", "--json"],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  // npm <= 11 reports an array of packs; npm >= 12 keys packs by package name.
  const parsed = JSON.parse(result.stdout.toString()) as unknown;
  const report = (
    Array.isArray(parsed) ? parsed[0] : Object.values(parsed as object)[0]
  ) as { files: Array<{ path: string }> } | undefined;
  expect(report?.files, result.stdout.toString().slice(0, 200)).toBeDefined();
  return report!.files.map((file) => file.path);
}

function runOrExplain(cmd: string[], cwd: string): ReturnType<typeof Bun.spawnSync> {
  const result = Bun.spawnSync({
    cmd,
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(
    result.exitCode,
    `${cmd.join(" ")}\n${result.stdout.toString()}\n${result.stderr.toString()}`,
  ).toBe(0);
  return result;
}

describe("published npm artifacts", () => {
  // The files map is a governed surface, not a mirror of the repo tree: an
  // entry ships ONLY when the framework runtime, the compiler, the shipped
  // tools, or a `pocket` CLI target consumes it from the tarball. Rust
  // sources ride along solely as build inputs for CLI-buildable targets
  // (psp, vita, symbian, Kindle, the web/sim wasm) plus the deliberately
  // standalone Pocket3D Vita/GLES2 crates for out-of-tree native 3D apps.
  // Platform source integrations without a CLI target (e.g. the ESP32-P4 PPA
  // backend, whose ESP-IDF C component cannot ship in npm anyway) stay
  // git-only. Adding an entry here means updating this list in the same PR —
  // deliberately.
  test("the files map stays exactly the governed surface", async () => {
    const manifest = await Bun.file(`${root}package.json`).json();
    expect(manifest.files).toEqual([
      "apps/hero",
      "apps/paper-ink",
      "framework/src",
      "framework/compiler",
      "contracts/schema",
      "contracts/spec",
      "docs/KINDLE.md",
      "tools",
      "hosts/web",
      "assets/brand",
      "assets/fonts",
      "assets/images",
      "engine/core/src",
      "engine/core/Cargo.toml",
      "engine/crates/pocket-mod/src",
      "engine/crates/pocket-mod/Cargo.toml",
      "engine/crates/pocket-ui-surface/src",
      "engine/crates/pocket-ui-surface/Cargo.toml",
      "engine/wasm/src",
      "engine/wasm/Cargo.toml",
      "engine/symbian",
      "hosts/psp/src",
      "hosts/psp/targets",
      "hosts/psp/build.rs",
      "hosts/psp/Cargo.toml",
      "hosts/psp/Cargo.lock",
      "hosts/vita/.cargo",
      "hosts/vita/assets",
      "hosts/vita/src",
      "hosts/vita/build.rs",
      "hosts/vita/Cargo.toml",
      "hosts/vita/Cargo.lock",
      "hosts/vita/README.md",
      "hosts/vita/rust-toolchain.toml",
      "hosts/symbian/probe",
      "hosts/symbian/runtime",
      "hosts/kindle/device",
      "hosts/kindle/src",
      "hosts/kindle/Cargo.toml",
      "hosts/kindle/Cargo.lock",
      "hosts/kindle/README.md",
      "engine/pocket3d/crates/pocket3d-vita/src",
      "engine/pocket3d/crates/pocket3d-vita/examples",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/src",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src",
      "pocket.config.ts",
      "pocket.json",
      "tsconfig.json",
      "bun.lock",
    ]);
  });

  test("framework tarball contains every locked native and standalone Pocket3D input", async () => {
    const files = packedFiles(root);
    expect(files).toEqual(expect.arrayContaining([
      "assets/brand/pocketjs-avatar-white-minimal.png",
      "assets/images/logo.png",
      "apps/hero/app.tsx",
      "apps/hero/main.tsx",
      "apps/hero/pocket.kindle.json",
      "apps/paper-ink/app.tsx",
      "apps/paper-ink/main.tsx",
      "apps/paper-ink/pocket.json",
      "bun.lock",
      "docs/KINDLE.md",
      "hosts/psp/Cargo.toml",
      "hosts/psp/Cargo.lock",
      "hosts/vita/Cargo.toml",
      "hosts/vita/Cargo.lock",
      "hosts/vita/assets/sce_sys/icon0.png",
      "hosts/vita/assets/sce_sys/livearea/contents/bg.png",
      "hosts/vita/assets/sce_sys/livearea/contents/startup.png",
      "hosts/vita/assets/sce_sys/livearea/contents/template.xml",
      "hosts/symbian/probe/main.cpp",
      "hosts/symbian/probe/pocketjs-e7-probe.pro",
      "hosts/symbian/runtime/main.cpp",
      "hosts/symbian/runtime/pocketjs-e7-runtime.pro",
      "hosts/symbian/runtime/pocketjs_symbian_keys.h",
      "hosts/kindle/Cargo.toml",
      "hosts/kindle/Cargo.lock",
      "hosts/kindle/src/main.rs",
      "hosts/kindle/device/run-runtime.sh",
      "engine/symbian/Cargo.toml",
      "engine/symbian/rust-toolchain.toml",
      "engine/symbian/src/lib.rs",
      "engine/crates/pocket-mod/Cargo.toml",
      "engine/crates/pocket-mod/src/lib.rs",
      "engine/crates/pocket-ui-surface/Cargo.toml",
      "engine/crates/pocket-ui-surface/src/lib.rs",
      "tools/cli/symbian-toolchain.json",
      "tools/symbian/coda-usb-probe.c",
      "tools/symbian/Dockerfile.dockerignore",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-vita/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-gles2/Cargo.lock",
      "engine/pocket3d/crates/pocket3d-gles2/src/lib.rs",
      "engine/pocket3d/crates/pocket3d-bsp/Cargo.toml",
      "engine/pocket3d/crates/pocket3d-bsp/src/lib.rs",
    ]));
    expect(files).not.toContain("engine/pocket3d/Cargo.toml");
    // Git-only platform integrations must not leak into the tarball.
    expect(files).not.toContain("engine/backends/esp32p4-ppa/src/lib.rs");
    expect(files.some((file) => file.startsWith("engine/backends/"))).toBe(false);
    expect(files.some((file) => file.startsWith("hosts/esp32p4/"))).toBe(false);
    expect(files).not.toContain("docs/SYMBIAN_E7.md");
    // The CLI toolchain pin still ships via the wholesale "tools" entry.
    expect(files).toContain("tools/cli/psp-toolchain.json");

    const bspManifest = await Bun.file(
      `${root}engine/pocket3d/crates/pocket3d-bsp/Cargo.toml`,
    ).text();
    expect(bspManifest).not.toContain(".workspace = true");
    expect(bspManifest).not.toContain("workspace = true");

    for (const manifest of [
      "engine/crates/pocket-mod/Cargo.toml",
      "engine/crates/pocket-ui-surface/Cargo.toml",
    ]) {
      const source = await Bun.file(`${root}${manifest}`).text();
      expect(source).not.toContain(".workspace = true");
      expect(source).not.toContain("workspace = true");
    }
  }, 30_000);

  test("the extracted tarball can check and compile the Kindle Hero", () => {
    const temp = mkdtempSync(join(tmpdir(), "pocketjs-kindle-package-"));
    try {
      const pack = runOrExplain(
        ["npm", "pack", "--silent", "--pack-destination", temp],
        root,
      );
      const tarball = pack.stdout?.toString().trim().split("\n").at(-1);
      expect(tarball).toBeTruthy();
      runOrExplain(["tar", "-xzf", join(temp, tarball!), "-C", temp], root);

      const packageRoot = join(temp, "package");
      // Dependencies are package-manager inputs, not tarball payload. Reuse the
      // checkout's already locked install so this source-completeness smoke
      // remains deterministic and offline.
      symlinkSync(
        join(root, "node_modules"),
        join(packageRoot, "node_modules"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const bun = Bun.which("bun") ?? "bun";
      runOrExplain(
        [bun, "install", "--frozen-lockfile", "--dry-run", "--ignore-scripts"],
        packageRoot,
      );
      runOrExplain(
        [
          bun,
          "tools/pocket.ts",
          "check",
          "--target",
          "kindle-pw5",
          "--manifest",
          "apps/hero/pocket.kindle.json",
          "--project-root",
          ".",
        ],
        packageRoot,
      );
      runOrExplain(
        [
          bun,
          "tools/pocket.ts",
          "compile",
          "--target",
          "kindle-pw5",
          "--manifest",
          "apps/hero/pocket.kindle.json",
          "--project-root",
          ".",
          "--outdir",
          "dist",
        ],
        packageRoot,
      );

      expect(Bun.file(join(packageRoot, "dist/hero-kindle-main.js")).size).toBeGreaterThan(0);
      expect(Bun.file(join(packageRoot, "dist/hero-kindle-main.pak")).size).toBeGreaterThan(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  }, 60_000);

  test("CLI tarball stays self-contained and minimal", () => {
    expect(packedFiles(`${root}tools/cli`)).toEqual([
      "README.md",
      "bin.mjs",
      "package.json",
      "psp-toolchain.json",
      "symbian-toolchain.json",
    ]);
  });
});
