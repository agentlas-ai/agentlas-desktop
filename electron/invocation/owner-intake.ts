import type { InvocationSteerResult, McpInvocationRequest } from "../../shared/types";
import type { InvocationWorkspaceBinding } from "./workspace-binding";
import { isTransientSendRefusalCode, sendRefusalCode } from "../../shared/transient-send-refusal";

/**
 * Owner intake: the one rule for a message the owner sends, from every surface (owner 2026-10-28: "내가 뭔 상황에서 유저가
 * 뭔 말을 하던 거절 불가").
 *
 * Production 2026-10-28 12:25-12:53Z, YouTube room (chat 8f3e09ee): the owner's "올리라고" from the phone met a chat still
 * cleaning up its previous turn, and the phone got `invocation_cleanup_pending` straight back; the Desktop composer already
 * queued such a message (renderer-send-queue.ts), the phone did not. A phone message into a Work room whose Goal the owner
 * had paused was refused `goal_explicit_resume_required`, and a phone message into a Goal room was never shown to the Goal
 * (its review was skipped as `execution_context`). The rule is now the same for every surface:
 *
 *  - a turn of the chat is running: the message goes into that turn as a direction (InvocationService.steer);
 *  - the chat is busy otherwise (the previous turn is settling or preparing, another process holds it, the app is restarting,
 *    the owner's own Stop is still draining): the message is saved in the transcript at once, the owner sees that it was
 *    received, and it starts the moment the chat is free (the durable steer queue retries it, invocation-steers.ts);
 *  - a Goal of the chat is waiting, blocked or paused: the message runs as the owner's turn and is reviewed as the owner's
 *    direction for that Goal (reviewOwnerGoalMessage). From the Desktop composer it resumes the Goal as before; from the
 *    phone or Telegram it runs as an ordinary turn of the room and leaves a paused Goal paused;
 *  - the runtime itself cannot run (signed out, limit): the run starts and fails with its own typed cause line, as before.
 *
 * Holds of system starts (a teammate's report, a host continuation, an automation) are unchanged: only the owner's own
 * words are never refused. Which refusals are "wait for the chat" is one list for every surface
 * (shared/transient-send-refusal.ts); this file decides who the owner is and what the received line says.
 */

/** The surface an owner message came from; null when the request is not the owner's own words. */
export type OwnerIntakeSurface = "desktop" | "mobile" | "mobile-one" | "telegram-one";

/** Prefix of the durable steer rows the owner intake writes (invocation_steers.id). */
export const OWNER_INTAKE_STEER_PREFIX = "owner-intake:";

/**
 * Prefix of the durable row of an owner message that went into a running turn as its direction. It is keyed by the same
 * intake id as the waiting-message row above, so a message the intake took is findable by its key whichever way it went:
 * a resend of the same key finds the row instead of steering twice, and a restart can tell "taken" from "never taken".
 * (It differs from OWNER_INTAKE_STEER_PREFIX because that prefix also marks a message already shown in the transcript,
 * which a steered direction is not: carried-owner-followups.ts binds the transcript row by it.)
 */
export const OWNER_STEERED_PREFIX = "owner-steered:";

/** What the durable rows say became of one intake id (InvocationService.ownerIntakeOutcome). */
export type OwnerIntakeOutcome =
  | { kind: "started"; runId: string }
  | { kind: "steered"; steer: InvocationSteerResult }
  | { kind: "queued"; plannedRunId: string; steer: InvocationSteerResult }
  | { kind: "failed" };

type OwnerExecutionContext = object & { readonly source?: string }

/** Exactly the shapes the owner's own channels start with: the binding plus that channel's execution surface, nothing else. */
function surfaceOnly(context: OwnerExecutionContext | undefined, surface: "mobile" | "telegram"): boolean {
  return !context || (context.source === surface && Object.keys(context as Record<string, unknown>)
    .every((key) => key === "source" || (surface === "telegram" && key === "surfaceContext")));
}

export function ownerMessageSurface(
  req: Pick<McpInvocationRequest, "promptOrigin" | "agentAppMode" | "oneTeamReportTurn">,
  workspaceBinding: Pick<InvocationWorkspaceBinding, "source"> | undefined,
  executionContext: OwnerExecutionContext | undefined,
): OwnerIntakeSurface | null {
  if (req.promptOrigin === "system" || req.agentAppMode === true || req.oneTeamReportTurn === true) return null;
  if (!workspaceBinding) {
    if (!executionContext) return "desktop";
    // A phone direction into a run the Desktop started keeps that run's (absent) binding (mobile-bridge invoke.steer).
    return surfaceOnly(executionContext, "mobile") ? "mobile" : null;
  }
  if ((workspaceBinding.source === "mobile" || workspaceBinding.source === "mobile-one") && surfaceOnly(executionContext, "mobile")) {
    return workspaceBinding.source;
  }
  if (workspaceBinding.source === "telegram-one" && surfaceOnly(executionContext, "telegram")) return "telegram-one";
  return null;
}

/** A start refusal that means "the chat is not free yet": the owner's message waits for it instead of being refused. */
export function ownerIntakeWaits(error: unknown): boolean {
  return isTransientSendRefusalCode(sendRefusalCode(error));
}

/** Before this long the message usually started on its own; a received line then would only be noise. */
export const OWNER_INTAKE_NOTICE_AFTER_MS = 4_000;

/**
 * A message the intake took while the request-intent judge was still answering (`startAfter`) starts when the judge
 * settles. The judges are bounded by their own 5 minute timeout; this is the safety net if one never settles, so a taken
 * message can never wait on a hung promise.
 */
export const OWNER_INTAKE_START_HOLD_MAX_MS = 310_000;

/** The received line for a message that is waiting for its chat. Pure; the phone and the Desktop draw the same stored row. */
export function ownerIntakeReceivedNotice(locale: "ko" | "en"): string {
  return locale === "ko"
    ? "받았습니다. 앞 작업 정리가 끝나는 대로 바로 실행합니다."
    : "Received. It runs as soon as the previous work has finished cleaning up.";
}
