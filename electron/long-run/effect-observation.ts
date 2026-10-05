/**
 * Effect observation — retired (owner decision 2026-10-05).
 *
 * This module used to launch a separate read-only model run (a "look") whenever a Goal or an automation step
 * had ended without the app knowing whether it had acted outside, and it held the Goal or step until a look,
 * the host receipt or a person settled it. On the owner's DB that machinery ran 139 looks (127 inconclusive,
 * about 55k input tokens each where measured), needed 19 manual acknowledgments, and its refusals made the
 * Thread Marketing Goal re-run every minute; only 3 looks found an action that had really taken effect.
 *
 * Owner: "그냥 잠금 제거하고 … 직전 초단기 메모리 보고 그냥 ai 스스로 체크만 하면 되지 판단보조로" and
 * "직접 대조가 전체중단시키거나 하면안됨". What replaced it:
 *   - memory/previous-turn.ts gives every turn the previous turn of its conversation, with any outside call whose
 *     outcome is unknown and a judgement aid to look at the current state before repeating it;
 *   - store/long-runs.ts unsettledLongRunAttempts counts only a running attempt (bc6584e3);
 *   - workflow/run-graph.ts runs an automation step of unknown outcome with a note instead of holding it (1180fda2);
 *   - one/host-alerts.ts reports what the app cannot get past on its own to the owner through One (b77e3c0b).
 *
 * The functions below keep the names their callers import and answer that looks are retired. The previous
 * implementation is in git history (last full version: 1180fda2).
 */
import type { ParsedEffectObservation } from "../../shared/effect-observation";
import { GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN, isClaimedWaitRecoveryBlocker } from "../../shared/long-run";
import {
  effectObservationTicket, registerAutomationObservationRuntime,
  type AutomationObservationRuntime, type EffectObservationDispatcher, type EffectObservationTicket,
} from "./effect-observation-tickets";

export {
  effectObservationTicket, registerAutomationObservationRuntime,
  type AutomationObservationRuntime, type EffectObservationDispatcher, type EffectObservationTicket,
};

/** A look's time budget. No look starts any more; the host still bounds a legacy look run it may meet. */
export const EFFECT_OBSERVATION_TIME_LIMIT_MS = 5 * 60_000;

const RETIRED = "effect_observation_retired";

/** Blockers that state an external effect is unknown. Older installs may have left a Goal blocked on one; the
 * blocked-goal sweep continues such a Goal itself. */
const EFFECT_UNCERTAIN_BLOCK_REASONS = new Set<string>([
  "checkpoint_side_effects_uncertain",
  "goal_wait_effects_uncertain",
  "auto_goal_resume_attempt_unsettled",
  GOAL_RESUME_EFFECT_BOUNDARY_UNCERTAIN,
  "goal_wait_claimed_dispatch_uncertain",
  "goal_wait_claimed_binding_changed",
]);

/** Whether this blocker is itself a statement that an external effect is unknown. */
export function isEffectUncertainBlockReason(reason: string | null | undefined): boolean {
  return EFFECT_UNCERTAIN_BLOCK_REASONS.has(reason ?? "") || isClaimedWaitRecoveryBlocker(reason);
}

export type EffectObservationDispatchResult =
  | { status: "dispatched"; runId: string }
  | { status: "skipped"; reason: string };

export type EffectObservationOutcome =
  | { outcome: "resumed"; verdict: "done" | "not_done"; resumeRunId: string }
  | { outcome: "wait_registered"; verdict: "done" | "not_done"; waitId: string }
  | { outcome: "fallback"; reason: string }
  | { outcome: "observed"; verdict: "done" | "not_done" };

/** Retired: no look is launched for a Goal. */
export function maybeDispatchEffectObservation(
  _dispatcher: EffectObservationDispatcher, _goalId: string, _trigger: string, _options: { epoch?: number } = {},
): EffectObservationDispatchResult {
  return { status: "skipped", reason: RETIRED };
}

/** Retired: no Goal look is ever due. */
export function sweepDueGoalEffectObservations(_dispatcher: EffectObservationDispatcher): EffectObservationDispatchResult[] {
  return [];
}

/** Retired: no automation look is launched. */
export function sweepAutomationEffectObservations(_runtime: AutomationObservationRuntime): EffectObservationDispatchResult[] {
  return [];
}

/** No look run exists to settle. */
export function completeEffectObservation(_input: {
  runId: string;
  parsed: ParsedEffectObservation | null;
  aborted: boolean;
  failed: boolean;
  proof?: "receipt";
}): EffectObservationOutcome | null {
  return null;
}

/** No look run exists whose verdict could be read. */
export function readEffectObservationFromFinal(_runId: string, _text: string): ParsedEffectObservation | null {
  return null;
}
