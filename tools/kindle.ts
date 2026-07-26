// PocketJS Kindle build/deploy/debug loop.
//
//   bun tools/kindle.ts probe
//   bun tools/kindle.ts dev --plan=.pocket/kindle-pw5/plan.json
//   bun tools/kindle.ts reload
//
// USB mass storage and USB networking are mutually exclusive on Kindle. All
// runtime operations therefore use key-only SSH; deploy streams a tar archive
// over SSH and never writes through /Volumes/Kindle.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  startDevServer,
  type DevServer,
} from "../hosts/web/server.ts";
import {
  assertBuildArtifacts,
  buildCommandPlan,
  deployCommandPlan,
  formatCommand,
  logsRemoteScript,
  parseKindleArgs,
  prepareRelease,
  probeRemoteScript,
  reloadRemoteScript,
  resolveBuildContext,
  runRemoteScript,
  shellQuote,
  sshCommandArgs,
  type BuildContext,
  type KindleCliOptions,
  type PreparedRelease,
} from "./kindle-lib.ts";
import {
  armMailboxRemoteScript,
  startKindleSshMailboxBridge,
  type KindleMailboxBridge,
} from "./kindle-ssh-mailbox.ts";

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function usage(): string {
  return `usage: bun tools/kindle.ts <command> [app] [options]

commands:
  probe    read-only SSH probe (firmware, framebuffer, input, ARM loader)
  build    build JS/PAK and the armv7-muslhf native host
  deploy   content-addressed, verified, rename-published SSH deploy
  run      start the deployed app through the trap-safe device launcher
  reload   send only SIGHUP to the verified runtime PID
  logs     tail the persistent device runtime log
  dev      build + deploy + run/reload + SSH mailbox + logs

build/app options:
  --plan=<path>          verified ResolvedBuildPlan (target kindle-pw5, ABI 5)
  --project-root=<path>  app project root (default: current directory)
  --outdir=<path>        JS/PAK output directory (default: <project>/dist)
  --app-output=<stem>    artifact stem when no plan is available
  --skip-build           use JS/PAK already produced by pocket compile
  --skip-native          use the existing native host binary

SSH options:
  --host=<host>          default 192.168.15.244
  --port=<port>          default 2222
  --user=<user>          default root
  --key=<path>           default ~/.ssh/pocketjs-kindle-ed25519
  --remote-root=<path>   default /mnt/us/pocketjs-dev

runtime options:
  --restart              restart when app artifacts or launch config changed
  --present-hz=<1..60>   override e-ink presentation rate
  --motion-waveform=<w>  shallow-refresh waveform: DU or A2
  --ghost-budget=<n>     fast updates before a full GC16 cleanup
  --rotation=<mode>      auto, 0, 90, 180, or 270
  --hub-port=<port>      local DevTools WebSocket hub (default 8130)
  --no-logs              dev exits after reload instead of following logs
  --dry-run              print external commands without executing them`;
}

function printCommand(argv: readonly string[], cwd?: string): void {
  console.log(`${cwd ? `[cwd ${cwd}] ` : ""}$ ${formatCommand(argv)}`);
}

async function runInherited(
  argv: readonly string[],
  options: {
    cwd?: string;
    env?: Readonly<Record<string, string>>;
    dryRun?: boolean;
  } = {},
): Promise<void> {
  if (options.dryRun) {
    printCommand(argv, options.cwd);
    return;
  }
  const child = Bun.spawn([...argv], {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await child.exited;
  if (status !== 0) {
    throw new Error(
      `PocketJS Kindle: command failed with exit ${status}: ${formatCommand(argv)}`,
    );
  }
}

async function runCaptured(
  argv: readonly string[],
  options: { dryRun?: boolean; label?: string; stdin?: string } = {},
): Promise<string> {
  if (options.dryRun) {
    printCommand(argv);
    return "";
  }
  const child = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
  });
  if (options.stdin !== undefined) child.stdin.write(options.stdin);
  child.stdin.end();
  const [status, output] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (status !== 0) {
    throw new Error(
      `PocketJS Kindle: ${options.label ?? "command"} failed with exit ${status}`,
    );
  }
  return output.trim();
}

function requireSshKey(options: KindleCliOptions): void {
  if (options.dryRun) return;
  if (!existsSync(options.connection.key)) {
    throw new Error(
      `PocketJS Kindle: SSH key not found: ${options.connection.key}\n` +
        "Run the Kindle bootstrap first, then start PocketJS SSH from the Kindle.",
    );
  }
}

async function build(
  options: KindleCliOptions,
  context: BuildContext,
): Promise<void> {
  const commands = buildCommandPlan(context, options, REPOSITORY_ROOT);
  for (const command of commands) {
    await runInherited(command.argv, {
      cwd: command.cwd,
      env: command.env,
      dryRun: options.dryRun,
    });
  }
  if (options.dryRun) {
    console.log("PocketJS Kindle: planned artifacts:");
    console.log(`  ${context.jsPath}`);
    console.log(`  ${context.pakPath}`);
    console.log(`  ${context.nativePath}`);
    return;
  }
  assertBuildArtifacts(context);
  console.log(
    `PocketJS Kindle: built ${context.appOutput} for kindle-pw5 (host ABI 5)`,
  );
}

async function uploadRelease(
  options: KindleCliOptions,
  release: PreparedRelease,
): Promise<string> {
  requireSshKey(options);
  const plan = deployCommandPlan(
    options.connection,
    release,
    `${process.pid}-${Date.now().toString(36)}`,
  );
  console.log(`PocketJS Kindle: release ${release.hash}`);
  if (options.dryRun) {
    printCommand(plan.prepare);
    console.log(`${formatCommand(plan.tar)} | ${formatCommand(plan.extract)}`);
    printCommand(plan.publish);
    return release.hash;
  }

  const state = await runCaptured(plan.prepare, { label: "remote staging prepare" });
  if (state !== "PRESENT" && state !== "READY") {
    throw new Error(
      `PocketJS Kindle: unexpected staging response ${JSON.stringify(state)}`,
    );
  }
  if (state === "READY") {
    const tar = Bun.spawn([...plan.tar], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "inherit",
    });
    const extract = Bun.spawn([...plan.extract], {
      stdin: tar.stdout,
      stdout: "inherit",
      stderr: "inherit",
    });
    const [tarStatus, extractStatus] = await Promise.all([
      tar.exited,
      extract.exited,
    ]);
    if (tarStatus !== 0 || extractStatus !== 0) {
      throw new Error(
        `PocketJS Kindle: upload failed (tar=${tarStatus}, ssh=${extractStatus}); current was not changed`,
      );
    }
  }
  const published = await runCaptured(plan.publish, {
    label: "remote release verification/publish",
    stdin: `${plan.publishScript}\n`,
  });
  if (published.split("\n").at(-1) !== release.hash) {
    throw new Error(
      `PocketJS Kindle: device did not confirm release ${release.hash}`,
    );
  }
  console.log(
    `PocketJS Kindle: deployed ${release.hash} to ${plan.releasePath}; current published by verified rename`,
  );
  return release.hash;
}

async function deploy(
  options: KindleCliOptions,
  context: BuildContext,
): Promise<string> {
  const release = prepareRelease(context);
  try {
    return await uploadRelease(options, release);
  } finally {
    release.cleanup();
  }
}

async function runDevice(
  options: KindleCliOptions,
  context: BuildContext,
  restart = options.restart,
): Promise<"RUNNING" | "STARTED" | "DRY-RUN"> {
  requireSshKey(options);
  const argv = sshCommandArgs(
    options.connection,
    runRemoteScript(options.connection.remoteRoot, context.appOutput, {
      restart,
      presentHz: options.presentHz,
      motionWaveform: options.motionWaveform,
      ghostBudget: options.ghostBudget,
      rotation: options.rotation,
    }),
  );
  const output = await runCaptured(argv, {
    dryRun: options.dryRun,
    label: "runtime launch",
  });
  if (options.dryRun) return "DRY-RUN";
  const status = output.startsWith("RUNNING ")
    ? "RUNNING"
    : output.startsWith("STARTED ")
      ? "STARTED"
      : undefined;
  if (!status) {
    throw new Error(
      `PocketJS Kindle: unexpected runtime launcher response ${JSON.stringify(output)}`,
    );
  }
  console.log(`PocketJS Kindle: ${output}`);
  return status;
}

async function reload(options: KindleCliOptions): Promise<void> {
  requireSshKey(options);
  const argv = sshCommandArgs(
    options.connection,
    reloadRemoteScript(options.connection.remoteRoot),
  );
  const output = await runCaptured(argv, {
    dryRun: options.dryRun,
    label: "runtime reload",
  });
  if (output) console.log(`PocketJS Kindle: ${output}`);
}

async function followLogs(options: KindleCliOptions): Promise<void> {
  requireSshKey(options);
  const argv = sshCommandArgs(
    options.connection,
    logsRemoteScript(options.connection.remoteRoot),
  );
  if (options.dryRun) {
    printCommand(argv);
    return;
  }
  const child = Bun.spawn(argv, {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    try {
      child.kill();
    } catch {
      // The SSH tail may already have exited.
    }
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const status = await child.exited;
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (status !== 0 && !interrupted) {
    throw new Error(
      `PocketJS Kindle: log tail failed with exit ${status}: ${formatCommand(argv)}`,
    );
  }
}

async function dev(
  options: KindleCliOptions,
  context: BuildContext,
): Promise<void> {
  await build(options, context);
  if (options.dryRun) {
    try {
      assertBuildArtifacts(context);
    } catch {
      console.log(
        "PocketJS Kindle: deploy/run dry-run omitted because the planned artifacts do not exist yet.",
      );
      return;
    }
  }
  await deploy(options, context);
  let bridge: KindleMailboxBridge | undefined;
  let server: DevServer | undefined;
  const mailboxDirectory =
    `${options.connection.remoteRoot}/runtime/pocketjs-dbg`;
  try {
    if (options.followLogs) {
      if (options.dryRun) {
        console.log(
          `PocketJS Kindle: would start DevTools panel at http://127.0.0.1:${options.hubPort}/devtools (with 10-port fallback)`,
        );
      } else {
        server = startDevServer({
          port: options.hubPort,
          portRetries: 10,
        });
        console.log(`PocketJS Kindle: DevTools panel ${server.panelUrl}`);
      }
      const armed = await runCaptured(
        sshCommandArgs(
          options.connection,
          armMailboxRemoteScript(mailboxDirectory),
        ),
        { dryRun: options.dryRun, label: "DevTools mailbox arm" },
      );
      if (!options.dryRun && armed !== "ARMED") {
        throw new Error(
          `PocketJS Kindle: unexpected mailbox arm response ${JSON.stringify(armed)}`,
        );
      }
    }
    if (options.followLogs && !options.dryRun) {
      bridge = startKindleSshMailboxBridge({
        connection: options.connection,
        hubPort: server!.port,
        remoteDirectory: mailboxDirectory,
        onEvent(event) {
          const detail = event.detail ? ` — ${event.detail}` : "";
          if (event.type === "error") {
            console.error(`PocketJS Kindle mailbox: ${event.type}${detail}`);
          } else {
            console.log(`PocketJS Kindle mailbox: ${event.type}${detail}`);
          }
        },
      });
      console.log(
        `PocketJS Kindle: DevTools mailbox → ws://127.0.0.1:${server!.port}/ws`,
      );
    }
    const state = await runDevice(options, context, true);
    if (state === "RUNNING") await reload(options);
    if (!options.followLogs) return;
    await followLogs(options);
  } finally {
    await bridge?.stop();
    server?.stop();
  }
}

export async function main(
  rawArgv = Bun.argv.slice(2),
  env = process.env,
): Promise<void> {
  let options: KindleCliOptions;
  try {
    if (rawArgv.includes("--help") || rawArgv.includes("-h")) {
      console.log(usage());
      return;
    }
    options = parseKindleArgs(rawArgv, env);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n\n${usage()}`,
      { cause: error },
    );
  }

  if (options.command === "probe") {
    requireSshKey(options);
    await runInherited(
      sshCommandArgs(
        options.connection,
        probeRemoteScript(options.connection.remoteRoot),
      ),
      { dryRun: options.dryRun },
    );
    return;
  }
  if (options.command === "reload") {
    await reload(options);
    return;
  }
  if (options.command === "logs") {
    await followLogs(options);
    return;
  }

  const context = await resolveBuildContext(options, REPOSITORY_ROOT);
  switch (options.command) {
    case "build":
      await build(options, context);
      return;
    case "deploy":
      await deploy(options, context);
      return;
    case "run":
      await runDevice(options, context);
      return;
    case "dev":
      await dev(options, context);
      return;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    if (process.env.POCKETJS_DEBUG === "1") {
      console.error(error);
    } else {
      console.error(
        error instanceof Error ? error.message : `PocketJS Kindle: ${error}`,
      );
    }
    process.exit(1);
  }
}
