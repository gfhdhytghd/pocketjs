#!/usr/bin/env bun

/**
 * Configure the temporary macOS side of the PocketJS Kindle USB network.
 *
 * This deliberately uses only macOS built-ins. It does not install a driver,
 * create a persistent Network Service, or alter DNS/default-route settings.
 */

import { KINDLE_USB_NETWORK } from "./kindle-bootstrap.ts";

const NETWORKSETUP = "/usr/sbin/networksetup";
const ROUTE = "/sbin/route";
const IFCONFIG = "/sbin/ifconfig";
const PING = "/sbin/ping";
const NETCAT = "/usr/bin/nc";
const OSASCRIPT = "/usr/bin/osascript";

export const DEFAULT_KINDLE_SSH_PORT = 2222;

export interface KindleUsbNetOptions {
  readonly check: boolean;
  readonly interfaceName?: string;
  readonly sshPort: number;
  readonly help: boolean;
}

export interface MacHardwarePort {
  readonly hardwarePort: string;
  readonly device: string;
  readonly ethernetAddress?: string;
}

export type KindleInterfaceDetection =
  | {
      readonly status: "found";
      readonly candidate: MacHardwarePort;
    }
  | {
      readonly status: "missing";
      readonly candidates: readonly [];
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly MacHardwarePort[];
    };

export interface SelectedUsbInterface {
  readonly interfaceName: string;
  readonly hardwarePort: string;
  readonly explicitlySelected: boolean;
}

export interface InterfaceAddress {
  readonly address: string;
  readonly netmask?: string;
}

export interface InterfaceStatus {
  readonly up: boolean;
  readonly linkStatus?: string;
  readonly ipv4: readonly InterfaceAddress[];
}

export interface ConnectivityProbeCommands {
  readonly ping: readonly string[];
  readonly sshPort: readonly string[];
}

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function usageText(): string {
  return [
    "usage: bun tools/kindle-usbnet.ts [options]",
    "",
    "Configure a temporary macOS address for PocketJS Kindle USB networking.",
    "Only explicit Kindle/RNDIS/Ethernet Gadget/USB Gadget hardware ports are",
    "auto-selected; use --interface for a generic macOS Ethernet Adapter name.",
    "",
    "options:",
    "  --check              Read-only status, ping, and SSH-port checks",
    "  --interface <enN>    Explicit macOS USB interface (for example en7)",
    "  --port <port>        Kindle Dropbear port (default: 2222)",
    "  -h, --help           Show this help",
    "",
    `target: ${KINDLE_USB_NETWORK.hostIp} netmask ${KINDLE_USB_NETWORK.netmask}`,
    `Kindle: ${KINDLE_USB_NETWORK.kindleIp}`,
    "",
    "No third-party kernel or network driver is installed by this tool.",
  ].join("\n");
}

function requiredOptionValue(
  argv: readonly string[],
  index: number,
  flag: string,
): { readonly value: string; readonly nextIndex: number } {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return { value, nextIndex: index + 1 };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("--port must be an integer between 1024 and 65535");
  }
  return port;
}

/**
 * Accept only the macOS Ethernet device namespace. This is intentionally more
 * restrictive than a general ifconfig interface parser because the value is
 * later included in a privileged command.
 */
export function validateMacEthernetInterface(value: string): string {
  if (!/^en[0-9]+$/.test(value)) {
    throw new Error("--interface must be a macOS Ethernet interface such as en7");
  }
  if (value === "en0") {
    throw new Error("refusing --interface en0: PocketJS never reconfigures the primary/Wi-Fi interface");
  }
  return value;
}

export function parseKindleUsbNetArgs(argv: readonly string[]): KindleUsbNetOptions {
  let check = false;
  let interfaceName: string | undefined;
  let sshPort = DEFAULT_KINDLE_SSH_PORT;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--interface") {
      if (interfaceName !== undefined) throw new Error("--interface may only be provided once");
      const parsed = requiredOptionValue(argv, index, arg);
      interfaceName = validateMacEthernetInterface(parsed.value);
      index = parsed.nextIndex;
    } else if (arg.startsWith("--interface=")) {
      if (interfaceName !== undefined) throw new Error("--interface may only be provided once");
      interfaceName = validateMacEthernetInterface(arg.slice("--interface=".length));
    } else if (arg === "--port") {
      const parsed = requiredOptionValue(argv, index, arg);
      sshPort = parsePort(parsed.value);
      index = parsed.nextIndex;
    } else if (arg.startsWith("--port=")) {
      sshPort = parsePort(arg.slice("--port=".length));
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      throw new Error(`unknown argument: ${arg}\n\n${usageText()}`);
    }
  }

  return { check, interfaceName, sshPort, help };
}

export function parseNetworkSetupHardwarePorts(output: string): MacHardwarePort[] {
  const ports: MacHardwarePort[] = [];
  let hardwarePort: string | undefined;
  let device: string | undefined;
  let ethernetAddress: string | undefined;

  const flush = (): void => {
    if (hardwarePort && device) {
      ports.push({
        hardwarePort,
        device,
        ...(ethernetAddress ? { ethernetAddress } : {}),
      });
    }
    hardwarePort = undefined;
    device = undefined;
    ethernetAddress = undefined;
  };

  for (const rawLine of output.replaceAll("\r\n", "\n").split("\n")) {
    const line = rawLine.trim();
    const portMatch = /^Hardware Port:\s*(.+)$/.exec(line);
    if (portMatch) {
      flush();
      hardwarePort = portMatch[1].trim();
      continue;
    }
    const deviceMatch = /^Device:\s*(\S+)$/.exec(line);
    if (deviceMatch) {
      device = deviceMatch[1];
      continue;
    }
    const addressMatch = /^Ethernet Address:\s*(\S+)$/.exec(line);
    if (addressMatch) {
      ethernetAddress = addressMatch[1];
      continue;
    }
    if (line === "") flush();
  }
  flush();

  return ports;
}

export function isExplicitKindleGadgetPort(hardwarePort: string): boolean {
  const normalized = hardwarePort
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return (
    /\bkindle\b/.test(normalized) ||
    /\brndis\b/.test(normalized) ||
    /\bethernet gadget\b/.test(normalized) ||
    /\busb gadget\b/.test(normalized)
  );
}

function uniquePortsByDevice(ports: readonly MacHardwarePort[]): MacHardwarePort[] {
  const byDevice = new Map<string, MacHardwarePort>();
  for (const port of ports) {
    if (!byDevice.has(port.device)) byDevice.set(port.device, port);
  }
  return [...byDevice.values()];
}

export function detectKindleUsbInterface(
  ports: readonly MacHardwarePort[],
): KindleInterfaceDetection {
  const candidates = uniquePortsByDevice(
    ports.filter(
      (port) =>
        /^en[0-9]+$/.test(port.device) &&
        isExplicitKindleGadgetPort(port.hardwarePort),
    ),
  );
  if (candidates.length === 0) return { status: "missing", candidates: [] };
  if (candidates.length === 1) return { status: "found", candidate: candidates[0] };
  return { status: "ambiguous", candidates };
}

export function parseDefaultRouteInterface(output: string): string | undefined {
  return /^\s*interface:\s*(\S+)\s*$/m.exec(output)?.[1];
}

function isWifiHardwarePort(hardwarePort: string): boolean {
  const normalized = hardwarePort.replaceAll("-", "").replace(/\s+/g, "").toLowerCase();
  return normalized === "wifi" || normalized === "airport";
}

function assertInterfaceSafety(
  interfaceName: string,
  port: MacHardwarePort,
  defaultRouteInterface: string | undefined,
): void {
  validateMacEthernetInterface(interfaceName);
  if (isWifiHardwarePort(port.hardwarePort)) {
    throw new Error(
      `refusing ${interfaceName}: networksetup identifies it as ${port.hardwarePort}`,
    );
  }
  if (defaultRouteInterface === interfaceName) {
    throw new Error(
      `refusing ${interfaceName}: it currently carries the macOS default route`,
    );
  }
}

/**
 * Resolve a safe interface without guessing. A generic "Ethernet Adapter" is
 * accepted only when the caller explicitly supplies its enN device name.
 */
export function selectKindleUsbInterface(
  ports: readonly MacHardwarePort[],
  defaultRouteInterface: string | undefined,
  explicitInterface?: string,
): SelectedUsbInterface {
  if (explicitInterface !== undefined) {
    validateMacEthernetInterface(explicitInterface);
    const matchingPorts = ports.filter((port) => port.device === explicitInterface);
    if (matchingPorts.length === 0) {
      throw new Error(
        `interface ${explicitInterface} is not present in networksetup output; ` +
          "connect/enable the Kindle USB gadget and retry",
      );
    }
    const port = matchingPorts[0];
    assertInterfaceSafety(explicitInterface, port, defaultRouteInterface);
    return {
      interfaceName: explicitInterface,
      hardwarePort: port.hardwarePort,
      explicitlySelected: true,
    };
  }

  const detected = detectKindleUsbInterface(ports);
  if (detected.status === "missing") {
    throw new KindleUsbGadgetMissingError(ports);
  }
  if (detected.status === "ambiguous") {
    const choices = detected.candidates
      .map((candidate) => `${candidate.device} (${candidate.hardwarePort})`)
      .join(", ");
    throw new Error(
      `multiple Kindle USB gadget interfaces are visible: ${choices}; ` +
        "refusing to guess, pass --interface enN explicitly",
    );
  }

  const { candidate } = detected;
  assertInterfaceSafety(candidate.device, candidate, defaultRouteInterface);
  return {
    interfaceName: candidate.device,
    hardwarePort: candidate.hardwarePort,
    explicitlySelected: false,
  };
}

export class KindleUsbGadgetMissingError extends Error {
  readonly ports: readonly MacHardwarePort[];

  constructor(ports: readonly MacHardwarePort[]) {
    super("no explicitly named Kindle USB network gadget is visible");
    this.name = "KindleUsbGadgetMissingError";
    this.ports = ports;
  }
}

function normalizeNetmask(netmask: string | undefined): string | undefined {
  if (!netmask) return undefined;
  if (/^0x[0-9a-fA-F]{8}$/.test(netmask)) {
    const hex = netmask.slice(2);
    return [0, 2, 4, 6]
      .map((offset) => String(Number.parseInt(hex.slice(offset, offset + 2), 16)))
      .join(".");
  }
  return netmask;
}

export function parseIfconfigStatus(output: string): InterfaceStatus {
  const firstLine = output.split("\n", 1)[0] ?? "";
  const flags = /flags=\d+<([^>]*)>/.exec(firstLine)?.[1].split(",") ?? [];
  const linkStatus = /^\s*status:\s*(\S+)\s*$/m.exec(output)?.[1];
  const ipv4: InterfaceAddress[] = [];
  const addressPattern = /^\s*inet\s+(\d+(?:\.\d+){3})(?:\s+netmask\s+(\S+))?/gm;
  for (const match of output.matchAll(addressPattern)) {
    ipv4.push({
      address: match[1],
      ...(match[2] ? { netmask: normalizeNetmask(match[2]) } : {}),
    });
  }
  return {
    up: flags.includes("UP"),
    ...(linkStatus ? { linkStatus } : {}),
    ipv4,
  };
}

export function hasKindleHostAddress(status: InterfaceStatus): boolean {
  return (
    status.up &&
    status.ipv4.some(
      (entry) =>
        entry.address === KINDLE_USB_NETWORK.hostIp &&
        entry.netmask === KINDLE_USB_NETWORK.netmask,
    )
  );
}

function isLinkLocalIpv4(address: string): boolean {
  return /^169\.254\./.test(address);
}

/**
 * An explicit generic enN is an informed escape hatch for macOS gadget names,
 * not permission to replace an address that belongs to another network. Keep
 * --check useful for read-only diagnosis, but fail closed before configuring.
 */
export function assertExplicitInterfaceAddressSafety(
  selected: SelectedUsbInterface,
  status: InterfaceStatus,
  checkOnly: boolean,
): void {
  if (!selected.explicitlySelected || checkOnly) return;

  const conflictingAddresses = status.ipv4
    .map((entry) => entry.address)
    .filter(
      (address) =>
        address !== KINDLE_USB_NETWORK.hostIp &&
        !isLinkLocalIpv4(address),
    );
  if (conflictingAddresses.length === 0) return;

  throw new Error(
    `refusing to configure ${selected.interfaceName}: the explicitly selected interface ` +
      `already has non-link-local IPv4 ${conflictingAddresses.join(", ")}; ` +
      "use --check to inspect it and verify the Kindle gadget's newly appeared enN",
  );
}

export function shouldConfigureKindleAddress(
  checkOnly: boolean,
  status: InterfaceStatus,
): boolean {
  return !checkOnly && !hasKindleHostAddress(status);
}

export function buildIfconfigCommand(interfaceName: string): readonly string[] {
  validateMacEthernetInterface(interfaceName);
  return [
    IFCONFIG,
    interfaceName,
    "inet",
    KINDLE_USB_NETWORK.hostIp,
    "netmask",
    KINDLE_USB_NETWORK.netmask,
    "up",
  ];
}

export function buildPrivilegedIfconfigAppleScript(interfaceName: string): string {
  const command = buildIfconfigCommand(interfaceName).join(" ");
  return (
    `do shell script "${command}" ` +
    'with prompt "PocketJS needs administrator access to configure the temporary Kindle USB network." ' +
    "with administrator privileges"
  );
}

export function buildConnectivityProbeCommands(
  sshPort: number,
): ConnectivityProbeCommands {
  const port = parsePort(String(sshPort));
  return {
    ping: [
      PING,
      "-n",
      "-c",
      "1",
      "-W",
      "1000",
      KINDLE_USB_NETWORK.kindleIp,
    ],
    sshPort: [
      NETCAT,
      "-4",
      "-z",
      "-w",
      "2",
      KINDLE_USB_NETWORK.kindleIp,
      String(port),
    ],
  };
}

function decode(data: Uint8Array): string {
  return new TextDecoder().decode(data).trim();
}

function runCommand(argv: readonly string[]): CommandResult {
  const result = Bun.spawnSync([...argv], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
  };
}

function checkedOutput(argv: readonly string[], label: string): string {
  const result = runCommand(argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode})` +
        `${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  }
  return result.stdout;
}

function readInterfaceStatus(interfaceName: string): InterfaceStatus {
  return parseIfconfigStatus(
    checkedOutput([IFCONFIG, interfaceName], `reading interface ${interfaceName}`),
  );
}

function printMissingGadgetGuidance(ports: readonly MacHardwarePort[]): void {
  console.error("PocketJS Kindle USBNet: no clearly named Kindle USB gadget is visible.");
  console.error("");
  console.error("On the Kindle / at the USB cable:");
  console.error("  1. Cleanly eject the Kindle storage volume in Finder.");
  console.error("  2. Keep USB connected, then launch PocketJS-Dev-Start.sh from PEKI/KUAL.");
  console.error("  3. Wait for USB storage to disappear and the network gadget to enumerate.");
  console.error("  4. Rerun this command.");
  const ethernetPorts = ports.filter((port) => /^en[0-9]+$/.test(port.device));
  if (ethernetPorts.length > 0) {
    console.error("");
    console.error("macOS currently reports these Ethernet devices:");
    for (const port of ethernetPorts) {
      console.error(`  ${port.device}: ${port.hardwarePort}`);
    }
    console.error(
      "If macOS gives the newly appeared gadget a generic name, identify that new enN",
    );
    console.error("by disconnect/reconnect comparison, then pass --interface enN explicitly.");
  }
  console.error("");
  console.error("This tool intentionally does not install HoRNDIS or any third-party driver.");
}

function printInterfaceStatus(status: InterfaceStatus): void {
  const addresses =
    status.ipv4.length > 0
      ? status.ipv4
          .map((entry) => `${entry.address}${entry.netmask ? `/${entry.netmask}` : ""}`)
          .join(", ")
      : "none";
  console.log(`  link: ${status.linkStatus ?? "unknown"}; flags: ${status.up ? "UP" : "not UP"}`);
  console.log(`  IPv4: ${addresses}`);
  console.log(
    `  host target: ${hasKindleHostAddress(status) ? "configured" : "not configured"}`,
  );
}

function configureInterface(interfaceName: string): void {
  const command = buildIfconfigCommand(interfaceName);
  console.log(`  privileged command: ${command.join(" ")}`);
  const result = runCommand([
    OSASCRIPT,
    "-e",
    buildPrivilegedIfconfigAppleScript(interfaceName),
  ]);
  if (result.exitCode !== 0) {
    if (/cancel|canceled|-128/i.test(result.stderr)) {
      throw new Error("administrator authorization was cancelled; no interface change was made");
    }
    throw new Error(
      `privileged ifconfig failed (exit ${result.exitCode})` +
        `${result.stderr ? `: ${result.stderr}` : ""}`,
    );
  }
}

function runConnectivityProbes(sshPort: number): {
  readonly ping: boolean;
  readonly sshPort: boolean;
} {
  const commands = buildConnectivityProbeCommands(sshPort);
  return {
    ping: runCommand(commands.ping).exitCode === 0,
    sshPort: runCommand(commands.sshPort).exitCode === 0,
  };
}

async function main(): Promise<number> {
  const options = parseKindleUsbNetArgs(Bun.argv.slice(2));
  if (options.help) {
    console.log(usageText());
    return 0;
  }
  if (process.platform !== "darwin") {
    throw new Error("this helper configures macOS only; use your OS network tools manually");
  }

  const hardwarePorts = parseNetworkSetupHardwarePorts(
    checkedOutput([NETWORKSETUP, "-listallhardwareports"], "networksetup discovery"),
  );
  const routeResult = runCommand([ROUTE, "-n", "get", "default"]);
  const defaultRouteInterface = parseDefaultRouteInterface(
    `${routeResult.stdout}\n${routeResult.stderr}`,
  );

  let selected: SelectedUsbInterface;
  try {
    selected = selectKindleUsbInterface(
      hardwarePorts,
      defaultRouteInterface,
      options.interfaceName,
    );
  } catch (error) {
    if (error instanceof KindleUsbGadgetMissingError) {
      printMissingGadgetGuidance(error.ports);
      return 2;
    }
    throw error;
  }

  console.log("PocketJS Kindle USBNet");
  console.log(`  mode: ${options.check ? "read-only check" : "temporary configuration"}`);
  console.log(
    `  interface: ${selected.interfaceName} (${selected.hardwarePort})` +
      `${selected.explicitlySelected ? " [explicit]" : " [auto-detected]"}`,
  );
  console.log(`  macOS default route: ${defaultRouteInterface ?? "none detected"}`);
  console.log(
    `  target: ${KINDLE_USB_NETWORK.hostIp} netmask ${KINDLE_USB_NETWORK.netmask}`,
  );

  let status = readInterfaceStatus(selected.interfaceName);
  console.log("Current interface state:");
  printInterfaceStatus(status);
  assertExplicitInterfaceAddressSafety(selected, status, options.check);

  if (shouldConfigureKindleAddress(options.check, status)) {
    console.log("Applying one temporary address (no Network Service, DNS, or route changes):");
    configureInterface(selected.interfaceName);
    status = readInterfaceStatus(selected.interfaceName);
    if (!hasKindleHostAddress(status)) {
      throw new Error(
        `ifconfig completed but ${selected.interfaceName} does not have ` +
          `${KINDLE_USB_NETWORK.hostIp}/${KINDLE_USB_NETWORK.netmask}`,
      );
    }
    console.log("  ✓ temporary host address is configured");
  } else if (options.check) {
    console.log("  read-only: no authorization requested and no network state changed");
  } else {
    console.log("  ✓ temporary host address was already configured; no authorization needed");
  }

  console.log("Read-only connectivity checks:");
  const probes = runConnectivityProbes(options.sshPort);
  console.log(
    `  ${probes.ping ? "✓" : "✗"} ping ${KINDLE_USB_NETWORK.kindleIp}`,
  );
  console.log(
    `  ${probes.sshPort ? "✓" : "✗"} SSH TCP ${KINDLE_USB_NETWORK.kindleIp}:${options.sshPort}`,
  );

  if (!hasKindleHostAddress(status)) {
    console.log("");
    console.log(
      `Host address is not configured. Rerun without --check` +
        `${options.interfaceName ? ` --interface ${options.interfaceName}` : ""}.`,
    );
    return 2;
  }
  if (!probes.sshPort) {
    console.log("");
    console.log("The macOS side is configured, but Kindle SSH is not reachable.");
    console.log("Run PocketJS-Dev-Start.sh on the Kindle, wait a few seconds, then use --check.");
    return 2;
  }
  if (!probes.ping) {
    console.log("  note: ICMP did not answer, but the SSH TCP port is reachable");
  }
  console.log("  ✓ Kindle USBNet is ready for PocketJS deploy/debug");
  return 0;
}

if (import.meta.main) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(
        `PocketJS Kindle USBNet failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    });
}
