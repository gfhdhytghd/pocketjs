import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  nokiaN9PackageIdentity,
  mapNokiaN9Touch,
  normalizeNokiaN9Frame,
  parseNokiaN9Status,
  validateNokiaN9CaptureReceipts,
  validateNokiaN9Status,
} from "../tools/nokia-n9.ts";
import { resolveNokiaN9BuildPlan } from "../tools/nokia-n9-profile.ts";

const root = resolve(import.meta.dir, "..");
const manifest = () => JSON.parse(readFileSync(
  resolve(root, "apps/nokia-n9-demo/pocket.json"),
  "utf8",
));

function status(overrides: Record<string, unknown> = {}) {
  return {
    schema: 1,
    build_id: "0123456789abcdef01234567",
    target: "nokia-n9-dev",
    host_abi: 9,
    pid: 42,
    state: "running",
    error: "",
    heartbeat: 10,
    guest_frames: 10,
    presented_frames: 10,
    logical_width: 854,
    logical_height: 480,
    physical_width: 854,
    physical_height: 480,
    orientation: "landscape",
    quarter_turns: 0,
    orientation_transitions: 2,
    context_generation: 1,
    display_active: true,
    tick_hz: 60,
    renderer: "gles2",
    gl_version: "OpenGL ES 2.0",
    gl_vendor: "Imagination Technologies",
    gl_renderer: "PowerVR SGX 530",
    gl_max_texture_size: 2048,
    completed_touch_sequences: 2,
    action_name: "hero_tap",
    action_value: 2,
    action_sequence: 2,
    timings_us: {
      javascript: 500,
      pending_jobs: 50,
      core_tick: 300,
      gl_submit: 700,
      swap: 15000,
      total: 16550,
    },
    fps_window: {
      samples: 600,
      warmup_remaining: 0,
      average_hz: 60,
      p95_ms: 17,
      max_ms: 18,
      missed_vblanks: 0,
    },
    ...overrides,
  };
}

describe("Nokia N9 runtime and acceptance contracts", () => {
  test("derives stable Debian identity from the dedicated manifest", () => {
    const source = manifest();
    const identity = nokiaN9PackageIdentity(resolveNokiaN9BuildPlan(source), source);
    expect(identity).toEqual({
      packageName: "pocketjs-nokia-n9-hero",
      executable: "nokia-n9-demo-main",
      title: "PocketJS: Nokia N9 Hero",
      version: "0.1.0",
      output: "nokia-n9-demo-main",
    });
  });

  test("rejects stale, stalled, non-GLES and actionless status", () => {
    const buildId = status().build_id;
    expect(() => validateNokiaN9Status(
      status({ heartbeat: 1, presented_frames: 1 }) as any,
      status({ heartbeat: 2, presented_frames: 2 }) as any,
      buildId,
      true,
    )).not.toThrow();
    expect(() => validateNokiaN9Status(status() as any, status() as any, buildId, false))
      .toThrow("did not advance");
    expect(() => validateNokiaN9Status(
      status() as any,
      status({ heartbeat: 11, presented_frames: 11, renderer: "software" }) as any,
      buildId,
      false,
    )).toThrow("60 Hz GLES2");
    expect(() => validateNokiaN9Status(
      status() as any,
      status({ heartbeat: 11, presented_frames: 11, physical_width: 480 }) as any,
      buildId,
      false,
    )).toThrow("viewport or visibility");
    expect(() => validateNokiaN9Status(
      status() as any,
      status({ heartbeat: 11, presented_frames: 11, action_sequence: 0 }) as any,
      buildId,
      true,
    )).toThrow("Hero touch/action");
  });

  test("parses only schema-1 ABI-9 N9 receipts", () => {
    expect(parseNokiaN9Status(JSON.stringify(status())).host_abi).toBe(9);
    expect(() => parseNokiaN9Status(JSON.stringify(status({ host_abi: 8 }))))
      .toThrow("incompatible");
  });

  test("normalizes bottom-up GLES captures through all quarter turns", () => {
    // Physical top-down colors: A B / C D / E F. Raw GLES rows are reversed.
    const pixel = (value: number) => [value, 0, 0, 255];
    const raw = Uint8Array.from([
      ...pixel(5), ...pixel(6),
      ...pixel(3), ...pixel(4),
      ...pixel(1), ...pixel(2),
    ]);
    const red = (turns: number) => {
      const frame = normalizeNokiaN9Frame(raw, 2, 3, turns);
      return {
        size: [frame.width, frame.height],
        values: Array.from(frame.rgba).filter((_, index) => index % 4 === 0),
      };
    };
    expect(red(0)).toEqual({ size: [2, 3], values: [1, 2, 3, 4, 5, 6] });
    expect(red(1)).toEqual({ size: [3, 2], values: [2, 4, 6, 1, 3, 5] });
    expect(red(2)).toEqual({ size: [2, 3], values: [6, 5, 4, 3, 2, 1] });
    expect(red(3)).toEqual({ size: [3, 2], values: [5, 3, 1, 6, 4, 2] });
  });

  test("maps all physical touch corners through four quarter turns", () => {
    const corners = (turns: number) => {
      const physicalWidth = turns & 1 ? 2 : 3;
      const physicalHeight = turns & 1 ? 3 : 2;
      return [
        mapNokiaN9Touch(0, 0, 3, 2, turns),
        mapNokiaN9Touch(physicalWidth - 1, 0, 3, 2, turns),
        mapNokiaN9Touch(0, physicalHeight - 1, 3, 2, turns),
        mapNokiaN9Touch(physicalWidth - 1, physicalHeight - 1, 3, 2, turns),
      ];
    };
    expect(corners(0)).toEqual([
      { x: 0, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 1 }, { x: 2, y: 1 },
    ]);
    expect(corners(1)).toEqual([
      { x: 0, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 1 }, { x: 2, y: 0 },
    ]);
    expect(corners(2)).toEqual([
      { x: 2, y: 1 }, { x: 0, y: 1 }, { x: 2, y: 0 }, { x: 0, y: 0 },
    ]);
    expect(corners(3)).toEqual([
      { x: 2, y: 0 }, { x: 2, y: 1 }, { x: 0, y: 0 }, { x: 0, y: 1 },
    ]);
  });

  test("requires three aligned byte-identical captures in both orientations", () => {
    const buildId = status().build_id;
    const make = (
      orientation: "landscape" | "portrait",
      sequence: number,
      hash = "a".repeat(64),
    ) => ({
      schema: 1 as const,
      build_id: buildId,
      orientation,
      sequence,
      width: 854,
      height: 480,
      quarter_turns: orientation === "landscape" ? 0 : 3,
      guest_frame: sequence * 24,
      gl_version: "OpenGL ES 2.0",
      gl_vendor: "Imagination Technologies",
      gl_renderer: "PowerVR SGX 530",
      raw_sha256: hash,
      device_fingerprint: "firmware-and-gl",
      device: {
        schema: 1 as const,
        model: "RM696",
        arch: "armv7l",
        kernel: "2.6.32-dfl61",
        harmattan: "40.2012.21-3",
        qt: "4.7.4",
      },
    });
    const complete = [
      ...[1, 2, 3].map((sequence) => make("landscape", sequence)),
      ...[1, 2, 3].map((sequence) => make("portrait", sequence)),
    ];
    expect(validateNokiaN9CaptureReceipts(complete, buildId)).toBe("firmware-and-gl");
    expect(() => validateNokiaN9CaptureReceipts(complete.slice(1), buildId))
      .toThrow("three byte-identical");
    expect(() => validateNokiaN9CaptureReceipts([
      ...complete.slice(0, -1),
      make("portrait", 3, "b".repeat(64)),
    ], buildId)).toThrow("three byte-identical");
  });

  test("shares E7 HostOps while adding live rotation, hit facts, status and capture", () => {
    const runtime = readFileSync(resolve(root, "hosts/symbian/runtime/main.cpp"), "utf8");
    const cli = readFileSync(resolve(root, "tools/nokia-n9.ts"), "utf8");
    expect(runtime).toContain("POCKETJS_TARGET_ID");
    expect(runtime).toContain('"hitTestBounds"');
    expect(runtime).toContain("JSValue arguments[4]");
    expect(runtime).toContain("ui_gl_render_rotated");
    expect(runtime).toContain("class PocketN9Window : public MWindow");
    expect(runtime).toContain("orientationAngleChanged(M::OrientationAngle)");
    expect(runtime).toContain("point.state() == Qt::TouchPointPressed");
    expect(runtime).toContain("touchHitById_.remove(point.id())");
    expect(runtime).toContain("switcherEntered()");
    expect(runtime).toContain("setAutoBufferSwap(false)");
    expect(runtime).toContain("swapBuffers();");
    expect(runtime).toContain("CLOCK_MONOTONIC");
    expect(runtime).toContain("timings_us");
    expect(runtime).toContain("POCKETJS_CAPTURE_FRAME_PERIOD");
    expect(runtime).toContain("::rename(");
    expect(runtime).toContain(".status.json");
    expect(runtime).toContain(".capture-request");
    expect(cli).toContain('const PRIVATE_KEY = join(KEY_ROOT, "id_rsa")');
    expect(cli).toContain('sftpTransfer("put"');
    expect(cli).toContain('sftpTransfer("get"');
    expect(cli).toContain('"HostkeyAlgorithms=+ssh-rsa"');
    expect(cli).toContain("^model=RM-?696$");
    expect(cli).toContain("meego-nokia-version");
    expect(cli).not.toContain("IMEI");
  });
});
