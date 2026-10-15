import { fixedPurposePrompt, purposePrompt } from "../runtime/purpose-prompts";
// 그래프 인터뷰 — 사람의 한 문장에서 시작해, 만들 수 있을 만큼 알아낼 때까지 **되묻는다**.
//
// 이 모듈은 모델을 부르지 않는다. 프롬프트를 만들고, 돌아온 텍스트를 엄격하게 읽는 두 가지만 한다.
// 모델 호출은 표면(데스크탑·터미널·플러그인)이 주입한다 — 그래야 파서와 강제 규칙을
// 모델 없이 전부 시험할 수 있다.
//
// 강제하는 것(프롬프트 문구가 아니라 **코드**로):
//  · 청사진이 검증을 통과하지 못하면, 모델이 "다 됐다"고 해도 질문으로 되돌린다.
//  · 같은 질문을 두 번 하지 않는다(사람이 이미 답한 것을 또 묻는 인터뷰는 신뢰를 잃는다).
//  · 질문은 한 번에 3개까지. 한꺼번에 쏟으면 사람이 답을 포기한다.
import { CAPABILITIES, PROVIDER_CATALOG } from "../../shared/graph-tool-binding";
import {
  BLUEPRINT_SCHEMA,
  validateBlueprint,
  autofillOutputChecks,
  type BlueprintQuestion,
  type BlueprintTurn,
  type GraphBlueprint,
} from "../../shared/graph-blueprint";
import { currentUiLocale } from "../ui-locale";

const L = (ko: string, en: string): string => (currentUiLocale() === "ko" ? ko : en);

export const MAX_QUESTIONS_PER_TURN = 3;
/** 인터뷰가 끝나지 않고 도는 것을 막는다. 이만큼 물었는데도 안 되면 사람에게 사정을 말한다. */
export const MAX_INTERVIEW_ROUNDS = 6;

export interface InterviewAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface InterviewState {
  /** 이 순간 저장된 자동화들 — runGraph 단계가 고를 수 있는 유일한 대상(지어내기 방지). */
  knownGraphs?: Array<{ id: string; name: string }>;
  /** 사람이 처음 한 말. 인터뷰 내내 목적의 정본. */
  request: string;
  answers: InterviewAnswer[];
  /** 이미 물은 질문 id — 같은 것을 또 묻지 않는다. */
  asked: string[];
  round: number;
  /**
   * 지난 시도가 **왜** 지어지지 못했는가.
   *
   * ★이게 없으면 모델은 같은 실수를 반복하고, 우리는 사람에게 "조금 더 구체적으로
   * 적어 주세요"라고 떠넘기게 된다 — 무엇이 틀렸는지 아는 쪽은 우리인데.
   * 커널은 이미 같은 규율을 쓴다: 지난 실패를 다음 실행 지시에 붙인다(buildStrategyDirective).
   */
  attempts?: Array<{
    round: number;
    problems: string[];
    /**
     * 그 시도가 **얼마나 컸는가**. 다음 시도가 이보다 작아졌으면 모델이 문제를
     * "그 단계를 지워서" 고친 것이다 — 사람이 요구한 일이 조용히 사라진다.
     */
    stepCount?: number;
    /** 시작 방식. 바뀌었으면 사람이 말한 시작 조건이 뒤집힌 것이다. */
    triggerKind?: string;
  }>;
}

/**
 * 모델이 스스로 고쳐 볼 기회의 상한.
 *
 * 무한히 맡기지 않는 이유: 같은 자리에서 계속 막히면 그건 모델이 못 고치는 문제이고,
 * 계속 부르면 사람은 아무 설명 없이 기다리기만 한다. 상한에 닿으면 **무엇을 시도했는지와
 * 함께** 멈춘다.
 */
export const MAX_SELF_CORRECTIONS = 4;

export function startInterview(request: string): InterviewState {
  return { request: request.trim(), answers: [], asked: [], round: 0, attempts: [] };
}

const RULES = [
  "interview: non-developer; ask missing run time, external effect, actionable detail or repeat intent only; never expose graph ids/edges or ask keys/login/name/obvious order" ,
  "delegation: owner defers => decide and explain in goal; retain authorized outside effects and repeat/time intent; never impose read-only or new limits; unspecified time may use input trigger" ,
  "questions: concise choices, at most 3; no repeated ids; after 3 unanswered rounds choose a disclosed default within owner authority" ,
  "steps: actionable; roles describe worker kind in product language, roleEn English; exact math/parsing/dates use code (vars -> result), not agent arithmetic; actual saved graph/provider ids only" ,
  "proof: repeated/computed outside effects need atomic checks; mutation produces ids, later independent read reobserves into evidence; not observable => disclose; branch on check pass/fail, normal empty branches need no nonempty test" ,
  "output: supplied ASK|BLUEPRINT schema; product language for all visible text" ,
].join("\n");

/** 이번 턴에 모델에게 보낼 지시. 지금까지 알아낸 것을 전부 함께 준다. */
export function buildInterviewPrompt(state: InterviewState, locale: "ko" | "en" = "ko"): string {
  const known = state.answers.length
    ? state.answers.map((a) => `Q(${a.questionId}): ${a.question}\nA: ${a.answer}`).join("\n\n")
    : "(nothing yet)";
  const lines: string[] = [`What they have already told you:\n${known}`];
  if (state.asked.length) {
    lines.push("", `Question ids already asked (do not repeat): ${state.asked.join(", ")}`);
  }
  // ★산출 언어는 입력 언어가 아니라 **제품 설정**이 정한다(실측 항목 1·15: 영어 설정에서
  //   한국어 질문이 나와 화면 절반이 뒤섞였다).
  // ★부를 수 있는 자동화 목록을 **그 순간 실물로** 싣는다. 이것이 없으면 모델은
  //   id를 지어내고, 그 그래프는 실행 때 죽는다(에이전트 슬롯과 같은 규율).
  const graphCatalog = state.knownGraphs?.length
    ? ["Saved automations (kind:\"runGraph\", exact id):", ...state.knownGraphs.slice(0, 40).map(g => `  ${g.id} — ${g.name}`)].join("\n") : "";
  // ★지난 시도가 왜 지어지지 못했는지를 **모델 앞에 놓는다**. 커널이 지난 실패를 다음
  //   실행 지시에 붙이는 것과 같은 규율이다 — 없으면 같은 실수를 그대로 반복한다.
  const attempts = state.attempts ?? [];
  if (attempts.length) {
    lines.push(
      "",
      "Your previous blueprint could NOT be built; return a corrected blueprint fixing exactly these (format problems on your side, not missing information; do not ask the person):",
      "fixes are ADDITIVE: add the missing top-level checks[] entry each problem names; keep EVERY step, the trigger, every produces/consumes; more steps and checks, never fewer",
      ...attempts.flatMap((a) => a.problems.map((problem) => `  · ${problem}`)),
      "",
      // ★가장 위험한 '고치는 방법'을 미리 막는다. 검증 오류는 그 단계를 지우면 사라지지만,
      //   그러면 사람이 부탁한 일이 조용히 없어진 채로 검증을 통과한다.
      "DO NOT fix a problem by deleting the step it complains about, dropping the outside action the person asked for, or changing when it starts; unfixable => keep the step and return ask[]",
    );
    const last = attempts[attempts.length - 1];
    if (typeof last.stepCount === "number") {
      lines.push(
        `Your previous attempt had ${last.stepCount} step(s)`
        + (last.triggerKind ? ` and started from: ${last.triggerKind}` : "")
        + ". The corrected blueprint must keep at least that much.",
      );
    }
  }
  if (state.round >= MAX_INTERVIEW_ROUNDS - 1) {
    lines.push(
      "",
      "last round: ask only what makes it impossible to build; otherwise return the blueprint",
    );
  }
  // The saved-automation list is the owner's versioned inventory (changes when automations are saved or removed), so it
  // composes before the locale and the request (ledger desktop.workflow.graph-interview.user; Terminal interview.cjs same).
  return purposePrompt([
    { id: "purpose.graph.interview.policy", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], text: RULES },
    { id: "purpose.graph.interview.catalog", revision: 2, stability: "versioned-content", changeTriggers: ["capability-inventory"], text: graphCatalog },
    { id: "purpose.graph.interview.locale", revision: 1, stability: "configuration", changeTriggers: ["locale"], text: `PRODUCT LANGUAGE: ${locale === "ko" ? "Korean" : "English"}` },
    { id: "purpose.graph.interview.request", revision: 1, stability: "task-context", changeTriggers: ["owner-input", "task"], text: `What the person asked for:\n${state.request}` },
    { id: "purpose.graph.interview.answers-repair", revision: 1, stability: "turn-context", changeTriggers: ["owner-input", "checkpoint"], text: lines.join("\n") },
  ]);
}

export type InterviewParse =
  | { ok: true; turn: BlueprintTurn }
  | { ok: false; code: string; reason: string; nextAction: string };

function firstJsonObject(text: string): string | null {
  const trimmed = String(text ?? "").trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : trimmed;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * ★런타임이 JSON 대신 **사람에게 하는 말**을 돌려줬을 수 있다.
 *
 * 실측 2026-08-06: 모델이 `You've hit your weekly limit · resets Aug 8 at 6pm (Asia/Seoul)`을
 * 돌려줬는데, 제품은 그 문장을 삼키고 "만들 내용을 읽지 못했습니다 / 한 문장으로 다시
 * 적어 주세요"라고 말했다. 사람은 자기 문장이 틀린 줄 알고 몇 번이고 다시 쓴다 —
 * 아무리 잘 써도 안 된다. 무엇이 막혔는지 아는 쪽은 제품인데, 그것을 지우고 있었다.
 *
 * 짧고 JSON이 아니면 잘린 청사진이 아니라 **고지문**이다. 그대로 보여준다.
 */
const RUNTIME_NOTICE_MAX = 240;
const unreadable = (rawText?: string | null): InterviewParse => {
  const text = (rawText ?? "").trim();
  if (text.length > 0 && text.length <= RUNTIME_NOTICE_MAX && !text.includes("{")) {
    return {
      ok: false,
      // 재시도로 해결되지 않는다 — 형식 문제가 아니다.
      code: "INTERVIEW_MODEL_UNAVAILABLE",
      reason: L(`AI가 만들지 못했습니다 — ${text}`, `The AI could not build this — ${text}`),
      nextAction: L("다른 모델을 연결하거나, 안내에 적힌 시각 이후에 다시 시도해 주세요.", "Connect another model, or try again after the time given in the notice."),
    };
  }
  return {
    ok: false,
    code: "INTERVIEW_OUTPUT_UNREADABLE",
    reason: L("만들 내용을 읽지 못했습니다.", "Could not read what to build."),
    nextAction: L("자동으로 돌릴 일을 한 문장으로 다시 적어 주세요.", "Describe what to automate again in one sentence."),
  };
};

/**
 * 모델 출력을 읽는다. 형태가 어긋나면 거절한다.
 *
 * ★핵심: 모델이 blueprint를 냈더라도 **검증을 통과하지 못하면 질문으로 되돌린다.**
 * 이것이 "집요하게 묻는다"를 프롬프트 문구가 아니라 코드로 만드는 지점이다.
 */
/**
 * 다시 만든 청사진이 **앞 시도보다 작아졌는가**.
 *
 * ★프롬프트로 "지우지 마라"고 부탁하는 것만으로는 안 된다. 검증 오류는 그 단계를 지우면
 * 사라지고, **지워진 청사진은 검증을 통과한다**. 그러면 사람이 부탁한 일이 조용히 없어진
 * 채로 "다 만들었습니다"가 나간다 — 이 제품이 반복해서 겪은 결함의 형태 그대로다.
 *
 * 좁게 막는다: 문제가 "단계가 너무 많다"였을 때만 줄어드는 것이 정상이다.
 */
export function weakenedAgainstLastAttempt(
  blueprint: GraphBlueprint,
  state: InterviewState,
): string | null {
  const attempts = state.attempts ?? [];
  const last = attempts[attempts.length - 1];
  if (!last) return null;
  const steps = Array.isArray(blueprint.steps) ? blueprint.steps.length : 0;
  const complainedAboutSize = last.problems.some((p) => p.includes("단계가") && p.includes("개입니다"));
  if (typeof last.stepCount === "number" && steps < last.stepCount && !complainedAboutSize) {
    return `앞서 만든 것에는 단계가 ${last.stepCount}개였는데 이번에는 ${steps}개입니다.`
      + " 문제를 그 단계를 지워서 고치면, 부탁하신 일이 사라진 채로 만들어집니다.";
  }
  const trigger = blueprint.trigger?.kind;
  if (last.triggerKind && trigger && trigger !== last.triggerKind) {
    return `시작 방식이 "${last.triggerKind}"에서 "${trigger}"로 바뀌었습니다.`
      + " 언제 시작할지는 말씀하신 대로 두어야 합니다.";
  }
  return null;
}

export function parseInterviewTurn(text: string | null | undefined, state: InterviewState): InterviewParse {
  const raw = firstJsonObject(String(text ?? ""));
  if (!raw) return unreadable(text);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable(text);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable(text);
  const record = parsed as { ask?: unknown; blueprint?: unknown };

  if (Array.isArray(record.ask) && record.ask.length > 0) {
    const questions = normalizeQuestions(record.ask, state);
    if (!questions.length) {
      return {
        ok: false,
        code: "INTERVIEW_REPEATED_QUESTIONS",
        reason: L("이미 답하신 것만 다시 물으려 했습니다.", "It only tried to ask questions you already answered."),
        nextAction: L("다시 시도하거나, 만들 것을 조금 더 구체적으로 적어 주세요.", "Try again, or describe what to build a bit more specifically."),
      };
    }
    return { ok: true, turn: { kind: "ask", questions } };
  }

  const blueprint = record.blueprint as GraphBlueprint | undefined;
  if (!blueprint || typeof blueprint !== "object") return unreadable(text);
  // ★출력값 검증 check는 모델에 되물어 진동시키지 말고 **코드가 채운다** — 부탁받은 완전한
  //   그래프를 완성한다(깎지도 떠넘기지도 않음). 나머지 문제만 모델/사람에게 돌린다.
  const normalized: GraphBlueprint = autofillOutputChecks({ ...blueprint, schema: BLUEPRINT_SCHEMA });
  const problems = validateBlueprint(normalized);
  if (problems.length === 0) {
    // 검증은 통과했다. 그런데 **앞 시도보다 작아졌으면** 문제를 지워서 고친 것이다.
    const weakened = weakenedAgainstLastAttempt(normalized, state);
    if (weakened) return { ok: true, turn: { kind: "retry", problems: [weakened] } };
    return { ok: true, turn: { kind: "blueprint", blueprint: normalized } };
  }

  // 만들 수 없는 청사진이다. 물어서 채울 수 있는 것은 질문으로 돌려준다.
  const questions = normalizeQuestions(
    problems.map((p) => p.ask).filter((q): q is BlueprintQuestion => !!q),
    state,
  );
  if (questions.length) return { ok: true, turn: { kind: "ask", questions } };
  // 물어서 채울 수 없는 문제 — 사람이 답을 안 준 게 아니라 **모델이 형식을 틀린** 것이다.
  // 그걸 사람에게 "구체적으로 적어 주세요"로 떠넘기면 막다른 길이 된다: 무엇이 틀렸는지
  // 사람은 모르고, 우리는 안다. 무엇이 틀렸는지 돌려주고 스스로 고치게 한다.
  return {
    ok: true,
    turn: {
      kind: "retry",
      problems: problems.map((p) => p.reason),
      // 이번 시도가 얼마나 컸는지 함께 넘긴다 — 다음 시도가 이보다 작아지면 막는다.
      stepCount: Array.isArray(normalized.steps) ? normalized.steps.length : 0,
      ...(normalized.trigger?.kind ? { triggerKind: normalized.trigger.kind } : {}),
    },
  };
}

function normalizeQuestions(candidates: unknown[], state: InterviewState): BlueprintQuestion[] {
  const seen = new Set(state.asked);
  const out: BlueprintQuestion[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const q = candidate as Partial<BlueprintQuestion>;
    const question = typeof q.question === "string" ? q.question.trim() : "";
    if (!question) continue;
    const id = (typeof q.id === "string" && q.id.trim() ? q.id.trim() : question).slice(0, 80);
    // 같은 것을 또 묻지 않는다. 답한 것을 다시 묻는 인터뷰는 사람이 곧 그만둔다.
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      question: question.slice(0, 300),
      why: (typeof q.why === "string" ? q.why.trim() : "").slice(0, 300),
      ...(Array.isArray(q.choices)
        ? { choices: q.choices.filter((c): c is string => typeof c === "string").slice(0, 6) }
        : {}),
    });
    if (out.length >= MAX_QUESTIONS_PER_TURN) break;
  }
  return out;
}

/** 사람이 답한 것을 인터뷰 상태에 반영한다. */
export function recordAnswers(state: InterviewState, answers: InterviewAnswer[]): InterviewState {
  return {
    ...state,
    answers: [...state.answers, ...answers],
    asked: [...new Set([...state.asked, ...answers.map((a) => a.questionId)])],
    round: state.round + 1,
  };
}
