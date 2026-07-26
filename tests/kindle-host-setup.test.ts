import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSha256,
  evaluateKindleHostProbe,
  executeKindleHostSetup,
  inspectZigLink,
  KINDLE_RUST_TARGET,
  KINDLE_ZIG_ASSET,
  kindleHostPaths,
  parseKindleHostSetupArgs,
  sha256Hex,
  type KindleHostInstallAction,
  type KindleHostProbe,
  type KindleHostSetupAdapter,
} from "../tools/kindle-host-setup.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), "pocketjs-kindle-host-"));
  temporaryDirectories.push(directory);
  return directory;
}

function readyProbe(
  overrides: Partial<KindleHostProbe> = {},
): KindleHostProbe {
  return {
    platform: "darwin",
    architecture: "arm64",
    bunVersion: "1.3.14",
    bunDependencies: true,
    brewAvailable: true,
    llvmFormula: "llvm",
    llvmWorking: true,
    mesonInstalled: true,
    mesonVersion: "1.11.2",
    ninjaInstalled: true,
    ninjaVersion: "1.13.2",
    rustupAvailable: true,
    rustTargetInstalled: true,
    cargoAvailable: true,
    cargoZigbuildWorking: true,
    zigDirectoryExists: true,
    managedZigVersion: KINDLE_ZIG_ASSET.version,
    managedZigWorking: true,
    zigLinkState: "managed",
    zigLinkDescription: "/managed/zig",
    pathZig: "/home/test/.cargo/bin/zig",
    pathZigVersion: KINDLE_ZIG_ASSET.version,
    pathZigManaged: true,
    ...overrides,
  };
}

describe("Kindle host setup manifest and arguments", () => {
  test("pins the official Zig arm64 macOS archive and Kindle Rust target", () => {
    expect(KINDLE_RUST_TARGET).toBe("armv7-unknown-linux-musleabihf");
    expect(KINDLE_ZIG_ASSET).toEqual({
      version: "0.14.1",
      archive: "zig-aarch64-macos-0.14.1.tar.xz",
      directory: "zig-aarch64-macos-0.14.1",
      url: "https://ziglang.org/download/0.14.1/zig-aarch64-macos-0.14.1.tar.xz",
      sha256: "39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa",
    });
  });

  test("parses only check and help", () => {
    expect(parseKindleHostSetupArgs([])).toEqual({ check: false, help: false });
    expect(parseKindleHostSetupArgs(["--check"])).toEqual({
      check: true,
      help: false,
    });
    expect(parseKindleHostSetupArgs(["-h"])).toEqual({
      check: false,
      help: true,
    });
    expect(() => parseKindleHostSetupArgs(["--write-anywhere"])).toThrow(
      "unknown argument",
    );
  });

  test("uses only PocketJS SDK and cargo-bin paths under the supplied home", () => {
    const paths = kindleHostPaths("/Users/tester");
    expect(paths.sdkRoot).toBe(
      "/Users/tester/.local/share/pocketjs-kindlesdk",
    );
    expect(paths.zigDirectory).toBe(
      "/Users/tester/.local/share/pocketjs-kindlesdk/zig-aarch64-macos-0.14.1",
    );
    expect(paths.zigBinary).toBe(`${paths.zigDirectory}/zig`);
    expect(paths.zigLink).toBe("/Users/tester/.cargo/bin/zig");
  });

  test("verifies SHA-256 before accepting an archive", () => {
    const bytes = new TextEncoder().encode("pocketjs");
    const digest = sha256Hex(bytes);
    expect(digest).toHaveLength(64);
    expect(() => assertSha256(bytes, digest, "fixture")).not.toThrow();
    expect(() => assertSha256(bytes, "0".repeat(64), "fixture")).toThrow(
      "SHA-256 mismatch",
    );
  });
});

describe("PocketJS-managed Zig ownership", () => {
  test("recognizes its own absolute and relative symlinks", () => {
    const root = temporaryRoot();
    const binary = join(root, "sdk", "zig");
    const link = join(root, "cargo", "bin", "zig");
    mkdirSync(dirname(binary), { recursive: true });
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(binary, "fixture");
    symlinkSync(binary, link);
    expect(inspectZigLink(link, binary).state).toBe("managed");

    rmSync(link);
    symlinkSync("../../sdk/zig", link);
    expect(inspectZigLink(link, binary).state).toBe("managed");
  });

  test("treats user files and foreign symlinks as conflicts", () => {
    const root = temporaryRoot();
    const binary = join(root, "sdk", "zig");
    const link = join(root, "cargo", "bin", "zig");
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(link, "user-owned");
    expect(inspectZigLink(link, binary)).toMatchObject({
      state: "conflict",
      description: "existing non-symlink file",
    });

    rmSync(link);
    symlinkSync("/opt/homebrew/bin/zig", link);
    expect(inspectZigLink(link, binary)).toMatchObject({
      state: "conflict",
    });
  });
});

describe("Kindle host setup planning and read-only doctor", () => {
  test("a ready machine is a no-op", () => {
    const evaluation = evaluateKindleHostProbe(readyProbe());
    expect(evaluation.actions).toEqual([]);
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.checks.every((item) => item.ok)).toBe(true);
  });

  test("installs exactly the missing components", () => {
    const evaluation = evaluateKindleHostProbe(readyProbe({
      bunDependencies: false,
      llvmFormula: undefined,
      llvmWorking: false,
      mesonInstalled: false,
      mesonVersion: undefined,
      ninjaInstalled: false,
      ninjaVersion: undefined,
      rustTargetInstalled: false,
      cargoZigbuildWorking: false,
      zigDirectoryExists: false,
      managedZigVersion: undefined,
      managedZigWorking: false,
      zigLinkState: "missing",
      zigLinkDescription: undefined,
      pathZig: "/opt/homebrew/bin/zig",
      pathZigVersion: "0.16.0",
      pathZigManaged: false,
    }));
    expect(evaluation.actions).toEqual([
      "bun-dependencies",
      "brew-llvm",
      "brew-meson",
      "brew-ninja",
      "rust-target",
      "cargo-zigbuild",
      "zig-install",
      "zig-link",
    ]);
    expect(evaluation.blockers).toEqual([]);
  });

  test("preflights ownership and broken existing-install conflicts", () => {
    const evaluation = evaluateKindleHostProbe(readyProbe({
      zigDirectoryExists: true,
      managedZigVersion: "0.16.0",
      managedZigWorking: false,
      zigLinkState: "conflict",
      zigLinkDescription: "existing non-symlink file",
      pathZigManaged: false,
      pathZigVersion: "0.16.0",
    }));
    expect(evaluation.actions).not.toContain("zig-install");
    expect(evaluation.actions).not.toContain("zig-link");
    expect(evaluation.blockers.join("\n")).toContain(
      "refusing to overwrite",
    );
  });

  test("--check never calls an installer", async () => {
    let installCalls = 0;
    const adapter: KindleHostSetupAdapter = {
      async probe() {
        return readyProbe({
          rustTargetInstalled: false,
        });
      },
      async install() {
        installCalls += 1;
      },
    };
    await expect(
      executeKindleHostSetup(
        { check: true, help: false },
        adapter,
        () => {},
      ),
    ).rejects.toThrow("Run without --check");
    expect(installCalls).toBe(0);
  });

  test("setup installs once, re-probes, and is idempotent", async () => {
    let probe = readyProbe({
      rustTargetInstalled: false,
      cargoZigbuildWorking: false,
    });
    const calls: KindleHostInstallAction[] = [];
    const adapter: KindleHostSetupAdapter = {
      async probe() {
        return probe;
      },
      async install(action) {
        calls.push(action);
        if (action === "rust-target") {
          probe = { ...probe, rustTargetInstalled: true };
        } else if (action === "cargo-zigbuild") {
          probe = { ...probe, cargoZigbuildWorking: true };
        }
      },
    };
    await executeKindleHostSetup(
      { check: false, help: false },
      adapter,
      () => {},
    );
    expect(calls).toEqual(["rust-target", "cargo-zigbuild"]);

    await executeKindleHostSetup(
      { check: false, help: false },
      adapter,
      () => {},
    );
    expect(calls).toEqual(["rust-target", "cargo-zigbuild"]);
  });
});
