import { createHash } from "node:crypto";
import type { McpInvocationEvent } from "../shared/types";
import { couldHaveChangedTheOutsideWorld } from "../shared/tool-activity";
import { readOnlyBrowserToolIsMutating } from "../shared/read-only-browser-tools";

/** Host-owned repetition evidence; tool requests never prove successful progress. */
export const AUTOMATION_NO_PROGRESS_LOOP = "automation_no_progress_loop" as const;
export const NO_PROGRESS_LIMITS = Object.freeze({
  sameObservationPerNode: 5,
  sameUrlPerNode: 3,
  sameUrlPerRun: 6,
  identicalStreakPerNode: 4,
});

/** Memory bounds, not execution/goal budgets. Eviction never establishes progress. */
export const NO_PROGRESS_MEMORY_LIMITS = Object.freeze({ scopes: 128, entriesPerScope: 512, toolIdsPerScope: 2048 });
export interface NoProgressGuardOptions {
  /** Scheduled request observation remains available; native invocations use completed outcomes. */
  observationMode?: "requests" | "completed";
}
interface CallEvidence {
  name: string;
  requestKey: string;
  observation: boolean;
  urlKey: string | null;
  waiting: "timer" | "teammate" | null;
}
interface ScopeState {
  observationCounts: Map<string, number>;
  urlCounts: Map<string, number>;
  lastExact: string | null;
  exactStreak: number;
  pending: Map<string, CallEvidence>;
  seenToolIds: Map<string, true>;
  successfulMutations: Map<string, true>;
}
export interface NoProgressGuardState {
  observationMode: "requests" | "completed";
  scopes: Map<string, ScopeState>;
  runUrlCounts: Map<string, number>;
  tripped: NoProgressDecision | null;
}
export interface NoProgressDecision {
  reasonCode: typeof AUTOMATION_NO_PROGRESS_LOOP;
  rule: "same_observation" | "same_url_node" | "same_url_run" | "identical_streak";
  tool: string;
  /** Opaque digest only: URLs, arguments and returned content never enter the notice. */
  fingerprint: string;
  count: number;
  nodeId: string | null;
}
export function createNoProgressGuard(options: NoProgressGuardOptions = {}): NoProgressGuardState {
  return { observationMode: options.observationMode ?? "requests", scopes: new Map(), runUrlCounts: new Map(), tripped: null };
}
function boundedSet<K, V>(map: Map<K, V>, key: K, value: V, limit: number = NO_PROGRESS_MEMORY_LIMITS.entriesPerScope): void {
  if (!map.has(key) && map.size >= limit) map.delete(map.keys().next().value!);
  map.set(key, value);
}
function scopeState(state: NoProgressGuardState, key: string): ScopeState {
  let scope = state.scopes.get(key);
  if (!scope) {
    scope = { observationCounts: new Map(), urlCounts: new Map(), lastExact: null, exactStreak: 0,
      pending: new Map(), seenToolIds: new Map(), successfulMutations: new Map() };
    boundedSet(state.scopes, key, scope, NO_PROGRESS_MEMORY_LIMITS.scopes);
  }
  return scope;
}
export function shortToolName(name: string): string {
  const trimmed = (name ?? "").trim();
  const short = trimmed.startsWith("mcp__") && trimmed.lastIndexOf("__") > 4
    ? trimmed.slice(trimmed.lastIndexOf("__") + 2) : trimmed;
  // These are transport prefixes, not arbitrary tool namespaces.
  return short.replace(/^(?:agentlas-browser|one-team)[.·/]/, "").toLowerCase();
}
function parseArgs(raw: string | undefined): unknown {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return raw; }
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
/** Preserve changing media observations without copying their bytes into the event ledger. */
export function toolObservationDigest(artifactPaths?: readonly string[], imageDataUrl?: string): string | undefined {
  if (!imageDataUrl && !artifactPaths?.length) return undefined;
  const hash = createHash("sha256").update("tool-observation-v1\0");
  for (const file of artifactPaths ?? []) hash.update(String(file.length)).update(":").update(file);
  hash.update("\0").update(imageDataUrl ?? "");
  return hash.digest("hex");
}
/** Paths, query strings, fragments, www hosts and numbered resources can be distinct work. */
export function normalizeNavigationUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try { return new URL(value.trim()).href; } catch { return value.trim(); }
}
function legitimateWaitKind(name: string, args: unknown): CallEvidence["waiting"] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;
  if (name === "browser_wait_for") {
    return Object.keys(a).every((key) => key === "time") && positive(a.time) ? "timer" : null;
  }
  if (name === "one_team_session_status") {
    return Object.keys(a).every((key) => ["session_id", "wait_seconds"].includes(key))
      && typeof a.session_id === "string" && Number.isInteger(a.wait_seconds) && positive(a.wait_seconds)
      && Number(a.wait_seconds) <= 180 ? "teammate" : null;
  }
  return null;
}
function hasRunningTeammateResult(result: string, depth = 0): boolean {
  if (depth > 2) return false;
  try {
    const value = JSON.parse(result);
    if (value?.status === "running") return true;
    // MCP envelopes carry the typed status result in a text block.
    return Array.isArray(value?.content) && value.content.some((part: { type?: string; text?: string }) =>
      part.type === "text" && typeof part.text === "string" && hasRunningTeammateResult(part.text, depth + 1));
  } catch { return false; }
}
function callEvidence(tool: NonNullable<McpInvocationEvent["tool"]>): CallEvidence | null {
  if (tool.args === undefined) return null;
  let name = shortToolName(tool.name);
  let args = parseArgs(tool.args);
  if (name === "call_mcp_tool" && args && typeof args === "object" && !Array.isArray(args)) {
    const envelope = args as Record<string, unknown>;
    if (typeof envelope.ToolName === "string" && envelope.ToolName.trim()) {
      name = shortToolName(envelope.ToolName);
      args = envelope.Arguments ?? {};
    }
  }
  const a = args as Record<string, unknown> | null;
  const url = name === "browser_navigate" || (name === "browser_tabs" && a?.action === "new")
    ? normalizeNavigationUrl(a?.url) : null;
  return { name, requestKey: digest(`${name} ${stableJson(args)}`),
    observation: !couldHaveChangedTheOutsideWorld(name) || !readOnlyBrowserToolIsMutating({ toolName: name, args }),
    urlKey: url ? digest(url) : null, waiting: legitimateWaitKind(name, args) };
}
function trip(state: NoProgressGuardState, decision: Omit<NoProgressDecision, "reasonCode">): NoProgressDecision {
  return state.tripped = { reasonCode: AUTOMATION_NO_PROGRESS_LOOP, ...decision };
}

/** Requests and completions have separate identities; only completed results can establish progress. */
export function noteNoProgressEvent(state: NoProgressGuardState, event: McpInvocationEvent): NoProgressDecision | null {
  if (state.tripped) return state.tripped;
  if (event.kind !== "tool-use" || !event.tool?.name) return null;
  const tool = event.tool;
  const nodeId = event.nodeId?.trim() || null;
  // Several admitted workers can independently read the same source. Their
  // first completed observations are not repetition by one execution actor.
  const actorId = event.agentId?.trim() || null;
  const scopeKey = JSON.stringify([nodeId, actorId]);
  const scope = scopeState(state, scopeKey);
  const id = tool.id?.trim();
  const idKey = id ? digest(id) : null;
  const observationDigest = typeof tool.observationDigest === "string" && /^[a-f0-9]{64}$/.test(tool.observationDigest)
    ? tool.observationDigest : undefined;
  const completed = tool.result !== undefined || tool.isError === true || observationDigest !== undefined;
  const pending = idKey ? scope.pending.get(idKey) : undefined;
  const call = callEvidence(tool) ?? pending;
  if (!call) return null;
  if (!completed) {
    if (idKey) {
      if (scope.seenToolIds.has(idKey)) return null;
      if (scope.pending.has(idKey)) {
        boundedSet(scope.pending, idKey, call, NO_PROGRESS_MEMORY_LIMITS.toolIdsPerScope);
        return null;
      }
      boundedSet(scope.pending, idKey, call, NO_PROGRESS_MEMORY_LIMITS.toolIdsPerScope);
    }
    if (state.observationMode === "completed" || !call.observation || call.waiting) return null;
  } else {
    if (idKey) {
      if (scope.seenToolIds.has(idKey)) return null;
      scope.pending.delete(idKey);
      boundedSet(scope.seenToolIds, idKey, true, NO_PROGRESS_MEMORY_LIMITS.toolIdsPerScope);
    }
    // A successful intentional wait is not evidence of a loop or of a mutation.
    if (tool.result !== undefined && tool.isError !== true && (call.waiting === "timer"
      || (call.waiting === "teammate" && hasRunningTeammateResult(tool.result)))) return null;
  }
  const outcomeKey = completed
    ? digest(`${call.requestKey} ${tool.isError === true ? "error" : "result"} ${tool.result ?? ""} ${observationDigest ?? ""}`)
    : call.requestKey;
  // Explicit runner success is required to clear an observation interval. Repeating the
  // same successful mutation/result cannot repeatedly erase a stalled-read history.
  if (completed && !call.observation && (tool.result !== undefined || observationDigest !== undefined) && tool.isError === false
    && !scope.successfulMutations.has(outcomeKey)) {
    boundedSet(scope.successfulMutations, outcomeKey, true);
    scope.observationCounts.clear();
    scope.urlCounts.clear();
    state.runUrlCounts.clear();
    scope.lastExact = null;
    scope.exactStreak = 0;
    return null;
  }
  // In scheduled request mode the observation request was already counted. A failed
  // completion still contributes failure evidence; it never clears that request count.
  if (completed && state.observationMode === "requests" && call.observation && pending && tool.isError !== true) return null;
  const exact = state.observationMode === "requests" && call.observation && tool.isError !== true ? call.requestKey : outcomeKey;
  scope.exactStreak = scope.lastExact === exact ? scope.exactStreak + 1 : 1;
  scope.lastExact = exact;
  if (scope.exactStreak >= NO_PROGRESS_LIMITS.identicalStreakPerNode) {
    return trip(state, { rule: "identical_streak", tool: call.name, fingerprint: exact, count: scope.exactStreak, nodeId });
  }
  if (call.urlKey && call.observation) {
    const urlKey = state.observationMode === "completed" ? digest(`${call.urlKey} ${outcomeKey}`) : call.urlKey;
    const nodeCount = (scope.urlCounts.get(urlKey) ?? 0) + 1;
    boundedSet(scope.urlCounts, urlKey, nodeCount);
    const runKey = state.observationMode === "completed" ? digest(`${scopeKey} ${urlKey}`) : urlKey;
    const runCount = (state.runUrlCounts.get(runKey) ?? 0) + 1;
    boundedSet(state.runUrlCounts, runKey, runCount);
    if (nodeCount >= NO_PROGRESS_LIMITS.sameUrlPerNode)
      return trip(state, { rule: "same_url_node", tool: call.name, fingerprint: urlKey, count: nodeCount, nodeId });
    if (runCount >= NO_PROGRESS_LIMITS.sameUrlPerRun)
      return trip(state, { rule: "same_url_run", tool: call.name, fingerprint: urlKey, count: runCount, nodeId });
    return null;
  }
  const count = (scope.observationCounts.get(exact) ?? 0) + 1;
  boundedSet(scope.observationCounts, exact, count);
  if (count >= NO_PROGRESS_LIMITS.sameObservationPerNode)
    return trip(state, { rule: "same_observation", tool: call.name, fingerprint: exact, count, nodeId });
  return null;
}








export function noProgressLoopOwnerText(decision: NoProgressDecision, locale: "ko" | "en"): string {
  if (locale === "ko") {
    const where = decision.nodeId ? `"${decision.nodeId}" 단계에서 ` : "";
    const what = decision.rule === "same_url_node" || decision.rule === "same_url_run"
      ? `같은 페이지 관찰을 ${decision.count}번 되풀이해`
      : decision.rule === "identical_streak"
        ? `똑같은 ${decision.tool} 호출을 ${decision.count}번 연달아 되풀이해`
        : `같은 ${decision.tool} 작업을 ${decision.count}번 되풀이해`;
    return `${where}${what}, 제자리를 돌지 않도록 호스트가 이 실행을 멈췄습니다.`;
  }
  return noProgressLoopError(decision).replace(`${AUTOMATION_NO_PROGRESS_LOOP}: `, "").replace(/^the run/, "The run");
}

/** 사람이 읽는 한 줄 + 맨 앞 기계 표식. 분류기는 표식만 본다. */
export function noProgressLoopError(decision: NoProgressDecision): string {
  const where = decision.nodeId ? ` in step "${decision.nodeId}"` : "";
  const what = decision.rule === "same_url_node" || decision.rule === "same_url_run"
    ? `repeated the same page observation ${decision.count} times`
    : decision.rule === "identical_streak"
      ? `repeated the identical ${decision.tool} call ${decision.count} times in a row`
      : `repeated the same ${decision.tool} operation ${decision.count} times without new evidence`;
  return `${AUTOMATION_NO_PROGRESS_LOOP}: the run ${what}${where}, so the host stopped it instead of letting it loop.`;
}
