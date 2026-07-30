import type { McpInvocationEvent } from "@/lib/types";

export type OneRunStageId = "understand" | "discover" | "verify" | "synthesize" | "prepare";

export type OneRunProgressState = {
  current: OneRunStageId;
  reached: OneRunStageId[];
  participants: OneRunParticipant[];
};

export type OneRunParticipant = {
  id: string;
  name: string;
  role?: string;
};

export const ONE_RUN_STAGE_ORDER: OneRunStageId[] = [
  "understand",
  "discover",
  "verify",
  "synthesize",
  "prepare",
];

export function initialOneRunProgress(): OneRunProgressState {
  return { current: "understand", reached: ["understand"], participants: [] };
}

function stageRank(stage: OneRunStageId): number {
  return ONE_RUN_STAGE_ORDER.indexOf(stage);
}

function inferredStage(event: McpInvocationEvent): OneRunStageId | null {
  if (event.kind === "surface") return "prepare";
  if (event.phase === "synthesize") return "synthesize";
  if (event.phase === "delegate") return "verify";
  if (event.phase === "plan") return "understand";

  const toolName = event.tool?.name?.toLowerCase() ?? "";
  if (event.kind === "tool-use") {
    if (event.tool?.result || /read|open|fetch|inspect|price|compare|verify|validate|check/.test(toolName)) return "verify";
    if (/search|find|query|browse|web|hub|discover|list/.test(toolName)) return "discover";
    return "discover";
  }

  if (event.kind === "partial") return "synthesize";
  const status = event.status?.toLowerCase() ?? "";
  if (/표|레이아웃|surface|format|render|정리 중/.test(status)) return "prepare";
  if (/종합|synthesi|결론|답변|작성/.test(status)) return "synthesize";
  if (/검증|확인|비교|가격|사실|verify|validat|cross.?check|inspect/.test(status)) return "verify";
  if (/검색|탐색|후보|자료|search|discover|research|browse|find/.test(status)) return "discover";
  return null;
}

export function reduceOneRunProgress(
  state: OneRunProgressState,
  input: McpInvocationEvent,
): OneRunProgressState {
  // Main can attribute an installed agent through runtimeAgentId even when the
  // underlying runtime omitted its transient agentId. Normalize that verified
  // identity before updating the visible participant list.
  const event = input.runtimeAgentId && !input.agentId
    ? { ...input, agentId: input.runtimeAgentId }
    : input;
  const nextStage = inferredStage(event);
  const current = nextStage && stageRank(nextStage) > stageRank(state.current) ? nextStage : state.current;
  const reached = ONE_RUN_STAGE_ORDER.slice(0, stageRank(current) + 1);
  let participants = state.participants;
  if (event.agentName && event.agentId) {
    const next = {
      id: event.agentId,
      name: event.agentName,
      ...(event.role?.trim() ? { role: event.role.trim() } : {}),
    };
    const existingIndex = participants.findIndex((item) => item.id === next.id);
    if (existingIndex < 0) {
      participants = [...participants, next].slice(0, 5);
    } else if (
      participants[existingIndex].name !== next.name
      || participants[existingIndex].role !== next.role
    ) {
      participants = participants.map((item, index) => index === existingIndex ? next : item);
    }
  }
  if (current === state.current && participants === state.participants) return state;
  return { current, reached, participants };
}

export function oneRunStageLabel(stage: OneRunStageId, locale: "ko" | "en"): string {
  const labels: Record<OneRunStageId, [string, string]> = {
    understand: ["요청과 조건을 정리하고 있어요.", "Understanding the request and constraints."],
    discover: ["후보와 필요한 자료를 찾고 있어요.", "Finding candidates and the right sources."],
    verify: ["가격·사실·출처를 확인하고 있어요.", "Checking facts, prices, and sources."],
    synthesize: ["검증한 내용을 하나의 답으로 합치고 있어요.", "Combining verified findings into one answer."],
    prepare: ["표와 출처를 읽기 쉽게 정리하고 있어요.", "Preparing a clear result with sources."],
  };
  return labels[stage][locale === "ko" ? 0 : 1];
}
