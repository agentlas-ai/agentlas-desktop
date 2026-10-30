import type { McpInvocationEvent, RuntimeSelection, RuntimeStatus } from "../../shared/types";

/*
 * The effort the owner picked for ONE request, and the plain sentence for a run that could not honour it.
 *
 * A runtime that does not offer the picked level is not an error the owner can fix, so the run still goes: the shared
 * resolver (selection.ts effortForSelectedModel) and the adapters (Codex, Anthropic API, ACP agents, the local loop,
 * Agentlas serving) apply the nearest level they have, or none. What used to be missing is the owner hearing about it:
 * the applied level only reached the receipts and the usage panel, so a person who picked "high" saw an answer and
 * could not tell it was produced at "low". This module decides when that is worth saying; client.ts says it, once at
 * the start (what selection resolved) and once more at the end only if the runner finally applied something else.
 *
 * Only an effort picked for this request counts: the owner's own turn, or the room chip that governs it. A level the
 * runtime carried as its own default, a Goal or automation turn, a fast turn (which asks for the lowest level on purpose)
 * and a run that moved to another runtime or model are not "the effort the owner picked" and say nothing.
 */

export interface OwnerPickedEffort {
  effort: string;
  kind: RuntimeSelection["kind"];
  model: string | null;
  acpAgentId: string | null;
}

export interface EffortDeviation { requested: string; ran: string | null }

const level = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim().toLowerCase() : null;

/** The pick this request carries, or null when the owner picked no effort or this is not the owner's own request. */
export function ownerPickedEffort(selection: Pick<RuntimeSelection, "kind" | "model" | "effort" | "acpAgentId"> | null | undefined, ownerTurn: boolean): OwnerPickedEffort | null {
  const effort = level(selection?.effort);
  if (!ownerTurn || !selection || !effort) return null;
  return { effort, kind: selection.kind, model: selection.model?.trim() || null, acpAgentId: selection.acpAgentId ?? null };
}

/** The pick still governs the runtime that runs: same engine, same model when the pick named one, same seat for an open ACP agent. */
function pickGoverns(picked: OwnerPickedEffort, runtime: Pick<RuntimeStatus, "kind" | "model" | "acpAgentId">): boolean {
  return runtime.kind === picked.kind
    && (picked.model === null || runtime.model === picked.model)
    && (picked.kind !== "acp" || (runtime.acpAgentId ?? null) === picked.acpAgentId);
}

/**
 * Did the run use something other than the picked effort? `ran` is what the run used: the level selection resolved at the
 * start, or the level the runner reports it applied (null = none sent, the runtime's own default).
 */
export function effortDeviation(input: {
  picked: OwnerPickedEffort | null;
  runtime: Pick<RuntimeStatus, "kind" | "model" | "acpAgentId">;
  ran: string | null | undefined;
}): EffortDeviation | null {
  const { picked, runtime } = input;
  if (!picked || !pickGoverns(picked, runtime)) return null;
  const ran = level(input.ran);
  return ran === picked.effort ? null : { requested: picked.effort, ran };
}

/**
 * The visible sentence, in the run's language and, for a screen set to the other one (the phone), in both. `label` is the engine
 * and model the run used, as the runtime-selected notice names it.
 */
export function effortDeviationNotice(deviation: EffortDeviation, label: string, locale: "ko" | "en"): NonNullable<McpInvocationEvent["notice"]> & { i18n: { ko: string; en: string } } {
  const i18n = {
    ko: `작업량 "${deviation.requested}" 요청을 ${label}에서 적용하지 못했습니다. 이 실행의 작업량: ${deviation.ran ? `"${deviation.ran}"` : "기본값"}`,
    en: `Effort "${deviation.requested}" could not be applied on ${label}. This run used ${deviation.ran ? `"${deviation.ran}"` : "the default effort"}.`,
  };
  return { level: "warning", code: "effort-not-honored", message: i18n[locale], i18n, details: JSON.stringify({ schemaVersion: 1, requested: deviation.requested, ran: deviation.ran }) };
}
