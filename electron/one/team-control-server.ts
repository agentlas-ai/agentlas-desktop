import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { onHostShutdown } from "../host-lifecycle";
import { userDataPath } from "../runtime-paths";
import { outsideInvocationJudgmentContext } from "../runtime/judgment-context";
import { oneGraphDispatch } from "./graph-dispatch";
import {
  oneTeamCreateMember,
  oneTeamComposeGroup,
  oneTeamInvite,
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

// The server outlives the turn that first starts it, and Node gives every later
// request the async context that was live at listen(). Started inside a turn, it
// served all later chats with that finished turn's runtime pin and aborted
// signal: toolchain_publish's test model never ran ("isolated_runtime_failed").
// So listen from the module-load context, and handle each request outside any
// invocation's judgment context.
const hostRootContext = AsyncLocalStorage.snapshot();

export interface OneTeamCapabilityBinding extends OneTeamCaller {
  /** Exact Main invocation; optional for legacy capabilities, never supplied by the MCP child. */
  supervisorReplyRunId?: string;
  /** A Work task: only `tools` (Toolchain search/run/result) may be called through this capability. */
  scope?: "toolchain-consumer";
  tools?: readonly string[];
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
  if (request.operation === "supervisor") {
    if (binding.scope === "toolchain-consumer") throw new Error("one-team-consumer-scope");
    const {isPersonalSupervisorConversation,oneSupervisor} = require("./supervisor") as typeof import("./supervisor");
    if (!binding.chatId || !isPersonalSupervisorConversation(binding.chatId)) throw new Error("supervisor_personal_conversation_required");
    const input = request.input && typeof request.input === "object" && !Array.isArray(request.input) ? request.input as Record<string, unknown> : {};
    const service = oneSupervisor();
    service.assertConversation(binding.chatId);
    switch (request.name) {
      case "one_supervisor_status": {
        const snapshot = await service.snapshot();
        return { one_id: snapshot.oneId, executor: snapshot.executor, observed_at: snapshot.observedAt, science_error: snapshot.scienceError,
          science_projects:snapshot.scienceProjects,
          tasks: snapshot.tasks.filter(task => !input.task_id || task.taskId === input.task_id).map(task=>input.task_id ? task : {...task,result:null}) };
      }
      // Owner 2026-10-04: what One hands off runs with full access and Always allow, whatever this reply's own permission.
      case "one_supervisor_start_work": return service.startWork({commandId:String(input.command_id ?? ""),text:String(input.brief ?? ""),
        ...(input.project_id ? {projectId:String(input.project_id)} : {}),permissions:"full"},binding.supervisorReplyRunId);
      case "one_supervisor_start_science": return service.startScience({commandId:String(input.command_id ?? ""),text:String(input.brief ?? ""),projectId:String(input.project_id ?? ""),
        ...(input.conversation_id ? {conversationId:String(input.conversation_id)} : {})},binding.supervisorReplyRunId);
      case "one_chat_send": return service.sendToChat({commandId:String(input.command_id ?? ""),chatId:String(input.chat_id ?? ""),text:String(input.message ?? "")},binding.supervisorReplyRunId);
      case "one_supervisor_follow_up": return service.followUp({commandId:String(input.command_id ?? ""),taskId:String(input.task_id ?? ""),text:String(input.message ?? "")},binding.supervisorReplyRunId);
      case "one_supervisor_checkin": return service.checkin({commandId:String(input.command_id ?? ""),action:input.action as "create"|"cancel"|"list",
        ...(input.instruction !== undefined ? {instruction:String(input.instruction)} : {}),...(input.every_minutes !== undefined ? {everyMinutes:Number(input.every_minutes)} : {}),
        ...(input.daily_at !== undefined ? {dailyAt:String(input.daily_at)} : {}),...(input.notify !== undefined ? {notify:input.notify as "important"|"always"} : {}),
        ...(input.checkin_id !== undefined ? {checkinId:String(input.checkin_id)} : {})});
      // The app-control catalog (every bridge operation) loads only when One first uses it.
      case "one_app_operations": return (require("../app-control/service") as typeof import("../app-control/service")).appControlOperations(input);
      case "one_app_call": return (require("../app-control/service") as typeof import("../app-control/service"))
        .appControlCall({ownerTurn:service.ownerTurn(binding.supervisorReplyRunId)},{operation:input.operation,args:input.args});
      case "one_supervisor_control": return service.control({commandId:String(input.command_id ?? ""),taskId:String(input.task_id ?? ""),expectedVersion:String(input.control_version ?? ""),action:input.action as "steer"|"cancel",...(input.message ? {text:String(input.message)} : {})});
      default: throw new Error("supervisor_operation_unknown");
    }
  }
  // The child lists only the consumer tools, but the boundary is here, not in the child.
  if (binding.scope === "toolchain-consumer"
    && (request.operation !== "graph" || !binding.tools?.includes(String(request.name ?? "")))) throw new Error("one-team-consumer-scope");
  switch (request.operation) {
    case "graph": return oneGraphDispatch(binding, String(request.name ?? ""),
      request.input && typeof request.input === "object" && !Array.isArray(request.input)
        ? request.input as Record<string, unknown> : {});
    case "list": return oneTeamList(binding);
    case "start": return oneTeamStartSession(binding, { member: request.member, brief: request.brief, newSession: request.newSession });
    case "steer": return oneTeamSteer(binding, { sessionId: request.sessionId, message: request.message });
    case "status": return oneTeamSessionStatus(binding, { sessionId: request.sessionId, waitSeconds: request.waitSeconds });
    case "create": return oneTeamCreateMember(binding, { name: request.name, role: request.role, personality: request.personality, invite: request.invite });
    case "invite": return oneTeamInvite(binding, { member: request.member });
    case "compose_group": return oneTeamComposeGroup(binding, { members: request.members });
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
  const startup = hostRootContext(() => new Promise<number>((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/one-team") return writeJson(res, 404, { ok: false, error: "not-found" });
      void readJsonBody(req).then(async (body) => {
        if (!body) return writeJson(res, 400, { ok: false, error: "invalid-request" });
        try {
          writeJson(res, 200, { ok: true, result: await outsideInvocationJudgmentContext(() => handleOneTeamControlRequest(body)) });
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
  }));
  serverStarting = startup;
  void startup.finally(() => { if (serverStarting === startup) serverStarting = null; });
  return startup;
}

/** Mint a per-config capability file (0600) that the MCP child reads. */
export async function createOneTeamCapability(
  input: OneTeamCaller & Pick<OneTeamCapabilityBinding, "scope" | "tools" | "supervisorReplyRunId">,
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
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, port, token: serverToken, capabilityId: binding.capabilityId,
    ...(binding.tools ? { tools: [...binding.tools] } : {}) }), { flag: "wx", mode: 0o600 });
  if (process.platform !== "win32") fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, target);
  return { path: target, binding };
}

export function removeOneTeamCapability(configKey: string, capabilityId: string): void {
  capabilities.delete(capabilityId);
  try { fs.rmSync(capabilityPath(configKey, capabilityId), { force: true }); } catch { /* best effort */ }
}
