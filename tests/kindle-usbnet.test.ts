import { describe, expect, test } from "bun:test";
import {
  assertExplicitInterfaceAddressSafety,
  buildConnectivityProbeCommands,
  buildIfconfigCommand,
  buildPrivilegedIfconfigAppleScript,
  detectKindleUsbInterface,
  hasKindleHostAddress,
  isExplicitKindleGadgetPort,
  KindleUsbGadgetMissingError,
  parseDefaultRouteInterface,
  parseIfconfigStatus,
  parseKindleUsbNetArgs,
  parseNetworkSetupHardwarePorts,
  selectKindleUsbInterface,
  shouldConfigureKindleAddress,
  validateMacEthernetInterface,
  type MacHardwarePort,
} from "../tools/kindle-usbnet.ts";

const hardwarePortsFixture = `
Hardware Port: Ethernet Adapter (en4)
Device: en4
Ethernet Address: 6e:86:20:00:cf:e5

Hardware Port: Amazon Kindle RNDIS/Ethernet Gadget
Device: en7
Ethernet Address: 02:00:00:00:00:01

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 60:3e:5f:33:d4:27

VLAN Configurations
===================
`;

function port(
  hardwarePort: string,
  device: string,
): MacHardwarePort {
  return { hardwarePort, device };
}

describe("Kindle USBNet arguments", () => {
  test("defaults to configuration and supports an explicit read-only check", () => {
    expect(parseKindleUsbNetArgs([])).toEqual({
      check: false,
      interfaceName: undefined,
      sshPort: 2222,
      help: false,
    });
    expect(
      parseKindleUsbNetArgs([
        "--check",
        "--interface",
        "en7",
        "--port=22022",
      ]),
    ).toEqual({
      check: true,
      interfaceName: "en7",
      sshPort: 22022,
      help: false,
    });
    expect(parseKindleUsbNetArgs(["--interface=en9", "--help"])).toMatchObject({
      interfaceName: "en9",
      help: true,
    });
  });

  test("rejects unsafe or malformed interface and port arguments", () => {
    for (const interfaceName of ["en0", "en", "en-1", "eth0", "en7;id", "en7 up"]) {
      expect(() => validateMacEthernetInterface(interfaceName)).toThrow();
    }
    expect(() => parseKindleUsbNetArgs(["--interface", "en7", "--interface=en8"])).toThrow(
      "only be provided once",
    );
    expect(() => parseKindleUsbNetArgs(["--port", "22"])).toThrow(
      "between 1024 and 65535",
    );
    expect(() => parseKindleUsbNetArgs(["--port=not-a-port"])).toThrow(
      "between 1024 and 65535",
    );
    expect(() => parseKindleUsbNetArgs(["--driver"])).toThrow("unknown argument");
  });
});

describe("macOS hardware-port parsing and Kindle gadget detection", () => {
  test("parses networksetup blocks and ignores its trailing VLAN section", () => {
    expect(parseNetworkSetupHardwarePorts(hardwarePortsFixture)).toEqual([
      {
        hardwarePort: "Ethernet Adapter (en4)",
        device: "en4",
        ethernetAddress: "6e:86:20:00:cf:e5",
      },
      {
        hardwarePort: "Amazon Kindle RNDIS/Ethernet Gadget",
        device: "en7",
        ethernetAddress: "02:00:00:00:00:01",
      },
      {
        hardwarePort: "Wi-Fi",
        device: "en0",
        ethernetAddress: "60:3e:5f:33:d4:27",
      },
    ]);
  });

  test("auto-matches only clearly named Kindle/RNDIS/gadget ports", () => {
    for (const name of [
      "Kindle",
      "Amazon Kindle USB",
      "RNDIS",
      "RNDIS/Ethernet Gadget",
      "Ethernet Gadget",
      "USB Gadget",
    ]) {
      expect(isExplicitKindleGadgetPort(name)).toBe(true);
    }
    for (const name of [
      "Ethernet Adapter (en4)",
      "USB 10/100/1000 LAN",
      "USB Ethernet",
      "Wi-Fi",
      "Kindleberry Adapter",
    ]) {
      expect(isExplicitKindleGadgetPort(name)).toBe(false);
    }

    const detection = detectKindleUsbInterface(
      parseNetworkSetupHardwarePorts(hardwarePortsFixture),
    );
    expect(detection).toEqual({
      status: "found",
      candidate: {
        hardwarePort: "Amazon Kindle RNDIS/Ethernet Gadget",
        device: "en7",
        ethernetAddress: "02:00:00:00:00:01",
      },
    });
  });

  test("does not guess between multiple explicit gadget candidates", () => {
    const ports = [
      port("Kindle USB Gadget", "en7"),
      port("RNDIS/Ethernet Gadget", "en8"),
    ];
    expect(detectKindleUsbInterface(ports)).toMatchObject({
      status: "ambiguous",
      candidates: ports,
    });
    expect(() => selectKindleUsbInterface(ports, "en0")).toThrow(
      "multiple Kindle USB gadget interfaces",
    );
    expect(() => selectKindleUsbInterface(ports, "en0")).toThrow(
      "pass --interface enN",
    );
  });

  test("reports a missing gadget instead of treating a generic adapter as Kindle", () => {
    const ports = [
      port("Ethernet Adapter (en4)", "en4"),
      port("USB 10/100/1000 LAN", "en5"),
      port("Wi-Fi", "en0"),
    ];
    expect(detectKindleUsbInterface(ports)).toEqual({
      status: "missing",
      candidates: [],
    });
    expect(() => selectKindleUsbInterface(ports, "en0")).toThrow(
      KindleUsbGadgetMissingError,
    );
  });

  test("supports an explicit generic enN but rejects Wi-Fi and default-route devices", () => {
    const ports = [
      port("Ethernet Adapter (en7)", "en7"),
      port("Wi-Fi", "en8"),
    ];
    expect(selectKindleUsbInterface(ports, "en0", "en7")).toEqual({
      interfaceName: "en7",
      hardwarePort: "Ethernet Adapter (en7)",
      explicitlySelected: true,
    });
    expect(() => selectKindleUsbInterface(ports, "en7", "en7")).toThrow(
      "default route",
    );
    expect(() => selectKindleUsbInterface(ports, "en0", "en8")).toThrow(
      "identifies it as Wi-Fi",
    );
    expect(() => selectKindleUsbInterface(ports, "en0", "en9")).toThrow(
      "not present",
    );
    expect(() => selectKindleUsbInterface(ports, "en0", "en0")).toThrow(
      "never reconfigures",
    );
  });

  test("parses the interface from route get default", () => {
    expect(
      parseDefaultRouteInterface(`
   route to: default
destination: default
    gateway: 192.168.71.1
  interface: en0
`),
    ).toBe("en0");
    expect(parseDefaultRouteInterface("route: writing to routing socket: not in table")).toBe(
      undefined,
    );
  });
});

describe("temporary address plan and read-only probes", () => {
  const configuredIfconfig = `en7: flags=8863<UP,BROADCAST,SMART,RUNNING,SIMPLEX,MULTICAST> mtu 1500
\toptions=400<CHANNEL_IO>
\tinet6 fe80::1%en7 prefixlen 64 scopeid 0x1b
\tinet 192.168.15.201 netmask 0xffffff00 broadcast 192.168.15.255
\tnd6 options=201<PERFORMNUD,DAD>
\tstatus: active
`;

  test("recognizes the exact temporary host address and netmask", () => {
    const status = parseIfconfigStatus(configuredIfconfig);
    expect(status).toEqual({
      up: true,
      linkStatus: "active",
      ipv4: [{ address: "192.168.15.201", netmask: "255.255.255.0" }],
    });
    expect(hasKindleHostAddress(status)).toBe(true);

    expect(
      hasKindleHostAddress(
        parseIfconfigStatus(
          configuredIfconfig.replace("0xffffff00", "0xffff0000"),
        ),
      ),
    ).toBe(false);
    expect(
      hasKindleHostAddress(
        parseIfconfigStatus(configuredIfconfig.replace("<UP,", "<")),
      ),
    ).toBe(false);
  });

  test("--check can never produce a mutating address action", () => {
    const unconfigured = parseIfconfigStatus(
      configuredIfconfig.replace("192.168.15.201", "169.254.10.20"),
    );
    expect(shouldConfigureKindleAddress(true, unconfigured)).toBe(false);
    expect(shouldConfigureKindleAddress(false, unconfigured)).toBe(true);
    expect(shouldConfigureKindleAddress(false, parseIfconfigStatus(configuredIfconfig))).toBe(
      false,
    );
  });

  test("refuses to overwrite a real IPv4 on an explicitly selected generic interface", () => {
    const explicit = {
      interfaceName: "en7",
      hardwarePort: "Ethernet Adapter (en7)",
      explicitlySelected: true,
    } as const;
    const businessNetwork = parseIfconfigStatus(
      configuredIfconfig.replace("192.168.15.201", "10.20.30.40"),
    );
    expect(() =>
      assertExplicitInterfaceAddressSafety(explicit, businessNetwork, false),
    ).toThrow("already has non-link-local IPv4 10.20.30.40");

    expect(() =>
      assertExplicitInterfaceAddressSafety(explicit, businessNetwork, true),
    ).not.toThrow();
    expect(() =>
      assertExplicitInterfaceAddressSafety(
        explicit,
        parseIfconfigStatus(
          configuredIfconfig.replace("192.168.15.201", "169.254.10.20"),
        ),
        false,
      ),
    ).not.toThrow();
    expect(() =>
      assertExplicitInterfaceAddressSafety(
        { ...explicit, explicitlySelected: false },
        businessNetwork,
        false,
      ),
    ).not.toThrow();
  });

  test("builds one fixed, injection-safe privileged ifconfig command", () => {
    expect(buildIfconfigCommand("en7")).toEqual([
      "/sbin/ifconfig",
      "en7",
      "inet",
      "192.168.15.201",
      "netmask",
      "255.255.255.0",
      "up",
    ]);
    expect(buildPrivilegedIfconfigAppleScript("en7")).toBe(
      'do shell script "/sbin/ifconfig en7 inet 192.168.15.201 netmask 255.255.255.0 up" ' +
        'with prompt "PocketJS needs administrator access to configure the temporary Kindle USB network." ' +
        "with administrator privileges",
    );
    expect(() => buildPrivilegedIfconfigAppleScript("en7; touch /tmp/bad")).toThrow();
  });

  test("uses read-only, bounded ping and SSH TCP-port probes", () => {
    expect(buildConnectivityProbeCommands(2222)).toEqual({
      ping: [
        "/sbin/ping",
        "-n",
        "-c",
        "1",
        "-W",
        "1000",
        "192.168.15.244",
      ],
      sshPort: [
        "/usr/bin/nc",
        "-4",
        "-z",
        "-w",
        "2",
        "192.168.15.244",
        "2222",
      ],
    });
    expect(() => buildConnectivityProbeCommands(22)).toThrow(
      "between 1024 and 65535",
    );
  });
});
