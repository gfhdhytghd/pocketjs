// site/verify.ts — headless-Chrome verifier over the DevTools Protocol.
//   bun site/verify.ts <url> [waitMs] [probeExpr]
// Loads <url> in headless Chrome, hooks page errors, waits, evaluates a probe
// expression (default: homepage structure, media, and overflow checks), saves a
// screenshot, and prints a JSON report. Local verification only.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const url = process.argv[2] ?? "http://127.0.0.1:8140/";
const waitMs = Number(process.argv[3] ?? 4000);
const probe =
  process.argv[4] ??
  `(() => {
     const visible = (element) => !!element && !element.hidden && element.getClientRects().length > 0;
     const hero = document.querySelector('.lp-hero h1');
     const brokenImages = [...document.images]
       .filter((image) => image.complete && image.naturalWidth === 0)
       .map((image) => image.currentSrc || image.src);
     const failedVideos = [...document.querySelectorAll('video')]
       .filter((video) => video.error)
       .map((video) => video.currentSrc || video.querySelector('source')?.src);
     return {
       title: document.title,
       heroHeading: hero?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
       heroVisible: visible(hero),
       activeDevicePanels: [...document.querySelectorAll('[data-device-panel]')].filter(visible).length,
       activeTargetPanels: [...document.querySelectorAll('[data-target-panel]')].filter(visible).length,
       menuControl: !!document.querySelector('[data-menu-toggle]'),
       horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
       brokenImages,
       failedVideos,
     };
   })()`;

const SHOT = process.env.SHOT ?? "/tmp/pocketjs-site-verify.png";

// --- launch an isolated Chrome debugging session ----------------------------
const profileDir = mkdtempSync(join(tmpdir(), "pocketjs-verify-"));
const proc = Bun.spawn(
  [CHROME, "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check",
    "--no-sandbox", "--hide-scrollbars", "--window-size=1400,1600",
    "--force-device-scale-factor=1", "about:blank"],
  { stdout: "ignore", stderr: "ignore" },
);

async function waitFor(fn: () => Promise<any>, tries = 40, gap = 100) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch {
      await Bun.sleep(gap);
    }
  }
  throw new Error("timed out waiting for chrome");
}

let port = 0;
const version = await waitFor(async () => {
  const [activePort] = readFileSync(join(profileDir, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
  port = Number(activePort);
  if (!Number.isInteger(port) || port <= 0) throw new Error("invalid Chrome debugging port");
  const response = await fetch(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error(`Chrome debugging endpoint returned ${response.status}`);
  return response.json();
});
const wsUrl = version.webSocketDebuggerUrl as string;
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map<number, (v: any) => void>();
const events: any[] = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data as string);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m.error ? { __error: m.error } : (m.result ?? {}));
    pending.delete(m.id);
  } else if (m.method) events.push(m);
};
function send(method: string, params: any = {}, sessionId?: string): Promise<any> {
  const id = ++msgId;
  const payload: any = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  ws.send(JSON.stringify(payload));
  return new Promise((res) => pending.set(id, res));
}

// Create and attach to the page owned by this verifier invocation.
const { targetId } = await send("Target.createTarget", { url: "about:blank" });
if (!targetId) throw new Error("Chrome did not create a verifier page target");
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
const S = (method: string, params?: any) => send(method, params, sessionId);

const pageErrors: string[] = [];
const consoleErrors: string[] = [];
ws.addEventListener("message", (ev: any) => {
  const m = JSON.parse(ev.data);
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    pageErrors.push(d.exception?.description || d.text || JSON.stringify(d));
  }
  if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
    consoleErrors.push(m.params.args.map((a: any) => a.value ?? a.description ?? "").join(" "));
  }
});

await S("Page.enable");
await S("Runtime.enable");
await S("Log.enable");
if (process.env.WIDTH) {
  await S("Emulation.setDeviceMetricsOverride", {
    width: Number(process.env.WIDTH), height: Number(process.env.HEIGHT ?? 800),
    deviceScaleFactor: 2, mobile: !!process.env.MOBILE,
  });
}
await S("Page.navigate", { url });
await Bun.sleep(waitMs);

const evalRes = await S("Runtime.evaluate", { expression: probe, returnByValue: true, awaitPromise: true });
const shotOpts: any = { format: "png", captureBeyondViewport: true };
if (process.env.CLIP) {
  const [x, y, w, h] = process.env.CLIP.split(",").map(Number);
  shotOpts.clip = { x, y, width: w, height: h, scale: 1 };
}
const shot = await S("Page.captureScreenshot", shotOpts);
if (shot.data) await Bun.write(SHOT, Buffer.from(shot.data, "base64"));

console.log(
  JSON.stringify(
    {
      url,
      probe: evalRes.result?.value ?? evalRes.result ?? evalRes,
      pageErrors: pageErrors.slice(0, 8),
      consoleErrors: consoleErrors.slice(0, 8),
      screenshot: SHOT,
    },
    null,
    2,
  ),
);

await send("Target.closeTarget", { targetId });
ws.close();
proc.kill();
await proc.exited;
rmSync(profileDir, { recursive: true, force: true });
