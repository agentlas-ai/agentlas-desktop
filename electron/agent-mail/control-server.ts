import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { agentMailGet, agentMailList, agentMailSend, agentMailStatus } from "./client";

// Main-side handler for the inline agent mail MCP child. Loopback only, one
// random server token, one capability per run config. Reads work in any run;
// sending needs a run the owner started with write or full permission.

const MAX_REQUEST_BYTES = 512 * 1024;

export interface AgentMailCapabilityBinding {
  capabilityId: string;
  chatId: string | null;
  permission: "read" | "write" | "full";
}

let server: http.Server | null = null;
let boundPort = 0;
let serverToken = "";
let serverStarting: Promise<number> | null = null;
let shutdownRegistered = false;
const capabilities = new Map<string, AgentMailCapabilityBinding>();

function safeKey(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 96) || randomUUID();
}

function controlDir(): string {
  return userDataPath("agent-mail");
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

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : typeof value === "string" ? [value] : [];
}

function unwrap<T>(result: ({ ok: true } & T) | { ok: false; code: string; message: string }): T {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  const { ok: _ok, ...rest } = result;
  return rest as unknown as T;
}

export async function handleAgentMailControlRequest(request: Record<string, unknown>): Promise<unknown> {
  if (typeof request.token !== "string" || !serverToken || request.token !== serverToken) throw new Error("agent-mail-capability-invalid");
  const binding = typeof request.capabilityId === "string" ? capabilities.get(request.capabilityId) : undefined;
  if (!binding) throw new Error("agent-mail-capability-invalid");
  switch (request.operation) {
    case "status": {
      const status = unwrap(await agentMailStatus());
      return {
        address: status.mailbox?.address ?? null,
        available: status.entitlement?.available ?? false,
        canSend: Boolean(status.entitlement?.mailbox.send) && binding.permission !== "read",
        monthlyRecipientLimit: status.entitlement?.monthlyRecipientLimit ?? 0,
        remainingThisMonth: status.entitlement?.remainingThisMonth ?? 0,
        periodEnd: status.entitlement?.period.end ?? null,
      };
    }
    case "list":
      return unwrap(await agentMailList({
        cursor: typeof request.cursor === "string" ? request.cursor : null,
        limit: typeof request.limit === "number" ? request.limit : 20,
        direction: request.direction === "inbound" || request.direction === "outbound" ? request.direction : undefined,
      }));
    case "read":
      return unwrap(await agentMailGet(String(request.messageId ?? "")));
    case "send": {
      if (binding.permission === "read") throw new Error("agent-mail-send-needs-write-run: this run is read-only; ask the owner to allow changes for this task.");
      return unwrap(await agentMailSend({
        to: list(request.to),
        cc: list(request.cc),
        bcc: list(request.bcc),
        subject: typeof request.subject === "string" ? request.subject : "",
        text: typeof request.text === "string" ? request.text : "",
        ...(typeof request.inReplyTo === "string" ? { inReplyTo: request.inReplyTo } : {}),
      }));
    }
    default:
      throw new Error("agent-mail-operation-invalid");
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

export function startAgentMailControlServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  if (serverStarting) return serverStarting;
  serverToken = randomUUID();
  const startup = new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/agent-mail") return writeJson(res, 404, { ok: false, error: "not-found" });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          writeJson(res, 200, { ok: true, result: await handleAgentMailControlRequest(body) });
        } catch (error) {
          writeJson(res, 409, { ok: false, error: error instanceof Error ? error.message : "agent-mail-failed" });
        }
      });
    });
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
export async function createAgentMailCapability(
  input: Omit<AgentMailCapabilityBinding, "capabilityId">,
  configKey: string,
): Promise<{ path: string; binding: AgentMailCapabilityBinding }> {
  const port = await startAgentMailControlServer();
  if (!port) throw new Error("agent-mail-control-unavailable");
  const binding: AgentMailCapabilityBinding = { ...input, capabilityId: randomUUID() };
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

export function removeAgentMailCapability(configKey: string, capabilityId: string): void {
  capabilities.delete(capabilityId);
  try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
}
