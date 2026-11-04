/**
 * The Goal lifecycle port (PLAN S7-4): the interface the common Goal engine drives a run's lifecycle through, and the registry that
 * names which implementation answers for a run.
 *
 * Two implementations answer. The HOST port is the common ledger itself (long_runs, Work and One). A DOMAIN port is a surface that
 * keeps its own loop state and its own atomic admission (Science: the attempt and the budget are updated in ONE transaction of the
 * Science database, so that state is not copied here). The engine asks the same questions of either and gets the same shapes back;
 * it never branches on a surface string to do so.
 *
 * This file imports no store at runtime (type-only), so the store functions can consult the registry without a cycle.
 */
import type { LongRunRecord } from "../store/long-runs";
import type { SegmentBudgetExhaustReason, SegmentBudgetState } from "../../shared/segment-budget";

export type GoalLifecycleKind = "host" | "domain";
export type GoalLifecyclePhase = "active" | "waiting" | "parked" | "terminal";
export type GoalParkCause = "budget" | "owner" | "host_boundary" | "approval" | "other";

/** One status shape for every surface. */
export interface GoalLifecycleStatus {
  kind: GoalLifecycleKind;
  phase: GoalLifecyclePhase;
  parkCause: GoalParkCause | null;
  /** The run's budget segment in the common shape (a domain's own budget is mirrored into it); null = none. */
  budget: SegmentBudgetState | null;
  /** When the budget clock next needs a look; null = nothing armed (spent, stopped, or a scheduling hold stops the clock). */
  nextDeadlineAt: string | null;
  /** A restart resumes this run by itself (it was parked by the host boundary, not by the owner or its budget). */
  resumesAtRestart: boolean;
}

export type GoalAdmission =
  | { admitted: true;
      /** The port wrote the attempt itself (domain, atomically with its budget); a host's attempts are written by startLongRunWorkerAttempt. */
      registered: boolean }
  | { admitted: false; cause: "budget" | "owner_stopped" | "not_active" | "conflict" };

export interface GoalBudgetVerdict {
  exhausted: boolean;
  reason: SegmentBudgetExhaustReason | null;
  /** The run now rests parked on the budget. */
  parked: boolean;
}

export type GoalResume = { resumed: true } | { resumed: false; reason: string };

export interface GoalResumeRequest {
  /** "owner" = the person pressed Resume; "host" = the app restarted / a retry came due, no person. */
  actor: "owner" | "host";
  reason: string;
  /** The instance taking custody on a host run's owner Resume. */
  appInstanceId?: string;
  expectedLoopVersion?: number;
}

export interface GoalLifecyclePort {
  readonly kind: GoalLifecycleKind;
  status(run: LongRunRecord, nowMs?: number): GoalLifecycleStatus | null;
  /** May another attempt start now; a domain port registers it too, in its own transaction. */
  admit(run: LongRunRecord, attempt: { invocationRunId: string }, nowMs?: number): GoalAdmission;
  /** Re-read the budget against the clock and park the run when it is spent. */
  evaluateBudget(run: LongRunRecord, nowMs?: number): GoalBudgetVerdict;
  park(run: LongRunRecord, request: { cause: "owner" | "host_boundary"; reason: string; requestId?: string }): { parked: boolean; reason?: string };
  resume(run: LongRunRecord, request: GoalResumeRequest): GoalResume;
  /** Complete the run. A host run completes only on verified criteria; a domain completes by its own declaration rules. */
  complete(run: LongRunRecord, request: { reason: string; requestId?: string }): { completed: boolean; reason?: string };
}

const domainPorts = new Map<string, GoalLifecyclePort>();

/** A surface that keeps its own loop registers the port that fronts it. Returns the undo (a stopped host unregisters). */
export function registerDomainGoalLifecyclePort(surface: string, port: GoalLifecyclePort): () => void {
  if (!surface || port.kind !== "domain") throw new Error("goal_lifecycle_domain_port_invalid");
  if (domainPorts.has(surface)) throw new Error(`goal_lifecycle_domain_port_duplicate:${surface}`);
  domainPorts.set(surface, port);
  return () => { if (domainPorts.get(surface) === port) domainPorts.delete(surface); };
}

export function domainGoalLifecyclePort(surface: string | null | undefined): GoalLifecyclePort | null {
  return surface ? domainPorts.get(surface) ?? null : null;
}
