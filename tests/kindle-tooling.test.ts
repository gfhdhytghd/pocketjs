import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  finalizeBuildPlan,
  type ResolvedBuildPlanContent,
} from "../framework/src/manifest/plan.ts";
import {
  DEFAULT_KINDLE_HOST,
  DEFAULT_KINDLE_PORT,
  DEFAULT_KINDLE_ROOT,
  KINDLE_HOST_ABI,
  KINDLE_RUST_TARGET,
  KINDLE_TARGET,
  buildCommandPlan,
  deployCommandPlan,
  parseKindleArgs,
  prepareRelease,
  probeRemoteScript,
  releaseContentHash,
  reloadRemoteScript,
  resolveBuildContext,
  runRemoteScript,
  shellQuote,
  sshCommandArgs,
  type BuildContext,
  type KindleConnection,
} from "../tools/kindle-lib.ts";
import {
  armMailboxRemoteScript,
  mailboxAppendRemoteScript,
  mailboxTailRemoteScript,
  normalizeMailboxLine,
} from "../tools/kindle-ssh-mailbox.ts";
import { startDevServer } from "../hosts/web/server.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const path = mkdtempSync(join(tmpdir(), "pocketjs-kindle-test-"));
  temporary.push(path);
  return path;
}

function connection(root = DEFAULT_KINDLE_ROOT): KindleConnection {
  return {
    host: DEFAULT_KINDLE_HOST,
    port: DEFAULT_KINDLE_PORT,
    user: "root",
    key: "/tmp/pocketjs-test-key",
    remoteRoot: root,
  };
}

function contextFixture(root: string, appOutput = "paper-ink"): BuildContext {
  const outdir = join(root, "dist");
  const nativePath = join(
    root,
    "hosts/kindle/target",
    KINDLE_RUST_TARGET,
    "release/pocketjs-kindle",
  );
  mkdirSync(outdir, { recursive: true });
  mkdirSync(resolve(nativePath, ".."), { recursive: true });
  writeFileSync(join(outdir, `${appOutput}.js`), "console.log('kindle');\n");
  writeFileSync(join(outdir, `${appOutput}.pak`), "pak-fixture");
  writeFileSync(nativePath, "ELF-fixture");
  return {
    app: "paper-ink",
    appOutput,
    projectRoot: root,
    outdir,
    hostInputs: {
      appOutput,
      target: KINDLE_TARGET,
      hostAbi: KINDLE_HOST_ABI,
      viewport: {
        logical: [309, 412],
        physical: [1236, 1648],
        presentation: "native",
        rasterDensity: 4,
      },
    },
    jsPath: join(outdir, `${appOutput}.js`),
    pakPath: join(outdir, `${appOutput}.pak`),
    nativePath,
  };
}

function stageRemoteRelease(
  plan: ReturnType<typeof deployCommandPlan>,
  release: Pick<ReturnType<typeof prepareRelease>, "directory">,
): void {
  mkdirSync(resolve(plan.stagingPath, ".."), { recursive: true });
  cpSync(release.directory, plan.stagingPath, { recursive: true });
}

function localPublishCommand(
  plan: ReturnType<typeof deployCommandPlan>,
): string {
  const statPadding = Array(17).fill("0").join(" ");
  return [
    "pocketjs_test_pid=$$",
    'mkdir -p "$POCKETJS_PUBLISH_PROC_ROOT/$pocketjs_test_pid"',
    `printf '%s\\n' "$pocketjs_test_pid (publish shell) S 1 ${statPadding} 777" >"$POCKETJS_PUBLISH_PROC_ROOT/$pocketjs_test_pid/stat"`,
    plan.publishScript,
  ].join("\n");
}

function localPublishEnvironment(
  procRoot: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    POCKETJS_PUBLISH_PROC_ROOT: procRoot,
    POCKETJS_PUBLISH_LOCK_WAIT_LIMIT: "5",
    ...extra,
  };
}

describe("Kindle CLI arguments and SSH boundary", () => {
  test("uses the dedicated USB-network defaults and expands the bootstrap key", () => {
    const options = parseKindleArgs(
      ["probe"],
      { HOME: "/Users/tester" },
      "/workspace/app",
    );
    expect(options.connection).toEqual({
      host: "192.168.15.244",
      port: 2222,
      user: "root",
      key: "/Users/tester/.ssh/pocketjs-kindle-ed25519",
      remoteRoot: "/mnt/us/pocketjs-dev",
    });
    expect(options.projectRoot).toBe("/workspace/app");
    expect(options.outdir).toBe("/workspace/app/dist");
  });

  test("accepts explicit SSH/runtime overrides and rejects injection-shaped values", () => {
    const options = parseKindleArgs([
      "dev",
      "paper-ink",
      "--host=kindle.local",
      "--port=2200",
      "--user=developer",
      "--key=/tmp/key with spaces",
      "--remote-root=/mnt/us/pocketjs-alt",
      "--present-hz=15",
      "--motion-waveform=A2",
      "--ghost-budget=48",
      "--rotation=90",
      "--hub-port=9000",
      "--no-logs",
    ]);
    expect(options.connection).toMatchObject({
      host: "kindle.local",
      port: 2200,
      user: "developer",
      key: "/tmp/key with spaces",
      remoteRoot: "/mnt/us/pocketjs-alt",
    });
    expect(options.presentHz).toBe(15);
    expect(options.motionWaveform).toBe("A2");
    expect(options.ghostBudget).toBe(48);
    expect(options.rotation).toBe("90");
    expect(options.hubPort).toBe(9000);
    expect(options.followLogs).toBe(false);
    expect(() => parseKindleArgs(["probe", "--host=x; touch /tmp/pwn"]))
      .toThrow("invalid SSH host");
    expect(() =>
      parseKindleArgs(["probe", "--remote-root=/mnt/us/dev;reboot"])
    ).toThrow("--remote-root");
    expect(() =>
      parseKindleArgs(["run", "paper-ink", "--motion-waveform=GC16"])
    ).toThrow("--motion-waveform");
  });

  test("quotes POSIX shell data and keeps the remote program in one SSH argv", () => {
    expect(shellQuote("plain/path-1")).toBe("plain/path-1");
    expect(shellQuote("a'b;$(touch /tmp/nope)")).toBe(
      `'a'"'"'b;$(touch /tmp/nope)'`,
    );
    const argv = sshCommandArgs(connection(), "printf '%s\\n' \"$HOME\"");
    expect(argv.slice(0, 7)).toEqual([
      "ssh",
      "-T",
      "-p",
      "2222",
      "-i",
      "/tmp/pocketjs-test-key",
      "-o",
    ]);
    expect(argv.at(-1)).toStartWith("sh -c ");
    expect(argv.at(-2)).toBe("root@192.168.15.244");
  });
});

describe("Kindle build boundary", () => {
  test("verifies plan target/hash/ABI and derives exact artifact paths", async () => {
    const root = tempRoot();
    const plan = finalizeBuildPlan({
      app: {
        id: "dev.pocketjs.paper-ink",
        title: "Paper Ink",
        entry: "src/main.tsx",
        framework: "solid",
        output: "paper-ink",
      },
      target: { id: KINDLE_TARGET, hostAbi: KINDLE_HOST_ABI },
      viewport: {
        logical: [309, 412],
        physical: [1236, 1648],
        presentation: "integer-fit",
        rasterDensity: 4,
      },
      features: { touch: true },
    });
    const planPath = join(root, "plan.json");
    writeFileSync(planPath, JSON.stringify(plan));
    const options = parseKindleArgs(
      [
        "build",
        `--plan=${planPath}`,
        `--project-root=${root}`,
        `--outdir=${join(root, "artifacts")}`,
      ],
      { HOME: root },
      root,
    );
    const context = await resolveBuildContext(options, root);
    expect(context.appOutput).toBe("paper-ink");
    expect(context.jsPath).toBe(join(root, "artifacts/paper-ink.js"));
    expect(context.nativePath).toBe(
      join(
        root,
        "hosts/kindle/target",
        KINDLE_RUST_TARGET,
        "release/pocketjs-kindle",
      ),
    );

    const modified = {
      ...plan,
      target: { ...plan.target, hostAbi: KINDLE_HOST_ABI + 1 },
    };
    writeFileSync(planPath, JSON.stringify(modified));
    await expect(resolveBuildContext(options, root)).rejects.toThrow(
      "invalid ResolvedBuildPlan checksum",
    );

    const { planHash: _planHash, ...planContent } = plan;
    const wrongAbi = finalizeBuildPlan({
      ...planContent,
      target: { id: KINDLE_TARGET, hostAbi: KINDLE_HOST_ABI + 1 },
    });
    writeFileSync(planPath, JSON.stringify(wrongAbi));
    await expect(resolveBuildContext(options, root)).rejects.toThrow(
      "has host ABI 6, expected 5",
    );

    const wrongTarget = finalizeBuildPlan({
      ...planContent,
      target: { id: "psp", hostAbi: KINDLE_HOST_ABI },
    });
    writeFileSync(planPath, JSON.stringify(wrongTarget));
    await expect(resolveBuildContext(options, root)).rejects.toThrow(
      "expected target kindle-pw5, got psp",
    );
  });

  test("enforces the PW5 display contract while admitting its supported presentations", async () => {
    const root = tempRoot();
    const planPath = join(root, "plan.json");
    const content: ResolvedBuildPlanContent = {
      app: {
        id: "dev.pocketjs.paper-ink",
        title: "Paper Ink",
        entry: "src/main.tsx",
        framework: "solid",
        output: "paper-ink",
      },
      target: { id: KINDLE_TARGET, hostAbi: KINDLE_HOST_ABI },
      viewport: {
        logical: [309, 412],
        physical: [1236, 1648],
        presentation: "native",
        rasterDensity: 4,
      },
      features: { touch: true },
    };
    const options = parseKindleArgs(
      [
        "build",
        `--plan=${planPath}`,
        `--project-root=${root}`,
      ],
      { HOME: root },
      root,
    );

    for (const presentation of ["native", "integer-fit"] as const) {
      writeFileSync(
        planPath,
        JSON.stringify(finalizeBuildPlan({
          ...content,
          viewport: { ...content.viewport, presentation },
        })),
      );
      const context = await resolveBuildContext(options, root);
      expect(context.hostInputs.viewport.presentation).toBe(presentation);
    }

    const rejects = async (
      viewport: ResolvedBuildPlanContent["viewport"],
      message: string,
    ) => {
      writeFileSync(
        planPath,
        JSON.stringify(finalizeBuildPlan({ ...content, viewport })),
      );
      await expect(resolveBuildContext(options, root)).rejects.toThrow(message);
    };
    await rejects(
      { ...content.viewport, logical: [308, 412] },
      "has logical viewport 308x412, expected kindle-pw5 309x412",
    );
    await rejects(
      { ...content.viewport, physical: [1236, 1647] },
      "has physical viewport 1236x1647, expected kindle-pw5 1236x1648",
    );
    await rejects(
      { ...content.viewport, rasterDensity: 3 },
      "has raster density 3, expected 4",
    );
    await rejects(
      { ...content.viewport, presentation: "fit" },
      'has unsupported presentation "fit"; expected one of native, integer-fit',
    );
  });

  test("plans pocket compile consumption and a fixed muslhf release build", async () => {
    const root = tempRoot();
    const context = contextFixture(root);
    const options = parseKindleArgs([
      "build",
      "paper-ink",
      "--skip-build",
    ], { HOME: root }, root);
    const commands = buildCommandPlan(context, options, root);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.argv).toEqual([
      Bun.which("cargo") ?? "cargo",
      "zigbuild",
      "--manifest-path",
      join(root, "hosts/kindle/Cargo.toml"),
      "--release",
      "--target",
      "armv7-unknown-linux-musleabihf",
      "--bin",
      "pocketjs-kindle",
    ]);
    expect(commands[0]!.env).toMatchObject({
      POCKETJS_TARGET: "kindle-pw5",
      POCKETJS_HOST_ABI: "5",
      POCKETJS_EMBED_APP: "0",
      POCKETJS_RASTER_DENSITY: "4",
      POCKETJS_PRESENTATION: "native",
      CARGO_ZIGBUILD_PYTHON_PATH: "/usr/bin/false",
    });
    expect(commands[0]!.env?.CARGO_ZIGBUILD_ZIG_PATH).toMatch(
      /\/\.cargo\/bin\/zig$/,
    );
    expect(commands[0]!.env?.CLANG_PATH).toMatch(/\/clang$/);
  });

  test("maps a bare demo name to its mounting main entry", async () => {
    const root = tempRoot();
    mkdirSync(join(root, "apps/paper-ink"), { recursive: true });
    writeFileSync(join(root, "apps/paper-ink/app.tsx"), "export default {};\n");
    writeFileSync(join(root, "apps/paper-ink/main.tsx"), "export default {};\n");
    const options = parseKindleArgs(
      ["build", "paper-ink"],
      { HOME: root },
      root,
    );
    const context = await resolveBuildContext(options, root);
    expect(context.app).toBe("paper-ink-main");
    expect(context.appOutput).toBe("paper-ink-main");
  });
});

describe("content-addressed Kindle deploy", () => {
  test("hash is canonical and changes with content", () => {
    const files = [
      {
        name: "app.js",
        sha256: "1".repeat(64),
        bytes: 10,
        executable: false,
      },
      {
        name: "pocketjs-kindle",
        sha256: "2".repeat(64),
        bytes: 20,
        executable: true,
      },
    ];
    const first = releaseContentHash("app", files);
    expect(first).toBe(releaseContentHash("app", [...files].reverse()));
    expect(first).not.toBe(
      releaseContentHash("app", [
        { ...files[0]!, sha256: "3".repeat(64) },
        files[1]!,
      ]),
    );
  });

  test("stages named artifacts plus checksums and produces atomic publish commands", () => {
    const root = tempRoot();
    const release = prepareRelease(contextFixture(root));
    try {
      expect(release.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(readFileSync(join(release.directory, "SHA256SUMS"), "utf8"))
        .toContain("pocketjs-kindle");
      expect(
        JSON.parse(readFileSync(join(release.directory, "release.json"), "utf8")),
      ).toMatchObject({
        target: "kindle-pw5",
        hostAbi: 5,
        appOutput: "paper-ink",
        releaseHash: release.hash,
      });

      const plan = deployCommandPlan(connection(), release, "test-nonce");
      expect(plan.releasePath).toBe(
        `/mnt/us/pocketjs-dev/releases/${release.hash}`,
      );
      expect(plan.stagingPath).toContain(
        `.${release.hash}.staging-test-nonce`,
      );
      expect(plan.tar).toEqual([
        "tar",
        "-cf",
        "-",
        "-C",
        release.directory,
        ".",
      ]);
      const publish = plan.publishScript;
      expect(plan.publish.at(-1)).toBe("sh -s");
      expect(plan.publish).not.toContain(publish);
      expect(Buffer.byteLength(publish)).toBeGreaterThan(8 * 1024);
      expect(plan.prepare.at(-1)).not.toContain(
        "runtime/pocketjs-dbg/enable",
      );
      expect(publish).toContain("sha256sum -c SHA256SUMS");
      expect(publish).toContain('mv "$pocketjs_stage" "$pocketjs_release"');
      expect(publish).toContain('pocketjs_next=".current-test-nonce"');
      expect(publish).toContain("current/.complete");
      expect(publish).toContain('mkdir "$pocketjs_publish_lock"');
      expect(publish).toContain("pocketjs_process_identity_matches");
      expect(publish).toContain("recovered stale publish lock");
      expect(publish).toContain("pocketjs_publish_recovery_owner_nonce");
      expect(publish).toContain("recovered stale publish recovery lock");
      expect(publish).toContain(
        "timed out waiting for the remote publish lock",
      );
      expect(publish).toContain("pocketjs_redundant_stage=1");
      expect(publish).toContain('rm -rf "$pocketjs_stage"');
      expect(publish).toContain("current reappeared during locked publish");
      expect(publish).toContain('mv "$pocketjs_next" current');
      expect(publish).toContain(
        "published current failed release hash read-back",
      );
      expect(publish).toContain("/mnt/us is normally FAT");
      expect(publish).not.toContain(
        "ln -s releases/",
      );
      expect(publish).toContain("previous");
    } finally {
      release.cleanup();
    }
  });

  test("serializes concurrent publishers across the current rename gap", async () => {
    const remoteRoot = tempRoot();
    const procRoot = join(remoteRoot, "proc");
    const fakeBin = join(remoteRoot, "fake-bin");
    const marker = join(remoteRoot, "publisher-a-moved-current");
    const current = join(remoteRoot, "current");
    const contextA = contextFixture(tempRoot());
    const contextB = contextFixture(tempRoot());
    writeFileSync(contextA.jsPath, "console.log('publisher-a');\n");
    writeFileSync(contextB.jsPath, "console.log('publisher-b');\n");
    const releaseA = prepareRelease(contextA);
    const releaseB = prepareRelease(contextB);
    try {
      const planA = deployCommandPlan(
        connection(remoteRoot),
        releaseA,
        "publisher-a",
      );
      const planB = deployCommandPlan(
        connection(remoteRoot),
        releaseB,
        "publisher-b",
      );
      stageRemoteRelease(planA, releaseA);
      stageRemoteRelease(planB, releaseB);
      mkdirSync(join(remoteRoot, "run"), { recursive: true });
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, ".complete"), "baseline\n");

      mkdirSync(fakeBin, { recursive: true });
      const fakeMv = join(fakeBin, "mv");
      writeFileSync(
        fakeMv,
        [
          "#!/bin/sh",
          '/bin/mv "$@"',
          "pocketjs_status=$?",
          'if [ "$pocketjs_status" -eq 0 ] &&',
          '  [ "${POCKETJS_TEST_PAUSE_AFTER_CURRENT_MOVE:-0}" = 1 ] &&',
          '  [ "${1:-}" = current ]; then',
          '  : >"$POCKETJS_TEST_CURRENT_MOVED_MARKER"',
          "  sleep 1",
          "fi",
          'exit "$pocketjs_status"',
          "",
        ].join("\n"),
      );
      chmodSync(fakeMv, 0o755);
      const path = `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`;

      const publisherA = Bun.spawn({
        cmd: ["/bin/sh", "-c", localPublishCommand(planA)],
        env: localPublishEnvironment(procRoot, {
          PATH: path,
          POCKETJS_TEST_PAUSE_AFTER_CURRENT_MOVE: "1",
          POCKETJS_TEST_CURRENT_MOVED_MARKER: marker,
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const publisherAStdout = new Response(publisherA.stdout).text();
      const publisherAStderr = new Response(publisherA.stderr).text();
      for (
        let attempt = 0;
        attempt < 500 && !existsSync(marker);
        attempt += 1
      ) {
        await Bun.sleep(10);
      }
      expect(existsSync(marker)).toBe(true);

      const publisherB = Bun.spawn({
        cmd: ["/bin/sh", "-c", localPublishCommand(planB)],
        env: localPublishEnvironment(procRoot, { PATH: path }),
        stdout: "pipe",
        stderr: "pipe",
      });
      const publisherBStdout = new Response(publisherB.stdout).text();
      const publisherBStderr = new Response(publisherB.stderr).text();
      const publisherBFinishedDuringGap = await Promise.race([
        publisherB.exited.then(() => true),
        Bun.sleep(200).then(() => false),
      ]);
      expect(publisherBFinishedDuringGap).toBe(false);

      const [statusA, statusB, stdoutA, stderrA, stdoutB, stderrB] =
        await Promise.all([
          publisherA.exited,
          publisherB.exited,
          publisherAStdout,
          publisherAStderr,
          publisherBStdout,
          publisherBStderr,
        ]);
      expect({ statusA, stderrA }).toEqual({ statusA: 0, stderrA: "" });
      expect({ statusB, stderrB }).toEqual({ statusB: 0, stderrB: "" });
      expect(stdoutA.trim().split("\n").at(-1)).toBe(releaseA.hash);
      expect(stdoutB.trim().split("\n").at(-1)).toBe(releaseB.hash);
      expect(readFileSync(join(current, ".complete"), "utf8").trim()).toBe(
        releaseB.hash,
      );
      expect(existsSync(join(current, ".current-publisher-a"))).toBe(false);
      expect(existsSync(join(remoteRoot, "run", "publish.lock"))).toBe(false);
    } finally {
      releaseA.cleanup();
      releaseB.cleanup();
    }
  });

  test("publishes identical staged releases concurrently without misclassifying the winner", async () => {
    const remoteRoot = tempRoot();
    const procRoot = join(remoteRoot, "proc");
    const context = contextFixture(tempRoot());
    writeFileSync(context.jsPath, "console.log('same-release');\n");
    const release = prepareRelease(context);
    try {
      const planA = deployCommandPlan(
        connection(remoteRoot),
        release,
        "same-release-a",
      );
      const planB = deployCommandPlan(
        connection(remoteRoot),
        release,
        "same-release-b",
      );
      stageRemoteRelease(planA, release);
      stageRemoteRelease(planB, release);
      mkdirSync(join(remoteRoot, "run"), { recursive: true });

      const publisherA = Bun.spawn({
        cmd: ["/bin/sh", "-c", localPublishCommand(planA)],
        env: localPublishEnvironment(procRoot),
        stdout: "pipe",
        stderr: "pipe",
      });
      const publisherB = Bun.spawn({
        cmd: ["/bin/sh", "-c", localPublishCommand(planB)],
        env: localPublishEnvironment(procRoot),
        stdout: "pipe",
        stderr: "pipe",
      });
      const publisherAStdout = new Response(publisherA.stdout).text();
      const publisherAStderr = new Response(publisherA.stderr).text();
      const publisherBStdout = new Response(publisherB.stdout).text();
      const publisherBStderr = new Response(publisherB.stderr).text();
      const [statusA, statusB, stdoutA, stderrA, stdoutB, stderrB] =
        await Promise.all([
          publisherA.exited,
          publisherB.exited,
          publisherAStdout,
          publisherAStderr,
          publisherBStdout,
          publisherBStderr,
        ]);

      expect({ statusA, stderrA }).toEqual({ statusA: 0, stderrA: "" });
      expect({ statusB, stderrB }).toEqual({ statusB: 0, stderrB: "" });
      expect(stdoutA.trim().split("\n").at(-1)).toBe(release.hash);
      expect(stdoutB.trim().split("\n").at(-1)).toBe(release.hash);
      expect(
        readFileSync(join(remoteRoot, "current", ".complete"), "utf8").trim(),
      ).toBe(release.hash);
      expect(existsSync(planA.stagingPath)).toBe(false);
      expect(existsSync(planB.stagingPath)).toBe(false);
      expect(existsSync(join(remoteRoot, "run", "publish.lock"))).toBe(false);
    } finally {
      release.cleanup();
    }
  });

  test("recovers a stale verified owner but times out on a live publish owner", () => {
    const remoteRoot = tempRoot();
    const procRoot = join(remoteRoot, "proc");
    const context = contextFixture(tempRoot());
    writeFileSync(context.jsPath, "console.log('stale-lock');\n");
    const release = prepareRelease(context);
    try {
      const stalePlan = deployCommandPlan(
        connection(remoteRoot),
        release,
        "stale-recovery",
      );
      stageRemoteRelease(stalePlan, release);
      const lock = join(remoteRoot, "run", "publish.lock");
      mkdirSync(lock, { recursive: true });
      writeFileSync(
        join(lock, "owner"),
        "pid=424242\nstarttime=999\nnonce=dead-owner\n",
      );

      const recovered = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", localPublishCommand(stalePlan)],
        env: localPublishEnvironment(procRoot),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stderr.toString()).toContain(
        "recovered stale publish lock",
      );
      expect(recovered.stdout.toString().trim().split("\n").at(-1)).toBe(
        release.hash,
      );
      expect(existsSync(lock)).toBe(false);

      mkdirSync(join(procRoot, "5151"), { recursive: true });
      writeFileSync(
        join(procRoot, "5151", "stat"),
        `5151 (live owner) S 1 ${Array(17).fill("0").join(" ")} 888`,
      );
      mkdirSync(lock);
      writeFileSync(
        join(lock, "owner"),
        "pid=5151\nstarttime=888\nnonce=live-owner\n",
      );
      const blocked = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", localPublishCommand(stalePlan)],
        env: localPublishEnvironment(procRoot, {
          POCKETJS_PUBLISH_LOCK_WAIT_LIMIT: "1",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr.toString()).toContain(
        "timed out waiting for the remote publish lock",
      );
      expect(readFileSync(join(lock, "owner"), "utf8")).toContain(
        "nonce=live-owner",
      );
    } finally {
      release.cleanup();
    }
  });

  test("recovers a dead publish recovery owner without stealing a live one", () => {
    const remoteRoot = tempRoot();
    const procRoot = join(remoteRoot, "proc");
    const context = contextFixture(tempRoot());
    writeFileSync(context.jsPath, "console.log('recovery-owner-died');\n");
    const release = prepareRelease(context);
    try {
      const plan = deployCommandPlan(
        connection(remoteRoot),
        release,
        "recovery-owner-died",
      );
      stageRemoteRelease(plan, release);
      const publishLock = join(remoteRoot, "run", "publish.lock");
      const recoveryLock = join(remoteRoot, "run", "publish.lock.recovery");
      mkdirSync(publishLock, { recursive: true });
      writeFileSync(
        join(publishLock, "owner"),
        "pid=424242\nstarttime=999\nnonce=dead-publisher\n",
      );
      mkdirSync(recoveryLock);
      writeFileSync(
        join(recoveryLock, "owner"),
        "pid=434343\nstarttime=1001\nnonce=dead-recovery\n",
      );

      const recovered = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", localPublishCommand(plan)],
        env: localPublishEnvironment(procRoot),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(recovered.exitCode).toBe(0);
      expect(recovered.stderr.toString()).toContain(
        "recovered stale publish recovery lock",
      );
      expect(recovered.stderr.toString()).toContain(
        "recovered stale publish lock",
      );
      expect(recovered.stdout.toString().trim().split("\n").at(-1)).toBe(
        release.hash,
      );
      expect(existsSync(recoveryLock)).toBe(false);
      expect(existsSync(publishLock)).toBe(false);

      mkdirSync(join(procRoot, "6262"), { recursive: true });
      writeFileSync(
        join(procRoot, "6262", "stat"),
        `6262 (live recovery) S 1 ${Array(17).fill("0").join(" ")} 1222`,
      );
      mkdirSync(recoveryLock);
      writeFileSync(
        join(recoveryLock, "owner"),
        "pid=6262\nstarttime=1222\nnonce=live-recovery\n",
      );
      const blocked = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", localPublishCommand(plan)],
        env: localPublishEnvironment(procRoot, {
          POCKETJS_PUBLISH_LOCK_WAIT_LIMIT: "1",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(blocked.exitCode).toBe(1);
      expect(blocked.stderr.toString()).toContain(
        "timed out waiting for the remote publish lock",
      );
      expect(readFileSync(join(recoveryLock, "owner"), "utf8")).toContain(
        "nonce=live-recovery",
      );
    } finally {
      release.cleanup();
    }
  });

  test("fails closed if current reappears before the final rename", () => {
    const remoteRoot = tempRoot();
    const procRoot = join(remoteRoot, "proc");
    const fakeBin = join(remoteRoot, "fake-bin");
    const current = join(remoteRoot, "current");
    const context = contextFixture(tempRoot());
    writeFileSync(context.jsPath, "console.log('rename-race');\n");
    const release = prepareRelease(context);
    try {
      const plan = deployCommandPlan(
        connection(remoteRoot),
        release,
        "rename-race",
      );
      stageRemoteRelease(plan, release);
      mkdirSync(join(remoteRoot, "run"), { recursive: true });
      mkdirSync(current, { recursive: true });
      writeFileSync(join(current, ".complete"), "baseline\n");

      mkdirSync(fakeBin, { recursive: true });
      const fakeMv = join(fakeBin, "mv");
      writeFileSync(
        fakeMv,
        [
          "#!/bin/sh",
          '/bin/mv "$@"',
          "pocketjs_status=$?",
          'if [ "$pocketjs_status" -eq 0 ] &&',
          '  [ "${POCKETJS_TEST_RECREATE_CURRENT:-0}" = 1 ] &&',
          '  [ "${1:-}" = current ]; then',
          "  mkdir current",
          "  printf 'intruder\\n' >current/.complete",
          "fi",
          'exit "$pocketjs_status"',
          "",
        ].join("\n"),
      );
      chmodSync(fakeMv, 0o755);
      const failed = Bun.spawnSync({
        cmd: ["/bin/sh", "-c", localPublishCommand(plan)],
        env: localPublishEnvironment(procRoot, {
          PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          POCKETJS_TEST_RECREATE_CURRENT: "1",
        }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(failed.exitCode).toBe(1);
      expect(failed.stderr.toString()).toContain(
        "current reappeared during locked publish",
      );
      expect(readFileSync(join(current, ".complete"), "utf8")).toBe(
        "intruder\n",
      );
      expect(existsSync(join(current, ".current-rename-race"))).toBe(false);
      expect(existsSync(join(remoteRoot, "run", "publish.lock"))).toBe(false);
    } finally {
      release.cleanup();
    }
  });
});

describe("runtime, probe, and SSH mailbox scripts", () => {
  test("DevTools server falls forward from an occupied requested port and reports the actual panel URL", async () => {
    const occupied = startDevServer({ port: 0 });
    let fallback: ReturnType<typeof startDevServer> | undefined;
    try {
      fallback = startDevServer({
        port: occupied.port,
        portRetries: 10,
      });
      expect(fallback.port).not.toBe(occupied.port);
      expect(fallback.panelUrl).toBe(
        `http://127.0.0.1:${fallback.port}/devtools`,
      );
      const response = await fetch(fallback.panelUrl);
      expect(response.status).toBe(200);
    } finally {
      fallback?.stop();
      occupied.stop();
    }
  });

  test("probe is read-only and reload only targets the identity-checked PID with HUP", () => {
    const probe = probeRemoteScript();
    expect(probe).toContain("/sys/class/graphics/fb0");
    expect(probe).toContain("/sys/class/input/input");
    expect(probe).toContain("/lib/ld-linux-armhf.so.3");
    expect(probe).toContain("current/pocketjs-kindle --probe");
    expect(probe).not.toMatch(/\b(?:mkdir|touch|rm|mv|chmod|kill)\b/);

    const reload = reloadRemoteScript(DEFAULT_KINDLE_ROOT);
    expect(reload).toContain("runtime.identity");
    expect(reload).toContain("runtime.launch");
    expect(reload).toContain("pocketjs_launch_state_valid");
    expect(reload).toContain(
      'pocketjs_sha256_file "/proc/$pocketjs_pid/exe"',
    );
    expect(reload).toContain(
      'pocketjs_sha256_file "$pocketjs_launch_native_path"',
    );
    expect(reload).toContain(
      'pocketjs_sha256_file "$pocketjs_launch_js_path"',
    );
    expect(reload).toContain(
      'pocketjs_sha256_file "$pocketjs_launch_pak_path"',
    );
    expect(reload).toContain('kill -HUP "$pocketjs_pid"');
    expect(reload).not.toMatch(/kill -(?:TERM|KILL)/);
  });

  test("run persists the complete launch fingerprint and delegates GUI ownership", () => {
    const script = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink", {
      restart: true,
      presentHz: 12,
      motionWaveform: "A2",
      ghostBudget: 40,
      rotation: "auto",
    });
    expect(script).toContain("/mnt/us/pocketjs-dev/run-runtime.sh");
    expect(script).toContain("/mnt/us/pocketjs-dev/stop-runtime.sh");
    expect(script).toContain("POCKETJS_RUNTIME_BIN=");
    expect(script).toContain(
      'POCKETJS_DBG_DIR="$pocketjs_debug_dir"',
    );
    expect(script).toContain("--js /mnt/us/pocketjs-dev/current/paper-ink.js");
    expect(script).toContain("--present-hz 12");
    expect(script).toContain("--motion-waveform A2");
    expect(script).toContain("--ghost-budget 40");
    expect(script).toContain("runtime.launch");
    expect(script).toContain("app_output=paper-ink");
    expect(script).toContain('printf \'native_path=%s\\n\' "$pocketjs_host"');
    expect(script).toContain('printf \'native_sha256=%s\\n\' "$pocketjs_native_hash"');
    expect(script).toContain('printf \'js_path=%s\\n\' "$pocketjs_js"');
    expect(script).toContain('printf \'js_sha256=%s\\n\' "$pocketjs_js_hash"');
    expect(script).toContain('printf \'pak_path=%s\\n\' "$pocketjs_pak"');
    expect(script).toContain('printf \'pak_sha256=%s\\n\' "$pocketjs_pak_hash"');
    expect(script).toContain("present_hz=12");
    expect(script).toContain("motion_waveform=A2");
    expect(script).toContain("ghost_budget=40");
    expect(script).toContain("rotation=auto");
    expect(script).toContain("argument_0=--js");
    expect(script).toContain("argument_13=auto");
    expect(script).toContain(
      'pocketjs_desired_fingerprint=$(pocketjs_sha256_file "$pocketjs_launch_candidate")',
    );
    expect(script).toContain(
      'printf \'fingerprint=%s\\n\' "$pocketjs_desired_fingerprint"',
    );
    expect(script).not.toContain("killall");
  });

  test("switching app A to B with the same native path cannot reuse the runtime", () => {
    const appA = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink-a", {
      restart: true,
      rotation: "auto",
    });
    const appB = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink-b", {
      restart: true,
      rotation: "auto",
    });
    const appBWithoutRestart = runRemoteScript(
      DEFAULT_KINDLE_ROOT,
      "paper-ink-b",
      {
        restart: false,
        rotation: "auto",
      },
    );
    expect(appA).toContain(
      "native_path=%s\\n' \"$pocketjs_host\"",
    );
    expect(appB).toContain(
      "native_path=%s\\n' \"$pocketjs_host\"",
    );
    expect(appA).toContain(
      "js_path=%s\\n' \"$pocketjs_js\"",
    );
    expect(appA).toContain(
      "argument_1=/mnt/us/pocketjs-dev/current/paper-ink-a.js",
    );
    expect(appB).toContain(
      "argument_1=/mnt/us/pocketjs-dev/current/paper-ink-b.js",
    );
    expect(appA).not.toBe(appB);
    expect(appB).toContain(
      'if pocketjs_launch_state_valid &&\n    [ "$pocketjs_launch_fingerprint" = "$pocketjs_desired_fingerprint" ]; then',
    );
    expect(appBWithoutRestart).toContain("pocketjs_restart=0");
    expect(appBWithoutRestart).toContain(
      "runtime launch config changed; rerun with --restart",
    );
    const fingerprintMatch = appB.indexOf(
      'if pocketjs_launch_state_valid &&',
    );
    const restartGuard = appB.indexOf(
      'if [ "$pocketjs_restart" != 1 ]; then',
    );
    const identityProtectedStop = appB.indexOf(
      "runtime PID identity changed before restart",
    );
    const stop = appB.indexOf(
      "/mnt/us/pocketjs-dev/stop-runtime.sh",
      identityProtectedStop,
    );
    expect(fingerprintMatch).toBeGreaterThan(-1);
    expect(restartGuard).toBeGreaterThan(fingerprintMatch);
    expect(identityProtectedStop).toBeGreaterThan(restartGuard);
    expect(stop).toBeGreaterThan(identityProtectedStop);
  });

  test("refresh settings and the exact runtime argv participate in the fingerprint", () => {
    const du = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink", {
      restart: true,
      presentHz: 12,
      motionWaveform: "DU",
      ghostBudget: 40,
      rotation: "0",
    });
    const a2 = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink", {
      restart: true,
      presentHz: 20,
      motionWaveform: "A2",
      ghostBudget: 64,
      rotation: "90",
    });
    expect(du).toContain("present_hz=12");
    expect(du).toContain("motion_waveform=DU");
    expect(du).toContain("ghost_budget=40");
    expect(du).toContain("rotation=0");
    expect(a2).toContain("present_hz=20");
    expect(a2).toContain("motion_waveform=A2");
    expect(a2).toContain("ghost_budget=64");
    expect(a2).toContain("rotation=90");
    expect(du).not.toBe(a2);
  });

  test("PID reuse is rejected and startup waits for the recorded process identity", () => {
    const script = runRemoteScript(DEFAULT_KINDLE_ROOT, "paper-ink", {
      restart: true,
      rotation: "auto",
    });
    const reusedPidProbe = script.indexOf(
      'if [ -r "/proc/$pocketjs_recorded_pid/stat" ]; then',
    );
    const reusedPidIdentity = script.indexOf(
      "if ! pocketjs_runtime_identity_check; then",
      reusedPidProbe,
    );
    const reusedPidRefusal = script.indexOf(
      "refusing to replace a reused PID",
    );
    expect(reusedPidProbe).toBeGreaterThan(-1);
    expect(reusedPidIdentity).toBeGreaterThan(reusedPidProbe);
    expect(reusedPidRefusal).toBeGreaterThan(reusedPidIdentity);

    const startupWait = script.slice(
      script.indexOf('while [ "$pocketjs_wait" -lt 15 ]; do'),
    );
    expect(startupWait).toContain(
      'pocketjs_launcher_pid=$(sed -n \'1p\' "$pocketjs_root/run/runtime-launcher.pid"',
    );
    expect(startupWait).toContain(
      '[ "$pocketjs_launcher_pid" = "$pocketjs_expected_launcher_pid" ] &&',
    );
    expect(startupWait).toContain(
      "pocketjs_runtime_identity_check 2>/dev/null; then",
    );
    expect(startupWait).toContain(
      'printf \'starttime=%s\\n\' "$pocketjs_expected_start"',
    );
    expect(startupWait).not.toContain('kill -0 "$pocketjs_pid"');
  });

  test("mailbox uses persistent SSH-side JSONL tail/append without command interpolation", () => {
    const dir = `${DEFAULT_KINDLE_ROOT}/runtime/pocketjs-dbg`;
    const arm = armMailboxRemoteScript(dir);
    expect(arm).toContain(": >/mnt/us/pocketjs-dev/runtime/pocketjs-dbg/in.jsonl");
    expect(arm).toContain("enable");
    expect(arm).toContain("ARMED");
    expect(mailboxTailRemoteScript(dir, 123)).toContain(
      'pocketjs_offset=123',
    );
    expect(mailboxTailRemoteScript(dir, 123)).toContain(
      'exec tail -c +"$pocketjs_first" -F',
    );
    expect(mailboxAppendRemoteScript(dir)).toContain(
      `printf '%s\\n' "$pocketjs_line"`,
    );
    expect(mailboxAppendRemoteScript(dir)).toContain("printf 'ACK\\n'");
    expect(normalizeMailboxLine(' { "t": "devStats" }\n')).toBe(
      '{"t":"devStats"}',
    );
    expect(() => normalizeMailboxLine('"not an object"')).toThrow(
      "JSON objects",
    );
  });

  test("dev starts the hub and arms the mailbox before launching or reloading", async () => {
    const source = await Bun.file(
      new URL("../tools/kindle.ts", import.meta.url),
    ).text();
    const body = source.slice(
      source.indexOf("async function dev("),
      source.indexOf("export async function main("),
    );
    const server = body.indexOf("startDevServer({");
    const arm = body.indexOf("armMailboxRemoteScript(mailboxDirectory)");
    const run = body.indexOf("await runDevice(options, context, true)");
    const reload = body.indexOf("await reload(options)");
    expect(server).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(server);
    expect(run).toBeGreaterThan(arm);
    expect(reload).toBeGreaterThan(run);
  });
});
