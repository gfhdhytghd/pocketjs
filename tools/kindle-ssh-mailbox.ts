// SSH-backed PocketJS DevTools mailbox for Kindle.
//
// Unlike the PSP usbhostfs bridge, this bridge never touches the USB mass
// storage mount. It keeps one SSH tail session and one SSH append session
// open, forwarding JSONL to/from the local DevTools WebSocket hub.

import { existsSync } from "node:fs";
import { startDevServer } from "../hosts/web/server.ts";
import {
  parseKindleArgs,
  reloadRemoteScript,
  shellQuote,
  sshCommandArgs,
  type KindleConnection,
} from "./kindle-lib.ts";

export interface KindleMailboxEvent {
  readonly type:
    | "hub-connected"
    | "hub-lost"
    | "device-connected"
    | "device-lost"
    | "device-talking"
    | "error";
  readonly detail?: string;
}

export interface KindleMailboxOptions {
  readonly connection: KindleConnection;
  readonly hubPort: number;
  readonly remoteDirectory?: string;
  readonly onEvent?: (event: KindleMailboxEvent) => void;
}

export interface KindleMailboxBridge {
  readonly remoteDirectory: string;
  stop(): Promise<void>;
}

export function armMailboxRemoteScript(remoteDirectory: string): string {
  return `set -eu
umask 077
mkdir -p ${shellQuote(remoteDirectory)}
: >${shellQuote(remoteDirectory)}/in.jsonl
: >${shellQuote(remoteDirectory)}/out.jsonl
printf 'PocketJS SSH devtools mailbox\\n' >${shellQuote(remoteDirectory)}/enable
printf 'ARMED\\n'`;
}

export function mailboxTailRemoteScript(
  remoteDirectory: string,
  committedBytes = 0,
): string {
  if (!Number.isSafeInteger(committedBytes) || committedBytes < 0) {
    throw new Error("mailbox tail offset must be a non-negative safe integer");
  }
  return `set -eu
umask 077
mkdir -p ${shellQuote(remoteDirectory)}
touch ${shellQuote(remoteDirectory)}/out.jsonl
pocketjs_size=$(wc -c <${shellQuote(remoteDirectory)}/out.jsonl)
pocketjs_offset=${committedBytes}
if [ "$pocketjs_offset" -gt "$pocketjs_size" ]; then pocketjs_offset=0; fi
pocketjs_first=$((pocketjs_offset + 1))
exec tail -c +"$pocketjs_first" -F ${shellQuote(remoteDirectory)}/out.jsonl`;
}

export function mailboxAppendRemoteScript(remoteDirectory: string): string {
  return `set -eu
umask 077
mkdir -p ${shellQuote(remoteDirectory)}
touch ${shellQuote(remoteDirectory)}/in.jsonl
while IFS= read -r pocketjs_line; do
  printf '%s\\n' "$pocketjs_line" >>${shellQuote(remoteDirectory)}/in.jsonl
  printf 'ACK\\n'
done`;
}

export function normalizeMailboxLine(value: string): string {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("mailbox messages must be JSON objects");
  }
  return JSON.stringify(parsed);
}

export function startKindleSshMailboxBridge(
  options: KindleMailboxOptions,
): KindleMailboxBridge {
  const emit = options.onEvent ?? (() => {});
  const remoteDirectory = options.remoteDirectory ??
    `${options.connection.remoteRoot}/runtime/pocketjs-dbg`;
  let stopped = false;
  let ws: WebSocket | null = null;
  let tailProcess: ReturnType<typeof Bun.spawn> | null = null;
  let appendProcess: ReturnType<typeof Bun.spawn> | null = null;
  let deviceGeneration = 0;
  let deviceBackoff = 500;
  let deviceReconnect: ReturnType<typeof setTimeout> | null = null;
  let hubBackoff = 500;
  let hubReconnect: ReturnType<typeof setTimeout> | null = null;
  let flushing = false;
  let writerInFlight = false;
  let deviceCommittedBytes = 0;
  const outboundToHub: string[] = [];
  const outboundToDevice: string[] = [];
  const MAX_QUEUED_LINES = 10_000;

  function enqueue(queue: string[], line: string, direction: string): void {
    if (queue.length >= MAX_QUEUED_LINES) {
      emit({
        type: "error",
        detail: `${direction} queue exceeded ${MAX_QUEUED_LINES} lines; refusing silent data loss`,
      });
      throw new Error(`PocketJS Kindle mailbox ${direction} queue overflow`);
    }
    queue.push(line);
  }

  function flushHub(): void {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (outboundToHub.length > 0 && ws.bufferedAmount < 1_048_576) {
      ws.send(outboundToHub.shift()!);
    }
  }

  async function flushDevice(): Promise<void> {
    if (flushing || !appendProcess || stopped) return;
    flushing = true;
    const processForFlush = appendProcess;
    try {
      if (
        outboundToDevice.length > 0 &&
        appendProcess === processForFlush &&
        !stopped &&
        !writerInFlight
      ) {
        const sink = processForFlush.stdin;
        if (!sink || typeof sink === "number") {
          throw new Error("SSH append stdin is not writable");
        }
        writerInFlight = true;
        sink.write(outboundToDevice[0]! + "\n");
        await sink.flush();
      }
    } catch (error) {
      writerInFlight = false;
      emit({
        type: "error",
        detail: `device append failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      scheduleDeviceReconnect(deviceGeneration);
    } finally {
      flushing = false;
      if (
        !stopped &&
        !writerInFlight &&
        outboundToDevice.length > 0 &&
        appendProcess
      ) {
        void flushDevice();
      }
    }
  }

  function scheduleDeviceReconnect(generation: number): void {
    if (stopped || generation !== deviceGeneration || deviceReconnect) return;
    emit({ type: "device-lost" });
    try {
      tailProcess?.kill();
      appendProcess?.kill();
    } catch {
      // They may already have exited.
    }
    tailProcess = null;
    appendProcess = null;
    writerInFlight = false;
    const delay = deviceBackoff;
    deviceBackoff = Math.min(deviceBackoff * 2, 8_000);
    deviceReconnect = setTimeout(() => {
      deviceReconnect = null;
      connectDevice();
    }, delay);
  }

  async function readDeviceOutput(
    stream: ReadableStream<Uint8Array>,
    generation: number,
  ): Promise<void> {
    let partial = Buffer.alloc(0);
    let sawLine = false;
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (stopped || generation !== deviceGeneration) return;
        partial = Buffer.concat([partial, Buffer.from(chunk)]);
        let newline: number;
        while ((newline = partial.indexOf(0x0a)) >= 0) {
          const lineBytes = partial.subarray(0, newline);
          partial = partial.subarray(newline + 1);
          deviceCommittedBytes += newline + 1;
          const line = lineBytes.toString("utf8").trim();
          if (!line) continue;
          try {
            const normalized = normalizeMailboxLine(line);
            enqueue(outboundToHub, normalized, "device-to-hub");
            flushHub();
            if (!sawLine) {
              sawLine = true;
              emit({ type: "device-talking" });
            }
          } catch (error) {
            emit({
              type: "error",
              detail: `ignored invalid device JSONL: ${
                error instanceof Error ? error.message : String(error)
              }`,
            });
          }
        }
      }
    } catch (error) {
      if (!stopped) {
        emit({
          type: "error",
          detail: `device tail failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    } finally {
      reader.releaseLock();
    }
    scheduleDeviceReconnect(generation);
  }

  async function readAppendAcknowledgements(
    stream: ReadableStream<Uint8Array>,
    generation: number,
  ): Promise<void> {
    let partial = "";
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        if (stopped || generation !== deviceGeneration) return;
        partial += Buffer.from(chunk).toString("utf8");
        let newline: number;
        while ((newline = partial.indexOf("\n")) >= 0) {
          const line = partial.slice(0, newline).trim();
          partial = partial.slice(newline + 1);
          if (line !== "ACK" || !writerInFlight) {
            emit({
              type: "error",
              detail: `unexpected device append acknowledgement ${JSON.stringify(line)}`,
            });
            continue;
          }
          outboundToDevice.shift();
          writerInFlight = false;
          void flushDevice();
        }
      }
    } catch (error) {
      if (!stopped) {
        emit({
          type: "error",
          detail: `device append acknowledgement failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    } finally {
      reader.releaseLock();
    }
    scheduleDeviceReconnect(generation);
  }

  function connectDevice(): void {
    if (stopped) return;
    const generation = ++deviceGeneration;
    const tail = Bun.spawn(
      sshCommandArgs(
        options.connection,
        mailboxTailRemoteScript(remoteDirectory, deviceCommittedBytes),
      ),
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    const append = Bun.spawn(
      sshCommandArgs(
        options.connection,
        mailboxAppendRemoteScript(remoteDirectory),
      ),
      { stdin: "pipe", stdout: "pipe", stderr: "inherit" },
    );
    tailProcess = tail;
    appendProcess = append;
    deviceBackoff = 500;
    emit({ type: "device-connected" });
    void readDeviceOutput(
      tail.stdout as ReadableStream<Uint8Array>,
      generation,
    );
    void readAppendAcknowledgements(
      append.stdout as ReadableStream<Uint8Array>,
      generation,
    );
    void flushDevice();
    void tail.exited.then(() => scheduleDeviceReconnect(generation));
    void append.exited.then(() => scheduleDeviceReconnect(generation));
  }

  function connectHub(): void {
    if (stopped) return;
    const socket = new WebSocket(
      `ws://127.0.0.1:${options.hubPort}/ws?role=device`,
    );
    socket.onopen = () => {
      hubBackoff = 500;
      emit({ type: "hub-connected" });
      flushHub();
    };
    socket.onmessage = (event) => {
      if (typeof event.data !== "string" || !event.data.trim()) return;
      try {
        enqueue(
          outboundToDevice,
          normalizeMailboxLine(event.data),
          "hub-to-device",
        );
        void flushDevice();
      } catch (error) {
        emit({
          type: "error",
          detail: `ignored invalid hub command: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    };
    socket.onclose = () => {
      if (ws === socket) ws = null;
      if (stopped || hubReconnect) return;
      emit({ type: "hub-lost" });
      const delay = hubBackoff;
      hubBackoff = Math.min(hubBackoff * 2, 8_000);
      hubReconnect = setTimeout(() => {
        hubReconnect = null;
        connectHub();
      }, delay);
    };
    socket.onerror = () => {
      // onclose owns retry and backoff.
    };
    ws = socket;
  }

  connectDevice();
  connectHub();

  return {
    remoteDirectory,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (deviceReconnect) clearTimeout(deviceReconnect);
      if (hubReconnect) clearTimeout(hubReconnect);
      ws?.close();
      try {
        tailProcess?.kill();
        appendProcess?.kill();
      } catch {
        // Already exited.
      }
      const cleanup = Bun.spawn(
        sshCommandArgs(
          options.connection,
          `rm -f ${shellQuote(remoteDirectory)}/enable
${reloadRemoteScript(options.connection.remoteRoot)}`,
        ),
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      await cleanup.exited;
    },
  };
}

async function main(): Promise<void> {
  if (Bun.argv.includes("--help") || Bun.argv.includes("-h")) {
    console.log(`usage: bun tools/kindle-ssh-mailbox.ts [options]

Starts the Pocket DevTools panel + WebSocket hub + persistent Kindle SSH
mailbox bridge. Options: --host, --port, --user, --key, --remote-root, and
--hub-port. The panel is printed after the actual available port is selected.`);
    return;
  }
  const options = parseKindleArgs(
    ["logs", ...Bun.argv.slice(2)],
    process.env,
    process.cwd(),
  );
  if (!existsSync(options.connection.key)) {
    throw new Error(
      `kindle-mailbox: SSH key not found: ${options.connection.key}`,
    );
  }
  const mailboxDirectory =
    `${options.connection.remoteRoot}/runtime/pocketjs-dbg`;
  const server = startDevServer({
    port: options.hubPort,
    portRetries: 10,
  });
  let bridge: KindleMailboxBridge | undefined;
  let armed = false;
  try {
    const arm = Bun.spawn(
      sshCommandArgs(
        options.connection,
        armMailboxRemoteScript(mailboxDirectory),
      ),
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    const [armStatus, armOutput] = await Promise.all([
      arm.exited,
      new Response(arm.stdout).text(),
    ]);
    armed = armStatus === 0 && armOutput.trim() === "ARMED";
    if (!armed) {
      throw new Error(
        `kindle-mailbox: could not arm device mailbox (exit ${armStatus})`,
      );
    }
    bridge = startKindleSshMailboxBridge({
      connection: options.connection,
      hubPort: server.port,
      remoteDirectory: mailboxDirectory,
      onEvent(event) {
        const detail = event.detail ? ` — ${event.detail}` : "";
        const output = event.type === "error" ? console.error : console.log;
        output(`kindle-mailbox: ${event.type}${detail}`);
      },
    });
    console.log(
      `kindle-mailbox: ${bridge.remoteDirectory} ↔ ws://127.0.0.1:${server.port}/ws`,
    );
    console.log(`kindle-mailbox: panel ${server.panelUrl}`);
    // A running surface probes the mailbox only when it mounts. HUP is a
    // frame-boundary guest rebuild; ignore the expected failure when no
    // runtime is active yet.
    const attach = Bun.spawn(
      sshCommandArgs(
        options.connection,
        reloadRemoteScript(options.connection.remoteRoot),
      ),
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    void attach.exited;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    await done;
  } finally {
    if (bridge) {
      await bridge.stop();
    } else if (armed) {
      const cleanup = Bun.spawn(
        sshCommandArgs(
          options.connection,
          `rm -f ${shellQuote(mailboxDirectory)}/enable`,
        ),
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
      );
      await cleanup.exited;
    }
    server.stop();
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : `kindle-mailbox: ${error}`,
    );
    process.exit(1);
  }
}
