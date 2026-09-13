import type http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setMaxListeners } from "node:events";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createPreparedMcpTargetTransport, listCompleteToolInventory } from "./client";
import { preparedMcpConsentResource, preparedMcpTargetTransport, type PreparedMcpBinding } from "./prepared-transport";
import { mcpToolSchemaDigest } from "./tool-schema";
import { bindMainToolConsentResource } from "../runtime/tool-consent";
import { defaultRuntimeToolPermission, getRuntimeToolPermissionArbiter, type RuntimeToolPermissionAsk } from "../runtime/tool-approval";

type Gate = {
  serverKey: string; runtime: string; sessionKey: string; permission?: "read" | "write" | "full";
  cwd?: string; chatId?: string; unattended?: boolean; simulation?: boolean; planMode?: boolean;
  catalogId: string | null; planReadAuthority?: "agentlas-browser" | "cua-driver"; planPath?: string;
};
type Registration = { cwd: Readonly<{ path: string; dev: number; ino: number }>; gate: Readonly<Gate>; binding?: PreparedMcpBinding; timer?: NodeJS.Timeout; connections: Set<() => void> };
type Frame = Record<string, any>;
type Policy = {
  mutating: (input: { catalogId?: string | null; toolName: string }) => boolean;
  planMutating: (input: { authority?: unknown; toolName: string; args?: unknown }) => boolean;
};
const launches = new Map<string, Registration>();
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const UNUSED_LAUNCH_MS = 5 * 60_000;
function expireUnused(handle: string, entry: Registration): void {
  if (launches.get(handle) !== entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { if (!entry.connections.size) launches.delete(handle); }, UNUSED_LAUNCH_MS);
  entry.timer.unref?.();
}
/** Main builder only. Serialized policy fields cannot register or upgrade a launch. */
export function prepareMcpProxyLaunch(gate: Gate): string {
  if (typeof gate.cwd !== "string" || !path.isAbsolute(gate.cwd)) throw new Error("mcp_proxy_cwd_invalid");
  let cwd: Registration["cwd"];
  try {
    const real = fs.realpathSync(gate.cwd), stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new Error();
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
    cwd = Object.freeze({ path: real, dev: stat.dev, ino: stat.ino });
  } catch { throw new Error("mcp_proxy_cwd_unavailable"); }
  const handle = randomUUID();
  const entry: Registration = { cwd, gate: Object.freeze({ ...gate, cwd: cwd.path }), connections: new Set() };
  launches.set(handle, entry); expireUnused(handle, entry); return handle;
}
export function activateMcpProxyLaunch(handle: string, binding: PreparedMcpBinding): void {
  const entry = launches.get(handle);
  if (!entry || entry.binding || entry.gate.serverKey !== binding.configKey) throw new Error("mcp_proxy_launch_unapproved");
  if (preparedMcpTargetTransport(binding, binding.server).kind !== "stdio") throw new Error("mcp_proxy_transport_unsupported");
  entry.binding = binding;
}
export function stopMcpProxySessions(): void {
  const entries = [...launches.values()]; launches.clear();
  for (const entry of entries) {
    if (entry.timer) clearTimeout(entry.timer);
    for (const close of [...entry.connections]) close();
  }
}
function graphAllows(gate: Readonly<Gate>, tool: string): boolean {
  if (!gate.planPath) return true;
  const stat = fs.statSync(gate.planPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) return false;
  const plan = JSON.parse(fs.readFileSync(gate.planPath, "utf8"));
  const name = `mcp__${gate.serverKey}__${tool}`;
  if (Array.isArray(plan.denyExact) && plan.denyExact.includes(name)) return false;
  return plan.denyUndeclaredMcp !== true || (Array.isArray(plan.allowPrefixes)
    && plan.allowPrefixes.some((prefix: unknown) => typeof prefix === "string" && name.startsWith(prefix)));
}

/** One persistent actual upstream per attached native wire, with no per-call process. */
export function handleMcpProxyBridge(req: http.IncomingMessage, res: http.ServerResponse, policy: Policy): void {
  const handle = (req.url ?? "").slice("/bridge/".length);
  const registration = launches.get(handle), candidate = registration?.binding;
  if (!registration || !candidate || !/^[a-f0-9-]{36}$/.test(handle)) { res.writeHead(403).end("mcp_proxy_launch_unapproved"); return; }
  const entry = registration, binding: PreparedMcpBinding = candidate, gate = entry.gate, lifetime = new AbortController();
  let transport: Transport | null = null, closed = false, initialized = false, buffer = "";
  setMaxListeners(0, lifetime.signal); // A lifetime can own any number of concurrent RPC waiters.
  const hostPrefix = `host:${randomUUID()}:`; let hostSequence = 0;
  const native = new Map<string, { id: string | number; method: string; controller?: AbortController; detach?: () => void; sent: boolean }>();
  const external = new Map<string, string>();
  const serverRequests = new Map<string, string | number>();
  const serverRequestIds = new Map<string, string>();
  const internal = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void; cleanup: () => void }>();
  const idKey = (id: unknown) => JSON.stringify(id);
  const validate = () => {
    if (closed || lifetime.signal.aborted) throw new Error("mcp_proxy_closed");
    preparedMcpTargetTransport(binding, binding.server);
    const stat = fs.statSync(entry.cwd.path);
    if (!stat.isDirectory() || fs.realpathSync(entry.cwd.path) !== entry.cwd.path
      || stat.dev !== entry.cwd.dev || stat.ino !== entry.cwd.ino) throw new Error("mcp_proxy_cwd_changed");
    fs.accessSync(entry.cwd.path, fs.constants.R_OK | fs.constants.X_OK);
  };
  const close = () => {
    if (closed) return; closed = true; clearInterval(revalidate);
    lifetime.abort(new Error("mcp_proxy_closed"));
    for (const pending of internal.values()) { pending.cleanup(); pending.reject(new Error("mcp_proxy_closed")); } internal.clear();
    for (const pending of native.values()) { pending.controller?.abort(new Error("mcp_proxy_closed")); pending.detach?.(); }
    native.clear(); external.clear(); serverRequests.clear(); serverRequestIds.clear();
    void transport?.close().catch(() => {});
    entry.connections.delete(close); if (!entry.connections.size) expireUnused(handle, entry);
    req.destroy(); res.destroy();
  };
  const revalidate = setInterval(() => { try { validate(); } catch { close(); } }, 1000); revalidate.unref?.();
  entry.connections.add(close); if (entry.timer) clearTimeout(entry.timer);
  req.on("aborted", close); req.on("end", close); req.on("error", close); res.on("close", close); res.on("error", close);
  const down = (frame: Frame) => {
    if (closed) return;
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES || res.writableLength + Buffer.byteLength(line) > MAX_FRAME_BYTES) { close(); return; }
    res.write(line);
  };
  const up = async (frame: Frame) => { validate(); if (!transport) throw new Error("mcp_proxy_not_ready"); await transport.send(frame as JSONRPCMessage); };
  const finish = (wireId: string, frame: Frame) => {
    const pending = native.get(wireId); if (!pending) return;
    pending.detach?.(); native.delete(wireId); external.delete(idKey(pending.id));
    down({ ...frame, id: pending.id });
  };
  const deny = (wireId: string, code: string) => finish(wireId, { jsonrpc: "2.0", result: { isError: true,
    _meta: { agentlasProxyFailure: code }, content: [{ type: "text", text: `MCP_PROXY_${code.toUpperCase()}: Tool execution was not authorized.` }] } });
  function query(method: string, params: Frame, signal: AbortSignal): Promise<Frame> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = `${hostPrefix}${++hostSequence}`;
      const abort = () => { const pending = internal.get(id); if (!pending) return; internal.delete(id); pending.cleanup(); reject(new Error("mcp_proxy_query_cancelled"));
        void up({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id } }).catch(() => {}); };
      const timer = setTimeout(() => { const pending = internal.get(id); if (!pending) return; internal.delete(id); pending.cleanup(); reject(new Error("mcp_proxy_inventory_timeout")); }, 45_000);
      timer.unref?.();
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      internal.set(id, { resolve, reject, cleanup }); signal.addEventListener("abort", abort, { once: true });
      void up({ jsonrpc: "2.0", id, method, params }).catch(() => { const p = internal.get(id); if (p) { internal.delete(id); p.cleanup(); p.reject(new Error("mcp_proxy_upstream_unavailable")); } });
      if (signal.aborted) abort();
    });
  }
  async function schema(tool: string, signal: AbortSignal): Promise<string> {
    const inventory = await listCompleteToolInventory({ listTools: async (params?: { cursor?: string }) => {
      const page = await query("tools/list", params ?? {}, signal);
      if (page.error || !page.result || !Array.isArray(page.result.tools)) throw new Error("mcp_proxy_inventory_invalid");
      return page.result;
    } } as Parameters<typeof listCompleteToolInventory>[0], signal);
    const matches = inventory.tools.filter(row => row.name === tool);
    if (matches.length !== 1) throw new Error("mcp_proxy_tool_unavailable");
    return mcpToolSchemaDigest(matches[0]);
  }
  async function toolCall(wireId: string, frame: Frame, signal: AbortSignal): Promise<void> {
    try {
      const tool = frame.params?.name, args = frame.params?.arguments ?? {};
      if (!initialized || typeof tool !== "string" || !tool || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("mcp_proxy_call_invalid");
      if (!graphAllows(gate, tool)) { deny(wireId, "plan_denied"); return; }
      const mutating = policy.mutating({ catalogId: gate.catalogId, toolName: tool });
      if ((gate.simulation && mutating) || (gate.planMode && policy.planMutating({ authority: gate.planReadAuthority, toolName: tool, args }))) { deny(wireId, "plan_denied"); return; }
      const digest = await schema(tool, signal); validate(); signal.throwIfAborted();
      const ask: RuntimeToolPermissionAsk = { runtime: gate.runtime, sessionKey: gate.sessionKey,
        tool: `mcp__${gate.serverKey}__${tool}`, kind: "other", cwd: gate.cwd, permission: gate.permission,
        chatId: gate.chatId, unattended: gate.unattended, mutating, signal, ...(gate.planMode ? { planMode: true as const } : {}) };
      bindMainToolConsentResource(ask, { tool: ask.tool, target: preparedMcpConsentResource(binding, binding.server), schema: digest, arguments: args });
      const arbiter = getRuntimeToolPermissionArbiter();
      const decision = arbiter ? await arbiter(ask) : defaultRuntimeToolPermission(ask);
      signal.throwIfAborted(); validate();
      if (decision === "deny") { deny(wireId, "policy_denied"); return; }
      if (await schema(tool, signal) !== digest) { deny(wireId, "schema_changed"); return; }
      signal.throwIfAborted(); validate();
      const pending = native.get(wireId); if (!pending) return; pending.sent = true;
      await up({ ...frame, id: wireId });
    } catch { deny(wireId, signal.aborted ? "cancelled" : "scope_or_schema_unavailable"); }
  }
  async function receive(frame: Frame): Promise<void> {
    validate();
    if (!frame || typeof frame !== "object" || Array.isArray(frame) || frame.jsonrpc !== "2.0") throw new Error("mcp_proxy_frame_invalid");
    if (typeof frame.method !== "string") {
      const original = serverRequests.get(idKey(frame.id));
      if (original === undefined) throw new Error("mcp_proxy_response_unmatched");
      serverRequests.delete(idKey(frame.id)); serverRequestIds.delete(idKey(original)); await up({ ...frame, id: original }); return;
    }
    if (frame.method === "notifications/cancelled") {
      const wireId = external.get(idKey(frame.params?.requestId));
      const pending = wireId ? native.get(wireId) : null;
      pending?.controller?.abort(new Error("mcp_proxy_call_cancelled"));
      if (wireId && pending?.sent) await up({ ...frame, params: { ...frame.params, requestId: wireId } });
      return;
    }
    if (frame.id === undefined) { if (frame.method === "tools/call") throw new Error("mcp_proxy_call_id_required"); await up(frame); return; }
    if ((typeof frame.id !== "string" && typeof frame.id !== "number") || external.has(idKey(frame.id))) throw new Error("mcp_proxy_request_id_invalid");
    const wireId = `client:${randomUUID()}`;
    const controller = frame.method === "tools/call" ? new AbortController() : undefined;
    const abort = () => controller?.abort(lifetime.signal.reason);
    if (controller) lifetime.signal.addEventListener("abort", abort, { once: true });
    native.set(wireId, { id: frame.id, method: frame.method, controller, sent: !controller,
      ...(controller ? { detach: () => lifetime.signal.removeEventListener("abort", abort) } : {}) });
    external.set(idKey(frame.id), wireId);
    if (controller) { void toolCall(wireId, frame, controller.signal); return; }
    await up({ ...frame, id: wireId });
  }
  req.pause();
  void (async () => {
    validate(); transport = await createPreparedMcpTargetTransport(binding, lifetime.signal, entry.cwd.path); validate();
    transport.onclose = close; transport.onerror = close;
    transport.onmessage = message => {
      const frame = message as Frame;
      if (closed) return;
      if (typeof frame.method === "string") {
        if (frame.id !== undefined) {
          if (serverRequestIds.has(idKey(frame.id))) { close(); return; }
          const id = `server:${randomUUID()}`;
          serverRequests.set(idKey(id), frame.id); serverRequestIds.set(idKey(frame.id), id); down({ ...frame, id });
        } else if (frame.method === "notifications/cancelled") {
          const id = serverRequestIds.get(idKey(frame.params?.requestId));
          if (id) down({ ...frame, params: { ...frame.params, requestId: id } });
        } else down(frame);
        return;
      }
      const host = internal.get(String(frame.id));
      if (host) { internal.delete(String(frame.id)); host.cleanup(); host.resolve(frame); return; }
      // A cancelled/timed-out inventory request can legitimately answer late.
      // The per-connection issued-id range retires it without retaining a set
      // proportional to lifetime tool count or disturbing unrelated waiters.
      if (typeof frame.id === "string" && frame.id.startsWith(hostPrefix)) {
        const sequence = Number(frame.id.slice(hostPrefix.length));
        if (Number.isSafeInteger(sequence) && sequence > 0 && sequence <= hostSequence) return;
      }
      const pending = native.get(String(frame.id));
      if (!pending) { close(); return; }
      if (pending.method === "initialize" && !frame.error) initialized = true;
      finish(String(frame.id), frame);
    };
    await transport.start(); validate();
    res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" }); res.flushHeaders();
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) { close(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        try { void receive(JSON.parse(line)).catch(close); } catch { close(); return; }
      }
    });
    req.resume();
  })().catch(close);
}
