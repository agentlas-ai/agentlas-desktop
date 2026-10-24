import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { app, powerMonitor } from "electron";
import { ActuatorManager, type Lease } from "../reach/actuator-manager";
import type { Actuator } from "../reach/actuator";
import { CuaActuator } from "../reach/cua-actuator";
import { ensureCuaDriver, type CuaInstall } from "../reach/cua-provision";
import { createNodeHost, nodeExec } from "../reach/host";
import { installSignature } from "../reach/install-watch";
import { buildReachMap, readAppCapabilities, readReachMap, writeReachScan } from "../reach/map";
import { isAppRunning } from "../reach/macos";
import { REACH_PROVIDERS } from "../reach/providers";
import { CapabilityRegistry } from "../reach/registry";
import { GUI_UNSUPPORTED, ReachService, REACH_FEATURE_VERSION, type ReachServiceOptions, type ReachStamp, type ReachStatus, type Timers } from "../reach/service";
import { flushUploads, Outbox, type UploadCandidate } from "../reach/upload";
import type { ReachPlatform } from "../reach/types";
import { getMeta, setMeta } from "../store/meta";
import { getReachExploreEnabled, REACH_STATUS_KEY, setReachExploreEnabled } from "../store/reach-explore";
import { setReachExploreListener } from "./reach-hooks";
import { buildRuntime, reachStateDir, setReachRuntime } from "./runtime";

// The desktop's Main process owns the Reach background service: it builds the app map after install and after every update of this
// feature (whatever the Settings switch says, silently), and with the switch on turns what it finds into capabilities. Everything
// platform-specific that the service and the harness operations need is wired here, once; nothing in reach/ imports Electron.

const STAMP_KEY = "reach.stamp.v1";
const INSTALL_ID_KEY = "reach.install.id.v1";
// The one place capability descriptions are sent. Not webBaseUrl(): a managed company sign-in points that at the company's own server.
const UPLOAD_ENDPOINT = "https://agentlas.cloud/api/desktop/capabilities";

let service: ReachService | null = null;
let manager: ActuatorManager<CuaInstall> | null = null;
// The background exploration holds the driver for a whole pass; an agent's own call queues behind it (or the other way round).
let passLease: Extract<Lease, { ok: true }> | null = null;
let locked = false;
let powerListening = false;

const timers: Timers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>); },
};

function platform(): ReachPlatform | null {
  return process.platform === "darwin" || process.platform === "win32" || process.platform === "linux" ? process.platform : null;
}

function installId(): string {
  const existing = getMeta(INSTALL_ID_KEY);
  if (existing && /^[0-9a-f-]{36}$/.test(existing)) return existing;
  const fresh = randomUUID();
  setMeta(INSTALL_ID_KEY, fresh);
  return fresh;
}

function readStamp(): ReachStamp | null {
  try {
    const parsed = JSON.parse(getMeta(STAMP_KEY) ?? "null") as Partial<ReachStamp> | null;
    return parsed && typeof parsed.feature === "number" && typeof parsed.appVersion === "string" && typeof parsed.completedAt === "number" ? (parsed as ReachStamp) : null;
  } catch { return null; }
}

// Apps are driven on screen on macOS, on Windows, and on Linux when there is a desktop session to drive (a display; the accessibility bus is
// checked when the driver starts). Elsewhere the map is still built and read.
function createManager(stateDir: string): ActuatorManager<CuaInstall> | null {
  const linuxSession = process.platform === "linux" && !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (process.platform !== "darwin" && process.platform !== "win32" && !linuxSession) return null;
  return new ActuatorManager<CuaInstall>({
    provision: () => ensureCuaDriver({
      platform: process.platform,
      arch: process.arch,
      reachHome: stateDir,
      exec: nodeExec,
      async download(url, signal) {
        const response = await fetch(url, { signal, redirect: "follow" });
        if (!response.body) return { status: response.status, chunks: (async function* () { /* empty */ })() };
        return { status: response.status, chunks: response.body as unknown as AsyncIterable<Uint8Array> };
      },
    }),
    start: async (install): Promise<Actuator> => {
      const actuator = await CuaActuator.start({ executable: install.executable, reachHome: stateDir, hostBundleId: "com.agentlas.desktop" });
      if (process.platform === "linux" || process.platform === "win32") {
        // The driver started, but can it see the screen and the accessibility bus of this session? If not it is let go again, quietly.
        const status = await actuator.status().catch(() => null);
        if (!status?.accessibility || !status.screenRecording) {
          await actuator.close();
          throw Object.assign(new Error("the desktop session has no display or no accessibility bus"), { code: "gui_session_unavailable" });
        }
      }
      return actuator;
    },
    timers,
  });
}

function listenToPower(): void {
  if (powerListening) return;
  powerListening = true;
  powerMonitor.on("lock-screen", () => { locked = true; });
  powerMonitor.on("unlock-screen", () => { locked = false; });
  powerMonitor.on("suspend", () => { service?.notifyExploreChanged(false); });
  powerMonitor.on("resume", () => { if (getReachExploreEnabled()) service?.notifyExploreChanged(true); });
}

async function uploadCandidates(stateDir: string, registry: CapabilityRegistry, only?: readonly string[]): Promise<UploadCandidate[]> {
  const map = await readReachMap(path.join(stateDir, "map"));
  if (!map) return [];
  const { readAppCapabilities } = await import("../reach/map");
  const out: UploadCandidate[] = [];
  for (const record of map.apps) {
    // the test-only opt-in sends about the named apps and nobody else's
    if (only && !only.some((id) => record.key === `bundle:${id}`)) continue;
    const app = { key: record.key, platform: record.platform, name: record.name, ...(record.version ? { version: record.version } : {}), fingerprint: record.fingerprint };
    const published = (await readAppCapabilities(path.join(stateDir, "map"), record.key)) ?? [];
    for (const capability of [...published, ...(await registry.capabilities(record.key))]) out.push({ app, capability });
  }
  return out;
}

/** Starts the Reach background service and the harness runtime. Call once, after the app is ready. A second call does nothing. */
// `qa`: the bundle ids a packaged local candidate was admitted for (development-effect-policy.ts reachQaAdmission); Reach then looks at, explores and sends about
// those apps only, with the switch on, and says what it sent. Never set in a normal run.
export async function startReach(options: { busy: () => boolean; service?: ReachServiceOptions; qa?: readonly string[] }): Promise<void> {
  if (service) return;
  const current = platform();
  if (!current) return;
  const stateDir = await reachStateDir();
  const registry = new CapabilityRegistry(path.join(stateDir, "registry"));
  const outbox = new Outbox(path.join(stateDir, "upload.json"));
  manager = createManager(stateDir);
  listenToPower();
  const qa = options.qa;
  const debug = qa !== undefined || process.env.AGENTLAS_REACH_DEBUG === "1";
  if (qa) setReachExploreEnabled(true, true); // the owner approved this test; the profile is disposable
  const unsupportedGui = { ok: false as const, error: GUI_UNSUPPORTED };
  const next = new ReachService({
    // Tests and E2E runs never map or explore the machine they run on.
    allowed: () => process.env.AGENTLAS_E2E !== "1",
    exploreEnabled: getReachExploreEnabled,
    stamp: {
      get: async () => readStamp(),
      set: async (stamp) => { setMeta(STAMP_KEY, JSON.stringify(stamp)); },
    },
    buildMap: async () => {
      // What the last scan read stays when an app that was running then is not running now (a dictionary that can only be read while the app runs).
      const mapDir = path.join(stateDir, "map");
      const before = await readReachMap(mapDir).catch(() => null);
      return buildReachMap({
        providers: REACH_PROVIDERS,
        extra: (key) => registry.capabilities(key),
        previous: async (key, fingerprint) => {
          const record = before?.apps.find((item) => item.key === key);
          return record && record.fingerprint === fingerprint ? readAppCapabilities(mapDir, key) : null;
        },
      });
    },
    // macOS: an app whose dictionary could not be read (it needs the app running) is running now.
    dictionaryWaiting: async () => {
      if (process.platform !== "darwin") return false;
      const map = await readReachMap(path.join(stateDir, "map"));
      const waiting = (map?.apps ?? []).filter((item) => item.harvest.some((record) => record.deferred === true));
      if (waiting.length === 0) return false;
      const host = createNodeHost();
      for (const item of waiting) if (await isAppRunning(host, item.path)) return true;
      return false;
    },
    installSignature: () => installSignature(createNodeHost(), REACH_PROVIDERS),
    writeScan: (scan) => writeReachScan(path.join(stateDir, "map"), scan),
    readMap: () => readReachMap(path.join(stateDir, "map")),
    registry,
    actuator: manager
      ? {
        prepare: () => manager!.prepare(),
        ensure: async () => {
          const lease = await manager!.acquire();
          if (!lease.ok) return lease;
          passLease = lease;
          // the test-only opt-in: the service sees only the named apps running, so nothing else the owner has open is ever touched
          const actuator = qa ? new Proxy(lease.actuator, { get(target, key) {
            if (key === "listApps") return async (...args: Parameters<Actuator["listApps"]>) => (await target.listApps(...args)).filter((item) => !!item.bundleId && qa.includes(item.bundleId));
            const value = (target as unknown as Record<string | symbol, unknown>)[key];
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          } }) : lease.actuator;
          return { ok: true as const, actuator };
        },
        release: async () => {
          const lease = passLease;
          passLease = null;
          await lease?.done();
          await manager!.release();
        },
      }
      : { prepare: async () => unsupportedGui, ensure: async () => unsupportedGui, release: async () => undefined },
    power: {
      idleSeconds: () => { try { return powerMonitor.getSystemIdleTime(); } catch { return null; } },
      onBattery: () => { try { return powerMonitor.isOnBatteryPower(); } catch { return null; } },
      locked: () => locked,
      busy: options.busy,
    },
    // Only a packaged build sends anything; a development build maps and explores but keeps the results to itself.
    flushUploads: async () => {
      if (!app.isPackaged && process.env.AGENTLAS_REACH_UPLOAD !== "1") return;
      const sent = await flushUploads({
        endpoint: UPLOAD_ENDPOINT,
        installId,
        client: { version: app.getVersion(), reach: String(REACH_FEATURE_VERSION) },
        context: { username: os.userInfo().username, hostname: os.hostname() },
        post: async (url, body, headers) => {
          const response = await fetch(url, { method: "POST", body, headers, signal: AbortSignal.timeout(15_000) });
          return { status: response.status };
        },
        outbox,
        now: () => Date.now(),
        day: () => new Date().toISOString().slice(0, 10),
      }, await uploadCandidates(stateDir, registry, qa));
      if (debug) console.log(`[reach] upload: ${sent.status}, ${sent.sent} record(s) accepted in ${sent.requests} request(s), dropped ${JSON.stringify(sent.dropped)}`);
    },
    writeStatus: (status: ReachStatus) => { setMeta(REACH_STATUS_KEY, JSON.stringify(status)); },
    appVersion: app.getVersion(),
    timers,
    now: () => Date.now(),
    day: () => new Date().toISOString().slice(0, 10),
    log: (line) => { if (debug) console.log(`[reach] ${line}`); },
  }, options.service ?? (qa ? { firstDelayMs: 3_000, cooldownMs: 0 } : undefined));
  service = next;
  setReachRuntime(buildRuntime(stateDir, {
    registry,
    gui: manager,
    service: next,
    exploreEnabled: getReachExploreEnabled,
  }));
  setReachExploreListener((enabled) => next.notifyExploreChanged(enabled));
  next.start();
}

/** Stops the service and lets the driver go. Safe to call when it never started. */
export async function stopReach(): Promise<void> {
  const running = service;
  service = null;
  setReachExploreListener(null);
  setReachRuntime(null);
  await running?.stop();
  await passLease?.done().catch(() => undefined);
  passLease = null;
  await manager?.shutdown();
  manager = null;
}
