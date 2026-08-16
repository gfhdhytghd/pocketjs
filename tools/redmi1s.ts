import { createHash } from "node:crypto";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractHostBuildInputs } from "../framework/src/manifest/host-build-inputs.ts";
import { bakeRedmi1SArtwork } from "./redmi1s-icon.ts";
import {
  REDMI1S_DEV_TARGET_ID,
  resolveRedmi1SBuildPlan,
} from "./redmi1s-profile.ts";
import toolchainJson from "./cli/redmi1s-toolchain.json";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_NAME = "dev.pocket_stack.redmi1s_demo";
const COMPONENT = `${PACKAGE_NAME}/android.app.NativeActivity`;
const APK_NAME = "PocketJS-Redmi1S.apk";
const BUILD_ID_PLACEHOLDER = "00000000000000000000000000000000";

interface ToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly device: {
    readonly model: string;
    readonly codename: string;
    readonly boardPlatform: string;
    readonly androidRelease: string;
    readonly sdk: string;
    readonly abi: string;
    readonly physicalViewport: readonly [number, number];
    readonly density: number;
    readonly gpuRenderer: string;
    readonly requiredGlEsVersion: string;
  };
  readonly compiler: {
    readonly androidSdkRoot: string;
    readonly compileSdk: string;
    readonly buildToolsVersion: string;
    readonly ndkVersion: string;
    readonly minimumSdk: string;
    readonly rustToolchain: string;
    readonly rustTarget: string;
    readonly quickJsRepository: string;
    readonly quickJsRevision: string;
    readonly quickJsVersion: string;
  };
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface BuildReceipt {
  readonly schema: 1;
  readonly buildId: string;
  readonly packageName: string;
  readonly target: string;
  readonly hostAbi: number;
  readonly minimumSdk: string;
  readonly abi: "armeabi-v7a";
  readonly files: Readonly<Record<string, string>>;
}

type DeviceStatus = Readonly<Record<string, string>>;

const TOOLCHAIN = toolchainJson as ToolchainManifest;

function run(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): CommandResult {
  const result = Bun.spawnSync({
    cmd: [executable, ...args],
    cwd: options.cwd ?? REPOSITORY,
    env: options.env ?? process.env,
    stdin: options.input,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function mustRun(
  executable: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: Uint8Array } = {},
): string {
  const result = run(executable, args, options);
  if (result.exitCode !== 0) {
    const detail = [result.stdout.trim(), result.stderr.trim()]
      .filter(Boolean)
      .join("\n");
    throw new Error(
      `pocket redmi1s: ${executable} ${args.join(" ")} failed (${result.exitCode})${
        detail ? `:\n${detail}` : ""
      }`,
    );
  }
  return result.stdout.trim();
}

function commandPath(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hashInputs(
  inputs: readonly { label: string; path: string }[],
): string {
  const hash = createHash("sha256");
  for (const input of inputs) {
    const bytes = readFileSync(input.path);
    hash.update(
      `${Buffer.byteLength(input.label)}:${input.label}${bytes.byteLength}:`,
    );
    hash.update(bytes);
  }
  return hash.digest("hex").slice(0, 32);
}

function cacheRoot(): string {
  const base = process.env.POCKET_STACK_CACHE_DIR?.trim()
    ? resolve(process.env.POCKET_STACK_CACHE_DIR.trim())
    : join(homedir(), ".cache/pocket-stack");
  return join(base, "redmi1s");
}

function sdkRoot(): string {
  const configured =
    process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  return resolve(configured || TOOLCHAIN.compiler.androidSdkRoot);
}

function ndkRoot(): string {
  return join(sdkRoot(), "ndk", TOOLCHAIN.compiler.ndkVersion);
}

function buildToolsRoot(): string {
  return join(sdkRoot(), "build-tools", TOOLCHAIN.compiler.buildToolsVersion);
}

function sdkManagerPath(): string {
  return join(sdkRoot(), "cmdline-tools/latest/bin/sdkmanager");
}

function androidJar(): string {
  return join(
    sdkRoot(),
    "platforms",
    `android-${TOOLCHAIN.compiler.compileSdk}`,
    "android.jar",
  );
}

function ndkToolchain(): string {
  return join(ndkRoot(), "toolchains/llvm/prebuilt/darwin-x86_64");
}

function clangPath(): string {
  return join(
    ndkToolchain(),
    "bin",
    `armv7a-linux-androideabi${TOOLCHAIN.compiler.minimumSdk}-clang`,
  );
}

function quickJsRoot(): string {
  return join(
    cacheRoot(),
    "sources",
    `quickjs-rs-${TOOLCHAIN.compiler.quickJsRevision}`,
  );
}

function quickJsSource(): string {
  return join(quickJsRoot(), "libquickjs-sys/embed/quickjs");
}

function manifestPath(): string {
  return join(REPOSITORY, "apps/redmi1s-demo/pocket.json");
}

function planPath(): string {
  return join(REPOSITORY, ".pocket/redmi1s/redmi1s-demo.plan.json");
}

function guestDirectory(): string {
  return join(REPOSITORY, "dist/redmi1s/guest");
}

function outputDirectory(): string {
  return join(REPOSITORY, "dist/redmi1s");
}

function apkPath(): string {
  return join(outputDirectory(), APK_NAME);
}

function receiptPath(): string {
  return join(outputDirectory(), "build-receipt.json");
}

function nativeBuildDirectory(): string {
  return join(REPOSITORY, ".pocket-build/redmi1s/runtime");
}

function rustTargetDirectory(): string {
  return join(REPOSITORY, ".pocket-build/redmi1s/rust-target");
}

function readReceipt(): BuildReceipt {
  if (!existsSync(receiptPath())) {
    throw new Error("pocket redmi1s: no built APK; run `bun redmi1s build`");
  }
  return JSON.parse(readFileSync(receiptPath(), "utf8")) as BuildReceipt;
}

function quickJsReady(): boolean {
  const root = quickJsRoot();
  const version = join(quickJsSource(), "VERSION");
  if (!existsSync(join(root, ".git/HEAD")) || !existsSync(version))
    return false;
  const revision = run("git", ["-C", root, "rev-parse", "HEAD"]);
  const tracked = run("git", [
    "-C",
    root,
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  return (
    revision.exitCode === 0 &&
    revision.stdout.trim() === TOOLCHAIN.compiler.quickJsRevision &&
    tracked.exitCode === 0 &&
    tracked.stdout.trim() === "" &&
    readFileSync(version, "utf8").trim() === TOOLCHAIN.compiler.quickJsVersion
  );
}

function setupQuickJs(): void {
  if (quickJsReady()) return;
  const root = quickJsRoot();
  const staging = `${root}.staging`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  mustRun("git", [
    "clone",
    "--no-checkout",
    TOOLCHAIN.compiler.quickJsRepository,
    staging,
  ]);
  mustRun("git", [
    "-C",
    staging,
    "checkout",
    "--detach",
    TOOLCHAIN.compiler.quickJsRevision,
  ]);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  renameSync(staging, root);
  if (!quickJsReady())
    throw new Error(
      "pocket redmi1s: checked-out QuickJS source failed verification",
    );
}

function setupRustTarget(): void {
  const installed = mustRun("rustup", [
    "target",
    "list",
    "--installed",
    "--toolchain",
    TOOLCHAIN.compiler.rustToolchain,
  ]);
  if (!installed.split("\n").includes(TOOLCHAIN.compiler.rustTarget)) {
    mustRun("rustup", [
      "target",
      "add",
      "--toolchain",
      TOOLCHAIN.compiler.rustToolchain,
      TOOLCHAIN.compiler.rustTarget,
    ]);
  }
}

function setupNdk(): void {
  if (existsSync(clangPath())) return;
  const sdkManager = sdkManagerPath();
  if (!existsSync(sdkManager)) {
    throw new Error(
      `pocket redmi1s: sdkmanager is unavailable at ${sdkManager}`,
    );
  }
  mustRun(sdkManager, ["--install", `ndk;${TOOLCHAIN.compiler.ndkVersion}`]);
  if (!existsSync(clangPath())) {
    throw new Error(
      `pocket redmi1s: NDK ${TOOLCHAIN.compiler.ndkVersion} has no API ${TOOLCHAIN.compiler.minimumSdk} ARMv7 clang wrapper`,
    );
  }
}

function signingKeyPath(): string {
  return join(cacheRoot(), "signing/pocketjs-redmi1s-debug.keystore");
}

function ensureSigningKey(): string {
  const path = signingKeyPath();
  if (existsSync(path)) return path;
  const keytool = join(process.env.JAVA_HOME || "", "bin/keytool");
  const executable = existsSync(keytool) ? keytool : commandPath("keytool");
  if (!executable) throw new Error("pocket redmi1s: keytool is unavailable");
  mkdirSync(dirname(path), { recursive: true });
  mustRun(executable, [
    "-genkeypair",
    "-keystore",
    path,
    "-storepass",
    "android",
    "-keypass",
    "android",
    "-alias",
    "pocketjs",
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10000",
    "-dname",
    "CN=PocketJS Redmi 1S,O=PocketJS,C=US",
  ]);
  return path;
}

function connectedSerial(): string {
  const requested = process.env.POCKETJS_REDMI1S_SERIAL?.trim();
  const devices = mustRun("adb", ["devices"])
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2 && parts[1] === "device")
    .map((parts) => parts[0]);
  if (requested) {
    if (!devices.includes(requested)) {
      throw new Error(
        `pocket redmi1s: requested device ${requested} is not connected and authorized`,
      );
    }
    return requested;
  }
  if (devices.length !== 1) {
    throw new Error(
      `pocket redmi1s: expected exactly one authorized ADB device, found ${devices.length}; ` +
        "set POCKETJS_REDMI1S_SERIAL",
    );
  }
  return devices[0];
}

function adb(serial: string, args: readonly string[]): string {
  return mustRun("adb", ["-s", serial, ...args]);
}

function deviceProperty(serial: string, key: string): string {
  return adb(serial, ["shell", "getprop", key]).replace(/\r/g, "").trim();
}

function verifyDeviceIdentity(): string {
  const serial = connectedSerial();
  const observed = {
    model: deviceProperty(serial, "ro.product.model"),
    codename: deviceProperty(serial, "ro.product.device"),
    boardPlatform: deviceProperty(serial, "ro.board.platform"),
    androidRelease: deviceProperty(serial, "ro.build.version.release"),
    sdk: deviceProperty(serial, "ro.build.version.sdk"),
    abi: deviceProperty(serial, "ro.product.cpu.abi"),
  };
  for (const [key, expected] of Object.entries({
    model: TOOLCHAIN.device.model,
    codename: TOOLCHAIN.device.codename,
    boardPlatform: TOOLCHAIN.device.boardPlatform,
    androidRelease: TOOLCHAIN.device.androidRelease,
    sdk: TOOLCHAIN.device.sdk,
    abi: TOOLCHAIN.device.abi,
  })) {
    if (observed[key as keyof typeof observed] !== expected) {
      throw new Error(
        `pocket redmi1s: refusing ${serial}; ${key}=${observed[key as keyof typeof observed]}, expected ${expected}`,
      );
    }
  }
  const display = adb(serial, ["shell", "wm", "size"]).replace(/\r/g, "");
  const density = adb(serial, ["shell", "wm", "density"]).replace(/\r/g, "");
  const expectedViewport = TOOLCHAIN.device.physicalViewport.join("x");
  if (
    !display.includes(`Physical size: ${expectedViewport}`) ||
    !density.includes(`Physical density: ${TOOLCHAIN.device.density}`)
  ) {
    throw new Error(
      `pocket redmi1s: refusing display ${display.trim()} / ${density.trim()}; ` +
        `expected ${expectedViewport} @${TOOLCHAIN.device.density}`,
    );
  }
  return serial;
}

function check(label: string, ok: boolean, detail: string): boolean {
  console.log(`[${ok ? "ok" : "missing"}] ${label}: ${detail}`);
  return ok;
}

async function doctor(): Promise<void> {
  const rustTargets = commandPath("rustup")
    ? run("rustup", [
        "target",
        "list",
        "--installed",
        "--toolchain",
        TOOLCHAIN.compiler.rustToolchain,
      ]).stdout
    : "";
  const tools = [
    [
      "ADB",
      Boolean(commandPath("adb")),
      commandPath("adb") || "install platform-tools",
    ],
    ["NDK clang", existsSync(clangPath()), clangPath()],
    ["android.jar", existsSync(androidJar()), androidJar()],
    [
      "aapt",
      existsSync(join(buildToolsRoot(), "aapt")),
      join(buildToolsRoot(), "aapt"),
    ],
    [
      "zipalign",
      existsSync(join(buildToolsRoot(), "zipalign")),
      join(buildToolsRoot(), "zipalign"),
    ],
    [
      "apksigner",
      existsSync(join(buildToolsRoot(), "apksigner")),
      join(buildToolsRoot(), "apksigner"),
    ],
    [
      "Rust target",
      rustTargets.split("\n").includes(TOOLCHAIN.compiler.rustTarget),
      TOOLCHAIN.compiler.rustTarget,
    ],
    ["QuickJS", quickJsReady(), quickJsRoot()],
  ] as const;
  let ready = true;
  for (const [label, ok, detail] of tools)
    ready = check(label, ok, detail) && ready;
  try {
    const serial = verifyDeviceIdentity();
    check(
      "Redmi 1S",
      true,
      `${serial} ${TOOLCHAIN.device.codename} Android ${TOOLCHAIN.device.androidRelease}`,
    );
  } catch (error) {
    ready = false;
    check(
      "Redmi 1S",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!ready)
    throw new Error(
      "pocket redmi1s: doctor found missing requirements; run `bun redmi1s setup`",
    );
}

async function setup(): Promise<void> {
  setupNdk();
  setupRustTarget();
  setupQuickJs();
  ensureSigningKey();
  console.log(`prepared ${TOOLCHAIN.toolchainVersion}`);
}

async function build(): Promise<void> {
  setupRustTarget();
  setupQuickJs();
  const manifest = JSON.parse(readFileSync(manifestPath(), "utf8"));
  const plan = resolveRedmi1SBuildPlan(manifest);
  mkdirSync(dirname(planPath()), { recursive: true });
  writeFileSync(planPath(), JSON.stringify(plan, null, 2) + "\n");
  const inputs = extractHostBuildInputs(plan, {
    expectedTarget: REDMI1S_DEV_TARGET_ID,
  });

  rmSync(guestDirectory(), { recursive: true, force: true });
  mkdirSync(guestDirectory(), { recursive: true });
  mustRun("bun", [
    "tools/build.ts",
    `--plan=${planPath()}`,
    `--project-root=${REPOSITORY}`,
    `--outdir=${guestDirectory()}`,
  ]);
  const guestJavaScript = join(guestDirectory(), `${inputs.appOutput}.js`);
  const guestPak = join(guestDirectory(), `${inputs.appOutput}.pak`);
  if (!existsSync(guestJavaScript) || !existsSync(guestPak)) {
    throw new Error(
      "pocket redmi1s: guest build did not produce JS and pak artifacts",
    );
  }

  const nativeBuild = nativeBuildDirectory();
  const staging = join(nativeBuild, "apk");
  const resources = join(staging, "res");
  const assets = join(staging, "assets");
  const libraries = join(staging, "lib/armeabi-v7a");
  rmSync(nativeBuild, { recursive: true, force: true });
  mkdirSync(resources, { recursive: true });
  mkdirSync(assets, { recursive: true });
  mkdirSync(libraries, { recursive: true });
  cpSync(guestJavaScript, join(assets, "app.js"));
  cpSync(guestPak, join(assets, "app.pak"));
  const icons = await bakeRedmi1SArtwork(resources);

  const clang = clangPath();
  const quickjs = quickJsSource();
  const glueDirectory = join(ndkRoot(), "sources/android/native_app_glue");
  const rustTarget = rustTargetDirectory();
  mkdirSync(rustTarget, { recursive: true });
  mustRun(
    "rustup",
    [
      "run",
      TOOLCHAIN.compiler.rustToolchain,
      "cargo",
      "build",
      "--release",
      "--locked",
      "--features",
      "bare-platform",
      "--target",
      TOOLCHAIN.compiler.rustTarget,
    ],
    {
      cwd: join(REPOSITORY, "engine/symbian"),
      env: {
        ...process.env,
        CARGO_TARGET_DIR: rustTarget,
        CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER: clang,
      },
    },
  );
  const coreLibrary = join(
    rustTarget,
    TOOLCHAIN.compiler.rustTarget,
    "release/libpocketjs_symbian_core.a",
  );
  if (!existsSync(coreLibrary)) {
    throw new Error(
      `pocket redmi1s: missing Rust static library ${coreLibrary}`,
    );
  }

  const buildId = hashInputs([
    { label: "plan", path: planPath() },
    { label: "guest/app.js", path: guestJavaScript },
    { label: "guest/app.pak", path: guestPak },
    {
      label: "host/manifest",
      path: join(REPOSITORY, "hosts/android-redmi1s/AndroidManifest.xml"),
    },
    {
      label: "host/runtime",
      path: join(REPOSITORY, "hosts/android-redmi1s/runtime.c"),
    },
    {
      label: "host/rust-abort",
      path: join(REPOSITORY, "hosts/android-redmi1s/rust_abort.c"),
    },
    {
      label: "host/pocket-runtime",
      path: join(REPOSITORY, "hosts/iphone2g/pocket_runtime.c"),
    },
    {
      label: "host/pocket-runtime-header",
      path: join(REPOSITORY, "hosts/iphone2g/pocket_runtime.h"),
    },
    {
      label: "host/pocket-core-header",
      path: join(REPOSITORY, "hosts/iphone2g/pocket_core.h"),
    },
    { label: "tool", path: join(REPOSITORY, "tools/redmi1s.ts") },
    { label: "profile", path: join(REPOSITORY, "tools/redmi1s-profile.ts") },
    {
      label: "toolchain",
      path: join(REPOSITORY, "tools/cli/redmi1s-toolchain.json"),
    },
    { label: "icon-source", path: join(REPOSITORY, "hosts/iphone4s/Icon.svg") },
    { label: "core", path: coreLibrary },
  ]);

  const common = [
    "-std=c11",
    "-O2",
    "-fPIC",
    "-fno-strict-aliasing",
    "-fwrapv",
    "-DANDROID",
    "-D_GNU_SOURCE",
    "-I",
    join(REPOSITORY, "hosts/iphone2g"),
    "-isystem",
    quickjs,
    "-I",
    glueDirectory,
  ];
  const firstPartyWarnings = ["-Wall", "-Wextra", "-Werror"];
  const compile = (
    source: string,
    output: string,
    extra: readonly string[] = [],
  ) => mustRun(clang, [...common, ...extra, "-c", source, "-o", output]);

  const runtimeObject = join(nativeBuild, "runtime.o");
  compile(join(REPOSITORY, "hosts/android-redmi1s/runtime.c"), runtimeObject, [
    ...firstPartyWarnings,
    `-DPOCKET_BUILD_ID=\"${buildId}\"`,
    `-DPOCKET_LOGICAL_WIDTH=${inputs.viewport.logical[0]}`,
    `-DPOCKET_LOGICAL_HEIGHT=${inputs.viewport.logical[1]}`,
    `-DPOCKET_PHYSICAL_WIDTH=${inputs.viewport.physical[0]}`,
    `-DPOCKET_PHYSICAL_HEIGHT=${inputs.viewport.physical[1]}`,
  ]);
  const guestRuntimeObject = join(nativeBuild, "pocket_runtime.o");
  compile(
    join(REPOSITORY, "hosts/iphone2g/pocket_runtime.c"),
    guestRuntimeObject,
    [
      ...firstPartyWarnings,
      `-DPOCKETJS_TARGET_ID=\"${inputs.target}\"`,
      `-DPOCKETJS_HOST_ABI=${inputs.hostAbi}`,
      `-DPOCKET_RASTER_DENSITY=${inputs.viewport.rasterDensity}`,
    ],
  );
  const rustAbortObject = join(nativeBuild, "rust_abort.o");
  compile(
    join(REPOSITORY, "hosts/android-redmi1s/rust_abort.c"),
    rustAbortObject,
    firstPartyWarnings,
  );
  const glueObject = join(nativeBuild, "android_native_app_glue.o");
  compile(join(glueDirectory, "android_native_app_glue.c"), glueObject);

  const quickJsObjects: string[] = [];
  for (const source of [
    "quickjs.c",
    "cutils.c",
    "dtoa.c",
    "libregexp.c",
    "libunicode.c",
  ]) {
    const output = join(nativeBuild, `quickjs-${source.replace(/\.c$/, "")}.o`);
    compile(join(quickjs, source), output, [
      `-DCONFIG_VERSION=\"${TOOLCHAIN.compiler.quickJsVersion}\"`,
      "-Wno-implicit-const-int-float-conversion",
    ]);
    quickJsObjects.push(output);
  }

  const sharedLibrary = join(libraries, "libpocketjs.so");
  mustRun(clang, [
    "-shared",
    "-Wl,--no-undefined",
    "-Wl,-soname,libpocketjs.so",
    "-Wl,-z,max-page-size=4096",
    "-Wl,--build-id=sha1",
    "-o",
    sharedLibrary,
    runtimeObject,
    guestRuntimeObject,
    rustAbortObject,
    glueObject,
    ...quickJsObjects,
    "-Wl,--whole-archive",
    coreLibrary,
    "-Wl,--no-whole-archive",
    "-landroid",
    "-llog",
    "-lEGL",
    "-lGLESv2",
    "-ldl",
    "-lm",
  ]);

  mkdirSync(outputDirectory(), { recursive: true });
  const unsignedApk = join(nativeBuild, "unsigned.apk");
  const alignedApk = join(nativeBuild, "aligned.apk");
  const aapt = join(buildToolsRoot(), "aapt");
  const zipalign = join(buildToolsRoot(), "zipalign");
  const apksigner = join(buildToolsRoot(), "apksigner");
  mustRun(aapt, [
    "package",
    "-f",
    "-M",
    join(REPOSITORY, "hosts/android-redmi1s/AndroidManifest.xml"),
    "-S",
    resources,
    "-A",
    assets,
    "-I",
    androidJar(),
    "-F",
    unsignedApk,
  ]);
  mustRun("zip", ["-q", "-r", unsignedApk, "lib"], { cwd: staging });
  mustRun(zipalign, ["-f", "4", unsignedApk, alignedApk]);
  cpSync(alignedApk, apkPath());
  mustRun(apksigner, [
    "sign",
    "--ks",
    ensureSigningKey(),
    "--ks-pass",
    "pass:android",
    "--key-pass",
    "pass:android",
    "--ks-key-alias",
    "pocketjs",
    "--min-sdk-version",
    TOOLCHAIN.compiler.minimumSdk,
    apkPath(),
  ]);
  mustRun(apksigner, ["verify", "--verbose", "--print-certs", apkPath()]);
  const badging = mustRun(aapt, ["dump", "badging", apkPath()]);
  for (const marker of [
    `package: name='${PACKAGE_NAME}'`,
    `sdkVersion:'${TOOLCHAIN.compiler.minimumSdk}'`,
    "native-code: 'armeabi-v7a'",
    "uses-gl-es: '0x20000'",
  ]) {
    if (!badging.includes(marker))
      throw new Error(`pocket redmi1s: APK is missing ${marker}`);
  }
  const sharedLibraryInfo = mustRun("file", [sharedLibrary]);
  if (
    !sharedLibraryInfo.includes("ELF 32-bit") ||
    !sharedLibraryInfo.includes("ARM")
  ) {
    throw new Error(
      `pocket redmi1s: unexpected native library: ${sharedLibraryInfo}`,
    );
  }
  chmodSync(apkPath(), 0o644);

  const files: Record<string, string> = {
    [APK_NAME]: sha256(apkPath()),
    "lib/armeabi-v7a/libpocketjs.so": sha256(sharedLibrary),
  };
  for (const icon of icons)
    files[`res/${icon.slice(resources.length + 1)}`] = sha256(icon);
  const receipt: BuildReceipt = {
    schema: 1,
    buildId,
    packageName: PACKAGE_NAME,
    target: inputs.target,
    hostAbi: inputs.hostAbi,
    minimumSdk: TOOLCHAIN.compiler.minimumSdk,
    abi: "armeabi-v7a",
    files,
  };
  writeFileSync(receiptPath(), JSON.stringify(receipt, null, 2) + "\n");
  console.log(`built ${apkPath()} (${buildId})`);
}

async function deploy(): Promise<void> {
  const serial = verifyDeviceIdentity();
  const receipt = readReceipt();
  if (sha256(apkPath()) !== receipt.files[APK_NAME]) {
    throw new Error("pocket redmi1s: APK no longer matches its build receipt");
  }
  const installed = adb(serial, ["install", "-r", apkPath()]);
  if (!installed.includes("Success"))
    throw new Error(`pocket redmi1s: install failed: ${installed}`);
  const packagePath = adb(serial, ["shell", "pm", "path", PACKAGE_NAME])
    .replace(/\r/g, "")
    .trim();
  if (!packagePath.startsWith("package:")) {
    throw new Error(`pocket redmi1s: package readback failed: ${packagePath}`);
  }
  console.log(`installed ${receipt.buildId} on ${serial}: ${packagePath}`);
}

function parseStatus(text: string): DeviceStatus {
  const fields: Record<string, string> = {};
  for (const line of text.replace(/\r/g, "").trim().split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0)
      fields[line.slice(0, separator)] = line.slice(separator + 1);
  }
  if (fields.schema !== "1" || !fields.build_id || !fields.state) {
    throw new Error(`pocket redmi1s: malformed device status:\n${text}`);
  }
  return fields;
}

function readDeviceStatus(serial: string): DeviceStatus {
  return parseStatus(
    adb(serial, ["shell", "run-as", PACKAGE_NAME, "cat", "files/status.txt"]),
  );
}

async function launch(): Promise<void> {
  const serial = verifyDeviceIdentity();
  adb(serial, ["shell", "am", "force-stop", PACKAGE_NAME]);
  const result = adb(serial, ["shell", "am", "start", "-n", COMPONENT]);
  if (!result.includes("Starting: Intent"))
    throw new Error(`pocket redmi1s: launch failed:\n${result}`);
  const receipt = readReceipt();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await Bun.sleep(250);
    try {
      const current = readDeviceStatus(serial);
      if (current.build_id === receipt.buildId && current.state === "running") {
        console.log(`launched ${receipt.buildId}: ${current.gl_renderer}`);
        return;
      }
      if (current.build_id === receipt.buildId && current.state === "failed") {
        throw new Error(`pocket redmi1s: runtime failed: ${current.error}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("runtime failed"))
        throw error;
    }
  }
  const logs = adb(serial, ["logcat", "-d", "-s", "PocketJS-Redmi1S:*", "*:S"]);
  throw new Error(
    `pocket redmi1s: runtime did not reach running state:\n${logs}`,
  );
}

function numeric(status: DeviceStatus, field: string): number {
  const value = Number(status[field]);
  if (!Number.isFinite(value))
    throw new Error(`pocket redmi1s: status field ${field} is not numeric`);
  return value;
}

async function status(requireAction = false): Promise<DeviceStatus> {
  const serial = verifyDeviceIdentity();
  const receipt = readReceipt();
  const first = readDeviceStatus(serial);
  await Bun.sleep(1000);
  const second = readDeviceStatus(serial);
  if (second.build_id !== receipt.buildId) {
    throw new Error(
      `pocket redmi1s: device build ${second.build_id} does not match local ${receipt.buildId}`,
    );
  }
  if (second.state !== "running" || second.renderer !== "gles2") {
    throw new Error(
      `pocket redmi1s: state=${second.state} renderer=${second.renderer} error=${second.error}`,
    );
  }
  if (
    second.logical_viewport !== "360x640" ||
    second.physical_viewport !== "720x1280" ||
    second.surface !== "720x1280"
  ) {
    throw new Error(
      "pocket redmi1s: runtime viewport receipt does not match the device contract",
    );
  }
  if (!second.gl_renderer.includes(TOOLCHAIN.device.gpuRenderer)) {
    throw new Error(
      `pocket redmi1s: unexpected GPU renderer ${second.gl_renderer}`,
    );
  }
  const glVersion = /^OpenGL ES (\d+)\.(\d+)/.exec(second.gl_version);
  if (!glVersion || Number(glVersion[1]) < 2) {
    throw new Error(
      `pocket redmi1s: runtime does not satisfy GLES2: ${second.gl_version}`,
    );
  }
  if (
    numeric(second, "guest_frames") <= numeric(first, "guest_frames") ||
    numeric(second, "swaps") <= numeric(first, "swaps")
  ) {
    throw new Error(
      "pocket redmi1s: guest frames or EGL swaps did not advance",
    );
  }
  if (
    numeric(second, "capture_successes") < 1 ||
    second.capture_hash === "0000000000000000"
  ) {
    throw new Error("pocket redmi1s: GPU readback capture is absent");
  }
  if (
    requireAction &&
    (second.action_name !== "hero_tap" ||
      numeric(second, "action_value") < 1 ||
      numeric(second, "completed_touch_sequences") < 1)
  ) {
    throw new Error("pocket redmi1s: no completed Hero touch/action receipt");
  }
  console.log(
    [
      `build=${second.build_id}`,
      `state=${second.state}`,
      `renderer=${second.renderer}`,
      `gpu=${second.gl_renderer}`,
      `gl=${second.gl_version}`,
      `frames=${second.guest_frames}`,
      `swaps=${second.swaps}`,
      `mean_frame_us=${second.mean_frame_us}`,
      `mean_swap_us=${second.mean_swap_us}`,
      `touches=${second.completed_touch_sequences}`,
      `action=${second.action_name || "none"}:${second.action_value || "0"}`,
      `capture=${second.capture_hash}`,
    ].join("\n"),
  );
  return second;
}

async function capture(): Promise<void> {
  const serial = verifyDeviceIdentity();
  const current = readDeviceStatus(serial);
  const width = Number(current.surface?.split("x")[0]);
  const height = Number(current.surface?.split("x")[1]);
  const remoteRaw = "/data/local/tmp/pocketjs-redmi1s-frame.rgba";
  const localRaw = join(outputDirectory(), ".device-frame.rgba");
  adb(serial, [
    "shell",
    `run-as ${PACKAGE_NAME} cat files/frame.rgba > ${remoteRaw}`,
  ]);
  mustRun("adb", ["-s", serial, "pull", remoteRaw, localRaw]);
  adb(serial, ["shell", "rm", remoteRaw]);
  const raw = readFileSync(localRaw);
  rmSync(localRaw, { force: true });
  const expected = width * height * 4;
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    raw.length !== expected
  ) {
    throw new Error(
      `pocket redmi1s: capture is ${raw.length} bytes, expected ${expected}`,
    );
  }
  const canvas = createCanvas(width, height);
  const image = canvas.getContext("2d").createImageData(width, height);
  const row = width * 4;
  for (let y = 0; y < height; y += 1) {
    image.data.set(
      raw.subarray((height - 1 - y) * row, (height - y) * row),
      y * row,
    );
  }
  canvas.getContext("2d").putImageData(image, 0, 0);
  const framePath = join(outputDirectory(), "device-frame.png");
  writeFileSync(framePath, canvas.toBuffer("image/png"));

  const remoteScreen = "/data/local/tmp/pocketjs-redmi1s-screen.png";
  const screenPath = join(outputDirectory(), "device-screen.png");
  adb(serial, ["shell", "screencap", "-p", remoteScreen]);
  mustRun("adb", ["-s", serial, "pull", remoteScreen, screenPath]);
  adb(serial, ["shell", "rm", remoteScreen]);
  const screen = readFileSync(screenPath);
  if (screen.subarray(1, 4).toString("ascii") !== "PNG") {
    throw new Error("pocket redmi1s: Android screenshot is not a PNG");
  }
  const decoded = await loadImage(screenPath);
  if (decoded.width !== 720 || decoded.height !== 1280) {
    throw new Error(
      `pocket redmi1s: screenshot is ${decoded.width}x${decoded.height}, expected 720x1280`,
    );
  }
  console.log(`captured ${framePath}\ncaptured ${screenPath}`);
}

async function accept(): Promise<void> {
  const serial = verifyDeviceIdentity();
  await status(false);
  await capture();
  adb(serial, ["shell", "input", "tap", "120", "1190"]);
  await Bun.sleep(1000);
  await status(true);
  await capture();
  console.log("Redmi 1S hardware acceptance passed");
}

function usage(): never {
  console.error(`usage: bun redmi1s <doctor|setup|build|deploy|launch|status|capture|accept|all>

  doctor   inspect the API 18 toolchain and exact connected phone
  setup    install the Rust target, pinned QuickJS source, and signing key
  build    compile the guest, ARMv7 runtime, GLES2 host, icons, and signed APK
  deploy   install the receipt-matched APK over ADB
  launch   start NativeActivity and wait for the GLES2 runtime
  status   verify advancing guest frames, EGL swaps, GPU identity, and capture
  capture  pull the GLES2 readback and Android compositor screenshot
  accept   verify runtime, inject a real Android touch, and verify Hero action
  all      build, deploy, launch, and accept`);
  process.exit(2);
}

async function main(): Promise<void> {
  const command = Bun.argv[2];
  if (command === "doctor") await doctor();
  else if (command === "setup") await setup();
  else if (command === "build") await build();
  else if (command === "deploy") await deploy();
  else if (command === "launch") await launch();
  else if (command === "status")
    await status(Bun.argv.includes("--require-action"));
  else if (command === "capture") await capture();
  else if (command === "accept") await accept();
  else if (command === "all") {
    await build();
    await deploy();
    await launch();
    await accept();
  } else usage();
}

if (import.meta.main) await main();
