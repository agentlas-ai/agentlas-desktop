/**
 * AGI goal manager, P0 — the blocker model and its deterministic classifier.
 *
 * Plan: docs/2026-09-28-agi-goal-manager/PLAN.md §3.6. Owner direction 2026-09-28: AGI designs and keeps managing
 * the goal, and when it stops or gets stuck it reads the evidence and clears the block itself. Every blocker class
 * gets at least one alternative-path attempt before anyone asks the owner (G1).
 *
 * Input is host facts only (ledger status codes, typed events, receipts), never prose (R7). Output reuses the one
 * persistence vocabulary (shared/persistence-policy.ts): FailureCause.kind and PersistenceBoundaryKind. There is no
 * second policy here: this module only names the class, the evidence and the ordered alternative paths.
 *
 * Owner correction 2026-09-28 ("시간으로 보면 안 되고 … 명시적 멈춤이 멈춤 아니냐"): elapsed idle time is never a
 * blocker. A goal waiting for its next scheduled run is running. Only typed signals open an incident: an explicit
 * owner pause, a blocked status with a reason, a failed or refused run, a needs_input hold, an exhausted effect
 * observation, a pre-run gate refusal, the progress-key stall detector, and a scheduled run that was due and never
 * started (missed_due_run).
 *
 * Pure: no DB, no clock. The replay contract drives it with the YouTube S1–S8 records.
 */
import { createHash } from "node:crypto";
import type { FailureCauseKind, PersistenceBoundaryKind } from "../../shared/persistence-policy";

export const AGI_BLOCKER_SCHEMA = "agentlas.agi-blocker.v1" as const;

export type AgiOwnerClass = "our_defect" | "agent_resolvable" | "human_only";

/** The typed actions the executor knows (P3). The classifier only orders them; it never runs them. */
export const AGI_ACTION_KINDS = [
  "settle_uncertain_effect",
  "create_teammate",
  "invite_teammate",
  "dispatch_teammate",
  "switch_runtime",
  "retry_node_with",
  "replan_tree",
  "start_work_turn",
  "run_login_recovery",
  "restart_agentlas_browser",
  "request_app_restart",
  "file_defect",
  "ask_owner_once",
  "rest",
] as const;
export type AgiActionKind = (typeof AGI_ACTION_KINDS)[number];

/** Actions that are not an alternative path (G1): asking, resting and filing a report change nothing by themselves. */
export const AGI_NON_ALTERNATIVE_ACTIONS: ReadonlySet<AgiActionKind> = new Set(["ask_owner_once", "rest", "file_defect", "request_app_restart"]);

/** One typed fact about why a goal is not moving. Codes are ledger/receipt codes, never model text. */
export type AgiBlockerSignal =
  /** pauseReason "user" or an unreleased owner hold (long_run_owner_paused). */
  | { kind: "owner_pause" }
  /** A genuine human boundary (payment approval, credential, security consent, purpose change). */
  | { kind: "boundary"; boundary: PersistenceBoundaryKind; code: string }
  /** long_runs.status = blocked with this blocked_reason. */
  | { kind: "blocked_status"; reason: string }
  /** A host pause the app itself caused (app_closed, crash_recovery, runtime_unavailable, agent_paused). */
  | { kind: "host_pause"; reason: string }
  /** The latest turn failed or was refused, with its receipt error code. */
  | { kind: "run_failed"; code: string; runId?: string | null }
  /** A pre-run gate refused to start the turn. */
  | { kind: "pre_run_refused"; code: string }
  /** The continuation row is parked on needs_input, or the goal asked the owner a question. */
  | { kind: "needs_input"; code?: string }
  /** An attempt's outward effect is unknown (interrupted mid-effect). */
  | { kind: "effect_uncertain"; attemptIds: string[] }
  /** Effect observation hit its cap; looksAfterExhausted counts observations dispatched after that event. */
  | { kind: "effect_observation_exhausted"; attemptIds: string[]; looksAfterExhausted: number }
  /** A later run's host receipt (tool ledger) recorded the outward effect the uncertain attempt was for. */
  | { kind: "later_run_receipt"; runId: string; attemptIds: string[]; ref: string }
  /** The goal tried to register a wait and the host refused it (goal_wait_*). */
  | { kind: "wait_registration_refused"; code: string }
  /** The progress-key stall detector (long_runs.stall_streak / stall_replan events). */
  | { kind: "stall_detected"; streak: number }
  /** A scheduled run was due and no run started (typed schedule fact, not elapsed idle time). */
  | { kind: "missed_due_run"; dueAt: string }
  /** A login wall on this domain; sourceSession is whether regular Chrome holds a session for it. */
  | { kind: "login_wall"; domain: string; sourceSession: "present" | "missing" | "unknown" }
  /** The Agentlas Browser could not be reached (CDP 404, target closed). */
  | { kind: "browser_unavailable"; code: string }
  /** A local tool crashed before doing its work (e.g. Blender Metal init). */
  | { kind: "tool_crash"; tool: string; code: string }
  /** The same host notice/stop code repeated in a row. */
  | { kind: "repeated_notice"; code: string; count: number };

export type AgiBlockerSignalKind = AgiBlockerSignal["kind"];

export interface AgiTacticFact {
  nodeId: string;
  status: "proposed" | "active" | "done" | "retired";
  /** Optional payload.depends_on; absent means siblings are independent (plan §3.2). */
  dependsOn?: readonly string[];
}

export interface AgiBlockerFacts {
  goalId: string;
  runId: string | null;
  runVersion: number | null;
  /** long_runs.status */
  status: string;
  pauseReason: string | null;
  blockedReason: string | null;
  signals: readonly AgiBlockerSignal[];
  /** Tactics of the current plan (goal_plan_nodes kind=tactic), for the branch andon. */
  tactics?: readonly AgiTacticFact[];
  /** The tactic the blocker sits on, if the ledger names one. */
  blockedNodeId?: string | null;
  /** Evidence refs the fact reader already resolved (long_run_events seq, run ids, log line ids). */
  evidenceRefs?: readonly string[];
}

/** What the goal chip shows (owner correction D7): only explicit states differ from running. */
export type AgiGoalDisplayState = "running" | "paused" | "blocked" | "needs_owner" | "terminal";

export interface AgiDefectFinding {
  /** Stable machine code, e.g. wait_registration_refused:goal_wait_goal_not_running */
  code: string;
  category: "crash" | "stall" | "wrong-result" | "ui" | "login" | "other";
  evidenceRefs: string[];
}

export interface AgiBlockerDiagnosis {
  schemaVersion: typeof AGI_BLOCKER_SCHEMA;
  goalId: string;
  stateDigest: string;
  display: AgiGoalDisplayState;
  /** True when an unblock attempt may be due for this exact state (never for running or an owner stop). */
  attemptDue: boolean;
  primarySignal: AgiBlockerSignalKind | null;
  causeKind: FailureCauseKind;
  ownerClass: AgiOwnerClass;
  boundary: PersistenceBoundaryKind | null;
  /** Our own defects seen in these facts (each becomes one local defect record + chip). */
  defects: AgiDefectFinding[];
  /** Alternative paths in order (G1). ask_owner_once only ever appears after at least one of them. */
  altPaths: AgiActionKind[];
  /** Tactics that do not depend on the blocked node and may run now (branch andon, R13). */
  eligibleTactics: string[];
  evidenceRefs: string[];
  /** Why the class was chosen, a finite vocabulary. */
  reasonCode: string;
}

const TERMINAL = new Set(["completed", "failed", "cancelled", "cancelling"]);
const HOST_PAUSES = new Set(["app_closed", "crash_recovery", "runtime_unavailable", "agent_paused"]);
/** Owner-question blocked reasons (the goal asked the owner): human only with a boundary, otherwise downgraded. */
const OWNER_QUESTION_REASONS = new Set(["goal_owner_answer_required", "auto_goal_owner_review_required"]);

function sha(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function signalKey(signal: AgiBlockerSignal): Record<string, unknown> {
  // Stable identity of a signal: kind + codes/ids, never counts that grow each beat or timestamps.
  switch (signal.kind) {
    case "boundary": return { k: signal.kind, b: signal.boundary, c: signal.code };
    case "blocked_status": return { k: signal.kind, r: signal.reason };
    case "host_pause": return { k: signal.kind, r: signal.reason };
    case "run_failed": return { k: signal.kind, c: signal.code, r: signal.runId ?? null };
    case "pre_run_refused": return { k: signal.kind, c: signal.code };
    case "needs_input": return { k: signal.kind, c: signal.code ?? null };
    case "effect_uncertain": return { k: signal.kind, a: [...signal.attemptIds].sort() };
    case "effect_observation_exhausted": return { k: signal.kind, a: [...signal.attemptIds].sort() };
    case "later_run_receipt": return { k: signal.kind, r: signal.runId, a: [...signal.attemptIds].sort() };
    case "wait_registration_refused": return { k: signal.kind, c: signal.code };
    case "stall_detected": return { k: signal.kind };
    case "missed_due_run": return { k: signal.kind, d: signal.dueAt };
    case "login_wall": return { k: signal.kind, d: signal.domain, s: signal.sourceSession };
    case "browser_unavailable": return { k: signal.kind, c: signal.code };
    case "tool_crash": return { k: signal.kind, t: signal.tool, c: signal.code };
    case "repeated_notice": return { k: signal.kind, c: signal.code };
    case "owner_pause": return { k: signal.kind };
  }
}

/** The exact blocked state. Same digest = same state = at most one unblock attempt (R6). */
export function agiBlockerStateDigest(facts: Pick<AgiBlockerFacts, "goalId" | "runId" | "status" | "pauseReason" | "blockedReason" | "signals">): string {
  const signals = facts.signals.map(signalKey).map((entry) => JSON.stringify(entry)).sort();
  return sha({ schema: AGI_BLOCKER_SCHEMA, goalId: facts.goalId, runId: facts.runId, status: facts.status,
    pauseReason: facts.pauseReason, blockedReason: facts.blockedReason, signals });
}

/**
 * Branch andon (R13): while a node is blocked only its dependent sub-tree is held. Siblings are independent unless
 * a tactic lists the blocked node (directly or transitively) in dependsOn.
 */
export function agiEligibleTactics(tactics: readonly AgiTacticFact[] | undefined, blockedNodeId: string | null | undefined): string[] {
  if (!tactics?.length) return [];
  const held = new Set<string>(blockedNodeId ? [blockedNodeId] : []);
  let grew = true;
  while (grew) {
    grew = false;
    for (const tactic of tactics) {
      if (held.has(tactic.nodeId)) continue;
      if ((tactic.dependsOn ?? []).some((dep) => held.has(dep))) { held.add(tactic.nodeId); grew = true; }
    }
  }
  return tactics.filter((tactic) => tactic.status === "active" && !held.has(tactic.nodeId)).map((tactic) => tactic.nodeId);
}

/** Failed-run receipt codes → cause (typed families only; unknown codes stay unknown). */
function causeOfRunCode(code: string): { cause: FailureCauseKind; ourDefect: boolean } {
  if (/quota|rate_limit|usage_limit/.test(code)) return { cause: "quota", ourDefect: false };
  if (/auth|login|signed_out|unauthori[sz]ed/.test(code)) return { cause: "auth", ourDefect: false };
  if (/timeout|runtime_unavailable|runtime_exit|empty_response|capacity|overloaded/.test(code)) return { cause: "runtime_unavailable", ourDefect: false };
  if (/busy|in_use|lease/.test(code)) return { cause: "resource_busy", ourDefect: false };
  if (/refused|denied|not_allowed|approval/.test(code)) return { cause: "tool_refused", ourDefect: false };
  if (/tool_missing|not_installed|mcp_unavailable/.test(code)) return { cause: "tool_missing", ourDefect: false };
  if (/session_conflict|resume_version_conflict/.test(code)) return { cause: "session_conflict", ourDefect: true };
  if (/crash|internal|unexpected|threw|invariant/.test(code)) return { cause: "unknown", ourDefect: true };
  return { cause: "unknown", ourDefect: false };
}

function refsOf(facts: AgiBlockerFacts, signal: AgiBlockerSignal | null): string[] {
  const refs = new Set<string>(facts.evidenceRefs ?? []);
  if (facts.runId) refs.add(`long_run:${facts.runId}`);
  if (signal?.kind === "later_run_receipt") refs.add(signal.ref);
  if (signal?.kind === "run_failed" && signal.runId) refs.add(`run:${signal.runId}`);
  return [...refs];
}

/**
 * The deterministic classifier. Priority is by what decides the next move, not by what happened first:
 * an owner stop wins (nothing to unblock), then a real boundary, then the most specific agent-fixable fact.
 */
export function classifyAgiBlocker(facts: AgiBlockerFacts): AgiBlockerDiagnosis {
  const signals = facts.signals;
  const find = <K extends AgiBlockerSignalKind>(kind: K): Extract<AgiBlockerSignal, { kind: K }> | undefined =>
    signals.find((signal) => signal.kind === kind) as Extract<AgiBlockerSignal, { kind: K }> | undefined;
  const eligibleTactics = agiEligibleTactics(facts.tactics, facts.blockedNodeId ?? null);
  const stateDigest = agiBlockerStateDigest(facts);
  const defects: AgiDefectFinding[] = [];
  const addDefect = (code: string, category: AgiDefectFinding["category"], signal: AgiBlockerSignal | null) => {
    if (!defects.some((entry) => entry.code === code)) defects.push({ code, category, evidenceRefs: refsOf(facts, signal) });
  };
  const base = (partial: Omit<AgiBlockerDiagnosis, "schemaVersion" | "goalId" | "stateDigest" | "eligibleTactics" | "defects" | "evidenceRefs"> & { signal: AgiBlockerSignal | null }): AgiBlockerDiagnosis => {
    const { signal, ...rest } = partial;
    // our_defect requires evidence (plan §3.6); every defect finding is filed.
    const evidenceRefs = refsOf(facts, signal);
    let ownerClass = rest.ownerClass;
    let boundary = rest.boundary;
    // human_only requires a named boundary; otherwise it is agent-resolvable (same rule as stall-replan.ts).
    if (ownerClass === "human_only" && !boundary) ownerClass = "agent_resolvable";
    if (ownerClass === "our_defect" && !evidenceRefs.length) ownerClass = "agent_resolvable";
    if (ownerClass !== "human_only") boundary = null;
    // G1: an ask is admissible only after at least one alternative path; the classifier never lists it first.
    let altPaths = rest.altPaths.filter((action, index, list) => list.indexOf(action) === index);
    if (altPaths[0] === "ask_owner_once") altPaths = [...altPaths.slice(1), "ask_owner_once"];
    if (altPaths.includes("ask_owner_once") && !altPaths.some((action) => !AGI_NON_ALTERNATIVE_ACTIONS.has(action))) {
      altPaths = eligibleTactics.length ? ["start_work_turn", ...altPaths] : ["replan_tree", ...altPaths];
    }
    if ((ownerClass === "our_defect" || defects.length) && !altPaths.includes("file_defect")) altPaths.push("file_defect");
    // An unresolved action is an incident, not a stop for the whole Goal.
    // The work controller can pick another tactic while this incident is repaired.
    if (rest.attemptDue && boundary !== "owner_stop" && !altPaths.includes("start_work_turn")) altPaths.unshift("start_work_turn");
    return { schemaVersion: AGI_BLOCKER_SCHEMA, goalId: facts.goalId, stateDigest, eligibleTactics, defects, evidenceRefs,
      ...rest, display: rest.attemptDue && boundary !== "owner_stop" ? "running" : rest.display,
      ownerClass, boundary, altPaths };
  };
  const branchWork: AgiActionKind[] = eligibleTactics.length ? ["start_work_turn", "dispatch_teammate", "create_teammate"] : [];

  // 0. Terminal: nothing to manage.
  if (TERMINAL.has(facts.status)) {
    return base({ display: "terminal", attemptDue: false, primarySignal: null, causeKind: "unknown", ownerClass: "agent_resolvable",
      boundary: null, altPaths: [], reasonCode: "goal_terminal", signal: null });
  }
  // 1. An explicit owner stop is a stop. No attempt, no notice (owner_stop is a boundary nobody crosses).
  const ownerPause = find("owner_pause") ?? (facts.status === "paused" && facts.pauseReason === "user" ? { kind: "owner_pause" as const } : undefined);
  if (ownerPause) {
    return base({ display: "paused", attemptDue: false, primarySignal: "owner_pause", causeKind: "boundary", ownerClass: "human_only",
      boundary: "owner_stop", altPaths: [], reasonCode: "owner_stop", signal: ownerPause });
  }

  // Secondary defect findings that ride along with any primary class.
  const exhausted = find("effect_observation_exhausted");
  const later = find("later_run_receipt");
  const waitRefused = find("wait_registration_refused");
  const repeated = find("repeated_notice");
  if (exhausted && exhausted.looksAfterExhausted > 0) addDefect("effect_observation_repeated_after_exhausted", "stall", exhausted);
  if (later && (exhausted || find("effect_uncertain"))) addDefect("owner_turn_effect_did_not_settle_goal_attempt", "wrong-result", later);
  if (waitRefused) addDefect(`wait_registration_refused:${waitRefused.code}`, "stall", waitRefused);
  if (repeated && repeated.count >= 2) addDefect(`repeated_notice:${repeated.code}`, "ui", repeated);
  const browser = find("browser_unavailable");
  if (browser) addDefect(`browser_unavailable:${browser.code}`, "crash", browser);

  // 2. A real boundary: one precise ask, but only after an alternative path (payment → continue the zero-cost path).
  const boundary = find("boundary");
  if (boundary) {
    return base({ display: "needs_owner", attemptDue: true, primarySignal: "boundary", causeKind: "boundary", ownerClass: "human_only",
      boundary: boundary.boundary, altPaths: [...branchWork, "replan_tree", "ask_owner_once"], reasonCode: `boundary_${boundary.boundary}`, signal: boundary });
  }
  // 3. Login wall: the login-recovery ladder first; its last rung is the only owner card.
  const wall = find("login_wall");
  if (wall) {
    // Chrome holds the session but we still hit the wall: our cookie path failed (S4, fixed in 1.2.47).
    if (wall.sourceSession === "present") addDefect(`login_wall_with_source_session:${wall.domain}`, "login", wall);
    return base({ display: "blocked", attemptDue: true, primarySignal: "login_wall", causeKind: "auth",
      ownerClass: wall.sourceSession === "present" ? "our_defect" : "agent_resolvable", boundary: null,
      altPaths: ["run_login_recovery", ...branchWork], reasonCode: "login_wall", signal: wall });
  }
  // 4. Uncertain outward effect: settle from a later host receipt when one exists; never redo the effect.
  const uncertain = find("effect_uncertain");
  if (exhausted || uncertain) {
    const settle: AgiActionKind[] = later ? ["settle_uncertain_effect"] : [];
    return base({ display: "blocked", attemptDue: true, primarySignal: exhausted ? "effect_observation_exhausted" : "effect_uncertain",
      causeKind: "effect_uncertain", ownerClass: "agent_resolvable", boundary: null,
      altPaths: [...settle, ...branchWork], reasonCode: later ? "effect_settleable_from_receipt" : "effect_uncertain", signal: exhausted ?? uncertain ?? null });
  }
  // 5. Browser unreachable: our defect; restart the Agentlas browser (D6 allows it) and keep other branches moving.
  if (browser) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "browser_unavailable", causeKind: "resource_busy", ownerClass: "our_defect",
      boundary: null, altPaths: ["restart_agentlas_browser", ...branchWork], reasonCode: "browser_unavailable", signal: browser });
  }
  // 6. A local tool crashed before working: a different path for the same capability.
  const crash = find("tool_crash");
  if (crash) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "tool_crash", causeKind: "tool_missing", ownerClass: "agent_resolvable",
      boundary: null, altPaths: ["retry_node_with", ...branchWork, "switch_runtime"], reasonCode: "tool_crash", signal: crash });
  }
  // 7. The host refused a wait registration: our defect; keep the goal moving on another tactic.
  if (waitRefused) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "wait_registration_refused", causeKind: "tool_refused", ownerClass: "our_defect",
      boundary: null, altPaths: [...branchWork, "replan_tree"], reasonCode: "wait_registration_refused", signal: waitRefused });
  }
  // 8. A failed or refused turn.
  const failed = find("run_failed");
  if (failed) {
    const { cause, ourDefect } = causeOfRunCode(failed.code);
    if (ourDefect) addDefect(`run_failed:${failed.code}`, "crash", failed);
    const moves: AgiActionKind[] = cause === "quota" || cause === "auth" || cause === "runtime_unavailable" ? ["switch_runtime", ...branchWork]
      : cause === "tool_refused" || cause === "tool_missing" ? ["retry_node_with", "replan_tree", "switch_runtime"]
        : [...branchWork, "replan_tree", "switch_runtime"];
    return base({ display: "blocked", attemptDue: true, primarySignal: "run_failed", causeKind: cause, ownerClass: ourDefect ? "our_defect" : "agent_resolvable",
      boundary: null, altPaths: moves, reasonCode: `run_failed_${cause}`, signal: failed });
  }
  const gate = find("pre_run_refused");
  if (gate) {
    addDefect(`pre_run_refused:${gate.code}`, "stall", gate);
    return base({ display: "blocked", attemptDue: true, primarySignal: "pre_run_refused", causeKind: "tool_refused", ownerClass: "our_defect",
      boundary: null, altPaths: [...branchWork, "replan_tree"], reasonCode: "pre_run_refused", signal: gate });
  }
  // 9. The progress-key stall detector: bring in a new signal (R5): replan, another runtime, a teammate.
  const stall = find("stall_detected");
  if (stall) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "stall_detected", causeKind: "self_hold", ownerClass: "agent_resolvable",
      boundary: null, altPaths: ["replan_tree", "switch_runtime", ...branchWork], reasonCode: "stall_detected", signal: stall });
  }
  // 10. A scheduled run was due and none started.
  const missed = find("missed_due_run");
  if (missed) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "missed_due_run", causeKind: "self_hold", ownerClass: "agent_resolvable",
      boundary: null, altPaths: ["start_work_turn", "switch_runtime"], reasonCode: "missed_due_run", signal: missed });
  }
  // 11. The goal asked the owner something. Without a boundary this is not human-only (§3.6): other branches first.
  const needs = find("needs_input") ?? (facts.status === "blocked" && OWNER_QUESTION_REASONS.has(facts.blockedReason ?? "")
    ? { kind: "needs_input" as const, code: facts.blockedReason ?? undefined } : undefined) ?? (facts.status === "waiting_user" ? { kind: "needs_input" as const, code: "waiting_user" } : undefined);
  if (needs) {
    return base({ display: "needs_owner", attemptDue: true, primarySignal: "needs_input", causeKind: "self_hold", ownerClass: "human_only",
      boundary: null, altPaths: [...branchWork, "replan_tree"], reasonCode: "owner_question_without_boundary", signal: needs });
  }
  // 12. A host pause the app caused (update restart, crash): the blocked-goal sweep already owns its continuation, and
  // the owner sees it as running (owner correction D7). Not an impediment by itself; if the continuation never comes,
  // a typed fact (missed due run, refused resume, blocked status) opens the incident instead.
  const hostPause = find("host_pause") ?? (facts.status === "paused" && HOST_PAUSES.has(facts.pauseReason ?? "") ? { kind: "host_pause" as const, reason: facts.pauseReason ?? "" } : undefined);
  if (hostPause && !defects.length) {
    return base({ display: "running", attemptDue: false, primarySignal: "host_pause", causeKind: "runtime_unavailable", ownerClass: "agent_resolvable",
      boundary: null, altPaths: ["start_work_turn", "switch_runtime"], reasonCode: `host_pause_${hostPause.reason}`, signal: hostPause });
  }
  // 13. Blocked with some other typed reason (S6: blocked while an unblocked tactic exists).
  const blocked = find("blocked_status") ?? (facts.status === "blocked" ? { kind: "blocked_status" as const, reason: facts.blockedReason ?? "unknown" } : undefined);
  if (blocked) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "blocked_status", causeKind: "self_hold", ownerClass: "agent_resolvable",
      boundary: null, altPaths: [...branchWork, "replan_tree", "switch_runtime"], reasonCode: eligibleTactics.length ? "blocked_with_eligible_branch" : "blocked",
      signal: blocked });
  }
  if (defects.length) {
    // Only a defect was seen (e.g. a repeated notice) while the goal otherwise runs.
    return base({ display: "running", attemptDue: true, primarySignal: repeated ? "repeated_notice" : null, causeKind: "unknown", ownerClass: "our_defect",
      boundary: null, altPaths: ["file_defect"], reasonCode: "defect_only", signal: repeated ?? null });
  }
  // Nothing typed says it is stuck: waiting for its next scheduled run is running (owner correction D7).
  return base({ display: "running", attemptDue: false, primarySignal: null, causeKind: "unknown", ownerClass: "agent_resolvable",
    boundary: null, altPaths: [], reasonCode: "running", signal: null });
}
