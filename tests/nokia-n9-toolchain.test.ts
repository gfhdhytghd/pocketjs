import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NOKIA_N9_TOOLCHAIN,
  nokiaN9DockerBuildArguments,
  nokiaN9DockerRunArguments,
  nokiaN9ImplementationDigest,
} from "../tools/nokia-n9-toolchain.ts";

const root = resolve(import.meta.dir, "..");

describe("pinned Nokia N9 Harmattan toolchain", () => {
  test("pins both the community archive and historical installer", () => {
    expect(NOKIA_N9_TOOLCHAIN.sdk.url).toBe(
      "https://n9.dy.fi/wp-content/uploads/2015/08/QtSdk-offline-linux-x86_64-v1.2.1.zip",
    );
    expect(NOKIA_N9_TOOLCHAIN.sdk.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(NOKIA_N9_TOOLCHAIN.sdk.installerMd5).toBe(
      "d200c6aa8684e9963d2ea4354266da3f",
    );
    expect(NOKIA_N9_TOOLCHAIN.sdk.installerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(NOKIA_N9_TOOLCHAIN.quickjs.rev).toMatch(/^[a-f0-9]{40}$/);
    expect(NOKIA_N9_TOOLCHAIN.quickjs.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test("builds amd64 from Debian snapshots and runs builds without network", () => {
    const digest = nokiaN9ImplementationDigest(root);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    const build = nokiaN9DockerBuildArguments(root).join(" ");
    expect(build).toContain("--platform linux/amd64");
    expect(build).toContain(NOKIA_N9_TOOLCHAIN.container.baseImage);
    expect(build).toContain(digest);
    const run = nokiaN9DockerRunArguments(root, "pocketjs-nokia-n9-doctor");
    expect(run).toContain("--network=none");
    expect(run.join(" ")).toContain("dst=/work,readonly");
    expect(run.join(" ")).toContain("dst=/toolchain");
    const orchestrator = readFileSync(resolve(root, "tools/nokia-n9.ts"), "utf8");
    expect(orchestrator).toContain('"--env", "CARGO_NET_OFFLINE=true"');
    expect(orchestrator).toContain("dst=/rustup,readonly");
    expect(orchestrator).toContain("dst=/cargo,readonly");
    expect(orchestrator).toContain('"--workdir", "/work/engine/symbian"');
  });

  test("installer setup validates hashes before entering the persistent volume", () => {
    const setup = readFileSync(
      resolve(root, "tools/nokia-n9/container/pocketjs-nokia-n9-setup"),
      "utf8",
    );
    expect(setup).toContain("sha256sum --check --status");
    expect(setup).toContain("md5sum --check --status");
    expect(setup).toContain("rm -rf /toolchain/QtSDK");
    expect(setup).toContain("test -x /toolchain/QtSDK/Madde/bin/mad");
  });

  test("ARM target matches Harmattan's Cortex-A8 VFP-argument ABI", () => {
    const target = JSON.parse(readFileSync(
      resolve(root, "engine/symbian/targets/armv7-nokia-n9-eabihf.json"),
      "utf8",
    ));
    expect(target.abi).toBe("eabihf");
    expect(target.cpu).toBe("cortex-a8");
    expect(target["llvm-floatabi"]).toBe("hard");
    expect(target.features).toContain("+vfp3");
    expect(target.features).toContain("+neon");
  });

  test("app packaging rejects ABI, dependency, and GLIBC drift", () => {
    const builder = readFileSync(
      resolve(root, "tools/nokia-n9/container/pocketjs-nokia-n9-build-app"),
      "utf8",
    );
    expect(builder).toContain("-mfloat-abi=hard");
    expect(builder).toContain("Tag_ABI_VFP_args: VFP registers");
    expect(builder).toContain("Requesting program interpreter: /lib/ld-linux.so.3");
    expect(builder).toContain("unexpected dynamic dependency");
    expect(builder).toContain("required-glibc.txt");
    expect(builder).toContain("available-glibc.txt");
    expect(builder).toContain("dpkg-deb --build");
    expect(builder).toContain("s|@EXECUTABLE@|$executable|g");
    expect(builder).not.toContain("export HOME=");
  });
});
