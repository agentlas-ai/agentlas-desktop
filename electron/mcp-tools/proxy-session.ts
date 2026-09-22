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
import { beginMainMcpEffect } from "./effect-receipts";
import { isCanonicalSystemTimeMcpServer } from "./system-time-server";

export type McpProxyGate = {
  serverKey: string; runtime: string; sessionKey: string; permission?: "read" | "write" | "full";
  cwd?: string; chatId?: string; unattended?: boolean; simulation?: boolean; planMode?: boolean;
  catalogId: string | null; planReadAuthority?: "agentlas-browser" | "cua-driver"; planPath?: string;
  /** Stable Main-owned identity for an Antigravity browser resident scope. */
  residentKey?: string;
};
type Registration = {
  cwd: Readonly<{ path: string; dev: number; ino: number }>;
  gate: Readonly<McpProxyGate>;
  binding?: PreparedMcpBinding;
  /** New gate/binding held until activateMcpProxyLaunch commits the rebind. */
  pendingGate?: Readonly<McpProxyGate>;
  pendingGeneration?: string;
  /** Active generation is sent to proxy-child in the bridge response header. */
  generation?: string;
  /** A promoted launch survives per-turn cleanup until its resident owner closes. */
  resident?: { key: string; owner: string };
  timer?: NodeJS.Timeout;
  connections: Set<(cause?: unknown) => void>;
};
type Frame = Record<string, any>;
type Policy = {
  mutating: (input: { catalogId?: string | null; toolName: string }) => boolean;
  planMutating: (input: { authority?: unknown; toolName: string; args?: unknown }) => boolean;
};
const launches = new Map<string, Registration>();
const residentLaunches = new Map<string, string>();
/**
 * A stale native wire can keep reconnecting after Main has revoked its handle.
 * Refusing that wire is correct, but logging every poll made a broken client
 * amplify both the log and Main's work indefinitely. Keep the refusal path
 * bounded as well as the live registry.
 */
const refusedHandleLogAt = new Map<string, number>();
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
const UNUSED_LAUNCH_MS = 5 * 60_000;
const MAX_ACTIVE_LAUNCHES = 256;
const MAX_CONNECTIONS_PER_LAUNCH = 8;
const REFUSED_LOG_COOLDOWN_MS = 30_000;
const MAX_REFUSED_LOGS_PER_WINDOW = 32;
let refusedLogWindowStartedAt = 0;
let refusedLogsInWindow = 0;

function logRefusedHandle(handle: string, reason: string): void {
  // Request URLs are untrusted input. Keep only the bounded handle prefix in
  // the diagnostic cache so a caller cannot allocate one new long string per
  // refusal while still preserving the useful opaque-id correlation.
  const key = handle.slice(0, 64);
  const now = Date.now();
  if (now - refusedLogWindowStartedAt >= REFUSED_LOG_COOLDOWN_MS) {
    refusedLogWindowStartedAt = now;
    refusedLogsInWindow = 0;
  }
  // Per-handle cooldown alone cannot bound a stream of distinct invalid URLs.
  if (refusedLogsInWindow >= MAX_REFUSED_LOGS_PER_WINDOW) return;
  const previous = refusedHandleLogAt.get(key) ?? 0;
  if (now - previous < REFUSED_LOG_COOLDOWN_MS) return;
  // Delete before insertion: the previous expiry-only pass could retain every
  // fresh unique key and grow without limit under a burst of refused wires.
  if (refusedHandleLogAt.size >= MAX_ACTIVE_LAUNCHES) {
    for (const [cachedKey, at] of refusedHandleLogAt) {
      if (now - at >= REFUSED_LOG_COOLDOWN_MS) refusedHandleLogAt.delete(cachedKey);
    }
    if (refusedHandleLogAt.size >= MAX_ACTIVE_LAUNCHES) {
      refusedHandleLogAt.delete(refusedHandleLogAt.keys().next().value!);
    }
  }
  refusedHandleLogAt.set(key, now);
  refusedLogsInWindow++;
  console.warn(`[mcp-proxy] bridge refused handle=${key.slice(0, 8)} reason=${reason}`);
}

function evictIdleLaunches(): void {
  if (launches.size < MAX_ACTIVE_LAUNCHES) return;
  for (const [handle, entry] of launches) {
    if (entry.connections.size || entry.resident || entry.binding) continue;
    launches.delete(handle);
    if (entry.timer) clearTimeout(entry.timer);
    if (launches.size < MAX_ACTIVE_LAUNCHES) return;
  }
}
function expireUnused(handle: string, entry: Registration): void {
  if (launches.get(handle) !== entry) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    // A promoted handle is owned by the resident CLI, not by the last HTTP
    // wire.  Its child may be idle for hours between turns; expiring the map
    // here would make that child hit terminal 403 and strand the session.
    if (!entry.connections.size && !entry.resident) launches.delete(handle);
  }, UNUSED_LAUNCH_MS);
  entry.timer.unref?.();
}
/** Main builder only. Serialized policy fields cannot register or upgrade a launch. */
export function prepareMcpProxyLaunch(gate: McpProxyGate): string {
  if (typeof gate.cwd !== "string" || !path.isAbsolute(gate.cwd)) throw new Error("mcp_proxy_cwd_invalid");
  let cwd: Registration["cwd"];
  try {
    const real = fs.realpathSync(gate.cwd), stat = fs.statSync(real);
    if (!stat.isDirectory()) throw new Error();
    fs.accessSync(real, fs.constants.R_OK | fs.constants.X_OK);
    cwd = Object.freeze({ path: real, dev: stat.dev, ino: stat.ino });
  } catch { throw new Error("mcp_proxy_cwd_unavailable"); }
  const normalizedGate = Object.freeze({ ...gate, cwd: cwd.path });
  if (gate.residentKey) {
    const existingHandle = residentLaunches.get(gate.residentKey);
    if (existingHandle) {
      const existing = launches.get(existingHandle);
      if (!existing?.resident || existing.resident.key !== gate.residentKey) {
        residentLaunches.delete(gate.residentKey);
      } else if (existing.gate.serverKey !== gate.serverKey || existing.gate.catalogId !== gate.catalogId
        || existing.cwd.path !== cwd.path || existing.cwd.dev !== cwd.dev || existing.cwd.ino !== cwd.ino) {
        throw new Error("mcp_proxy_resident_scope_conflict");
      } else {
        // Config materialization happens before the Antigravity pool lease is
        // acquired.  Never let a concurrent turn rebind an active resident
        // owner; that would interrupt its live browser call before the pool
        // has had a chance to serialize the turns.
        if (existing.binding) throw new Error("mcp_proxy_resident_scope_active");
        // A resident handle has one prepare -> activate transaction at a
        // time.  Without this fail-closed gate, two overlapping config builds
        // could overwrite pendingGate and activate turn B's policy with turn
        // A's prepared binding.  The caller may retry after the first build
        // either activates or cleans up the transaction.
        if (existing.pendingGate) throw new Error("mcp_proxy_resident_scope_busy");
        existing.pendingGate = normalizedGate;
        existing.pendingGeneration = randomUUID();
        return existingHandle;
      }
    }
  }
  evictIdleLaunches();
  if (launches.size >= MAX_ACTIVE_LAUNCHES) throw new Error("mcp_proxy_launch_capacity_exceeded");
  const handle = randomUUID();
  const entry: Registration = { cwd, gate: normalizedGate, connections: new Set(),
    ...(gate.residentKey ? { pendingGeneration: randomUUID() } : {}) };
  launches.set(handle, entry); expireUnused(handle, entry); return handle;
}
export function activateMcpProxyLaunch(handle: string, binding: PreparedMcpBinding): void {
  const entry = launches.get(handle);
  if (!entry || entry.gate.serverKey !== binding.configKey) throw new Error("mcp_proxy_launch_unapproved");
  if (preparedMcpTargetTransport(binding, binding.server).kind !== "stdio") throw new Error("mcp_proxy_transport_unsupported");
  if (entry.resident) {
    if (entry.binding) throw new Error("mcp_proxy_resident_scope_active");
    const nextGate = entry.pendingGate ?? entry.gate;
    const nextGeneration = entry.pendingGeneration ?? randomUUID();
    if (nextGate.serverKey !== binding.configKey || nextGate.residentKey !== entry.resident.key) {
      throw new Error("mcp_proxy_resident_scope_conflict");
    }
    // Rebinding is terminal for the old wire. Its child reconnects to the same
    // opaque handle and receives the new generation in the HTTP response.
    for (const close of [...entry.connections]) close("mcp_proxy_scope_rebound");
    entry.gate = nextGate;
    entry.binding = binding;
    entry.generation = nextGeneration;
    entry.pendingGate = undefined;
    entry.pendingGeneration = undefined;
    return;
  }
  entry.binding = binding;
  entry.generation = entry.pendingGeneration ?? randomUUID();
  entry.pendingGeneration = undefined;
}
/** Revoke only this Main-minted launch, including its attached wires. */
export function revokeMcpProxyLaunch(handle: string): void {
  const entry = launches.get(handle);
  if (!entry) return;
  if (entry.resident) {
    deactivateMcpProxyLaunch(handle);
    return;
  }
  launches.delete(handle);
  if (entry.timer) clearTimeout(entry.timer);
  for (const close of [...entry.connections]) close();
}
/**
 * Promote one already-prepared browser launch to a resident scope. This is
 * called only after the AGY resident process has produced a result; before
 * that point ordinary cleanup remains a hard revoke.
 */
export function promoteMcpProxyLaunch(handle: string): { key: string; owner: string } {
  const entry = launches.get(handle);
  const key = entry?.gate.residentKey;
  if (!entry || !key || !entry.binding) throw new Error("mcp_proxy_resident_promotion_unapproved");
  const currentHandle = residentLaunches.get(key);
  if (currentHandle && currentHandle !== handle) throw new Error("mcp_proxy_resident_scope_conflict");
  const owner = randomUUID();
  entry.resident = { key, owner };
  residentLaunches.set(key, handle);
  if (!entry.generation) entry.generation = entry.pendingGeneration ?? randomUUID();
  entry.pendingGeneration = undefined;
  return { key, owner };
}
/** A resident launch is inactive between turns but remains addressable. */
export function deactivateMcpProxyLaunch(handle: string): void {
  const entry = launches.get(handle);
  if (!entry) return;
  for (const close of [...entry.connections]) close("mcp_proxy_scope_revoked");
  entry.binding = undefined;
  entry.pendingGate = undefined;
  entry.pendingGeneration = undefined;
  entry.generation = undefined;
}
/** Drop an uncommitted resident prepare without touching its active owner. */
export function cancelMcpProxyLaunchPreparation(handle: string): void {
  const entry = launches.get(handle);
  if (!entry?.resident) return;
  entry.pendingGate = undefined;
  entry.pendingGeneration = undefined;
}
/** Close the stable handle only if this exact resident owner still owns it. */
export function revokeMcpProxyResidentKey(key: string, owner: string): boolean {
  const handle = residentLaunches.get(key);
  const entry = handle ? launches.get(handle) : undefined;
  if (!entry?.resident || entry.resident.key !== key || entry.resident.owner !== owner) return false;
  residentLaunches.delete(key);
  entry.resident = undefined;
  launches.delete(handle!);
  if (entry.timer) clearTimeout(entry.timer);
  for (const close of [...entry.connections]) close("mcp_proxy_scope_revoked");
  return true;
}
export function isPersistentMcpProxyLaunch(handle: string): boolean {
  return Boolean(launches.get(handle)?.resident);
}
export function mcpProxyLaunchResidentKey(handle: string): string | null {
  const entry = launches.get(handle);
  return entry?.gate.residentKey ?? entry?.resident?.key ?? null;
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
  residentLaunches.clear();
  refusedHandleLogAt.clear();
  refusedLogWindowStartedAt = 0;
  refusedLogsInWindow = 0;
  for (const entry of entries) {
    if (entry.timer) clearTimeout(entry.timer);
    for (const close of [...entry.connections]) close();
  }
}
function graphAllows(gate: Readonly<McpProxyGate>, tool: string): boolean {
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
  if (registration?.resident && !candidate && /^[a-f0-9-]{36}$/.test(handle)) {
    // A resident child remains alive between turns. Inactive is retryable;
    // only deletion/revocation is terminal 403. The next rebind supplies a
    // generation header and the child discards frames queued in this gap.
    logRefusedHandle(handle, "launch_scope_inactive");
    res.writeHead(409).end("mcp_proxy_scope_inactive"); return;
  }
  if (!registration || !candidate || !/^[a-f0-9-]{36}$/.test(handle)) {
    // 실측(2026-09-14): 컴퓨터 유즈가 한 앱 세션 안에서 35번 "not connected" 였는데 앱 로그엔 프록시 줄이 0건이었다.
    logRefusedHandle(handle, !registration ? "launch_unknown_or_expired" : !candidate ? "launch_not_activated" : "handle_invalid");
    res.writeHead(403).end("mcp_proxy_launch_unapproved"); return;
  }
  if (registration.connections.size >= MAX_CONNECTIONS_PER_LAUNCH) {
    logRefusedHandle(handle, "launch_connection_capacity_exceeded");
    res.writeHead(429).end("mcp_proxy_connection_capacity_exceeded"); return;
  }
  // A revoked seal cannot recover on the same handle. Reject before opening
  // a wire so proxy-child receives terminal 403, not a retryable socket reset.
  try { preparedMcpTargetTransport(candidate, candidate.server); validateLaunchCwd(registration.cwd); }
  catch {
    revokeMcpProxyLaunch(handle);
    res.writeHead(403).end("mcp_proxy_launch_unapproved"); return;
  }
  const entry = registration, binding: PreparedMcpBinding = candidate, gate = entry.gate, lifetime = new AbortController();
  const generation = entry.generation;
  if (!generation) {
    console.warn(`[mcp-proxy] bridge refused handle=${handle.slice(0, 8)} reason=launch_generation_missing`);
    res.writeHead(403).end("mcp_proxy_launch_unapproved"); return;
  }
  let transport: Transport | null = null, closed = false, initialized = false, buffer = "";
  setMaxListeners(0, lifetime.signal); // A lifetime can own any number of concurrent RPC waiters.
  const hostPrefix = `host:${randomUUID()}:`; let hostSequence = 0;
  const native = new Map<string, { id: string | number; method: string; controller?: AbortController; detach?: () => void; sent: boolean; effect?: ReturnType<typeof beginMainMcpEffect> }>();
  const external = new Map<string, string>();
  const serverRequests = new Map<string, string | number>();
  const serverRequestIds = new Map<string, string>();
  const internal = new Map<string, { resolve: (frame: Frame) => void; reject: (error: Error) => void; cleanup: () => void }>();
  const idKey = (id: unknown) => JSON.stringify(id);
  const validate = () => {
    if (closed || lifetime.signal.aborted) throw new Error("mcp_proxy_closed");
    // Rebinding is a turn boundary.  An async approval/inventory continuation
    // from the old wire must never validate against the new binding or grant.
    if (entry.binding !== binding || entry.generation !== generation) throw new Error("mcp_proxy_scope_rebound");
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
    for (const pending of native.values()) { pending.effect?.finish(); pending.controller?.abort(new Error("mcp_proxy_closed")); pending.detach?.(); }
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
  const up = async (frame: Frame) => {
    validate(); if (!transport) throw new Error("mcp_proxy_not_ready");
    await transport.send(frame as JSONRPCMessage);
  };
  const finish = (wireId: string, frame: Frame) => {
    const pending = native.get(wireId); if (!pending) return;
    pending.effect?.finish(frame);
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
      const pending = native.get(wireId); if (!pending) return; pending.sent = true; pending.effect?.dispatched();
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
    const tool = frame.params?.name, args = frame.params?.arguments ?? {};
    const effect = controller && typeof tool === "string" && args && typeof args === "object" && !Array.isArray(args)
      ? beginMainMcpEffect(binding, tool, args, isCanonicalSystemTimeMcpServer(binding.server) ? "time"
        : gate.planReadAuthority === "agentlas-browser" ? "native-browser" : null) : undefined;
    native.set(wireId, { id: frame.id, method: frame.method, controller, sent: !controller, effect,
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
    res.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
      // The native proxy child compares this before replaying frames queued
      // during a closed/rebound wire. A new generation never inherits them.
      "x-agentlas-mcp-proxy-generation": generation,
    }); res.flushHeaders();
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
