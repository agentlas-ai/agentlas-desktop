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
}

export interface BlueprintBranch {
  /** 이 단계 **뒤에** 갈림길을 놓는다. */
  afterStep: number;
  /** 사람에게 보여줄 갈림길 이름. 실제 규칙과 다르면 안 되므로 규칙에서 만든다. */
  var: string;
  op: "contains" | "truthy" | "falsy" | "eq" | "neq" | "gt" | "lt";
  value?: string | number;
  /** 참일 때 갈 단계 번호(없으면 여기서 끝). */
  yesStep?: number;
  /** 거짓일 때 갈 단계 번호(없으면 여기서 끝). */
  noStep?: number;
  /** 거짓일 때 앞 단계로 되돌아가 반복한다면 그 단계 번호. */
  repeatStep?: number;
  /** 반복 상한. repeatStep이 있으면 반드시 있어야 한다. */
  maxRepeats?: number;
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
  | { kind: "blueprint"; blueprint: GraphBlueprint };

export interface BlueprintProblem {
  /** 이 문제를 풀려면 사람에게 물어야 하는가. */
  ask: BlueprintQuestion | null;
  reason: string;
}

const OPS = new Set(["contains", "truthy", "falsy", "eq", "neq", "gt", "lt"]);
const VALUE_OPS = new Set(["contains", "eq", "neq", "gt", "lt"]);
const MAX_STEPS = 20;
export const MAX_REPEATS = 20;

const VAR_RE = /^[A-Za-z_][\w-]*$/;

/**
 * 청사진이 실제로 그래프로 지어질 수 있는지 검사한다.
 * **여기서 통과시킨 것만 그래프가 된다.** 모자란 곳은 "기본값"이 아니라 질문으로 돌려준다 —
 * 자동화는 사람이 보지 않을 때 도는 것이라, 지어낸 값이 그대로 실행된다.
 */
export function validateBlueprint(bp: GraphBlueprint | null | undefined): BlueprintProblem[] {
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
    for (const name of step.consumes ?? []) {
      if (!produced.has(name)) {
        push(`${at}가 쓰는 "${name}" 값을 아무도 만들지 않습니다.`, {
          id: `step-${index}-consumes-${name}`,
          question: `"${step.title || at}" 단계가 쓰는 "${name}"은(는) 어디서 오나요?`,
          why: "만들어 주는 단계가 없으면 그 자리가 빈 채로 실행됩니다.",
        });
      }
    }
    if (step.produces) {
      if (!VAR_RE.test(step.produces)) push(`${at}의 결과 이름 "${step.produces}"은(는) 쓸 수 없습니다.`);
      else produced.add(step.produces);
    }
  });

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
    if (branch.repeatStep !== undefined) {
      if (!steps[branch.repeatStep]) push(`${at}의 되돌아갈 단계가 없습니다.`);
      if (branch.repeatStep > branch.afterStep) push(`${at}는 뒤쪽 단계로 되돌아갈 수 없습니다.`);
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
export function buildGraphFromBlueprint(bp: GraphBlueprint): BlueprintBuild {
  const problems = validateBlueprint(bp);
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

  const stepId = (index: number): string => `step${index + 1}`;
  bp.steps.forEach((step, index) => {
    nodes.push({
      id: stepId(index),
      type: step.effect === "mutation" ? "action" : "agent",
      label: step.title,
      position: { x: column(index + 1), y: 0 },
      config: {
        prompt: step.instruction,
        effect: step.effect,
        // 바깥을 바꾸는 단계는 기본이 "확인 후 실행"이다. 이 기본값을 낮추는 것은
        // 자동화를 만드는 자리가 아니라 사람이 따로 결정할 일이다.
        ...(step.effect === "mutation" ? { approval: "ask" } : {}),
        ...(step.produces ? { produces: step.produces } : {}),
        ...(step.consumes?.length ? { consumes: step.consumes[0] } : {}),
      },
    });
  });

  // 갈림길이 붙는 단계 번호 → 갈림길 노드 id
  const branches = bp.branches ?? [];
  const branchAt = new Map<number, BlueprintBranch>();
  branches.forEach((branch) => branchAt.set(branch.afterStep, branch));

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
  bp.steps.forEach((_step, index) => {
    const branch = branchAt.get(index);
    if (!branch) {
      const next = bp.steps[index + 1];
      if (next) link(stepId(index), stepId(index + 1));
      return;
    }
    const branchId = `check${index + 1}`;
    nodes.push({
      id: branchId,
      type: "condition",
      // 이름을 규칙에서 만든다 — 사람이 지은 이름이 실제 규칙과 달라 예측이 안 되던 문제(실측)를
      // 애초에 만들 수 없게 한다.
      label: branchLabel(branch),
      position: { x: column(index + 1) + 140, y: 0 },
      config: {
        var: branch.var,
        op: branch.op,
        ...(branch.value !== undefined ? { value: branch.value } : {}),
      },
    });
    link(stepId(index), branchId);
    // 참 쪽
    if (branch.yesStep !== undefined && bp.steps[branch.yesStep]) {
      link(branchId, stepId(branch.yesStep), "true");
    } else if (bp.steps[index + 1]) {
      link(branchId, stepId(index + 1), "true");
    }
    // 거짓 쪽 — 되돌아가는 반복이면 상한과 함께.
    if (branch.repeatStep !== undefined) {
      link(branchId, stepId(branch.repeatStep), "false", branch.maxRepeats);
    } else if (branch.noStep !== undefined && bp.steps[branch.noStep]) {
      link(branchId, stepId(branch.noStep), "false");
    }
  });

  return {
    ok: true,
    graph: { version: 1, nodes, edges },
    scheduleHuman: trigger.kind === "cron" ? trigger.schedule : "manual",
    triggerType: trigger.kind === "cron" ? "schedule" : "manual",
  };
}

/** 갈림길 이름을 규칙에서 만든다. */
export function branchLabel(branch: BlueprintBranch): string {
  const shown = typeof branch.value === "string" ? `"${branch.value}"` : String(branch.value ?? "");
  switch (branch.op) {
    case "contains": return `${branch.var}에 ${shown}이(가) 있나?`;
    case "truthy": return `${branch.var}에 값이 있나?`;
    case "falsy": return `${branch.var}이(가) 비었나?`;
    case "eq": return `${branch.var}이(가) ${shown}인가?`;
    case "neq": return `${branch.var}이(가) ${shown}이 아닌가?`;
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
  if (!raw || raw === "manual") return locale === "ko" ? "값을 넣을 때만" : "only when you start it";
  const daily = /^daily-(\d{2}):(\d{2})$/.exec(raw);
  if (daily) return locale === "ko" ? `매일 ${hhmm(daily[1], daily[2], "ko")}` : `every day at ${daily[1]}:${daily[2]}`;
  const parts = raw.split(/\s+/);
  if (parts.length === 5) {
    const [min, hour, dom, mon, dow] = parts;
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && mon === "*") {
      const at = hhmm(hour.padStart(2, "0"), min.padStart(2, "0"), locale);
      const when = dowPhrase(dow, dom, locale);
      return locale === "ko" ? `${when} ${at}` : `${when} at ${hour.padStart(2, "0")}:${min.padStart(2, "0")}`;
    }
  }
  return raw;
}

function hhmm(hour: string, minute: string, locale: "ko" | "en"): string {
  if (locale !== "ko") return `${hour}:${minute}`;
  const h = Number(hour);
  const period = h < 12 ? "오전" : "오후";
  const shown = h % 12 === 0 ? 12 : h % 12;
  return minute === "00" ? `${period} ${shown}시` : `${period} ${shown}시 ${Number(minute)}분`;
}

const DOW_KO: Record<string, string> = { "0": "일", "1": "월", "2": "화", "3": "수", "4": "목", "5": "금", "6": "토", "7": "일" };

function dowPhrase(dow: string, dom: string, locale: "ko" | "en"): string {
  if (dow === "*" && dom === "*") return locale === "ko" ? "매일" : "every day";
  if (dow === "1-5") return locale === "ko" ? "평일(월~금)" : "every weekday";
  if (dow === "0,6" || dow === "6,0") return locale === "ko" ? "주말" : "every weekend";
  if (/^\d$/.test(dow)) {
    return locale === "ko" ? `매주 ${DOW_KO[dow]}요일` : `every week on day ${dow}`;
  }
  if (dow === "*" && /^\d+$/.test(dom)) {
    return locale === "ko" ? `매월 ${Number(dom)}일` : `on day ${dom} of each month`;
  }
  if (/^[\d,]+$/.test(dow)) {
    const days = dow.split(",").map((d) => DOW_KO[d] ?? d).join("·");
    return locale === "ko" ? `매주 ${days}요일` : `on ${dow}`;
  }
  return locale === "ko" ? "정해진 때" : "on schedule";
}

function scheduleLabel(schedule: string): string {
  return humanSchedule(schedule, "ko");
}
