import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import manifestJson from "./cli/nokia-n9-toolchain.json";
import { pocketStackCacheRoot } from "./psp-toolchain.ts";

export interface NokiaN9ToolchainManifest {
  readonly schemaVersion: 1;
  readonly toolchainVersion: string;
  readonly container: {
    readonly platform: "linux/amd64";
    readonly baseImage: string;
    readonly debianSnapshot: string;
    readonly debianSecuritySnapshot: string;
    readonly image: string;
    readonly volume: string;
  };
  readonly sdk: {
    readonly asset: string;
    readonly url: string;
    readonly bytes: number;
    readonly sha256: string;
    readonly installer: string;
    readonly installerMd5: string;
    readonly installerSha256: string;
  };
  readonly quickjs: {
    readonly version: string;
    readonly repository: string;
    readonly rev: string;
    readonly asset: string;
    readonly url: string;
    readonly sha256: string;
  };
  readonly downloadsCachePath: string;
  readonly receipt: string;
  readonly markers: readonly string[];
  readonly device: {
    readonly usbVendorId: string;
    readonly storageProductId: string;
    readonly model: string;
    readonly defaultHost: string;
    readonly user: string;
  };
  readonly runtime: {
    readonly rustToolchain: string;
    readonly tickHz: 60;
    readonly target: "nokia-n9-dev";
    readonly hostAbi: 9;
  };
}

export const NOKIA_N9_TOOLCHAIN = manifestJson as unknown as NokiaN9ToolchainManifest;

export function nokiaN9DownloadsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.POCKETJS_NOKIA_N9_DOWNLOADS?.trim();
  return explicit
    ? resolve(explicit)
    : join(pocketStackCacheRoot(env), NOKIA_N9_TOOLCHAIN.downloadsCachePath);
}

export function nokiaN9DownloadPath(
  asset: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return join(nokiaN9DownloadsRoot(env), asset);
}

const IMPLEMENTATION_FILES = [
  "tools/cli/nokia-n9-toolchain.json",
  "tools/nokia-n9/Dockerfile",
  "tools/nokia-n9/Dockerfile.dockerignore",
  "tools/nokia-n9/container/controller.qs",
  "tools/nokia-n9/container/pocketjs-nokia-n9-setup",
  "tools/nokia-n9/container/pocketjs-nokia-n9-doctor",
  "tools/nokia-n9/container/pocketjs-nokia-n9-build-probe",
  "tools/nokia-n9/container/pocketjs-nokia-n9-build-app",
  "tools/nokia-n9/container/patches/quickjs-harmattan.patch",
] as const;

export function nokiaN9ImplementationDigest(repository: string): string {
  const root = isAbsolute(repository) ? repository : resolve(repository);
  const hash = createHash("sha256");
  for (const relative of IMPLEMENTATION_FILES) {
    const path = join(root, relative);
    if (!existsSync(path)) throw new Error(`missing N9 implementation input ${relative}`);
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function nokiaN9DockerBuildArguments(repository: string): string[] {
  const manifest = NOKIA_N9_TOOLCHAIN;
  return [
    "build",
    "--platform",
    manifest.container.platform,
    "--build-arg",
    `POCKETJS_NOKIA_N9_BASE_IMAGE=${manifest.container.baseImage}`,
    "--build-arg",
    `POCKETJS_DEBIAN_SNAPSHOT=${manifest.container.debianSnapshot}`,
    "--build-arg",
    `POCKETJS_DEBIAN_SECURITY_SNAPSHOT=${manifest.container.debianSecuritySnapshot}`,
    "--build-arg",
    `POCKETJS_NOKIA_N9_IMPLEMENTATION_SHA256=${nokiaN9ImplementationDigest(repository)}`,
    "--build-arg",
    `POCKETJS_NOKIA_N9_TOOLCHAIN_VERSION=${manifest.toolchainVersion}`,
    "-f",
    join(repository, "tools/nokia-n9/Dockerfile"),
    "-t",
    manifest.container.image,
    repository,
  ];
}

export function nokiaN9DockerRunArguments(
  repository: string,
  command: string,
  extra: readonly string[] = [],
): string[] {
  const root = isAbsolute(repository) ? repository : resolve(repository);
  return [
    "run",
    "--rm",
    "--platform",
    NOKIA_N9_TOOLCHAIN.container.platform,
    "--user",
    `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
    "--network=none",
    "--mount",
    `type=volume,src=${NOKIA_N9_TOOLCHAIN.container.volume},dst=/toolchain`,
    "--mount",
    `type=bind,src=${root},dst=/work,readonly`,
    "--mount",
    `type=bind,src=${join(root, "dist/nokia-n9")},dst=/out`,
    NOKIA_N9_TOOLCHAIN.container.image,
    command,
    ...extra,
  ];
}
