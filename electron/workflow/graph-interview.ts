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
export const MAX_SELF_CORRECTIONS = 2;

export function startInterview(request: string): InterviewState {
  return { request: request.trim(), answers: [], asked: [], round: 0, attempts: [] };
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
  "with examples when a choice is not obvious. Write every question, choice, name, goal, label,",
  "and note in the PRODUCT LANGUAGE stated at the end of this prompt — even when the person",
  "writes in another language. The person chose the product language in settings; drifting to",
  "the input language makes the product look broken. (Their own words quoted back are fine.)",
  "",
  "Return ONLY compact JSON, one of these two shapes:",
  '  {"ask":[{"id":"<stable-id>","question":"...","why":"...","choices":["...","..."]}]}',
  `  {"blueprint":{"schema":"${BLUEPRINT_SCHEMA}","name":"...","goal":"...","trigger":{...},"steps":[...],"branches":[...]}}`,
  "",
  "trigger is either {\"kind\":\"cron\",\"schedule\":\"daily-08:00\"} (24h, or a 5-field cron string)",
  "or {\"kind\":\"input\",\"label\":\"<what to ask the person>\",\"varName\":\"<one word, a-z>\"}.",
  "",
  "steps[] entries: {\"title\":\"...\",\"instruction\":\"...\",\"effect\":\"read\"|\"mutation\",",
  "  \"produces\":\"<one word>\",\"consumes\":[\"<one word>\"],\"role\":\"<kind of worker>\"}.",
  "  · instruction is what the agent is told. Write it so it can act with no further questions.",
  "  · role: what KIND of worker this step needs, in the person's language",
  "    (\"한국어 마케팅 글쓰기\", \"web game coding\", \"data analysis\"). Add it to every",
  "    agent/action step. Write the role, NEVER an agent name or id — the product searches",
  "    the real catalog and fills the slot itself. A name you invent does not exist and the",
  "    graph dies at run time. Steps that need the same kind of worker get the same role text.",
  "    Alongside role, add roleEn: the same role faithfully translated to English. The catalog",
  "    is English — searching with a non-English role buries the right worker (measured: the",
  "    same query ranked its target 1st in English and 144th in Korean).",
  "  · kind:\"code\" when the step is an EXACT computation or data-shaping that a chat model would",
  "    get quietly wrong: number math, currency/percent, parsing HTML/CSV/JSON, spreadsheet cells,",
  "    date arithmetic, calling a data library (e.g. yfinance). For those, add kind:\"code\", a short",
  "    codeLang (\"python\" default, or \"js\"), and code:\"<the script>\". The script gets the upstream",
  "    values as `vars` (a dict/object) and must set `result` to what the next step reads.",
  "    Read consumes[] the same way. YOU write the code — the person only describes what they want.",
  "    If the script imports anything outside the Python standard library, declare the pip names in",
  "    packages:[\"yfinance\"] on that step — the product installs them before the run. Prefer the",
  "    standard library when it can do the job; an undeclared import dies on the user's machine.",
  "  · kind:\"runGraph\" when the person wants an automation they ALREADY have to run as one",
  "    step of this one (\"then run my weekly report\"). Add graphRef:\"<id>\" chosen from the",
  "    list of saved automations at the end of this prompt — never invent an id, and never use",
  "    the name (names change, ids do not). If nothing in that list matches, do not guess:",
  "    write the work as ordinary steps instead.",
  "  · kind:\"agent\" (the default, omit it) for judgement, writing, summarizing, deciding — anything",
  "    where being approximately right is fine. Split a step: fetch+compute in a code step, then",
  "    judge/write in an agent step. Do not put exact math inside an agent instruction.",
  "  · a step that reads {{x}} must list x in consumes, and some earlier step (or the input trigger)",
  "    must declare produces:\"x\".",
  "  · effect:\"mutation\" for anything that leaves the machine or changes a file.",
  "  · approval:\"auto\" ONLY when the person explicitly said the step may go out without",
  "    their review (\"검토 없이\", \"바로 올려\", \"no review needed\"). Never lower it yourself,",
  "    never infer it from convenience. Omit the field otherwise — outward steps stay locked.",
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
  "checks[] (REQUIRED whenever a branch repeats, and whenever a step that changes things",
  "  outside sends out a value an earlier step computed — an unattended run must not ship",
  "  an empty or invented result):",
  "  {\"afterStep\":<0-based>,\"subject\":\"<a value some step produces>\",",
  "   \"criteria\":\"<one-line summary of what passing means>\",\"produces\":\"<one word>\",",
  "   \"items\":[{\"text\":\"<atomic, checkable>\",\"kind\":\"must\"|\"mustNot\"}]}",
  "  · A check is a SEPARATE step that judges the result against the criteria and produces",
  "    \"pass\" or \"fail\". A repeat must branch on that verdict — never on words inside the",
  "    result itself. A step that grades its own output is not a check.",
  "  · So: to repeat until good enough, add a check after the step, then branch on",
  "    {\"var\":\"<the check's produces>\",\"op\":\"eq\",\"value\":\"fail\",\"repeatOn\":\"yes\",...}.",
  "  · YOU propose the checklist (items): 2-5 \"must\" items (what must exist in the result)",
  "    plus 1-3 \"mustNot\" items (common failure modes for THIS task: invented numbers,",
  "    placeholder text, copying the input verbatim, missing the asked comparison...).",
  "    Write items that are atomic and checkable — 'The CSV has a numeric price column',",
  "    not 'The data looks good'. Vague items produce noisy judging.",
  "    The person will see and can edit every item before saving — propose, don't ask.",
  "  · A factual item (\"the price matches the real value\") cannot be judged from the result",
  "    alone — the judge would guess. Split it: add a read step BEFORE the check that re-fetches",
  "    the fact (kind:\"code\" or a read step with uses) into its own produces, then set the",
  "    check's evidence:\"<that name>\". The check then compares result against evidence.",
  "    Only ask when the goal itself is too vague to know what the result even is.",
  "  · repeatOn says which side loops. Write the condition the way the person said it and",
  "    put the loop on the side they meant — do not flip either one to make it fit.",
  "",
  "Ask at most 3 questions per turn. Never repeat a question id you already asked.",
  "",
  `capability must be one of: ${CAPABILITIES.join(", ")}`,
  `provider must be one of: ${PROVIDER_CATALOG.map((p) => p.id).join(", ")}`,
].join("\n");

/** 이번 턴에 모델에게 보낼 지시. 지금까지 알아낸 것을 전부 함께 준다. */
export function buildInterviewPrompt(state: InterviewState, locale: "ko" | "en" = "ko"): string {
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
  // ★산출 언어는 입력 언어가 아니라 **제품 설정**이 정한다(실측 항목 1·15: 영어 설정에서
  //   한국어 질문이 나와 화면 절반이 뒤섞였다).
  // ★부를 수 있는 자동화 목록을 **그 순간 실물로** 싣는다. 이것이 없으면 모델은
  //   id를 지어내고, 그 그래프는 실행 때 죽는다(에이전트 슬롯과 같은 규율).
  if (state.knownGraphs?.length) {
    lines.push(
      "",
      "Saved automations you may call with kind:\"runGraph\" (use the id exactly):",
      ...state.knownGraphs.slice(0, 40).map((g) => `  ${g.id} — ${g.name}`),
    );
  }
  lines.push("", `PRODUCT LANGUAGE: ${locale === "ko" ? "Korean" : "English"}. Every user-facing string you emit is in this language.`);
  // ★지난 시도가 왜 지어지지 못했는지를 **모델 앞에 놓는다**. 커널이 지난 실패를 다음
  //   실행 지시에 붙이는 것과 같은 규율이다 — 없으면 같은 실수를 그대로 반복한다.
  const attempts = state.attempts ?? [];
  if (attempts.length) {
    lines.push(
      "",
      "Your previous blueprint could NOT be built. Fix exactly these problems and return a",
      "corrected blueprint. Do not repeat the same mistake, and do not ask the person about it —",
      "these are format problems on your side, not missing information:",
      ...attempts.flatMap((a) => a.problems.map((problem) => `  · ${problem}`)),
      "",
      // ★가장 위험한 '고치는 방법'을 미리 막는다. 검증 오류는 그 단계를 지우면 사라지지만,
      //   그러면 사람이 부탁한 일이 조용히 없어진 채로 검증을 통과한다.
      "DO NOT fix a problem by deleting the step it complains about, by dropping the outside",
      "action the person asked for, or by changing when the automation starts. Keep everything",
      "the person asked for and fix only the format. If a problem seems unfixable, keep the",
      "step and return ask[] instead.",
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
