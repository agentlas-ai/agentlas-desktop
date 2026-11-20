import { getDb } from "./store/db";

/**
 * A schedule a model saves must point at something that exists. the model guessed targetId "agentlas-one" (the registered
 * personal agent is "builtin-agentlas-one"), the store took it as written, and the run answered into a hidden session nobody reads. The call
 * is refused with the cause and the way on instead. A hub target is a package slug the hub resolves at run time, so it is not read here.
 * Reads only the registries (no model, no word list).
 */
export function automationTargetProblem(targetType: unknown, targetId: unknown): { code: string; detail: string } | null {
  if (targetType !== "agent" && targetType !== "firm") return null;
  const id = typeof targetId === "string" ? targetId.trim() : "";
  const way = "Leave targetType and targetId out to use the conversation's own agent, or pass the id of a registered agent (agents.list) or company.";
  if (!id) return { code: "automation_target_required", detail: `${targetType} target needs targetId. ${way}` };
  const table = targetType === "agent" ? "installed_agents" : "firms";
  let found = false;
  try { found = Boolean(getDb().prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(id)); } catch { found = true; /* a registry that cannot be read does not refuse a save */ }
  return found ? null : { code: "automation_target_unknown", detail: `No registered ${targetType} has the id "${id.slice(0, 120)}". ${way}` };
}

/** The conversation a model names as the report destination must exist, or the report would be dropped silently. */
export function automationOriginChatProblem(chatId: unknown): { code: string; detail: string } | null {
  if (typeof chatId !== "string" || !chatId) return null;
  let found = true;
  try { found = Boolean(getDb().prepare("SELECT 1 FROM chats WHERE id = ? LIMIT 1").get(chatId)); } catch { found = true; }
  return found ? null : { code: "automation_origin_chat_unknown", detail: "monitor.originChatId is not a conversation of this app; leave monitor out to report into the calling conversation." };
}
