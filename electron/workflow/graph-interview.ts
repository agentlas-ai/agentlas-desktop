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
  type BlueprintQuestion,
  type BlueprintTurn,
  type GraphBlueprint,
} from "../../shared/graph-blueprint";

export const MAX_QUESTIONS_PER_TURN = 3;
/** 인터뷰가 끝나지 않고 도는 것을 막는다. 이만큼 물었는데도 안 되면 사람에게 사정을 말한다. */
export const MAX_INTERVIEW_ROUNDS = 6;

export interface InterviewAnswer {
  questionId: string;
  question: string;
  answer: string;
}

export interface InterviewState {
  /** 사람이 처음 한 말. 인터뷰 내내 목적의 정본. */
  request: string;
  answers: InterviewAnswer[];
  /** 이미 물은 질문 id — 같은 것을 또 묻지 않는다. */
  asked: string[];
  round: number;
}

export function startInterview(request: string): InterviewState {
  return { request: request.trim(), answers: [], asked: [], round: 0 };
}

const RULES = [
  "You are building an automation for someone who is not a developer. You will be asked to either",
  "ASK questions or produce a BLUEPRINT. Never produce raw graph JSON, node ids, or edges.",
  "",
  "Ask rather than assume. These must come from the person, never from you:",
  "  · when it runs (a time, or 'whenever I give it a value') — never invent a time;",
  "  · whether a step goes OUTSIDE (posting, emailing, saving a file, paying) — never downgrade to read;",
  "  · what exactly each step should do, in enough detail that an agent can act without asking back;",
  "  · how many times a repeat may run.",
  "Ask about what you genuinely cannot decide. Do not ask about things you can name yourself",
  "(a sensible automation name, a variable name, the order of obvious steps).",
  "",
  "If the person says they do not know, or asks you to decide (\"you pick\", \"알아서 해줘\",",
  "\"상관없어\", \"아무거나\"), DECIDE IT YOURSELF and move on. Never ask the same thing a third time.",
  "Deferring to you is not permission — it means take the most conservative option:",
  "  · goes outside? → read. Nothing leaves the machine unless they said yes in their own words.",
  "  · repeat limit? → 2, the smallest useful bound.",
  "  · run time? → there is no safe time to pick, so offer to make it input-triggered instead",
  "    (it then runs only when they start it) and build that if they still do not choose.",
  "Say what you decided for them in the goal sentence, so they can see it and change it.",
  "",
  "If an answer does not actually answer your question, do not repeat the question as-is —",
  "offer concrete choices instead. Never ask more than you need: prefer building with a sensible",
  "default over a fourth round of questions about the same thing.",
  "",
  "Write questions the way a helpful shop assistant would: short, concrete, one thing at a time,",
  "with examples when a choice is not obvious. Write them in the same language the person used.",
  "",
  "Return ONLY compact JSON, one of these two shapes:",
  '  {"ask":[{"id":"<stable-id>","question":"...","why":"...","choices":["...","..."]}]}',
  `  {"blueprint":{"schema":"${BLUEPRINT_SCHEMA}","name":"...","goal":"...","trigger":{...},"steps":[...],"branches":[...]}}`,
  "",
  "trigger is either {\"kind\":\"cron\",\"schedule\":\"daily-08:00\"} (24h, or a 5-field cron string)",
  "or {\"kind\":\"input\",\"label\":\"<what to ask the person>\",\"varName\":\"<one word, a-z>\"}.",
  "",
  "steps[] entries: {\"title\":\"...\",\"instruction\":\"...\",\"effect\":\"read\"|\"mutation\",",
  "  \"produces\":\"<one word>\",\"consumes\":[\"<one word>\"]}.",
  "  · instruction is what the agent is told. Write it so it can act with no further questions.",
  "  · a step that reads {{x}} must list x in consumes, and some earlier step (or the input trigger)",
  "    must declare produces:\"x\".",
  "  · effect:\"mutation\" for anything that leaves the machine or changes a file.",
  "  · uses: [{\"capability\":\"<from the list below>\",\"provider\":\"<id>\"|null}] — the outside",
  "    services this step needs. Pick the capability from the closed list; if the person named a",
  "    service, put its id in provider, otherwise leave provider null and it will be asked later.",
  "    A step that only writes text needs no `uses` at all.",
  "  · Never invent a capability or provider id. If what they want is not in the list, say so",
  "    in the step instruction and leave `uses` out rather than inventing one.",
  "  · Do NOT ask whether an account is already connected, and do not mention API keys, tokens,",
  "    logins, or authentication. The product checks connections itself and asks separately.",
  "    Ask only WHICH service, and only when it genuinely changes what gets built.",
  "",
  "branches[] entries (optional): {\"afterStep\":<0-based>,\"var\":\"<one word>\",",
  "  \"op\":\"contains|truthy|falsy|eq|ne|gt|lt\",\"value\":\"...\",",
  "  \"yesStep\":<index>,\"noStep\":<index>,",
  "  \"repeatStep\":<index>,\"repeatOn\":\"yes\"|\"no\",\"maxRepeats\":<1-20>}.",
  "  · repeatStep goes BACK to an earlier step. It REQUIRES repeatOn and maxRepeats.",
  "",
  "checks[] (optional, but REQUIRED whenever a branch repeats):",
  "  {\"afterStep\":<0-based>,\"subject\":\"<a value some step produces>\",",
  "   \"criteria\":\"<what makes it good enough, in the person's words>\",\"produces\":\"<one word>\"}",
  "  · A check is a SEPARATE step that judges the result against the criteria and produces",
  "    \"pass\" or \"fail\". A repeat must branch on that verdict — never on words inside the",
  "    result itself. A step that grades its own output is not a check.",
  "  · So: to repeat until good enough, add a check after the step, then branch on",
  "    {\"var\":\"<the check's produces>\",\"op\":\"eq\",\"value\":\"fail\",\"repeatOn\":\"yes\",...}.",
  "  · Ask the person what \"good enough\" means for them. Do not invent the criteria.",
  "  · repeatOn says which side loops. Write the condition the way the person said it and",
  "    put the loop on the side they meant — do not flip either one to make it fit.",
  "",
  "Ask at most 3 questions per turn. Never repeat a question id you already asked.",
  "",
  `capability must be one of: ${CAPABILITIES.join(", ")}`,
  `provider must be one of: ${PROVIDER_CATALOG.map((p) => p.id).join(", ")}`,
].join("\n");

/** 이번 턴에 모델에게 보낼 지시. 지금까지 알아낸 것을 전부 함께 준다. */
export function buildInterviewPrompt(state: InterviewState): string {
  const known = state.answers.length
    ? state.answers.map((a) => `Q(${a.questionId}): ${a.question}\nA: ${a.answer}`).join("\n\n")
    : "(nothing yet)";
  const lines = [
    RULES,
    "",
    `What the person asked for:\n${state.request}`,
    "",
    `What they have already told you:\n${known}`,
  ];
  if (state.asked.length) {
    lines.push("", `Question ids already asked (do not repeat): ${state.asked.join(", ")}`);
  }
  if (state.round >= MAX_INTERVIEW_ROUNDS - 1) {
    lines.push(
      "",
      "This is the last round. Ask only what makes the automation impossible to build without it;",
      "otherwise return the blueprint.",
    );
  }
  return lines.join("\n");
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

const unreadable = (): InterviewParse => ({
  ok: false,
  code: "INTERVIEW_OUTPUT_UNREADABLE",
  reason: "만들 내용을 읽지 못했습니다.",
  nextAction: "자동으로 돌릴 일을 한 문장으로 다시 적어 주세요.",
});

/**
 * 모델 출력을 읽는다. 형태가 어긋나면 거절한다.
 *
 * ★핵심: 모델이 blueprint를 냈더라도 **검증을 통과하지 못하면 질문으로 되돌린다.**
 * 이것이 "집요하게 묻는다"를 프롬프트 문구가 아니라 코드로 만드는 지점이다.
 */
export function parseInterviewTurn(text: string | null | undefined, state: InterviewState): InterviewParse {
  const raw = firstJsonObject(String(text ?? ""));
  if (!raw) return unreadable();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return unreadable();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return unreadable();
  const record = parsed as { ask?: unknown; blueprint?: unknown };

  if (Array.isArray(record.ask) && record.ask.length > 0) {
    const questions = normalizeQuestions(record.ask, state);
    if (!questions.length) {
      return {
        ok: false,
        code: "INTERVIEW_REPEATED_QUESTIONS",
        reason: "이미 답하신 것만 다시 물으려 했습니다.",
        nextAction: "다시 시도하거나, 만들 것을 조금 더 구체적으로 적어 주세요.",
      };
    }
    return { ok: true, turn: { kind: "ask", questions } };
  }

  const blueprint = record.blueprint as GraphBlueprint | undefined;
  if (!blueprint || typeof blueprint !== "object") return unreadable();
  const normalized: GraphBlueprint = { ...blueprint, schema: BLUEPRINT_SCHEMA };
  const problems = validateBlueprint(normalized);
  if (problems.length === 0) return { ok: true, turn: { kind: "blueprint", blueprint: normalized } };

  // 만들 수 없는 청사진이다. 물어서 채울 수 있는 것은 질문으로 돌려준다.
  const questions = normalizeQuestions(
    problems.map((p) => p.ask).filter((q): q is BlueprintQuestion => !!q),
    state,
  );
  if (questions.length) return { ok: true, turn: { kind: "ask", questions } };
  return {
    ok: false,
    code: "INTERVIEW_BLUEPRINT_INVALID",
    reason: problems.map((p) => p.reason).slice(0, 4).join(" "),
    nextAction: "조금 더 구체적으로 적어 주시면 다시 시도합니다.",
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
