import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { screen } from "electron";
import { checkComputerUsePermissions } from "../mac-permissions";
import { captureComputerUsePreview } from "./preview";
import { computerUseControlInfoPath } from "./channel";
import {
  invokeNativeInputDriver,
  nativeInputDriverAvailable,
  type NativeInputAction,
  type NativeInputResult,
} from "./native-driver";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_AUDIT_ROWS = 200;

interface AuditRow {
  at: string;
  action: string;
  ok: boolean;
  error: string | null;
  textLength?: number;
}

interface Point {
  x: number;
  y: number;
}

let server: http.Server | null = null;
let boundPort = 0;
let token = "";
let actionQueue: Promise<unknown> = Promise.resolve();
const auditRows: AuditRow[] = [];
const sourceGeometries = new Map<string, {
  sourceId: string;
  frameWidth: number;
  frameHeight: number;
  bounds: { x: number; y: number; width: number; height: number };
}>();

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let oversized = false;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) oversized = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (oversized) return resolve(null);
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

function recordAudit(action: string, result: NativeInputResult, textLength?: number): void {
  auditRows.push({
    at: new Date().toISOString(),
    action,
    ok: result.ok,
    error: typeof result.error === "string" ? result.error.slice(0, 120) : null,
    ...(typeof textLength === "number" ? { textLength } : {}),
  });
  if (auditRows.length > MAX_AUDIT_ROWS) auditRows.splice(0, auditRows.length - MAX_AUDIT_ROWS);
}

function safeString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedInteger(value: unknown, min: number, max: number, fallback: number): number | null {
  if (value === undefined) return fallback;
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}

function sourceGeometry(sourceId: string | null): {
  sourceId: string | null;
  frameWidth: number;
  frameHeight: number;
  bounds: { x: number; y: number; width: number; height: number };
} | null {
  if (sourceId) {
    const known = sourceGeometries.get(sourceId);
    if (known) return known;
  }
  const displays = screen.getAllDisplays();
  if (displays.length === 0) return null;
  const sourceDisplayId = sourceId?.match(/^screen:(\d+):/)?.[1] ?? null;
  const display = displays.find((candidate) => String(candidate.id) === sourceDisplayId) ?? screen.getPrimaryDisplay();
  return {
    sourceId,
    frameWidth: 1120,
    frameHeight: 700,
    bounds: display.bounds,
  };
}

function mapPoint(body: Record<string, unknown>, prefix = ""): Point | null {
  const x = finiteNumber(body[`${prefix}x`]);
  const y = finiteNumber(body[`${prefix}y`]);
  if (x === null || y === null) return null;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 256) : null;
  const geometry = sourceGeometry(sourceId);
  if (!geometry || x < 0 || y < 0 || x > geometry.frameWidth || y > geometry.frameHeight) return null;
  return {
    x: geometry.bounds.x + (x / geometry.frameWidth) * geometry.bounds.width,
    y: geometry.bounds.y + (y / geometry.frameHeight) * geometry.bounds.height,
  };
}

async function runAction(body: Record<string, unknown>): Promise<NativeInputResult> {
  const action = safeString(body.action, 40);
  if (!action) return { ok: false, error: "invalid-action", message: "A valid action is required." };

  const appName = body.app === undefined ? null : safeString(body.app, 160);
  if (body.app !== undefined && !appName) {
    return { ok: false, error: "invalid-app", message: "app must be under 160 characters." };
  }
  let targetPid: number | undefined;
  if (appName && action !== "focusApp" && action !== "listApps" && action !== "status") {
    const focused = await invokeNativeInputDriver({ action: "focusApp", app: appName });
    recordAudit("focusApp", focused);
    if (!focused.ok) return focused;
    if (typeof focused.pid === "number" && Number.isInteger(focused.pid) && focused.pid > 0) targetPid = focused.pid;
    await new Promise((resolve) => setTimeout(resolve, 280));
  }

  let request: NativeInputAction | null = null;
  switch (action) {
    case "status": request = { action: "status" }; break;
    case "listApps": request = { action: "listApps" }; break;
    case "focusApp":
      if (appName) request = { action: "focusApp", app: appName };
      break;
    case "move": {
      const point = mapPoint(body);
      if (point) request = { action: "move", ...point };
      break;
    }
    case "click": {
      const point = mapPoint(body);
      const button = body.button === undefined ? "left" : body.button;
      const clickCount = boundedInteger(body.clickCount, 1, 2, 1);
      if (point && (button === "left" || button === "right" || button === "middle") && clickCount) {
        request = { action: "click", ...point, button, clickCount: clickCount as 1 | 2 };
      }
      break;
    }
    case "drag": {
      const from = mapPoint(body, "from_");
      const to = mapPoint(body, "to_");
      const durationMs = boundedInteger(body.durationMs, 50, 5_000, 450);
      const button = body.button === undefined ? "left" : body.button;
      if (from && to && durationMs && (button === "left" || button === "right" || button === "middle")) {
        request = {
          action: "drag",
          fromX: from.x,
          fromY: from.y,
          toX: to.x,
          toY: to.y,
          durationMs,
          button,
        };
      }
      break;
    }
    case "scroll": {
      const deltaX = boundedInteger(body.deltaX, -4_000, 4_000, 0);
      const deltaY = boundedInteger(body.deltaY, -4_000, 4_000, 0);
      if (deltaX !== null && deltaY !== null && (deltaX !== 0 || deltaY !== 0)) {
        request = { action: "scroll", deltaX, deltaY };
      }
      break;
    }
    case "typeText": {
      const value = safeString(body.text, 16 * 1024);
      if (value && Buffer.byteLength(value, "utf8") <= 16 * 1024) request = { action: "typeText", text: value, targetPid };
      break;
    }
    case "selectText": request = { action: "selectText", targetPid }; break;
    case "key": {
      const key = safeString(body.key, 32);
      const modifiers = body.modifiers === undefined ? [] : body.modifiers;
      const repeat = boundedInteger(body.repeat, 1, 20, 1);
      if (key && Array.isArray(modifiers) && modifiers.length <= 5 && modifiers.every((value) => typeof value === "string" && value.length <= 16) && repeat) {
        request = { action: "key", key, modifiers: modifiers as string[], repeat };
      }
      break;
    }
  }

  if (!request) return { ok: false, error: "invalid-arguments", message: "Computer Use action arguments were rejected." };
  const result = await invokeNativeInputDriver(request);
  recordAudit(action, result, action === "typeText" && typeof body.text === "string" ? body.text.length : undefined);
  return result;
}

function writePrivateInfoFile(): void {
  const infoPath = computerUseControlInfoPath();
  const infoDir = path.dirname(infoPath);
  fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(infoDir, 0o700);
  const temp = `${infoPath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port: boundPort, token }), { mode: 0o600, flag: "wx" });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, infoPath);
  if (process.platform !== "win32") fs.chmodSync(infoPath, 0o600);
}

export function startComputerUseControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (process.platform !== "darwin") return Promise.resolve(0);
  token = randomUUID();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
        writeJson(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (req.method !== "POST") {
        writeJson(res, 404, { ok: false, error: "not-found" });
        return;
      }
      void readJsonBody(req).then((body) => {
        if (!body) {
          writeJson(res, 400, { ok: false, error: "invalid-request" });
          return;
        }
        if (req.url === "/status") {
          const permissions = checkComputerUsePermissions();
          writeJson(res, 200, {
            ok: true,
            available: nativeInputDriverAvailable(),
            platform: process.platform,
            accessibility: permissions.accessibility,
            screenRecording: permissions.screenRecording,
          });
          return;
        }
        if (req.url === "/capture") {
          const sourceId = typeof body.sourceId === "string" ? body.sourceId.slice(0, 256) : undefined;
          void captureComputerUsePreview(sourceId).then((preview) => {
            for (const source of preview.sources) {
              if (source.bounds && source.width > 0 && source.height > 0) {
                sourceGeometries.set(source.id, {
                  sourceId: source.id,
                  frameWidth: source.width,
                  frameHeight: source.height,
                  bounds: source.bounds,
                });
              }
            }
            writeJson(res, 200, { ok: true, preview });
          }, () => {
            writeJson(res, 500, { ok: false, error: "capture-failed" });
          });
          return;
        }
        if (req.url === "/action") {
          const execute = actionQueue.then(() => runAction(body), () => runAction(body));
          actionQueue = execute.then(() => undefined, () => undefined);
          void execute.then((result) => writeJson(res, result.ok ? 200 : 409, result), () => {
            writeJson(res, 500, { ok: false, error: "action-failed" });
          });
          return;
        }
        if (req.url === "/logs") {
          writeJson(res, 200, { ok: true, logs: auditRows.slice(-100) });
          return;
        }
        writeJson(res, 404, { ok: false, error: "not-found" });
      });
    });

    srv.on("error", () => {
      server = null;
      boundPort = 0;
      resolve(0);
    });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      try {
        writePrivateInfoFile();
      } catch (error) {
        console.error("[computer-use] capability file failed:", error);
        try { srv.close(); } catch { /* ignore */ }
        server = null;
        boundPort = 0;
      }
      resolve(boundPort);
    });
  });
}

export function stopComputerUseControlServer(): void {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  server = null;
  boundPort = 0;
  token = "";
  auditRows.length = 0;
  sourceGeometries.clear();
  try { fs.rmSync(computerUseControlInfoPath(), { force: true }); } catch { /* ignore */ }
}
