/** Private host checkpoint, never a browser credential or a resume capability. */
export interface InvocationBrowserLoginWait {
  prerequisite: {
    prerequisiteId: string;
    runId: string;
    chatId: string;
    nodeId?: string;
    sessionId: string;
    generation: string;
  };
  sourceInvocationId: string;
  chatId: string;
  goalId: string | null;
  goalRevision: number | null;
  ownerEpoch: string;
  runtimeQuiesced: boolean;
  effectsSettled: boolean;
  state: "waiting" | "claimed" | "dispatched" | "cancelled" | "blocked";
  successorInvocationId: string | null;
  reason: string | null;
}

export const INVOCATION_BROWSER_LOGIN_WAIT_EVENT = "invocation_browser_login_wait";
const identifier = (value: unknown): value is string => typeof value === "string"
  && /^[a-zA-Z0-9_.:-]{1,256}$/.test(value)
  && !/^(?:sk-|gh[opusr]_|github_pat_)/.test(value);
const record = (value: unknown): value is Record<string, unknown> => !!value
  && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));

/** Accept intact older JSON-string rows; never reconstruct redacted identities. */
export function parseInvocationBrowserLoginWait(value: unknown, runId: string, chatId: string | null): InvocationBrowserLoginWait | null {
  if (typeof value === "string") {
    if (value.length > 8_192) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!record(value) || !keys(value, ["prerequisite", "sourceInvocationId", "chatId", "goalId", "goalRevision", "ownerEpoch",
    "runtimeQuiesced", "effectsSettled", "state", "successorInvocationId", "reason"])) return null;
  const ref = value.prerequisite;
  if (!record(ref) || !keys(ref, ["prerequisiteId", "runId", "chatId", "nodeId", "sessionId", "generation"])
    || ![ref.prerequisiteId, ref.runId, ref.chatId, ref.sessionId, ref.generation, value.sourceInvocationId, value.chatId, value.ownerEpoch].every(identifier)
    || (ref.nodeId !== undefined && !identifier(ref.nodeId))
    || value.sourceInvocationId !== runId || ref.runId !== runId || value.chatId !== chatId || ref.chatId !== chatId
    || (value.goalId !== null && !identifier(value.goalId))
    || (value.goalRevision !== null && (!Number.isSafeInteger(value.goalRevision) || (value.goalRevision as number) < 0))
    || (value.goalId === null && value.goalRevision !== null)
    || typeof value.runtimeQuiesced !== "boolean" || typeof value.effectsSettled !== "boolean"
    || !["waiting", "claimed", "dispatched", "cancelled", "blocked"].includes(value.state as string)
    || (value.successorInvocationId !== null && !identifier(value.successorInvocationId))
    || (value.state === "waiting" && value.successorInvocationId !== null)
    || (["claimed", "dispatched"].includes(value.state as string) && value.successorInvocationId === null)
    || (value.reason !== null && (typeof value.reason !== "string" || value.reason.length > 800 || /[\r\n\x00]/.test(value.reason)))) return null;
  return {
    prerequisite: { prerequisiteId: ref.prerequisiteId as string, runId, chatId: chatId as string,
      ...(ref.nodeId === undefined ? {} : { nodeId: ref.nodeId as string }), sessionId: ref.sessionId as string, generation: ref.generation as string },
    sourceInvocationId: runId, chatId: chatId as string, goalId: value.goalId as string | null, goalRevision: value.goalRevision as number | null,
    ownerEpoch: value.ownerEpoch as string, runtimeQuiesced: value.runtimeQuiesced, effectsSettled: value.effectsSettled,
    state: value.state as InvocationBrowserLoginWait["state"], successorInvocationId: value.successorInvocationId as string | null, reason: value.reason as string | null,
  };
}
