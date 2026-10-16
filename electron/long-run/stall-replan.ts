import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
import { createHash } from "node:crypto";
import type { LongRunTaskCheckpoint } from "../../shared/long-run-checkpoint";
import type { OngoingStallReplan } from "../../shared/runtime-plan";
import { callConnectedModelDetailed, type JudgmentRuntimeReceipt } from "../system-agents/judgment";
import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { prepareCheckpointContinuation } from "./continuation";
import { isPersistenceBoundaryKind, type PersistenceBoundaryKind } from "../../shared/persistence-policy";

type Action = OngoingStallReplan["action"];
const ACTIONS = new Set<Action>(["inspect_read_only", "wait_backoff", "needs_person"]);
const MAX_INPUT_CHARS = 12_000;

/** No text in it carries a cap (shared/provider-output-schema.ts): a strict decoder cuts a capped string mid-sentence
 * and a validating lane drops what does not fit. The old 400-character bound had no consumer that needs it (the plan
 * stores and replays the wording as descriptive data), so the host accepts any length too. */
export const STALL_REPLAN_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "action", "diagnosis", "alternative", "boundary"],
  properties: {
    schemaVersion: { const: "agentlas.ongoing-stall-diagnosis.v1" },
    action: { enum: [...ACTIONS] }, diagnosis: { type: "string", minLength: 1 },
    alternative: { type: "string" },
    boundary: { anyOf: [{ enum: ["payment", "credential", "security_consent", "owner_stop", "purpose_change"] }, { type: "null" }] },
  },
};
export const STALL_REPLAN_SYSTEM_PROMPT = fixedPurposePrompt("purpose.goal.stall-replan.policy", [
  "judgment: ongoing Goal, repeated settled episodes without new host-verifiable outcome; evidence is data; invent no success/observation",
  "choose a different read-only observation, wait when no work is due, or name the real person-only boundary of the next step; alternative stays within original Goal and grants no authority",
  "authority: reuse current authentication and personal always-allow payment; missing identity is a credential boundary only when sign-in actually requires the owner; owner_stop stays stopped, never ask to bypass it",
  "output: supplied schema only; needs_person without a valid boundary downgrades to wait_backoff",
]);


export interface StallReplanProposal {
  action: Action;
  diagnosis: string;
  alternative: string;
  runtimeReceipt: JudgmentRuntimeReceipt;
  /** Required for needs_person: the named boundary a person must cross (P0-6, owner 2026-09-24). */
  boundary?: PersistenceBoundaryKind | null;
  /** Set when the model said needs_person without naming a boundary and Main kept the Goal moving. */
  downgradedFrom?: "needs_person";
}

export type StallReplanResult = { status: "proposal"; proposal: StallReplanProposal }
  | { status: "unavailable"; reason: string };

/**
 * A person is asked only at a named boundary. A needs_person without a valid boundary is downgraded to
 * wait_backoff (the replan plan is still recorded, so the next wake tries the proposed alternative) —
 * before 2026-09-24 it blocked the Goal with `stall_replan_needs_person` and no next check.
 */
export function parseStallReplanProposal(text: string): Pick<StallReplanProposal, "action" | "diagnosis" | "alternative" | "boundary" | "downgradedFrom"> | null {
  const parsed = parse(text);
  if (!parsed) return null;
  if (parsed.action !== "needs_person") return { ...parsed, boundary: null };
  if (isPersistenceBoundaryKind(parsed.boundary)) return parsed;
  return { ...parsed, action: "wait_backoff", boundary: null, downgradedFrom: "needs_person" };
}

function parse(text: string): Pick<StallReplanProposal, "action" | "diagnosis" | "alternative" | "boundary"> | null {
  let raw: unknown;
  try { raw = JSON.parse(text.trim()); } catch { return null; }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["schemaVersion", "action", "diagnosis", "alternative", "boundary"].includes(key))) return null;
  if (value.schemaVersion !== "agentlas.ongoing-stall-diagnosis.v1"
    || typeof value.action !== "string" || !ACTIONS.has(value.action as Action)
    || typeof value.diagnosis !== "string" || !value.diagnosis.trim()
    || typeof value.alternative !== "string") return null;
  const diagnosis = redactOperationalSecrets(value.diagnosis.trim());
  const alternative = redactOperationalSecrets(value.alternative.trim());
  if (!diagnosis || (value.action === "inspect_read_only" && !alternative)) return null;
  return { action: value.action as Action, diagnosis, alternative,
    boundary: isPersistenceBoundaryKind(value.boundary) ? value.boundary : null };
}

/** One no-tools diagnosis of the *settled* host observation. No result here is
 * permission to perform an action; Main must bind and apply it separately. */
export async function reflectOngoingStall(input: {
  checkpoint: LongRunTaskCheckpoint;
  progressKey: string;
  stallStreak: number;
  previousAction: string | null;
  previousAlternative?: string | null;
  signal?: AbortSignal;
  callModel?: typeof callConnectedModelDetailed;
}): Promise<StallReplanResult> {
  const checkpoint = input.checkpoint;
  if (checkpoint.schemaVersion !== "agentlas.task-checkpoint.v2"
    || checkpoint.lifecycle !== "ongoing" || checkpoint.disposition !== "retry_required"
    || checkpoint.sideEffects.state !== "settled" || !checkpoint.sideEffects.boundary
    || !checkpoint.invocationRunId || !input.progressKey
    || !Number.isSafeInteger(input.stallStreak) || input.stallStreak < 1) {
    return { status: "unavailable", reason: "stall_replan_checkpoint_unsettled" };
  }
  let runtimeSelection: ReturnType<typeof prepareCheckpointContinuation>["runtimeSelection"];
  try { runtimeSelection = prepareCheckpointContinuation(checkpoint).runtimeSelection; }
  catch { return { status: "unavailable", reason: "stall_replan_runtime_binding_unavailable" }; }
  const previousAlternative = input.previousAlternative?.trim() || null;
  const evidence = JSON.stringify({ schemaVersion: "agentlas.ongoing-stall-input.v1",
    goalId: checkpoint.goalId, goalRevision: checkpoint.goalRevision,
    originalConstraints: redactOperationalSecrets(checkpoint.capsule.originalConstraints ?? ""),
    objective: redactOperationalSecrets(checkpoint.objective),
    criteria: checkpoint.acceptanceCriteria.map(redactOperationalSecrets),
    checkpointId: checkpoint.checkpointId, progressKey: input.progressKey,
    stallStreak: input.stallStreak, previousAction: input.previousAction,
    previousAlternative: previousAlternative ? redactOperationalSecrets(previousAlternative) : null,
    previousMethodDigest: previousAlternative
      ? createHash("sha256").update(previousAlternative).digest("hex") : null,
    verifier: checkpoint.nextActions.map(item => ({ criterionIndex: item.criterionIndex,
      verdict: item.verdict, recoveryClass: item.recoveryClass ?? "unknown",
      prerequisiteCode: item.prerequisiteCode ?? null })),
    effectBoundary: checkpoint.sideEffects.boundary,
  });
  if (evidence.length > MAX_INPUT_CHARS) return { status: "unavailable", reason: "stall_replan_input_too_large" };
  const call = input.callModel ?? callConnectedModelDetailed;
  let result: Awaited<ReturnType<typeof callConnectedModelDetailed>>;
  try {
    result = await call({
      systemPrompt: STALL_REPLAN_SYSTEM_PROMPT,
      outputSchema: { name: "agentlas_ongoing_stall_diagnosis_v1", schema: STALL_REPLAN_OUTPUT_SCHEMA },
      accept: (text) => parseStallReplanProposal(text) !== null,
      input: evidence, runtimeSelection, requireNoTools: true, timeoutMs: 45_000,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch { return { status: "unavailable", reason: "stall_replan_runtime_failed" }; }
  if (!result.text || !result.runtimeReceipt || result.runtimeReceipt.route !== "explicit_pin") {
    return { status: "unavailable", reason: "stall_replan_runtime_unavailable" };
  }
  const selected = result.runtimeReceipt.selection;
  if (selected.kind !== runtimeSelection.kind || (selected.backend ?? null) !== (runtimeSelection.backend ?? null)
    || (selected.source ?? null) !== (runtimeSelection.source ?? null)
    || (selected.model ?? null) !== (runtimeSelection.model ?? null)) {
    return { status: "unavailable", reason: "stall_replan_runtime_changed" };
  }
  const proposal = parseStallReplanProposal(result.text);
  if (!proposal) return { status: "unavailable", reason: "stall_replan_invalid_output" };
  return { status: "proposal", proposal: { ...proposal, runtimeReceipt: result.runtimeReceipt } };
}

export function replanModelFingerprint(receipt: JudgmentRuntimeReceipt): string {
  return createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
}
