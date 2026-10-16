/*
 * A graph step that hands work to its room's teammates stays open until that work has settled, and it is the step —
 * with its own team tools — that is woken by each result.
 *
 * Production 2026-10-12..16 (daily "TCIagent YouTube" graph cdf732ca, step1 = the room's One with One Team tools): every
 * day step1 started teammate sessions, was told "background work started; the result wakes this conversation; end the
 * turn" (team-dispatch.ts oneTeamStartSession), and ended within 0-17 minutes. The result never woke the step: a graph
 * step acts for its room (graph-team-grant.ts), so the dispatch row named the ROOM as its parent, and a settled session
 * woke the room's One with a read-only report turn that may not hand work on (oneTeamReportTurn, X4). The step itself
 * had already ended, step2 checked a production that had not happened, and verify2 failed. No video was ever produced by
 * the graph; the 15 videos of 10-14 came from the room's Goal loop (419 cycles) that re-woke One with its tools.
 * Dev-instance replay r01 (2026-10-17 00:55 KST) reproduced it exactly: step1 ended after 7m46s with three teammates
 * running and "미완료".
 *
 * So the step owns what it dispatched (one_team_dispatches.graph_owner = "<runId>#<nodeId>", written by the host from the
 * Main-minted grant, never from model input), and runGraphTeamStep drives it:
 *   1. run the step's turn;
 *   2. while a session it owns is still working, wait (no model turn, no polling the model);
 *   3. when a session settles, stops on the owner, or posts a note, run ONE continuation turn of the same step, in the
 *      same conversation with the same grant, carrying those results as data;
 *   4. the step ends when it has nothing in flight and nothing unread: its last turn's answer is the step's output.
 * A session parked on an owner-only action is not "in flight" for the step: it cannot move without the owner, the step
 * hears about it once and decides (an unattended run never waits on an owner here).
 *
 * The wait lives only in this process. If the host dies while a step waits, the run is interrupted like any in-flight
 * step (the graph runner's interrupted semantics); nothing here restarts it.
 */

export type GraphTeamStepEvent =
  | { kind: "settled"; dispatchId: string }
  | { kind: "owner_wait"; dispatchId: string }
  | { kind: "note"; dispatchId: string; from: string; text: string };

interface OpenStep {
  events: GraphTeamStepEvent[];
  wake: (() => void) | null;
  phase: "turn" | "waiting";
  turnStartedAt: number;
  turnBudgetMs: number;
}

const openSteps = new Map<string, OpenStep>();

export function graphTeamStepOwner(runId: string, nodeId: string): string {
  return `${runId}#${nodeId}`;
}

export function graphTeamStepOpen(owner: string | null | undefined): boolean {
  return Boolean(owner && openSteps.has(owner));
}

/** A settlement / owner wait / note for a step that is open. False when no step holds it (the caller keeps its own path). */
export function deliverGraphTeamStepEvent(owner: string | null | undefined, event: GraphTeamStepEvent): boolean {
  const step = owner ? openSteps.get(owner) : undefined;
  if (!step) return false;
  if (event.kind !== "note" && step.events.some((item) => item.kind === event.kind && item.dispatchId === event.dispatchId)) return true;
  step.events.push(event);
  const wake = step.wake;
  step.wake = null;
  wake?.();
  return true;
}

/** The step read this result itself (one_team_session_status): it is not handed to it again. */
export function consumeGraphTeamStepEvent(owner: string | null | undefined, dispatchId: string): void {
  const step = owner ? openSteps.get(owner) : undefined;
  if (step) step.events = step.events.filter((event) => event.kind === "note" || event.dispatchId !== dispatchId);
}

/**
 * Until when the step's deadline must not cut it: while it waits on teammates that are working, and during each of its
 * own turns for that turn's full budget (the step's node budget applies to the step's own turns, not to the teammates'
 * work it is waiting for). Null when the step is not open or nothing it owns is working.
 */
export function graphTeamStepHold(runId: string, nodeId: string, now = Date.now()): number | null {
  const step = openSteps.get(graphTeamStepOwner(runId, nodeId));
  if (!step) return null;
  if (step.phase === "turn") return step.turnStartedAt + step.turnBudgetMs;
  const live = ownedWork(graphTeamStepOwner(runId, nodeId)).some((item) => item.inFlight);
  return live ? now + 60_000 : null;
}

export interface GraphTeamStepWork { dispatchId: string; member: string; status: string; inFlight: boolean; active: boolean }

function ownedWork(owner: string): GraphTeamStepWork[] {
  try {
    return (require("./team-dispatch") as typeof import("./team-dispatch")).graphStepOwnedWork(owner);
  } catch {
    return [];
  }
}

export interface GraphTeamStepDriver<T> {
  /** graph-team-grant.ts grant of this step (null = not a team step: one turn, exactly as before). */
  grant: { runId: string; nodeId: string; permission: "read" | "write" } | null;
  dryRun: boolean;
  /** The step's node budget (run-graph nodeTimeoutMs): it bounds each of the step's own turns. */
  turnBudgetMs: number;
  signal: AbortSignal;
  /** The step's first turn, exactly as without a team. */
  first: () => Promise<T>;
  /** One continuation turn of the same step with this host-composed prompt. */
  next: (prompt: string) => Promise<T>;
  /** A turn that failed ends the step with that failure (no continuation after a failed turn). */
  turnFailed: (result: T) => boolean;
  /** Host progress while the step waits (keeps the run's inactivity watchdog fed only by real teammate activity). */
  onWaiting?: (work: readonly GraphTeamStepWork[]) => void;
  /** Heartbeat period while teammates are active (default 4 minutes, under the 8-minute run inactivity watchdog). */
  heartbeatMs?: number;
}

export async function runGraphTeamStep<T>(driver: GraphTeamStepDriver<T>): Promise<T> {
  if (!driver.grant || driver.grant.permission !== "write" || driver.dryRun) return driver.first();
  const owner = graphTeamStepOwner(driver.grant.runId, driver.grant.nodeId);
  if (openSteps.has(owner)) throw new Error("graph_team_step_already_open");
  const step: OpenStep = { events: [], wake: null, phase: "turn", turnStartedAt: Date.now(), turnBudgetMs: driver.turnBudgetMs };
  openSteps.set(owner, step);
  const heartbeatMs = Math.max(1_000, driver.heartbeatMs ?? 4 * 60_000);
  try {
    let result = await driver.first();
    for (;;) {
      if (driver.turnFailed(result) || driver.signal.aborted) return result;
      if (step.events.length === 0) {
        const work = ownedWork(owner);
        if (!work.some((item) => item.inFlight)) return result;
        step.phase = "waiting";
        await new Promise<void>((resolve) => {
          const done = () => { clearInterval(beat); driver.signal.removeEventListener("abort", done); step.wake = null; resolve(); };
          const beat = setInterval(() => {
            const now = ownedWork(owner);
            if (!now.some((item) => item.inFlight)) { done(); return; }
            if (now.some((item) => item.active)) driver.onWaiting?.(now);
          }, heartbeatMs);
          step.wake = done;
          driver.signal.addEventListener("abort", done, { once: true });
          if (step.events.length > 0 || driver.signal.aborted) done();
        });
        if (driver.signal.aborted) return result;
        continue;
      }
      const events = step.events.splice(0, step.events.length);
      const prompt = (require("./team-dispatch") as typeof import("./team-dispatch")).graphTeamStepContinuationPrompt(owner, events);
      step.phase = "turn";
      step.turnStartedAt = Date.now();
      result = await driver.next(prompt);
    }
  } finally {
    openSteps.delete(owner);
    step.wake?.();
  }
}

/** Test seam: steps currently open (contract gates only). */
export function openGraphTeamStepOwners(): string[] {
  return [...openSteps.keys()];
}
