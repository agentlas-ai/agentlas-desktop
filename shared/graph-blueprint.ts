// 그래프 청사진 — 자연어로 자동화를 만들 때 **모델이 말하는 유일한 형태**.
//
// 설계의 핵심 한 줄: **모델은 청사진만 말하고, 그래프는 코드가 짓는다.**
// 모델이 노드 id와 연결을 직접 쓰게 두면, 실사용에서 사람이 겪은 결함이 그대로 재발한다
// (참/거짓 미선언 연결 → 두 분기 동시 실행 · 아무도 안 잇는 고아 노드 ·
//  상한 없는 반복 · 아무도 만들지 않는 값 참조). 여기서는 그 형태를 만들 수 없게 한다.
//
// 두 번째 규칙: **모르면 지어내지 말고 묻는다.** 실행 시각을 안 정했으면 시각을 지어내지 않고,
// 바깥을 바꾸는 단계인지 모르면 읽기로 낮추지 않는다. 자동화는 사람이 없는 동안 돌기 때문에
// "그럴듯한 기본값"이 그대로 실행된다.
import type { WorkflowGraph, WorkflowNode, WorkflowEdge } from "./types";
import { layoutGraph, needsLayout } from "./graph-layout";
import { CAPABILITIES, CAPABILITY_LABEL, findProvider, providersFor } from "./graph-tool-binding";
import { humanizeScheduleLabel } from "./schedule-describe";

export const BLUEPRINT_SCHEMA = "agentlas.graph-blueprint.v1";

export type BlueprintEffect = "read" | "mutation";

export interface BlueprintStep {
  /** 사람이 읽을 단계 이름. 화면과 실행 기록에 그대로 쓰인다. */
  title: string;
  /** 이 단계가 할 일을 사람 말로. 에이전트에게 그대로 전달된다. */
  instruction: string;
  /** 이 단계가 만들어 내는 값의 이름(다음 단계가 {{이름}}으로 읽는다). */
  produces?: string;
  /** 이 단계가 읽어 쓰는 값의 이름들. */
  consumes?: string[];
  /** 바깥을 바꾸는가. 모르면 청사진을 받지 않는다 — 아래 validate 참조. */
  effect: BlueprintEffect;
  /**
   * 이 단계가 **무엇을 가지고** 일하는가. 사람 말이 아니라 닫힌 어휘(CAPABILITIES)로 적는다.
   *
   * 실사용 실측: "캘린더요"라는 답에서 `title: "캘린더에서 일정 가져오기"`만 저장됐고,
   * 연결이 없다는 사실이 어디에도 없어 켜졌고, 실행하고서야 죽었다.
   * provider를 아직 안 정했으면 null로 둔다 — **그래도 저장은 된다**(create-then-gate).
   */
  uses?: Array<{ capability: string; provider?: string | null }>;
  /**
   * 이 단계를 **무엇으로** 실행하는가. 안 적으면 "agent"(말로 시킴).
   * - "agent": 판단·글쓰기 — 런타임(Claude 등)에 프롬프트로 넘긴다.
   * - "code": **정확한 계산·데이터 가공** — AI가 짠 스크립트를 격리 실행한다.
   *   숫자 계산·엑셀·파싱은 말로 시키면 조용히 틀리므로 이쪽으로 온다.
   *   ★경계는 사람이 아니라 AI가 스텝마다 고른다(인터뷰 프롬프트가 가르친다).
   */
  kind?: "agent" | "code" | "runGraph";
  /**
   * kind가 "runGraph"일 때 부를 자동화의 **id**(이름 아님 — 이름은 바뀐다).
   * ★모델이 지어낼 수 없다: 인터뷰 지시문이 그 순간 실제로 저장된 목록만 보여 주고,
   *   목록에 없는 id는 검증에서 거절된다. 지어낸 id는 실행에서 죽는다.
   */
  graphRef?: string;
  /** kind가 "code"일 때 실제 스크립트. AI가 채운다. */
  code?: string;
  /** 코드 언어. 기본 python(번들 인터프리터·데이터 라이브러리). */
  codeLang?: "python" | "js";
  /** 코드가 쓰는 서드파티 pip 이름들 — 커널이 실행 전에 설치한다. 표준 라이브러리는 선언 불필요. */
  packages?: string[];
  /**
   * 이 단계를 **어떤 성격의 일꾼**이 해야 하는가 — 사람 말로 적는다("한국어 마케팅 글쓰기").
   * ★모델은 **역할만** 말하고 실제 에이전트는 코드가 Hub에서 검색해 꽂는다. 모델이
   *   에이전트 이름(slug)을 직접 쓰면 없는 것을 지어내 실행 때 죽는다 — 이 제품이
   *   그래프 전체에서 지키는 규율("모델은 청사진만, 실물은 코드가")과 같은 이유다.
   */
  role?: string;
  /** role의 영어 번역 — 카탈로그가 영어라 검색은 이걸로 한다(다국어 라우팅 실측). */
  roleEn?: string;
  /**
   * (구) 바깥으로 나가기 전에 사람 확인을 받을지.
   * ★승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 커널은 실행 중에 멈춰 묻지 않고,
   *   컴파일러도 이 선언을 그래프에 싣지 않는다. 칸 자체는 옛 청사진(모델 출력 캐시 포함)이
   *   이 필드를 들고 올 수 있어 파싱 호환용으로만 남긴다. 바깥으로 나가는 단계라는 사실은
   *   저장 전 확인 화면이 "바깥으로 나감, 확인 없이 바로"로 알린다.
   */
  approval?: "ask" | "auto";
}

export interface BlueprintBranch {
  /** 이 단계 **뒤에** 갈림길을 놓는다. */
  afterStep: number;
  /** 사람에게 보여줄 갈림길 이름. 실제 규칙과 다르면 안 되므로 규칙에서 만든다. */
  var: string;
  op: (typeof CONDITION_OPS)[number];
  value?: string | number;
  /** 참일 때 갈 단계 번호(없으면 여기서 끝). */
  yesStep?: number;
  /** 거짓일 때 갈 단계 번호(없으면 여기서 끝). */
  noStep?: number;
  /** 앞 단계로 되돌아가 반복한다면 그 단계 번호. */
  repeatStep?: number;
  /**
   * 어느 쪽으로 갈 때 되돌아가는가. **선언이 필요하다.**
   * 예전엔 "거짓일 때만" 되돌아갈 수 있었다. 그래서 "'다시'라고 하면 다시 쓴다"를
   * 표현하려면 조건이나 방향 중 하나를 뒤집어야만 했고, 실제로 만들어진 갈림길이
   * 전부 거꾸로였다(실사용 실측 3/3). 되돌아가는 쪽을 사람이 말한 그대로 적게 한다.
   */
  repeatOn?: "yes" | "no";
  /** 반복 상한. repeatStep이 있으면 반드시 있어야 한다. */
  maxRepeats?: number;
}

export interface BlueprintCheck {
  /** 이 단계 **뒤에** 검증을 놓는다. */
  afterStep: number;
  /** 무엇을 볼 것인가 — 앞 단계가 만든 값의 이름. */
  subject: string;
  /** 통과 기준 한 문장(하위호환). items 가 있으면 항목별 판정이 우선한다. */
  criteria: string;
  /**
   * 채점표 — 항목별 yes/no. must = 있어야 한다(빠뜨림 방지),
   * mustNot = 하면 안 된다(판정자의 후한 버릇·꼼수 통과 방지).
   * 내용은 AI가 그 그래프를 보고 쓴다 — 코드에 분야 목록은 없다.
   */
  items?: Array<{ text: string; kind: "must" | "mustNot" }>;
  /** 판정 결과를 담을 이름(기본: check<N>_verdict). */
  produces?: string;
  /**
   * 판정 근거가 담긴 값의 이름 — 재조회 스텝이 만든 것. 사실 확인형 검증
   * ("값이 실제와 일치하나")은 대상만 보고 판정할 수 없어 이 근거와 대조한다.
   */
  evidence?: string;
}

export type BlueprintTrigger =
  | { kind: "cron"; schedule: string }
  | { kind: "input"; label: string; varName: string };

export interface GraphBlueprint {
  schema: typeof BLUEPRINT_SCHEMA;
  name: string;
  /** 이 자동화가 무엇을 위한 것인지 한 문장. 사람이 나중에 읽고 알아볼 근거. */
  goal: string;
  trigger: BlueprintTrigger;
  steps: BlueprintStep[];
  branches?: BlueprintBranch[];
  /**
   * 검증 단계. 만든 것을 **다른 노드가** 기준으로 판정한다.
   * 반복(repeatStep)이 있으면 반드시 있어야 한다 — 없으면 "마음에 들 때까지"를
   * 글자 찾기로 흉내 내게 되고, 그건 이 제품이 다른 곳에서 걷어낸 단어장 판정이다.
   */
  checks?: BlueprintCheck[];
}

export interface BlueprintQuestion {
  /** 같은 질문을 두 번 하지 않기 위한 식별자. */
  id: string;
  /** 사람에게 물을 말. */
  question: string;
  /** 왜 묻는지 — 답을 안 주면 무엇이 잘못될 수 있는지. */
  why: string;
  /** 고르기 쉽게 보여줄 보기(선택). */
  choices?: string[];
}

export type BlueprintTurn =
  | { kind: "ask"; questions: BlueprintQuestion[] }
  | { kind: "blueprint"; blueprint: GraphBlueprint }
  /**
   * 모델이 형식을 틀렸다 — 사람이 답을 안 준 게 아니다.
   * 무엇이 틀렸는지 돌려주고 **스스로 고치게** 한다. 사람에게 "구체적으로 적어 주세요"로
   * 떠넘기면 막다른 길이 된다: 무엇이 틀렸는지 사람은 모르고, 우리는 안다.
   */
  | {
      kind: "retry";
      problems: string[];
      /** 이번 시도가 얼마나 컸는가 — 다음 시도가 이보다 작아지면 막는다. */
      stepCount?: number;
      triggerKind?: string;
    };

export interface BlueprintProblem {
  /** 이 문제를 풀려면 사람에게 물어야 하는가. */
  ask: BlueprintQuestion | null;
  reason: string;
}

/**
 * 갈림길이 쓸 수 있는 판단 방법. **커널이 실제로 실행할 수 있는 것과 같아야 한다.**
 * 예전엔 여기에 "neq"가 있었는데 커널은 "ne"만 실행했다 — 제품이 자기가 만들어 놓고
 * 자기가 못 읽는 자동화를 저장했고, 사람은 마지막 단계에서야 알았다(실사용 실측).
 * scripts/test-graph-interview-contract.cjs 가 커널 소스와 이 목록을 대조한다.
 */
export const CONDITION_OPS = ["truthy", "falsy", "eq", "ne", "gt", "lt", "contains"] as const;
const OPS = new Set<string>(CONDITION_OPS);
const VALUE_OPS = new Set(["contains", "eq", "ne", "gt", "lt"]);
const MAX_STEPS = 20;
export const MAX_REPEATS = 20;

const VAR_RE = /^[A-Za-z_][\w-]*$/;

/**
 * capability를 사람 말로. 어휘의 집은 graph-tool-binding이라 거기서 온다 —
 * 질문 보기와 연결 창이 **같은 한 벌**을 써야 두 화면의 말이 갈라지지 않는다.
 */
export { CAPABILITY_LABEL } from "./graph-tool-binding";

const CAPABILITY_CHOICES: string[] = CAPABILITIES.map((id) => CAPABILITY_LABEL[id] ?? id);

/**
 * ★바깥으로 나가는 단계가 소비하는 '앞에서 만든 값'에 검증 check가 없으면 **코드가 채운다**.
 *
 * 검증기는 어떤 check가 필요한지(어느 단계 뒤·무슨 값)를 이미 정확히 안다. 그걸 모델에게
 * 되물어 진동시키는 대신 여기서 표준 check를 넣어 **부탁받은 완전한 그래프를 완성한다.**
 * 단계를 깎지도(전부 유지), 캔버스로 떠넘기지도 않는다 — 빠진 건 검증 단계 하나뿐이고,
 * 그건 사람이 정할 게 아니라 코드가 채울 수 있는 기계적 산물이다. 사람은 저장 확인 화면에서
 * 이 항목을 보고 고칠 수 있다(propose, not ask). 이것이 "대충 던지고 네가 업글해"의 반대다.
 */
export function autofillOutputChecks(bp: GraphBlueprint): GraphBlueprint {
  if (!bp || !Array.isArray(bp.steps)) return bp;
  const checks: BlueprintCheck[] = Array.isArray(bp.checks) ? [...bp.checks] : [];
  const checked = new Set(checks.map((c) => (c.subject ?? "").trim()).filter(Boolean));
  bp.steps.forEach((step, index) => {
    if (step.effect !== "mutation") return;
    for (const value of Array.isArray(step.consumes) ? step.consumes : []) {
      const name = String(value ?? "").trim();
      if (!name || checked.has(name)) continue;
      const madeAt = bp.steps.findIndex((s, i) => i < index && (s.produces ?? "").trim() === name);
      if (madeAt < 0) continue;
      checks.push({
        afterStep: madeAt,
        subject: name,
        criteria: `${name}이(가) 비어있지 않고 요청대로 채워졌다`,
        produces: `${name}_ok`,
        items: [
          { text: `${name}이(가) 실제 내용으로 채워졌다`, kind: "must" },
          { text: "빈 값·자리표시자·지어낸 값이 아니다", kind: "mustNot" },
        ],
      });
      checked.add(name);
    }
  });
  return { ...bp, checks };
}

/**
 * 청사진이 실제로 그래프로 지어질 수 있는지 검사한다.
 * **여기서 통과시킨 것만 그래프가 된다.** 모자란 곳은 "기본값"이 아니라 질문으로 돌려준다 —
 * 자동화는 사람이 보지 않을 때 도는 것이라, 지어낸 값이 그대로 실행된다.
 */
/**
 * 이 순간 실제로 저장돼 있는 자동화들 — `runGraph` 단계가 가리킬 수 있는 유일한 대상.
 * 비워 두면 그 검사를 건너뛴다(목록을 모르는 호출부까지 막지 않는다).
 */
export interface BlueprintContext {
  knownGraphs?: Array<{ id: string; name: string }>;
  /** 지금 고치고 있는 자동화 — 자기를 부르면 무한 재귀다. */
  selfId?: string;
}

export function validateBlueprint(
  bp: GraphBlueprint | null | undefined,
  ctx: BlueprintContext = {},
): BlueprintProblem[] {
  const problems: BlueprintProblem[] = [];
  const push = (reason: string, ask: BlueprintQuestion | null = null): void => {
    problems.push({ reason, ask });
  };
  if (!bp || typeof bp !== "object") {
    push("만들 내용을 읽지 못했습니다.");
    return problems;
  }
  if (!bp.name?.trim()) {
    push("이름이 없습니다.", {
      id: "name",
      question: "이 자동화를 뭐라고 부를까요?",
      why: "목록에서 이 이름으로 찾게 됩니다.",
    });
  }
  if (!bp.goal?.trim()) {
    push("무엇을 위한 자동화인지가 없습니다.", {
      id: "goal",
      question: "이 자동화로 무엇을 얻고 싶으신가요? 한 문장이면 됩니다.",
      why: "나중에 목록에서 보고 무엇이었는지 알아보려면 필요합니다.",
    });
  }

  // 시작 방식 — 지어내지 않는다.
  const trigger = bp.trigger;
  if (!trigger || typeof trigger !== "object") {
    push("언제 시작하는지가 없습니다.", triggerQuestion());
  } else if (trigger.kind === "cron") {
    if (!trigger.schedule?.trim()) {
      push("실행 시각이 없습니다.", {
        id: "schedule",
        question: "몇 시에 돌릴까요?",
        why: "시각을 대신 정하면, 보지 않는 시간에 조용히 돌게 됩니다.",
        choices: ["매일 아침 8시", "매일 저녁 9시", "평일 아침 9시", "매주 월요일 아침 9시"],
      });
    }
  } else if (trigger.kind === "input") {
    if (!trigger.label?.trim()) {
      push("무엇을 입력받는지가 없습니다.", {
        id: "input-label",
        question: "시작할 때 무엇을 입력받을까요? (예: 만들 프로젝트의 주제)",
        why: "입력창에 이 문구가 그대로 보입니다.",
      });
    }
    if (!trigger.varName?.trim() || !VAR_RE.test(trigger.varName)) {
      push("입력값의 이름이 올바르지 않습니다.");
    }
  } else {
    push("언제 시작하는지를 알 수 없습니다.", triggerQuestion());
  }

  // 단계
  const steps = Array.isArray(bp.steps) ? bp.steps : [];
  if (steps.length === 0) {
    push("할 일이 하나도 없습니다.", {
      id: "steps",
      question: "무슨 일을 해야 하나요? 순서대로 적어 주세요.",
      why: "단계가 없으면 만들 수 있는 것이 없습니다.",
    });
  }
  if (steps.length > MAX_STEPS) {
    push(`단계가 ${steps.length}개입니다. 한 번에 만들 수 있는 것은 ${MAX_STEPS}개까지입니다.`);
  }
  const produced = new Set<string>();
  if (trigger?.kind === "input" && trigger.varName) produced.add(trigger.varName);
  steps.forEach((step, index) => {
    const at = `${index + 1}번째 단계`;
    if (!step || typeof step !== "object") { push(`${at}를 읽지 못했습니다.`); return; }
    if (!step.title?.trim()) push(`${at}에 이름이 없습니다.`);
    if (!step.instruction?.trim()) {
      push(`${at}가 무엇을 할지 적혀 있지 않습니다.`, {
        id: `step-${index}-instruction`,
        question: `"${step.title || at}" 단계에서 정확히 무엇을 해야 하나요?`,
        why: "지시가 비면 에이전트가 되물어 오고, 자동화는 아무것도 하지 못합니다.",
      });
    }
    if (step.effect !== "read" && step.effect !== "mutation") {
      // ★"모르면 읽기"로 낮추지 않는다. 바깥을 바꾸는 단계를 읽기로 적으면
      //   승인 브레이크가 걸리지 않은 채 실행된다.
      push(`${at}가 바깥을 바꾸는지 정해지지 않았습니다.`, {
        id: `step-${index}-effect`,
        question: `"${step.title || at}"은(는) 바깥으로 나가는 일(글 게시, 메일 발송, 파일 저장, 결제)을 하나요?`,
        why: "바깥을 바꾸는 단계는 실행 전에 확인받도록 잠가 둡니다.",
        choices: ["아니요, 만들기만 합니다", "네, 바깥으로 나갑니다"],
      });
    }
    // ★코드 스텝은 스크립트가 있어야 한다. 없으면 "코드로 하겠다"고 해 놓고 빈 채로 저장돼
    //   실행에서 CODE_NODE_EMPTY로 죽는다(저작 시점에 막는 게 맞다).
    if (step.kind === "runGraph") {
      /*
       * ★부를 자동화는 **실재해야 한다.** 이름이 아니라 id로 가리키는 이유도 같다 —
       * 이름은 바뀌고, 지어낸 id는 실행에서 죽는다(그때는 이미 저장된 뒤다).
       * 목록을 모르는 호출부에서는 이 검사를 건너뛴다(형식만 본다).
       */
      const ref = step.graphRef?.trim();
      if (!ref) {
        push(`${at}가 어느 자동화를 부를지 정하지 않았습니다.`);
      } else if (ctx.selfId && ref === ctx.selfId) {
        push(`${at}가 자기 자신을 부릅니다 — 끝나지 않습니다.`);
      } else if (ctx.knownGraphs?.length && !ctx.knownGraphs.some((g) => g.id === ref)) {
        push(`${at}가 부르려는 자동화("${ref}")가 없습니다. 저장된 자동화 중에서 골라야 합니다.`);
      }
    }
    if (step.kind === "code") {
      if (!step.code?.trim()) {
        push(`${at}는 코드로 실행한다고 했는데 스크립트가 비어 있습니다.`, {
          id: `step-${index}-code`,
          question: `"${step.title || at}" 단계에서 무엇을 계산·가공하나요? (AI가 스크립트를 채웁니다)`,
          why: "코드 단계는 스크립트가 없으면 실행되지 않습니다.",
        });
      }
      if (step.codeLang && step.codeLang !== "python" && step.codeLang !== "js") {
        push(`${at}의 코드 언어 "${step.codeLang}"을(를) 이 제품이 모릅니다(python 또는 js).`);
      }
    }
    for (const name of step.consumes ?? []) {
      if (!produced.has(name)) {
        push(`${at}가 쓰는 "${name}" 값을 아무도 만들지 않습니다.`, {
          id: `step-${index}-consumes-${name}`,
          question: `"${step.title || at}" 단계가 쓰는 "${name}"은(는) 어디서 오나요?`,
          why: "만들어 주는 단계가 없으면 그 자리가 빈 채로 실행됩니다.",
        });
      }
    }

    // 도구 요구 — 닫힌 어휘로만. 사람 말은 여기 못 들어온다.
    for (const use of step.uses ?? []) {
      if (!use || typeof use !== "object") { push(`${at}의 도구 선언을 읽지 못했습니다.`); continue; }
      if (!CAPABILITIES.includes(use.capability)) {
        push(`${at}가 이 제품이 모르는 도구("${use.capability}")를 쓰려고 합니다.`, {
          id: `step-${index}-capability`,
          question: `"${step.title || at}" 단계는 어떤 서비스를 씁니까?`,
          why: "이 제품이 다룰 수 있는 것으로 골라야 실제로 연결할 수 있습니다.",
          choices: CAPABILITY_CHOICES,
        });
        continue;
      }
      // 공급자 미정은 **막지 않는다**(업계 합의: create-then-gate). 다만 사람에게 묻는다 —
      // "캘린더"는 여럿이고, 그중 어느 것인지는 사람만 안다.
      if (use.provider && !findProvider(use.provider)) {
        push(`${at}가 이 제품이 모르는 서비스("${use.provider}")를 가리킵니다.`, {
          id: `step-${index}-provider`,
          question: `"${step.title || at}" 단계는 어느 서비스를 씁니까?`,
          why: "서비스가 정해져야 어느 계정을 연결할지 알 수 있습니다.",
          choices: providersFor(use.capability).map((provider) => provider.label),
        });
      }
    }
    if (step.produces) {
      if (!VAR_RE.test(step.produces)) push(`${at}의 결과 이름 "${step.produces}"은(는) 쓸 수 없습니다.`);
      else produced.add(step.produces);
    }
  });


  // 검증 단계
  const checkVerdicts = new Set<string>();
  for (const check of bp.checks ?? []) {
    const at = `${(check.afterStep ?? 0) + 1}번째 단계 뒤의 검증`;
    if (!steps[check.afterStep]) { push(`${at}가 없는 단계를 가리킵니다.`); continue; }
    if (!check.subject || !produced.has(check.subject)) {
      push(`${at}가 볼 "${check.subject}" 값을 아무도 만들지 않습니다.`);
    }
    const checkItems = Array.isArray(check.items)
      ? check.items.filter((item) => typeof item?.text === "string" && item.text.trim())
      : [];
    for (const item of Array.isArray(check.items) ? check.items : []) {
      if (typeof item?.text !== "string" || !item.text.trim()) {
        push(`${at}의 채점표 항목 하나가 비어 있습니다.`);
      }
    }
    if (checkItems.length === 0 && !check.criteria?.trim()) {
      push(`${at}의 통과 기준이 없습니다.`, {
        id: `check-${check.afterStep}-criteria`,
        question: `"${steps[check.afterStep]?.title ?? at}" 결과가 어떤 상태여야 통과인가요?`,
        why: "기준이 없으면 무엇을 보고 판정할지 정할 수 없습니다.",
      });
    }
    if (check.evidence && !produced.has(check.evidence)) {
      push(`${at}가 근거로 삼는 "${check.evidence}" 값을 아무도 만들지 않습니다.`, {
        id: `check-${check.afterStep}-evidence`,
        question: `검증 근거 "${check.evidence}"은(는) 어느 단계가 가져오나요?`,
        why: "근거 없는 사실 확인은 판정자가 지어내게 됩니다 — 재조회 단계가 먼저 필요합니다.",
      });
    }
    const name = check.produces?.trim() || `check${check.afterStep + 1}_verdict`;
    produced.add(name);
    checkVerdicts.add(name);
  }

  /*
   * ★계산한 값이 그대로 **바깥으로 나가면** 검증이 있어야 한다.
   *
   * 실사용 실측(2026-08-06, 주간 매출 요약): 코드가 증감률을 전부 `null`로 냈는데
   * 아무도 안 보고 그대로 요약 엑셀로 저장될 뻔했다. 검증은 "반복이 있을 때만"
   * 요구했기 때문에 이 그래프에는 한 칸도 없었다 — 사람이 없는 동안 도는 자동화가
   * 빈 결과를 산출물로 만들어 내보내는 형태다.
   *
   * 규칙은 케이스가 아니라 구조다: 앞 단계가 만든 값을 mutation 단계가 소비하면,
   * 그 값에 대한 검증이 그 사이에 있어야 한다. (사람이 직접 준 값이나, 바깥에
   * 나가지 않는 그래프에는 요구하지 않는다 — 쓸데없는 관문을 늘리지 않는다.)
   */
  {
    const checkedSubjects = new Set(
      (bp.checks ?? []).map((check) => check.subject?.trim()).filter((v): v is string => !!v),
    );
    steps.forEach((step, index) => {
      if (step.effect !== "mutation") return;
      const consumes = Array.isArray(step.consumes) ? step.consumes : [];
      for (const value of consumes) {
        const name = String(value ?? "").trim();
        if (!name || checkedSubjects.has(name)) continue;
        // 앞의 어떤 단계가 만들어 낸 값인가(사람이 넣은 시작 값은 검증 대상이 아니다).
        const madeAt = steps.findIndex((s, i) => i < index && s.produces?.trim() === name);
        if (madeAt < 0) continue;
        push(
          `"${step.title || `${index + 1}번째 단계`}"는 바깥으로 나가는데, 그 앞에서 만든 `
          + `"${name}" 값이 쓸 만한지 확인하는 단계가 없습니다. 단계는 하나도 지우지 말고, `
          + `top-level checks[]에 이 항목을 그대로 추가하세요: `
          + `{"afterStep":${madeAt},"subject":"${name}","criteria":"${name}이(가) 비어있지 않고 요청대로 채워졌다",`
          + `"produces":"${name}_ok","items":[{"text":"${name}이(가) 실제 내용으로 채워졌다","kind":"must"},`
          + `{"text":"빈 값·자리표시자·지어낸 값이 아니다","kind":"mustNot"}]}`,
        );
      }
    });
  }

  /*
   * ★바깥을 바꾼 mutation의 **결과**는 독립 재조회로 확인해야 한다(입력이 아니라 결과).
   *
   * 위 블록은 mutation이 **소비하는 입력값**을 검증하게 한다(게시할 목록이 채워졌나).
   * 하지만 "게시가 실제로 됐나"는 그것으로 답이 안 된다 — 모델이 "게시 완료"라고 써도
   * 바깥에는 아무것도 없을 수 있다(실측 2026-08-19: X 자동화가 두 런타임에서 4/4로 끝나며
   * "3건 게시"라고 적었지만 X엔 0건). 결과가 실제로 반영됐는지는 **바깥을 다시 관측한
   * 근거**로만 판정된다.
   *
   * 규칙: 바깥을 바꾸는 mutation 단계가 결과값(produces)을 내면, 그 값을 subject로 하고
   * **evidence(독립 재조회 단계의 결과)를 가진** check가 있어야 한다. evidence 없는 check는
   * 결과만 보고 판정하는 자기 채점이라 인정하지 않는다.
   */
  {
    const resultChecks = new Map<string, BlueprintCheck>();
    for (const check of bp.checks ?? []) {
      const subj = check.subject?.trim();
      if (subj) resultChecks.set(subj, check);
    }
    steps.forEach((step, index) => {
      if (step.effect !== "mutation") return;
      const result = String(step.produces ?? "").trim();
      // 결과값을 안 내는 mutation은 관측할 대상이 없다 — 빌더가 produces를 붙이게 프롬프트가
      // 지시하며, 그래도 없으면 여기서 그 사실을 지적한다(관측 불가능한 발행은 검증 불가능).
      if (!result) {
        push(
          `"${step.title || `${index + 1}번째 단계`}"는 바깥을 바꾸는데 결과값(produces)이 없습니다. `
          + `무엇이 반영됐는지(게시된 URL·저장된 경로·갱신된 행 id 등)를 produces로 내보내야 `
          + `그 결과가 실제로 일어났는지 확인할 수 있습니다.`,
        );
        return;
      }
      const check = resultChecks.get(result);
      const hasEvidence = !!check && !!String(check.evidence ?? "").trim();
      if (!hasEvidence) {
        const madeBy = steps.findIndex(
          (s, i) => i > index && s.effect === "read" && (s.consumes ?? []).map((v) => String(v).trim()).includes(result),
        );
        const evName = `${result}_observed`;
        push(
          `"${step.title || `${index + 1}번째 단계`}"는 바깥을 바꿨지만, 그 결과가 실제로 반영됐는지 `
          + `**독립적으로 다시 관측해** 확인하는 검증이 없습니다. 모델이 "완료"라고 써도 바깥은 그대로일 수 `
          + `있습니다. 단계를 지우지 말고: (1) 이 단계 뒤에 결과를 바깥에서 다시 보는 read 단계`
          + `(게시 URL 열기·파일 다시 읽기·행 재조회)를 두어 그 관측을 "${evName}"으로 내보내고, `
          + `(2) top-level checks[]에 {"afterStep":${madeBy >= 0 ? madeBy : index + 1},"subject":"${result}",`
          + `"criteria":"${result}이(가) 바깥에 실제로 반영됐다","evidence":"${evName}",`
          + `"produces":"${result}_ok","items":[{"text":"관측된 결과가 반영하려던 것과 일치한다","kind":"must"},`
          + `{"text":"관측되지 않았거나 지어낸 확인이 아니다","kind":"mustNot"}]} 를 추가하세요.`,
        );
      }
    });
  }

  // ★반복이 있는데 검증이 없으면, "마음에 들 때까지"를 글자 찾기로 흉내 내게 된다.
  //   실사용 실측: 만들어진 반복 그래프가 전부 **글 쓰는 노드가 자기 결과에 "좋음"을 붙이고
  //   갈림길이 그 글자를 찾는** 모양이었다 — 만든 놈이 자기를 채점하는 단어장 판정이다.
  for (const branch of bp.branches ?? []) {
    if (branch.repeatStep === undefined) continue;
    if (!checkVerdicts.has(branch.var)) {
      push(`${(branch.afterStep ?? 0) + 1}번째 단계 뒤의 반복이 검증 결과가 아니라 "${branch.var}"의 내용을 보고 돌지 말지 정합니다.`, {
        id: `branch-${branch.afterStep}-needs-check`,
        question: `"${steps[branch.repeatStep]?.title ?? "앞 단계"}"를 다시 할지 말지, 무엇을 보고 정할까요? 통과 기준을 한 문장으로 적어 주세요.`,
        why: "만든 단계가 자기 결과에 붙인 글자를 보고 정하면, 자기가 자기를 채점하는 셈이 됩니다.",
      });
    }
  }

  /*
   * ★"비어 있을 수 있다"고 갈림길이 말한 값에, 검증이 "비어 있으면 안 된다"고 하면
   *   그 그래프는 **평상시마다 실패한다**.
   *
   *   실측 2026-08-19: 환율이 임계값을 안 넘으면 알림 줄을 만들지 않는 자동화를 지었는데,
   *   빌더가 `alertline` 에 "비어있지 않고 채워졌다" 검사를 걸고 **바로 다음에**
   *   `alertline` 에 값이 있는지로 분기했다. 임계값을 안 넘은 날(=대부분의 날)
   *   alertline 은 정당하게 비고, 검증이 그 값을 못 찾아 실행이 NODE_INPUT_MISSING 으로
   *   죽었다. 계산은 정확했고 결과도 옳았는데 자동화는 실패로 남았다.
   *
   *   임계값 감시는 가장 흔한 자동화 모양 중 하나다 — "알릴 것이 없는 날"이 정상이어야 한다.
   *   비어 있을 수 있는 값의 검증은 값이 있는 쪽 가지 **안에서** 해야 하므로,
   *   저작 시점에 되돌린다.
   */
  const emptinessTestedVars = new Set(
    (bp.branches ?? [])
      .filter((branch) => branch.op === "truthy" || branch.op === "falsy")
      .map((branch) => String(branch.var ?? "").trim())
      .filter(Boolean),
  );
  for (const check of bp.checks ?? []) {
    const subject = String(check.subject ?? "").trim();
    if (!subject || !emptinessTestedVars.has(subject)) continue;
    const branch = (bp.branches ?? []).find((b) => String(b.var ?? "").trim() === subject);
    if (!branch) continue;
    const yesStep = typeof branch.yesStep === "number" ? branch.yesStep : null;
    /*
     * ★**위치**를 본다. 갈림길 뒤의 값-있는 쪽에 놓인 검증은 비어 있는 날 아예 돌지 않으므로
     *   문제가 아니다 — 그게 우리가 하라고 안내하는 바로 그 모양이다. 위치를 안 보면
     *   고친 청사진도 계속 되돌려 보내게 되고, 빌더는 같은 지적을 받으며 영원히 돈다
     *   (실측: 안내를 따라도 문제가 남아 네 번 시도 끝에 포기했다).
     */
    const at = typeof check.afterStep === "number" ? check.afterStep : -1;
    const runsBeforeTheBranchDecides = at <= (branch.afterStep ?? 0);
    const sitsOnTheEmptySide = typeof branch.noStep === "number" && at === branch.noStep;
    if (!runsBeforeTheBranchDecides && !sitsOnTheEmptySide) continue;
    /*
     * ★사람에게 묻지 않는다. 이건 사람이 정할 일이 아니라 **모양이 틀린 것**이고, 고치는 법도
     *   하나로 정해진다. 처음에는 질문(ask)으로 냈다가 실측에서 실패했다: 빌더가 네 번
     *   고쳐 보다 "could not pin it down" 으로 포기해, 사용자는 틀린 그래프 대신 **아무
     *   그래프도** 못 받았다. 되돌리려면 무엇을 어디로 옮기라고 정확히 말해야 한다.
     */
    push(
      `"${subject}"은(는) 갈림길이 비어 있을 수 있다고 말하는 값인데, 그 앞의 검증이 비어 있지 않기를 요구합니다. `
      + "임계값 감시처럼 '알릴 것이 없는 날'이 정상인 자동화는 그 날마다 실패합니다. "
      + `검증을 지우지 말고 **값이 있는 쪽에서만 돌게** 옮기세요: 이 검증의 afterStep 을 `
      + (yesStep !== null
        ? `갈림길의 yes 쪽 단계(${yesStep})나 그 뒤 단계로 바꾸면 됩니다.`
        : "갈림길의 yes 쪽 단계나 그 뒤 단계로 바꾸면 됩니다.")
      + ` 값이 비었는지 자체를 확인하고 싶다면, "${subject}"을(를) 만든 비교 단계가 `
      + "무엇을 읽고 어떤 임계값을 적용했는지 보고하게 하고 그 보고를 subject 로 삼으세요 "
      + "— 그 보고는 알릴 것이 없는 날에도 비지 않습니다.",
    );
  }

  // 갈림길·반복
  for (const branch of bp.branches ?? []) {
    const at = `${(branch.afterStep ?? 0) + 1}번째 단계 뒤의 갈림길`;
    if (!steps[branch.afterStep]) { push(`${at}가 없는 단계를 가리킵니다.`); continue; }
    if (!OPS.has(branch.op)) { push(`${at}의 판단 방법을 알 수 없습니다.`); continue; }
    if (!branch.var || !produced.has(branch.var)) {
      push(`${at}가 보는 "${branch.var}" 값을 아무도 만들지 않습니다.`);
    }
    if (VALUE_OPS.has(branch.op) && (branch.value === undefined || branch.value === null || branch.value === "")) {
      push(`${at}가 무엇과 비교하는지 정해져 있지 않습니다.`, {
        id: `branch-${branch.afterStep}-value`,
        question: `${at}에서, 어떤 경우에 "예"로 갈까요?`,
        why: "비교할 것이 없으면 갈림길이 판단하지 못하고 거기서 멈춥니다.",
      });
    }
    // 앞 단계로 가는 연결은 이름이 무엇이든 **반복**이다. yesStep/noStep으로 뒤로 가면서
    // 상한이 없으면 커널이 실행을 거절한다 — 저장하는 자리에서 막는다(실측: 3/3이 이렇게 만들어졌다).
    for (const [key, target] of [["yesStep", branch.yesStep], ["noStep", branch.noStep]] as const) {
      if (typeof target !== "number") continue;
      if (target <= branch.afterStep && branch.repeatStep === undefined) {
        push(`${at}의 "${key === "yesStep" ? "예" : "아니오"}" 쪽이 앞 단계로 되돌아가는데 반복 횟수가 없습니다.`, {
          id: `branch-${branch.afterStep}-repeats`,
          question: `${at}에서 되돌아가는 반복, 최대 몇 번까지 할까요?`,
          why: "사람이 보지 않는 사이에 도는 자동화라, 멈출 지점이 없으면 실행하지 않습니다.",
          choices: ["2번", "3번", "5번"],
        });
      }
    }
    if (branch.repeatStep !== undefined) {
      if (branch.repeatOn !== "yes" && branch.repeatOn !== "no") {
        // 막기만 하면 인터뷰가 막다른 길이 된다. **방향은 사람이 말해야 하는 것**이고,
        // 실제로 만들어진 갈림길이 전부 거꾸로였던 이유가 바로 이 방향이다(실측 3/3).
        const back = steps[branch.repeatStep]?.title ?? "앞 단계";
        const rule = branchLabel(branch);
        push(`${at}가 어느 쪽으로 갈 때 되돌아가는지 정해지지 않았습니다.`, {
          id: `branch-${branch.afterStep}-direction`,
          question: `"${rule}" — 어느 쪽일 때 "${back}"부터 다시 할까요?`,
          why: "이 방향이 뒤집히면 원하는 것과 정반대로 도는 자동화가 됩니다.",
          choices: [`그렇다면 다시`, `아니라면 다시`],
        });
      }
      if (!steps[branch.repeatStep]) push(`${at}의 되돌아갈 단계가 없습니다.`);
      if (branch.repeatStep > branch.afterStep) push(`${at}는 뒤쪽 단계로 되돌아갈 수 없습니다.`);
      // 되돌아가는 쪽과 이어가는 쪽이 같은 단계면 갈림길이 아무 역할도 못 한다.
      if (branch.repeatOn === "yes" ? branch.noStep === branch.repeatStep : branch.yesStep === branch.repeatStep) {
        push(`${at}의 양쪽이 모두 같은 단계로 갑니다 — 갈림길이 아무것도 가르지 않습니다.`);
      }
      const cap = branch.maxRepeats;
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1 || cap > MAX_REPEATS) {
        push(`${at}의 반복 횟수가 정해져 있지 않습니다.`, {
          id: `branch-${branch.afterStep}-repeats`,
          question: `${at}에서 되돌아가는 반복, 최대 몇 번까지 할까요?`,
          why: "사람이 보지 않는 사이에 도는 자동화라, 멈출 지점이 없으면 실행하지 않습니다.",
          choices: ["2번", "3번", "5번"],
        });
      }
    }
    if (branch.yesStep === undefined && branch.noStep === undefined && branch.repeatStep === undefined) {
      push(`${at} 뒤에 아무것도 이어져 있지 않습니다.`);
    }
  }
  return problems;
}

function triggerQuestion(): BlueprintQuestion {
  return {
    id: "trigger",
    question: "정해진 시각에 스스로 돌까요, 값을 넣을 때만 돌까요?",
    why: "두 방식은 서로 다른 자동화입니다. 임의로 정하면 원하지 않는 때에 돌게 됩니다.",
    choices: ["정해진 시각에 스스로", "값을 넣을 때만"],
  };
}

export type BlueprintBuild =
  | { ok: true; graph: WorkflowGraph; scheduleHuman: string; triggerType: "schedule" | "manual" }
  | { ok: false; problems: BlueprintProblem[] };

/**
 * 청사진을 그래프로 짓는다. **노드 id와 연결은 전부 여기서 만든다** —
 * 모델이 직접 쓰면 참/거짓 미선언 연결이나 고아 노드가 생기고, 그건 실행돼야 드러난다.
 */
/** 길이를 넘으면 마지막 온전한 낱말까지만 남긴다 — 말이 중간에서 끊기지 않게. */
function clipAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  // 공백이 있는 언어(영어 등)는 낱말 경계까지 물린다. 한국어처럼 띄어쓰기가 드문
  // 문장은 그대로 자르되 말줄임표로 잘렸음을 알린다.
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

export function buildGraphFromBlueprint(
  bp: GraphBlueprint,
  locale: "ko" | "en" = "ko",
  ctx: BlueprintContext = {},
): BlueprintBuild {
  const problems = validateBlueprint(bp, ctx);
  if (problems.length) return { ok: false, problems };

  const nodes: WorkflowNode[] = [];
  const edges: WorkflowEdge[] = [];
  const column = (index: number): number => index * 280;

  const trigger = bp.trigger;
  nodes.push({
    id: "start",
    type: "trigger",
    label: trigger.kind === "cron" ? scheduleLabel(trigger.schedule) : trigger.label,
    position: { x: 0, y: 0 },
    config: trigger.kind === "cron"
      ? { schedule: trigger.schedule }
      : { kind: "input", promptLabel: trigger.label, produces: trigger.varName },
  });

/**
 * 에이전트 단계가 만든 값을 **코드 단계가 읽는다면**, 그 값의 모양을 프롬프트에 못 박는다.
 *
 * ★실측 2026-08-20 (캠페인 E4 vs E5). 같은 빌더가 두 그래프를 만들었는데:
 *   · E4 는 `Return a JSON list of objects: {id, is_invoice, vendor, ...}` 라고 적었고 —
 *     다음 코드 단계가 그대로 읽어 **완주**했다.
 *   · E5 는 `write down: the mail id, the sender, the type, ...` 라고만 적었고 —
 *     모델이 마크다운 표로 답해 다음 코드가 **빈손**을 냈다(request_count: 0). 검증이
 *     그걸 잡아 정직하게 실패했지만, 사용자에게는 그냥 안 되는 자동화다.
 *
 *   차이는 형식 한 줄이었다. 그리고 그 한 줄을 **매번 쓸지 말지는 모델의 그날 기분**에
 *   달려 있었다. 사람에게 보이는 결과가 그렇게 정해지면 안 된다.
 *
 * ★모델 판단이 아니라 **그래프 모양**으로 결정한다: 에이전트가 낸 값을 코드가 소비하면
 *   기계가 읽을 값이고, 사람이 읽는 곳으로만 가면 글이어도 된다. 그래서 조건문이지만
 *   추측이 아니다 — 저작 시점에 그래프가 이미 답을 갖고 있다.
 */
function promptWithHandoffContract(
  step: { instruction: string; produces?: string | null },
  all: Array<{ kind?: string; consumes?: string[] | null }>,
): string {
  const produces = step.produces?.trim();
  if (!produces) return step.instruction;
  const readByCode = all.some((other) => other.kind === "code"
    && (other.consumes ?? []).some((name) => String(name).trim() === produces));
  if (!readByCode) return step.instruction;
  return [
    step.instruction,
    "",
    `A later step reads ${produces} as data, not as prose. Return ONLY JSON — no prose, no`,
    "markdown, no code fences. Use a JSON array when there are several items and a JSON",
    "object when there is one. Every field you were asked for becomes a key. If a value",
    "cannot be read from the input, use null — never guess it and never leave a placeholder.",
  ].join("\n");
}

  const stepId = (index: number): string => `step${index + 1}`;
  bp.steps.forEach((step, index) => {
    const isCode = step.kind === "code";
    // 다른 자동화를 한 단계로 부른다(커넥터 C46). 캔버스엔 있는데 말로는 못 만들던 구멍.
    const isSub = step.kind === "runGraph";
    nodes.push({
      id: stepId(index),
      // 코드 스텝은 code 노드로, 아니면 바깥 변경 여부에 따라 action/agent.
      type: isSub ? "subgraph" : isCode ? "code" : (step.effect === "mutation" ? "action" : "agent"),
      label: step.title,
      position: { x: column(index + 1), y: 0 },
      config: {
        // 코드 노드는 프롬프트가 아니라 스크립트를 지고 간다. 지시문은 참고용(note)으로 함께.
        ...(isSub
          ? { graphRef: step.graphRef ?? "", note: step.instruction }
          : isCode
          ? {
            code: step.code ?? "", codeLang: step.codeLang === "js" ? "js" : "python", note: step.instruction,
            ...(Array.isArray(step.packages) && step.packages.length
              ? { packages: step.packages.map((v) => String(v).trim()).filter(Boolean) }
              : {}),
          }
          : { prompt: promptWithHandoffContract(step, bp.steps) }),
        effect: step.effect,
        /* ★승인 게이트 폐지(오너 이사회 결정 2026-08-10): 컴파일러는 approval 선언을
           그래프에 싣지 않는다 — 커널이 읽지 않는 잠금을 실으면 "잠갔다고 믿는데 안
           잠기는" 거짓 선언이 된다. 바깥으로 나가는 것에 대한 동의는 이 그래프를
           만들기로 한 그 순간에 이미 있었고, 저장 전 확인 화면이 그 사실을 알린다. */
        ...(step.role?.trim() ? { role: step.role.trim() } : {}),
        ...(step.roleEn?.trim() ? { roleEn: step.roleEn.trim() } : {}),
        ...(step.produces ? { produces: step.produces } : {}),
        ...(step.consumes?.length ? { consumes: step.consumes[0] } : {}),
        // 도구 요구는 노드가 지고 간다 — 켜기 게이트가 이걸 읽어 연결 여부를 계산한다.
        ...(step.uses?.length
          ? {
            needs: step.uses.map((use) => ({
              capability: use.capability,
              provider: use.provider && findProvider(use.provider) ? use.provider : null,
              required: true,
            })),
          }
          : {}),
      },
    });
  });

  // 갈림길이 붙는 단계 번호 → 갈림길 노드 id
  const branches = bp.branches ?? [];
  const branchAt = new Map<number, BlueprintBranch>();
  branches.forEach((branch) => branchAt.set(branch.afterStep, branch));
  // ★한 단계 뒤에 검증 여럿 — "주가 재확인 + 형식 검사"를 검증 2개로 표현한다.
  const checkAt = new Map<number, BlueprintCheck[]>();
  for (const check of bp.checks ?? []) {
    const list = checkAt.get(check.afterStep) ?? [];
    list.push(check);
    checkAt.set(check.afterStep, list);
  }
  const checkId = (index: number, ordinal = 0): string =>
    ordinal === 0 ? `verify${index + 1}` : `verify${index + 1}-${ordinal + 1}`;

  let edgeSeq = 0;
  const link = (source: string, target: string, handle?: string, maxIterations?: number): void => {
    edges.push({
      id: `e${edgeSeq += 1}`,
      source,
      target,
      ...(handle ? { sourceHandle: handle } : {}),
      ...(typeof maxIterations === "number" ? { maxIterations } : {}),
    });
  };

  link("start", stepId(0));
  // 검증 노드를 먼저 세운다 — 갈림길은 검증 결과를 읽는다.
  for (const [afterStep, list] of checkAt) {
    if (!bp.steps[afterStep]) continue;
    list.forEach((check, ordinal) => {
      // ★검증 노드 이름 — 접두어는 **제품 언어**를 따르고, 자를 때는 단어를 쪼개지 않는다.
      //   예전에는 "검증: "이 하드코딩돼 영어 그래프에도 한국어가 붙었고, 40자에서
      //   기계적으로 잘라 "…comes from the sal"처럼 말이 끊겼다(실사용 실측 2026-08-06).
      const rawLabel = (check.criteria?.trim() || check.items?.find((item) => item?.text?.trim())?.text
        || (locale === "en" ? "Checklist" : "채점표")).trim();
      const label = clipAtWord(rawLabel, 40);
      const itemRows = Array.isArray(check.items)
        ? check.items
          .filter((item) => typeof item?.text === "string" && item.text.trim())
          .map((item) => ({ text: item.text.trim(), kind: item.kind === "mustNot" ? "mustNot" : "must" }))
        : [];
      nodes.push({
        id: checkId(afterStep, ordinal),
        type: "eval",
        label: `${locale === "en" ? "Check" : "검증"}: ${label}`,
        position: { x: column(afterStep + 1) + 70 + ordinal * 60, y: 0 },
        config: {
          subject: check.subject,
          ...(check.criteria?.trim() ? { criteria: check.criteria } : {}),
          ...(itemRows.length ? { items: itemRows } : {}),
          ...(typeof check.evidence === "string" && check.evidence.trim() ? { evidence: check.evidence.trim() } : {}),
          produces: check.produces?.trim()
            || (ordinal === 0 ? `check${afterStep + 1}_verdict` : `check${afterStep + 1}_${ordinal + 1}_verdict`),
        },
      });
    });
  }
  bp.steps.forEach((_step, index) => {
    const checkList = checkAt.get(index) ?? [];
    const branch = branchAt.get(index);
    // 단계 → 검증1 → 검증2 → … → 갈림길 순서로 잇는다(직렬 — 각 검증이 독립 판정).
    const afterStepId = checkList.length ? checkId(index, checkList.length - 1) : stepId(index);
    checkList.forEach((_check, ordinal) => {
      link(ordinal === 0 ? stepId(index) : checkId(index, ordinal - 1), checkId(index, ordinal));
    });
    if (!branch) {
      const next = bp.steps[index + 1];
      if (next) link(afterStepId, stepId(index + 1));
      return;
    }
    const branchId = `check${index + 1}`;
    nodes.push({
      id: branchId,
      type: "condition",
      // 이름을 규칙에서 만든다 — 사람이 지은 이름이 실제 규칙과 달라 예측이 안 되던 문제(실측)를
      // 애초에 만들 수 없게 한다.
      label: branchLabel(branch, locale),
      position: { x: column(index + 1) + 140, y: 0 },
      config: {
        var: branch.var,
        op: branch.op,
        ...(branch.value !== undefined ? { value: branch.value } : {}),
      },
    });
    link(afterStepId, branchId);
    // 되돌아가는 쪽은 선언(repeatOn)대로 잇는다 — 예전처럼 거짓 쪽으로 고정하면
    // 사람이 말한 방향과 반대인 자동화가 만들어진다.
    const repeatSide = branch.repeatStep !== undefined ? branch.repeatOn : undefined;
    if (repeatSide === "yes") {
      link(branchId, stepId(branch.repeatStep!), "true", branch.maxRepeats);
    } else if (branch.yesStep !== undefined && bp.steps[branch.yesStep]) {
      link(branchId, stepId(branch.yesStep), "true");
    } else if (bp.steps[index + 1]) {
      link(branchId, stepId(index + 1), "true");
    }
    if (repeatSide === "no") {
      link(branchId, stepId(branch.repeatStep!), "false", branch.maxRepeats);
    } else if (branch.noStep !== undefined && bp.steps[branch.noStep]) {
      link(branchId, stepId(branch.noStep), "false");
    } else if (repeatSide === "yes" && bp.steps[index + 1]) {
      link(branchId, stepId(index + 1), "false");
    }
    // ★빠져나가는 쪽이 비어 있으면 **끝나는 자리를 만들어 준다**.
    //
    //   "마음에 들 때까지 다시 써"를 마지막 단계에 걸면, 되돌아가는 쪽만 이어지고
    //   빠져나가는 쪽은 아무 데도 안 간다. 그러면 커널은 NO_MATCHING_EDGE로 멈춘다 —
    //   그것도 **드디어 통과한 순간에**. 실패하는 동안은 잘 돌다가 성공하자마자 죽는,
    //   가장 나쁜 타이밍이다. 말로 만든 사람은 자기가 뭘 빠뜨렸는지 알 수도 없다.
    //   조건 노드가 "여기서 끝나는 게 맞다면 종료 노드를 이으세요"라고 안내하는 그 자리를
    //   컴파일러가 대신 채운다.
    const exitSide = repeatSide === "yes" ? "false" : repeatSide === "no" ? "true" : null;
    if (exitSide && !edges.some((e) => e.source === branchId && e.sourceHandle === exitSide)) {
      const doneId = `${branchId}-done`;
      const produced = bp.steps[branch.repeatStep ?? index]?.produces;
      nodes.push({
        id: doneId,
        type: "output",
        position: { x: 0, y: 0 },
        label: "끝",
        config: {
          effect: "read",
          text: produced ? `{{${produced}}}` : "완료했습니다.",
        },
      });
      link(branchId, doneId, exitSide);
    }
  });

  // ★겹치지 않게 배치한 뒤 돌려준다. 예전에는 단계 간격이 280px인데 검증을 +70,
  //   갈림길을 +140만 띄워 노드 폭(230)보다 좁았고, 검증·반복이 있는 실제 그래프는
  //   캔버스에서 카드가 서로 겹쳐 글자를 못 읽었다(실측 2026-08-05, 노드 14개 그래프).
  //   ★캔버스와 **같은 함수**를 쓴다 — 배치 규칙이 두 벌이 되면 반드시 갈라진다.
  const built = { version: 1 as const, nodes, edges };
  const laidOut = needsLayout(built) ? layoutGraph(built) : nodes;
  return {
    ok: true,
    graph: { version: 1, nodes: laidOut, edges },
    scheduleHuman: trigger.kind === "cron" ? trigger.schedule : "manual",
    triggerType: trigger.kind === "cron" ? "schedule" : "manual",
  };
}


/**
 * 갈림길이 실제로 어떻게 갈라지는지 사람 말로. **저장 전에 이걸로 확인을 받는다.**
 *
 * 실사용 실측에서 만들어진 갈림길 3개가 **전부 방향이 거꾸로**였다("다시 써줘"라고 하면
 * 끝내고, 마음에 든다고 하면 다시 쓰는 식). 그림을 안 봤으면 그대로 켰을 것이고,
 * 켜도 아무도 알려주지 않는다. 방향은 코드가 검증할 수 없으니 사람이 읽고 답해야 한다.
 */
export function describeBranches(bp: GraphBlueprint, locale: "ko" | "en" = "ko"): string[] {
  const lines: string[] = [];
  const title = (index?: number): string =>
    typeof index === "number" && bp.steps[index] ? bp.steps[index].title : (locale === "ko" ? "끝" : "the end");
  for (const branch of bp.branches ?? []) {
    const rule = branchLabel(branch, locale);
    const repeatText = branch.repeatStep !== undefined
      ? (locale === "ko"
        ? `"${title(branch.repeatStep)}"부터 다시 (최대 ${branch.maxRepeats}번)`
        : `back to "${title(branch.repeatStep)}" (up to ${branch.maxRepeats}x)`)
      : null;
    const yes = repeatText && branch.repeatOn === "yes"
      ? repeatText
      : branch.yesStep !== undefined ? title(branch.yesStep) : title(branch.afterStep + 1);
    const no = repeatText && branch.repeatOn !== "yes"
      ? repeatText
      : branch.noStep !== undefined ? title(branch.noStep) : title(branch.afterStep + 1);
    // 이미 따옴표가 붙은 반복 문구에 또 씌우면 ""…""처럼 겹친다.
    const quote = (text: string): string => (text.startsWith('"') ? text : `"${text}"`);
    lines.push(locale === "ko"
      ? `${rule} → 그렇다면 ${quote(yes ?? "끝")}, 아니라면 ${quote(no)}`
      : `${rule} → yes: ${quote(yes ?? "the end")}, no: ${quote(no)}`);
  }
  return lines;
}

/**
 * 갈림길 이름을 규칙에서 만든다.
 *
 * ★언어를 받는다. 예전에는 **무조건 한국어**였다 — 영어로 만든 그래프에도
 * `verdict이(가) "fail"인가?` 같은 칸이 박혔다. 화면이 섞여 보이는 데서 끝나지 않고,
 * 그 라벨이 공개 설명문에 실려 Hub 발행이 통째로 거절됐다(실측 2026-08-06:
 * "descriptionEn contains Hangul"). 언어는 이미 컴파일러가 들고 있었는데 이 함수만
 * 안 받고 있었다.
 */
export function branchLabel(branch: BlueprintBranch, locale: "ko" | "en" = "ko"): string {
  const shown = typeof branch.value === "string" ? `"${branch.value}"` : String(branch.value ?? "");
  if (locale === "en") {
    switch (branch.op) {
      case "contains": return `Does ${branch.var} contain ${shown}?`;
      case "truthy": return `Does ${branch.var} have a value?`;
      case "falsy": return `Is ${branch.var} empty?`;
      case "eq": return `Is ${branch.var} ${shown}?`;
      case "ne": return `Is ${branch.var} not ${shown}?`;
      case "gt": return `Is ${branch.var} greater than ${shown}?`;
      case "lt": return `Is ${branch.var} less than ${shown}?`;
      default: return `Check ${branch.var}`;
    }
  }
  switch (branch.op) {
    case "contains": return `${branch.var}에 ${shown}이(가) 있나?`;
    case "truthy": return `${branch.var}에 값이 있나?`;
    case "falsy": return `${branch.var}이(가) 비었나?`;
    case "eq": return `${branch.var}이(가) ${shown}인가?`;
    case "ne": return `${branch.var}이(가) ${shown}이 아닌가?`;
    case "gt": return `${branch.var}이(가) ${shown}보다 큰가?`;
    case "lt": return `${branch.var}이(가) ${shown}보다 작은가?`;
    default: return `${branch.var} 확인`;
  }
}

/**
 * 실행 시점을 사람 말로. `0 8 * * 1-5`나 `daily-08:00`은 제품이 쓰는 저장 형식이지
 * 사람이 읽을 말이 아니다 — 화면에 그대로 내보내면 사용자는 자기 자동화가 언제 도는지 모른다.
 */
export function humanSchedule(schedule: string, locale: "ko" | "en" = "ko"): string {
  const raw = String(schedule ?? "").trim();
  // 그래프의 manual 은 "안 돈다"가 아니라 "네가 값을 넣어 시작한다"이다 — 이
  // 화면에서만 맞는 말이므로 여기서 소유한다.
  if (!raw || raw === "manual") return locale === "ko" ? "값을 넣을 때만" : "only when you start it";
  // 나머지 표현식 해석은 **한 벌**이 소유한다(shared/schedule-describe.ts).
  //
  // 예전에는 이 함수가 자기 파서를 따로 갖고 있었고, `*/20 * * * *` 처럼 분 칸이
  // 숫자가 아닌 형태를 못 읽어 **원문을 그대로 반환**했다. 그래서 폰은 "20분마다"라고
  // 하는데 데스크탑 자동화 화면은 같은 자동화를 `*/20 * * * *` 로 보여줬다.
  // 두 표면이 같은 값을 다르게 말하면 둘 중 하나는 반드시 틀린다.
  return humanizeScheduleLabel(raw, locale);
}

function scheduleLabel(schedule: string): string {
  return humanSchedule(schedule, "ko");
}
