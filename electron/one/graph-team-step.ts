



























export type GraphTeamStepEvent =
  | { kind: "settled"; dispatchId: string }
  | { kind: "owner_wait"; dispatchId: string }
  /** urgent: the note names a teammate who is not working, so someone has to start them (room-chat.ts idle recipient). */
  | { kind: "note"; dispatchId: string; from: string; text: string; urgent?: boolean };

/** A note that needs no one started waits this long for company (a result, a stop, more notes) before it wakes the step. */
export const GRAPH_TEAM_NOTE_BATCH_MS = 5 * 60_000;
const actionable = (event: GraphTeamStepEvent): boolean => event.kind !== "note" || event.urgent === true;

interface OpenStep {
  events: GraphTeamStepEvent[];
  wake: (() => void) | null;
  /** Starts the note batch window while the step waits. */
  onNote: (() => void) | null;
  /** The batch window closed: unread progress notes are delivered now. */
  notesDue: boolean;
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
  // Teammates post progress notes every minute or two; each wake is a full model turn. A result, an owner stop or a note
  // that needs someone started wakes the step at once; other notes ride along with the next of those, or after a quiet
  // batch window (dev replay r03: one continuation turn per minute, ~90k input tokens each, mostly for progress notes).
  if (!actionable(event)) { step.onNote?.(); return true; }
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
  /** How long progress-only notes wait for company before they wake the step (default GRAPH_TEAM_NOTE_BATCH_MS). */
  noteBatchMs?: number;
}

export async function runGraphTeamStep<T>(driver: GraphTeamStepDriver<T>): Promise<T> {
  if (!driver.grant || driver.grant.permission !== "write" || driver.dryRun) return driver.first();
  const owner = graphTeamStepOwner(driver.grant.runId, driver.grant.nodeId);
  if (openSteps.has(owner)) throw new Error("graph_team_step_already_open");
  const step: OpenStep = { events: [], wake: null, onNote: null, notesDue: false, phase: "turn", turnStartedAt: Date.now(), turnBudgetMs: driver.turnBudgetMs };
  openSteps.set(owner, step);
  const heartbeatMs = Math.max(1_000, driver.heartbeatMs ?? 4 * 60_000);
  const noteBatchMs = Math.max(1_000, driver.noteBatchMs ?? GRAPH_TEAM_NOTE_BATCH_MS);
  try {
    let result = await driver.first();
    for (;;) {
      if (driver.turnFailed(result) || driver.signal.aborted) return result;
      if (!step.notesDue && !step.events.some(actionable)) {
        if (!ownedWork(owner).some((item) => item.inFlight)) {
          // Nothing in flight: the step ends, after one turn for notes it has not read yet.
          if (step.events.length === 0) return result;
        } else {
          step.phase = "waiting";
          await new Promise<void>((resolve) => {
            let batch: ReturnType<typeof setTimeout> | null = null;
            const startBatch = () => { if (!batch) batch = setTimeout(() => { step.notesDue = true; done(); }, noteBatchMs); };
            const done = () => {
              clearInterval(beat); if (batch) clearTimeout(batch);
              driver.signal.removeEventListener("abort", done); step.wake = null; step.onNote = null; resolve();
            };
            const beat = setInterval(() => {
              const now = ownedWork(owner);
              if (!now.some((item) => item.inFlight)) { done(); return; }
              if (now.some((item) => item.active)) driver.onWaiting?.(now);
            }, heartbeatMs);
            step.wake = done;
            step.onNote = startBatch;
            driver.signal.addEventListener("abort", done, { once: true });
            if (step.events.length > 0) startBatch();
            if (step.events.some(actionable) || driver.signal.aborted) done();
          });
          if (driver.signal.aborted) return result;
          continue;
        }
      }
      const events = step.events.splice(0, step.events.length);
      step.notesDue = false;
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
