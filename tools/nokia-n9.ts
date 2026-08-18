import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";
import { resolveNokiaN9BuildPlan } from "./nokia-n9-profile.ts";
import {
  NOKIA_N9_TOOLCHAIN,
  nokiaN9DockerBuildArguments,
  nokiaN9DockerRunArguments,
  nokiaN9DownloadPath,
  nokiaN9DownloadsRoot,
  nokiaN9ImplementationDigest,
} from "./nokia-n9-toolchain.ts";

const REPOSITORY = resolve(import.meta.dir, "..");
const OUTPUT_ROOT = join(REPOSITORY, "dist/nokia-n9");
const DEFAULT_MANIFEST = join(REPOSITORY, "apps/nokia-n9-demo/pocket.json");
const KEY_ROOT = join(
  process.env.POCKET_STACK_CACHE_DIR ?? join(homedir(), ".cache/pocket-stack"),
  "nokia-n9/ssh",
);
const PRIVATE_KEY = join(KEY_ROOT, "id_rsa");
const KNOWN_HOSTS = join(KEY_ROOT, "known_hosts");
const PAIRING_RECEIPT = join(KEY_ROOT, "device.json");
const DEVICE_RUNTIME_RECEIPT = join(KEY_ROOT, "runtime.json");

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    inherit?: boolean;
    env?: Record<string, string | undefined>;
    input?: string;
  } = {},
): Promise<CommandResult> {
  const child = Bun.spawn({
    cmd: [command, ...args],
    cwd: options.cwd ?? REPOSITORY,
    env: options.env ?? process.env,
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
    stdin: options.input === undefined ? "ignore" : new Blob([options.input]),
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    options.inherit ? Promise.resolve("") : new Response(child.stdout).text(),
    options.inherit ? Promise.resolve("") : new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function mustRun(
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    inherit?: boolean;
    env?: Record<string, string | undefined>;
    input?: string;
  } = {},
): Promise<string> {
  const result = await run(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      `pocket nokia-n9: ${command} failed (${result.exitCode})${
        result.stderr.trim() ? `\n${result.stderr.trim()}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashInputs(paths: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(relative(REPOSITORY, path));
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 24);
}

function writeAtomic(path: string, bytes: string | Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, bytes);
  renameSync(temporary, path);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const direct = args.find((arg) => arg.startsWith(`${flag}=`));
  if (direct) return direct.slice(flag.length + 1);
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

async function ensureDownload(
  asset: string,
  url: string,
  expectedSha256: string,
  expectedBytes?: number,
): Promise<string> {
  const destination = nokiaN9DownloadPath(asset);
  mkdirSync(dirname(destination), { recursive: true });
  if (!existsSync(destination) ||
      (expectedBytes !== undefined && statSync(destination).size !== expectedBytes) ||
      sha256(destination) !== expectedSha256) {
    rmSync(destination, { force: true });
    await mustRun("curl", [
      "--fail",
      "--location",
      "--output",
      destination,
      url,
    ], { inherit: true });
  }
  if (sha256(destination) !== expectedSha256) {
    throw new Error(`pocket nokia-n9: ${asset} failed SHA-256 verification`);
  }
  if (expectedBytes !== undefined && statSync(destination).size !== expectedBytes) {
    throw new Error(`pocket nokia-n9: ${asset} has the wrong byte length`);
  }
  return destination;
}

export interface NokiaN9PackageIdentity {
  readonly packageName: string;
  readonly executable: string;
  readonly title: string;
  readonly version: string;
  readonly output: string;
}

export function nokiaN9PackageIdentity(
  plan: ResolvedBuildPlan,
  manifest: { readonly name: string; readonly version: string },
): NokiaN9PackageIdentity {
  const packageName = manifest.name
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!/^[a-z0-9][a-z0-9+.-]{1,62}$/.test(packageName)) {
    throw new Error("pocket nokia-n9: manifest name is not a safe Debian package name");
  }
  const executable = plan.app.output
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!executable) throw new Error("pocket nokia-n9: app output has no safe executable name");
  if (!/^[0-9][a-zA-Z0-9.+:~_-]*$/.test(manifest.version)) {
    throw new Error("pocket nokia-n9: manifest version is not a safe Debian version");
  }
  if (!plan.app.title.trim() || /[\r\n\0]/.test(plan.app.title)) {
    throw new Error("pocket nokia-n9: app title is not safe for desktop metadata");
  }
  return {
    packageName,
    executable,
    title: plan.app.title,
    version: manifest.version,
    output: plan.app.output,
  };
}

async function setup(): Promise<void> {
  await ensureDownload(
    NOKIA_N9_TOOLCHAIN.sdk.asset,
    NOKIA_N9_TOOLCHAIN.sdk.url,
    NOKIA_N9_TOOLCHAIN.sdk.sha256,
    NOKIA_N9_TOOLCHAIN.sdk.bytes,
  );
  await ensureDownload(
    NOKIA_N9_TOOLCHAIN.quickjs.asset,
    NOKIA_N9_TOOLCHAIN.quickjs.url,
    NOKIA_N9_TOOLCHAIN.quickjs.sha256,
  );
  await mustRun("docker", nokiaN9DockerBuildArguments(REPOSITORY), { inherit: true });
  await mustRun("docker", ["volume", "create", NOKIA_N9_TOOLCHAIN.container.volume]);
  await mustRun("docker", [
    "run",
    "--rm",
    "--platform",
    NOKIA_N9_TOOLCHAIN.container.platform,
    "--network=none",
    "--mount",
    `type=volume,src=${NOKIA_N9_TOOLCHAIN.container.volume},dst=/toolchain`,
    "--mount",
    `type=bind,src=${nokiaN9DownloadsRoot()},dst=/downloads,readonly`,
    NOKIA_N9_TOOLCHAIN.container.image,
    "pocketjs-nokia-n9-setup",
  ], { inherit: true });
  const installed = await mustRun("rustup", ["toolchain", "list"]);
  if (!installed.split(/\r?\n/).some((line) =>
    line.startsWith(NOKIA_N9_TOOLCHAIN.runtime.rustToolchain))) {
    await mustRun("rustup", [
      "toolchain",
      "install",
      NOKIA_N9_TOOLCHAIN.runtime.rustToolchain,
      "--profile",
      "minimal",
      "--component",
      "rust-src",
    ], { inherit: true });
  }
}

async function imageReady(): Promise<boolean> {
  const result = await run("docker", [
    "image",
    "inspect",
    "--format",
    '{{index .Config.Labels "org.pocketjs.nokia-n9.toolchain"}} {{index .Config.Labels "org.pocketjs.nokia-n9.implementation"}}',
    NOKIA_N9_TOOLCHAIN.container.image,
  ]);
  return result.exitCode === 0 && result.stdout.trim() ===
    `${NOKIA_N9_TOOLCHAIN.toolchainVersion} ${nokiaN9ImplementationDigest(REPOSITORY)}`;
}

function validateDeviceHost(host: string): string {
  if (!/^[a-zA-Z0-9.-]+$/.test(host) || host.startsWith("-") || host.includes("..")) {
    throw new Error("pocket nokia-n9: --host must be an IPv4 address or DNS name");
  }
  return host;
}

function pairedHost(): string | undefined {
  if (!existsSync(PAIRING_RECEIPT)) return undefined;
  try {
    const value = JSON.parse(readFileSync(PAIRING_RECEIPT, "utf8")) as {
      schema?: number;
      host?: string;
    };
    return value.schema === 1 && value.host ? validateDeviceHost(value.host) : undefined;
  } catch {
    return undefined;
  }
}

function sshBase(host?: string): string[] {
  if (!existsSync(PRIVATE_KEY) || !existsSync(KNOWN_HOSTS)) {
    throw new Error("pocket nokia-n9: device key is absent; run `bun nokia-n9 pair --host <address>`");
  }
  const address = validateDeviceHost(
    host ?? process.env.POCKETJS_NOKIA_N9_HOST ?? pairedHost() ??
      NOKIA_N9_TOOLCHAIN.device.defaultHost,
  );
  return [
    "-i", PRIVATE_KEY,
    "-o", `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "ConnectTimeout=5",
    "-o", "ServerAliveInterval=5",
    "-o", "HostkeyAlgorithms=+ssh-rsa",
    "-o", "PubkeyAcceptedAlgorithms=+ssh-rsa",
    `${NOKIA_N9_TOOLCHAIN.device.user}@${address}`,
  ];
}

function sftpQuote(path: string): string {
  if (path.includes("\n") || path.includes("\r")) {
    throw new Error("pocket nokia-n9: SFTP path contains a newline");
  }
  return `"${path.replace(/["\\]/g, "\\$&")}"`;
}

async function sftpTransfer(command: "put" | "get", source: string, destination: string): Promise<void> {
  await mustRun("sftp", ["-b", "-", ...sshBase()], {
    input: `${command} ${sftpQuote(source)} ${sftpQuote(destination)}\n`,
  });
}

async function doctor(device: boolean): Promise<boolean> {
  let ok = true;
  for (const { label, path, expected, bytes } of [
    {
      label: "Qt SDK archive",
      path: nokiaN9DownloadPath(NOKIA_N9_TOOLCHAIN.sdk.asset),
      expected: NOKIA_N9_TOOLCHAIN.sdk.sha256,
      bytes: NOKIA_N9_TOOLCHAIN.sdk.bytes,
    },
    {
      label: "QuickJS source",
      path: nokiaN9DownloadPath(NOKIA_N9_TOOLCHAIN.quickjs.asset),
      expected: NOKIA_N9_TOOLCHAIN.quickjs.sha256,
      bytes: undefined,
    },
  ] as const) {
    const valid = existsSync(path) && sha256(path) === expected &&
      (bytes === undefined || statSync(path).size === bytes);
    console.log(`${valid ? "✓" : "✗"} ${label}`);
    ok = valid && ok;
  }
  const image = await imageReady();
  console.log(`${image ? "✓" : "✗"} pinned linux/amd64 toolchain image`);
  ok = image && ok;
  if (image) {
    mkdirSync(OUTPUT_ROOT, { recursive: true });
    const checked = await run("docker", nokiaN9DockerRunArguments(
      REPOSITORY,
      "pocketjs-nokia-n9-doctor",
    ));
    if (checked.stdout) process.stdout.write(checked.stdout);
    if (checked.stderr) process.stderr.write(checked.stderr);
    ok = checked.exitCode === 0 && ok;
  }
  const rust = await run("rustup", [
    "run",
    NOKIA_N9_TOOLCHAIN.runtime.rustToolchain,
    "rustc",
    "--version",
  ]);
  console.log(`${rust.exitCode === 0 ? "✓" : "✗"} ${NOKIA_N9_TOOLCHAIN.runtime.rustToolchain}`);
  ok = rust.exitCode === 0 && ok;

  if (device) {
    rmSync(DEVICE_RUNTIME_RECEIPT, { force: true });
    const storage = await run("lsusb", [
      "-d",
      `${NOKIA_N9_TOOLCHAIN.device.usbVendorId}:${NOKIA_N9_TOOLCHAIN.device.storageProductId}`,
    ]);
    if (storage.exitCode === 0 && storage.stdout.includes("N9")) {
      console.error("✗ Nokia N9 is in Storage mode; select SDK mode and start SDK Connectivity");
      return false;
    }
    const remote = await run("ssh", [
      ...sshBase(),
      "printf 'model='; hostname; printf 'arch='; uname -m; printf 'kernel='; uname -r; printf 'harmattan='; dpkg-query -W -f='${Version}\\n' meego-nokia-version 2>/dev/null; printf 'qt='; dpkg-query -W -f='${Version}\\n' libqt4-core 2>/dev/null",
    ]);
    const accepted = remote.exitCode === 0 &&
      /^model=RM-?696$/im.test(remote.stdout) &&
      /^arch=armv7/im.test(remote.stdout) &&
      /^kernel=.*dfl61/im.test(remote.stdout) &&
      /^harmattan=\S+/im.test(remote.stdout) &&
      /^qt=\S+/im.test(remote.stdout);
    console.log(`${accepted ? "✓" : "✗"} Nokia N9 Harmattan SSH runtime`);
    if (accepted) {
      const fields = Object.fromEntries(remote.stdout.trim().split(/\r?\n/).map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }));
      writeAtomic(DEVICE_RUNTIME_RECEIPT, `${JSON.stringify({
        schema: 1,
        model: fields.model,
        arch: fields.arch,
        kernel: fields.kernel,
        harmattan: fields.harmattan,
        qt: fields.qt,
      }, null, 2)}\n`);
      console.log(remote.stdout.trim());
    }
    ok = accepted && ok;
  }
  return ok;
}

async function pair(host: string): Promise<void> {
  const address = validateDeviceHost(host);
  mkdirSync(KEY_ROOT, { recursive: true });
  if (!existsSync(PRIVATE_KEY)) {
    await mustRun("ssh-keygen", ["-t", "rsa", "-b", "3072", "-N", "", "-f", PRIVATE_KEY]);
    chmodSync(PRIVATE_KEY, 0o600);
  }
  await mustRun("ssh-copy-id", [
    "-i",
    `${PRIVATE_KEY}.pub`,
    "-o",
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    "-o",
    "StrictHostKeyChecking=ask",
    "-o",
    "HostkeyAlgorithms=+ssh-rsa",
    "-o",
    "PubkeyAcceptedAlgorithms=+ssh-rsa",
    `${NOKIA_N9_TOOLCHAIN.device.user}@${address}`,
  ], { inherit: true });
  writeAtomic(PAIRING_RECEIPT, `${JSON.stringify({ schema: 1, host: address }, null, 2)}\n`);
}

async function buildRustCore(payload: string): Promise<string> {
  const targetRoot = join(OUTPUT_ROOT, ".cargo-nokia-n9");
  const rustupRoot = resolve(process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"));
  const cargoRoot = resolve(process.env.CARGO_HOME ?? join(homedir(), ".cargo"));
  if (!existsSync(rustupRoot) || !existsSync(cargoRoot)) {
    throw new Error("pocket nokia-n9: pinned Rust or Cargo home is missing; run setup --yes");
  }
  const args = nokiaN9DockerRunArguments(REPOSITORY, "/cargo/bin/rustup", [
    "run", NOKIA_N9_TOOLCHAIN.runtime.rustToolchain, "cargo",
    "build",
    "--release",
    "--locked",
    "--offline",
    "--target",
    "targets/armv7-nokia-n9-eabihf.json",
    "-Z",
    "json-target-spec",
    "-Z",
    "build-std=core,alloc,compiler_builtins",
    "-Z",
    "build-std-features=compiler-builtins-mem",
    "--features",
    "bare-platform",
  ]);
  args.splice(args.indexOf(NOKIA_N9_TOOLCHAIN.container.image), 0,
    "--env", "RUSTUP_HOME=/rustup",
    "--env", "CARGO_HOME=/cargo",
    "--env", "CARGO_NET_OFFLINE=true",
    "--env", "CARGO_TARGET_DIR=/out/.cargo-nokia-n9",
    "--env", "CARGO_PROFILE_RELEASE_OPT_LEVEL=2",
    "--mount", `type=bind,src=${rustupRoot},dst=/rustup,readonly`,
    "--mount", `type=bind,src=${cargoRoot},dst=/cargo,readonly`,
    "--workdir", "/work/engine/symbian");
  await mustRun("docker", args, { inherit: true });
  const library = join(
    targetRoot,
    "armv7-nokia-n9-eabihf/release/libpocketjs_symbian_core.a",
  );
  if (!existsSync(library)) throw new Error("pocket nokia-n9: Rust core archive is missing");
  const staged = join(payload, "libpocketjs_symbian_core.a");
  copyFileSync(library, staged);
  return staged;
}

async function buildApp(manifestPath: string): Promise<string> {
  if (!await doctor(false)) throw new Error("pocket nokia-n9: toolchain doctor failed");
  const absoluteManifest = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(absoluteManifest, "utf8"));
  const plan = resolveNokiaN9BuildPlan(manifest);
  const identity = nokiaN9PackageIdentity(plan, manifest);
  const payload = join(OUTPUT_ROOT, "build", plan.app.output);
  rmSync(payload, { recursive: true, force: true });
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
  writeFileSync(join(payload, "package.json"), `${JSON.stringify(identity, null, 2)}\n`);

  await mustRun("bun", [
    "tools/build.ts",
    `--plan=${join(payload, "plan.json")}`,
    `--project-root=${REPOSITORY}`,
    `--outdir=${payload}`,
  ], { inherit: true });
  copyFileSync(join(payload, `${plan.app.output}.js`), join(payload, "app.js"));
  copyFileSync(join(payload, `${plan.app.output}.pak`), join(payload, "app.pak"));
  const core = await buildRustCore(payload);

  const nativeInputs = [
    join(REPOSITORY, "hosts/symbian/runtime/main.cpp"),
    join(REPOSITORY, "hosts/symbian/runtime/pocketjs_symbian_core.h"),
    join(REPOSITORY, "hosts/symbian/runtime/pocketjs_symbian_extension.h"),
    join(REPOSITORY, "hosts/symbian/runtime/pocketjs_symbian_keys.h"),
    join(REPOSITORY, "hosts/nokia-n9/runtime/pocketjs-n9-runtime.pro"),
    join(REPOSITORY, "hosts/nokia-n9/runtime/pocketjs-n9.desktop.in"),
    join(REPOSITORY, "hosts/nokia-n9/runtime/manifest.aegis"),
    join(REPOSITORY, "hosts/symbian/runtime/pocketjs-runtime.qrc"),
    join(REPOSITORY, "tools/cli/nokia-n9-toolchain.json"),
    join(REPOSITORY, "tools/nokia-n9/container/pocketjs-nokia-n9-build-app"),
    join(REPOSITORY, "tools/nokia-n9/container/patches/quickjs-harmattan.patch"),
    join(REPOSITORY, "apps/meizu-m8-demo/icon80.png"),
    absoluteManifest,
    join(payload, "plan.json"),
    join(payload, "app.js"),
    join(payload, "app.pak"),
    core,
  ];
  const buildId = hashInputs(nativeInputs);
  writeFileSync(join(payload, "build-id.txt"), `${buildId}\n`);

  const args = nokiaN9DockerRunArguments(
    REPOSITORY,
    "pocketjs-nokia-n9-build-app",
    ["/out/build/" + plan.app.output],
  );
  args.splice(args.indexOf(NOKIA_N9_TOOLCHAIN.container.image), 0,
    "--mount",
    `type=bind,src=${nokiaN9DownloadsRoot()},dst=/downloads,readonly`);
  await mustRun("docker", args, { inherit: true });
  const output = join(
    OUTPUT_ROOT,
    `${identity.packageName}_${identity.version}-1_armel.deb`,
  );
  if (!existsSync(output)) throw new Error(`pocket nokia-n9: expected package is missing: ${output}`);
  return output;
}

async function buildProbe(): Promise<string> {
  if (!await doctor(false)) throw new Error("pocket nokia-n9: toolchain doctor failed");
  mkdirSync(OUTPUT_ROOT, { recursive: true });
  const args = nokiaN9DockerRunArguments(REPOSITORY, "pocketjs-nokia-n9-build-probe");
  await mustRun("docker", args, { inherit: true });
  const output = join(OUTPUT_ROOT, "pocketjs-n9-probe_0.1.0-1_armel.deb");
  if (!existsSync(output)) throw new Error("pocket nokia-n9: probe package is missing");
  return output;
}

function receiptForDeb(deb: string): { buildId: string; packageName: string; executable: string } {
  const receipt = deb.replace(/\.deb$/, ".receipt.json");
  if (!existsSync(receipt)) throw new Error(`pocket nokia-n9: missing receipt ${receipt}`);
  return JSON.parse(readFileSync(receipt, "utf8"));
}

async function deploy(debPath: string): Promise<void> {
  const deb = resolve(debPath);
  const receipt = receiptForDeb(deb);
  const remoteDirectory = `/home/developer/pocketjs-deploy/${receipt.buildId}`;
  const remoteDeb = `${remoteDirectory}/${deb.split("/").pop()}`;
  await mustRun("ssh", [...sshBase(), `mkdir -p '${remoteDirectory}'`]);
  await sftpTransfer("put", deb, remoteDeb);
  const remoteHash = await mustRun("ssh", [...sshBase(), `sha256sum '${remoteDeb}' | cut -d' ' -f1`]);
  if (remoteHash !== sha256(deb)) throw new Error("pocket nokia-n9: device package readback mismatch");
  console.log("Package copied and verified. Enter the device root password when prompted.");
  await mustRun("ssh", ["-tt", ...sshBase(), `devel-su -c \"dpkg -i '${remoteDeb}'\"`], { inherit: true });
  const installed = await mustRun("ssh", [
    ...sshBase(),
    `dpkg-query -W -f='\${Version}' '${receipt.packageName}'`,
  ]);
  console.log(`installed ${receipt.packageName} ${installed}`);
}

async function latestReceipt(): Promise<{ buildId: string; packageName: string; executable: string }> {
  const path = join(OUTPUT_ROOT, "latest.receipt.json");
  if (!existsSync(path)) throw new Error("pocket nokia-n9: no app build receipt; run build app");
  return JSON.parse(readFileSync(path, "utf8"));
}

async function launch(): Promise<void> {
  const receipt = await latestReceipt();
  await mustRun("ssh", [
    ...sshBase(),
    `DISPLAY=:0 /usr/bin/invoker --single-instance --type=e /opt/${receipt.packageName}/bin/${receipt.executable} >/tmp/pocketjs-n9-launch.log 2>&1 &`,
  ]);
  console.log(`launch requested for ${receipt.packageName}`);
}

export interface NokiaN9DeviceStatus {
  readonly schema: number;
  readonly build_id: string;
  readonly target: string;
  readonly host_abi: number;
  readonly pid: number;
  readonly state: string;
  readonly error: string;
  readonly heartbeat: number;
  readonly guest_frames: number;
  readonly presented_frames: number;
  readonly logical_width: number;
  readonly logical_height: number;
  readonly physical_width: number;
  readonly physical_height: number;
  readonly orientation: "landscape" | "portrait";
  readonly quarter_turns: number;
  readonly orientation_transitions: number;
  readonly context_generation: number;
  readonly display_active: boolean;
  readonly tick_hz: number;
  readonly renderer: string;
  readonly gl_version: string;
  readonly gl_vendor: string;
  readonly gl_renderer: string;
  readonly gl_max_texture_size: number;
  readonly completed_touch_sequences: number;
  readonly action_name: string;
  readonly action_value: number;
  readonly action_sequence: number;
  readonly timings_us: {
    readonly javascript: number;
    readonly pending_jobs: number;
    readonly core_tick: number;
    readonly gl_submit: number;
    readonly swap: number;
    readonly total: number;
  };
  readonly fps_window: {
    readonly samples: number;
    readonly warmup_remaining: number;
    readonly average_hz: number;
    readonly p95_ms: number;
    readonly max_ms: number;
    readonly missed_vblanks: number;
  };
}

export function parseNokiaN9Status(text: string): NokiaN9DeviceStatus {
  const value = JSON.parse(text) as NokiaN9DeviceStatus;
  if (value.schema !== 1 || value.target !== "nokia-n9-dev" || value.host_abi !== 9) {
    throw new Error("pocket nokia-n9: malformed or incompatible device status");
  }
  if (!value.fps_window || !value.timings_us || !Number.isInteger(value.pid)) {
    throw new Error("pocket nokia-n9: incomplete device status");
  }
  return value;
}

async function readStatus(buildId: string): Promise<NokiaN9DeviceStatus> {
  const path = `/tmp/pocketjs-n9-${buildId}.status.json`;
  return parseNokiaN9Status(await mustRun("ssh", [...sshBase(), `cat '${path}'`]));
}

export function validateNokiaN9Status(
  first: NokiaN9DeviceStatus,
  current: NokiaN9DeviceStatus,
  buildId: string,
  requireAction: boolean,
): void {
  if (current.build_id !== buildId || current.state !== "running" || current.error) {
    throw new Error(`pocket nokia-n9: device state=${current.state} error=${current.error || "none"}`);
  }
  if (current.heartbeat <= first.heartbeat || current.presented_frames <= first.presented_frames) {
    throw new Error("pocket nokia-n9: device frame heartbeat did not advance");
  }
  if (current.tick_hz !== 60 || current.renderer !== "gles2") {
    throw new Error("pocket nokia-n9: device is not running the 60 Hz GLES2 path");
  }
  const landscape = current.orientation === "landscape" &&
    current.logical_width === 854 && current.logical_height === 480;
  const portrait = current.orientation === "portrait" &&
    current.logical_width === 480 && current.logical_height === 854;
  if ((!landscape && !portrait) || current.physical_width !== 854 ||
      current.physical_height !== 480 || !current.display_active) {
    throw new Error("pocket nokia-n9: device viewport or visibility is invalid");
  }
  if (requireAction && (
    current.completed_touch_sequences < 1 ||
    current.action_name !== "hero_tap" ||
    current.action_value < 1 ||
    current.action_sequence < 1
  )) throw new Error("pocket nokia-n9: no completed Hero touch/action receipt yet");
}

async function status(requireAction: boolean): Promise<NokiaN9DeviceStatus> {
  const receipt = await latestReceipt();
  const first = await readStatus(receipt.buildId);
  await Bun.sleep(1200);
  const current = await readStatus(receipt.buildId);
  validateNokiaN9Status(first, current, receipt.buildId, requireAction);
  console.log(JSON.stringify(current, null, 2));
  return current;
}

export function normalizeNokiaN9Frame(
  raw: Uint8Array,
  width: number,
  height: number,
  quarterTurns: number,
): { width: number; height: number; rgba: Uint8ClampedArray } {
  if (raw.byteLength !== width * height * 4) throw new Error("N9 RGBA frame has the wrong byte length");
  const turns = quarterTurns & 3;
  const outputWidth = turns & 1 ? height : width;
  const outputHeight = turns & 1 ? width : height;
  const rgba = new Uint8ClampedArray(outputWidth * outputHeight * 4);
  const sourceAt = (physicalX: number, physicalYTop: number): number =>
    ((height - 1 - physicalYTop) * width + physicalX) * 4;
  for (let y = 0; y < outputHeight; y += 1) {
    for (let x = 0; x < outputWidth; x += 1) {
      let physicalX = x;
      let physicalY = y;
      if (turns === 1) {
        physicalX = width - 1 - y;
        physicalY = x;
      } else if (turns === 2) {
        physicalX = width - 1 - x;
        physicalY = height - 1 - y;
      } else if (turns === 3) {
        physicalX = y;
        physicalY = height - 1 - x;
      }
      const source = sourceAt(physicalX, physicalY);
      const target = (y * outputWidth + x) * 4;
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = raw[source + 3];
    }
  }
  return { width: outputWidth, height: outputHeight, rgba };
}

export function mapNokiaN9Touch(
  physicalX: number,
  physicalY: number,
  logicalWidth: number,
  logicalHeight: number,
  quarterTurns: number,
): { x: number; y: number } {
  const turns = quarterTurns & 3;
  if (turns === 1) {
    return { x: physicalY, y: logicalHeight - 1 - physicalX };
  }
  if (turns === 2) {
    return {
      x: logicalWidth - 1 - physicalX,
      y: logicalHeight - 1 - physicalY,
    };
  }
  if (turns === 3) {
    return { x: logicalWidth - 1 - physicalY, y: physicalX };
  }
  return { x: physicalX, y: physicalY };
}

interface NokiaN9RuntimeReceipt {
  readonly schema: 1;
  readonly model: string;
  readonly arch: string;
  readonly kernel: string;
  readonly harmattan: string;
  readonly qt: string;
}

export interface NokiaN9CaptureReceipt {
  readonly schema: 1;
  readonly build_id: string;
  readonly orientation: "landscape" | "portrait";
  readonly sequence: number;
  readonly width: number;
  readonly height: number;
  readonly quarter_turns: number;
  readonly guest_frame: number;
  readonly gl_version: string;
  readonly gl_vendor: string;
  readonly gl_renderer: string;
  readonly raw_sha256: string;
  readonly device_fingerprint: string;
  readonly device: NokiaN9RuntimeReceipt;
}

function nokiaN9RuntimeReceipt(): NokiaN9RuntimeReceipt {
  if (!existsSync(DEVICE_RUNTIME_RECEIPT)) {
    throw new Error("pocket nokia-n9: device receipt is missing; run doctor --device");
  }
  const value = JSON.parse(readFileSync(DEVICE_RUNTIME_RECEIPT, "utf8")) as NokiaN9RuntimeReceipt;
  if (value.schema !== 1 || !/^RM-?696$/i.test(value.model) ||
      !/^armv7/i.test(value.arch) || !/dfl61/i.test(value.kernel) ||
      !value.harmattan || !value.qt) {
    throw new Error("pocket nokia-n9: device receipt is incompatible");
  }
  return value;
}

export function validateNokiaN9CaptureReceipts(
  captures: readonly NokiaN9CaptureReceipt[],
  buildId: string,
): string {
  const groups = new Map<string, NokiaN9CaptureReceipt[]>();
  for (const capture of captures) {
    if (capture.schema !== 1 || capture.build_id !== buildId ||
        !/^[a-f0-9]{64}$/.test(capture.raw_sha256)) continue;
    const group = groups.get(capture.device_fingerprint) ?? [];
    group.push(capture);
    groups.set(capture.device_fingerprint, group);
  }
  for (const [fingerprint, group] of groups) {
    let complete = true;
    for (const orientation of ["landscape", "portrait"] as const) {
      const latest = group
        .filter((capture) => capture.orientation === orientation)
        .sort((left, right) => left.sequence - right.sequence)
        .slice(-3);
      const expectedTurns = orientation === "landscape" ? 0 : 3;
      if (latest.length !== 3 || new Set(latest.map((capture) => capture.raw_sha256)).size !== 1 ||
          latest.some((capture) => capture.width !== 854 || capture.height !== 480 ||
            capture.quarter_turns !== expectedTurns || capture.guest_frame % 24 !== 0)) {
        complete = false;
        break;
      }
    }
    if (complete) return fingerprint;
  }
  throw new Error(
    "pocket nokia-n9: capture three byte-identical aligned frames in each orientation",
  );
}

async function capture(): Promise<string> {
  const receipt = await latestReceipt();
  const prefix = `/tmp/pocketjs-n9-${receipt.buildId}`;
  await mustRun("ssh", [...sshBase(), `rm -f '${prefix}.frame.rgba' '${prefix}.frame.json'; touch '${prefix}.capture-request'`]);
  let metadata = "";
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await Bun.sleep(100);
    const result = await run("ssh", [...sshBase(), `cat '${prefix}.frame.json' 2>/dev/null`]);
    if (result.exitCode === 0 && result.stdout.trim()) {
      metadata = result.stdout.trim();
      break;
    }
  }
  if (!metadata) throw new Error("pocket nokia-n9: capture timed out");
  const info = JSON.parse(metadata) as {
    build_id: string;
    width: number;
    height: number;
    quarter_turns: number;
    guest_frame: number;
    gl_version: string;
    gl_vendor: string;
    gl_renderer: string;
  };
  if (info.build_id !== receipt.buildId || info.width !== 854 || info.height !== 480 ||
      ![0, 3].includes(info.quarter_turns) || info.guest_frame % 24 !== 0 ||
      !info.gl_version || !info.gl_vendor || !info.gl_renderer) {
    throw new Error("pocket nokia-n9: stale or malformed capture sidecar");
  }
  const device = nokiaN9RuntimeReceipt();
  const deviceFingerprint = createHash("sha256").update(JSON.stringify([
    device.model,
    device.kernel,
    device.harmattan,
    device.qt,
    info.gl_version,
    info.gl_vendor,
    info.gl_renderer,
  ])).digest("hex").slice(0, 16);
  const firmware = device.harmattan.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const captureRoot = join(
    OUTPUT_ROOT,
    "captures",
    receipt.buildId,
    `${firmware}-${deviceFingerprint}`,
  );
  mkdirSync(captureRoot, { recursive: true });
  const orientation = info.quarter_turns === 0 ? "landscape" : "portrait";
  const sequence = readdirSync(captureRoot)
    .map((name) => new RegExp(`^${orientation}-(\\d{3})\\.json$`).exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .reduce((maximum, match) => Math.max(maximum, Number(match[1])), 0) + 1;
  const base = `${orientation}-${String(sequence).padStart(3, "0")}`;
  const rawPath = join(captureRoot, `${base}.rgba`);
  const rawTemporary = `${rawPath}.tmp-${process.pid}`;
  await sftpTransfer("get", `${prefix}.frame.rgba`, rawTemporary);
  if (statSync(rawTemporary).size !== info.width * info.height * 4) {
    rmSync(rawTemporary, { force: true });
    throw new Error("pocket nokia-n9: capture byte length does not match its sidecar");
  }
  renameSync(rawTemporary, rawPath);
  const raw = readFileSync(rawPath);
  const localReceipt: NokiaN9CaptureReceipt = {
    schema: 1,
    ...info,
    orientation,
    sequence,
    raw_sha256: createHash("sha256").update(raw).digest("hex"),
    device_fingerprint: deviceFingerprint,
    device,
  };
  writeAtomic(join(captureRoot, `${base}.json`), `${JSON.stringify(localReceipt, null, 2)}\n`);
  const normalized = normalizeNokiaN9Frame(raw, info.width, info.height, info.quarter_turns);
  const canvas = createCanvas(normalized.width, normalized.height);
  const image = canvas.getContext("2d").createImageData(normalized.width, normalized.height);
  image.data.set(normalized.rgba);
  canvas.getContext("2d").putImageData(image, 0, 0);
  const output = join(captureRoot, `${base}.png`);
  writeAtomic(output, canvas.toBuffer("image/png"));
  console.log(output);
  return output;
}

async function accept(): Promise<void> {
  const receipt = await latestReceipt();
  const current = await status(true);
  if (current.orientation_transitions < 2) throw new Error("pocket nokia-n9: rotate landscape → portrait → landscape before acceptance");
  if (current.action_value < 2) throw new Error("pocket nokia-n9: tap Hero in both orientations before acceptance");
  const fps = current.fps_window;
  if (fps.samples < 600 || fps.average_hz < 59 || fps.average_hz > 61 ||
      fps.p95_ms > 17.5 || fps.max_ms >= 25 || fps.missed_vblanks !== 0) {
    throw new Error(`pocket nokia-n9: 60 Hz acceptance failed: ${JSON.stringify(fps)}`);
  }
  const captureRoot = join(OUTPUT_ROOT, "captures", receipt.buildId);
  const captures: NokiaN9CaptureReceipt[] = [];
  if (existsSync(captureRoot)) {
    for (const directory of readdirSync(captureRoot, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue;
      const root = join(captureRoot, directory.name);
      for (const name of readdirSync(root).filter((entry) => entry.endsWith(".json"))) {
        captures.push(JSON.parse(readFileSync(join(root, name), "utf8")));
      }
    }
  }
  const fingerprint = validateNokiaN9CaptureReceipts(captures, receipt.buildId);
  console.log(`PocketJS Nokia N9 automated hardware gates passed (${fingerprint})`);
  console.log("Complete the documented 20-rotation, resume, edge-swipe, and visual-review checklist.");
}

const HELP = `PocketJS Nokia N9 / Harmattan toolchain

  bun nokia-n9 setup --yes
  bun nokia-n9 doctor [--device]
  bun nokia-n9 pair --host <address>
  bun nokia-n9 build probe
  bun nokia-n9 build app [--manifest <pocket.json>]
  bun nokia-n9 deploy <deb>
  bun nokia-n9 launch
  bun nokia-n9 status [--require-action]
  bun nokia-n9 capture
  bun nokia-n9 accept`;

export async function nokiaN9Main(args: readonly string[] = Bun.argv.slice(2)): Promise<void> {
  const command = args[0] ?? "help";
  if (command === "setup") {
    if (!args.includes("--yes")) throw new Error("setup downloads the archived Qt SDK; re-run with --yes");
    await setup();
  } else if (command === "doctor") {
    if (!await doctor(args.includes("--device"))) process.exitCode = 1;
  } else if (command === "pair") {
    const host = flagValue(args, "--host");
    if (!host) throw new Error("usage: bun nokia-n9 pair --host <address>");
    await pair(host);
  } else if (command === "build" && args[1] === "probe") {
    console.log(await buildProbe());
  } else if (command === "build" && args[1] === "app") {
    console.log(await buildApp(flagValue(args, "--manifest") ?? DEFAULT_MANIFEST));
  } else if (command === "deploy") {
    if (!args[1]) throw new Error("usage: bun nokia-n9 deploy <deb>");
    await deploy(args[1]);
  } else if (command === "launch") {
    await launch();
  } else if (command === "status") {
    await status(args.includes("--require-action"));
  } else if (command === "capture") {
    await capture();
  } else if (command === "accept") {
    await accept();
  } else if (["help", "--help", "-h"].includes(command)) {
    console.log(HELP);
  } else {
    console.error(HELP);
    throw new Error(`pocket nokia-n9: unknown command ${command}`);
  }
}

if (import.meta.main) {
  try {
    await nokiaN9Main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
