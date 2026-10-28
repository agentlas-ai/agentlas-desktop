/**
 * AGI goal manager, P3 — the deterministic unblock handler the monitor calls on unblock_attempt_due.
 *
 * R15: the model is called only when the diff has no deterministic fix. This handler is that deterministic part:
 * for the attempt's diagnosis it files every defect it found (local only; sending needs the owner's press, D5), then
 * walks the ordered alternative paths and executes the first one whose arguments are host facts (start the unblocked
 * tactic's turn, run the login ladder for the named domain,
 * restart the Agentlas Browser, record a runtime switch). Paths that need a judgement to fill their arguments
 * (create/dispatch a teammate, replan, retry with another tool, the owner ask) are left to the model-backed attempt
 * (plan P4) and the handler rests. Action ids are derived from (incident, attempt, action), so a crash replay finds its
 * receipt instead of acting twice.
 */
import { agiDecisionRefusal, retainAgiDecisionControl } from "./decision-control";
import type { AgiBlockerFacts, AgiActionKind } from "./blocker";
import { AGI_NON_ALTERNATIVE_ACTIONS, agiHarnessCapability } from "./blocker";
import { AGI_ACTION_SCHEMA, type AgiActionExecutor, type AgiActionReceipt } from "./actions";
import type { AgiUnblockHandler, AgiUnblockInput, AgiUnblockResult } from "./monitor";
import type { AgiModelAttempt } from "./model-attempt";
import { runtimeFailureBlocksReplay } from "../runtime/selection";

function actionId(input: AgiUnblockInput, attempt: number, action: string, index: number): string {
  const incident = input.incidentId.replace(/[^A-Za-z0-9]/g, "").slice(-24);
  return `agi:${incident}:${attempt}:${action}:${index}`;
}

function deterministicArgs(action: AgiActionKind, input: AgiUnblockInput, facts: AgiBlockerFacts | null): Record<string, unknown> | null {
  const d = input.diagnosis;
  switch (action) {
    case "start_work_turn": return { nodeId: d.eligibleTactics[0] ?? null };
    case "run_login_recovery": {
      const wall = facts?.signals.find((signal) => signal.kind === "login_wall");
      return wall && wall.kind === "login_wall" && wall.domain !== "unknown" ? { domain: wall.domain } : null;
    }
    case "restart_agentlas_browser": return {};
    case "switch_runtime": return { reason: d.reasonCode };
    default: return null;
  }
}

/** The capability rule lives in blocker.ts (the executor's repeat escalation uses it too). */
export const harnessCapability = agiHarnessCapability;

export type AgiUnblockHandlerWithModel = AgiUnblockHandler & {
  /** Resolves when every model attempt this handler dispatched has settled (contracts, shutdown). */
  settled(): Promise<void>;
};

/**
 * The handler the monitor calls. With a model attempt installed (P4) it files the defects, then dispatches ONE model
 * attempt for this state and returns at once; the attempt's end is written back to agi_unblock_attempts. If the model
 * attempt could not act (no runtime, budget, invalid answer, only refusals) the deterministic first host-fact path
 * runs as the fallback, so a stuck goal never depends on a model being available.
 */
export function createAgiDeterministicHandler(executor: AgiActionExecutor, readFacts?: (goalId: string) => AgiBlockerFacts | null,
  model?: AgiModelAttempt | null): AgiUnblockHandlerWithModel {
  const inFlight = new Set<Promise<unknown>>();
  const handler = ((input: AgiUnblockInput) => {
    const controlRefusal = () => agiDecisionRefusal(input);
    const initialRefusal = controlRefusal();
    if (initialRefusal) return { outcome: "rested", code: initialRefusal };
    if (input.facts?.repairInFlight || model?.isRunning(input.goalId) || executor.isDeferredBusy(input.goalId)) return { outcome: "rested", code: "agi.repair-in-flight" };
    const d = input.diagnosis;
    if (!input.runId || input.runVersion === null) return { outcome: "failed", code: "agi.goal-ledger-missing" };
    const incident = executor.incidents.get(input.incidentId);
    const attempt = Math.max(1, incident?.attempts ?? 1);
    const fence = { goalId: input.goalId, runId: input.runId, runVersion: input.runVersion };
    const facts = input.facts ?? readFacts?.(input.goalId) ?? null;
    const done: Array<{ action: string; result: string }> = [];
    const run = (action: AgiActionKind, args: Record<string, unknown>, index: number, runFence = fence): AgiActionReceipt => {
      const refusal = controlRefusal();
      if (refusal) return { actionId: actionId(input, attempt, action, index), action, ok: false, code: refusal };
      let refreshed: ReturnType<NonNullable<AgiUnblockInput["refreshFence"]>> | undefined;
      try { refreshed = input.refreshFence?.(); } catch { refreshed = null; }
      if (input.refreshFence && !refreshed) return { actionId: actionId(input, attempt, action, index), action, ok: false, code: "agi.action.state-changed" };
      const receipt = executor.execute({ schema: AGI_ACTION_SCHEMA, actionId: actionId(input, attempt, action, index), incidentId: input.incidentId,
        attempt, fence: refreshed ?? runFence, action, args, attemptTokensSoFar: 0 }, input);
      done.push({ action, result: receipt.ok ? receipt.code : `refused:${receipt.code}` });
      // This attempt's own accepted effect is the state its next action expects (monitor.ts acceptOwnEffect).
      if (receipt.ok) { try { input.acceptOwnEffect?.(); } catch { /* the next refresh reads the store again */ } }
      return receipt;
    };
    // 1. Our defects: one local record each (the chip offers sending; nothing leaves without the owner's press).
    d.defects.forEach((defect, index) => {
      run("file_defect", { code: defect.code, category: defect.category,
        evidenceRefs: defect.evidenceRefs.length ? defect.evidenceRefs : d.evidenceRefs }, index);
    });
    // 2. The first alternative path whose arguments are host facts.
    const deterministic = (runFence = fence): boolean => {
      let acted = false;
      d.altPaths.forEach((action, index) => {
        if (acted || AGI_NON_ALTERNATIVE_ACTIONS.has(action)) return;
        if (action === "start_work_turn" && !executor.canContinueGoal(input.goalId)) return;
        const args = deterministicArgs(action, input, facts);
        if (!args) return;
        const receipt = run(action, args, 100 + index, runFence);
        if (receipt.ok) acted = true;
      });
      return acted;
    };
    // 1b. The same Agentlas capability failing again (this reason code opened twice for the goal in a day, or a second
    // attempt on the same state) means the Agentlas path itself is broken, and another Agentlas path tends to hit the
    // same defect (production 2026-10-12: one goal opened browser_unavailable 36 times in a week, each "resolved" by a
    // browser restart or a new turn and back again). The capability is handed to the runtime's own tools for this goal;
    // the work turn below then runs with that host notice in its plan context.
    const capability = harnessCapability(d);
    if (capability && (attempt >= 2 || executor.incidents.recurrences(input.goalId, d.reasonCode, Date.now() - 24 * 60 * 60_000) >= 2)) {
      run("use_native_harness", { capability, defect: d.reasonCode }, 80);
    }
    // Start independent work before advisory model checks; repair may time out
    // or ask for a missing credential without holding the original controller. Only when the host would continue the Goal now:
    // asked anyway, the host deferred 7,841 of 7,888 such turns (a running Goal, or a scheduled retry that owns the next step).
    const initialVersion = executor.currentVersion(input.goalId);
    const work = initialVersion === null || !executor.canContinueGoal(input.goalId) ? null
      : run("start_work_turn", { nodeId: d.eligibleTactics[0] ?? null }, 90, { ...fence, runVersion: initialVersion });
    const workStarted = work?.ok === true;
    if (workStarted) return { outcome: "acted", code: "agi.work-continued", actions: done };
    if (model) {
      const refusal = controlRefusal();
      if (refusal) return { outcome: "rested", code: refusal, actions: done };
      const pre = [...done];
      const modelVersion = executor.currentVersion(input.goalId);
      const release = retainAgiDecisionControl(input);
      let flight: Promise<void>;
      try { flight = model.run({ ...input, runVersion: modelVersion ?? input.runVersion }, pre).then((result) => {
        let final: AgiUnblockResult = result;
        // This code is produced only from Main's successful rest receipt with
        // actual wait/checkpoint IDs. Generic rested output is not a wake promise.
        const waitRegistered = result.code === "agi.model.wait-registered"
          && result.actions?.some(action => action.action === "rest" && action.result === "goal_episode_wait_registered") === true;
        const refusal = controlRefusal();
        if (refusal && result.outcome !== "acted" && result.outcome !== "needs-human" && !waitRegistered) final = { ...result, outcome: "rested", code: refusal };
        if (!refusal && !workStarted && result.outcome !== "acted" && !waitRegistered
          && !runtimeFailureBlocksReplay({ providerCode: result.code })) {
          const version = executor.currentVersion(input.goalId);
          const acted = version !== null && deterministic({ ...fence, runVersion: version });
          final = { ...result, outcome: acted ? "acted" : result.outcome, code: acted ? "agi.model-fallback-acted" : result.code,
            actions: [...(result.actions ?? []), ...done.slice(pre.length)] };
        }
        executor.recordAttemptResult(input.goalId, input.stateDigest, final, attempt);
      }, () => executor.recordAttemptResult(input.goalId, input.stateDigest, { outcome: "failed", code: "agi.model-attempt-threw" }, attempt)).finally(release); }
      catch (error) { release(); throw error; }
      inFlight.add(flight);
      void flight.then(() => inFlight.delete(flight), () => inFlight.delete(flight));
      return { outcome: workStarted ? "acted" : "rested", code: "agi.model-attempt-dispatched", actions: done };
    }
    if (workStarted) return { outcome: "acted", code: "agi.work-continued", actions: done };
    if (deterministic()) return { outcome: "acted", actions: done };
    // A real boundary with no deterministic alternative: the model-backed attempt (P4) or the owner card handles it.
    if (d.ownerClass === "human_only" && d.boundary) return { outcome: "needs-human", code: `agi.boundary.${d.boundary}`, actions: done };
    return { outcome: "rested", code: "agi.no-deterministic-path", actions: done };
  }) as AgiUnblockHandlerWithModel;
  handler.isBusy = (goalId) => model?.isRunning(goalId) === true || executor.isDeferredBusy(goalId);
  handler.settled = async () => {
    while (inFlight.size || executor.isDeferredBusy()) await Promise.allSettled([...inFlight, executor.settledDeferred()]);
  };
  return handler;
}
