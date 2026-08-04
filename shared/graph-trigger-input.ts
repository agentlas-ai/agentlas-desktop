// 입력 트리거 계약 — "이 그래프는 시작할 때 사람에게 무엇을 받는가"를 한 곳에서 정한다.
//
// 이 규칙이 여러 곳에 흩어져 있으면, 화면은 "주제"를 묻고 커널은 `input`을 찾는 식으로
// 어긋난다. 사용자에겐 값을 넣었는데 빈 값으로 실행된 것처럼 보인다.
// 터미널·플러그인도 같은 규칙을 따라야 하며, 그쪽은 별도 패키지라 문자열 계약으로만 공유한다.
import type { WorkflowGraph, WorkflowNode } from "./types";

/** 값을 못 정했을 때 쓰는 변수 이름. 프롬프트에서 {{input}} 으로 읽힌다. */
export const DEFAULT_TRIGGER_INPUT_VAR = "input";

export function isInputTriggerNode(node: WorkflowNode | null | undefined): boolean {
  if (!node || node.type !== "trigger") return false;
  const kind = node.config?.kind;
  return kind === "input" || kind === "manual";
}

/** 이 트리거가 만들어 내는 변수 이름. 프롬프트가 {{이 이름}} 으로 값을 읽는다. */
export function triggerProducesName(node: WorkflowNode | null | undefined): string {
  const declared = node?.config?.produces;
  return typeof declared === "string" && declared.trim() ? declared.trim() : DEFAULT_TRIGGER_INPUT_VAR;
}

/** 사람에게 보여줄 질문 문구. 없으면 변수 이름을 그대로 쓰지 않고 일반 문구로 묻는다. */
export function triggerInputLabel(node: WorkflowNode | null | undefined, locale: "ko" | "en" = "ko"): string {
  const declared = node?.config?.promptLabel;
  if (typeof declared === "string" && declared.trim()) return declared.trim();
  return locale === "en" ? "Input for this graph" : "이 그래프에 넘길 값";
}

export interface GraphInputRequirement {
  /** 시작할 때 사람이 값을 넣어야 하는가. */
  required: boolean;
  /** 채워 넣을 변수 이름. */
  varName: string;
  /** 사람에게 보여줄 질문. */
  label: string;
}

/**
 * 이 그래프가 시작 입력을 요구하는지 한 번에 답한다.
 * 트리거가 입력형이라고 선언했거나, 트리거가 만드는 변수를 실제로 참조하는 단계가 있으면 요구한다
 * — 선언을 빠뜨린 그래프가 조용히 빈 값으로 도는 것을 막기 위해서다.
 */
export function graphInputRequirement(
  graph: WorkflowGraph | null | undefined,
  locale: "ko" | "en" = "ko",
): GraphInputRequirement | null {
  const trigger = graph?.nodes?.find((node) => node.type === "trigger") ?? null;
  if (!trigger) return null;
  const unproduced = unproducedVariables(graph);
  const declared = typeof trigger.config?.produces === "string" && trigger.config.produces.trim()
    ? trigger.config.produces.trim()
    : null;
  // 이름을 선언하지 않았어도, 아무 단계도 만들지 않는 값이 **정확히 하나**면 그것이
  // 사람이 넣어야 하는 값이다. 이건 추측이 아니라 그래프에서 읽어낸 사실이며,
  // 이 도출이 없으면 화면은 `input`을 받고 프롬프트는 `topic`을 찾아 빈 채로 돈다.
  const varName = declared
    ?? (unproduced.length === 1 ? unproduced[0] : DEFAULT_TRIGGER_INPUT_VAR);
  if (!isInputTriggerNode(trigger) && !unproduced.includes(varName)) return null;
  return { required: true, varName, label: triggerInputLabel(trigger, locale) };
}

/** 어떤 단계도 만들어 주지 않는데 누군가 읽는 값들 — 밖에서 들어와야 하는 값이다. */
export function unproducedVariables(graph: WorkflowGraph | null | undefined): string[] {
  const produced = new Set<string>();
  for (const node of graph?.nodes ?? []) {
    const produces = node.config?.produces;
    if (typeof produces === "string" && produces.trim()) produced.add(produces.trim());
    const to = node.config?.to;
    if (typeof to === "string" && to.trim()) produced.add(to.trim());
  }
  const referenced: string[] = [];
  for (const node of graph?.nodes ?? []) {
    const text = `${node.config?.prompt ?? ""}\n${node.config?.text ?? ""}\n${node.config?.template ?? ""}`;
    for (const match of text.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)) {
      const name = match[1];
      if (!produced.has(name) && !referenced.includes(name)) referenced.push(name);
    }
  }
  return referenced;
}
