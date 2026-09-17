import type http from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setMaxListeners } from "node:events";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createPreparedMcpTargetTransport, listCompleteToolInventory } from "./client";
import { preparedMcpConsentResource, preparedMcpTargetTransport, PreparedMcpScopeChangedError, type PreparedMcpBinding } from "./prepared-transport";
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
/** Revoke only this Main-minted launch, including its attached wires. */
export function revokeMcpProxyLaunch(handle: string): void {
  const entry = launches.get(handle);
  if (!entry) return;
  launches.delete(handle);
  if (entry.timer) clearTimeout(entry.timer);
  for (const close of [...entry.connections]) close();
}
class McpProxyCwdChangedError extends Error {
  readonly code = "mcp_proxy_cwd_changed";
  constructor() { super("mcp_proxy_cwd_changed"); }
}
function validateLaunchCwd(cwd: { path: string; dev: number; ino: number }): void {
  try {
    const stat = fs.statSync(cwd.path);
    if (!stat.isDirectory() || fs.realpathSync(cwd.path) !== cwd.path
      || stat.dev !== cwd.dev || stat.ino !== cwd.ino) throw new McpProxyCwdChangedError();
    fs.accessSync(cwd.path, fs.constants.R_OK | fs.constants.X_OK);
  } catch { throw new McpProxyCwdChangedError(); }
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
  if (!registration || !candidate || !/^[a-f0-9-]{36}$/.test(handle)) {
    // 실측(2026-09-14): 컴퓨터 유즈가 한 앱 세션 안에서 35번 "not connected" 였는데 앱 로그엔 프록시 줄이 0건이었다.
    console.warn(`[mcp-proxy] bridge refused handle=${handle.slice(0, 8)} reason=${!registration ? "launch_unknown_or_expired" : !candidate ? "launch_not_activated" : "handle_invalid"}`);
    res.writeHead(403).end("mcp_proxy_launch_unapproved"); return;
  }
  // A revoked seal cannot recover on the same handle. Reject before opening
  // a wire so proxy-child receives terminal 403, not a retryable socket reset.
  try { preparedMcpTargetTransport(candidate, candidate.server); validateLaunchCwd(registration.cwd); }
  catch {
    revokeMcpProxyLaunch(handle);
    res.writeHead(403).end("mcp_proxy_launch_unapproved"); return;
  }
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
    validateLaunchCwd(entry.cwd);
  };
  const close = (cause?: unknown) => {
    if (closed) return; closed = true; clearInterval(revalidate);
    const invalidScope = cause instanceof PreparedMcpScopeChangedError || cause instanceof McpProxyCwdChangedError;
    if (invalidScope) revokeMcpProxyLaunch(handle);
    const reason = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : initialized ? "wire_closed" : "closed_before_initialize";
    console.warn(`[mcp-proxy] bridge closed server=${gate.serverKey} handle=${handle.slice(0, 8)} initialized=${initialized} reason=${reason}`);
    lifetime.abort(new Error("mcp_proxy_closed"));
    for (const pending of internal.values()) { pending.cleanup(); pending.reject(new Error("mcp_proxy_closed")); } internal.clear();
    for (const pending of native.values()) { pending.controller?.abort(new Error("mcp_proxy_closed")); pending.detach?.(); }
    native.clear(); external.clear(); serverRequests.clear(); serverRequestIds.clear();
    void transport?.close().catch(() => {});
    entry.connections.delete(close); if (!entry.connections.size) expireUnused(handle, entry);
    if (invalidScope && !res.headersSent && !res.destroyed) {
      // The seal may change while the upstream is starting, after admission
      // but before 200. This race is terminal too, not a transient reset.
      res.writeHead(403).end("mcp_proxy_launch_unapproved"); req.resume();
    } else { req.destroy(); res.destroy(); }
  };
  // cwd 재검증은 연결마다 초당 stat·realpath·access 3회였다 — 경로가 바뀌는 일은 드물다. 5초면 충분하다.
  const revalidate = setInterval(() => { try { validate(); } catch (error) { close(error); } }, 5000); revalidate.unref?.();
  entry.connections.add(close); if (entry.timer) clearTimeout(entry.timer);
  req.on("aborted", () => close("wire_aborted")); req.on("end", () => close("wire_ended")); req.on("error", (error) => close(error));
  res.on("close", () => close("wire_response_closed")); res.on("error", (error) => close(error));
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
  /*
   * 도구 목록은 호출마다 두 번(승인 전·후) 상류에 다시 묻고 있었다 — 컴퓨터 유즈 248회 호출이면 목록 왕복 ~500회.
   * 연결당 짧게 캐시하고, 상류가 notifications/tools/list_changed 를 보내면 비운다(승인 중 스키마 변경 감지는 유지).
   */
  const INVENTORY_TTL_MS = 30_000;
  let inventoryCache: { at: number; digests: Map<string, string> } | null = null;
  async function schema(tool: string, signal: AbortSignal): Promise<string> {
    if (!inventoryCache || Date.now() - inventoryCache.at > INVENTORY_TTL_MS) {
      const inventory = await listCompleteToolInventory({ listTools: async (params?: { cursor?: string }) => {
        const page = await query("tools/list", params ?? {}, signal);
        if (page.error || !page.result || !Array.isArray(page.result.tools)) throw new Error("mcp_proxy_inventory_invalid");
        return page.result;
      } } as Parameters<typeof listCompleteToolInventory>[0], signal);
      const digests = new Map<string, string>();
      const counts = new Map<string, number>();
      for (const row of inventory.tools) { counts.set(row.name, (counts.get(row.name) ?? 0) + 1); digests.set(row.name, mcpToolSchemaDigest(row)); }
      for (const [name, n] of counts) if (n !== 1) digests.delete(name);
      inventoryCache = { at: Date.now(), digests };
    }
    const digest = inventoryCache.digests.get(tool);
    if (!digest) throw new Error("mcp_proxy_tool_unavailable");
    return digest;
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
    transport.onclose = () => close("upstream_transport_closed"); transport.onerror = (error) => close(error instanceof Error ? `upstream_transport_error:${error.message}` : "upstream_transport_error");
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
        } else {
          if (frame.method === "notifications/tools/list_changed") inventoryCache = null;
          down(frame);
        }
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
