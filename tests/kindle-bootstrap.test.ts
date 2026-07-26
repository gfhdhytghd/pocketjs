import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureDedicatedSshKey,
  KINDLE_BOOTSTRAP_ASSETS,
  KINDLE_USB_NETWORK,
  parseKindleBootstrapArgs,
  safeArchiveMemberPath,
  stageKindleVolume,
  type PreparedKindlePayload,
} from "../tools/kindle-bootstrap.ts";

const root = new URL("..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
const text = new TextEncoder();

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function temporaryRoot(prefix = "pocketjs-kindle-test-"): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function kindleVolume(): string {
  const volume = temporaryRoot();
  mkdirSync(join(volume, "documents"));
  return volume;
}

function fakeArmElf(seed: number): Uint8Array {
  const data = new Uint8Array(64);
  data.set([0x7f, 0x45, 0x4c, 0x46, 1, 1], 0);
  data[18] = 40;
  data[19] = 0;
  data[32] = seed;
  return data;
}

function appleDoubleFixture(): Uint8Array {
  const data = Buffer.alloc(42);
  data.writeUInt32BE(0x00051607, 0);
  data.writeUInt32BE(0x00020000, 4);
  data.write("Mac OS X        ", 8, "ascii");
  data.writeUInt16BE(1, 24);
  data.writeUInt32BE(9, 26);
  data.writeUInt32BE(38, 30);
  data.writeUInt32BE(4, 34);
  data.writeUInt32BE(0, 38);
  return data;
}

function fakePowerd(options?: {
  preventScreenSaver?: "0" | "1";
  state?: string;
  ignoreSet?: boolean;
}) {
  const fixture = temporaryRoot();
  const fakeBin = join(fixture, "bin");
  const preventFile = join(fixture, "prevent-screen-saver");
  const stateFile = join(fixture, "powerd-state");
  const callLog = join(fixture, "powerd-calls.txt");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(preventFile, `${options?.preventScreenSaver ?? "0"}\n`);
  writeFileSync(stateFile, `${options?.state ?? "active"}\n`);
  writeFileSync(
    join(fakeBin, "lipc-get-prop"),
    [
      "#!/bin/sh",
      'printf "get %s\\n" "$*" >>"$POCKETJS_TEST_POWERD_CALL_LOG"',
      'pocketjs_test_property="${5:-$4}"',
      'case "$pocketjs_test_property" in',
      '  preventScreenSaver) cat "$POCKETJS_TEST_POWERD_PREVENT_FILE" ;;',
      '  state) cat "$POCKETJS_TEST_POWERD_STATE_FILE" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(fakeBin, "lipc-set-prop"),
    [
      "#!/bin/sh",
      'printf "set %s\\n" "$*" >>"$POCKETJS_TEST_POWERD_CALL_LOG"',
      '[ "$4" = "preventScreenSaver" ] || exit 1',
      options?.ignoreSet
        ? ":"
        : 'printf "%s\\n" "$5" >"$POCKETJS_TEST_POWERD_PREVENT_FILE"',
      "",
    ].join("\n"),
  );
  chmodSync(join(fakeBin, "lipc-get-prop"), 0o755);
  chmodSync(join(fakeBin, "lipc-set-prop"), 0o755);
  return {
    fixture,
    preventFile,
    callLog,
    env: {
      ...process.env,
      POCKETJS_SYSTEM_PATH: `${fakeBin}:/usr/bin:/bin`,
      POCKETJS_TEST_POWERD_PREVENT_FILE: preventFile,
      POCKETJS_TEST_POWERD_STATE_FILE: stateFile,
      POCKETJS_TEST_POWERD_CALL_LOG: callLog,
    },
  };
}

function payload(): PreparedKindlePayload {
  return {
    kual: text.encode("#!/bin/sh\n# fixture PEKI\n"),
    fbink: fakeArmElf(1),
    dropbear: fakeArmElf(2),
    publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureKeyMaterial pocketjs-test\n",
    mrpiEntries: [
      { path: "extensions/", directory: true, mode: 0o755 },
      { path: "extensions/MRInstaller/", directory: true, mode: 0o755 },
      {
        path: "extensions/MRInstaller/bin/mrinstaller.sh",
        directory: false,
        mode: 0o755,
        data: text.encode("#!/bin/sh\n# fixture MRPI\n"),
      },
      { path: "mrpackages/", directory: true, mode: 0o755 },
      {
        path: "extensions/._FinderJunk",
        directory: false,
        mode: 0o644,
        data: text.encode("must not be copied"),
      },
    ],
  };
}

describe("Kindle USB bootstrap manifest", () => {
  test("pins every upstream asset and the known PEKI SHA-256", () => {
    expect(KINDLE_BOOTSTRAP_ASSETS.peki).toMatchObject({
      version: "1.0.0",
      sourceRevision: "v1.0.0",
      url: "https://github.com/KindleModding/PEKI/releases/download/v1.0.0/PEKI.zip",
      sha256: "617571e81c96809f34dff0b710db8aebbda03dcfbfef4322ab51d20e09175034",
      memberSha256: "1e86c0aac4e99d03e627ec8b410a9d9badf0bd6f701b89dc4adf5fb7c5cb33a0",
    });
    expect(KINDLE_BOOTSTRAP_ASSETS.mrpi.url).toContain(
      KINDLE_BOOTSTRAP_ASSETS.mrpi.sourceRevision,
    );
    expect(KINDLE_BOOTSTRAP_ASSETS.koreader.url).toContain(
      KINDLE_BOOTSTRAP_ASSETS.koreader.sourceRevision,
    );
    for (const asset of Object.values(KINDLE_BOOTSTRAP_ASSETS)) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(KINDLE_BOOTSTRAP_ASSETS.koreader.members.fbink.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(KINDLE_BOOTSTRAP_ASSETS.koreader.members.dropbear.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("uses the conventional point-to-point Kindle USB addresses", () => {
    expect(KINDLE_USB_NETWORK).toEqual({
      hostIp: "192.168.15.201",
      kindleIp: "192.168.15.244",
      netmask: "255.255.255.0",
      interface: "usb0",
    });
  });
});

describe("Kindle USB volume staging", () => {
  test("installs only managed targets, preserves unrelated content, and is idempotent", () => {
    const volume = kindleVolume();
    writeFileSync(join(volume, "documents", "my-book.txt"), "keep me");
    mkdirSync(join(volume, "extensions", "OtherExtension"), { recursive: true });
    writeFileSync(join(volume, "extensions", "OtherExtension", "config.xml"), "keep extension");
    mkdirSync(join(volume, "pocketjs-dev", "settings", "SSH"), { recursive: true });
    writeFileSync(join(volume, "pocketjs-dev", "notes.txt"), "keep notes");
    writeFileSync(
      join(volume, "pocketjs-dev", "settings", "SSH", "authorized_keys"),
      "ssh-ed25519 AAAAExistingUserKey existing\n",
    );

    const first = stageKindleVolume(volume, payload(), { sshPort: 2222 });
    expect(first.installed.length).toBeGreaterThan(0);
    expect(readFileSync(join(volume, "documents", "my-book.txt"), "utf8")).toBe("keep me");
    expect(
      readFileSync(join(volume, "extensions", "OtherExtension", "config.xml"), "utf8"),
    ).toBe("keep extension");
    expect(readFileSync(join(volume, "pocketjs-dev", "notes.txt"), "utf8")).toBe("keep notes");

    const authorizedKeys = readFileSync(
      join(volume, "pocketjs-dev", "settings", "SSH", "authorized_keys"),
      "utf8",
    );
    expect(authorizedKeys).toContain("AAAAExistingUserKey");
    expect(authorizedKeys).toContain("BEGIN POCKETJS KINDLE BOOTSTRAP KEY");
    expect(authorizedKeys).toContain("AAAAIFixtureKeyMaterial");

    const start = readFileSync(join(volume, "pocketjs-dev", "start-ssh.sh"), "utf8");
    expect(start).toContain("-l usb0");
    expect(start).toContain(`-p "$POCKETJS_KINDLE_IP:$POCKETJS_PORT"`);
    expect(start).toContain(KINDLE_USB_NETWORK.kindleIp);
    expect(start).not.toContain("@@");
    expect(
      readFileSync(join(volume, "pocketjs-dev", "usbnet-start.sh"), "utf8"),
    ).toContain('sh "$POCKETJS_USB_MODE" network');
    expect(
      readFileSync(join(volume, "pocketjs-dev", "usb-mode.sh"), "utf8"),
    ).not.toContain("/usr/local/bin/usbnetwork.sh");
    expect(existsSync(join(volume, "documents", "PocketJS-Dev-Start-USBNet.sh"))).toBe(true);
    expect(existsSync(join(volume, "documents", "PocketJS-Dev-Stop-USBNet.sh"))).toBe(true);
    expect(existsSync(join(volume, "documents", "PocketJS-Dev-Run-Runtime.sh"))).toBe(true);
    expect(existsSync(join(volume, "documents", "PocketJS-Dev-Stop-Runtime.sh"))).toBe(true);
    const kualMenu = JSON.parse(
      readFileSync(join(volume, "extensions", "PocketJS", "menu.json"), "utf8"),
    );
    expect(kualMenu.items[0].name).toBe("PocketJS Dev");
    expect(kualMenu.items[0].items.slice(0, 2)).toEqual([
      expect.objectContaining({
        name: "Start USB SSH",
        action: "./bin/pocketjs.sh",
        params: "start-ssh",
      }),
      expect.objectContaining({
        name: "Stop USB SSH",
        action: "./bin/pocketjs.sh",
        params: "stop-ssh",
      }),
    ]);
    expect(
      readFileSync(
        join(volume, "extensions", "PocketJS", "bin", "pocketjs.sh"),
        "utf8",
      ),
    ).toContain("exec sh /mnt/us/pocketjs-dev/start-ssh.sh");
    const runtimeLauncher = readFileSync(
      join(volume, "pocketjs-dev", "run-runtime.sh"),
      "utf8",
    );
    expect(runtimeLauncher).toContain("trap 'cleanup $?' EXIT");
    expect(runtimeLauncher).toContain("trap 'on_hup' HUP");
    expect(runtimeLauncher).toContain("kill \"-$pocketjs_signal\" \"$POCKETJS_RUNTIME_PID\"");
    expect(runtimeLauncher).toContain("KPPMainAppV2 KPPMainApp awesome");
    expect(runtimeLauncher).toContain("runtime.log");
    expect(runtimeLauncher).toContain("export POCKETJS_GUI_PAUSED=1");
    expect(runtimeLauncher).toContain("persist_powerd_original");
    expect(runtimeLauncher).toContain("restore_recorded_powerd");
    expect(runtimeLauncher).not.toContain("com.lab126.powerd powerButton");
    expect(
      runtimeLauncher.indexOf("if ! prevent_screensaver_for_runtime;"),
    ).toBeLessThan(runtimeLauncher.indexOf("if ! pause_kindle_ui;"));
    expect(runtimeLauncher.indexOf("if ! pause_kindle_ui;")).toBeLessThan(
      runtimeLauncher.indexOf("export POCKETJS_GUI_PAUSED=1"),
    );
    expect(runtimeLauncher.indexOf("export POCKETJS_GUI_PAUSED=1")).toBeLessThan(
      runtimeLauncher.indexOf('"$POCKETJS_RUNTIME" "$@" &'),
    );
    const cleanupStart = runtimeLauncher.indexOf("cleanup() {");
    const cleanupEnd = runtimeLauncher.indexOf(
      "\n}\n\nforward_signal()",
      cleanupStart,
    );
    const cleanupBody = runtimeLauncher.slice(cleanupStart, cleanupEnd);
    expect(
      cleanupBody.indexOf('"$POCKETJS_DEV_ROOT/bin/fbink" -q -f -s'),
    ).toBeLessThan(
      cleanupBody.indexOf('rm -f "$POCKETJS_LAUNCH_LOCK/owner"'),
    );
    expect(existsSync(join(volume, "extensions", "._FinderJunk"))).toBe(false);

    const receipt = JSON.parse(
      readFileSync(join(volume, "pocketjs-dev", ".pocketjs-bootstrap.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      managedBy: "pocketjs-kindle-bootstrap",
      schemaVersion: 2,
      profile: { device: "Kindle Paperwhite 5", firmware: "5.19.2", abi: "armhf" },
      ssh: {
        port: 2222,
        transport: {
          interface: "usb0",
          hostIp: KINDLE_USB_NETWORK.hostIp,
          kindleIp: KINDLE_USB_NETWORK.kindleIp,
          wifiListening: false,
        },
      },
    });
    const expectedManagedFiles = [
      "documents/KUAL.sh",
      "documents/PocketJS-Dev-Diagnose.sh",
      "documents/PocketJS-Dev-Run-Runtime.sh",
      "documents/PocketJS-Dev-Start-USBNet.sh",
      "documents/PocketJS-Dev-Start.sh",
      "documents/PocketJS-Dev-Stop-Runtime.sh",
      "documents/PocketJS-Dev-Stop-USBNet.sh",
      "documents/PocketJS-Dev-Stop.sh",
      "extensions/MRInstaller/bin/mrinstaller.sh",
      "extensions/PocketJS/bin/pocketjs.sh",
      "extensions/PocketJS/menu.json",
      "pocketjs-dev/README.txt",
      "pocketjs-dev/bin/dropbear",
      "pocketjs-dev/bin/fbink",
      "pocketjs-dev/diagnose.sh",
      "pocketjs-dev/run-runtime.sh",
      "pocketjs-dev/settings/SSH/authorized_keys",
      "pocketjs-dev/start-ssh.sh",
      "pocketjs-dev/stop-runtime.sh",
      "pocketjs-dev/stop-ssh.sh",
      "pocketjs-dev/usb-mode.sh",
      "pocketjs-dev/usbnet-start.sh",
      "pocketjs-dev/usbnet-stop.sh",
    ];
    expect(receipt.managedFiles.map((file: { path: string }) => file.path).sort()).toEqual(
      expectedManagedFiles.sort(),
    );
    for (const file of receipt.managedFiles as Array<{
      path: string;
      bytes: number;
      sha256: string;
    }>) {
      const data = readFileSync(join(volume, ...file.path.split("/")));
      expect(file.bytes).toBe(data.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(data).digest("hex"));
    }

    const allFiles = readdirSync(volume, { recursive: true, encoding: "utf8" });
    expect(allFiles.some((path) => path.split("/").some((name) => name.startsWith("._")))).toBe(
      false,
    );

    const second = stageKindleVolume(volume, payload(), { sshPort: 2222 });
    expect(second.installed).toEqual([]);
    expect(second.updated).toEqual([]);
    expect(second.unchanged.length).toBeGreaterThan(0);
  });

  test("removes only valid AppleDouble sidecars for exact managed targets", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    writeFileSync(join(volume, "._pocketjs-dev"), appleDoubleFixture());
    writeFileSync(join(volume, "._extensions"), appleDoubleFixture());
    writeFileSync(join(volume, "._mrpackages"), appleDoubleFixture());
    writeFileSync(join(volume, "documents", "._KUAL.sh"), appleDoubleFixture());
    writeFileSync(join(volume, "extensions", "._PocketJS"), appleDoubleFixture());
    writeFileSync(
      join(volume, "extensions", "MRInstaller", "bin", "._mrinstaller.sh"),
      appleDoubleFixture(),
    );
    writeFileSync(
      join(volume, "pocketjs-dev", "._.pocketjs-bootstrap.json"),
      appleDoubleFixture(),
    );
    writeFileSync(join(volume, "pocketjs-dev", "._notes.txt"), appleDoubleFixture());
    writeFileSync(join(volume, "documents", "._my-book.txt"), appleDoubleFixture());

    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    expect(existsSync(join(volume, "._pocketjs-dev"))).toBe(false);
    expect(existsSync(join(volume, "._extensions"))).toBe(true);
    expect(existsSync(join(volume, "._mrpackages"))).toBe(true);
    expect(existsSync(join(volume, "documents", "._KUAL.sh"))).toBe(false);
    expect(existsSync(join(volume, "extensions", "._PocketJS"))).toBe(false);
    expect(
      existsSync(join(volume, "extensions", "MRInstaller", "bin", "._mrinstaller.sh")),
    ).toBe(false);
    expect(
      existsSync(join(volume, "pocketjs-dev", "._.pocketjs-bootstrap.json")),
    ).toBe(false);
    expect(existsSync(join(volume, "pocketjs-dev", "._notes.txt"))).toBe(true);
    expect(existsSync(join(volume, "documents", "._my-book.txt"))).toBe(true);
  });

  test("preflights a non-AppleDouble collision before updating managed files", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const startBefore = readFileSync(join(volume, "pocketjs-dev", "start-ssh.sh"));
    const receiptBefore = readFileSync(
      join(volume, "pocketjs-dev", ".pocketjs-bootstrap.json"),
    );
    writeFileSync(join(volume, "documents", "._KUAL.sh"), "user data");

    expect(() => stageKindleVolume(volume, payload(), { sshPort: 22022 })).toThrow(
      "AppleDouble collision at managed metadata path",
    );
    expect(readFileSync(join(volume, "documents", "._KUAL.sh"), "utf8")).toBe("user data");
    expect(readFileSync(join(volume, "pocketjs-dev", "start-ssh.sh"))).toEqual(startBefore);
    expect(readFileSync(join(volume, "pocketjs-dev", ".pocketjs-bootstrap.json"))).toEqual(
      receiptBefore,
    );
  });

  test("rejects malformed AppleDouble headers and entry tables", () => {
    const malformed = [
      {
        data: Uint8Array.of(0x00, 0x05, 0x16, 0x07),
        error: "refusing truncated AppleDouble collision",
      },
      {
        data: (() => {
          const data = Buffer.from(appleDoubleFixture());
          data.writeUInt32BE(0x00030000, 4);
          return data;
        })(),
        error: "refusing non-AppleDouble collision",
      },
      {
        data: (() => {
          const data = Buffer.from(appleDoubleFixture());
          data.writeUInt32BE(data.byteLength + 1, 30);
          return data;
        })(),
        error: "refusing invalid AppleDouble entry",
      },
    ];

    for (const fixture of malformed) {
      const volume = kindleVolume();
      stageKindleVolume(volume, payload(), { sshPort: 2222 });
      writeFileSync(join(volume, "documents", "._KUAL.sh"), fixture.data);
      expect(() => stageKindleVolume(volume, payload(), { sshPort: 2222 })).toThrow(
        fixture.error,
      );
      expect(readFileSync(join(volume, "documents", "._KUAL.sh"))).toEqual(
        Buffer.from(fixture.data),
      );
    }
  });

  test("removes an AppleDouble sidecar left beside an atomic temporary file", () => {
    const volume = kindleVolume();
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const temporarySidecar = join(
        volume,
        "documents",
        `._.KUAL.sh.pocketjs-${process.pid}-8`,
      );
      writeFileSync(temporarySidecar, appleDoubleFixture());
      stageKindleVolume(volume, payload(), { sshPort: 2222 });
      expect(existsSync(temporarySidecar)).toBe(false);
    } finally {
      Math.random = originalRandom;
    }
  });

  test("preserves a pre-existing temporary-name collision and its sidecar", () => {
    const volume = kindleVolume();
    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
      const temporary = join(
        volume,
        "documents",
        `.KUAL.sh.pocketjs-${process.pid}-8`,
      );
      const temporarySidecar = join(
        volume,
        "documents",
        `._.KUAL.sh.pocketjs-${process.pid}-8`,
      );
      writeFileSync(temporary, "pre-existing temporary path");
      writeFileSync(temporarySidecar, appleDoubleFixture());

      expect(() => stageKindleVolume(volume, payload(), { sshPort: 2222 })).toThrow();
      expect(readFileSync(temporary, "utf8")).toBe("pre-existing temporary path");
      expect(readFileSync(temporarySidecar)).toEqual(Buffer.from(appleDoubleFixture()));
    } finally {
      Math.random = originalRandom;
    }
  });

  test("preflights conflicts before writing anything", () => {
    const volume = kindleVolume();
    writeFileSync(join(volume, "documents", "KUAL.sh"), "a different user file");

    expect(() => stageKindleVolume(volume, payload())).toThrow(
      "refusing to overwrite an existing different PEKI KUAL.sh",
    );
    expect(existsSync(join(volume, "pocketjs-dev"))).toBe(false);
    expect(readFileSync(join(volume, "documents", "KUAL.sh"), "utf8")).toBe(
      "a different user file",
    );
  });

  test("updates PocketJS-owned text when the port changes without replacing binaries", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const beforeFbink = readFileSync(join(volume, "pocketjs-dev", "bin", "fbink"));

    const updated = stageKindleVolume(volume, payload(), { sshPort: 22022 });
    expect(updated.updated).toContain("pocketjs-dev/start-ssh.sh");
    expect(updated.updated).toContain("pocketjs-dev/.pocketjs-bootstrap.json");
    expect(readFileSync(join(volume, "pocketjs-dev", "start-ssh.sh"), "utf8")).toContain(
      'POCKETJS_PORT="${POCKETJS_SSH_PORT:-22022}"',
    );
    expect(readFileSync(join(volume, "pocketjs-dev", "bin", "fbink"))).toEqual(beforeFbink);
  });

  test("drives the firmware volumd switch in both directions and verifies sysfs state", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fakeBin = join(temporaryRoot(), "bin");
    const fakeUsb0 = join(temporaryRoot(), "sys", "class", "net", "usb0");
    const callLog = join(temporaryRoot(), "lipc-calls.txt");
    const attemptFile = join(temporaryRoot(), "volumd-attempts.txt");
    const propertyFile = join(temporaryRoot(), "volumd-property.txt");
    mkdirSync(fakeBin, { recursive: true });
    const setProp = join(fakeBin, "lipc-set-prop");
    writeFileSync(
      setProp,
      [
        "#!/bin/sh",
        'printf "set %s\\n" "$*" >>"$POCKETJS_TEST_CALL_LOG"',
        'if [ "$5" = "1" ]; then',
        "  pocketjs_test_attempt=0",
        '  if [ -f "$POCKETJS_TEST_ATTEMPT_FILE" ]; then',
        '    pocketjs_test_attempt=$(sed -n "1p" "$POCKETJS_TEST_ATTEMPT_FILE")',
        "  fi",
        "  pocketjs_test_attempt=$((pocketjs_test_attempt + 1))",
        '  printf "%s\\n" "$pocketjs_test_attempt" >"$POCKETJS_TEST_ATTEMPT_FILE"',
        '  if [ "$pocketjs_test_attempt" -lt 3 ]; then exit 1; fi',
        '  mkdir -p "$POCKETJS_USB_INTERFACE_PATH"',
        "else",
        '  rmdir "$POCKETJS_USB_INTERFACE_PATH"',
        "fi",
        'printf "%s\\n" "$5" >"$POCKETJS_TEST_PROPERTY_FILE"',
        "",
      ].join("\n"),
    );
    chmodSync(setProp, 0o755);
    const getProp = join(fakeBin, "lipc-get-prop");
    writeFileSync(getProp, '#!/bin/sh\ncat "$POCKETJS_TEST_PROPERTY_FILE"\n');
    chmodSync(getProp, 0o755);
    const sendEvent = join(fakeBin, "lipc-send-event");
    writeFileSync(
      sendEvent,
      [
        "#!/bin/sh",
        'printf "event %s\\n" "$*" >>"$POCKETJS_TEST_CALL_LOG"',
        "",
      ].join("\n"),
    );
    chmodSync(sendEvent, 0o755);
    const id = join(fakeBin, "id");
    writeFileSync(id, "#!/bin/sh\nprintf '0\\n'\n");
    chmodSync(id, 0o755);
    const ifconfig = join(fakeBin, "ifconfig");
    writeFileSync(
      ifconfig,
      [
        "#!/bin/sh",
        'printf "ifconfig %s\\n" "$*" >>"$POCKETJS_TEST_CALL_LOG"',
        "",
      ].join("\n"),
    );
    chmodSync(ifconfig, 0o755);
    const sleep = join(fakeBin, "sleep");
    writeFileSync(
      sleep,
      [
        "#!/bin/sh",
        'printf "sleep %s\\n" "$*" >>"$POCKETJS_TEST_CALL_LOG"',
        "",
      ].join("\n"),
    );
    chmodSync(sleep, 0o755);

    const usbMode = join(volume, "pocketjs-dev", "usb-mode.sh");
    const environment = {
      ...process.env,
      POCKETJS_SYSTEM_PATH: `${fakeBin}:/usr/bin:/bin`,
      POCKETJS_USB_INTERFACE_PATH: fakeUsb0,
      POCKETJS_USB_WAIT_LIMIT: "0",
      POCKETJS_VOLUMD_RETRY_LIMIT: "3",
      POCKETJS_USB_SHORT_SETTLE: "0",
      POCKETJS_USB_LONG_SETTLE: "0",
      POCKETJS_TEST_CALL_LOG: callLog,
      POCKETJS_TEST_ATTEMPT_FILE: attemptFile,
      POCKETJS_TEST_PROPERTY_FILE: propertyFile,
    };
    const network = Bun.spawnSync({
      cmd: ["/bin/sh", usbMode, "network"],
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(network.exitCode, network.stderr.toString()).toBe(0);
    expect(existsSync(fakeUsb0)).toBe(true);

    const massStorage = Bun.spawnSync({
      cmd: ["/bin/sh", usbMode, "mass-storage"],
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(massStorage.exitCode, massStorage.stderr.toString()).toBe(0);
    expect(existsSync(fakeUsb0)).toBe(false);
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual([
      "set -i -- com.lab126.volumd useUsbForNetwork 1",
      "sleep 1",
      "set -i -- com.lab126.volumd useUsbForNetwork 1",
      "sleep 1",
      "set -i -- com.lab126.volumd useUsbForNetwork 1",
      "event -r 3 -d 2 com.lab126.hal usbUnconfigured",
      "sleep 0",
      "event -r 3 -d 2 com.lab126.hal usbPlugOut",
      "ifconfig usb0 down",
      "set -i -- com.lab126.volumd useUsbForNetwork 0",
      "sleep 0",
      "event -r 3 -d 2 com.lab126.hal usbUnconfigured",
      "sleep 0",
      "event -r 3 -d 2 com.lab126.hal usbPlugOut",
      "sleep 0",
    ]);
  });

  test("rejects a successful volumd write whose property read-back disagrees", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const fakeBin = join(fixture, "bin");
    const fakeUsb0 = join(fixture, "usb0");
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(
      join(fakeBin, "lipc-set-prop"),
      '#!/bin/sh\nmkdir -p "$POCKETJS_USB_INTERFACE_PATH"\n',
    );
    writeFileSync(join(fakeBin, "lipc-get-prop"), "#!/bin/sh\nprintf '0\\n'\n");
    writeFileSync(join(fakeBin, "lipc-send-event"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(fakeBin, "id"), "#!/bin/sh\nprintf '0\\n'\n");
    for (const name of ["lipc-set-prop", "lipc-get-prop", "lipc-send-event", "id"]) {
      chmodSync(join(fakeBin, name), 0o755);
    }

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(volume, "pocketjs-dev", "usb-mode.sh"), "network"],
      env: {
        ...process.env,
        POCKETJS_SYSTEM_PATH: `${fakeBin}:/usr/bin:/bin`,
        POCKETJS_USB_INTERFACE_PATH: fakeUsb0,
        POCKETJS_USB_WAIT_LIMIT: "0",
        POCKETJS_VOLUMD_RETRY_LIMIT: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "volumd read-back mismatch (requested 1, got 0)",
    );
  });

  test("reasserts Mass Storage after a partially accepted USBNetwork transition", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const fakeBin = join(fixture, "bin");
    const fakeUsb0 = join(fixture, "sys", "class", "net", "usb0");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const controlRoot = join(fixture, "control");
    const callLog = join(fixture, "volumd-values.txt");
    const propertyFile = join(fixture, "volumd-property.txt");
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });

    const setProp = join(fakeBin, "lipc-set-prop");
    writeFileSync(
      setProp,
      [
        "#!/bin/sh",
        'printf "%s\\n" "$5" >>"$POCKETJS_TEST_CALL_LOG"',
        'printf "%s\\n" "$5" >"$POCKETJS_TEST_PROPERTY_FILE"',
        "# Deliberately accept network=1 without ever creating usb0.",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(setProp, 0o755);
    const getProp = join(fakeBin, "lipc-get-prop");
    writeFileSync(getProp, '#!/bin/sh\ncat "$POCKETJS_TEST_PROPERTY_FILE"\n');
    chmodSync(getProp, 0o755);
    const sendEvent = join(fakeBin, "lipc-send-event");
    writeFileSync(sendEvent, "#!/bin/sh\nexit 0\n");
    chmodSync(sendEvent, 0o755);
    const id = join(fakeBin, "id");
    writeFileSync(id, "#!/bin/sh\nprintf '0\\n'\n");
    chmodSync(id, 0o755);
    const sleep = join(fakeBin, "sleep");
    writeFileSync(sleep, "#!/bin/sh\nexit 0\n");
    chmodSync(sleep, 0o755);

    const devRoot = join(volume, "pocketjs-dev");
    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-start.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_SYSTEM_PATH: `${fakeBin}:/usr/bin:/bin`,
        POCKETJS_USB_INTERFACE_PATH: fakeUsb0,
        POCKETJS_USB_WAIT_LIMIT: "0",
        POCKETJS_VOLUMD_RETRY_LIMIT: "1",
        POCKETJS_USB_SHORT_SETTLE: "0",
        POCKETJS_USB_LONG_SETTLE: "0",
        POCKETJS_TEST_CALL_LOG: callLog,
        POCKETJS_TEST_PROPERTY_FILE: propertyFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toEqual(["1", "0"]);
    expect(
      existsSync(join(localRoot, "run", "usb-mode-before-pocketjs")),
    ).toBe(false);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain(
      "original USB Mass Storage mode restored",
    );
  });

  test("refuses Mass Storage while a PocketJS runtime still owns userstore", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const modeCalled = join(fixture, "mode-called");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "424242", "fd"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(runtime, "fixture runtime");
    symlinkSync(runtime, join(procRoot, "424242", "exe"));
    symlinkSync(tmpRoot, join(procRoot, "424242", "cwd"));
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeMode,
      `#!/bin/sh\nprintf called >${JSON.stringify(modeCalled)}\n`,
    );
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain(
      "refusing USB Mass Storage while pid 424242 has executable",
    );
    expect(existsSync(modeCalled)).toBe(false);
    expect(
      readFileSync(
        join(localRoot, "run", "usb-mode-before-pocketjs"),
        "utf8",
      ),
    ).toBe("mass-storage\n");
  });

  test("refuses Mass Storage while a log follower retains a PocketJS file", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const runtimeLog = join(devRoot, "logs", "runtime.log");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "5050", "fd"), { recursive: true });
    mkdirSync(join(devRoot, "logs"), { recursive: true });
    writeFileSync(runtimeLog, "fixture log");
    symlinkSync("/bin/sh", join(procRoot, "5050", "exe"));
    symlinkSync(tmpRoot, join(procRoot, "5050", "cwd"));
    symlinkSync(runtimeLog, join(procRoot, "5050", "fd", "3"));
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(fakeMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain(
      "pid 5050 has open fd under",
    );
    expect(
      existsSync(join(localRoot, "run", "usb-mode-before-pocketjs")),
    ).toBe(true);
  });

  test("treats the Kindle base-us mount as a userstore alias", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const userstore = join(fixture, "mnt-us");
    const baseUserstore = join(fixture, "mnt-base-us");
    const heldBook = join(baseUserstore, "documents", "held.azw3");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "8080", "fd"), { recursive: true });
    mkdirSync(join(baseUserstore, "documents"), { recursive: true });
    mkdirSync(userstore, { recursive: true });
    writeFileSync(heldBook, "fixture");
    symlinkSync("/bin/sh", join(procRoot, "8080", "exe"));
    symlinkSync(tmpRoot, join(procRoot, "8080", "cwd"));
    symlinkSync(heldBook, join(procRoot, "8080", "fd", "4"));
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(fakeMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: userstore,
        POCKETJS_USERSTORE_ALIAS_ROOT: baseUserstore,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const usbLog = readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8");
    expect(usbLog).toContain("pid 8080 has open fd under");
    expect(usbLog).toContain(heldBook);
  });

  test("refuses Mass Storage while a process retains a userstore memory map", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const mappedAsset = join(devRoot, "current", "app.pak");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "8181", "fd"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(mappedAsset, "fixture");
    symlinkSync("/bin/sh", join(procRoot, "8181", "exe"));
    symlinkSync(tmpRoot, join(procRoot, "8181", "cwd"));
    writeFileSync(
      join(procRoot, "8181", "maps"),
      `00010000-00020000 r--p 00000000 00:00 0 ${mappedAsset}\n`,
    );
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(fakeMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    const usbLog = readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8");
    expect(usbLog).toContain("pid 8181 has memory map under");
    expect(usbLog).toContain(mappedAsset);
  });

  test("holds an export gate and refuses Mass Storage while a runtime generation is active", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const launchLock = join(controlRoot, "runtime-launch.lock");
    const exportLock = join(controlRoot, "userstore-export.lock");
    const modeCalled = join(fixture, "mode-called");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(launchLock, { recursive: true });
    writeFileSync(join(launchLock, "owner"), `${process.pid}\n`);
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeMode,
      `#!/bin/sh\nprintf called >${JSON.stringify(modeCalled)}\n`,
    );
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
        POCKETJS_LAUNCH_LOCK_WAIT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain("runtime launch generation is still active");
    expect(existsSync(modeCalled)).toBe(false);
    expect(existsSync(exportLock)).toBe(false);
    expect(existsSync(launchLock)).toBe(true);
    expect(
      readFileSync(
        join(localRoot, "run", "usb-mode-before-pocketjs"),
        "utf8",
      ),
    ).toBe("mass-storage\n");
  });

  test("serializes USB export with an active runtime stop generation", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const stopLock = join(controlRoot, "runtime-stop.lock");
    const exportLock = join(controlRoot, "userstore-export.lock");
    const modeCalled = join(fixture, "mode-called");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(stopLock, { recursive: true });
    writeFileSync(join(stopLock, "owner"), `${process.pid}\n`);
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeMode,
      `#!/bin/sh\nprintf called >${JSON.stringify(modeCalled)}\n`,
    );
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain("a runtime stop or interrupted stop is active");
    expect(existsSync(modeCalled)).toBe(false);
    expect(existsSync(exportLock)).toBe(false);
    expect(existsSync(stopLock)).toBe(true);
  });

  test("refuses USB export while Kindle UI recovery is still pending", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const uiState = join(devRoot, "run", "runtime-ui-stopped");
    const modeCalled = join(fixture, "mode-called");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(uiState, "KPPMainAppV2 99 456\n");
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeMode,
      `#!/bin/sh\nprintf called >${JSON.stringify(modeCalled)}\n`,
    );
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain("Kindle UI recovery is still pending");
    expect(existsSync(modeCalled)).toBe(false);
    expect(existsSync(uiState)).toBe(true);
    expect(existsSync(join(controlRoot, "userstore-export.lock"))).toBe(false);
    expect(existsSync(join(controlRoot, "runtime-stop.lock"))).toBe(false);
    expect(existsSync(join(controlRoot, "runtime-launch.lock"))).toBe(false);
  });

  test("refuses USB export while Kindle powerd recovery is still pending", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const powerdState = join(devRoot, "run", "runtime-powerd-state");
    const modeCalled = join(fixture, "mode-called");
    mkdirSync(join(localRoot, "run"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(powerdState, "preventScreenSaver=0\n");
    writeFileSync(
      join(localRoot, "run", "usb-mode-before-pocketjs"),
      "mass-storage\n",
    );
    const fakeMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeMode,
      `#!/bin/sh\nprintf called >${JSON.stringify(modeCalled)}\n`,
    );
    chmodSync(fakeMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "usbnet-stop.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USB_INTERFACE_PATH: join(fixture, "usb0"),
        POCKETJS_USB_MODE: fakeMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(
      readFileSync(join(localRoot, "logs", "usbnetwork.log"), "utf8"),
    ).toContain("Kindle powerd recovery is still pending");
    expect(existsSync(modeCalled)).toBe(false);
    expect(existsSync(powerdState)).toBe(true);
    expect(existsSync(join(controlRoot, "userstore-export.lock"))).toBe(false);
    expect(existsSync(join(controlRoot, "runtime-stop.lock"))).toBe(false);
    expect(existsSync(join(controlRoot, "runtime-launch.lock"))).toBe(false);
  });

  test("keeps runtime identity and UI state when SIGKILL cannot stop it", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const identityRuntime = join(devRoot, "current", "pocketjs-kindle");
    const runtime = join(devRoot, "previous", "pocketjs-kindle");
    const runDirectory = join(devRoot, "run");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "424242"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    mkdirSync(join(devRoot, "previous"), { recursive: true });
    writeFileSync(identityRuntime, "fixture original path");
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(runtime, "fixture runtime");
    writeFileSync(join(procRoot, "424242", "comm"), "pocketjs-kindle\n");
    writeFileSync(
      join(procRoot, "424242", "stat"),
      ["424242", "(pocketjs-kindle)", "S", ...Array(18).fill("0"), "123"].join(
        " ",
      ),
    );
    symlinkSync(runtime, join(procRoot, "424242", "exe"));
    writeFileSync(join(runDirectory, "runtime.pid"), "424242\n");
    writeFileSync(
      join(runDirectory, "runtime.identity"),
      `pid=424242\nstarttime=123\nbinary=${identityRuntime}\n`,
    );
    writeFileSync(
      join(runDirectory, "runtime-ui-stopped"),
      "KPPMainAppV2 99 456\n",
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_TERM_WAIT: "0",
        POCKETJS_RUNTIME_KILL_WAIT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "runtime survived SIGKILL; keeping identity and UI/power recovery state",
    );
    expect(existsSync(join(runDirectory, "runtime.pid"))).toBe(true);
    expect(existsSync(join(runDirectory, "runtime.identity"))).toBe(true);
    expect(existsSync(join(runDirectory, "runtime-ui-stopped"))).toBe(true);
  });

  test("refuses a live runtime PID with mismatched durable identity", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const expectedRuntime = join(devRoot, "current", "pocketjs-kindle");
    const unrelated = join(fixture, "unrelated-process");
    const runDirectory = join(devRoot, "run");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "31337"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(expectedRuntime, "fixture runtime");
    writeFileSync(unrelated, "unrelated");
    writeFileSync(
      join(procRoot, "31337", "stat"),
      ["31337", "(unrelated)", "S", ...Array(18).fill("0"), "999"].join(" "),
    );
    symlinkSync(unrelated, join(procRoot, "31337", "exe"));
    writeFileSync(join(runDirectory, "runtime.pid"), "31337\n");
    writeFileSync(
      join(runDirectory, "runtime.identity"),
      `pid=31337\nstarttime=123\nbinary=${expectedRuntime}\n`,
    );

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "runtime PID identity mismatch; refusing to signal pid 31337",
    );
    expect(existsSync(join(runDirectory, "runtime.pid"))).toBe(true);
    expect(existsSync(join(runDirectory, "runtime.identity"))).toBe(true);
  });

  test("does not resume the Kindle UI when a live runtime lost its pid file", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const uiState = join(devRoot, "run", "runtime-ui-stopped");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "606060"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(runtime, "fixture runtime");
    symlinkSync(runtime, join(procRoot, "606060", "exe"));
    writeFileSync(uiState, "KPPMainAppV2 99 456\n");

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "runtime pid file is missing but a PocketJS runtime is active",
    );
    expect(existsSync(uiState)).toBe(true);
  });

  test("keeps UI recovery state when SIGCONT cannot be verified", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const controlRoot = join(fixture, "control");
    const uiState = join(devRoot, "run", "runtime-ui-stopped");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "909090"), { recursive: true });
    writeFileSync(join(procRoot, "909090", "comm"), "KPPMainAppV2\n");
    writeFileSync(
      join(procRoot, "909090", "stat"),
      ["909090", "(KPPMainAppV2)", "T", ...Array(18).fill("0"), "777"].join(
        " ",
      ),
    );
    symlinkSync("/bin/sh", join(procRoot, "909090", "exe"));
    writeFileSync(uiState, "KPPMainAppV2 909090 777\n");

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_UI_RESUME_WAIT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "Kindle UI resume could not be verified; keeping recovery state",
    );
    expect(existsSync(uiState)).toBe(true);
  });

  test("restores the original preventScreenSaver value when runtime launch aborts", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const powerd = fakePowerd({ preventScreenSaver: "0", state: "active" });
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(powerd.fixture, "tmp");
    const procRoot = join(powerd.fixture, "proc");
    const controlRoot = join(powerd.fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const runtimeCalled = join(powerd.fixture, "runtime-called");
    const fbinkLockObservation = join(
      powerd.fixture,
      "fbink-lock-observation",
    );
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(
      runtime,
      `#!/bin/sh\nprintf called >${JSON.stringify(runtimeCalled)}\n`,
    );
    chmodSync(runtime, 0o755);
    writeFileSync(
      join(devRoot, "bin", "fbink"),
      [
        "#!/bin/sh",
        'if [ -f "$POCKETJS_CONTROL_ROOT/runtime-launch.lock/owner" ]; then',
        '  printf "held\\n" >"$POCKETJS_TEST_FBINK_LOCK_OBSERVATION"',
        "else",
        '  printf "released\\n" >"$POCKETJS_TEST_FBINK_LOCK_OBSERVATION"',
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(join(devRoot, "bin", "fbink"), 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...powerd.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
        POCKETJS_TEST_FBINK_LOCK_OBSERVATION: fbinkLockObservation,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(powerd.preventFile, "utf8")).toBe("0\n");
    expect(
      existsSync(join(devRoot, "run", "runtime-powerd-state")),
    ).toBe(false);
    expect(readFileSync(fbinkLockObservation, "utf8")).toBe("held\n");
    expect(existsSync(runtimeCalled)).toBe(false);
    const powerdCalls = readFileSync(powerd.callLog, "utf8");
    expect(powerdCalls).toContain(
      "set -i -- com.lab126.powerd preventScreenSaver 1",
    );
    expect(powerdCalls).toContain(
      "set -i -- com.lab126.powerd preventScreenSaver 0",
    );
    expect(powerdCalls).toContain("get -e -- com.lab126.powerd state");
    expect(powerdCalls).not.toContain(
      "get -i -e -- com.lab126.powerd state",
    );
  });

  test("refuses an already sleeping Kindle without synthesizing a power-button event", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const powerd = fakePowerd({
      preventScreenSaver: "0",
      state: "screenSaver",
    });
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(powerd.fixture, "tmp");
    const procRoot = join(powerd.fixture, "proc");
    const controlRoot = join(powerd.fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const uiState = join(devRoot, "run", "runtime-ui-stopped");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(procRoot, "909090"), { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(join(procRoot, "909090", "comm"), "KPPMainAppV2\n");
    writeFileSync(
      join(procRoot, "909090", "stat"),
      ["909090", "(KPPMainAppV2)", "S", ...Array(18).fill("0"), "777"].join(
        " ",
      ),
    );
    writeFileSync(uiState, "KPPMainAppV2 909090 777\n");
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    chmodSync(runtime, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...powerd.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(powerd.preventFile, "utf8")).toBe("0\n");
    expect(existsSync(uiState)).toBe(false);
    expect(
      existsSync(join(devRoot, "run", "runtime-powerd-state")),
    ).toBe(false);
    expect(
      readFileSync(join(devRoot, "logs", "runtime.log"), "utf8"),
    ).toContain(
      "already in screenSaver state; wake it with the physical power button",
    );
    const powerdCalls = readFileSync(powerd.callLog, "utf8");
    expect(powerdCalls).toContain("get -e -- com.lab126.powerd state");
    expect(powerdCalls).not.toContain(
      "get -i -e -- com.lab126.powerd state",
    );
    expect(powerdCalls).not.toContain("powerButton");
  });

  test("fails closed for a non-active transitional powerd state", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const powerd = fakePowerd({
      preventScreenSaver: "0",
      state: "readyToSuspend",
    });
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(powerd.fixture, "tmp");
    const procRoot = join(powerd.fixture, "proc");
    const controlRoot = join(powerd.fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    chmodSync(runtime, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...powerd.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(powerd.preventFile, "utf8")).toBe("0\n");
    expect(
      existsSync(join(devRoot, "run", "runtime-powerd-state")),
    ).toBe(false);
    expect(
      readFileSync(join(devRoot, "logs", "runtime.log"), "utf8"),
    ).toContain(
      "powerd is not active (state readyToSuspend); refusing to start",
    );
  });

  test("fails closed and rolls back a preventScreenSaver read-back mismatch", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const powerd = fakePowerd({
      preventScreenSaver: "0",
      state: "active",
      ignoreSet: true,
    });
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(powerd.fixture, "tmp");
    const procRoot = join(powerd.fixture, "proc");
    const controlRoot = join(powerd.fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    chmodSync(runtime, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...powerd.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(powerd.preventFile, "utf8")).toBe("0\n");
    expect(
      existsSync(join(devRoot, "run", "runtime-powerd-state")),
    ).toBe(false);
    expect(
      readFileSync(join(devRoot, "logs", "runtime.log"), "utf8"),
    ).toContain("preventScreenSaver read-back mismatch");
  });

  test("guarded stop recovers a durable preventScreenSaver override", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const powerd = fakePowerd({ preventScreenSaver: "1", state: "active" });
    const devRoot = join(volume, "pocketjs-dev");
    const tmpRoot = join(powerd.fixture, "tmp");
    const procRoot = join(powerd.fixture, "proc");
    const controlRoot = join(powerd.fixture, "control");
    const powerdState = join(devRoot, "run", "runtime-powerd-state");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(powerdState, "preventScreenSaver=0\n");

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-runtime.sh")],
      env: {
        ...powerd.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(readFileSync(powerd.preventFile, "utf8")).toBe("0\n");
    expect(existsSync(powerdState)).toBe(false);
    expect(result.stdout.toString()).toContain(
      "restored preventScreenSaver=0",
    );
  });

  test("runtime launcher yields to an active stop-generation gate", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const devRoot = join(volume, "pocketjs-dev");
    const fixture = temporaryRoot();
    const tmpRoot = join(fixture, "tmp");
    const controlRoot = join(fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const stopLock = join(controlRoot, "runtime-stop.lock");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    mkdirSync(stopLock, { recursive: true });
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    chmodSync(runtime, 0o755);
    writeFileSync(join(stopLock, "owner"), `${process.pid}\n`);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(
      "a runtime stop/export operation is active; refusing a new launch",
    );
    expect(existsSync(join(devRoot, "run", "runtime.pid"))).toBe(false);
  });

  test("runtime launcher yields to an active userstore export gate", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const devRoot = join(volume, "pocketjs-dev");
    const fixture = temporaryRoot();
    const tmpRoot = join(fixture, "tmp");
    const controlRoot = join(fixture, "control");
    const runtime = join(devRoot, "current", "pocketjs-kindle");
    const exportLock = join(controlRoot, "userstore-export.lock");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(join(devRoot, "current"), { recursive: true });
    mkdirSync(exportLock, { recursive: true });
    writeFileSync(runtime, "#!/bin/sh\nexit 0\n");
    chmodSync(runtime, 0o755);
    writeFileSync(join(exportLock, "owner"), `${process.pid}\n`);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "run-runtime.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_CONTROL_ROOT: controlRoot,
        POCKETJS_RUNTIME_BIN: runtime,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain(
      "a runtime stop/export operation is active; refusing a new launch",
    );
    expect(existsSync(join(controlRoot, "runtime-launch.lock"))).toBe(false);
    expect(existsSync(join(devRoot, "run", "runtime.pid"))).toBe(false);
  });

  test("blocks USB restore when a captured Dropbear shell descendant survives", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const listenerPid = "424240";
    const childPid = "424241";
    const listenerProc = join(procRoot, listenerPid);
    const childProc = join(procRoot, childPid);
    const usbStopCalled = join(fixture, "usb-stop-called");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(listenerProc, { recursive: true });
    mkdirSync(childProc, { recursive: true });
    const procStat = (pid: string, name: string, ppid: string, start: string) =>
      [pid, `(${name})`, "T", ppid, ...Array(17).fill("0"), start].join(" ");
    writeFileSync(
      join(listenerProc, "stat"),
      procStat(listenerPid, "drop bear ) tricky", "1", "1000"),
    );
    writeFileSync(join(listenerProc, "status"), "Name:\tdropbear\nPPid:\t1\n");
    writeFileSync(join(listenerProc, "environ"), "");
    symlinkSync(join(devRoot, "bin", "dropbear"), join(listenerProc, "exe"));
    writeFileSync(
      join(childProc, "stat"),
      procStat(childPid, "sh", "999999", "1001"),
    );
    writeFileSync(
      join(childProc, "status"),
      `Name:\tsh\nPPid:\t${listenerPid}\n`,
    );
    writeFileSync(join(childProc, "environ"), "");
    symlinkSync("/bin/sh", join(childProc, "exe"));

    const fakeStopRuntime = join(fixture, "stop-runtime.sh");
    const fakeUsbStop = join(fixture, "usbnet-stop.sh");
    const fakeUsbMode = join(fixture, "usb-mode.sh");
    const fakeSignal = join(fixture, "signal.sh");
    writeFileSync(fakeStopRuntime, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      fakeUsbStop,
      `#!/bin/sh\nprintf called >${JSON.stringify(usbStopCalled)}\n`,
    );
    writeFileSync(fakeUsbMode, "#!/bin/sh\nexit 0\n");
    writeFileSync(
      fakeSignal,
      [
        "#!/bin/sh",
        `if [ "$1" = "-TERM" ] && [ "$2" = "${listenerPid}" ]; then`,
        '  rm -f "$POCKETJS_TEST_PROC_ROOT/$2/exe" "$POCKETJS_TEST_PROC_ROOT/$2/stat" "$POCKETJS_TEST_PROC_ROOT/$2/status" "$POCKETJS_TEST_PROC_ROOT/$2/environ"',
        '  rmdir "$POCKETJS_TEST_PROC_ROOT/$2"',
        "fi",
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fakeStopRuntime, 0o755);
    chmodSync(fakeUsbStop, 0o755);
    chmodSync(fakeUsbMode, 0o755);
    chmodSync(fakeSignal, 0o755);
    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "stop-ssh.sh")],
      env: {
        ...process.env,
        SSH_CONNECTION: "",
        SSH_CLIENT: "",
        SSH_TTY: "",
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_STOP_RUNTIME: fakeStopRuntime,
        POCKETJS_USBNET_STOP: fakeUsbStop,
        POCKETJS_USB_MODE: fakeUsbMode,
        POCKETJS_DROPBEAR_TERM_WAIT: "1",
        POCKETJS_DROPBEAR_KILL_WAIT: "0",
        POCKETJS_DROPBEAR_FREEZE_WAIT: "0",
        POCKETJS_SSH_STOP_FOREGROUND: "1",
        POCKETJS_SIGNAL_COMMAND: fakeSignal,
        POCKETJS_TEST_PROC_ROOT: procRoot,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "PocketJS Dropbear process survived SIGKILL",
    );
    expect(existsSync(usbStopCalled)).toBe(false);
  });

  test("detaches Stop USB SSH from the KUAL launcher before safety checks", async () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const usbStopCalled = join(fixture, "usb-stop-called");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });

    const fakeStopRuntime = join(fixture, "stop-runtime.sh");
    const fakeUsbStop = join(fixture, "usbnet-stop.sh");
    const fakeUsbMode = join(fixture, "usb-mode.sh");
    writeFileSync(fakeStopRuntime, "#!/bin/sh\nsleep 1\nexit 0\n");
    writeFileSync(
      fakeUsbStop,
      `#!/bin/sh\nprintf called >${JSON.stringify(usbStopCalled)}\n`,
    );
    writeFileSync(fakeUsbMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeStopRuntime, 0o755);
    chmodSync(fakeUsbStop, 0o755);
    chmodSync(fakeUsbMode, 0o755);

    const result = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-c",
        [
          'mkdir -p "$POCKETJS_PROC_ROOT/$$" || exit 1',
          `printf '%s (KUAL launcher) Z 1 ${Array(17).fill("0").join(" ")} 777\\n' "$$" >"$POCKETJS_PROC_ROOT/$$/stat"`,
          'exec /bin/sh "$POCKETJS_TEST_STOP_SSH"',
        ].join("\n"),
      ],
      env: {
        ...process.env,
        SSH_CONNECTION: "",
        SSH_CLIENT: "",
        SSH_TTY: "",
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_STOP_RUNTIME: fakeStopRuntime,
        POCKETJS_USBNET_STOP: fakeUsbStop,
        POCKETJS_USB_MODE: fakeUsbMode,
        POCKETJS_TEST_STOP_SSH: join(devRoot, "stop-ssh.sh"),
        POCKETJS_DROPBEAR_TERM_WAIT: "0",
        POCKETJS_DROPBEAR_KILL_WAIT: "0",
        POCKETJS_DROPBEAR_FREEZE_WAIT: "0",
        POCKETJS_SSH_STOP_LAUNCHER_WAIT: "5",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("SSH stop worker started");
    expect(existsSync(usbStopCalled)).toBe(false);
    for (let attempt = 0; attempt < 100 && !existsSync(usbStopCalled); attempt += 1) {
      await Bun.sleep(25);
    }
    expect(existsSync(usbStopCalled)).toBe(true);
    expect(
      readFileSync(join(localRoot, "logs", "dropbear-stop.log"), "utf8"),
    ).toContain("Stopping PocketJS Dropbear");
  });

  test("detaches Start SSH before the USBNetwork helper can roll back", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const selfFdRoot = join(fixture, "self-fd");
    const fdReport = join(fixture, "fd-report");
    const kualInput = join(volume, "kual-input");
    const kualLog = join(volume, "KUAL.log");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    mkdirSync(selfFdRoot, { recursive: true });
    writeFileSync(kualInput, "still attached\n");
    writeFileSync(kualLog, "");
    symlinkSync(kualLog, join(selfFdRoot, "9"));

    const fakeUsbStart = join(fixture, "usbnet-start.sh");
    const fakeUsbStop = join(fixture, "usbnet-stop.sh");
    const fakeUsbMode = join(fixture, "usb-mode.sh");
    writeFileSync(
      fakeUsbStart,
      [
        "#!/bin/sh",
        'if (printf unexpected >&9) 2>/dev/null; then',
        '  printf "fd9=open\\n" >"$POCKETJS_TEST_FD_REPORT"',
        "else",
        '  printf "fd9=closed\\n" >"$POCKETJS_TEST_FD_REPORT"',
        "fi",
        "if IFS= read -r pocketjs_attached_line; then",
        '  printf "fd0=data:%s\\n" "$pocketjs_attached_line" >>"$POCKETJS_TEST_FD_REPORT"',
        "else",
        '  printf "fd0=eof\\n" >>"$POCKETJS_TEST_FD_REPORT"',
        "fi",
        'printf "usb-helper-stdout\\n"',
        'printf "usb-helper-stderr\\n" >&2',
        "exit 1",
        "",
      ].join("\n"),
    );
    writeFileSync(fakeUsbStop, "#!/bin/sh\nexit 0\n");
    writeFileSync(fakeUsbMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeUsbStart, 0o755);
    chmodSync(fakeUsbStop, 0o755);
    chmodSync(fakeUsbMode, 0o755);

    const result = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-c",
        [
          'exec 0<"$POCKETJS_TEST_KUAL_INPUT"',
          'exec 9>"$POCKETJS_TEST_KUAL_LOG"',
          'exec /bin/sh "$POCKETJS_TEST_START_SSH"',
        ].join("\n"),
      ],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_SELF_FD_ROOT: selfFdRoot,
        POCKETJS_USERSTORE_ROOT: volume,
        POCKETJS_USBNET_START: fakeUsbStart,
        POCKETJS_USBNET_STOP: fakeUsbStop,
        POCKETJS_USB_MODE: fakeUsbMode,
        POCKETJS_TEST_START_SSH: join(devRoot, "start-ssh.sh"),
        POCKETJS_TEST_KUAL_INPUT: kualInput,
        POCKETJS_TEST_KUAL_LOG: kualLog,
        POCKETJS_TEST_FD_REPORT: fdReport,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(readFileSync(fdReport, "utf8")).toBe("fd9=closed\nfd0=eof\n");
    expect(readFileSync(kualLog, "utf8")).toBe("");
    const dropbearLog = readFileSync(
      join(localRoot, "logs", "dropbear.log"),
      "utf8",
    );
    expect(dropbearLog).toContain("usb-helper-stdout");
    expect(dropbearLog).toContain("usb-helper-stderr");
    expect(dropbearLog).toContain("USBNetwork could not be enabled");
  });

  test("rotates the durable Dropbear log before a failed USBNetwork start", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const fixture = temporaryRoot();
    const devRoot = join(volume, "pocketjs-dev");
    const localRoot = join(fixture, "var-local");
    const tmpRoot = join(fixture, "tmp");
    const procRoot = join(fixture, "proc");
    const logFile = join(localRoot, "logs", "dropbear.log");
    mkdirSync(join(localRoot, "logs"), { recursive: true });
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(procRoot, { recursive: true });
    writeFileSync(logFile, "x".repeat(1048577));

    const fakeUsbStart = join(fixture, "usbnet-start.sh");
    const fakeUsbStop = join(fixture, "usbnet-stop.sh");
    const fakeUsbMode = join(fixture, "usb-mode.sh");
    writeFileSync(fakeUsbStart, "#!/bin/sh\nexit 1\n");
    writeFileSync(fakeUsbStop, "#!/bin/sh\nexit 0\n");
    writeFileSync(fakeUsbMode, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeUsbStart, 0o755);
    chmodSync(fakeUsbStop, 0o755);
    chmodSync(fakeUsbMode, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(devRoot, "start-ssh.sh")],
      env: {
        ...process.env,
        POCKETJS_DEV_ROOT: devRoot,
        POCKETJS_LOCAL_ROOT: localRoot,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_PROC_ROOT: procRoot,
        POCKETJS_USBNET_START: fakeUsbStart,
        POCKETJS_USBNET_STOP: fakeUsbStop,
        POCKETJS_USB_MODE: fakeUsbMode,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(statSync(logFile).size).toBeGreaterThanOrEqual(524288);
    expect(statSync(logFile).size).toBeLessThan(525000);
    expect(readFileSync(logFile, "utf8")).toContain(
      "USBNetwork could not be enabled",
    );
  });

  test("requires Stop USB SSH to be launched locally", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(volume, "pocketjs-dev", "stop-ssh.sh")],
      env: {
        ...process.env,
        SSH_CONNECTION: "192.168.15.201 50000 192.168.15.244 2222",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "must be launched locally from KUAL or the Kindle Library",
    );
  });

  test("refuses USB gadget changes without root elevation", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const fakeBin = join(temporaryRoot(), "bin");
    mkdirSync(fakeBin, { recursive: true });
    const id = join(fakeBin, "id");
    writeFileSync(id, "#!/bin/sh\nprintf '1000\\n'\n");
    chmodSync(id, 0o755);

    const result = Bun.spawnSync({
      cmd: ["/bin/sh", join(volume, "pocketjs-dev", "usb-mode.sh"), "network"],
      env: {
        ...process.env,
        POCKETJS_SYSTEM_PATH: `${fakeBin}:/usr/bin:/bin`,
        POCKETJS_USB_INTERFACE_PATH: join(temporaryRoot(), "usb0"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("requires root");
  });

  test("refuses a precreated tmpfs symlink instead of overwriting through it", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const fixture = temporaryRoot();
    const tmpRoot = join(fixture, "tmp");
    const victim = join(fixture, "victim");
    const victimScript = join(victim, "usb-mode.sh");
    mkdirSync(tmpRoot, { recursive: true });
    mkdirSync(victim, { recursive: true });
    writeFileSync(victimScript, "do not overwrite\n");

    const result = Bun.spawnSync({
      cmd: [
        "/bin/sh",
        "-c",
        [
          'ln -s "$POCKETJS_TEST_VICTIM" "$POCKETJS_TMP_ROOT/pocketjs-usb-mode.$$" || exit 1',
          'exec /bin/sh "$POCKETJS_TEST_USB_MODE" mass-storage',
        ].join("\n"),
      ],
      env: {
        ...process.env,
        POCKETJS_TMP_ROOT: tmpRoot,
        POCKETJS_TEST_VICTIM: victim,
        POCKETJS_TEST_USB_MODE: join(volume, "pocketjs-dev", "usb-mode.sh"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      "could not exclusively create USB mode tmpfs directory",
    );
    expect(readFileSync(victimScript, "utf8")).toBe("do not overwrite\n");
  });

  test("invalidates the old receipt before an interrupted managed-file update", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });
    const receiptPath = join(volume, "pocketjs-dev", ".pocketjs-bootstrap.json");
    expect(existsSync(receiptPath)).toBe(true);

    const originalRandom = Math.random;
    const collisionPath = join(
      volume,
      "pocketjs-dev",
      `.start-ssh.sh.pocketjs-${process.pid}-8`,
    );
    writeFileSync(collisionPath, "leave this collision in place");
    Math.random = () => 0.5;
    try {
      expect(() => stageKindleVolume(volume, payload(), { sshPort: 22022 })).toThrow();
    } finally {
      Math.random = originalRandom;
    }

    expect(existsSync(receiptPath)).toBe(false);
    expect(readFileSync(collisionPath, "utf8")).toBe("leave this collision in place");
    unlinkSync(collisionPath);

    stageKindleVolume(volume, payload(), { sshPort: 22022 });
    const committed = JSON.parse(readFileSync(receiptPath, "utf8"));
    expect(committed.ssh.port).toBe(22022);
    expect(committed.managedFiles).toBeArray();
  });

  test("gates every device signal on durable process identity", () => {
    const volume = kindleVolume();
    stageKindleVolume(volume, payload(), { sshPort: 2222 });

    const runtime = readFileSync(
      join(volume, "pocketjs-dev", "run-runtime.sh"),
      "utf8",
    );
    const persistUiCall = runtime.indexOf(
      'persist_ui_identity "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"',
    );
    const stopUiCall = runtime.indexOf('kill -STOP "$pocketjs_pid"');
    expect(persistUiCall).toBeGreaterThan(-1);
    expect(stopUiCall).toBeGreaterThan(persistUiCall);
    expect(runtime).toContain('mv -f "$pocketjs_identity_tmp" "$POCKETJS_UI_STATE"');
    expect(runtime).toContain("sync >/dev/null 2>&1");
    expect(runtime).toContain(
      'ui_process_matches "$pocketjs_name" "$pocketjs_pid" "$pocketjs_starttime"',
    );
    const afterUiStop = runtime.slice(stopUiCall);
    expect(afterUiStop.indexOf('kill -CONT "$pocketjs_pid"')).toBeLessThan(
      afterUiStop.indexOf('log "could not verify stopped Kindle UI identity'),
    );

    const usbnetStart = readFileSync(
      join(volume, "pocketjs-dev", "usbnet-start.sh"),
      "utf8",
    );
    expect(usbnetStart).toContain(
      'fail_with_rollback "firmware USBNetwork switch failed"',
    );
    expect(usbnetStart).toContain(
      'fail_with_rollback "ifconfig is unavailable; cannot configure usb0"',
    );
    expect(usbnetStart).toContain(
      'fail_with_rollback "failed to configure usb0 as $POCKETJS_KINDLE_IP"',
    );
    expect(usbnetStart).toContain(
      'POCKETJS_USB_STATE="$POCKETJS_LOCAL_ROOT/run/usb-mode-before-pocketjs"',
    );
    expect(usbnetStart).toContain(
      'POCKETJS_USB_LOG="$POCKETJS_LOCAL_ROOT/logs/usbnetwork.log"',
    );
    const rollbackHelper = usbnetStart.indexOf('sh "$POCKETJS_USBNET_STOP"');
    expect(rollbackHelper).toBeGreaterThan(-1);
    expect(usbnetStart).not.toContain('sh "$POCKETJS_USB_MODE" mass-storage');
    expect(usbnetStart.indexOf("exec </dev/null")).toBeLessThan(rollbackHelper);
    const usbnetStop = readFileSync(
      join(volume, "pocketjs-dev", "usbnet-stop.sh"),
      "utf8",
    );
    const stopGuard = usbnetStop.indexOf(
      "if ! assert_userstore_quiescent",
    );
    const stopSync = usbnetStop.lastIndexOf("sync >/dev/null 2>&1");
    const stopGuardAfterSync = usbnetStop.indexOf(
      "if ! assert_userstore_quiescent",
      stopSync,
    );
    const stopUsbHelper = usbnetStop.lastIndexOf(
      'sh "$POCKETJS_USB_MODE" mass-storage',
    );
    const stopVerifyUsb0Gone = usbnetStop.indexOf(
      "if usb_network_present; then",
      stopUsbHelper,
    );
    const stopClearUsbState = usbnetStop.indexOf(
      'rm -f "$POCKETJS_USB_STATE"',
      stopVerifyUsb0Gone,
    );
    expect(stopGuard).toBeGreaterThan(-1);
    expect(stopSync).toBeGreaterThan(stopGuard);
    expect(stopGuardAfterSync).toBeGreaterThan(stopSync);
    expect(stopUsbHelper).toBeGreaterThan(stopGuardAfterSync);
    expect(stopUsbHelper).toBeGreaterThan(-1);
    expect(stopVerifyUsb0Gone).toBeGreaterThan(stopUsbHelper);
    expect(stopClearUsbState).toBeGreaterThan(stopVerifyUsb0Gone);
    expect(usbnetStop).toContain(
      "USB Mass Storage restore did not complete; keeping recovery state",
    );
    expect(usbnetStop).toContain(
      'POCKETJS_USB_STATE="$POCKETJS_LOCAL_ROOT/run/usb-mode-before-pocketjs"',
    );
    expect(usbnetStop).toContain(
      '"$POCKETJS_PROC_ROOT"/[0-9]*',
    );
    expect(usbnetStop).toContain(
      '"$pocketjs_proc_dir"/fd/*',
    );

    const usbMode = readFileSync(
      join(volume, "pocketjs-dev", "usb-mode.sh"),
      "utf8",
    );
    expect(usbMode).toContain("lipc-set-prop -i --");
    expect(usbMode).toContain(
      'com.lab126.volumd useUsbForNetwork "$pocketjs_target_value"',
    );
    expect(usbMode).toContain(
      "lipc-send-event -r 3 -d 2 com.lab126.hal usbUnconfigured",
    );
    expect(usbMode).toContain(
      "lipc-send-event -r 3 -d 2 com.lab126.hal usbPlugOut",
    );
    expect(usbMode).toContain("if ! target_mode_present; then");
    expect(usbMode).toContain(
      '[ "$pocketjs_target_value" -eq 1 ] && target_mode_present',
    );
    expect(usbMode).toContain("POCKETJS_USB_MODE_REEXEC");

    const startSsh = readFileSync(
      join(volume, "pocketjs-dev", "start-ssh.sh"),
      "utf8",
    );
    expect(startSsh).toContain(
      'POCKETJS_IDENTITY_FILE="$POCKETJS_LOCAL_ROOT/run/dropbear.identity"',
    );
    expect(startSsh).toContain("persist_dropbear_identity");
    expect(startSsh).toContain('name=dropbear\\n');
    expect(startSsh).toContain(
      'dropbear_process_matches "$pocketjs_identity_pid" "$pocketjs_identity_starttime"',
    );
    expect(startSsh).toContain(
      '"$POCKETJS_DROPBEAR"|"$POCKETJS_DROPBEAR (deleted)"',
    );
    expect(startSsh).toContain("rollback_usbnet_on_failure");
    expect(startSsh).toContain(
      'if ! sh "$POCKETJS_USBNET_STOP"; then',
    );
    expect(startSsh).toContain("terminate_all_pocketjs_dropbear");
    expect(startSsh).toContain(
      "an untracked PocketJS Dropbear process is already running",
    );
    expect(startSsh).toContain("sed -n '1{s/^.*) //;p;}'");
    expect(startSsh).toContain("awk '{ print $20 }'");
    expect(startSsh).toContain(
      "pocketjs_scan_start_before=$(process_starttime",
    );
    expect(startSsh).toContain(
      '[ "$pocketjs_scan_start_before" = "$pocketjs_scan_start_after" ]',
    );
    expect(startSsh).toContain(
      'sed -n \'s/^PPid:[[:space:]]*//p\'',
    );
    expect(startSsh).toContain("freeze_pocketjs_dropbear_tree");
    expect(startSsh).toContain("final_dropbear_rescan_is_empty");
    expect(startSsh).toContain("pocketjs_usbnet_ready=0");
    expect(startSsh).toContain(
      'notify_system "PocketJS SSH failed: USBNetwork unavailable"',
    );
    expect(startSsh).toContain("detach_from_launcher_fds");
    expect(startSsh).toContain('exec </dev/null >>"$POCKETJS_LOG_FILE" 2>&1');
    expect(startSsh).toContain('"$pocketjs_self_fd_root/"[0-9]*');
    const detachBeforeUsbnet = startSsh.lastIndexOf(
      "detach_from_launcher_fds\npocketjs_detach_status=$?",
    );
    const startUsbnet = startSsh.indexOf('if ! sh "$POCKETJS_USBNET_START"; then');
    expect(detachBeforeUsbnet).toBeGreaterThan(-1);
    expect(startUsbnet).toBeGreaterThan(detachBeforeUsbnet);
    expect(startSsh).toContain(
      '[ "$pocketjs_log_size" -gt 1048576 ]',
    );
    expect(startSsh).toContain("tail -c 524288");
    const rollbackTrap = startSsh.indexOf(
      "trap 'rollback_usbnet_on_failure $?' EXIT",
    );
    const startDropbear = startSsh.lastIndexOf('"$POCKETJS_DROPBEAR" \\');
    expect(rollbackTrap).toBeGreaterThan(-1);
    expect(startDropbear).toBeGreaterThan(rollbackTrap);

    const stopSsh = readFileSync(
      join(volume, "pocketjs-dev", "stop-ssh.sh"),
      "utf8",
    );
    const stopRuntime = stopSsh.lastIndexOf('sh "$POCKETJS_STOP_RUNTIME"');
    const verifyDropbear = stopSsh.lastIndexOf("dropbear_binary_matches");
    const signalDropbear = stopSsh.indexOf(
      '"$POCKETJS_SIGNAL_COMMAND" "-$pocketjs_signal"',
    );
    const restoreUsb = stopSsh.lastIndexOf('exec sh "$POCKETJS_USBNET_STOP"');
    expect(stopRuntime).toBeGreaterThan(-1);
    expect(signalDropbear).toBeGreaterThan(verifyDropbear);
    expect(restoreUsb).toBeGreaterThan(signalDropbear);
    expect(stopSsh).toContain("terminate_all_pocketjs_dropbear");
    expect(stopSsh).toContain("must be launched locally from KUAL or the Kindle Library");
    expect(stopSsh).toContain("POCKETJS_SSH_STOP_REEXEC");
    expect(stopSsh).toContain(
      '"$POCKETJS_DROPBEAR"|"$POCKETJS_DROPBEAR (deleted)"',
    );
    expect(stopSsh).toContain("POCKETJS_SSH_STOP_FOREGROUND");
    expect(stopSsh).toContain("POCKETJS_SSH_STOP_DETACHED=1");
    expect(stopSsh).toContain("trap '' HUP");
    expect(stopSsh).toContain('exec </dev/null >>"$POCKETJS_STOP_LOG_FILE" 2>&1');
    expect(stopSsh).toContain('"$pocketjs_self_fd_root/"[0-9]*');
    expect(stopSsh).toContain("wait_for_detached_launcher_exit");
    expect(stopSsh).toContain("detached_launcher_identity_is_active");
    expect(stopSsh).toContain('!= "Z"');
    expect(stopSsh).toContain("freeze_pocketjs_dropbear_tree");
    expect(stopSsh).toContain("final_dropbear_rescan_is_empty");
    expect(stopSsh).toContain("continue_tracked_processes");

    const stopRuntimeScript = readFileSync(
      join(volume, "pocketjs-dev", "stop-runtime.sh"),
      "utf8",
    );
    const killRuntime = stopRuntimeScript.indexOf('kill -KILL "$pocketjs_pid"');
    const verifyAfterKill = stopRuntimeScript.indexOf(
      "runtime survived SIGKILL",
      killRuntime,
    );
    const clearRuntimeIdentity = stopRuntimeScript.indexOf(
      'rm -f "$POCKETJS_RUNTIME_PID_FILE" "$POCKETJS_RUNTIME_IDENTITY"',
      verifyAfterKill,
    );
    expect(killRuntime).toBeGreaterThan(-1);
    expect(verifyAfterKill).toBeGreaterThan(killRuntime);
    expect(clearRuntimeIdentity).toBeGreaterThan(verifyAfterKill);
  });

  test("rejects path traversal and non-MRPI payload paths", () => {
    expect(() => safeArchiveMemberPath("../escape")).toThrow("traversal");
    expect(() => safeArchiveMemberPath("extensions/../documents/escape")).toThrow("traversal");
    expect(() => safeArchiveMemberPath("/absolute")).toThrow("absolute");
    expect(() => safeArchiveMemberPath("extensions\\escape")).toThrow("unsafe");

    const volume = kindleVolume();
    const bad = {
      ...payload(),
      mrpiEntries: [
        {
          path: "documents/not-mrpi.sh",
          directory: false,
          mode: 0o755,
          data: text.encode("bad"),
        },
      ],
    };
    expect(() => stageKindleVolume(volume, bad)).toThrow("refusing non-MRPI payload entry");
  });
});

describe("Kindle bootstrap CLI and host key", () => {
  test("parses explicit volume, key, cache, port, and dry-run", () => {
    expect(parseKindleBootstrapArgs([
      "--volume=/Volumes/Kindle",
      "--ssh-key",
      "/tmp/kindle-key",
      "--cache=/tmp/kindle-cache",
      "--port",
      "22022",
      "--dry-run",
    ])).toEqual({
      volume: "/Volumes/Kindle",
      sshKey: "/tmp/kindle-key",
      cacheDirectory: "/tmp/kindle-cache",
      sshPort: 22022,
      dryRun: true,
    });
    expect(() => parseKindleBootstrapArgs(["--port=22"])).toThrow("between 1024 and 65535");
    expect(() => parseKindleBootstrapArgs(["--ssh-key=key.pub"])).toThrow("private key");
  });

  test("dry-run performs no downloads, key generation, or volume writes", () => {
    const volume = kindleVolume();
    const key = join(temporaryRoot(), "missing", "pocketjs-kindle");
    const before = readdirSync(volume, { recursive: true, encoding: "utf8" });
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        join(root, "tools", "kindle-bootstrap.ts"),
        "--volume",
        volume,
        "--ssh-key",
        key,
        "--dry-run",
      ],
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString()).toContain("no files, keys, caches, or downloads were changed");
    expect(result.stdout.toString()).toContain(KINDLE_BOOTSTRAP_ASSETS.peki.sha256);
    expect(existsSync(key)).toBe(false);
    expect(readdirSync(volume, { recursive: true, encoding: "utf8" })).toEqual(before);
  });

  test("generates one dedicated ed25519 identity and reuses it", () => {
    if (!Bun.which("ssh-keygen")) return;
    const key = join(temporaryRoot(), ".ssh", "pocketjs-kindle-ed25519");
    const first = ensureDedicatedSshKey(key);
    const second = ensureDedicatedSshKey(key);
    expect(first).toBe(second);
    expect(first).toStartWith("ssh-ed25519 ");
    expect(existsSync(`${key}.pub`)).toBe(true);
    expect(statSync(key).mode & 0o777).toBe(0o600);
  });

  test("all committed device templates are POSIX shell syntax-clean", () => {
    const shell = Bun.which("sh");
    if (!shell) return;
    const directory = join(root, "hosts", "kindle", "device");
    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".sh")) continue;
      const result = Bun.spawnSync({
        cmd: [shell, "-n", join(directory, name)],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, `${name}: ${result.stderr.toString()}`).toBe(0);
    }
  });
});
