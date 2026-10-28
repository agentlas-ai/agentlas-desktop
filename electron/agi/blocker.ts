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
import type { PlanBranchReadiness, PlanReadiness } from "../../shared/goal-shape";
import { createHash } from "node:crypto";
import type { FailureCauseKind, PersistenceBoundaryKind } from "../../shared/persistence-policy";
import { goalContinuationAdmissible } from "../../shared/goal-continuation";

export const AGI_BLOCKER_SCHEMA = "agentlas.agi-blocker.v1" as const;

export type AgiOwnerClass = "our_defect" | "agent_resolvable" | "human_only";

/** The typed actions the executor knows (P3). The classifier only orders them; it never runs them. */
export const AGI_ACTION_KINDS = [
  "create_teammate",
  "invite_teammate",
  "dispatch_teammate",
  "switch_runtime",
  "retry_node_with",
  "use_native_harness",
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
  | { kind: "repeated_notice"; code: string; count: number }
  /**
   * A continuation the host promised could not start, by its typed notice (shared/continuation-refusal-notice.ts): a verified
   * sign-in or an approved full access whose successor turn was refused. Production 2026-10-28 06:07Z and 2026-10-27 01:31Z / 05:02Z,
   * YouTube room: the room sat on its last line for hours. The way on is the Goal's next turn from its checkpoint.
   */
  | { kind: "continuation_refused"; continuation: "browser-login" | "permission-escalation"; code: string }
  /**
   * The Goal's own wakes (goal_wake_started for this long run) failed this many times in a row with the same typed code. A host retry
   * of the same wake repeats it. Production 2026-10-28, YouTube room: 14 sweep wakes in a row failed one-team-runtime-selection-changed
   * before any controller attempt existed, so the controller receipt the AGI read never showed it.
   */
  | { kind: "repeated_failure"; code: string; count: number };

export type AgiBlockerSignalKind = AgiBlockerSignal["kind"];

export interface AgiTacticFact {
  nodeId: string;
  status: "proposed" | "active" | "done" | "retired";
  /** Historical absence is unknown, retained for compatibility. */
  readiness?: PlanBranchReadiness;
  dependsOn?: readonly string[];
}

export interface AgiBlockerFacts {
  goalId: string;
  /** Host-only wake identity; no message or tool payload is included. */
  chatId?: string | null;
  /** Accepted Goal sources only (owner input/control, plan and policy authority). A completed tool id is not progress. */
  progress?: { ownerInputId: string | null; authority?: string; checkpoint?: string | null };
  /** An admitted provider, observer, or worker already owns this goal's work. */
  repairInFlight?: boolean;
  /**
   * Why nothing is due right now although the Goal is not clear: its room or a teammate chat has a turn in flight (chat_busy), or
   * the host scheduler holds a registered wake for it (host_wait). An open incident is held across this, not closed and reopened.
   */
  heldBy?: "chat_busy" | "host_wait";
  /** Exact host schedule transition; not idle time or a retry of an effect. */
  nextWakeAtMs?: number;
  /** Strict action rebase boundary, separate from cost/wake identity. */
  fenceState?: string;
  runId: string | null;
  runVersion: number | null;
  /** long_runs.status */
  status: string;
  pauseReason: string | null;
  blockedReason: string | null;
  signals: readonly AgiBlockerSignal[];
  /** Tactics of the current plan (goal_plan_nodes kind=tactic), for the branch andon. */
  tactics?: readonly AgiTacticFact[];
  planReadiness?: PlanReadiness;
  /** The tactic the blocker sits on, if the ledger names one. */
  blockedNodeId?: string | null;
  /** Evidence refs the fact reader already resolved (long_run_events seq, run ids, log line ids). */
  evidenceRefs?: readonly string[];
  /**
   * The goal has a live (not a retired Goal continuation row) automation with a recorded run, the only thing switch_runtime
   * can move (goal-facts.ts goalRuntimeSwitchTarget, used by electron/agi/wiring.ts recordAgiMove). A Goal's own wake is the
   * host's, so this is false for every Goal today: that move is structurally refused and not proposed. Absent = unknown, not refused.
   */
  continuationAutomation?: boolean;
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
  branchReadiness?: Array<Omit<PlanBranchReadiness, "evidenceRefs">>;
  evidenceRefs: string[];
  /** Why the class was chosen, a finite vocabulary. */
  reasonCode: string;
  /**
   * The machine code of the primary signal (a failed run's receipt code, a browser ladder stop `browser_ladder:<code>`, a tool crash code).
   * Host-only, never projected to the model. use_native_harness is decided from it (agiHarnessCapability); absent on an incident opened
   * before it existed, and absent means "unknown", which never hands anything to the runtime's own tools.
   */
  signalCode?: string;
  /**
   * Present only when a signal's code is one an app restart actually clears (AGI_APP_RESTART_CAUSES). The executor
   * refuses request_app_restart without it (agi.app-restart.not-indicated). Host-only: never projected to the model.
   */
  appRestart?: { code: string; reason: string };
}

/**
 * Causes an app restart can actually clear: state that lives only in the running process and is rebuilt at launch.
 * Production Yotube 2026-10-17: AGI asked the owner to restart because restarting was "the one path not tried yet" on
 * goal_episode_admission_missing (a custody defect only new code fixes). The owner restarted at 12:49Z; the next retries
 * failed the same way and the 14:38Z update fixed it. A restart ask needs one of these typed codes as its basis.
 */
export const AGI_APP_RESTART_CAUSES: ReadonlyArray<{ readonly code: string; readonly reason: string }> = Object.freeze([
  { code: "invocation_native_fence_already_configured",
    reason: "The background-service start fence is installed once per process; a stale one blocks every new turn until relaunch (1.3.48)." },
  { code: "native_auth_not_provisioned",
    reason: "The background service started before its signed channel was provisioned; only a relaunch provisions it first (2026-10-17 first launch)." },
  { code: "native_auth_channel_lost",
    reason: "The signed channel to the background service is rebuilt at launch; when every re-attach fails it stays lost until relaunch." },
  { code: "native_gui_activation_prerequisites_missing",
    reason: "The background service died under the app window (EPIPE); the window's native turns fail until the service is relaunched." },
]);

/** The first signal whose code a restart clears, with the reason; null when a restart would not change the state. */
export function agiAppRestartIndication(signals: readonly AgiBlockerSignal[]): { code: string; reason: string } | null {
  for (const signal of signals) {
    const code = signal.kind === "run_failed" || signal.kind === "pre_run_refused" || signal.kind === "repeated_notice" ? signal.code : null;
    const cause = code ? AGI_APP_RESTART_CAUSES.find((entry) => entry.code === code) : undefined;
    if (cause) return { code: cause.code, reason: cause.reason };
  }
  return null;
}

/** Paths whose admission depends on the goal's own structure (status, plan, automation), not on the cause. */
const STRUCTURAL_PATHS: ReadonlySet<AgiActionKind> = new Set(["start_work_turn", "dispatch_teammate", "create_teammate", "replan_tree", "retry_node_with", "switch_runtime"]);
/** Signals whose only remedies are the structural paths: when none is admissible nothing is left for AGI to try. */
const STRANDABLE_SIGNALS: ReadonlySet<AgiBlockerSignalKind> = new Set(["run_failed", "pre_run_refused", "stall_detected", "missed_due_run", "blocked_status",
  "continuation_refused"]);
/** Close reason of an incident whose every path the host refuses by structure (typed, never parsed from prose). */
export const AGI_NO_ADMISSIBLE_PATH = "no_admissible_path";

/**
 * Would the host admit this path for this goal at all? Mirrors the refusals the executor returns every time for the same
 * shape (production 2026-10-16, auto-message goals: agi.turn.deferred for a queued goal, agi.move.no-continuation-automation
 * for a goal without a continuation automation). Unknown facts (undefined) count as admissible.
 */
function pathAdmissible(action: AgiActionKind, facts: AgiBlockerFacts, eligibleTactics: readonly string[]): boolean {
  switch (action) {
    case "start_work_turn": return goalContinuationAdmissible(facts.status, facts.pauseReason);
    case "dispatch_teammate": case "create_teammate": return eligibleTactics.length > 0;
    case "replan_tree": case "retry_node_with": return facts.tactics === undefined || facts.tactics.length > 0;
    case "switch_runtime": return facts.continuationAutomation !== false;
    default: return true;
  }
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
    case "wait_registration_refused": return { k: signal.kind, c: signal.code };
    case "stall_detected": return { k: signal.kind };
    case "missed_due_run": return { k: signal.kind, d: signal.dueAt };
    case "login_wall": return { k: signal.kind, d: signal.domain, s: signal.sourceSession };
    case "browser_unavailable": return { k: signal.kind, c: signal.code };
    case "tool_crash": return { k: signal.kind, t: signal.tool, c: signal.code };
    case "repeated_notice": return { k: signal.kind, c: signal.code };
    case "continuation_refused": return { k: signal.kind, n: signal.continuation, c: signal.code };
    case "repeated_failure": return { k: signal.kind, c: signal.code };
    case "owner_pause": return { k: signal.kind };
  }
}

/** The exact blocked state. Same digest = same incident and durable retry history; counter/timestamp churn is not progress. */
export function agiBlockerStateDigest(facts: Pick<AgiBlockerFacts, "goalId" | "runId" | "status" | "pauseReason" | "blockedReason" | "signals" | "progress" | "tactics" | "blockedNodeId">): string {
  const signals = facts.signals.map(signalKey).map((entry) => JSON.stringify(entry)).sort();
  return sha({ schema: AGI_BLOCKER_SCHEMA, goalId: facts.goalId, runId: facts.runId, status: facts.status,
    pauseReason: facts.pauseReason, blockedReason: facts.blockedReason, signals,
    progress: facts.progress ?? null, blockedNodeId: facts.blockedNodeId ?? null,
    tactics: (facts.tactics ?? []).map(t => ({ id: t.nodeId, status: t.status, deps: [...(t.dependsOn ?? [])].sort(), readiness: t.readiness ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)) });
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
  return tactics.filter((tactic) => (tactic.status === "active" || tactic.status === "proposed") && !held.has(tactic.nodeId)
    && (tactic.readiness ? tactic.readiness.inspectable && tactic.readiness.workClasses.some(kind => kind !== "observe") : true)).map((tactic) => tactic.nodeId);
}

/**
 * The Agentlas capability a diagnosis points at when the runtime's own tools can replace it (use_native_harness).
 * Null when they cannot: a runtime that fails by itself (quota, auth, an unknown crash) needs another runtime, a login
 * wall needs the owner, and a refused start never reaches a turn. The browser ladder also carries on-screen app control
 * (production Yotube 2026-10-12: browser_cua_repl on the Agentlas app failed unified-cua-native-transport-unavailable in
 * daemon-served turns, read as browser_unavailable 32 times a day).
 */
export function agiHarnessCapability(d: Pick<AgiBlockerDiagnosis, "primarySignal" | "causeKind"> & Partial<Pick<AgiBlockerDiagnosis, "signalCode" | "defects">>): "browser" | "tool" | null {
  const capability = d.primarySignal === "browser_unavailable" ? "browser"
    : d.primarySignal === "tool_crash" ? "tool"
      : d.primarySignal === "run_failed" && (d.causeKind === "tool_refused" || d.causeKind === "tool_missing") ? "tool" : null;
  if (!capability) return null;
  // A browser incident opened before signalCode existed still names its code in the typed defect it filed.
  const code = d.signalCode ?? d.defects?.find((defect) => defect.code.startsWith("browser_unavailable:"))?.code.slice("browser_unavailable:".length);
  return agiHarnessBypassAllowed(capability, code) ? capability : null;
}

/**
 * Browser ladder stops (electron/browser/fallback-ladder.ts BROWSER_FAILURE_CODES) that mean the Agentlas browser TOOL broke: a cut
 * bridge, a browser that would not start or died, the in-app guest or session gone, a refused tab, the MCP not attached, a failed
 * native call. Only these may be answered with the runtime's own tools. Not here, on purpose: ownership-unverifiable (the host could not
 * prove whose browser it is) and port-foreign (a browser outside the Agentlas profile is never driven) are safety verdicts, login-wall
 * and human-check-required are the owner's, and page-load-failed is the site, not the tool.
 */
export const AGI_HARNESS_TOOL_BREAKAGE_LADDER_CODES: ReadonlySet<string> = new Set([
  "bridge-wire-dropped", "chrome-launch-failed", "chrome-crashed", "native-session-ended", "native-tab-limit", "native-guest-destroyed",
  "browser-mcp-not-attached", "native-tool-failed",
]);
/** A code that names an ownership, consent, approval, credential, security or human-check verdict: never a tool breakage. */
const HARNESS_VERDICT_CODE = /ownership|unverifiable|consent|approv|denied|forbidden|not[_-]?allowed|permission|security|foreign|human[_-]?check|captcha|login|sign[_-]?in|auth|credential|payment|wall/i;

/**
 * May the runtime's own tools (shell, direct API, built-in web) answer this failure? Only a tool that BROKE (a crash, a missing
 * tool, a plain refusal by the Agentlas tool itself, a dead browser bridge); a verdict the host or the owner made is never bypassed
 * (production 2026-10-20: the only ladder stops were native-tool-failed 307, native-tab-limit 2, ownership-unverifiable 1, page-load-failed 1;
 * the old rule handed all of them over, ownership-unverifiable included). An unknown code is not allowed.
 */
export function agiHarnessBypassAllowed(capability: "browser" | "tool", code: string | null | undefined): boolean {
  if (!code) return false;
  if (capability === "browser" && code.startsWith("browser_ladder:")) return AGI_HARNESS_TOOL_BREAKAGE_LADDER_CODES.has(code.slice("browser_ladder:".length));
  return !HARNESS_VERDICT_CODE.test(code);
}

/**
 * Exact typed receipt / provider codes that say the runtime session itself was lost: resume refused or timed out
 * (runner providerCode "resume_failed", codex-turn-failure.ts "resume_refused"), recovery exhausted its candidates
 * (mcp/client.ts notice "runtime-recovery-exhausted"). A set of machine codes, never a word pattern.
 */
export const AGI_RUNTIME_SESSION_LOST_CODES: ReadonlySet<string> = new Set(["resume_failed", "resume_refused", "thread_resume_failed", "runtime-recovery-exhausted"]);

/** Failed-run receipt codes → cause (typed families only; unknown codes stay unknown). */
function causeOfRunCode(code: string): { cause: FailureCauseKind; ourDefect: boolean } {
  if (/quota|rate_limit|usage_limit/.test(code)) return { cause: "quota", ourDefect: false };
  if (/auth|login|signed_out|unauthori[sz]ed/.test(code)) return { cause: "auth", ourDefect: false };
  if (/timeout|runtime_unavailable|runtime_exit|empty_response|capacity|overloaded/.test(code)) return { cause: "runtime_unavailable", ourDefect: false };
  if (/busy|in_use|lease/.test(code)) return { cause: "resource_busy", ourDefect: false };
  if (/refused|denied|not_allowed|approval/.test(code)) return { cause: "tool_refused", ourDefect: false };
  if (/tool_missing|not_installed|mcp_unavailable/.test(code)) return { cause: "tool_missing", ourDefect: false };
  if (/session_conflict|resume_version_conflict/.test(code)) return { cause: "session_conflict", ourDefect: true };
  // The runtime's session could not be resumed or ended under the turn (codex thread/resume timed out, recovery exhausted its
  // candidates). The host already retired that session binding (agent-context "resume_failed"): the next turn opens a new session
  // from the Goal's checkpoint. Production 2026-10-28 12:19Z and 12:32Z: resume_failed after a 120 s thread/resume timeout.
  if (AGI_RUNTIME_SESSION_LOST_CODES.has(code)) return { cause: "runtime_unavailable", ourDefect: false };
  if (/crash|internal|unexpected|threw|invariant/.test(code)) return { cause: "unknown", ourDefect: true };
  return { cause: "unknown", ourDefect: false };
}

function refsOf(facts: AgiBlockerFacts, signal: AgiBlockerSignal | null): string[] {
  const refs = new Set<string>(facts.evidenceRefs ?? []);
  if (facts.runId) refs.add(`long_run:${facts.runId}`);
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
  const appRestartIndication = agiAppRestartIndication(signals);
  const appRestart = appRestartIndication ? { appRestart: appRestartIndication } : {};
  const defects: AgiDefectFinding[] = [];
  const addDefect = (code: string, category: AgiDefectFinding["category"], signal: AgiBlockerSignal | null) => {
    if (!defects.some((entry) => entry.code === code)) defects.push({ code, category, evidenceRefs: refsOf(facts, signal) });
  };
  const base = (partial: Omit<AgiBlockerDiagnosis, "schemaVersion" | "goalId" | "stateDigest" | "eligibleTactics" | "defects" | "evidenceRefs"> & { signal: AgiBlockerSignal | null }): AgiBlockerDiagnosis => {
    const { signal, ...rest } = partial;
    // our_defect requires evidence (plan §3.6); every defect finding is filed.
    const evidenceRefs = refsOf(facts, signal);
    const signalCode = signal && "code" in signal && typeof signal.code === "string" ? signal.code : undefined;
    let ownerClass = rest.ownerClass;
    let boundary = rest.boundary;
    // human_only requires a named boundary; otherwise it is agent-resolvable (same rule as stall-replan.ts).
    if (ownerClass === "human_only" && !boundary) ownerClass = "agent_resolvable";
    if (ownerClass === "our_defect" && !evidenceRefs.length) ownerClass = "agent_resolvable";
    if (ownerClass !== "human_only") boundary = null;
    // G1: an ask is admissible only after at least one alternative path; the classifier never lists it first.
    // A path the host refuses by this goal's structure every time is not proposed (switch_runtime without a live automation to move:
    // the host wakes a Goal itself since 034d8584e, so there is nothing to switch). Unknown facts keep it (pathAdmissible).
    let altPaths = rest.altPaths.filter((action, index, list) => list.indexOf(action) === index
      && (action !== "switch_runtime" || pathAdmissible(action, facts, eligibleTactics)));
    if (altPaths[0] === "ask_owner_once") altPaths = [...altPaths.slice(1), "ask_owner_once"];
    if (altPaths.includes("ask_owner_once") && !altPaths.some((action) => !AGI_NON_ALTERNATIVE_ACTIONS.has(action))) {
      altPaths = eligibleTactics.length && goalContinuationAdmissible(facts.status, facts.pauseReason)
        ? ["start_work_turn", ...altPaths] : ["replan_tree", ...altPaths];
    }
    if ((ownerClass === "our_defect" || defects.length) && !altPaths.includes("file_defect")) altPaths.push("file_defect");
    // A boundary the owner must cross is not a place to start model-briefed teammate work (executor: agi.team.human-only-incident).
    if (ownerClass === "human_only") altPaths = altPaths.filter((action) => action !== "dispatch_teammate" && action !== "create_teammate");
    // An unresolved action is an incident, not a stop for the whole Goal.
    // The work controller can pick another tactic while this incident is repaired.
    // Offer a work turn only when the host can continue the Goal now (shared/goal-continuation.ts); otherwise the
    // host defers it every time and the refusals come back as defect reports.
    if (!goalContinuationAdmissible(facts.status, facts.pauseReason)) altPaths = altPaths.filter((action) => action !== "start_work_turn");
    else if (rest.attemptDue && boundary !== "owner_stop" && !altPaths.includes("start_work_turn")) altPaths.unshift("start_work_turn");
    // Every remaining path is refused by this goal's structure (not by a transient state): nothing AGI can attempt will ever be
    // admitted. The failure stays visible to the owner as needs_owner (the run failed; sending the message again is theirs),
    // and the incident settles instead of retrying forever on its backoff.
    if (rest.attemptDue && STRANDABLE_SIGNALS.has(rest.primarySignal as AgiBlockerSignalKind) && ownerClass !== "our_defect" && !defects.length
      && boundary !== "owner_stop"
      && altPaths.filter((action) => !AGI_NON_ALTERNATIVE_ACTIONS.has(action)).every((action) => STRUCTURAL_PATHS.has(action) && !pathAdmissible(action, facts, eligibleTactics))) {
      return { schemaVersion: AGI_BLOCKER_SCHEMA, goalId: facts.goalId, stateDigest, eligibleTactics, branchReadiness: facts.planReadiness?.branches.map(({ evidenceRefs: _refs, ...branch }) => branch), defects, evidenceRefs,
        ...rest, display: "needs_owner", attemptDue: false, ownerClass, boundary, altPaths: [], reasonCode: AGI_NO_ADMISSIBLE_PATH, ...appRestart,
        ...(signalCode ? { signalCode } : {}) };
    }
    return { schemaVersion: AGI_BLOCKER_SCHEMA, goalId: facts.goalId, stateDigest, eligibleTactics, branchReadiness: facts.planReadiness?.branches.map(({ evidenceRefs: _refs, ...branch }) => branch), defects, evidenceRefs,
      ...rest, display: rest.attemptDue && boundary !== "owner_stop" ? "running" : rest.display,
      ownerClass, boundary, altPaths, ...appRestart, ...(signalCode ? { signalCode } : {}) };
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

  // 1b. A Goal paused by its budget is a stop only the owner lifts (owner decision 2026-10-04: the token limit really
  //     stops; the way on is the owner's). It used to read as a "payment" boundary with an attempt due, so AGI kept
  //     opening incidents and starting turns for a Goal paused since 2026-09-06 and filed a defect about it at
  //     nearly every wake (agi_unblock_repeats_budget_paused_goal, agi.budget_pause_misclassified_as_payment and
  //     five more codes on 2026-10-04..05). No attempt, no notice, like an owner stop.
  if (facts.status === "paused" && facts.pauseReason === "budget") {
    return base({ display: "paused", attemptDue: false, primarySignal: "owner_pause", causeKind: "boundary", ownerClass: "human_only",
      boundary: "owner_stop", altPaths: [], reasonCode: "budget_stop", signal: null });
  }

  // Secondary defect findings that ride along with any primary class.
  const waitRefused = find("wait_registration_refused");
  const repeated = find("repeated_notice");
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
  // 2b. A continuation the host promised was refused (sign-in verified or full access approved, successor not started). The owner's
  //     part is done; the Goal's next turn from its checkpoint is the way on, then the other branches.
  const refusedContinuation = find("continuation_refused");
  if (refusedContinuation) {
    return base({ display: "blocked", attemptDue: true, primarySignal: "continuation_refused", causeKind: "resource_busy", ownerClass: "agent_resolvable",
      boundary: null, altPaths: ["start_work_turn", ...branchWork, "replan_tree"], reasonCode: `continuation_refused_${refusedContinuation.continuation.replace(/-/g, "_")}`,
      signal: refusedContinuation });
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
  // 7b. The Goal's wakes fail the same way every time: the host's retry repeats it, so it is our defect (filed, and One tells the
  //     owner what and why) while AGI moves the work another way (teammates, a new plan); a turn is still tried first when the
  //     host would admit one.
  const repeatedFailure = find("repeated_failure");
  if (repeatedFailure) {
    addDefect(`repeated_failure:${repeatedFailure.code}`, "stall", repeatedFailure);
    const { cause } = causeOfRunCode(repeatedFailure.code);
    return base({ display: "blocked", attemptDue: true, primarySignal: "repeated_failure", causeKind: cause, ownerClass: "our_defect",
      boundary: null, altPaths: [...branchWork, "replan_tree", "switch_runtime"], reasonCode: "repeated_failure", signal: repeatedFailure });
  }
  // 8. A failed or refused turn.
  const failed = find("run_failed");
  if (failed) {
    const { cause, ourDefect } = causeOfRunCode(failed.code);
    if (ourDefect) addDefect(`run_failed:${failed.code}`, "crash", failed);
    // A lost session: a new session from the checkpoint first (the host retired the old binding), then another runtime.
    const moves: AgiActionKind[] = AGI_RUNTIME_SESSION_LOST_CODES.has(failed.code) ? ["start_work_turn", ...branchWork, "switch_runtime"]
      : cause === "quota" || cause === "auth" || cause === "runtime_unavailable" ? ["switch_runtime", ...branchWork]
      : cause === "tool_refused" || cause === "tool_missing" ? ["retry_node_with", "replan_tree", "switch_runtime"]
        : [...branchWork, "replan_tree", "switch_runtime"];
    return base({ display: "blocked", attemptDue: true, primarySignal: "run_failed", causeKind: cause, ownerClass: ourDefect ? "our_defect" : "agent_resolvable",
      boundary: null, altPaths: moves, reasonCode: AGI_RUNTIME_SESSION_LOST_CODES.has(failed.code) ? "run_failed_session_lost" : `run_failed_${cause}`, signal: failed });
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
