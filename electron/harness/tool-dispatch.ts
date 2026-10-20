import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HarnessCallContext } from "./capability-ports";
import type { InstalledMcpServer } from "../../shared/types";
import type { PreparedMcpBinding } from "../mcp-tools/prepared-transport";
import { redactSecrets } from "../../shared/secret-patterns";
import { redactToolJson, redactToolText } from "./tool-result-store";
import { didYouMean } from "../../shared/did-you-mean";

/*
 * Harness tool dispatch ports (docs/2026-10-13-native-harness/15 §7-8):
 *   tool.call / tool.result / tool.cancel / tool.subscribe / result.read, plus the backend of mcp.app.resource.read.
 *
 * The one MCP client of this app does the wire work (electron/mcp-tools/client.ts: callServerToolContent,
 * testServerConnection) -- nothing here spawns or speaks MCP itself. This file adds what the ports promise on top:
 *   - the call is checked against the CURRENT inventory (providerRef, tool, schemaDigest) before anything is sent;
 *   - dispatch happens ONCE; a transport that died after the request left is "dispatch-unsettled", never replayed;
 *   - the exact result is retained durably under a resultRef (userData/harness/tool-results/<callId>.json, binary
 *     parts as sibling files) and is never auto-deleted;
 *   - in-flight calls can be cancelled (AbortController) and settle honestly.
 *
 * Personal mode is always-allow with no per-action approval (contract policy); the gate is "installed + enabled +
 * current schema + credentials present". No electron import at top level: the daemon loads this module.
 */

type PortOutcome =
  | { status: "ok"; data: unknown }
  | { status: "refused" | "unavailable"; reason: string; next?: string };
type Args = Record<string, unknown>;

const ok = (data: unknown): PortOutcome => ({ status: "ok", data });
const refused = (reason: string, next?: string): PortOutcome => ({ status: "refused", reason, ...(next ? { next } : {}) });
const str = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

// ── receipts (same durable ledger file as capability-ports; that module's appender is not exported) ─────────────────

async function appendReceipt(entry: Record<string, unknown>): Promise<string> {
  const receiptId = `hr_${randomUUID()}`;
  try {
    const { userDataPath } = await import("../runtime-paths");
    const file = userDataPath(path.join("harness", "receipts.jsonl"));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ receiptId, at: new Date().toISOString(), ...entry });
    if (Buffer.byteLength(line) <= 64 * 1024) fs.appendFileSync(file, `${line}\n`, { mode: 0o600 });
  } catch {
    // Evidence, not a gate.
  }
  return receiptId;
}

// ── call records ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ToolCallState = "dispatching" | "running" | "succeeded" | "tool-error" | "failed" | "cancelled" | "dispatch-unsettled";
const TERMINAL: ReadonlySet<ToolCallState> = new Set(["succeeded", "tool-error", "failed", "cancelled", "dispatch-unsettled"]);

interface CallEvent { sequence: number; at: string; type: string; detail?: Record<string, unknown> }
interface ArtifactRef { index: number; mimeType: string; file: string; bytes: number; sha256: string }

interface CallRecord {
  schemaVersion: "agentlas.tool-call-record.v1";
  callId: string;
  resultRef: string;
  chatId: string;
  runId: string;
  toolId: string;
  /** Absent on genuine native-port results; legacy MCP records retain their existing fields. */
  providerRef?: string;
  serverId?: string;
  schemaDigest?: string;
  origin?: { kind: "native-port"; operationId: string; ownerScope: string };
  argumentsDigest: string;
  argumentKeys: string[];
  state: ToolCallState;
  startedAt: string;
  settledAt: string | null;
  cancelRequested: boolean;
  error: { code: string; boundary?: string; message: string } | null;
  events: CallEvent[];
  result: {
    isError: boolean;
    text: string;
    original: Record<string, unknown>;
    artifacts: ArtifactRef[];
    /** Hash of the UNREDACTED result as received (computed in memory; the original text is never stored). */
    originalSha256: string;
    /** Hash of the bytes in `original` as stored. Equal to originalSha256 exactly when redacted is false. */
    storedSha256: string;
    /** True when credential-shaped text was masked before storing. Binary sibling files are not masked. */
    redacted: boolean;
  } | null;
}

interface LiveCall { record: CallRecord; controller: AbortController; done: Promise<void> }
const live = new Map<string, LiveCall>();

const CALL_ID = /^(?:tc|np)_[0-9a-f-]{36}$/;
const refToCallId = (ref: string): string | null => {
  const id = ref.startsWith("result:") ? ref.slice(7) : "";
  return CALL_ID.test(id) ? id : null;
};

async function storeDir(): Promise<string> {
  const { userDataPath } = await import("../runtime-paths");
  const dir = userDataPath(path.join("harness", "tool-results"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

async function persist(record: CallRecord): Promise<void> {
  const dir = await storeDir();
  const file = path.join(dir, `${record.callId}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

async function pushEvent(record: CallRecord, type: string, detail?: Record<string, unknown>): Promise<void> {
  record.events.push({ sequence: record.events.length + 1, at: new Date().toISOString(), type, ...(detail ? { detail } : {}) });
  await persist(record);
}

/** A record found "running" with no live runner belongs to a dead process: honest outcome is unsettled, not a retry. */
async function loadRecord(callId: string, ownerChatId: string, ctx: HarnessCallContext): Promise<CallRecord | null> {
  const active = live.get(callId);
  if (active) return active.record.chatId === ownerChatId ? active.record : null;
  let record: CallRecord;
  try { record = JSON.parse(fs.readFileSync(path.join(await storeDir(), `${callId}.json`), "utf8")) as CallRecord; } catch { return null; }
  // Refuse before reconciling a dead process: a foreign read may neither see nor mutate its call.
  if (record.chatId !== ownerChatId) return null;
  if (record.origin?.kind === "native-port") {
    try { if (await nativePortOwnerScope(ctx) !== record.origin.ownerScope) return null; } catch { return null; }
  }
  if (!TERMINAL.has(record.state)) {
    record.state = "dispatch-unsettled";
    record.settledAt = new Date().toISOString();
    record.error = { code: "dispatch-unsettled", message: "the process that sent this call ended before an outcome was recorded; the call is not replayed" };
    await pushEvent(record, "settled", { state: record.state, reason: "process_ended" });
  }
  return record;
}

const view = (record: CallRecord) => ({
  callId: record.callId,
  resultRef: record.resultRef,
  state: record.state,
  terminal: TERMINAL.has(record.state),
  toolId: record.toolId,
  providerRef: record.providerRef,
  schemaDigest: record.schemaDigest,
  startedAt: record.startedAt,
  settledAt: record.settledAt,
  cancelRequested: record.cancelRequested,
  ...(record.error ? { error: record.error } : {}),
  ...(record.state === "dispatch-unsettled" ? { note: "the request may or may not have taken effect on the provider; check the provider's own state before any retry" } : {}),
  ...(record.result ? { redacted: record.result.redacted === true, preview: record.result.text.slice(0, 4000), previewTruncated: record.result.text.length > 4000, isError: record.result.isError, artifacts: record.result.artifacts.map(({ index, mimeType, bytes }) => ({ index, mimeType, bytes })) } : {}),
});

/** Model authority comes from the bound run; the owner's renderer must name the conversation it is showing. */
function retainedCallOwner(args: Args, ctx: HarnessCallContext): { chatId: string } | { reason: string } {
  if (ctx.chatId === "ui") {
    const chatId = str(args.chatId);
    return chatId ? { chatId } : { reason: "owner_chat_required" };
  }
  if (!str(ctx.chatId)) return { reason: "owner_chat_required" };
  if (args.chatId !== undefined && args.chatId !== ctx.chatId) return { reason: "owner_chat_mismatch" };
  return { chatId: ctx.chatId };
}

/** Host authority only. A renderer may read its current account, while a run must carry its sealed binding. */
export async function nativePortOwnerScope(ctx: HarnessCallContext): Promise<string> {
  const { getAuthenticatedSessionBinding } = await import("../auth");
  const current = getAuthenticatedSessionBinding();
  const expected = ctx.hostAccountBinding;
  if (!current || (!expected && ctx.chatId !== "ui") || (expected && (expected.workspaceId !== current.workspaceId || expected.userId !== current.userId || expected.sessionId !== current.sessionId))) throw new Error("native_result_owner_changed");
  return sha(JSON.stringify([current.workspaceId, current.userId]));
}

/** Retain an actual completed native operation; no MCP server, transport or model-authored reference is invented. */
export async function retainNativePortResult(ctx: HarnessCallContext, operationId: string, args: Args, original: Record<string, unknown>, ownerScope: string): Promise<{ callId: string; resultRef: string }> {
  if (ctx.dryRun || !str(ctx.chatId) || ctx.chatId === "ui" || !str(ctx.runId) || !/^[a-z][a-z0-9_.-]+$/.test(operationId)) throw new Error("native_result_binding_invalid");
  ctx.signal?.throwIfAborted();
  if (await nativePortOwnerScope(ctx) !== ownerScope) throw new Error("native_result_owner_changed");
  const callId = `np_${randomUUID()}`, at = new Date().toISOString();
  const received = JSON.stringify(original), raw = redactToolJson(original), stored = JSON.stringify(raw);
  const record: CallRecord = {
    schemaVersion: "agentlas.tool-call-record.v1", callId, resultRef: `result:${callId}`, chatId: ctx.chatId, runId: ctx.runId,
    toolId: operationId, origin: { kind: "native-port", operationId, ownerScope }, argumentsDigest: sha(JSON.stringify(args)), argumentKeys: Object.keys(args).slice(0, 64),
    state: "succeeded", startedAt: at, settledAt: at, cancelRequested: false, error: null,
    events: [{ sequence: 1, at, type: "settled", detail: { state: "succeeded", operationId } }],
    result: { isError: false, text: "", original: raw, artifacts: [], originalSha256: sha(received), storedSha256: sha(stored), redacted: received !== stored },
  };
  ctx.signal?.throwIfAborted();
  if (await nativePortOwnerScope(ctx) !== ownerScope) throw new Error("native_result_owner_changed");
  await persist(record);
  return { callId, resultRef: record.resultRef };
}

// ── inventory (current schema of one connector) ──────────────────────────────────────────────────────────────────────

async function installedServers(): Promise<InstalledMcpServer[]> {
  const { listInstalledServers } = await import("../mcp-tools/registry");
  try { return listInstalledServers(); } catch { return []; }
}

/** providerRef: catalog id, server id, or `connector:<id>`. */
export async function findServer(providerRef: string): Promise<InstalledMcpServer | null> {
  const ref = providerRef.replace(/^connector:/, "").replace(/^tool:/, "");
  const all = (await installedServers()).filter((server) => server.id === ref || server.catalogId === ref);
  return all.find((server) => server.enabled) ?? all[0] ?? null;
}

type InventoryTool = { name: string; [key: string]: unknown };











export type RunScopedBinding =
  | { ok: true; server: InstalledMcpServer; prepared?: PreparedMcpBinding }
  | { ok: false; code: "not_available_in_this_run" | "run_binding_ended"; next: string };

/** The launch a harness port must use for `server` in this call: the run's prepared binding for a host-channel tool. */
export async function runScopedBinding(server: InstalledMcpServer, ctx?: Pick<HarnessCallContext, "mcpConfigPath">): Promise<RunScopedBinding> {
  const { hostChannelToolIds } = await import("../plugins/builtin");
  if (!server.catalogId || !hostChannelToolIds().has(server.catalogId)) return { ok: true, server };
  const unavailable = { ok: false as const, code: "not_available_in_this_run" as const,
    next: `${server.catalogId} is attached only to runs whose own tool list carries it; this run has none, so use your listed tools or report the missing capability` };
  const configPath = str(ctx?.mcpConfigPath);
  if (!configPath) return unavailable;
  const { preparedMcpBindings } = await import("../mcp-tools/prepared-transport");
  let bindings: PreparedMcpBinding[];
  try { bindings = preparedMcpBindings(configPath); } catch {
    return { ok: false, code: "run_binding_ended", next: "this run's tool binding ended or changed; the next turn binds tools again" };
  }
  const prepared = bindings.find((binding) => binding.server.id === server.id)
    ?? bindings.find((binding) => binding.server.catalogId === server.catalogId);
  return prepared ? { ok: true, server: prepared.server, prepared } : unavailable;
}

/** Current tools/list of one installed connector, with the digest tool.call must carry. */
export async function describeConnectorTools(providerRef: string, ctx?: Pick<HarnessCallContext, "mcpConfigPath">): Promise<
  | { ok: true; server: InstalledMcpServer; prepared?: PreparedMcpBinding; tools: Array<{ name: string; description: string; schemaDigest: string; inputSchema: unknown }> }
  | { ok: false; code: string; next?: string }
> {
  const installed = await findServer(providerRef);
  if (!installed) return { ok: false, code: "not-installed", next: "connector.search finds installed connectors" };
  if (!installed.enabled) return { ok: false, code: "disabled", next: "connector.connect switches it on" };
  const bound = await runScopedBinding(installed, ctx);
  if (!bound.ok) return { ok: false, code: bound.code, next: bound.next };
  const { server, prepared } = bound;
  const { testServerConnection } = await import("../mcp-tools/client");
  const { mcpToolSchemaDigest } = await import("../mcp-tools/tool-schema");
  const status = await testServerConnection(server, { timeoutMs: 20_000, ...(prepared ? { prepared } : {}) });
  if (status.missingEnv.length > 0 || status.failureCode === "authentication_required") return { ok: false, code: "auth-required", next: "auth.status then auth.ensure/auth.login" };
  if (!status.connected) return { ok: false, code: "offline", next: "connector.status; retry when the server answers" };
  return {
    ok: true,
    server,
    ...(prepared ? { prepared } : {}),
    tools: (status.tools as InventoryTool[]).map((tool) => ({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description.slice(0, 280) : "",
      schemaDigest: mcpToolSchemaDigest(tool),
      inputSchema: tool.inputSchema ?? null,
    })),
  };
}

// ── tool.call ────────────────────────────────────────────────────────────────────────────────────────────────────────

const BINARY_INLINE_LIMIT = 16 * 1024;
const inlineWaitMs = (): number => {
  const value = Number(process.env.AGENTLAS_TOOL_INLINE_WAIT_MS);
  return Number.isFinite(value) && value >= 0 ? value : 20_000;
};

/** Binary parts leave the JSON as sibling files; the remaining structure is the received result. */
async function retainOriginal(callId: string, raw: Record<string, unknown>): Promise<{ original: Record<string, unknown>; artifacts: ArtifactRef[] }> {
  const dir = await storeDir();
  const artifacts: ArtifactRef[] = [];
  const content = Array.isArray(raw.content) ? raw.content : [];
  const next = content.map((item, index) => {
    if (!item || typeof item !== "object") return item;
    const part = item as Record<string, unknown>;
    const holder = typeof part.data === "string" ? "data" : part.resource && typeof (part.resource as Record<string, unknown>).blob === "string" ? "blob" : null;
    if (!holder) return item;
    const base64 = holder === "data" ? (part.data as string) : ((part.resource as Record<string, unknown>).blob as string);
    if (base64.length < BINARY_INLINE_LIMIT) return item;
    const bytes = Buffer.from(base64, "base64");
    const file = `${callId}.part-${index}.bin`;
    fs.writeFileSync(path.join(dir, file), bytes, { mode: 0o600 });
    const mimeType = typeof part.mimeType === "string" ? part.mimeType : typeof (part.resource as Record<string, unknown> | undefined)?.mimeType === "string" ? ((part.resource as Record<string, unknown>).mimeType as string) : "application/octet-stream";
    artifacts.push({ index, mimeType, file, bytes: bytes.length, sha256: sha(bytes) });
    if (holder === "data") return { ...part, data: undefined, artifactRef: { index, file, bytes: bytes.length, sha256: sha(bytes) } };
    return { ...part, resource: { ...(part.resource as Record<string, unknown>), blob: undefined, artifactRef: { index, file, bytes: bytes.length, sha256: sha(bytes) } } };
  });
  return { original: { ...raw, content: next }, artifacts };
}

async function settle(call: LiveCall, state: ToolCallState, error: CallRecord["error"], extra?: Record<string, unknown>): Promise<void> {
  const { record } = call;
  record.state = state;
  record.error = error ? { ...error, message: redactSecrets(error.message) } : error;
  record.settledAt = new Date().toISOString();
  await pushEvent(record, "settled", { state, ...(error ? { code: error.code } : {}), ...extra });
  await appendReceipt({ operationId: "tool.call.settled", callId: record.callId, resultRef: record.resultRef, state, providerRef: record.providerRef, toolId: record.toolId, chatId: record.chatId, runId: record.runId });
}

async function run(call: LiveCall, server: InstalledMcpServer, args: Args, prepared?: PreparedMcpBinding): Promise<void> {
  const { record, controller } = call;
  const { callServerToolContent, McpToolCallError } = await import("../mcp-tools/client");
  try {
    record.state = "running";
    await pushEvent(record, "started");
    const result = await callServerToolContent(server, record.toolId, args, {
      ...(prepared ? { prepared } : {}),
      expectedToolSchemaDigest: record.schemaDigest,
      retainFullResult: true,
      signal: controller.signal,
      timeoutMs: 45_000,
    });
    if (!result) { await settle(call, "failed", { code: "auth-required", message: "the connector is missing credentials" }); return; }
    const received = (result.rawResult ?? { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) }) as Record<string, unknown>;
    // G03: mask secrets before anything is stored or previewed. originalSha256 is of the received bytes (in memory only).
    const originalSha256 = sha(JSON.stringify(received));
    const raw = redactToolJson(received);
    const storedRaw = sha(JSON.stringify(raw));
    const text = redactToolText(result.text);
    const { original, artifacts } = await retainOriginal(record.callId, raw);
    record.result = { isError: result.isError, text: text.text, original, artifacts, originalSha256, storedSha256: storedRaw,
      redacted: text.redacted || originalSha256 !== storedRaw };
    await settle(call, result.isError ? "tool-error" : "succeeded", null);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    if (error instanceof McpToolCallError) {
      if (error.boundary === "pre-request-error") {
        if (record.cancelRequested) await settle(call, "cancelled", { code: "cancelled", boundary: error.boundary, message: "cancelled before the request was sent" });
        else if (/mcp_prepared_tool_schema_changed|mcp_tool_not_in_current_inventory/.test(message)) await settle(call, "failed", { code: "stale-schema", boundary: error.boundary, message });
        else await settle(call, "failed", { code: "provider-failure", boundary: error.boundary, message });
      } else if (error.boundary === "ambiguous-transport") {
        await settle(call, "dispatch-unsettled", { code: "dispatch-unsettled", boundary: error.boundary, message: record.cancelRequested ? `cancel requested after send: ${message}` : message });
      } else {
        await settle(call, "failed", { code: "provider-failure", boundary: error.boundary, message });
      }
    } else {
      await settle(call, record.cancelRequested ? "cancelled" : "failed", { code: record.cancelRequested ? "cancelled" : "provider-failure", message });
    }
  } finally {
    live.delete(record.callId);
  }
}

export async function toolCall(args: Args, ctx: HarnessCallContext): Promise<PortOutcome> {
  const toolRef = str(args.toolId);
  const providerRef = str(args.providerRef);
  const schemaDigest = str(args.schemaDigest);
  const callArgs = args.arguments;
  if (!toolRef || !providerRef || !schemaDigest || !callArgs || typeof callArgs !== "object" || Array.isArray(callArgs)) {
    return refused("invalid-input", "required: toolId, providerRef, schemaDigest, arguments (object)");
  }
  if (ctx.dryRun) return refused("dry_run", "a dry run validates only; nothing was dispatched");

  const inventory = await describeConnectorTools(providerRef, ctx);
  if (!inventory.ok) return refused(inventory.code, inventory.next);
  const toolName = toolRef.replace(/^tool:/, "").replace(new RegExp(`^${providerRef.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[:/]`), "");
  const tool = inventory.tools.find((item) => item.name === toolName);
  if (!tool) {
    // A misspelled tool name names the closest one the connector lists now (names tool.describe shows); it is never called instead.
    const near = didYouMean(toolName, inventory.tools.map((item) => item.name));
    return refused("stale-binding", `the connector no longer lists ${toolName}; tool.describe for the current tools${near ? `.${near}` : ""}`);
  }
  if (tool.schemaDigest !== schemaDigest) return refused("stale-schema", `current schemaDigest is ${tool.schemaDigest}; re-read the schema before calling`);

  const callId = `tc_${randomUUID()}`;
  const controller = new AbortController();
  const record: CallRecord = {
    schemaVersion: "agentlas.tool-call-record.v1",
    callId,
    resultRef: `result:${callId}`,
    chatId: ctx.chatId,
    runId: ctx.runId,
    toolId: toolName,
    providerRef,
    serverId: inventory.server.id,
    schemaDigest,
    argumentsDigest: sha(JSON.stringify(callArgs)),
    argumentKeys: Object.keys(callArgs as object).slice(0, 64),
    state: "dispatching",
    startedAt: new Date().toISOString(),
    settledAt: null,
    cancelRequested: false,
    error: null,
    events: [],
    result: null,
  };
  const entry = { record, controller } as LiveCall;
  live.set(callId, entry);
  await pushEvent(record, "accepted");
  // The accept receipt is written before the request can leave: an uncertain outcome always has evidence of the attempt.
  await appendReceipt({ operationId: "tool.call", callId, resultRef: record.resultRef, providerRef, toolId: toolName, schemaDigest, argumentsDigest: record.argumentsDigest, chatId: ctx.chatId, runId: ctx.runId });
  entry.done = run(entry, inventory.server, callArgs as Args, inventory.prepared).catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([entry.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, inlineWaitMs()); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  return ok(view(record));
}

// ── tool.result / tool.cancel / tool.subscribe ───────────────────────────────────────────────────────────────────────

export async function toolResult(args: Args, ctx: HarnessCallContext): Promise<PortOutcome> {
  const callId = str(args.callId);
  if (!CALL_ID.test(callId)) return refused("invalid-input", "callId comes from tool.call");
  const owner = retainedCallOwner(args, ctx);
  if ("reason" in owner) return refused(owner.reason);
  const record = await loadRecord(callId, owner.chatId, ctx);
  return record ? ok(view(record)) : refused("not-found", "no such call on this machine");
}

export async function toolCancel(args: Args, ctx: HarnessCallContext): Promise<PortOutcome> {
  const callId = str(args.callId);
  if (!CALL_ID.test(callId)) return refused("invalid-input", "callId comes from tool.call");
  if (ctx.dryRun) return refused("dry_run", "a dry run cancels nothing");
  const owner = retainedCallOwner(args, ctx);
  if ("reason" in owner) return refused(owner.reason);
  const active = live.get(callId);
  if (!active) {
    const record = await loadRecord(callId, owner.chatId, ctx);
    return record ? ok({ ...view(record), alreadySettled: true }) : refused("not-found", "no such call on this machine");
  }
  if (active.record.chatId !== owner.chatId) return refused("not-found", "no such call on this machine");
  active.record.cancelRequested = true;
  await pushEvent(active.record, "cancel_requested");
  await appendReceipt({ operationId: "tool.cancel", callId, resultRef: active.record.resultRef, chatId: ctx.chatId, runId: ctx.runId });
  active.controller.abort();
  // Settlement is whatever the transport boundary proves; wait briefly for it, then report what is known.
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([active.done, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5_000); timer.unref?.(); })]);
  if (timer) clearTimeout(timer);
  return ok(view(active.record));
}

export async function toolSubscribe(args: Args, ctx: HarnessCallContext): Promise<PortOutcome> {
  const callId = str(args.callId);
  const after = Number(args.afterSequence);
  if (!CALL_ID.test(callId) || !Number.isInteger(after) || after < 0) return refused("invalid-input", "callId and afterSequence (integer >= 0)");
  const owner = retainedCallOwner(args, ctx);
  if ("reason" in owner) return refused(owner.reason);
  const record = await loadRecord(callId, owner.chatId, ctx);
  if (!record) return refused("not-found", "no such call on this machine");
  const events = record.events.filter((event) => event.sequence > after);
  return ok({ callId, state: record.state, terminal: TERMINAL.has(record.state), events, nextSequence: record.events.length });
}

// ── result.read ──────────────────────────────────────────────────────────────────────────────────────────────────────

const clamp = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
};

function pageText(text: string, cursor: string, limit: number): { content: string; nextCursor: string | null; totalChars: number } | null {
  const offset = cursor === "" ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return null;
  const end = Math.min(text.length, offset + limit);
  return { content: text.slice(offset, end), nextCursor: end < text.length ? String(end) : null, totalChars: text.length };
}

export async function resultRead(args: Args, ctx: HarnessCallContext): Promise<PortOutcome> {
  const callId = refToCallId(str(args.resultRef));
  const part = str(args.part);
  if (!callId || !["original", "structured", "artifact", "summary"].includes(part)) return refused("invalid-input", "resultRef from tool.call; part: original|structured|artifact|summary");
  const owner = retainedCallOwner(args, ctx);
  if ("reason" in owner) return refused(owner.reason);
  const record = await loadRecord(callId, owner.chatId, ctx);
  if (!record) return refused("not-found", "no such result on this machine");
  if (!record.result) return refused("result-not-ready", `call state is ${record.state}; tool.result shows progress`);
  const cursor = str(args.cursor);
  const limit = clamp(args.limit, 64_000, 1_000, 256_000);
  const index = args.index === undefined ? null : Number(args.index);
  const { result } = record;
  const content = Array.isArray(result.original.content) ? result.original.content : [];

  if (part === "summary") {
    const page = pageText(result.text, cursor, limit);
    return page ? ok({ part, isError: result.isError, redacted: result.redacted === true, storedSha256: result.storedSha256, originalSha256: result.originalSha256, ...page }) : refused("invalid-input", "cursor out of range");
  }
  if (part === "structured") {
    const structured = result.original.structuredContent;
    if (structured === undefined) return refused("part_absent", "this result has no structuredContent; read part original or summary");
    const page = pageText(JSON.stringify(structured), cursor, limit);
    return page ? ok({ part, ...page }) : refused("invalid-input", "cursor out of range");
  }
  if (part === "original") {
    let selected: unknown = result.original;
    if (index !== null) {
      if (!Number.isInteger(index) || index < 0 || index >= content.length) return refused("invalid-input", `index out of range (0..${content.length - 1})`);
      selected = content[index];
    }
    const page = pageText(JSON.stringify(selected), cursor, limit);
    return page ? ok({ part, redacted: result.redacted === true, ...(record.origin?.kind === "native-port" ? { nativeBinding: { ...record.origin, chatId: record.chatId, runId: record.runId, callId: record.callId } } : {}), ...(index !== null ? { index } : { originalSha256: result.originalSha256, storedSha256: result.storedSha256, partCount: content.length }), ...page }) : refused("invalid-input", "cursor out of range");
  }
  // artifact: list, or one binary part paged by byte offset (base64).
  if (index === null) return ok({ part, artifacts: result.artifacts.map(({ index: i, mimeType, bytes, sha256 }) => ({ index: i, mimeType, bytes, sha256 })) });
  const artifact = result.artifacts.find((item) => item.index === index);
  if (!artifact) return refused("part_absent", "no binary part at that index; part artifact without index lists them");
  const offset = cursor === "" ? 0 : Number(cursor);
  if (!Number.isInteger(offset) || offset < 0 || offset > artifact.bytes) return refused("invalid-input", "cursor out of range");
  const pageBytes = Math.floor(clamp(args.limit, 48_000, 3_000, 192_000) / 3) * 3;
  const fd = fs.openSync(path.join(await storeDir(), artifact.file), "r");
  try {
    const buffer = Buffer.alloc(Math.min(pageBytes, artifact.bytes - offset));
    fs.readSync(fd, buffer, 0, buffer.length, offset);
    const end = offset + buffer.length;
    return ok({ part, index, mimeType: artifact.mimeType, bytes: artifact.bytes, sha256: artifact.sha256, encoding: "base64", content: buffer.toString("base64"), nextCursor: end < artifact.bytes ? String(end) : null });
  } finally {
    fs.closeSync(fd);
  }
}

// ── mcp.app.resource.read ────────────────────────────────────────────────────────────────────────────────────────────

export interface McpResourceContents { contents: Array<{ uri: string; mimeType?: string; text?: string; blob?: string; _meta?: Record<string, unknown> }>; _meta?: Record<string, unknown> }
export type McpResourceReader = (server: InstalledMcpServer, uri: string, options: { signal?: AbortSignal; timeoutMs?: number }) => Promise<McpResourceContents>;

let resourceReaderOverride: McpResourceReader | null = null;
/** Test seam only. Production resolves `readServerResource` exported by mcp-tools/client (see mcpAppResourceRead). */
export function setMcpResourceReaderForTest(reader: McpResourceReader | null): void { resourceReaderOverride = reader; }

const MAX_APP_HTML_BYTES = 5 * 1024 * 1024;

export async function mcpAppResourceRead(args: Args, _ctx: HarnessCallContext): Promise<PortOutcome> {
  const connectorId = str(args.connectorId);
  const uri = str(args.uri);
  if (!connectorId || !uri) return refused("invalid-input", "required: connectorId, uri");
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return refused("invalid-input", "uri must be a ui:// resource URI"); }
  if (parsed.protocol !== "ui:") return refused("invalid-input", "only ui:// resources are served to MCP Apps views");
  const server = await findServer(connectorId);
  if (!server) return refused("not-installed", "connector.search finds installed connectors");
  if (!server.enabled) return refused("disabled", "connector.connect switches it on");

  let reader: McpResourceReader | null = resourceReaderOverride;
  if (!reader) {
    const client = (await import("../mcp-tools/client")) as unknown as { readServerResource?: McpResourceReader };
    reader = client.readServerResource ?? null;
  }
  if (!reader) return { status: "unavailable", reason: "missing-port", next: "mcp-tools/client.ts must export readServerResource(server, uri, { signal, timeoutMs }) -> resources/read result" };

  let read: McpResourceContents;
  try {
    read = await reader(server, uri, { timeoutMs: 20_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 300) : "unknown error";
    return refused(/401|unauthor|credential/i.test(message) ? "auth-required" : "provider-failure", message);
  }
  const item = read.contents.find((entry) => entry.uri === uri) ?? read.contents[0];
  if (!item) return refused("provider-failure", "the server returned no contents for that uri");
  const mimeType = item.mimeType ?? "";
  if (!/^text\/html\b/i.test(mimeType)) return refused("unsupported-mime", `expected text/html;profile=mcp-app, got ${mimeType || "none"}`);
  const html = typeof item.text === "string" ? item.text : typeof item.blob === "string" ? Buffer.from(item.blob, "base64").toString("utf8") : null;
  if (html === null) return refused("provider-failure", "the resource has neither text nor blob");
  if (Buffer.byteLength(html) > MAX_APP_HTML_BYTES) return refused("provider-failure", "the app resource exceeds 5 MB");
  const meta = (item._meta ?? read._meta ?? {}) as Record<string, unknown>;
  const ui = (meta.ui && typeof meta.ui === "object" ? meta.ui : {}) as Record<string, unknown>;
  return ok({
    connectorId: server.id,
    uri,
    mimeType,
    html,
    htmlSha256: sha(html),
    ...(ui.csp !== undefined ? { csp: ui.csp } : {}),
    ...(ui.domain !== undefined ? { domain: ui.domain } : {}),
    ...(ui.permissions !== undefined ? { permissions: ui.permissions } : {}),
    ...(ui.prefersBorder !== undefined ? { prefersBorder: ui.prefersBorder } : {}),
  });
}

export const TOOL_PORT_HANDLERS: Record<string, (args: Args, ctx: HarnessCallContext) => Promise<PortOutcome>> = {
  "tool.call": toolCall,
  "tool.result": toolResult,
  "tool.cancel": toolCancel,
  "tool.subscribe": toolSubscribe,
  "result.read": resultRead,
  "mcp.app.resource.read": mcpAppResourceRead,
};
