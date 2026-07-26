import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { POCKET_TARGETS, type Viewport } from "../contracts/spec/platforms.ts";
import {
  extractHostBuildInputs,
  hostBuildEnvironment,
  type HostBuildInputs,
} from "../framework/src/manifest/host-build-inputs.ts";
import type { ResolvedBuildPlan } from "../framework/src/manifest/plan.ts";

export const KINDLE_TARGET = "kindle-pw5";
export const KINDLE_HOST_ABI = 5;
export const KINDLE_RUST_TARGET = "armv7-unknown-linux-musleabihf";
export const DEFAULT_KINDLE_HOST = "192.168.15.244";
export const DEFAULT_KINDLE_PORT = 2222;
export const DEFAULT_KINDLE_USER = "root";
export const DEFAULT_KINDLE_KEY = "~/.ssh/pocketjs-kindle-ed25519";
export const DEFAULT_KINDLE_ROOT = "/mnt/us/pocketjs-dev";

const KINDLE_PROFILE = POCKET_TARGETS[KINDLE_TARGET];

export const KINDLE_COMMANDS = [
  "probe",
  "build",
  "deploy",
  "run",
  "reload",
  "logs",
  "dev",
] as const;

export type KindleCommand = (typeof KINDLE_COMMANDS)[number];

export interface KindleConnection {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly key: string;
  readonly remoteRoot: string;
}

export interface KindleCliOptions {
  readonly command: KindleCommand;
  readonly app?: string;
  readonly planPath?: string;
  readonly projectRoot: string;
  readonly outdir: string;
  readonly appOutput?: string;
  readonly skipBuild: boolean;
  readonly skipNative: boolean;
  readonly dryRun: boolean;
  readonly restart: boolean;
  readonly followLogs: boolean;
  readonly hubPort: number;
  readonly presentHz?: number;
  readonly motionWaveform?: "DU" | "A2";
  readonly ghostBudget?: number;
  readonly rotation: "auto" | "0" | "90" | "180" | "270";
  readonly connection: KindleConnection;
}

export interface BuildContext {
  readonly app?: string;
  readonly appOutput: string;
  readonly planPath?: string;
  readonly projectRoot: string;
  readonly outdir: string;
  readonly hostInputs: HostBuildInputs;
  readonly jsPath: string;
  readonly pakPath: string;
  readonly nativePath: string;
}

export interface ReleaseFile {
  readonly name: string;
  readonly source: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly executable: boolean;
}

export interface PreparedRelease {
  readonly hash: string;
  readonly appOutput: string;
  readonly directory: string;
  readonly files: readonly ReleaseFile[];
  cleanup(): void;
}

export interface DeployCommandPlan {
  readonly releasePath: string;
  readonly stagingPath: string;
  readonly prepare: readonly string[];
  readonly tar: readonly string[];
  readonly extract: readonly string[];
  readonly publish: readonly string[];
  readonly publishScript: string;
}

function optionValue(
  argv: string[],
  index: number,
  name: string,
): { value: string; consumed: number } | undefined {
  const arg = argv[index]!;
  const prefix = `--${name}=`;
  if (arg.startsWith(prefix)) {
    const value = arg.slice(prefix.length);
    if (!value) throw new Error(`PocketJS Kindle: --${name} requires a value`);
    return { value, consumed: 1 };
  }
  if (arg !== `--${name}`) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`PocketJS Kindle: --${name} requires a value`);
  }
  return { value, consumed: 2 };
}

function positiveInteger(value: string, label: string, maximum = 65_535): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`PocketJS Kindle: ${label} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

export function validateRemoteRoot(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  if (
    !normalized.startsWith("/") ||
    normalized.includes("..") ||
    !/^\/[A-Za-z0-9._/-]+$/.test(normalized)
  ) {
    throw new Error(
      "PocketJS Kindle: --remote-root must be an absolute path containing only letters, digits, /, ., _, and -",
    );
  }
  return normalized;
}

export function validateAppOutput(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(
      "PocketJS Kindle: app output must be a single safe filename stem (letters, digits, ., _, -)",
    );
  }
  return value;
}

function validateConnectionPart(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    throw new Error(`PocketJS Kindle: invalid ${label} ${JSON.stringify(value)}`);
  }
  return value;
}

export function parseKindleArgs(
  rawArgv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): KindleCliOptions {
  const argv = [...rawArgv];
  const rawCommand = argv.shift();
  if (!rawCommand || !KINDLE_COMMANDS.includes(rawCommand as KindleCommand)) {
    throw new Error(
      `PocketJS Kindle: expected command ${KINDLE_COMMANDS.join("|")}, got ${rawCommand ?? "<missing>"}`,
    );
  }

  let app: string | undefined;
  let planPath: string | undefined;
  let projectRoot = resolve(cwd);
  let outdir: string | undefined;
  let appOutput: string | undefined;
  let skipBuild = false;
  let skipNative = false;
  let dryRun = false;
  let restart = false;
  let followLogs = true;
  let hubPort = positiveInteger(env.PORT ?? "8130", "hub port");
  let presentHz: number | undefined;
  let motionWaveform: KindleCliOptions["motionWaveform"];
  let ghostBudget: number | undefined;
  let rotation: KindleCliOptions["rotation"] = "auto";
  let host = env.POCKETJS_KINDLE_HOST ?? DEFAULT_KINDLE_HOST;
  let port = positiveInteger(
    env.POCKETJS_KINDLE_PORT ?? String(DEFAULT_KINDLE_PORT),
    "SSH port",
  );
  let user = env.POCKETJS_KINDLE_USER ?? DEFAULT_KINDLE_USER;
  let key = env.POCKETJS_KINDLE_KEY ?? DEFAULT_KINDLE_KEY;
  let remoteRoot = env.POCKETJS_KINDLE_ROOT ?? DEFAULT_KINDLE_ROOT;

  for (let index = 0; index < argv.length;) {
    const arg = argv[index]!;
    let read: ReturnType<typeof optionValue>;
    if ((read = optionValue(argv, index, "plan"))) {
      planPath = resolve(cwd, read.value);
    } else if ((read = optionValue(argv, index, "project-root"))) {
      projectRoot = resolve(cwd, read.value);
    } else if ((read = optionValue(argv, index, "outdir"))) {
      outdir = resolve(cwd, read.value);
    } else if ((read = optionValue(argv, index, "app-output"))) {
      appOutput = validateAppOutput(read.value);
    } else if ((read = optionValue(argv, index, "host"))) {
      host = read.value;
    } else if ((read = optionValue(argv, index, "port"))) {
      port = positiveInteger(read.value, "SSH port");
    } else if ((read = optionValue(argv, index, "user"))) {
      user = read.value;
    } else if (
      (read = optionValue(argv, index, "key")) ||
      (read = optionValue(argv, index, "identity"))
    ) {
      key = read.value;
    } else if ((read = optionValue(argv, index, "remote-root"))) {
      remoteRoot = read.value;
    } else if ((read = optionValue(argv, index, "hub-port"))) {
      hubPort = positiveInteger(read.value, "hub port");
    } else if ((read = optionValue(argv, index, "present-hz"))) {
      presentHz = positiveInteger(read.value, "present rate", 60);
    } else if ((read = optionValue(argv, index, "motion-waveform"))) {
      if (read.value !== "DU" && read.value !== "A2") {
        throw new Error("PocketJS Kindle: --motion-waveform must be DU or A2");
      }
      motionWaveform = read.value;
    } else if ((read = optionValue(argv, index, "ghost-budget"))) {
      ghostBudget = positiveInteger(read.value, "ghost budget", 1_000_000);
    } else if ((read = optionValue(argv, index, "rotation"))) {
      if (!["auto", "0", "90", "180", "270"].includes(read.value)) {
        throw new Error("PocketJS Kindle: --rotation must be auto, 0, 90, 180, or 270");
      }
      rotation = read.value as KindleCliOptions["rotation"];
    } else {
      read = undefined;
      if (arg === "--skip-build") skipBuild = true;
      else if (arg === "--skip-native") skipNative = true;
      else if (arg === "--dry-run") dryRun = true;
      else if (arg === "--restart") restart = true;
      else if (arg === "--no-logs") followLogs = false;
      else if (arg.startsWith("-")) {
        throw new Error(`PocketJS Kindle: unknown option ${arg}`);
      } else if (!app) {
        app = arg;
      } else {
        throw new Error(`PocketJS Kindle: unexpected argument ${arg}`);
      }
    }
    index += read?.consumed ?? 1;
  }

  if (planPath && app) {
    throw new Error("PocketJS Kindle: pass either an app or --plan, not both");
  }
  if (appOutput && planPath) {
    throw new Error("PocketJS Kindle: --app-output cannot override --plan");
  }

  return {
    command: rawCommand as KindleCommand,
    app,
    planPath,
    projectRoot,
    outdir: outdir ?? resolve(projectRoot, "dist"),
    appOutput,
    skipBuild,
    skipNative,
    dryRun,
    restart,
    followLogs,
    hubPort,
    presentHz,
    motionWaveform,
    ghostBudget,
    rotation,
    connection: {
      host: validateConnectionPart(host, "SSH host"),
      port,
      user: validateConnectionPart(user, "SSH user"),
      key: resolve(cwd, expandHome(key, env.HOME ?? homedir())),
      remoteRoot: validateRemoteRoot(remoteRoot),
    },
  };
}

export function shellQuote(value: string): string {
  if (value.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function sshBaseArgs(connection: KindleConnection): string[] {
  return [
    "ssh",
    "-T",
    "-p",
    String(connection.port),
    "-i",
    connection.key,
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    `${connection.user}@${connection.host}`,
  ];
}

export function sshCommandArgs(
  connection: KindleConnection,
  remoteScript: string,
): string[] {
  return [...sshBaseArgs(connection), `sh -c ${shellQuote(remoteScript)}`];
}

export function probeRemoteScript(root = DEFAULT_KINDLE_ROOT): string {
  const safeRoot = validateRemoteRoot(root);
  return `set -u
echo '== PocketJS Kindle probe (read-only) =='
echo
echo '== uname =='
uname -a 2>&1 || true
echo
echo '== firmware =='
for pocketjs_file in /etc/prettyversion.txt /etc/version.txt /proc/device-tree/model; do
  if [ -r "$pocketjs_file" ]; then
    echo "-- $pocketjs_file"
    cat "$pocketjs_file" 2>&1 || true
    echo
  fi
done
echo
echo '== framebuffer =='
for pocketjs_file in /sys/class/graphics/fb0/name /sys/class/graphics/fb0/virtual_size /sys/class/graphics/fb0/bits_per_pixel /sys/class/graphics/fb0/stride /sys/class/graphics/fb0/rotate; do
  if [ -r "$pocketjs_file" ]; then
    printf '%s: ' "$pocketjs_file"
    cat "$pocketjs_file" 2>&1 || true
  fi
done
if command -v fbset >/dev/null 2>&1; then fbset -i 2>&1 || true; fi
echo
echo '== input =='
for pocketjs_input in /sys/class/input/input*; do
  [ -d "$pocketjs_input" ] || continue
  printf '%s: ' "$pocketjs_input"
  if [ -r "$pocketjs_input/name" ]; then cat "$pocketjs_input/name" 2>&1; else echo unknown; fi
done
echo
echo '== ARM loaders =='
for pocketjs_loader in /lib/ld-linux-armhf.so.3 /lib/ld-linux.so.3 /lib/ld-uClibc.so.0; do
  if [ -e "$pocketjs_loader" ]; then ls -l "$pocketjs_loader" 2>&1; fi
done
echo
echo '== PocketJS bootstrap =='
for pocketjs_file in ${shellQuote(safeRoot)}/run-runtime.sh ${shellQuote(safeRoot)}/stop-runtime.sh ${shellQuote(safeRoot)}/bin/fbink; do
  if [ -e "$pocketjs_file" ]; then ls -l "$pocketjs_file" 2>&1; else echo "missing: $pocketjs_file"; fi
done
if [ -x ${shellQuote(safeRoot)}/current/pocketjs-kindle ]; then
  echo
  echo '== PocketJS native host probe =='
  ${shellQuote(safeRoot)}/current/pocketjs-kindle --probe 2>&1 || true
fi`;
}

function deriveAppOutput(app: string, repositoryRoot: string): string {
  const normalized = app.replace(/\\/g, "/").replace(/\.tsx?$/, "");
  const parts = normalized.split("/");
  const leaf = parts.at(-1) ?? normalized;
  if (leaf === "main" && parts.length > 1) {
    return validateAppOutput(`${parts.at(-2)}-main`);
  }
  if (leaf === "app" && parts.length > 1) {
    return validateAppOutput(parts.at(-2)!);
  }
  if (
    !app.includes("/") &&
    !existsSync(resolve(repositoryRoot, "apps", app, "app.tsx")) &&
    !existsSync(resolve(repositoryRoot, "apps", app, "app.ts")) &&
    (
      existsSync(resolve(repositoryRoot, "apps", app, "main.tsx")) ||
      existsSync(resolve(repositoryRoot, "apps", app, "main.ts"))
    )
  ) {
    return validateAppOutput(`${app}-main`);
  }
  return validateAppOutput(leaf);
}

function mountedAppArgument(app: string, repositoryRoot: string): string {
  if (
    !app.includes("/") &&
    (
      existsSync(resolve(repositoryRoot, "apps", app, "main.tsx")) ||
      existsSync(resolve(repositoryRoot, "apps", app, "main.ts"))
    )
  ) {
    return `${app}-main`;
  }
  return app;
}

function sameViewport(left: Viewport, right: Viewport): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function validateKindleHostInputs(
  inputs: HostBuildInputs,
  planPath: string,
): void {
  const display = KINDLE_PROFILE.display;
  const logical = display.logicalViewports[0]!;
  if (
    display.logicalViewports.length !== 1 ||
    !sameViewport(inputs.viewport.logical, logical)
  ) {
    throw new Error(
      `PocketJS Kindle: ${planPath} has logical viewport ${
        inputs.viewport.logical.join("x")
      }, expected ${KINDLE_TARGET} ${logical.join("x")}`,
    );
  }
  if (!sameViewport(inputs.viewport.physical, display.physicalViewport)) {
    throw new Error(
      `PocketJS Kindle: ${planPath} has physical viewport ${
        inputs.viewport.physical.join("x")
      }, expected ${KINDLE_TARGET} ${display.physicalViewport.join("x")}`,
    );
  }
  if (inputs.viewport.rasterDensity !== display.rasterDensity) {
    throw new Error(
      `PocketJS Kindle: ${planPath} has raster density ${
        inputs.viewport.rasterDensity
      }, expected ${display.rasterDensity}`,
    );
  }
  if (!display.presentations.includes(inputs.viewport.presentation)) {
    throw new Error(
      `PocketJS Kindle: ${planPath} has unsupported presentation ${
        JSON.stringify(inputs.viewport.presentation)
      }; expected one of ${display.presentations.join(", ")}`,
    );
  }

  const scaleX = inputs.viewport.physical[0] / inputs.viewport.logical[0];
  const scaleY = inputs.viewport.physical[1] / inputs.viewport.logical[1];
  if (
    inputs.viewport.presentation === "native" &&
    (
      inputs.viewport.logical[0] * inputs.viewport.rasterDensity !==
        inputs.viewport.physical[0] ||
      inputs.viewport.logical[1] * inputs.viewport.rasterDensity !==
        inputs.viewport.physical[1]
    )
  ) {
    throw new Error(
      `PocketJS Kindle: ${planPath} native presentation does not match raster density`,
    );
  }
  if (
    inputs.viewport.presentation === "integer-fit" &&
    (!Number.isInteger(scaleX) || scaleX < 1 || scaleX !== scaleY)
  ) {
    throw new Error(
      `PocketJS Kindle: ${planPath} integer-fit presentation needs one positive integer scale`,
    );
  }
}

export async function resolveBuildContext(
  options: KindleCliOptions,
  repositoryRoot: string,
): Promise<BuildContext> {
  let appOutput: string;
  let hostInputs: HostBuildInputs;
  const resolvedApp = options.app
    ? mountedAppArgument(options.app, repositoryRoot)
    : undefined;
  if (options.planPath) {
    const plan = await Bun.file(options.planPath).json() as ResolvedBuildPlan;
    hostInputs = extractHostBuildInputs(plan, { expectedTarget: KINDLE_TARGET });
    if (hostInputs.hostAbi !== KINDLE_HOST_ABI) {
      throw new Error(
        `PocketJS Kindle: ${options.planPath} has host ABI ${hostInputs.hostAbi}, expected ${KINDLE_HOST_ABI}`,
      );
    }
    validateKindleHostInputs(hostInputs, options.planPath);
    appOutput = validateAppOutput(hostInputs.appOutput);
  } else {
    const app = resolvedApp;
    if (!app && !options.appOutput) {
      throw new Error(
        "PocketJS Kindle: this command needs an app, --app-output, or --plan",
      );
    }
    appOutput = validateAppOutput(
      options.appOutput ?? deriveAppOutput(app!, repositoryRoot),
    );
    hostInputs = {
      appOutput,
      target: KINDLE_TARGET,
      hostAbi: KINDLE_HOST_ABI,
      viewport: {
        logical: [309, 412],
        physical: [1236, 1648],
        presentation: "native",
        rasterDensity: 4,
      },
    };
  }

  return {
    app: resolvedApp,
    appOutput,
    planPath: options.planPath,
    projectRoot: options.projectRoot,
    outdir: options.outdir,
    hostInputs,
    jsPath: resolve(options.outdir, `${appOutput}.js`),
    pakPath: resolve(options.outdir, `${appOutput}.pak`),
    nativePath: resolve(
      repositoryRoot,
      "hosts/kindle/target",
      KINDLE_RUST_TARGET,
      "release/pocketjs-kindle",
    ),
  };
}

export function buildCommandPlan(
  context: BuildContext,
  options: Pick<KindleCliOptions, "skipBuild" | "skipNative">,
  repositoryRoot: string,
): Array<{ argv: string[]; cwd: string; env?: Readonly<Record<string, string>> }> {
  const commands: Array<{
    argv: string[];
    cwd: string;
    env?: Readonly<Record<string, string>>;
  }> = [];
  if (!options.skipBuild) {
    commands.push({
      argv: context.planPath
        ? [
          process.execPath,
          resolve(repositoryRoot, "tools/build.ts"),
          `--plan=${context.planPath}`,
          `--project-root=${context.projectRoot}`,
          `--outdir=${context.outdir}`,
        ]
        : [
          process.execPath,
          resolve(repositoryRoot, "tools/build.ts"),
          context.app!,
          "--density=4",
          `--outdir=${context.outdir}`,
        ],
      cwd: context.projectRoot,
    });
  }
  if (!options.skipNative) {
    // cargo-zigbuild 0.23 probes `python3 -m ziglang` before the standalone
    // Zig executable. The Kindle setup owns ~/.cargo/bin/zig and validates it
    // against the pinned SDK, so bypass an unrelated Python package and bind
    // the build to that exact tool. CLANG_PATH also keeps bindgen from invoking
    // Xcode's much heavier `xcodebuild -find clang` discovery path.
    const nativeToolEnvironment = {
      CARGO_ZIGBUILD_PYTHON_PATH: "/usr/bin/false",
      CARGO_ZIGBUILD_ZIG_PATH: resolve(homedir(), ".cargo", "bin", "zig"),
      CLANG_PATH:
        process.env.CLANG_PATH ?? Bun.which("clang") ?? "/usr/bin/clang",
    };
    commands.push({
      argv: [
        Bun.which("cargo") ?? "cargo",
        "zigbuild",
        "--manifest-path",
        resolve(repositoryRoot, "hosts/kindle/Cargo.toml"),
        "--release",
        "--target",
        KINDLE_RUST_TARGET,
        "--bin",
        "pocketjs-kindle",
      ],
      cwd: repositoryRoot,
      env: {
        ...hostBuildEnvironment(context.hostInputs, {
          outputDirectory: context.outdir,
          embedApp: false,
        }),
        ...nativeToolEnvironment,
      },
    });
  }
  return commands;
}

export function assertBuildArtifacts(context: BuildContext): void {
  for (const [label, path] of [
    ["JavaScript bundle", context.jsPath],
    ["asset pack", context.pakPath],
    ["native host", context.nativePath],
  ] as const) {
    let size = 0;
    try {
      size = statSync(path).size;
    } catch {
      size = 0;
    }
    if (size < 1) {
      throw new Error(`PocketJS Kindle: ${label} is missing or empty: ${path}`);
    }
  }
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function releaseContentHash(
  appOutput: string,
  files: readonly Pick<ReleaseFile, "name" | "sha256" | "bytes" | "executable">[],
): string {
  const canonical = {
    schemaVersion: 1,
    target: KINDLE_TARGET,
    hostAbi: KINDLE_HOST_ABI,
    appOutput: validateAppOutput(appOutput),
    files: [...files]
      .map((file) => ({
        name: file.name,
        sha256: file.sha256,
        bytes: file.bytes,
        executable: file.executable,
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function prepareRelease(context: BuildContext): PreparedRelease {
  assertBuildArtifacts(context);
  const inputs = [
    { name: `${context.appOutput}.js`, source: context.jsPath, executable: false },
    { name: `${context.appOutput}.pak`, source: context.pakPath, executable: false },
    { name: "pocketjs-kindle", source: context.nativePath, executable: true },
  ];
  const files: ReleaseFile[] = inputs.map((file) => ({
    ...file,
    sha256: sha256File(file.source),
    bytes: statSync(file.source).size,
  }));
  const hash = releaseContentHash(context.appOutput, files);
  const directory = mkdtempSync(join(tmpdir(), "pocketjs-kindle-release-"));
  for (const file of files) copyFileSync(file.source, join(directory, file.name));
  const receipt = {
    schemaVersion: 1,
    target: KINDLE_TARGET,
    hostAbi: KINDLE_HOST_ABI,
    appOutput: context.appOutput,
    releaseHash: hash,
    files: files.map(({ name, sha256, bytes, executable }) => ({
      name,
      sha256,
      bytes,
      executable,
    })),
  };
  writeFileSync(join(directory, "release.json"), JSON.stringify(receipt, null, 2) + "\n");
  const receiptFile: ReleaseFile = {
    name: "release.json",
    source: join(directory, "release.json"),
    sha256: sha256File(join(directory, "release.json")),
    bytes: statSync(join(directory, "release.json")).size,
    executable: false,
  };
  const deployedFiles = [...files, receiptFile];
  const sums = deployedFiles
    .map((file) => `${file.sha256}  ${file.name}`)
    .sort()
    .join("\n") + "\n";
  writeFileSync(join(directory, "SHA256SUMS"), sums);
  return {
    hash,
    appOutput: context.appOutput,
    directory,
    files: deployedFiles,
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

export function deployCommandPlan(
  connection: KindleConnection,
  release: Pick<PreparedRelease, "hash" | "directory">,
  nonce = `${process.pid}`,
): DeployCommandPlan {
  if (!/^[0-9a-f]{64}$/.test(release.hash)) {
    throw new Error("PocketJS Kindle: invalid release hash");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(nonce)) {
    throw new Error("PocketJS Kindle: invalid staging nonce");
  }
  const root = connection.remoteRoot;
  const releasePath = `${root}/releases/${release.hash}`;
  const stagingPath = `${root}/releases/.${release.hash}.staging-${nonce}`;
  const qRoot = shellQuote(root);
  const qRelease = shellQuote(releasePath);
  const qStage = shellQuote(stagingPath);

  const prepareScript = `set -eu
umask 077
mkdir -p ${qRoot}/releases ${qRoot}/runtime/pocketjs-dbg ${qRoot}/run ${qRoot}/logs
if [ -f ${qRelease}/.complete ]; then
  printf 'PRESENT\\n'
else
  rm -rf ${qStage}
  mkdir ${qStage}
  printf 'READY\\n'
fi`;
  const extractScript = `set -eu
test -d ${qStage}
tar -xf - -C ${qStage}`;
  const publishScript = `set -eu
pocketjs_release=${qRelease}
pocketjs_stage=${qStage}
pocketjs_root=${qRoot}
pocketjs_hash=${shellQuote(release.hash)}
pocketjs_publish_nonce=${shellQuote(nonce)}
pocketjs_publish_proc_root=\${POCKETJS_PUBLISH_PROC_ROOT:-/proc}
pocketjs_publish_lock_wait_limit=\${POCKETJS_PUBLISH_LOCK_WAIT_LIMIT:-60}
pocketjs_publish_lock="$pocketjs_root/run/publish.lock"
pocketjs_publish_recovery_lock="$pocketjs_root/run/publish.lock.recovery"
pocketjs_publish_owner_candidate="$pocketjs_root/run/.publish-owner-$pocketjs_publish_nonce.$$"
pocketjs_publish_recovery_owner_nonce="$pocketjs_publish_nonce.recovery"
pocketjs_publish_recovery_candidate_name=".publish-recovery-candidate-$pocketjs_publish_nonce.$$"
pocketjs_publish_recovery_candidate="$pocketjs_root/run/$pocketjs_publish_recovery_candidate_name"
pocketjs_publish_nested_recovery_candidate="$pocketjs_publish_recovery_lock/$pocketjs_publish_recovery_candidate_name"
pocketjs_publish_stale_lock="$pocketjs_root/run/.publish-stale-$pocketjs_publish_nonce.$$"
pocketjs_publish_stale_recovery_lock="$pocketjs_root/run/.publish-recovery-stale-$pocketjs_publish_nonce.$$"
pocketjs_publish_lock_acquired=0
pocketjs_publish_recovery_acquired=0
pocketjs_publish_stale_recovery_owned=0

pocketjs_valid_number() {
  case "\${1:-}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

pocketjs_process_stat_remainder() {
  pocketjs_stat_line=$(sed -n '1p' "$pocketjs_publish_proc_root/$1/stat" 2>/dev/null || true)
  case "$pocketjs_stat_line" in
    *") "*) ;;
    *) return 1 ;;
  esac
  printf '%s\\n' "\${pocketjs_stat_line##*) }"
}

pocketjs_process_starttime() {
  pocketjs_stat_remainder=$(pocketjs_process_stat_remainder "$1") || return 1
  set -- $pocketjs_stat_remainder
  [ "$#" -ge 20 ] || return 1
  shift 19
  pocketjs_valid_number "$1" || return 1
  printf '%s\\n' "$1"
}

pocketjs_process_state() {
  pocketjs_stat_remainder=$(pocketjs_process_stat_remainder "$1") || return 1
  set -- $pocketjs_stat_remainder
  [ "$#" -ge 1 ] || return 1
  printf '%s\\n' "$1"
}

pocketjs_process_identity_matches() {
  pocketjs_identity_pid=$1
  pocketjs_identity_start=$2
  pocketjs_valid_number "$pocketjs_identity_pid" || return 1
  pocketjs_valid_number "$pocketjs_identity_start" || return 1
  [ "$(pocketjs_process_starttime "$pocketjs_identity_pid" 2>/dev/null || true)" = "$pocketjs_identity_start" ] ||
    return 1
  pocketjs_identity_state=$(pocketjs_process_state "$pocketjs_identity_pid" 2>/dev/null || true)
  [ -n "$pocketjs_identity_state" ] && [ "$pocketjs_identity_state" != Z ]
}

pocketjs_read_publish_owner() {
  pocketjs_owner_file=$1
  pocketjs_owner_pid=$(sed -n 's/^pid=//p' "$pocketjs_owner_file" 2>/dev/null || true)
  pocketjs_owner_start=$(sed -n 's/^starttime=//p' "$pocketjs_owner_file" 2>/dev/null || true)
  pocketjs_owner_nonce=$(sed -n 's/^nonce=//p' "$pocketjs_owner_file" 2>/dev/null || true)
  pocketjs_valid_number "$pocketjs_owner_pid" || return 1
  pocketjs_valid_number "$pocketjs_owner_start" || return 1
  case "$pocketjs_owner_nonce" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
  esac
  [ "$(sed -n '4p' "$pocketjs_owner_file" 2>/dev/null || true)" = "" ]
}

pocketjs_publish_owner_matches() {
  pocketjs_expected_owner_file=$1
  pocketjs_expected_owner_pid=$2
  pocketjs_expected_owner_start=$3
  pocketjs_expected_owner_nonce=$4
  pocketjs_read_publish_owner "$pocketjs_expected_owner_file" &&
    [ "$pocketjs_owner_pid" = "$pocketjs_expected_owner_pid" ] &&
    [ "$pocketjs_owner_start" = "$pocketjs_expected_owner_start" ] &&
    [ "$pocketjs_owner_nonce" = "$pocketjs_expected_owner_nonce" ]
}

pocketjs_write_self_owner() {
  pocketjs_self_owner_file=$1
  pocketjs_self_owner_nonce=$2
  {
    printf 'pid=%s\\n' "$$"
    printf 'starttime=%s\\n' "$pocketjs_publish_self_start"
    printf 'nonce=%s\\n' "$pocketjs_self_owner_nonce"
  } >"$pocketjs_self_owner_file" &&
    pocketjs_publish_owner_matches \
      "$pocketjs_self_owner_file" "$$" "$pocketjs_publish_self_start" "$pocketjs_self_owner_nonce"
}

pocketjs_release_recovery_lock() {
  if [ "$pocketjs_publish_recovery_acquired" -eq 1 ] &&
    pocketjs_publish_owner_matches \
      "$pocketjs_publish_recovery_lock/owner" \
      "$$" "$pocketjs_publish_self_start" "$pocketjs_publish_recovery_owner_nonce"; then
    rm -f "$pocketjs_publish_recovery_lock/owner"
    rmdir "$pocketjs_publish_recovery_lock" 2>/dev/null || true
  fi
  pocketjs_publish_recovery_acquired=0
}

pocketjs_release_publish_lock() {
  if [ "$pocketjs_publish_lock_acquired" -eq 1 ] &&
    pocketjs_publish_owner_matches \
      "$pocketjs_publish_lock/owner" \
      "$$" "$pocketjs_publish_self_start" "$pocketjs_publish_nonce"; then
    rm -f "$pocketjs_publish_lock/owner"
    rmdir "$pocketjs_publish_lock" 2>/dev/null || true
  fi
  pocketjs_publish_lock_acquired=0
}

pocketjs_publish_cleanup() {
  rm -f "$pocketjs_publish_owner_candidate"
  rm -rf "$pocketjs_publish_recovery_candidate" "$pocketjs_publish_nested_recovery_candidate"
  pocketjs_release_publish_lock
  pocketjs_release_recovery_lock
  rm -rf "$pocketjs_publish_stale_lock"
  if [ "$pocketjs_publish_stale_recovery_owned" -eq 1 ]; then
    rm -rf "$pocketjs_publish_stale_recovery_lock"
  fi
}

pocketjs_try_acquire_recovery_lock() {
  rm -rf "$pocketjs_publish_recovery_candidate" "$pocketjs_publish_nested_recovery_candidate"
  if ! mkdir "$pocketjs_publish_recovery_candidate" 2>/dev/null ||
    ! pocketjs_write_self_owner \
      "$pocketjs_publish_recovery_candidate/owner" "$pocketjs_publish_recovery_owner_nonce"; then
    rm -rf "$pocketjs_publish_recovery_candidate"
    return 1
  fi
  if ! mv "$pocketjs_publish_recovery_candidate" "$pocketjs_publish_recovery_lock" 2>/dev/null; then
    rm -rf "$pocketjs_publish_recovery_candidate"
    return 1
  fi
  if pocketjs_publish_owner_matches \
    "$pocketjs_publish_recovery_lock/owner" \
    "$$" "$pocketjs_publish_self_start" "$pocketjs_publish_recovery_owner_nonce"; then
    pocketjs_publish_recovery_acquired=1
    return 0
  fi
  # POSIX mv nests a source directory when the destination already exists.
  # Remove only our uniquely named nested candidate and leave its owner alone.
  rm -rf "$pocketjs_publish_nested_recovery_candidate"
  return 1
}

pocketjs_restore_recovery_lock() {
  if [ ! -e "$pocketjs_publish_recovery_lock" ] &&
    [ ! -L "$pocketjs_publish_recovery_lock" ]; then
    mv "$pocketjs_publish_stale_recovery_lock" "$pocketjs_publish_recovery_lock" 2>/dev/null ||
      true
  fi
}

pocketjs_recover_stale_recovery_lock() {
  [ -d "$pocketjs_publish_recovery_lock" ] || return 1
  pocketjs_recovery_snapshot_valid=0
  if pocketjs_read_publish_owner "$pocketjs_publish_recovery_lock/owner"; then
    if pocketjs_process_identity_matches "$pocketjs_owner_pid" "$pocketjs_owner_start"; then
      return 1
    fi
    pocketjs_recovery_snapshot_pid=$pocketjs_owner_pid
    pocketjs_recovery_snapshot_start=$pocketjs_owner_start
    pocketjs_recovery_snapshot_nonce=$pocketjs_owner_nonce
    pocketjs_recovery_snapshot_valid=1
  fi

  # Re-read immediately before quarantine. If the generation changed, a
  # different publisher owns it and this recovery attempt must stand down.
  if [ "$pocketjs_recovery_snapshot_valid" -eq 1 ]; then
    pocketjs_publish_owner_matches \
      "$pocketjs_publish_recovery_lock/owner" \
      "$pocketjs_recovery_snapshot_pid" \
      "$pocketjs_recovery_snapshot_start" \
      "$pocketjs_recovery_snapshot_nonce" ||
      return 1
    pocketjs_process_identity_matches \
      "$pocketjs_recovery_snapshot_pid" "$pocketjs_recovery_snapshot_start" &&
      return 1
  elif pocketjs_read_publish_owner "$pocketjs_publish_recovery_lock/owner"; then
    return 1
  fi

  if [ -e "$pocketjs_publish_stale_recovery_lock" ] ||
    [ -L "$pocketjs_publish_stale_recovery_lock" ]; then
    return 1
  fi
  if ! mv "$pocketjs_publish_recovery_lock" "$pocketjs_publish_stale_recovery_lock"; then
    return 1
  fi
  if [ "$pocketjs_recovery_snapshot_valid" -eq 1 ]; then
    if ! pocketjs_publish_owner_matches \
      "$pocketjs_publish_stale_recovery_lock/owner" \
      "$pocketjs_recovery_snapshot_pid" \
      "$pocketjs_recovery_snapshot_start" \
      "$pocketjs_recovery_snapshot_nonce"; then
      pocketjs_restore_recovery_lock
      return 1
    fi
  elif pocketjs_read_publish_owner "$pocketjs_publish_stale_recovery_lock/owner"; then
    pocketjs_restore_recovery_lock
    return 1
  fi
  pocketjs_publish_stale_recovery_owned=1
  rm -rf "$pocketjs_publish_stale_recovery_lock"
  pocketjs_publish_stale_recovery_owned=0
  echo 'PocketJS Kindle: recovered stale publish recovery lock' >&2
  return 0
}

pocketjs_acquire_recovery_lock() {
  if pocketjs_try_acquire_recovery_lock; then
    return 0
  fi
  if pocketjs_recover_stale_recovery_lock &&
    pocketjs_try_acquire_recovery_lock; then
    return 0
  fi
  return 1
}

pocketjs_recover_stale_publish_lock() {
  if ! pocketjs_acquire_recovery_lock; then
    return 1
  fi

  if [ ! -d "$pocketjs_publish_lock" ]; then
    pocketjs_release_recovery_lock
    return 0
  fi
  if pocketjs_read_publish_owner "$pocketjs_publish_lock/owner" &&
    pocketjs_process_identity_matches "$pocketjs_owner_pid" "$pocketjs_owner_start"; then
    pocketjs_release_recovery_lock
    return 1
  fi

  pocketjs_publish_owner_matches \
    "$pocketjs_publish_recovery_lock/owner" \
    "$$" "$pocketjs_publish_self_start" "$pocketjs_publish_recovery_owner_nonce" ||
    {
      pocketjs_publish_recovery_acquired=0
      return 1
    }
  rm -rf "$pocketjs_publish_stale_lock"
  if ! mv "$pocketjs_publish_lock" "$pocketjs_publish_stale_lock"; then
    pocketjs_release_recovery_lock
    return 1
  fi
  rm -rf "$pocketjs_publish_stale_lock"
  pocketjs_release_recovery_lock
  echo 'PocketJS Kindle: recovered stale publish lock' >&2
  return 0
}

case "$pocketjs_publish_lock_wait_limit" in
  ''|*[!0-9]*)
    echo 'PocketJS Kindle: invalid publish lock wait limit' >&2
    exit 2
    ;;
esac
if [ "$pocketjs_publish_lock_wait_limit" -lt 1 ] ||
  [ "$pocketjs_publish_lock_wait_limit" -gt 300 ]; then
  echo 'PocketJS Kindle: publish lock wait limit must be between 1 and 300 seconds' >&2
  exit 2
fi

pocketjs_publish_self_start=$(pocketjs_process_starttime "$$" 2>/dev/null || true)
if ! pocketjs_valid_number "$pocketjs_publish_self_start"; then
  echo 'PocketJS Kindle: could not verify publish process identity' >&2
  exit 1
fi
if ! pocketjs_write_self_owner "$pocketjs_publish_owner_candidate" "$pocketjs_publish_nonce"; then
  echo 'PocketJS Kindle: could not prepare publish lock identity' >&2
  exit 1
fi

trap pocketjs_publish_cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

pocketjs_publish_wait=0
while [ "$pocketjs_publish_wait" -lt "$pocketjs_publish_lock_wait_limit" ]; do
  if [ ! -e "$pocketjs_publish_recovery_lock" ] &&
    [ ! -L "$pocketjs_publish_recovery_lock" ] &&
    mkdir "$pocketjs_publish_lock" 2>/dev/null; then
    if [ -e "$pocketjs_publish_recovery_lock" ] ||
      [ -L "$pocketjs_publish_recovery_lock" ]; then
      rmdir "$pocketjs_publish_lock" 2>/dev/null || true
    elif mv "$pocketjs_publish_owner_candidate" "$pocketjs_publish_lock/owner" &&
      pocketjs_publish_owner_matches \
        "$pocketjs_publish_lock/owner" \
        "$$" "$pocketjs_publish_self_start" "$pocketjs_publish_nonce"; then
      pocketjs_publish_lock_acquired=1
      break
    else
      rm -f "$pocketjs_publish_lock/owner"
      rmdir "$pocketjs_publish_lock" 2>/dev/null || true
      echo 'PocketJS Kindle: could not commit publish lock identity' >&2
      exit 1
    fi
  elif pocketjs_recover_stale_publish_lock; then
    :
  fi
  pocketjs_publish_wait=$((pocketjs_publish_wait + 1))
  sleep 1
done
if [ "$pocketjs_publish_lock_acquired" -ne 1 ]; then
  echo 'PocketJS Kindle: timed out waiting for the remote publish lock' >&2
  exit 1
fi

pocketjs_redundant_stage=0
if [ -d "$pocketjs_stage" ]; then
  cd "$pocketjs_stage"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c SHA256SUMS
  elif command -v busybox >/dev/null 2>&1; then
    busybox sha256sum -c SHA256SUMS
  else
    echo 'PocketJS Kindle: sha256sum is unavailable on device' >&2
    exit 1
  fi
  chmod 0755 pocketjs-kindle
  printf '%s\\n' "$pocketjs_hash" >.complete
  if [ -e "$pocketjs_release" ] || [ -L "$pocketjs_release" ]; then
    if [ ! -L "$pocketjs_release" ] &&
      [ -d "$pocketjs_release" ] &&
      [ "$(sed -n '1p' "$pocketjs_release/.complete" 2>/dev/null || true)" = "$pocketjs_hash" ]; then
      pocketjs_redundant_stage=1
    else
      echo 'PocketJS Kindle: refusing an incomplete or conflicting pre-existing release' >&2
      exit 1
    fi
  else
    mv "$pocketjs_stage" "$pocketjs_release"
  fi
fi
test "$(sed -n '1p' "$pocketjs_release/.complete")" = "$pocketjs_hash"
cd "$pocketjs_release"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  busybox sha256sum -c SHA256SUMS
fi
cd "$pocketjs_root"
if [ "$pocketjs_redundant_stage" -eq 1 ]; then
  rm -rf "$pocketjs_stage"
fi
if [ "$(sed -n '1p' current/.complete 2>/dev/null || true)" = "$pocketjs_hash" ]; then
  printf '%s\\n' "$pocketjs_hash"
  exit 0
fi
pocketjs_next=".current-${nonce}"
pocketjs_previous_next=".previous-${nonce}"
rm -rf "$pocketjs_next" "$pocketjs_previous_next"
mkdir "$pocketjs_next"
# /mnt/us is normally FAT and cannot create symlinks. Publish a verified
# current directory by rename instead; the running guest does not read it
# until the explicit SIGHUP after deploy completes.
cp "$pocketjs_release"/.complete "$pocketjs_release"/* "$pocketjs_next"/
chmod 0755 "$pocketjs_next/pocketjs-kindle"
cd "$pocketjs_next"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  busybox sha256sum -c SHA256SUMS
fi
cd "$pocketjs_root"
if [ -L current ]; then
  echo 'PocketJS Kindle: refusing unexpected current symlink on FAT userstore' >&2
  exit 1
elif [ -d current ]; then
  mv current "$pocketjs_previous_next"
elif [ -e current ]; then
  echo 'PocketJS Kindle: refusing non-directory current path' >&2
  exit 1
fi
if [ -e current ] || [ -L current ]; then
  echo 'PocketJS Kindle: current reappeared during locked publish; refusing nested rename' >&2
  exit 1
fi
if ! mv "$pocketjs_next" current; then
  if [ -d "$pocketjs_previous_next" ] && [ ! -e current ]; then
    mv "$pocketjs_previous_next" current || true
  fi
  exit 1
fi
if [ "$(sed -n '1p' current/.complete 2>/dev/null || true)" != "$pocketjs_hash" ]; then
  echo 'PocketJS Kindle: published current failed release hash read-back' >&2
  exit 1
fi
if [ -d "$pocketjs_previous_next" ]; then
  rm -rf previous
  mv "$pocketjs_previous_next" previous
fi
printf '%s\\n' "$pocketjs_hash"`;

  return {
    releasePath,
    stagingPath,
    prepare: sshCommandArgs(connection, prepareScript),
    tar: ["tar", "-cf", "-", "-C", release.directory, "."],
    extract: sshCommandArgs(connection, extractScript),
    // Dropbear builds on Kindle may reject a large SSH exec request. Keep the
    // remote command tiny and stream the verified publish program over stdin.
    publish: [...sshBaseArgs(connection), "sh -s"],
    publishScript,
  };
}

function runtimeIdentityCheck(root: string): string {
  const qRoot = shellQuote(root);
  return `pocketjs_runtime_identity_check() {
  pocketjs_pid=$(sed -n '1p' ${qRoot}/run/runtime.pid 2>/dev/null || true)
  case "$pocketjs_pid" in
    ''|*[!0-9]*) return 1 ;;
  esac
  pocketjs_expected_pid=$(sed -n 's/^pid=//p' ${qRoot}/run/runtime.identity 2>/dev/null || true)
  pocketjs_expected_start=$(sed -n 's/^starttime=//p' ${qRoot}/run/runtime.identity 2>/dev/null || true)
  pocketjs_actual_start=$(awk '{ print $22 }' "/proc/$pocketjs_pid/stat" 2>/dev/null || true)
  pocketjs_actual_state=$(awk '{ print $3 }' "/proc/$pocketjs_pid/stat" 2>/dev/null || true)
  [ "$pocketjs_expected_pid" = "$pocketjs_pid" ] &&
    [ -n "$pocketjs_expected_start" ] &&
    [ "$pocketjs_expected_start" = "$pocketjs_actual_start" ] &&
    [ -n "$pocketjs_actual_state" ] &&
    [ "$pocketjs_actual_state" != Z ]
}`;
}

function runtimeLaunchStateHelpers(root: string): string {
  const state = `${root}/run/runtime.launch`;
  return `pocketjs_sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v busybox >/dev/null 2>&1; then
    busybox sha256sum "$1" | awk '{ print $1 }'
  else
    echo 'PocketJS Kindle: sha256sum is unavailable on device' >&2
    return 1
  fi
}
pocketjs_sha256_stream() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{ print $1 }'
  elif command -v busybox >/dev/null 2>&1; then
    busybox sha256sum | awk '{ print $1 }'
  else
    echo 'PocketJS Kindle: sha256sum is unavailable on device' >&2
    return 1
  fi
}
pocketjs_launch_state_valid() {
  pocketjs_launch_fingerprint=$(sed -n 's/^fingerprint=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_pid=$(sed -n 's/^pid=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_start=$(sed -n 's/^starttime=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_native_path=$(sed -n 's/^native_path=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_native_hash=$(sed -n 's/^native_sha256=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_js_path=$(sed -n 's/^js_path=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_js_hash=$(sed -n 's/^js_sha256=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_pak_path=$(sed -n 's/^pak_path=//p' ${shellQuote(state)} 2>/dev/null || true)
  pocketjs_launch_pak_hash=$(sed -n 's/^pak_sha256=//p' ${shellQuote(state)} 2>/dev/null || true)
  [ "\${#pocketjs_launch_fingerprint}" -eq 64 ] 2>/dev/null || return 1
  case "$pocketjs_launch_fingerprint" in *[!0-9a-f]*) return 1 ;; esac
  for pocketjs_launch_hash in \
    "$pocketjs_launch_native_hash" \
    "$pocketjs_launch_js_hash" \
    "$pocketjs_launch_pak_hash"; do
    [ "\${#pocketjs_launch_hash}" -eq 64 ] 2>/dev/null || return 1
    case "$pocketjs_launch_hash" in *[!0-9a-f]*) return 1 ;; esac
  done
  [ "$pocketjs_launch_pid" = "$pocketjs_pid" ] || return 1
  [ "$pocketjs_launch_start" = "$pocketjs_expected_start" ] || return 1
  pocketjs_launch_actual_fingerprint=$(sed -n '4,$p' ${shellQuote(state)} 2>/dev/null | pocketjs_sha256_stream) || return 1
  [ "$pocketjs_launch_actual_fingerprint" = "$pocketjs_launch_fingerprint" ] || return 1
  pocketjs_active_native_hash=$(pocketjs_sha256_file "/proc/$pocketjs_pid/exe" 2>/dev/null || true)
  [ "$pocketjs_active_native_hash" = "$pocketjs_launch_native_hash" ] || return 1
  pocketjs_current_native_hash=$(pocketjs_sha256_file "$pocketjs_launch_native_path" 2>/dev/null || true)
  pocketjs_current_js_hash=$(pocketjs_sha256_file "$pocketjs_launch_js_path" 2>/dev/null || true)
  pocketjs_current_pak_hash=$(pocketjs_sha256_file "$pocketjs_launch_pak_path" 2>/dev/null || true)
  [ "$pocketjs_current_native_hash" = "$pocketjs_launch_native_hash" ] &&
    [ "$pocketjs_current_js_hash" = "$pocketjs_launch_js_hash" ] &&
    [ "$pocketjs_current_pak_hash" = "$pocketjs_launch_pak_hash" ]
}`;
}

export function reloadRemoteScript(root: string): string {
  const safeRoot = validateRemoteRoot(root);
  return `set -eu
${runtimeIdentityCheck(safeRoot)}
${runtimeLaunchStateHelpers(safeRoot)}
if ! pocketjs_runtime_identity_check; then
  echo 'PocketJS Kindle: runtime PID identity mismatch; refusing to signal' >&2
  exit 1
fi
if ! pocketjs_launch_state_valid; then
  echo 'PocketJS Kindle: runtime launch state is missing or invalid; refusing to signal' >&2
  exit 1
fi
if ! pocketjs_runtime_identity_check; then
  echo 'PocketJS Kindle: runtime PID identity changed before reload; refusing to signal' >&2
  exit 1
fi
kill -HUP "$pocketjs_pid"
printf 'reloaded pid %s\\n' "$pocketjs_pid"`;
}

export function runRemoteScript(
  root: string,
  appOutput: string,
  options: Pick<
    KindleCliOptions,
    "restart" | "presentHz" | "motionWaveform" | "ghostBudget" | "rotation"
  >,
): string {
  const safeRoot = validateRemoteRoot(root);
  const safeOutput = validateAppOutput(appOutput);
  const current = `${safeRoot}/current`;
  const runScript = `${safeRoot}/run-runtime.sh`;
  const stopScript = `${safeRoot}/stop-runtime.sh`;
  const host = `${current}/pocketjs-kindle`;
  const js = `${current}/${safeOutput}.js`;
  const pak = `${current}/${safeOutput}.pak`;
  const fbink = `${safeRoot}/bin/fbink`;
  const runtimeArgs = [
    "--js",
    js,
    "--pak",
    pak,
    "--fbink",
    fbink,
    ...(options.presentHz ? ["--present-hz", String(options.presentHz)] : []),
    ...(options.motionWaveform
      ? ["--motion-waveform", options.motionWaveform]
      : []),
    ...(options.ghostBudget
      ? ["--ghost-budget", String(options.ghostBudget)]
      : []),
    "--rotation",
    options.rotation,
  ];
  const extraArgs = runtimeArgs.map(shellQuote).join(" ");
  const launchArgumentLines = runtimeArgs
    .map((argument, index) =>
      `  printf '%s\\n' ${shellQuote(`argument_${index}=${argument}`)}`)
    .join("\n");
  const presentHz = options.presentHz ? String(options.presentHz) : "default";
  const motionWaveform = options.motionWaveform ?? "default";
  const ghostBudget = options.ghostBudget
    ? String(options.ghostBudget)
    : "default";
  return `set -eu
pocketjs_root=${shellQuote(safeRoot)}
pocketjs_host=${shellQuote(host)}
pocketjs_js=${shellQuote(js)}
pocketjs_pak=${shellQuote(pak)}
pocketjs_debug_dir="$pocketjs_root/runtime"
pocketjs_launch_state="$pocketjs_root/run/runtime.launch"
pocketjs_launch_candidate="$pocketjs_root/run/.runtime.launch-config.$$"
pocketjs_launch_next="$pocketjs_root/run/.runtime.launch.$$"
pocketjs_restart=${options.restart ? "1" : "0"}
trap 'rm -f "$pocketjs_launch_candidate" "$pocketjs_launch_next"' EXIT
test -x ${shellQuote(runScript)}
test -x ${shellQuote(stopScript)}
test -x "$pocketjs_host"
test -r "$pocketjs_js"
test -r "$pocketjs_pak"
${runtimeIdentityCheck(safeRoot)}
${runtimeLaunchStateHelpers(safeRoot)}
pocketjs_native_hash=$(pocketjs_sha256_file "$pocketjs_host")
pocketjs_js_hash=$(pocketjs_sha256_file "$pocketjs_js")
pocketjs_pak_hash=$(pocketjs_sha256_file "$pocketjs_pak")
{
  printf '%s\\n' 'version=1'
  printf '%s\\n' ${shellQuote(`app_output=${safeOutput}`)}
  printf 'native_path=%s\\n' "$pocketjs_host"
  printf 'native_sha256=%s\\n' "$pocketjs_native_hash"
  printf 'js_path=%s\\n' "$pocketjs_js"
  printf 'js_sha256=%s\\n' "$pocketjs_js_hash"
  printf 'pak_path=%s\\n' "$pocketjs_pak"
  printf 'pak_sha256=%s\\n' "$pocketjs_pak_hash"
  printf 'debug_dir=%s\\n' "$pocketjs_debug_dir"
  printf '%s\\n' ${shellQuote(`present_hz=${presentHz}`)}
  printf '%s\\n' ${shellQuote(`motion_waveform=${motionWaveform}`)}
  printf '%s\\n' ${shellQuote(`ghost_budget=${ghostBudget}`)}
  printf '%s\\n' ${shellQuote(`rotation=${options.rotation}`)}
  printf '%s\\n' ${shellQuote(`argument_count=${runtimeArgs.length}`)}
${launchArgumentLines}
} >"$pocketjs_launch_candidate"
pocketjs_desired_fingerprint=$(pocketjs_sha256_file "$pocketjs_launch_candidate")
pocketjs_recorded_pid=$(sed -n '1p' "$pocketjs_root/run/runtime.pid" 2>/dev/null || true)
pocketjs_running=0
case "$pocketjs_recorded_pid" in
  ''|*[!0-9]*) ;;
  *)
    if [ -r "/proc/$pocketjs_recorded_pid/stat" ]; then
      if ! pocketjs_runtime_identity_check; then
        echo 'PocketJS Kindle: runtime PID identity mismatch; refusing to replace a reused PID' >&2
        exit 1
      fi
      pocketjs_running=1
    fi
    ;;
esac
if [ "$pocketjs_running" = 1 ]; then
  if pocketjs_launch_state_valid &&
    [ "$pocketjs_launch_fingerprint" = "$pocketjs_desired_fingerprint" ]; then
    printf 'RUNNING %s\\n' "$pocketjs_pid"
    exit 0
  fi
  if [ "$pocketjs_restart" != 1 ]; then
    echo 'PocketJS Kindle: runtime launch config changed; rerun with --restart (dev does this automatically)' >&2
    exit 1
  fi
  if ! pocketjs_runtime_identity_check; then
    echo 'PocketJS Kindle: runtime PID identity changed before restart; refusing to signal' >&2
    exit 1
  fi
  ${shellQuote(stopScript)} >&2
fi
POCKETJS_RUNTIME_BIN="$pocketjs_host" POCKETJS_DBG_DIR="$pocketjs_debug_dir" nohup ${shellQuote(runScript)} ${extraArgs} >/dev/null 2>&1 </dev/null &
pocketjs_expected_launcher_pid=$!
pocketjs_wait=0
while [ "$pocketjs_wait" -lt 15 ]; do
  pocketjs_launcher_pid=$(sed -n '1p' "$pocketjs_root/run/runtime-launcher.pid" 2>/dev/null || true)
  if [ "$pocketjs_launcher_pid" = "$pocketjs_expected_launcher_pid" ] &&
    pocketjs_runtime_identity_check 2>/dev/null; then
    pocketjs_active_native_hash=$(pocketjs_sha256_file "/proc/$pocketjs_pid/exe" 2>/dev/null || true)
    if [ "$pocketjs_active_native_hash" = "$pocketjs_native_hash" ]; then
      {
        printf 'fingerprint=%s\\n' "$pocketjs_desired_fingerprint"
        printf 'pid=%s\\n' "$pocketjs_pid"
        printf 'starttime=%s\\n' "$pocketjs_expected_start"
        cat "$pocketjs_launch_candidate"
      } >"$pocketjs_launch_next"
      mv -f "$pocketjs_launch_next" "$pocketjs_launch_state"
      printf 'STARTED %s\\n' "$pocketjs_pid"
      exit 0
    fi
  fi
  sleep 1
  pocketjs_wait=$((pocketjs_wait + 1))
done
echo "PocketJS Kindle: runtime did not start; inspect $pocketjs_root/logs/runtime.log" >&2
exit 1`;
}

export function logsRemoteScript(root: string): string {
  const safeRoot = validateRemoteRoot(root);
  return `set -eu
test -f ${shellQuote(safeRoot)}/logs/runtime.log || : >${shellQuote(safeRoot)}/logs/runtime.log
exec tail -n 200 -F ${shellQuote(safeRoot)}/logs/runtime.log`;
}

export function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}
