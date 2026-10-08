import type { McpInvocationRequest } from "../../shared/types";
import { effectiveInvocationPermission } from "../../shared/invocation-permission";
import { normalizeOnePreflightSteerRequest, ONE_PREFLIGHT_STEER_REQUEST_KEYS, type OnePreflightSteerRequest } from "../../shared/one-preflight-steers";
import { readInvocationEffectBoundary } from "./effect-boundary-reader";
import { invocationService } from "./service";
import { admitMainInvocation } from "../runtime/scheduled-root-context";
import {
  durableQueuedSteerMatches, persistQueuedSteer,
} from "../store/invocation-steers";
import {
  claimOnePreflightSteer, getOnePreflightSubmission, holdOnePreflightSteer,
  recoverOnePreflightSubmissionParents, listDispatchableOnePreflightSteers,
  markOnePreflightSteerAttached, reconcileClaimedOnePreflightSteers,
} from "../store/one-preflight-steers";
import { getInvocationRunReceipt } from "../store/run-events";

function requestForPreflightSteer(templateJson: string, chatId: string, prompt: string, choices?: OnePreflightSteerRequest): McpInvocationRequest {
  const template = JSON.parse(templateJson) as McpInvocationRequest;
  if (template.chatId !== chatId || template.oneMode !== true || template.userPrompt !== "") {
    throw new Error("one_preflight_steer_template_invalid");
  }
  if (choices !== undefined) {
    // A new gesture supplies a complete choice snapshot. Missing keys mean
    // defaults; they cannot inherit mutable or different parent choices.
    for (const key of ONE_PREFLIGHT_STEER_REQUEST_KEYS) delete template[key];
    Object.assign(template, normalizeOnePreflightSteerRequest(choices));
  }
  return { ...template, userPrompt: prompt,
    permissions: effectiveInvocationPermission(template.permissions, template.planMode), runId: undefined };
}

function exactDurable(id: string, chatId: string, parentRunId: string, request: McpInvocationRequest): boolean {
  return durableQueuedSteerMatches({ id, chatId, originalRunId: parentRunId, request });
}

/** Never infer permission to replay from a missing acknowledgement. */
export function dispatchOnePreflightSteers(submissionId?: string, chatId?: string): {
  examined: number; attached: number; held: number;
} {
  const candidates = listDispatchableOnePreflightSteers(submissionId, chatId);
  let attached = 0;
  let held = 0;
  const materializedChats = new Set<string>();
  const reservedCapacity = new Map<string, number>();
  for (const item of candidates) {
    // Intake has already committed this message. Scheduler saturation is a
    // known no-dispatch condition, so leave it queued and unclaimed.
    if (invocationService.steerQueueCapacity(item.chatId) <= (reservedCapacity.get(item.chatId) ?? 0)) continue;
    const parent = getOnePreflightSubmission(item.submissionId);
    const parentRunId = parent?.parent_run_id;
    if (!parent || parent.state !== "bound" || !parentRunId || !parent.steer_template_json) {
      if (holdOnePreflightSteer(item.steerId)) held += 1;
      continue;
    }
    const receipt = getInvocationRunReceipt(parentRunId);
    const active = invocationService.attach(item.chatId, { includeEvents: false });
    // The durable ledger projects a started-but-unterminated run as
    // "interrupted"; only the in-memory owner can attest that it is running.
    const activeParent = active?.runId === parentRunId
      && receipt?.chatId === item.chatId
      && invocationService.receipt(parentRunId)?.status === "running";
    let settledParent = false;
    if (!activeParent && receipt?.status === "completed") {
      try {
        const boundary = readInvocationEffectBoundary({
          invocationRunId: parentRunId, expectedChatId: item.chatId,
        });
        settledParent = boundary.terminal && boundary.effects === "settled";
      } catch { /* No effect proof is not an auto-resume grant. */ }
    }
    if (!activeParent && !settledParent) {
      if (holdOnePreflightSteer(item.steerId)) held += 1;
      continue;
    }
    if (!claimOnePreflightSteer(item.steerId, parentRunId)) {
      if (holdOnePreflightSteer(item.steerId)) held += 1;
      continue;
    }
    try {
      const request = requestForPreflightSteer(parent.steer_template_json, item.chatId, item.userPrompt, item.request);
      if (activeParent) {
        invocationService.steer(request, parentRunId, undefined, undefined,
          admitMainInvocation(item.chatId), item.steerId);
      } else {
        // An exact completed+effect-settled parent has no live service owner.
        // Materialize the ordinary durable queue using the same idempotency ID;
        // its existing boot recovery is the sole successor dispatcher.
        persistQueuedSteer({ id: item.steerId, chatId: item.chatId,
          originalRunId: parentRunId, request });
        materializedChats.add(item.chatId);
        reservedCapacity.set(item.chatId, (reservedCapacity.get(item.chatId) ?? 0) + 1);
      }
      if (!exactDurable(item.steerId, item.chatId, parentRunId, request)) {
        throw new Error("one_preflight_steer_receipt_missing");
      }
      if (markOnePreflightSteerAttached(item.steerId, parentRunId)) attached += 1;
    } catch {
      // The service may have persisted a row before its acknowledgement was
      // lost. Exact durable identity settles this handoff without resending.
      let acknowledged = false;
      try {
        acknowledged = exactDurable(item.steerId, item.chatId, parentRunId,
          requestForPreflightSteer(parent.steer_template_json, item.chatId, item.userPrompt, item.request));
      } catch { /* Template proof was lost. */ }
      if (acknowledged) {
        if (markOnePreflightSteerAttached(item.steerId, parentRunId)) attached += 1;
      } else if (holdOnePreflightSteer(item.steerId)) held += 1;
    }
  }
  for (const materializedChat of materializedChats) invocationService.recoverQueuedSteers(materializedChat);
  return { examined: candidates.length, attached, held };
}

/** Called after bootstrap gates and before ordinary queued-steer recovery. */
export function recoverOnePreflightSteers(currentOwnerEpoch: string): {
  parentBound: number; orphaned: number; acknowledged: number; uncertain: number;
  examined: number; attached: number; held: number;
} {
  const parents = recoverOnePreflightSubmissionParents(currentOwnerEpoch);
  const claims = reconcileClaimedOnePreflightSteers((item) => {
    const parent = getOnePreflightSubmission(item.submissionId);
    if (!item.parentRunId || !parent?.steer_template_json || parent.parent_run_id !== item.parentRunId) return false;
    try {
      return exactDurable(item.steerId, item.chatId, item.parentRunId,
        requestForPreflightSteer(parent.steer_template_json, item.chatId, item.userPrompt, item.request));
    } catch { return false; }
  });
  const dispatched = dispatchOnePreflightSteers();
  return { parentBound: parents.bound, orphaned: parents.held,
    acknowledged: claims.attached, uncertain: claims.held, ...dispatched };
}
