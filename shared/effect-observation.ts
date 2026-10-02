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

/** The whole system prompt of a minimal (claude-code) observation run. The user prompt carries the task. */
export const EFFECT_OBSERVATION_SYSTEM_PROMPT = [
  "You are a read-only checker working for the Agentlas desktop app.",
  "Your answer is read by the app, not by a person.",
  "Only look: read files, list folders, search, or use the browser tools you are given to open or refresh pages.",
  "Never create, change, send, post, buy, delete or undo anything, and never retry the earlier action.",
  "Follow the check request exactly, including its final JSON or verdict marker response contract.",
].join(" ");

export type EffectObservationVerdict = "done" | "not_done" | "unknown";

export interface EffectObservationReport {
  verdict: EffectObservationVerdict;
  attemptIds: string[];
  evidence: string;
  /**
   * Optional exact text a reported target produced (automation steps that declare
   * `produces`). Only keys from the expected set are accepted; nothing is inferred.
   */
  outputs: Record<string, string>;
}

export type ParsedEffectObservation =
  | { status: "reported"; report: EffectObservationReport }
  | { status: "invalid"; reason: string }
  | { status: "absent" };

const MAX_EVIDENCE = 500;
const MAX_OUTPUT = 16_000;

/** Main binds the whole target set before dispatch. Constrained runtimes must return every target,
 * including unknown ones, rather than silently dropping an interrupted attempt from the verdict. */
export function effectObservationOutputSchema(attemptIds: readonly string[]): Record<string, unknown> {
  return {
    type: "object", additionalProperties: false,
    required: ["verdict", "attempts", "evidence", "summary"],
    properties: {
      verdict: { type: "string", enum: ["done", "not_done", "unknown"] },
      attempts: { type: "array", items: { type: "string", enum: [...attemptIds] },
        minItems: attemptIds.length, maxItems: attemptIds.length },
      evidence: { type: "string" },
      summary: { type: "string", description: "At most three sentences in the requested UI language about what you actually saw." },
    },
  };
}

/**
 * The marker line with presentation wrappers removed. Observers answering in a
 * chat persona (measured 2026-09-24: 7 of 7 looks came back as markdown with a
 * name prefix and a progress bar) put the line in backticks, bold, a list item
 * or a quote. Only leading/trailing markdown punctuation is removed - the body
 * must still start with the exact marker and parse as the strict JSON below.
 */
function markerLine(line: string): string | null {
  const unwrapped = line.trim()
    .replace(/^(?:[>*_`~\-]+[ \t]*)+/, "")
    .replace(/(?:[ \t]*[*_`~]+)+$/, "")
    .trim();
  return unwrapped.startsWith(EFFECT_OBSERVATION_MARKER) ? unwrapped : null;
}

function markerLines(text: string): string[] {
  return text.split("\n").map(markerLine).filter((line): line is string => line !== null);
}

/**
 * 표식 한 줄을 읽는다. 기대한 시도 목록과 **정확히 같은 집합**을 가리켜야 한다 — 일부만 보고
 * 전부 판정하거나, 모르는 시도를 끼워 넣은 보고는 무효다.
 */
export function parseEffectObservationMarker(text: string, expectedAttemptIds: readonly string[]): ParsedEffectObservation {
  // Native structured-output runtimes return the JSON document directly. The same exact-set
  // validation below still owns settlement; transport schema enforcement is never evidence.
  const structured = typeof text === "string" && !text.includes(EFFECT_OBSERVATION_MARKER) && text.trim().startsWith("{");
  if (typeof text !== "string" || (!structured && !text.includes(EFFECT_OBSERVATION_MARKER))) return { status: "absent" };
  const lines = structured ? [] : markerLines(text);
  if (!structured && lines.length !== 1) return { status: "invalid", reason: lines.length ? "effect_observation_ambiguous" : "effect_observation_not_on_own_line" };
  const body = structured ? text.trim() : lines[0].trim().slice(EFFECT_OBSERVATION_MARKER.length).trim();
  if (body.length > 64_000) return { status: "invalid", reason: "effect_observation_too_large" };
  let value: unknown;
  try { value = JSON.parse(body); } catch { return { status: "invalid", reason: "effect_observation_malformed" }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "invalid", reason: "effect_observation_malformed" };
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !["verdict", "attempts", "evidence", "outputs", "summary"].includes(key))) {
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
  const outputs: Record<string, string> = {};
  if (item.summary !== undefined && typeof item.summary !== "string") {
    return { status: "invalid", reason: "effect_observation_summary_invalid" };
  }
  if (item.outputs !== undefined) {
    if (!item.outputs || typeof item.outputs !== "object" || Array.isArray(item.outputs)) {
      return { status: "invalid", reason: "effect_observation_outputs_invalid" };
    }
    for (const [key, value] of Object.entries(item.outputs as Record<string, unknown>)) {
      if (!expected.includes(key) || typeof value !== "string" || !value.trim() || value.length > MAX_OUTPUT) {
        return { status: "invalid", reason: "effect_observation_outputs_invalid" };
      }
      outputs[key] = value;
    }
  }
  const evidence = typeof item.evidence === "string" ? item.evidence.replace(/\s+/g, " ").trim() : "";
  // 보았다고 말하려면 무엇을 보았는지 적어야 한다. 근거 없는 done/not_done 은 모름이다.
  if (item.verdict !== "unknown" && !evidence) return { status: "invalid", reason: "effect_observation_evidence_missing" };
  return { status: "reported", report: { verdict: item.verdict, attemptIds: expected, evidence: evidence.slice(0, MAX_EVIDENCE), outputs } };
}

/** 표식 줄을 본문에서 지운다. 표식이 없으면 원문 그대로. */
export function stripEffectObservationMarker(text: string): string {
  if (text?.trim().startsWith("{") && !text.includes(EFFECT_OBSERVATION_MARKER)) {
    try {
      const item = JSON.parse(text) as Record<string, unknown>;
      if (Array.isArray(item.attempts) && parseEffectObservationMarker(text, item.attempts).status === "reported") {
        return typeof item.summary === "string" ? item.summary.trim() : "";
      }
    } catch { /* Preserve unrelated JSON output. */ }
  }
  if (!text || !text.includes(EFFECT_OBSERVATION_MARKER)) return text;
  return text.split("\n")
    .filter((line) => markerLine(line) === null)
    .join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "");
}
