#!/usr/bin/env bun

/**
 * Idempotent macOS host-toolchain setup for Kindle development.
 *
 * `--check` is a read-only doctor: it only inspects files and executes version
 * queries. The default mode installs missing prerequisites, then runs the same
 * doctor again. PocketJS owns only its versioned SDK directory and an exact
 * ~/.cargo/bin/zig symlink; conflicting user files are never replaced.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const KINDLE_RUST_TARGET = "armv7-unknown-linux-musleabihf";

export const KINDLE_ZIG_ASSET = {
  version: "0.14.1",
  archive: "zig-aarch64-macos-0.14.1.tar.xz",
  directory: "zig-aarch64-macos-0.14.1",
  url: "https://ziglang.org/download/0.14.1/zig-aarch64-macos-0.14.1.tar.xz",
  sha256: "39f3dc5e79c22088ce878edc821dedb4ca5a1cd9f5ef915e9b3cc3053e8faefa",
} as const;

const REPOSITORY_ROOT = resolve(new URL("..", import.meta.url).pathname);

export interface KindleHostSetupOptions {
  readonly check: boolean;
  readonly help: boolean;
}

export interface KindleHostPaths {
  readonly sdkRoot: string;
  readonly zigDirectory: string;
  readonly zigBinary: string;
  readonly zigLink: string;
}

export type ZigLinkState = "missing" | "managed" | "conflict";

export interface KindleHostProbe {
  readonly platform: string;
  readonly architecture: string;
  readonly bunVersion?: string;
  readonly bunDependencies: boolean;
  readonly brewAvailable: boolean;
  readonly llvmFormula?: string;
  readonly llvmWorking: boolean;
  readonly mesonInstalled: boolean;
  readonly mesonVersion?: string;
  readonly ninjaInstalled: boolean;
  readonly ninjaVersion?: string;
  readonly rustupAvailable: boolean;
  readonly rustTargetInstalled: boolean;
  readonly cargoAvailable: boolean;
  readonly cargoZigbuildWorking: boolean;
  readonly zigDirectoryExists: boolean;
  readonly managedZigVersion?: string;
  readonly managedZigWorking: boolean;
  readonly zigLinkState: ZigLinkState;
  readonly zigLinkDescription?: string;
  readonly pathZig?: string;
  readonly pathZigVersion?: string;
  readonly pathZigManaged: boolean;
}

export type KindleHostInstallAction =
  | "bun-dependencies"
  | "brew-llvm"
  | "brew-meson"
  | "brew-ninja"
  | "rust-target"
  | "cargo-zigbuild"
  | "zig-install"
  | "zig-link";

export interface HostCheck {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface HostEvaluation {
  readonly checks: readonly HostCheck[];
  readonly actions: readonly KindleHostInstallAction[];
  readonly blockers: readonly string[];
}

export interface KindleHostSetupAdapter {
  probe(): Promise<KindleHostProbe>;
  install(action: KindleHostInstallAction): Promise<void>;
}

function usageText(): string {
  return [
    "usage: bun tools/kindle-host-setup.ts [--check]",
    "",
    "Without flags, install only missing Kindle host-toolchain components and",
    "run the doctor again. --check is strictly read-only.",
    "",
    "options:",
    "  --check      inspect the toolchain without downloading or writing",
    "  -h, --help   show this help",
  ].join("\n");
}

export function parseKindleHostSetupArgs(
  argv: readonly string[],
): KindleHostSetupOptions {
  let check = false;
  let help = false;
  for (const argument of argv) {
    if (argument === "--check") check = true;
    else if (argument === "--help" || argument === "-h") help = true;
    else throw new Error(`unknown argument: ${argument}\n\n${usageText()}`);
  }
  return { check, help };
}

export function kindleHostPaths(
  homeDirectory = homedir(),
): KindleHostPaths {
  const sdkRoot = join(homeDirectory, ".local", "share", "pocketjs-kindlesdk");
  const zigDirectory = join(sdkRoot, KINDLE_ZIG_ASSET.directory);
  return {
    sdkRoot,
    zigDirectory,
    zigBinary: join(zigDirectory, "zig"),
    zigLink: join(homeDirectory, ".cargo", "bin", "zig"),
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assertSha256(
  data: Uint8Array,
  expected: string,
  label: string,
): void {
  const actual = sha256Hex(data);
  if (actual !== expected) {
    throw new Error(
      `${label} SHA-256 mismatch: expected ${expected}, received ${actual}`,
    );
  }
}

function normalizedLinkTarget(linkPath: string, rawTarget: string): string {
  return resolve(dirname(linkPath), rawTarget);
}

export function inspectZigLink(
  linkPath: string,
  managedBinary: string,
): { state: ZigLinkState; description?: string } {
  if (!existsSync(linkPath)) {
    // existsSync is false for broken symlinks; lstat still distinguishes one.
    try {
      const stat = lstatSync(linkPath);
      if (!stat.isSymbolicLink()) {
        return { state: "conflict", description: "existing non-symlink file" };
      }
    } catch {
      return { state: "missing" };
    }
  }

  const stat = lstatSync(linkPath);
  if (!stat.isSymbolicLink()) {
    return { state: "conflict", description: "existing non-symlink file" };
  }
  const rawTarget = readlinkSync(linkPath);
  const target = normalizedLinkTarget(linkPath, rawTarget);
  if (target !== resolve(managedBinary)) {
    return {
      state: "conflict",
      description: `symlink points to ${rawTarget}`,
    };
  }
  return { state: "managed", description: rawTarget };
}

function check(
  label: string,
  ok: boolean,
  detail: string,
): HostCheck {
  return { label, ok, detail };
}

export function evaluateKindleHostProbe(
  probe: KindleHostProbe,
): HostEvaluation {
  const checks: HostCheck[] = [
    check(
      "host platform",
      probe.platform === "darwin" && probe.architecture === "arm64",
      `${probe.platform}/${probe.architecture}; required darwin/arm64`,
    ),
    check("Bun", probe.bunVersion !== undefined, probe.bunVersion ?? "not found"),
    check(
      "repository dependencies",
      probe.bunDependencies,
      probe.bunDependencies ? "installed" : "bun install required",
    ),
    check(
      "Homebrew",
      probe.brewAvailable,
      probe.brewAvailable ? "available" : "not found",
    ),
    check(
      "Homebrew LLVM/libclang",
      probe.llvmWorking,
      probe.llvmWorking
        ? `${probe.llvmFormula} provides libclang`
        : probe.llvmFormula
          ? `${probe.llvmFormula} is installed but libclang is unusable`
          : "not installed",
    ),
    check(
      "Homebrew Meson",
      probe.mesonInstalled && probe.mesonVersion !== undefined,
      probe.mesonVersion ?? "not installed",
    ),
    check(
      "Homebrew Ninja",
      probe.ninjaInstalled && probe.ninjaVersion !== undefined,
      probe.ninjaVersion ?? "not installed",
    ),
    check(
      `Rust target ${KINDLE_RUST_TARGET}`,
      probe.rustTargetInstalled,
      probe.rustTargetInstalled ? "installed" : "not installed",
    ),
    check(
      "cargo-zigbuild",
      probe.cargoZigbuildWorking,
      probe.cargoZigbuildWorking ? "cargo zigbuild --help succeeds" : "not installed",
    ),
    check(
      `managed Zig ${KINDLE_ZIG_ASSET.version}`,
      probe.managedZigWorking,
      probe.managedZigVersion ??
        (probe.zigDirectoryExists ? "invalid managed directory" : "not installed"),
    ),
    check(
      "managed ~/.cargo/bin/zig link",
      probe.zigLinkState === "managed",
      probe.zigLinkDescription ?? probe.zigLinkState,
    ),
    check(
      "active PATH Zig",
      probe.pathZigManaged && probe.pathZigVersion === KINDLE_ZIG_ASSET.version,
      probe.pathZig
        ? `${probe.pathZig} (${probe.pathZigVersion ?? "version failed"})`
        : "not found",
    ),
  ];

  const actions: KindleHostInstallAction[] = [];
  const blockers: string[] = [];
  if (probe.platform !== "darwin" || probe.architecture !== "arm64") {
    blockers.push(
      `the pinned Zig archive supports arm64 macOS, not ${probe.platform}/${probe.architecture}`,
    );
  }
  if (!probe.bunDependencies) actions.push("bun-dependencies");

  if (!probe.llvmFormula) actions.push("brew-llvm");
  else if (!probe.llvmWorking) {
    blockers.push(
      `${probe.llvmFormula} is installed but does not expose a working libclang; refusing to reinstall an existing formula`,
    );
  }
  if (!probe.mesonInstalled) actions.push("brew-meson");
  else if (!probe.mesonVersion) {
    blockers.push("Homebrew Meson is installed but `meson --version` fails");
  }
  if (!probe.ninjaInstalled) actions.push("brew-ninja");
  else if (!probe.ninjaVersion) {
    blockers.push("Homebrew Ninja is installed but `ninja --version` fails");
  }
  if (
    actions.some((action) => action.startsWith("brew-")) &&
    !probe.brewAvailable
  ) {
    blockers.push("Homebrew is required to install LLVM, Meson, and Ninja");
  }

  if (!probe.rustTargetInstalled) actions.push("rust-target");
  if (!probe.rustupAvailable && actions.includes("rust-target")) {
    blockers.push("rustup is required to install the Kindle Rust target");
  }
  if (!probe.cargoZigbuildWorking) actions.push("cargo-zigbuild");
  if (!probe.cargoAvailable && actions.includes("cargo-zigbuild")) {
    blockers.push("Cargo is required to install cargo-zigbuild");
  }

  if (!probe.managedZigWorking) {
    if (probe.zigDirectoryExists) {
      blockers.push(
        "the managed Zig directory exists but is not Zig 0.14.1; refusing to overwrite it",
      );
    } else {
      actions.push("zig-install");
    }
  }
  if (probe.zigLinkState === "missing") actions.push("zig-link");
  else if (probe.zigLinkState === "conflict") {
    blockers.push(
      `~/.cargo/bin/zig is user-owned (${probe.zigLinkDescription}); refusing to overwrite it`,
    );
  }

  const zigWillChange =
    actions.includes("zig-install") || actions.includes("zig-link");
  if (
    !zigWillChange &&
    (!probe.pathZigManaged || probe.pathZigVersion !== KINDLE_ZIG_ASSET.version)
  ) {
    blockers.push(
      "PATH does not resolve Zig to PocketJS 0.14.1; put ~/.cargo/bin before Homebrew",
    );
  }

  return { checks, actions, blockers };
}

export async function executeKindleHostSetup(
  options: KindleHostSetupOptions,
  adapter: KindleHostSetupAdapter,
  writeLine: (line: string) => void = console.log,
): Promise<void> {
  const before = await adapter.probe();
  const evaluation = evaluateKindleHostProbe(before);
  for (const item of evaluation.checks) {
    writeLine(`${item.ok ? "✓" : "✗"} ${item.label}: ${item.detail}`);
  }
  if (evaluation.blockers.length > 0) {
    throw new Error(
      `Kindle host setup blocked:\n${evaluation.blockers.map((line) => `  - ${line}`).join("\n")}`,
    );
  }
  if (options.check) {
    if (evaluation.actions.length > 0) {
      throw new Error(
        `Kindle host toolchain is incomplete. Run without --check to install: ${
          evaluation.actions.join(", ")
        }`,
      );
    }
    writeLine("PocketJS Kindle host toolchain is ready (read-only check).");
    return;
  }

  for (const action of evaluation.actions) {
    writeLine(`→ ${installActionLabel(action)}`);
    await adapter.install(action);
  }

  const after = await adapter.probe();
  const verified = evaluateKindleHostProbe(after);
  if (verified.blockers.length > 0 || verified.actions.length > 0) {
    throw new Error(
      [
        "Kindle host setup finished but doctor still fails.",
        ...verified.blockers.map((line) => `  - ${line}`),
        ...(verified.actions.length > 0
          ? [`  - still missing: ${verified.actions.join(", ")}`]
          : []),
      ].join("\n"),
    );
  }
  writeLine(
    evaluation.actions.length > 0
      ? "PocketJS Kindle host toolchain installed and verified."
      : "PocketJS Kindle host toolchain was already ready; no changes made.",
  );
}

function installActionLabel(action: KindleHostInstallAction): string {
  switch (action) {
    case "bun-dependencies":
      return "install repository Bun dependencies";
    case "brew-llvm":
      return "install Homebrew LLVM/libclang";
    case "brew-meson":
      return "install Homebrew Meson";
    case "brew-ninja":
      return "install Homebrew Ninja";
    case "rust-target":
      return `install Rust target ${KINDLE_RUST_TARGET}`;
    case "cargo-zigbuild":
      return "install cargo-zigbuild";
    case "zig-install":
      return `install pinned Zig ${KINDLE_ZIG_ASSET.version}`;
    case "zig-link":
      return "create PocketJS-managed ~/.cargo/bin/zig symlink";
  }
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCommand(
  argv: readonly string[],
  options: { cwd?: string; timeout?: number } = {},
): CommandResult {
  const result = Bun.spawnSync([...argv], {
    cwd: options.cwd,
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    // A broken Homebrew Zig 0.16 has been observed hanging in dyld on this
    // machine. Doctor probes must fail in bounded time instead of wedging.
    timeout: options.timeout ?? 30_000,
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
}

function workingVersion(
  executable: string | null,
  args = ["--version"],
): string | undefined {
  if (!executable) return undefined;
  const result = runCommand([executable, ...args], { timeout: 10_000 });
  return result.exitCode === 0 ? result.stdout.split("\n")[0]?.trim() : undefined;
}

function repositoryDependenciesInstalled(): boolean {
  const manifestPath = join(REPOSITORY_ROOT, "package.json");
  const lockPath = join(REPOSITORY_ROOT, "bun.lock");
  const modules = join(REPOSITORY_ROOT, "node_modules");
  if (!existsSync(manifestPath) || !existsSync(lockPath) || !existsSync(modules)) {
    return false;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const names = [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
  ];
  if (
    names.some((name) => !existsSync(join(modules, ...name.split("/"), "package.json")))
  ) {
    return false;
  }
  const bun = Bun.which("bun");
  return !!bun &&
    runCommand([bun, "pm", "ls", "--all"], { cwd: REPOSITORY_ROOT }).exitCode === 0;
}

function sameResolvedFile(candidate: string | undefined, expected: string): boolean {
  if (!candidate || !existsSync(candidate) || !existsSync(expected)) return false;
  try {
    return realpathSync(candidate) === realpathSync(expected);
  } catch {
    return false;
  }
}

function findLlvmFormula(brew: string): string | undefined {
  const result = runCommand([brew, "list", "--formula"]);
  if (result.exitCode !== 0) return undefined;
  const formulas = result.stdout.split("\n");
  return formulas.includes("llvm")
    ? "llvm"
    : formulas.find((formula) => /^llvm@[0-9]+$/.test(formula));
}

function brewFormulaInstalled(brew: string, formula: string): boolean {
  return runCommand([brew, "list", "--versions", formula]).exitCode === 0;
}

function llvmProvidesLibclang(
  brew: string,
  formula: string | undefined,
): boolean {
  if (!formula) return false;
  const prefix = runCommand([brew, "--prefix", formula]);
  if (prefix.exitCode !== 0) return false;
  return existsSync(join(prefix.stdout, "lib", "libclang.dylib"));
}

export async function probeKindleHost(
  homeDirectory = homedir(),
): Promise<KindleHostProbe> {
  const paths = kindleHostPaths(homeDirectory);
  const brew = Bun.which("brew");
  const rustup = Bun.which("rustup");
  const cargo = Bun.which("cargo");
  const meson = Bun.which("meson");
  const ninja = Bun.which("ninja");
  const pathZig = Bun.which("zig") ?? undefined;
  const bun = Bun.which("bun");
  const llvmFormula = brew ? findLlvmFormula(brew) : undefined;
  const managedZigVersion = existsSync(paths.zigBinary)
    ? workingVersion(paths.zigBinary, ["version"])
    : undefined;
  const link = inspectZigLink(paths.zigLink, paths.zigBinary);
  const installedTargets = rustup
    ? runCommand([rustup, "target", "list", "--installed"])
    : { exitCode: 1, stdout: "", stderr: "" };
  const cargoZigbuild = cargo
    ? runCommand([cargo, "zigbuild", "--help"])
    : { exitCode: 1, stdout: "", stderr: "" };

  return {
    platform: process.platform,
    architecture: process.arch,
    bunVersion: bun ? workingVersion(bun) : undefined,
    bunDependencies: repositoryDependenciesInstalled(),
    brewAvailable: brew !== null,
    llvmFormula,
    llvmWorking: brew ? llvmProvidesLibclang(brew, llvmFormula) : false,
    mesonInstalled: brew ? brewFormulaInstalled(brew, "meson") : false,
    mesonVersion: workingVersion(meson),
    ninjaInstalled: brew ? brewFormulaInstalled(brew, "ninja") : false,
    ninjaVersion: workingVersion(ninja),
    rustupAvailable: rustup !== null,
    rustTargetInstalled: installedTargets.exitCode === 0 &&
      installedTargets.stdout.split("\n").includes(KINDLE_RUST_TARGET),
    cargoAvailable: cargo !== null,
    cargoZigbuildWorking: cargoZigbuild.exitCode === 0,
    zigDirectoryExists: existsSync(paths.zigDirectory),
    managedZigVersion,
    managedZigWorking: managedZigVersion === KINDLE_ZIG_ASSET.version,
    zigLinkState: link.state,
    zigLinkDescription: link.description,
    pathZig,
    pathZigVersion: workingVersion(pathZig ?? null, ["version"]),
    pathZigManaged: sameResolvedFile(pathZig, paths.zigBinary),
  };
}

async function installPinnedZig(paths: KindleHostPaths): Promise<void> {
  if (existsSync(paths.zigDirectory)) {
    throw new Error(
      `refusing to overwrite existing managed directory ${paths.zigDirectory}`,
    );
  }
  mkdirSync(paths.sdkRoot, { recursive: true });
  const staging = mkdtempSync(join(paths.sdkRoot, ".zig-install-"));
  try {
    const response = await fetch(KINDLE_ZIG_ASSET.url, { redirect: "follow" });
    if (!response.ok) {
      throw new Error(
        `downloading Zig failed: HTTP ${response.status} ${response.statusText}`,
      );
    }
    const archive = new Uint8Array(await response.arrayBuffer());
    assertSha256(archive, KINDLE_ZIG_ASSET.sha256, KINDLE_ZIG_ASSET.archive);
    const archivePath = join(staging, KINDLE_ZIG_ASSET.archive);
    writeFileSync(archivePath, archive);
    const extractedRoot = join(staging, KINDLE_ZIG_ASSET.directory);
    const tar = runCommand(
      ["tar", "-xJf", archivePath, "-C", staging],
      { timeout: 120_000 },
    );
    if (tar.exitCode !== 0) {
      throw new Error(`extracting Zig failed: ${tar.stderr || tar.stdout}`);
    }
    const extractedBinary = join(extractedRoot, "zig");
    if (!existsSync(extractedBinary)) {
      throw new Error(`Zig archive did not contain ${KINDLE_ZIG_ASSET.directory}/zig`);
    }
    chmodSync(extractedBinary, 0o755);
    const version = workingVersion(extractedBinary, ["version"]);
    if (version !== KINDLE_ZIG_ASSET.version) {
      throw new Error(
        `extracted Zig reported ${version ?? "no version"}, expected ${KINDLE_ZIG_ASSET.version}`,
      );
    }
    if (existsSync(paths.zigDirectory)) {
      throw new Error(
        `managed Zig directory appeared during installation; refusing to replace it`,
      );
    }
    renameSync(extractedRoot, paths.zigDirectory);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function installManagedZigLink(paths: KindleHostPaths): void {
  const state = inspectZigLink(paths.zigLink, paths.zigBinary);
  if (state.state === "managed") return;
  if (state.state === "conflict") {
    throw new Error(
      `refusing to overwrite ${paths.zigLink}: ${state.description}`,
    );
  }
  if (!existsSync(paths.zigBinary)) {
    throw new Error(`managed Zig binary is missing: ${paths.zigBinary}`);
  }
  mkdirSync(dirname(paths.zigLink), { recursive: true });
  // Re-check after mkdir so a concurrent/user-created target is still safe.
  if (inspectZigLink(paths.zigLink, paths.zigBinary).state !== "missing") {
    throw new Error(
      `${paths.zigLink} appeared during setup; refusing to overwrite it`,
    );
  }
  symlinkSync(paths.zigBinary, paths.zigLink);
}

export function createRealKindleHostSetupAdapter(
  homeDirectory = homedir(),
): KindleHostSetupAdapter {
  const paths = kindleHostPaths(homeDirectory);
  return {
    probe: () => probeKindleHost(homeDirectory),
    async install(action) {
      switch (action) {
        case "bun-dependencies":
          requireCommandSuccess(
            [Bun.which("bun") ?? "bun", "install", "--frozen-lockfile"],
            REPOSITORY_ROOT,
          );
          break;
        case "brew-llvm":
          requireCommandSuccess([Bun.which("brew") ?? "brew", "install", "llvm"]);
          break;
        case "brew-meson":
          requireCommandSuccess([Bun.which("brew") ?? "brew", "install", "meson"]);
          break;
        case "brew-ninja":
          requireCommandSuccess([Bun.which("brew") ?? "brew", "install", "ninja"]);
          break;
        case "rust-target":
          requireCommandSuccess([
            Bun.which("rustup") ?? "rustup",
            "target",
            "add",
            KINDLE_RUST_TARGET,
          ]);
          break;
        case "cargo-zigbuild":
          requireCommandSuccess([
            Bun.which("cargo") ?? "cargo",
            "install",
            "cargo-zigbuild",
            "--locked",
          ]);
          break;
        case "zig-install":
          await installPinnedZig(paths);
          break;
        case "zig-link":
          installManagedZigLink(paths);
          break;
      }
    },
  };
}

function requireCommandSuccess(argv: readonly string[], cwd?: string): void {
  console.log(`$ ${argv.join(" ")}`);
  const child = Bun.spawnSync([...argv], {
    cwd,
    env: process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  if (child.exitCode !== 0) {
    throw new Error(`command failed with exit ${child.exitCode}: ${argv.join(" ")}`);
  }
}

async function main(): Promise<void> {
  const options = parseKindleHostSetupArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(usageText());
    return;
  }
  await executeKindleHostSetup(
    options,
    createRealKindleHostSetupAdapter(),
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      `PocketJS Kindle host setup: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}
