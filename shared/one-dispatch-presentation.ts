import { parseAskFenceBody, type AgentlasAskQuestion } from "./ask-fence-flatten";

export interface OneDispatchQuestionAnswer {
  parentChatId: string; dispatchId: string; chatId: string; runId: string; sourceMessageId: string;
  reply?: string; locale?: "ko" | "en"; retryCommitted?: boolean;
}

/** Read-only facts about one exact internal One delegation, shared by Desktop and Mobile. */
export interface OneDispatchPresentation {
  dispatchId: string;
  parentChatId: string;
  memberAgentId: string;
  memberIcon: string;
  status: "running" | "waiting_input" | "completed" | "failed" | "cancelled" | "interrupted";
  startedAt: string;
  updatedAt: string;
  resultText?: string;
  pendingQuestion?: { sourceMessageId: string; questions: AgentlasAskQuestion[]; committedReply?: string; continuationRunId?: string };
  activity?: Array<{ id: string; kind: "reasoning" | "tool" | "status"; text: string; createdAt: string }>;
}

export function normalizeOneDispatchPresentation(value: unknown): OneDispatchPresentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const id = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(s);
  const time = (s: unknown): s is string => typeof s === "string" && s.length <= 40 && Number.isFinite(Date.parse(s));
  if (!id(v.dispatchId) || !id(v.parentChatId) || !id(v.memberAgentId)
    || typeof v.memberIcon !== "string" || v.memberIcon.length > 2048 || /[\u0000-\u001f]/.test(v.memberIcon)
    || !["running", "waiting_input", "completed", "failed", "cancelled", "interrupted"].includes(String(v.status))
    || !time(v.startedAt) || !time(v.updatedAt)) return undefined;
  const activity: NonNullable<OneDispatchPresentation["activity"]> = [];
  if (Array.isArray(v.activity)) for (const item of v.activity.slice(-8)) {
    if (!item || typeof item !== "object" || !id(item.id) || !time(item.createdAt)
      || !["reasoning", "tool", "status"].includes(item.kind) || typeof item.text !== "string") continue;
    activity.push({ id: item.id, kind: item.kind, text: item.text.slice(0, 1200), createdAt: item.createdAt });
  }
  const pending = v.pendingQuestion as {sourceMessageId?:unknown;questions?:unknown;committedReply?:unknown;continuationRunId?:unknown} | undefined;
  const questions = Array.isArray(pending?.questions)
    ? pending.questions.slice(0,8).flatMap(q => {
      try { const json = JSON.stringify(q); const parsed = typeof json === "string" ? parseAskFenceBody(json) : null; return parsed ? [parsed] : []; }
      catch { return []; }
    }) : [];
  return { dispatchId: v.dispatchId, parentChatId: v.parentChatId, memberAgentId: v.memberAgentId,
    memberIcon: v.memberIcon, status: v.status as OneDispatchPresentation["status"], startedAt: v.startedAt, updatedAt: v.updatedAt,
    ...(typeof v.resultText === "string" && v.resultText.trim() ? { resultText: v.resultText.slice(0, 12000) } : {}),
    ...(pending && id(pending.sourceMessageId) && questions.length ? { pendingQuestion: { sourceMessageId:pending.sourceMessageId, questions,
      ...(id(pending.continuationRunId) && typeof pending.committedReply === "string" && pending.committedReply.length <= 12000
        ? {continuationRunId:pending.continuationRunId,committedReply:pending.committedReply} : {}),
    } } : {}),
    ...(activity.length ? { activity } : {}) };
}
