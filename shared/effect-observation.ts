/**
 * 효과 관찰 표식 계약 — 오너 지시 2026-09-23.
 *
 * "게시됐는지 왜 모르지 브라우저 보면 알잖아… One이 직접 보면 알텐데 새로고침하던지 해서."
 *
 * 끊긴 시도가 바깥에 이미 무언가를 했는지(게시·전송·구매) 앱이 모를 때, 사람에게 묻기 전에
 * 읽기 전용 실행 한 번으로 **직접 가서 본다**. 그 실행의 판정은 산문을 읽어 추정하지 않는다 —
 * 모델이 답 끝에 내는 고정 표식 한 줄만 기계 신호다(권한 승격 표식과 같은 원칙).
 *
 *   <<agentlas-effect-observation>>{"verdict":"done","attempts":["…"],"evidence":"https://…"}
 *
 * 표식은 사람에게 보여줄 문장이 아니다 — 감지한 뒤 화면·저장 본문에서 지운다.
 * 표식이 없거나, 형식이 어긋나거나, 대상 시도 목록이 정확히 맞지 않으면 판정은 "모름"이고,
 * 모름은 오늘의 동작(사람의 한 문장 재개)으로 돌아간다. 모름을 재실행으로 바꾸는 길은 없다.
 *
 * 이 파일은 아무것도 import 하지 않는다 — electron 과 renderer 가 같은 한 벌을 쓴다.
 */

export const EFFECT_OBSERVATION_MARKER = "<<agentlas-effect-observation>>";

export type EffectObservationVerdict = "done" | "not_done" | "unknown";

export interface EffectObservationReport {
  verdict: EffectObservationVerdict;
  attemptIds: string[];
  evidence: string;
}

export type ParsedEffectObservation =
  | { status: "reported"; report: EffectObservationReport }
  | { status: "invalid"; reason: string }
  | { status: "absent" };

const MAX_EVIDENCE = 500;

function markerLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().startsWith(EFFECT_OBSERVATION_MARKER));
}

/**
 * 표식 한 줄을 읽는다. 기대한 시도 목록과 **정확히 같은 집합**을 가리켜야 한다 — 일부만 보고
 * 전부 판정하거나, 모르는 시도를 끼워 넣은 보고는 무효다.
 */
export function parseEffectObservationMarker(text: string, expectedAttemptIds: readonly string[]): ParsedEffectObservation {
  if (typeof text !== "string" || !text.includes(EFFECT_OBSERVATION_MARKER)) return { status: "absent" };
  const lines = markerLines(text);
  if (lines.length !== 1) return { status: "invalid", reason: lines.length ? "effect_observation_ambiguous" : "effect_observation_not_on_own_line" };
  const body = lines[0].trim().slice(EFFECT_OBSERVATION_MARKER.length).trim();
  if (body.length > 4096) return { status: "invalid", reason: "effect_observation_too_large" };
  let value: unknown;
  try { value = JSON.parse(body); } catch { return { status: "invalid", reason: "effect_observation_malformed" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", reason: "effect_observation_malformed" };
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["verdict", "attempts", "evidence"].includes(key))) {
    return { status: "invalid", reason: "effect_observation_unknown_field" };
  }
  if (item.verdict !== "done" && item.verdict !== "not_done" && item.verdict !== "unknown") {
    return { status: "invalid", reason: "effect_observation_verdict_invalid" };
  }
  if (!Array.isArray(item.attempts) || item.attempts.some((id) => typeof id !== "string" || !id)) {
    return { status: "invalid", reason: "effect_observation_attempts_invalid" };
  }
  const reported = [...new Set(item.attempts as string[])].sort();
  const expected = [...new Set(expectedAttemptIds)].sort();
  if (reported.length !== (item.attempts as string[]).length
    || JSON.stringify(reported) !== JSON.stringify(expected)) {
    return { status: "invalid", reason: "effect_observation_attempts_mismatch" };
  }
  const evidence = typeof item.evidence === "string" ? item.evidence.replace(/\s+/g, " ").trim() : "";
  // 보았다고 말하려면 무엇을 보았는지 적어야 한다. 근거 없는 done/not_done 은 모름이다.
  if (item.verdict !== "unknown" && !evidence) return { status: "invalid", reason: "effect_observation_evidence_missing" };
  return { status: "reported", report: { verdict: item.verdict, attemptIds: expected, evidence: evidence.slice(0, MAX_EVIDENCE) } };
}

/** 표식 줄을 본문에서 지운다. 표식이 없으면 원문 그대로. */
export function stripEffectObservationMarker(text: string): string {
  if (!text || !text.includes(EFFECT_OBSERVATION_MARKER)) return text;
  return text.split("\n")
    .filter((line) => !line.trim().startsWith(EFFECT_OBSERVATION_MARKER))
    .join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}
