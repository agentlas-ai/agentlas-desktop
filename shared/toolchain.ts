// Adaptive Toolchain — pure learning core (no Electron, no store).
//
// Design: docs/2026-10-03-adaptive-toolchain/PLAN.md (local-only doc).
//
// What this file decides, and why each rule exists (all measured on the live
// store, 2026-10-03):
//
//  · A case is "the same graph node", identified by a digest of the node's own
//    definition (type + config), never by the graph digest and never by the node
//    id alone. One automation changed its graph 30 times in 30 days and replaced
//    18 node ids; a graph-level digest made 123 of 132 strategy proposals stale
//    before any evidence could accumulate.
//  · Host bookkeeping rows are not actions. `Agentlas Plugins · …` pseudo tool
//    events were 7,560 rows in 30 days and were the ten most "repeated" patterns.
//  · Tool names are runtime dialects. The same shell read is `bash` (codex),
//    `run_command` (antigravity) and `Bash` (claude-code); the same browser call
//    is `browser_navigate` or `mcp__agentlas-browser__browser_navigate`.
//  · Only executed, judged evidence counts. A text summary is never promotion
//    evidence (720 promoted "experiences" were copies of the request text).
//
// Nothing here writes anything. Callers own persistence and side effects.

import { createHash } from "node:crypto";

import { canonicalJsonValue } from "./graph-execution-digest";
import { isHostPreflightTool } from "./tool-activity";
import { classifyTool } from "./tool-taxonomy";
import type { WorkflowNode } from "./types";

// ── Node identity ────────────────────────────────────────────────────────────

/**
 * Digest of what a node *does*: its type and config. Position, label and id are
 * presentation or naming and must not split one case into two.
 */
export function nodeDefinitionDigest(node: Pick<WorkflowNode, "type" | "config">): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalJsonValue({ type: node.type, config: node.config ?? {} })))
    .digest("hex")}`;
}

// ── Runtime-independent tool vocabulary ──────────────────────────────────────

export type ToolClass =
  | "shell_read" // a shell command proven observation-only by parseShellRead
  | "shell" // any other shell command (unknown effect)
  | "file_read"
  | "file_write"
  | "browse_nav"
  | "browse_read"
  | "browse_act"
  | "browse_code"
  | "web_search"
  | "clock"
  | "other";

/** `mcp__agentlas-browser__browser_navigate` / `playwright.browser_navigate` → `browser_navigate`. */
export function normalizeToolName(name: string): string {
  let value = String(name || "").trim();
  const mcp = value.match(/^mcp__[^_]+(?:[-_][^_]+)*__(.+)$/);
  if (mcp) value = mcp[1];
  // `server.tool` → `tool`, but a script name such as `cua_repl.js` is the tool itself.
  const dotted = value.lastIndexOf(".");
  if (dotted >= 0 && dotted < value.length - 1 && !/\.(?:m?js|cjs|py)$/i.test(value)) value = value.slice(dotted + 1);
  return value.toLowerCase();
}

/**
 * Runtime-independent step class. Which runtime calls what by which name is the
 * canonical taxonomy's job (shared/tool-taxonomy.ts) — this file only maps its
 * answer onto the classes pattern mining needs, so a new runtime's tool names are
 * learned in one place.
 */
export function toolClassOf(name: string, args?: unknown): ToolClass {
  const tool = normalizeToolName(name);
  if (tool === "get_current_time") return "clock";
  if (tool.startsWith("browser_") || tool === "cua_repl.js") return browserStepOf(tool);
  const action = classifyTool(tool);
  if (action === "command") return parseShellRead(shellCommandOf(args)) ? "shell_read" : "shell";
  if (action === "read" || action === "search") return "file_read";
  if (action === "file") return "file_write";
  if (action === "fetch") return "web_search";
  if (action === "browser") return "browse_act";
  return "other";
}

// judgment-exempt: this splits a browser step into navigation / observation /
//   interaction for page-read mining. It never answers "did the outside change" —
//   that stays with couldHaveChangedTheOutsideWorld — and a page-read candidate is
//   never applied without a cost measurement and the owner's approval.
function browserStepOf(tool: string): ToolClass {
  if (/^browser_(?:navigate|navigate_back|tabs|resize)$/.test(tool)) return "browse_nav";
  if (/^browser_(?:snapshot|find|take_screenshot|wait_for|network_requests?|console_messages|skill_list)$/.test(tool)) return "browse_read";
  if (/^browser_(?:evaluate|run_code|run_code_unsafe|cua_repl)$/.test(tool) || tool === "cua_repl.js") return "browse_code";
  return "browse_act";
}

/**
 * Host rows are not agent actions. The host's own recognizer is the single
 * definition (shared/tool-activity.ts) — a second copy here would drift.
 */
export function isHostPseudoToolEvent(payload: { toolName?: unknown }): boolean {
  return typeof payload.toolName === "string" && isHostPreflightTool(payload.toolName);
}

// ── Shell reads ──────────────────────────────────────────────────────────────

/** The command string inside a tool's argument bag, whatever the runtime calls it. */
export function shellCommandOf(args: unknown): string {
  let value: unknown = args;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return value as string; }
  }
  if (!value || typeof value !== "object") return "";
  const bag = value as Record<string, unknown>;
  const raw = bag.command ?? bag.cmd ?? bag.CommandLine ?? bag.commandLine;
  if (Array.isArray(raw)) return raw.map(String).join(" ");
  return typeof raw === "string" ? raw : "";
}

export interface ShellRead {
  verb: "tail" | "head" | "cat";
  /** Relative to the run's working folder; never absolute, never escaping it. */
  path: string;
  /** Lines requested (tail/head); null for cat. */
  lines: number | null;
}

const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9가-힣._\-/]+$/;

/**
 * A shell command that only reads one relative file. Anything with a pipe,
 * redirect, substitution, glob, chain or absolute path is not proven read-only
 * and is not a crystallization candidate.
 */
export function parseShellRead(command: string): ShellRead | null {
  let text = String(command || "").trim();
  // Runtime login-shell wrappers: /bin/zsh -lc '…', bash -lc "…", sh -c '…'
  const wrapped = text.match(/^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  if (wrapped) text = wrapped[2].trim();
  if (!text || /[|;&<>`$*?(){}\[\]\\\n]/.test(text)) return null;
  const parts = text.split(/\s+/);
  const verb = parts[0];
  if (verb === "cat" && parts.length === 2 && SAFE_PATH.test(parts[1])) return { verb: "cat", path: parts[1], lines: null };
  if (verb !== "tail" && verb !== "head") return null;
  let lines: number | null = 10;
  let index = 1;
  if (parts[index] === "-n" && /^\d{1,4}$/.test(parts[index + 1] ?? "")) { lines = Number(parts[index + 1]); index += 2; }
  else if (/^-n\d{1,4}$/.test(parts[index] ?? "")) { lines = Number(parts[index].slice(2)); index += 1; }
  else if (/^-\d{1,4}$/.test(parts[index] ?? "")) { lines = Number(parts[index].slice(1)); index += 1; }
  if (parts.length !== index + 1 || !SAFE_PATH.test(parts[index])) return null;
  return { verb, path: parts[index], lines };
}

// ── Episodes ─────────────────────────────────────────────────────────────────

export type EpisodeOutcome = "accepted" | "rejected" | "needs_input" | "blocked" | "unjudged" | "completed" | "error";

export interface EpisodeStep {
  cls: ToolClass;
  tool: string;
  /** shell_read target, or navigated host+first path segment. */
  target?: string;
  lines?: number | null;
  /** Result size in characters when the runner reported it (runners cap near 12k). */
  resultChars?: number;
  ok: boolean;
}

export interface NodeEpisode {
  runId: string;
  automationId: string;
  nodeId: string;
  /** Null for runs recorded before node digests were written: grouped by node id, marked legacy. */
  nodeDigest: string | null;
  outcome: EpisodeOutcome;
  steps: EpisodeStep[];
  startedAt: string;
}

export interface RunEventRowLike {
  run_id: string;
  seq: number;
  ts: string;
  kind: string;
  automation_id: string | null;
  node_id: string | null;
  payload_json: string;
}

function parsePayload(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function navTarget(args: unknown): string | undefined {
  let value: unknown = args;
  if (typeof value === "string") { try { value = JSON.parse(value); } catch { return undefined; } }
  const url = value && typeof value === "object" ? (value as { url?: unknown }).url : undefined;
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    const first = parsed.pathname.split("/").filter(Boolean)[0] ?? "";
    return `${parsed.hostname.replace(/^www\./, "")}/${first}`;
  } catch {
    return undefined;
  }
}

/**
 * Turn one run's ordered events into per-node episodes. Rows must be one
 * automation run, ordered by seq. `nodeDigestOf` resolves the digest recorded
 * for (run, node) — null when the run predates node digests.
 */
export function buildNodeEpisodes(input: {
  rows: RunEventRowLike[];
  outcome: EpisodeOutcome;
  nodeDigestOf: (nodeId: string) => string | null;
}): NodeEpisode[] {
  const byNode = new Map<string, NodeEpisode>();
  for (const row of input.rows) {
    if (row.kind !== "mcp_tool-use" || !row.node_id || !row.automation_id) continue;
    const payload = parsePayload(row.payload_json);
    if (!payload || isHostPseudoToolEvent(payload)) continue;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (!toolName) continue;
    // A requested-but-never-completed call proves nothing about what the node needed.
    if (payload.toolCompleted === false) continue;
    let episode = byNode.get(row.node_id);
    if (!episode) {
      episode = {
        runId: row.run_id,
        automationId: row.automation_id,
        nodeId: row.node_id,
        nodeDigest: input.nodeDigestOf(row.node_id),
        outcome: input.outcome,
        steps: [],
        startedAt: row.ts,
      };
      byNode.set(row.node_id, episode);
    }
    const cls = toolClassOf(toolName, payload.toolArgs);
    const step: EpisodeStep = { cls, tool: normalizeToolName(toolName), ok: payload.toolIsError !== true };
    if (typeof payload.toolResultChars === "number" && Number.isFinite(payload.toolResultChars)) step.resultChars = payload.toolResultChars;
    if (cls === "shell_read") {
      const read = parseShellRead(shellCommandOf(payload.toolArgs));
      if (read) { step.target = read.path; step.lines = read.lines; }
    } else if (cls === "browse_nav") {
      step.target = navTarget(payload.toolArgs);
    }
    const last = episode.steps[episode.steps.length - 1];
    // Collapse immediate repeats of the identical call (pollers, retries).
    if (last && last.tool === step.tool && last.target === step.target && last.lines === step.lines) continue;
    episode.steps.push(step);
  }
  return [...byNode.values()];
}

// ── Candidate detection ──────────────────────────────────────────────────────

export type CandidateKind = "state_file_read" | "page_read";

export interface DetectedCandidate {
  kind: CandidateKind;
  caseKey: string;
  automationId: string;
  nodeId: string;
  nodeDigest: string | null;
  /** state_file_read: relative file path. page_read: host/first-segment. */
  target: string;
  /** state_file_read: most lines any episode asked for. */
  lines: number | null;
  share: number;
  supportingRunIds: string[];
  eligibleEpisodes: number;
  /** Evidence quality: judged acceptance, or only "the kernel finished". */
  evidence: "accepted" | "kernel_completed_only";
}

export interface CaseObservation {
  caseKey: string;
  automationId: string;
  nodeId: string;
  nodeDigest: string | null;
  eligibleEpisodes: number;
  evidence: "accepted" | "kernel_completed_only" | "insufficient";
  /** Best observed share per target, including those under the threshold (honest UI). */
  topTargets: Array<{ kind: CandidateKind; target: string; share: number }>;
}

export interface DetectOptions {
  minEpisodes: number;
  minShare: number;
}

export const DEFAULT_DETECT_OPTIONS: DetectOptions = { minEpisodes: 10, minShare: 0.8 };

export function caseKeyOf(episode: Pick<NodeEpisode, "automationId" | "nodeId" | "nodeDigest">): string {
  return episode.nodeDigest
    ? `automation:${episode.automationId}:${episode.nodeDigest}`
    : `automation:${episode.automationId}:legacy-node:${episode.nodeId}`;
}

function pageReadsOf(episode: NodeEpisode): Set<string> {
  // A navigation counts as a page read only when a read follows within two steps.
  const targets = new Set<string>();
  episode.steps.forEach((step, index) => {
    if (step.cls !== "browse_nav" || !step.target) return;
    if (episode.steps.slice(index + 1, index + 3).some((next) => next.cls === "browse_read")) targets.add(step.target);
  });
  return targets;
}

export function detectCandidates(
  episodes: NodeEpisode[],
  options: DetectOptions = DEFAULT_DETECT_OPTIONS,
): { candidates: DetectedCandidate[]; observations: CaseObservation[] } {
  const groups = new Map<string, NodeEpisode[]>();
  for (const episode of episodes) {
    const key = caseKeyOf(episode);
    const group = groups.get(key) ?? [];
    group.push(episode);
    groups.set(key, group);
  }
  const candidates: DetectedCandidate[] = [];
  const observations: CaseObservation[] = [];
  for (const [caseKey, group] of groups) {
    const accepted = group.filter((episode) => episode.outcome === "accepted");
    const completed = group.filter((episode) => episode.outcome === "completed");
    // Judged acceptance first; "kernel finished" is weaker evidence and is labelled as such.
    const [eligible, evidence] = accepted.length >= options.minEpisodes
      ? [accepted, "accepted" as const]
      : accepted.length + completed.length >= options.minEpisodes
        ? [[...accepted, ...completed], "kernel_completed_only" as const]
        : [[], "insufficient" as const];
    const head = group[group.length - 1];
    const counts = new Map<string, { kind: CandidateKind; target: string; runs: string[]; lines: number | null }>();
    for (const episode of eligible) {
      const seen = new Set<string>();
      for (const step of episode.steps) {
        if (step.cls !== "shell_read" || !step.target) continue;
        const key = `state_file_read\0${step.target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key) ?? { kind: "state_file_read" as const, target: step.target, runs: [], lines: null };
        entry.runs.push(episode.runId);
        if (step.lines !== undefined && step.lines !== null) entry.lines = Math.max(entry.lines ?? 0, step.lines);
        counts.set(key, entry);
      }
      for (const target of pageReadsOf(episode)) {
        const key = `page_read\0${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = counts.get(key) ?? { kind: "page_read" as const, target, runs: [], lines: null };
        entry.runs.push(episode.runId);
        counts.set(key, entry);
      }
    }
    const ranked = [...counts.values()]
      .map((entry) => ({ ...entry, share: eligible.length ? entry.runs.length / eligible.length : 0 }))
      .sort((a, b) => b.share - a.share);
    observations.push({
      caseKey,
      automationId: head.automationId,
      nodeId: head.nodeId,
      nodeDigest: head.nodeDigest,
      eligibleEpisodes: eligible.length,
      evidence,
      topTargets: ranked.slice(0, 3).map(({ kind, target, share }) => ({ kind, target, share })),
    });
    if (evidence === "insufficient") continue;
    for (const entry of ranked) {
      if (entry.share < options.minShare) break;
      candidates.push({
        kind: entry.kind,
        caseKey,
        automationId: head.automationId,
        nodeId: head.nodeId,
        nodeDigest: head.nodeDigest,
        target: entry.target,
        lines: entry.kind === "state_file_read" ? Math.min(entry.lines ?? 10, 200) : null,
        share: entry.share,
        supportingRunIds: entry.runs.slice(-20),
        eligibleEpisodes: eligible.length,
        evidence,
      });
    }
  }
  return { candidates, observations };
}

// ── Crystallization lifecycle (state machine) ────────────────────────────────
//
// A crystallization is a runtime overlay, not a graph edit: before an agent
// node runs, the host performs the stable read itself and hands the value to the
// node. The graph definition never changes, so no paused run is invalidated and
// no digest churns. When any guard fails the node simply runs as it always did
// (tracing-JIT side exit → interpreter).
//
//   candidate ─(read-only kind, automatic)→ shadow ─(K matches)→ ready
//   ready ─(owner approves once)→ active
//   active ─(2 consecutive fallbacks | agent still reads | outcome regressed)→ demoted
//   shadow ─(mismatch budget spent)→ blacklisted
//   ready/demoted ─(owner dismisses)→ rejected      demoted ─(owner)→ shadow
//   any open state ─(node digest gone from the graph)→ superseded

export type CrystallizationState =
  | "candidate" | "shadow" | "ready" | "active" | "demoted" | "rejected" | "blacklisted" | "superseded";

export const OPEN_CRYSTALLIZATION_STATES: ReadonlySet<CrystallizationState> =
  new Set(["candidate", "shadow", "ready", "active", "demoted"]);

export interface Crystallization {
  id: string;
  /** One open crystallization per lineage (case + kind + target). */
  lineageKey: string;
  kind: CandidateKind;
  caseKey: string;
  automationId: string;
  nodeId: string;
  nodeDigest: string | null;
  target: string;
  lines: number | null;
  state: CrystallizationState;
  /** Finite machine vocabulary; never prose. */
  reasonCode: string | null;
  evidence: {
    share: number;
    eligibleEpisodes: number;
    quality: DetectedCandidate["evidence"];
    supportingRunIds: string[];
  };
  /** Working folder the node was observed to use; the overlay reads only inside it. */
  folder: string | null;
  /**
   * Page reads only: what the read costs the node, measured, never assumed. A
   * page read is not synthesized until this shows the read is a large share of
   * the node's input (plan Phase 0 → Phase 1 gate).
   */
  cost?: PageReadCost | null;
  shadow: { runs: number; consecutiveMatches: number; matches: number; mismatches: number; notRead: number };
  active: { runs: number; rereads: number; fallbacks: number; consecutiveFallbacks: number; appliedAt: string | null };
  outcomes: { before: { accepted: number; judged: number }; after: { accepted: number; judged: number } };
  createdAt: string;
  updatedAt: string;
}

export interface PageReadCost {
  /** Episodes where both the read size and the node's input tokens were recorded. */
  measuredEpisodes: number;
  avgReadChars: number;
  avgNodeInputTokens: number;
  /** Runners cap a tool result near 12k characters; a capped read is a lower bound. */
  readCapped: boolean;
}

/** Characters returned by page reads at `target` in one episode (reads after navigating there). */
export function pageReadChars(episode: NodeEpisode, target: string): number | null {
  let total = 0;
  let measured = false;
  let onTarget = false;
  for (const step of episode.steps) {
    if (step.cls === "browse_nav") { onTarget = step.target === target; continue; }
    if (onTarget && step.cls === "browse_read" && typeof step.resultChars === "number") {
      total += step.resultChars;
      measured = true;
    }
  }
  return measured ? total : null;
}

export function measurePageReadCost(
  episodes: NodeEpisode[],
  target: string,
  nodeInputTokens: (runId: string, nodeId: string) => number | null,
): PageReadCost | null {
  let count = 0;
  let chars = 0;
  let tokens = 0;
  let capped = false;
  for (const episode of episodes) {
    const read = pageReadChars(episode, target);
    const input = nodeInputTokens(episode.runId, episode.nodeId);
    if (read === null || input === null || input <= 0) continue;
    count += 1;
    chars += read;
    tokens += input;
    if (episode.steps.some((step) => (step.resultChars ?? 0) >= 12_000)) capped = true;
  }
  if (count === 0) return null;
  return { measuredEpisodes: count, avgReadChars: Math.round(chars / count), avgNodeInputTokens: Math.round(tokens / count), readCapped: capped };
}

export const CRYSTALLIZATION_POLICY = {
  /** Consecutive shadow matches before the owner is asked once (Scientist / canary). */
  shadowMatchesToReady: 5,
  /** Mismatches before the lineage is blacklisted (TraceMonkey: 2 failed recordings). */
  shadowMismatchBudget: 2,
  /** Consecutive guard failures before demotion. */
  fallbacksToDemote: 2,
  /** If the agent re-reads in this share of the first N active runs, nothing is saved. */
  rereadWindow: 10,
  rereadShareToDemote: 0.8,
  /** Judged runs on each side before comparing acceptance. */
  outcomeWindow: 10,
  /** Allowed acceptance drop versus the pre-crystallization baseline. */
  outcomeTolerance: 0.15,
} as const;

export function lineageKeyOf(candidate: Pick<DetectedCandidate, "caseKey" | "kind" | "target">): string {
  return `${candidate.caseKey}:${candidate.kind}:${candidate.target}`;
}

function emptyCounters(): Pick<Crystallization, "shadow" | "active" | "outcomes"> {
  return {
    shadow: { runs: 0, consecutiveMatches: 0, matches: 0, mismatches: 0, notRead: 0 },
    active: { runs: 0, rereads: 0, fallbacks: 0, consecutiveFallbacks: 0, appliedAt: null },
    outcomes: { before: { accepted: 0, judged: 0 }, after: { accepted: 0, judged: 0 } },
  };
}

/**
 * Merge a fresh detection into the existing crystallizations (rule R1):
 *  · an open lineage absorbs new evidence instead of spawning a sibling;
 *  · rejected/blacklisted lineages never come back by themselves;
 *  · open lineages whose node digest no longer exists are superseded;
 *  · page reads stay candidates until their cost share is measured.
 */
export function mergeDetectedCandidates(input: {
  existing: Crystallization[];
  detected: DetectedCandidate[];
  liveNodeDigests: ReadonlySet<string>;
  now: string;
  newId: () => string;
}): Crystallization[] {
  const next = input.existing.map((item) => ({ ...item }));
  const byLineage = new Map(next.map((item) => [item.lineageKey, item]));
  for (const item of next) {
    if (!OPEN_CRYSTALLIZATION_STATES.has(item.state)) continue;
    if (item.nodeDigest && !input.liveNodeDigests.has(item.nodeDigest)) {
      item.state = "superseded";
      item.reasonCode = "node_definition_changed";
      item.updatedAt = input.now;
    }
  }
  for (const detected of input.detected) {
    // Overlays bind to a node digest. Legacy (digest-less) evidence waits until digests exist.
    if (!detected.nodeDigest || !input.liveNodeDigests.has(detected.nodeDigest)) continue;
    const lineageKey = lineageKeyOf(detected);
    const current = byLineage.get(lineageKey);
    const evidence = {
      share: detected.share,
      eligibleEpisodes: detected.eligibleEpisodes,
      quality: detected.evidence,
      supportingRunIds: detected.supportingRunIds,
    };
    if (current && current.state !== "superseded") {
      current.evidence = evidence;
      if (detected.lines !== null) current.lines = Math.max(current.lines ?? 0, detected.lines);
      current.updatedAt = input.now;
      continue;
    }
    const created: Crystallization = {
      id: input.newId(),
      lineageKey,
      kind: detected.kind,
      caseKey: detected.caseKey,
      automationId: detected.automationId,
      nodeId: detected.nodeId,
      nodeDigest: detected.nodeDigest,
      target: detected.target,
      lines: detected.lines,
      state: detected.kind === "state_file_read" ? "shadow" : "candidate",
      reasonCode: detected.kind === "state_file_read" ? null : "needs_cost_measurement",
      evidence,
      folder: null,
      ...emptyCounters(),
      createdAt: input.now,
      updatedAt: input.now,
    };
    if (current) next.splice(next.indexOf(current), 1, created);
    else next.push(created);
    byLineage.set(lineageKey, created);
  }
  return next;
}

export type ShadowObservation = "match" | "mismatch" | "not_read" | "unavailable";

export function applyShadowObservation(item: Crystallization, observation: ShadowObservation, now: string): Crystallization {
  if (item.state !== "shadow" || observation === "unavailable") return item;
  const next: Crystallization = { ...item, shadow: { ...item.shadow, runs: item.shadow.runs + 1 }, updatedAt: now };
  if (observation === "not_read") {
    // The node did not need the value this time. Neither evidence for nor against.
    next.shadow.notRead += 1;
    return next;
  }
  if (observation === "match") {
    next.shadow.matches += 1;
    next.shadow.consecutiveMatches += 1;
    if (next.shadow.consecutiveMatches >= CRYSTALLIZATION_POLICY.shadowMatchesToReady) {
      next.state = "ready";
      next.reasonCode = "shadow_matched";
    }
    return next;
  }
  next.shadow.mismatches += 1;
  next.shadow.consecutiveMatches = 0;
  if (next.shadow.mismatches >= CRYSTALLIZATION_POLICY.shadowMismatchBudget) {
    next.state = "blacklisted";
    next.reasonCode = "shadow_mismatch";
  }
  return next;
}

export type ActiveObservation =
  | { kind: "applied"; agentReread: boolean }
  | { kind: "fallback"; reasonCode: string };

export function applyActiveObservation(item: Crystallization, observation: ActiveObservation, now: string): Crystallization {
  if (item.state !== "active") return item;
  const active = { ...item.active, runs: item.active.runs + 1 };
  const next: Crystallization = { ...item, active, updatedAt: now };
  if (observation.kind === "fallback") {
    active.fallbacks += 1;
    active.consecutiveFallbacks += 1;
    if (active.consecutiveFallbacks >= CRYSTALLIZATION_POLICY.fallbacksToDemote) {
      next.state = "demoted";
      next.reasonCode = observation.reasonCode;
    }
    return next;
  }
  active.consecutiveFallbacks = 0;
  if (observation.agentReread) active.rereads += 1;
  const appliedRuns = active.runs - active.fallbacks;
  if (appliedRuns >= CRYSTALLIZATION_POLICY.rereadWindow
    && active.rereads / appliedRuns >= CRYSTALLIZATION_POLICY.rereadShareToDemote) {
    next.state = "demoted";
    next.reasonCode = "agent_still_reads";
  }
  return next;
}

/** Compute-matched comparison: the same node's judged runs before vs. after activation. */
export function applyOutcomeComparison(item: Crystallization, now: string): Crystallization {
  if (item.state !== "active") return item;
  const { before, after } = item.outcomes;
  const window = CRYSTALLIZATION_POLICY.outcomeWindow;
  if (before.judged < window || after.judged < window) return item;
  const drop = before.accepted / before.judged - after.accepted / after.judged;
  if (drop <= CRYSTALLIZATION_POLICY.outcomeTolerance) return item;
  return { ...item, state: "demoted", reasonCode: "outcome_regressed", updatedAt: now };
}

export type OwnerDecision = "approve" | "dismiss" | "demote" | "retry";

/** Owner actions are explicit and narrow; an illegal transition is refused, not coerced. */
export function applyOwnerDecision(item: Crystallization, decision: OwnerDecision, now: string): Crystallization | null {
  const to = (state: CrystallizationState, reasonCode: string, extra: Partial<Crystallization> = {}): Crystallization =>
    ({ ...item, ...extra, state, reasonCode, updatedAt: now });
  if (decision === "approve" && item.state === "ready") {
    return to("active", "owner_approved", { active: { ...emptyCounters().active, appliedAt: now } });
  }
  if (decision === "dismiss" && (item.state === "ready" || item.state === "demoted" || item.state === "candidate")) {
    return to("rejected", "owner_dismissed");
  }
  if (decision === "demote" && item.state === "active") return to("demoted", "owner_demoted");
  if (decision === "retry" && (item.state === "demoted" || item.state === "blacklisted") && item.kind === "state_file_read") {
    return to("shadow", "owner_retry", { shadow: emptyCounters().shadow });
  }
  return null;
}

// ── Shadow comparison ────────────────────────────────────────────────────────

/**
 * Did the agent's own read see the same file state the host read? Runtimes wrap
 * shell output differently (exit-code headers, trailing markers), so equality is
 * judged on content lines: the agent's last content line must be the host's last
 * line, and every non-empty host line the agent printed must appear in order.
 */
export function shadowReadMatches(hostText: string, agentResult: string): boolean {
  const host = String(hostText || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (host.length === 0) return false;
  const agent = String(agentResult || "").split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const hostLast = host[host.length - 1];
  const at = agent.lastIndexOf(hostLast);
  if (at < 0) return false;
  // Anything after the host's last line must be runtime framing, not newer file content.
  if (agent.slice(at + 1).some((line) => !/^(?:\[?exit(?: code)?:?\s*\d+\]?|process exited.*|wall time.*|\(no output\))$/i.test(line))) return false;
  // The agent may have asked for fewer lines; whatever it shows must be the host's suffix.
  const agentTail = agent.slice(0, at + 1).filter((line) => host.includes(line));
  const suffix = host.slice(host.length - agentTail.length);
  return agentTail.length > 0 && agentTail.every((line, index) => line === suffix[index]);
}

// ── Callable interface (Phase 2) ─────────────────────────────────────────────

export interface ToolchainInputProperty {
  type: "string";
  description: string;
  maxLength?: number;
}

export interface ToolchainInterface {
  schemaVersion: "agentlas.toolchain-interface.v1";
  automationId: string;
  name: string;
  description: string;
  whenToUse: string[];
  whenNotToUse: string[];
  inputSchema: { type: "object"; properties: Record<string, ToolchainInputProperty>; required: string[]; additionalProperties: false };
  inputExamples: Array<Record<string, string>>;
  /** MCP annotation vocabulary. Pessimistic unless the graph proves otherwise. */
  effects: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  state: "draft" | "callable" | "deprecated";
  /** Definition + purpose the contract was written and tested against; any change makes it stale. */
  definitionDigest: string;
  coldStart: {
    at: string;
    positives: number;
    /** Positives where search returned this contract at all (search recall, before the model chooses). */
    positiveFound?: number;
    positiveSelected: number;
    positiveBound: number;
    negatives: number;
    negativeSelected: number;
    passed: boolean;
    model: string | null;
    /** Every probe, so a failure says where it failed: search, choice, or input binding. */
    cases?: Array<{ kind: "positive" | "negative"; task: string; found: boolean; selected: boolean; bound: boolean }>;
  } | null;
  /** Search hits returned to One, and runs One actually requested (AWM: exposure ≠ use). */
  usage: { returned: number; runs: number };
  /** Who made it callable: the owner from the Toolchains screen, or One for a graph it saved. */
  exposedBy?: { kind: "owner" | "one"; chatId: string | null; at: string };
  updatedAt: string;
}

export const COLD_START_POLICY = { minSelectionAndBinding: 0.9, maxNegativeSelections: 0, maxCallable: 30, searchLimit: 5 } as const;

export function coldStartPassed(result: NonNullable<ToolchainInterface["coldStart"]>): boolean {
  if (result.positives <= 0 || result.negatives <= 0) return false;
  return result.positiveSelected / result.positives >= COLD_START_POLICY.minSelectionAndBinding
    && result.positiveBound / result.positives >= COLD_START_POLICY.minSelectionAndBinding
    && result.negativeSelected <= COLD_START_POLICY.maxNegativeSelections;
}

/** Validate call arguments against the contract. Problems are machine codes with a field. */
export function toolchainInputProblems(contract: Pick<ToolchainInterface, "inputSchema">, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["input:expected_object"];
  const bag = input as Record<string, unknown>;
  const schema = contract.inputSchema;
  const problems: string[] = [];
  for (const key of schema.required) {
    if (typeof bag[key] !== "string" || !(bag[key] as string).trim()) problems.push(`${key}:required`);
  }
  for (const [key, value] of Object.entries(bag)) {
    const property = schema.properties[key];
    if (!property) { problems.push(`${key}:unknown_field`); continue; }
    if (typeof value !== "string") { problems.push(`${key}:expected_string`); continue; }
    if (property.maxLength && value.length > property.maxLength) problems.push(`${key}:too_long`);
  }
  return problems;
}

// ── Search acceptance ────────────────────────────────────────────────────────
//
// Ranking itself is the product's one hybrid ranker (electron/memory/local-embedding
// rankHybridLocal: multilingual model2vec + lexical, thresholds already calibrated
// for Korean). This is only the acceptance rule on its measurements, so it can be
// tested without a model. Search is for recall — the caller (One, or the cold-start
// selector) reads when_not_to_use and decides. Below both floors nothing returns:
// the empty answer is the honest one (the design plugin was attached to 370 runs
// by a keyword fallback and used by 3).

export interface ToolchainSearchMeasurement {
  automationId: string;
  score: number;
  lexicalScore: number;
  /** The ranker's own semantic gate (model-specific floor and relative floor). */
  semanticEligible: boolean;
}

export interface ToolchainSearchHit {
  automationId: string;
  score: number;
}

export const SEARCH_POLICY = { lexicalFloor: 0.2 } as const;

export function acceptToolchainHits(measured: ToolchainSearchMeasurement[], limit: number = COLD_START_POLICY.searchLimit): ToolchainSearchHit[] {
  return measured
    // Exclusions are not scored here. A first version dropped a hit when the task
    // matched when_not_to_use "better" — comparing scores across two rankings, so an
    // English request overlapping boilerplate words ("the", "output") lost a correct
    // match (cold-start: 0/5 found). The contract carries when_not_to_use and the
    // caller decides; in real cold-start tests that caller made 0 wrong picks.
    .filter((entry) => entry.semanticEligible || entry.lexicalScore >= SEARCH_POLICY.lexicalFloor)
    .sort((left, right) => right.score - left.score || left.automationId.localeCompare(right.automationId))
    .slice(0, Math.max(1, Math.min(limit, COLD_START_POLICY.searchLimit)))
    .map(({ automationId, score }) => ({ automationId, score }));
}

/** The text a contract is found by: what it is for, never what it excludes. */
export function contractSearchText(contract: Pick<ToolchainInterface, "name" | "description" | "whenToUse" | "inputSchema">): string {
  return [contract.name, contract.description, ...contract.whenToUse,
    ...Object.values(contract.inputSchema.properties).map((property) => property.description)].filter(Boolean).join("\n");
}

// ── Persisted per-automation document ────────────────────────────────────────

export interface ToolchainAutomationState {
  schemaVersion: "agentlas.toolchain-state.v1";
  automationId: string;
  /** Compare-and-set counter; every write must present the revision it read. */
  revision: number;
  refreshedAt: string | null;
  observations: CaseObservation[];
  crystallizations: Crystallization[];
  interface: ToolchainInterface | null;
}

export function emptyToolchainState(automationId: string): ToolchainAutomationState {
  return {
    schemaVersion: "agentlas.toolchain-state.v1",
    automationId,
    revision: 0,
    refreshedAt: null,
    observations: [],
    crystallizations: [],
    interface: null,
  };
}

/** Renderer-facing summary (no local paths: the folder stays in Main). */
export interface ToolchainCrystallizationView extends Omit<Crystallization, "folder" | "evidence"> {
  folderKnown: boolean;
  evidence: Omit<Crystallization["evidence"], "supportingRunIds"> & { supportingRuns: number };
}

export interface ToolchainAutomationView {
  automationId: string;
  automationName: string;
  enabled: boolean;
  refreshedAt: string | null;
  observations: CaseObservation[];
  crystallizations: ToolchainCrystallizationView[];
  interface: ToolchainInterface | null;
  /** True when the interface was tested against a definition that has since changed. */
  interfaceStale: boolean;
}

export interface ToolchainOverview {
  schemaVersion: "agentlas.toolchain-overview.v1";
  generatedAt: string;
  automations: ToolchainAutomationView[];
}

export interface ToolchainsApi {
  overview: () => Promise<ToolchainOverview>;
  refresh: (automationId?: string) => Promise<ToolchainOverview>;
  decide: (input: { automationId: string; crystallizationId: string; decision: OwnerDecision }) => Promise<ToolchainOverview>;
  expose: (automationId: string) => Promise<ToolchainOverview>;
  withdraw: (automationId: string) => Promise<ToolchainOverview>;
}
