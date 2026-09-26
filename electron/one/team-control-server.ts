import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import {
  oneTeamList,
  oneTeamSessionStatus,
  oneTeamStartSession,
  oneTeamSteer,
  type OneTeamCaller,
} from "./team-dispatch";

// Main-side handler for the inline one-team MCP child. Loopback only, one
// random server token, one capability per run config (bound to the caller chat
// and its permission). Same shape as the agent-mail control server.

const MAX_REQUEST_BYTES = 64 * 1024;

export interface OneTeamCapabilityBinding extends OneTeamCaller {
  capabilityId: string;
}

let server: http.Server | null = null;
let boundPort = 0;
let serverToken = "";
let serverStarting: Promise<number> | null = null;
let shutdownRegistered = false;
const capabilities = new Map<string, OneTeamCapabilityBinding>();

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || randomUUID();
}

function controlDir(): string {
  return userDataPath("one-team");
}

function capabilityPath(configKey: string, capabilityId: string): string {
  return path.join(controlDir(), `capability-${safeKey(configKey)}-${safeKey(capabilityId)}.json`);
}

function writeJson(res: http.ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve(value && typeof value === "object" ? value : null);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}

export async function handleOneTeamControlRequest(request: Record<string, unknown>): Promise<unknown> {
  if (typeof request.token !== "string" || !serverToken || request.token !== serverToken) throw new Error("one-team-capability-invalid");
  const binding = typeof request.capabilityId === "string" ? capabilities.get(request.capabilityId) : undefined;
  if (!binding) throw new Error("one-team-capability-invalid");
  switch (request.operation) {
    case "list": return oneTeamList(binding);
    case "start": return oneTeamStartSession(binding, { member: request.member, brief: request.brief, newSession: request.newSession });
    case "steer": return oneTeamSteer(binding, { sessionId: request.sessionId, message: request.message });
    case "status": return oneTeamSessionStatus(binding, { sessionId: request.sessionId, waitSeconds: request.waitSeconds });
    default: throw new Error("one-team-unknown-operation");
  }
}

function dispose(): void {
  capabilities.clear();
  if (server) {
    try { server.close(); } catch { /* best effort */ }
  }
  server = null;
  boundPort = 0;
  serverToken = "";
}

export function startOneTeamControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/one-team") return writeJson(res, 404, { ok: false, error: "not-found" });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          writeJson(res, 200, { ok: true, result: await handleOneTeamControlRequest(body) });
        } catch (error) {
          writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "one-team-failed" });
        }
      });
    });
    // Waiting for a teammate can take minutes; the default request timeout must not cut it.
    srv.requestTimeout = 0;
    srv.headersTimeout = 60_000;
    srv.once("error", () => { server = null; boundPort = 0; resolve(0); });
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      boundPort = typeof address === "object" && address ? address.port : 0;
      server = srv;
      srv.unref();
      if (!shutdownRegistered) {
        shutdownRegistered = true;
        onHostShutdown(dispose);
      }
      resolve(boundPort);
    });
  });
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

/** Mint a per-config capability file (0600) that the MCP child reads. */
export async function createOneTeamCapability(
  input: OneTeamCaller,
  configKey: string,
): Promise<{ path: string; binding: OneTeamCapabilityBinding }> {
  const port = await startOneTeamControlServer();
  if (!port) throw new Error("one-team-control-unavailable");
  const binding: OneTeamCapabilityBinding = { ...input, capabilityId: randomUUID() };
  capabilities.set(binding.capabilityId, binding);
  const directory = controlDir();
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
  const target = capabilityPath(configKey, binding.capabilityId);
  const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port, token: serverToken, capabilityId: binding.capabilityId }), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return { path: target, binding };
}

export function removeOneTeamCapability(configKey: string, capabilityId: string): void {
  capabilities.delete(capabilityId);
  try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
}
