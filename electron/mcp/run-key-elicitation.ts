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
  promise: Promise<"provided" | "declined" | "timeout">;
  settle: (outcome: "provided" | "declined" | "timeout") => void;
  settled: boolean;
}

const pendingByRunId = new Map<string, PendingElicitation>();

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
): McpRunKeyRequest | null {
  const missing = tools.filter((tool) => tool.state === "missing-key" && tool.missingEnv.length > 0);
  if (missing.length === 0) return null;
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
  entry.settle(outcome === "provided" ? "provided" : "declined");
  return { ok: true };
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
  return [
    `Credential elicitation result: ${cause} for: ${names}.`,
    "These tools are unavailable for this run. Do not call them, do not pretend they worked, and do not ask the user again for these credentials.",
    "Instead, choose an alternative tool or approach from the tools that ARE available this run and tell the user which substitute you used.",
    "If nothing available can substitute for the task, say so plainly, name the missing capability, and stop instead of fabricating results.",
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
  const request = buildRunKeyRequest(opts.runId, opts.context.tools);
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
