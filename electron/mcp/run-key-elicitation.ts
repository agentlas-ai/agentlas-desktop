// Runtime API-key elicitation for interactive chat runs.
//
// Before this gate existed, auto-select marked matched tools "missing-key" and
// only appended prose telling the LLM to "ask in chat" — no UI ever appeared and
// no fallback logic existed. This module owns the pre-launch elicitation window:
//  1. When one or more MATCHED tools are missing credentials on an interactive
//     renderer run, emit a structured `mcp-key-request` sink event and wait a
//     bounded window for the renderer's McpKeyRequestSheet to respond over the
//     `mcp:supplyRunKeys` IPC channel.
//  2. Secret values NEVER travel through this module or its IPC channel — the
//     renderer saves each key with the existing `env:set` vault handler and the
//     IPC response here only signals "provided" | "declined".
//  3. On decline/timeout (or keys still missing after save) the run proceeds
//     WITHOUT those tools plus an honest system-prompt block instructing the
//     model to pick an alternative from what IS available — that block is the
//     fallback-on-decline.
// Unattended runs (automation / site-studio / trex / telegram / agent-app) must
// never block on a human: callers pass interactive:false and the gate is a
// pure no-op that emits nothing.
import { MCP_TOOL_CATALOG } from "../mcp-tools/catalog";
import { hasEnvVar, listEnvKeys, renameEnvVar } from "../secrets/vault";
import { mediaToolEnvKeys, planEnvKeyRenames } from "../runtime/env-key-reach";
import type { AutoSelectedMcpTool } from "../mcp-tools/auto-select";
import type { McpInvocationEvent, McpRunKeyRequest } from "../../shared/types";

type KeyElicitationSink = (ev: McpInvocationEvent) => void;

export type RunKeyElicitationOutcome = "provided" | "declined" | "timeout" | "skipped";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

export function runKeyElicitationTimeoutMs(): number {
  const raw = Number(process.env.AGENTLAS_MCP_KEY_REQUEST_TIMEOUT_MS);
  if (Number.isFinite(raw) && raw > 0) return Math.min(raw, MAX_TIMEOUT_MS);
  return DEFAULT_TIMEOUT_MS;
}

interface PendingElicitation {
  request: McpRunKeyRequest;
  promise: Promise<"provided" | "declined" | "timeout">;
  settle: (outcome: "provided" | "declined" | "timeout") => void;
  settled: boolean;
}

const pendingByRunId = new Map<string, PendingElicitation>();

/**
 * Key requests of runs the background service hosts, as Main saw them (flow audit 2026-10-18, I-D2).
 *
 * A daemon-hosted interactive run keeps its pending request in the daemon's memory and sends its mcp-key-request
 * event to the window over the native stream. Every answer path (mcp:supplyRunKeys, mcp:useStoredRunKey,
 * oneVault:openRunKeyRequest / runKeyStatus) looked only in Main's memory, so a decline, a saved key or a renamed
 * stored key never reached the run: it waited out its 120 s window and continued without the tool, "not provided in
 * time" (the add14fc8 class: state held by the process that hosts the run, answers looked up in Main).
 * Main now mirrors that request from the service's own event (value-free, the exact object the service holds) and
 * hands each answer to the hosting service over the signed channel; the service settles only its exact pending
 * request. Secret values never travel: "provided" is Main's receipt-gate verdict, and the service re-reads its own
 * vault when it reselects the tools.
 */
interface HostedElicitation { chatId: string; request: McpRunKeyRequest }
const hostedByRunId = new Map<string, HostedElicitation>();
const MAX_HOSTED_ELICITATIONS = 64;
export interface RunKeyOwnerHost {
  /** True when the hosting service settled that exact pending request, false when it had none; throws when the answer
   * could not be delivered (the mirror is kept for a retry). */
  deliver(target: Readonly<{ chatId: string; runId: string; request: Readonly<McpRunKeyRequest> }>, outcome: "declined" | "provided"): Promise<boolean>;
}
let ownerHost: RunKeyOwnerHost | null = null;
/** Main only (its IPC registration): the route to the service that hosts a run. A re-registration replaces it. */
export function configureRunKeyOwnerHost(host: RunKeyOwnerHost): void {
  if (typeof host?.deliver !== "function") throw new Error("mcp_key_owner_host_invalid");
  ownerHost = host;
}
function hostedElicitation(runId: string): HostedElicitation | null {
  const entry = hostedByRunId.get(runId);
  if (!entry) return null;
  if (entry.request.expiresAt <= Date.now()) { hostedByRunId.delete(runId); return null; }
  return entry;
}
/** Main: one event of a run the background service hosts (native-gui-events). A key request is mirrored; the run's own
 * final or error retires it. A run this process hosts never takes this path. */
export function observeHostedRunKeyEvent(runId: string, chatId: string, event: Pick<McpInvocationEvent, "kind" | "agentId" | "keyRequest">): void {
  if (event.kind === "mcp-key-request") {
    const request = event.keyRequest;
    if (!request || request.runId !== runId || pendingByRunId.has(runId) || !(request.expiresAt > Date.now())) return;
    hostedByRunId.delete(runId);
    hostedByRunId.set(runId, { chatId, request: structuredClone(request) });
    for (const [id, entry] of hostedByRunId) if (entry.request.expiresAt <= Date.now()) hostedByRunId.delete(id);
    while (hostedByRunId.size > MAX_HOSTED_ELICITATIONS) hostedByRunId.delete(hostedByRunId.keys().next().value!);
    return;
  }
  if (!event.agentId && (event.kind === "final" || event.kind === "error")) hostedByRunId.delete(runId);
}
async function deliverHosted(runId: string, entry: HostedElicitation, outcome: "declined" | "provided"): Promise<boolean> {
  const host = ownerHost;
  if (!host) return false;
  let settled: boolean;
  try { settled = await host.deliver({ chatId: entry.chatId, runId, request: entry.request }, outcome) === true; }
  catch { return false; }
  // Answered either way: settled now, or the service no longer holds it (timed out, aborted, answered elsewhere).
  if (hostedByRunId.get(runId) === entry) hostedByRunId.delete(runId);
  return settled;
}
/** Service side: the window's answer for a run this process hosts, over the signed native channel. Only the exact
 * pending request (same requestId and expiry) settles. */
export function settleRunKeyElicitationFromWindow(
  runId: string,
  expected: Readonly<{ requestId: string; expiresAt: number }>,
  outcome: "declined" | "provided",
): boolean {
  const entry = pendingByRunId.get(runId);
  if (!entry || entry.settled || entry.request.requestId !== expected.requestId || entry.request.expiresAt !== expected.expiresAt
    || entry.request.expiresAt <= Date.now() || (outcome !== "declined" && outcome !== "provided")) return false;
  entry.settle(outcome);
  return true;
}

/** Main-authored, value-free identity; never accept this scope from model text. */
export interface GoalKeyElicitationScope {
  goalId: string;
  revision: number;
  scopeHash: string;
  userMessageId: string;
  configurationRevision: number;
  automaticContinuation: boolean;
  isCurrent: () => boolean;
}
interface DeferredKeyReceipt {
  outcome: "declined" | "timeout";
  expiresAt: number;
  isCurrent: () => boolean;
}
const deferredKeys = new Map<string, DeferredKeyReceipt>();
const DEFERRED_KEY_TTL_MS = 30 * 60_000;
let deferredKeyCleanup: ReturnType<typeof setInterval> | undefined;
function scopeIsCurrent(scope: { isCurrent: () => boolean }): boolean {
  try { return scope.isCurrent(); } catch { return false; }
}
function pruneDeferredKeys(): void {
  for (const [key, receipt] of deferredKeys) {
    if (receipt.expiresAt <= Date.now() || !scopeIsCurrent(receipt)) deferredKeys.delete(key);
  }
  if (!deferredKeys.size && deferredKeyCleanup) {
    clearInterval(deferredKeyCleanup);
    deferredKeyCleanup = undefined;
  }
}
function deferredKeyIdentity(scope: GoalKeyElicitationScope, request: McpRunKeyRequest): string {
  return JSON.stringify([scope.goalId, scope.revision, scope.scopeHash, scope.userMessageId,
    scope.configurationRevision, request.tools.map((tool) => [tool.id, tool.envKeys.map((entry) => entry.key).sort()])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

/** Structured, value-free key request for the renderer sheet. Null when every
 *  matched tool already has its credentials. */
export function buildRunKeyRequest(
  runId: string,
  tools: AutoSelectedMcpTool[],
  timeoutMs = runKeyElicitationTimeoutMs(),
  /** Saved env key names (value-free). A saved name that looks like a missing key is offered on the sheet. */
  storedNames: readonly string[] = [],
): McpRunKeyRequest | null {
  const missing = tools.filter((tool) => tool.state === "missing-key" && tool.missingEnv.length > 0);
  if (missing.length === 0) return null;
  const knownRead = [
    ...MCP_TOOL_CATALOG.flatMap((entry) => entry.envRequirements.map((req) => req.key)),
    ...mediaToolEnvKeys(),
  ];
  const wanted = missing.flatMap((tool) => tool.missingEnv);
  const matches = new Map(planEnvKeyRenames(storedNames, wanted, knownRead).map((s) => [s.to, s.from]));
  return {
    requestId: runId,
    runId,
    expiresAt: Date.now() + timeoutMs,
    tools: missing.map((tool) => {
      const entry = MCP_TOOL_CATALOG.find((candidate) => candidate.id === tool.id);
      return {
        id: tool.id,
        name: tool.name,
        ...(entry?.setupUrl ? { setupUrl: entry.setupUrl } : {}),
        envKeys: tool.missingEnv.map((key) => {
          const requirement = entry?.envRequirements.find((req) => req.key === key);
          return {
            key,
            ...(matches.has(key) ? { storedMatch: matches.get(key)! } : {}),
            ...(requirement?.label ? { label: requirement.label } : {}),
            ...(requirement?.labelEn ? { labelEn: requirement.labelEn } : {}),
            ...(requirement?.hint ? { hint: requirement.hint } : {}),
            ...(requirement?.hintEn ? { hintEn: requirement.hintEn } : {}),
          };
        }),
      };
    }),
  };
}

/** Emit the sheet event once and wait for the renderer (or the timeout/abort).
 *  Idempotent per runId: a second call while one window is pending returns the
 *  SAME promise and emits nothing. */
export function awaitRunKeyElicitation(opts: {
  runId: string;
  request: McpRunKeyRequest;
  sink: KeyElicitationSink;
  signal?: AbortSignal;
}): Promise<"provided" | "declined" | "timeout"> {
  const existing = pendingByRunId.get(opts.runId);
  if (existing) return existing.promise;

  let resolvePromise!: (outcome: "provided" | "declined" | "timeout") => void;
  const promise = new Promise<"provided" | "declined" | "timeout">((resolve) => {
    resolvePromise = resolve;
  });
  const entry: PendingElicitation = {
    request: structuredClone(opts.request),
    promise,
    settled: false,
    settle: () => {},
  };
  // NOTE: the timer stays ref'd on purpose — a pending elicitation window is an
  // active await inside a live run, and an unref'd timer let a bare Node event
  // loop drain and exit before the bounded window resolved.
  const timer = setTimeout(
    () => entry.settle("timeout"),
    Math.max(0, opts.request.expiresAt - Date.now()),
  );
  const onAbort = () => entry.settle("declined");
  entry.settle = (outcome) => {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    pendingByRunId.delete(opts.runId);
    resolvePromise(outcome);
  };
  pendingByRunId.set(opts.runId, entry);
  if (opts.signal?.aborted) {
    entry.settle("declined");
    return promise;
  }
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    opts.sink({ kind: "mcp-key-request", keyRequest: opts.request });
  } catch {
    // A broken sink must not hang the run — fall through to the timeout.
  }
  return promise;
}

/** IPC entry (`mcp:supplyRunKeys`). Signals completion only — never values.
 *  Unknown/duplicate runIds are a safe no-op ({ ok: false }). */
export function resolveRunKeyElicitation(runId: string, outcome: unknown): { ok: boolean } {
  const entry = pendingByRunId.get(String(runId));
  if (!entry || entry.settled) return { ok: false };
  // A renderer signal cannot certify OS custody. Main's exact receipt gate owns "provided".
  if(outcome==='provided')return {ok:false};
  entry.settle("declined");
  return { ok: true };
}
/** IPC entry for a decline from any window: a run this process hosts settles here, a daemon-hosted run's decline goes
 *  to its service (I-D2). Same answer shape as resolveRunKeyElicitation. */
export async function resolveRunKeyElicitationAnywhere(runId: string, outcome: unknown): Promise<{ ok: boolean }> {
  const id = String(runId);
  if (pendingByRunId.has(id)) return resolveRunKeyElicitation(id, outcome);
  const hosted = hostedElicitation(id);
  if (!hosted || outcome !== "declined") return { ok: false };
  return { ok: await deliverHosted(id, hosted, "declined") };
}
/** Main-only read of the original pending intent; no secret values or caller-built scope. A daemon-hosted run's
 *  request is the one its service sent (I-D2). */
export function pendingRunKeyElicitation(runId:string):McpRunKeyRequest|null {
  const entry=pendingByRunId.get(runId);
  if(entry)return !entry.settled&&entry.request.expiresAt>Date.now()?structuredClone(entry.request):null;
  const hosted=hostedElicitation(runId);
  return hosted?structuredClone(hosted.request):null;
}
let nativeSavedGate:((request:Readonly<McpRunKeyRequest>)=>boolean|Promise<boolean>)|null=null;
export function configureRunKeySavedReceiptGate(gate:(request:Readonly<McpRunKeyRequest>)=>boolean|Promise<boolean>):void {
  if(nativeSavedGate&&nativeSavedGate!==gate)throw new Error('mcp_key_receipt_gate_already_configured');nativeSavedGate=gate;
}
export async function resolveRunKeysFromNativeReceipt(runId:string):Promise<{ok:boolean}> {
  const entry=pendingByRunId.get(runId);
  if(!entry){
    // A daemon-hosted run: Main's receipt gate decides, the hosting service settles (I-D2).
    const hosted=hostedElicitation(runId),gate=nativeSavedGate;
    if(!hosted||!gate)return{ok:false};
    try{if(await gate(Object.freeze(structuredClone(hosted.request)))!==true)return{ok:false};}catch{return{ok:false};}
    if(hostedElicitation(runId)!==hosted||nativeSavedGate!==gate)return{ok:false};
    return{ok:await deliverHosted(runId,hosted,'provided')};
  }
  if(!entry||entry.settled||entry.request.expiresAt<=Date.now()||!nativeSavedGate)return{ok:false};
  const gate=nativeSavedGate;
  try{if(await gate(Object.freeze(structuredClone(entry.request)))!==true)return{ok:false};}catch{return{ok:false};}
  if(pendingByRunId.get(runId)!==entry||entry.settled||entry.request.expiresAt<=Date.now()||nativeSavedGate!==gate)return{ok:false};
  entry.settle('provided');return{ok:true};
}

/**
 * The owner's yes on the sheet: "use the saved key <storedName> as <keyName>". Main accepts it only for a name it
 * offered itself on this pending request, renames inside the vault (the value never leaves Main), and releases the run
 * only when every key the request asked for is now saved. It never runs without the sheet's click.
 */
export async function resolveRunKeyWithStoredName(
  runId: string,
  toolId: string,
  keyName: string,
  storedName: string,
): Promise<{ ok: boolean; resolved: boolean }> {
  const entry = pendingByRunId.get(runId);
  if (!entry) return resolveHostedRunKeyWithStoredName(runId, toolId, keyName, storedName);
  if (entry.settled || entry.request.expiresAt <= Date.now()) return { ok: false, resolved: false };
  const offered = entry.request.tools.find((tool) => tool.id === toolId)?.envKeys.find((key) => key.key === keyName);
  if (!offered || offered.storedMatch !== storedName) return { ok: false, resolved: false };
  const renamed = await renameEnvVar(storedName, keyName);
  if (!renamed.ok) return { ok: false, resolved: false };
  if (pendingByRunId.get(runId) !== entry || entry.settled) return { ok: true, resolved: false };
  const wanted = entry.request.tools.flatMap((tool) => tool.envKeys.map((key) => key.key));
  const saved = await Promise.all(wanted.map((key) => hasEnvVar(key).catch(() => false)));
  if (!saved.every(Boolean) || entry.settled) return { ok: true, resolved: false };
  entry.settle("provided");
  return { ok: true, resolved: true };
}

/** The same yes for a daemon-hosted run (I-D2): the rename happens in Main's vault as above, and the hosting service is
 *  released only when every requested key is saved; it re-reads its own vault when it reselects. */
async function resolveHostedRunKeyWithStoredName(runId: string, toolId: string, keyName: string, storedName: string): Promise<{ ok: boolean; resolved: boolean }> {
  const hosted = hostedElicitation(runId);
  if (!hosted) return { ok: false, resolved: false };
  const offered = hosted.request.tools.find((tool) => tool.id === toolId)?.envKeys.find((key) => key.key === keyName);
  if (!offered || offered.storedMatch !== storedName) return { ok: false, resolved: false };
  const renamed = await renameEnvVar(storedName, keyName);
  if (!renamed.ok) return { ok: false, resolved: false };
  if (hostedElicitation(runId) !== hosted) return { ok: true, resolved: false };
  const wanted = hosted.request.tools.flatMap((tool) => tool.envKeys.map((key) => key.key));
  const saved = await Promise.all(wanted.map((key) => hasEnvVar(key).catch(() => false)));
  if (!saved.every(Boolean) || hostedElicitation(runId) !== hosted) return { ok: true, resolved: false };
  return { ok: true, resolved: await deliverHosted(runId, hosted, "provided") };
}

/** Test/diagnostic surface: is a key window pending for this run? */
export function hasPendingRunKeyElicitation(runId: string): boolean {
  return pendingByRunId.has(runId);
}

/** Honest fallback block for tools that stay locked. English on purpose — it
 *  joins the English auto-selection system prompt. */
export function buildDeclinedKeyFallbackPrompt(
  tools: Array<{ id: string; name: string }>,
  reason: "declined" | "timeout" | "still-missing",
): string {
  if (tools.length === 0) return "";
  const names = tools.map((tool) => `${tool.id} (${tool.name})`).join(", ");
  const cause =
    reason === "timeout"
      ? "the user did not provide the required API keys in time"
      : reason === "still-missing"
        ? "the required API keys are still not configured after setup"
        : "the user declined to provide the required API keys (or does not have them)";
  // Composition order: fixed → variable (docs/PROMPT-COMPOSITION-POLICY.md, ledger desktop.mcp.run-key-elicitation.declined-fallback).
  return [
    "The tools named in the credential elicitation result below are unavailable for this run. Do not call them, do not pretend they worked, and do not ask the user again for these credentials.",
    "Instead, choose an alternative tool or approach from the tools that ARE available this run and tell the user which substitute you used.",
    "If nothing available can substitute for the task, say so plainly, name the missing capability, and stop instead of fabricating results.",
    `Credential elicitation result: ${cause} for: ${names}.`,
  ].join(" ");
}

export interface RunKeyElicitationGateResult<TContext extends { tools: AutoSelectedMcpTool[] }> {
  context: TContext;
  outcome: RunKeyElicitationOutcome;
  /** Non-empty only when tools remain locked — append to the auto-selection prompt. */
  fallbackPrompt: string;
}

/** Full pre-launch gate used by runMcpInvocation. Interactive renderer runs
 *  only; every unattended path passes interactive:false and gets the original
 *  context back untouched with zero events emitted. */
export async function runMcpKeyElicitationGate<TContext extends { tools: AutoSelectedMcpTool[] }>(opts: {
  runId: string | undefined;
  /** True only for renderer/mobile-less interactive chat runs — never automations. */
  interactive: boolean;
  context: TContext;
  sink: KeyElicitationSink;
  signal?: AbortSignal;
  /** Re-runs auto-selection after keys were saved; may throw (kept fail-open). */
  reselect: () => Promise<TContext>;
  /** Main validates active Goal, actual user turn, registry and credential revision. */
  goalScope?: GoalKeyElicitationScope;
}): Promise<RunKeyElicitationGateResult<TContext>> {
  const skipped: RunKeyElicitationGateResult<TContext> = {
    context: opts.context,
    outcome: "skipped",
    fallbackPrompt: "",
  };
  if (!opts.interactive || !opts.runId) return skipped;
  let storedNames: string[] = [];
  if (opts.context.tools.some((tool) => tool.state === "missing-key" && tool.missingEnv.length > 0)) {
    try { storedNames = await listEnvKeys(); } catch { /* a locked vault only drops the rename offer */ }
  }
  const request = buildRunKeyRequest(opts.runId, opts.context.tools, runKeyElicitationTimeoutMs(), storedNames);
  if (!request) return skipped;
  pruneDeferredKeys();
  const scope = opts.goalScope;
  const identity = scope?.userMessageId && scopeIsCurrent(scope) ? deferredKeyIdentity(scope, request) : null;
  const prior = identity && scope?.automaticContinuation && !opts.signal?.aborted
    ? deferredKeys.get(identity) : undefined;
  if (prior) {
    return { context: opts.context, outcome: prior.outcome,
      fallbackPrompt: buildDeclinedKeyFallbackPrompt(request.tools, prior.outcome) };
  }
  const outcome = await awaitRunKeyElicitation({
    runId: opts.runId,
    request,
    sink: opts.sink,
    signal: opts.signal,
  });
  // Abort currently settles the UI promise as declined; it is never a user's
  // credential decision and must not suppress a future request.
  if (identity && scope && !opts.signal?.aborted && scopeIsCurrent(scope)) {
    if (outcome === "provided") deferredKeys.delete(identity);
    else {
      deferredKeys.delete(identity);
      deferredKeys.set(identity, { outcome, expiresAt: Date.now() + DEFERRED_KEY_TTL_MS, isCurrent: scope.isCurrent });
      while (deferredKeys.size > 128) deferredKeys.delete(deferredKeys.keys().next().value!);
      if (!deferredKeyCleanup) {
        deferredKeyCleanup = setInterval(pruneDeferredKeys, 30_000);
        deferredKeyCleanup.unref?.();
      }
    }
  }
  if (outcome === "provided") {
    let refreshed = opts.context;
    try {
      refreshed = await opts.reselect();
    } catch {
      // Keep the original selection; still-missing tools fall through below.
    }
    const stillMissing = refreshed.tools.filter(
      (tool) =>
        tool.state === "missing-key" &&
        tool.missingEnv.length > 0 &&
        request.tools.some((requested) => requested.id === tool.id),
    );
    return {
      context: refreshed,
      outcome,
      fallbackPrompt: buildDeclinedKeyFallbackPrompt(stillMissing, "still-missing"),
    };
  }
  return {
    context: opts.context,
    outcome,
    fallbackPrompt: buildDeclinedKeyFallbackPrompt(request.tools, outcome),
  };
}
