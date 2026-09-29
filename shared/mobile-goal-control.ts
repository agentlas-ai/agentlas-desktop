import { parseGoalPanelEdit } from "./goal-panel";

/** Additive, host-bound remote access to the existing Desktop goal services. */
export const MOBILE_GOAL_CONTROL_METHODS = [
  "alive.getState", "alive.setEnabled", "alive.setTokenLimit",
  "agi.getTokenLimits", "agi.setTokenLimits",
  "goalPanel.view", "goalPanel.edit", "goalPanel.shape", "chats.pauseGoal", "chats.deleteGoal",
] as const;
export type MobileGoalControlMethod = (typeof MOBILE_GOAL_CONTROL_METHODS)[number];
export const MOBILE_GOAL_CONTROL_WRITE_METHODS = [
  "alive.setEnabled", "alive.setTokenLimit", "agi.setTokenLimits", "goalPanel.edit", "goalPanel.shape", "chats.pauseGoal", "chats.deleteGoal",
] as const;
export const MOBILE_GOAL_CONTROL_CAPABILITY = {
  schemaVersion: 1, alive: true, agiTokenLimits: true, goalPanel: true,
  pauseGoal: true, deleteGoal: true, resumeGoal: false, reviseGoal: false, reauthorizeGoal: false, goalResumeReview: false,
  changedEvent: "goalControl.updated", hostBinding: "expectedHostId", shapeOutcome: "accepted",
  unsupportedReasons: {
    resumeGoal: "main_resume_confirmation_contract_not_exposed",
    reviseGoal: "main_revision_contract_not_exposed",
    reauthorizeGoal: "main_reauthorization_contract_not_exposed",
    goalResumeReview: "main_attempt_review_contract_not_exposed",
  },
} as const;
export const isMobileGoalControlMethod = (value: string): value is MobileGoalControlMethod =>
  (MOBILE_GOAL_CONTROL_METHODS as readonly string[]).includes(value);

function record(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function id(value: unknown, max = 200): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}
function limit(value: unknown, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
function aliveLimit(value: unknown): boolean { return value === null || limit(value, 1, 1_000_000_000); }
const EDIT_KEYS: Record<string, readonly string[]> = {
  amend_objective: ["op", "text"], add_tactic: ["op", "strategyId", "description", "doneWhen", "recurring"],
  add_strategy: ["op", "aim", "kpi", "firstSubGoal"], edit_node: ["op", "nodeId", "intent", "doneWhen", "kpi"],
  remove_node: ["op", "nodeId"], move_node: ["op", "nodeId", "direction"], pause_node: ["op", "nodeId"],
  resume_node: ["op", "nodeId"], mark_done: ["op", "nodeId"],
  accept_suggestion: ["op", "suggestionId"], dismiss_suggestion: ["op", "suggestionId"],
};

/** No coercion or extra nested fields; Main still applies every domain/concurrency fence. */
export function validateMobileGoalControlParams(method: MobileGoalControlMethod, raw: unknown): string | null {
  if (!record(raw)) return "goal control params must be an object";
  const p = raw;
  if (typeof p.expectedHostId !== "string" || !/^host_[a-f0-9]{32}$/.test(p.expectedHostId)) return "expectedHostId is required";
  const allowed: Record<MobileGoalControlMethod, string[]> = {
    "alive.getState": ["surface", "chatId"],
    "alive.setEnabled": ["surface", "chatId", "enabled", "tokenLimit", "moveFrom"],
    "alive.setTokenLimit": ["surface", "chatId", "tokenLimit"],
    "agi.getTokenLimits": [], "agi.setTokenLimits": ["attemptTokenLimit", "dailyGoalTokenLimit"],
    "goalPanel.view": ["chatId"], "goalPanel.edit": ["chatId", "expectedGoalId", "expectedPlan", "edit"],
    "goalPanel.shape": ["chatId", "expectedGoalId"],
    "chats.pauseGoal": ["chatId", "expectedGoalId"], "chats.deleteGoal": ["chatId", "expectedGoalId"],
  };
  if (!keys(p, ["expectedHostId", ...allowed[method]])) return "goal control contains unsupported fields";
  if (!method.startsWith("agi.") && !id(p.chatId)) return "chatId must be a bounded identifier";
  if (method.startsWith("alive.")) {
    if (p.surface !== "one" && p.surface !== "work") return "surface must be one or work";
    if (method === "alive.setEnabled" && (typeof p.enabled !== "boolean" || (p.moveFrom !== undefined && typeof p.moveFrom !== "boolean"))) return "enabled and moveFrom must be booleans";
    if ((method === "alive.setTokenLimit" || "tokenLimit" in p) && !aliveLimit(p.tokenLimit)) return "tokenLimit must be null or an integer from 1 to 1000000000";
  }
  if (method === "agi.setTokenLimits") {
    if (!("attemptTokenLimit" in p) && !("dailyGoalTokenLimit" in p)) return "a token limit is required";
    for (const field of ["attemptTokenLimit", "dailyGoalTokenLimit"]) {
      if (field in p && !limit(p[field], 5_000, 50_000_000)) return `${field} must be an integer from 5000 to 50000000`;
    }
    if (typeof p.attemptTokenLimit === "number" && typeof p.dailyGoalTokenLimit === "number" && p.attemptTokenLimit > p.dailyGoalTokenLimit) return "attemptTokenLimit exceeds dailyGoalTokenLimit";
  }
  if (method === "goalPanel.shape" || method === "goalPanel.edit" || method === "chats.pauseGoal" || method === "chats.deleteGoal") {
    if (!id(p.expectedGoalId, 256)) return "expectedGoalId must be a bounded identifier";
  }
  if (method === "goalPanel.edit") {
    const e = p.edit;
    if (!record(e) || typeof e.op !== "string" || !Object.hasOwn(EDIT_KEYS, e.op) || !keys(e, EDIT_KEYS[e.op]!)) return "edit contains unsupported fields";
    if (e.op === "add_tactic" && typeof e.recurring !== "boolean") return "recurring must be a boolean";
    if (e.op === "add_strategy" && (!record(e.firstSubGoal) || !keys(e.firstSubGoal, ["description", "doneWhen"]))) return "firstSubGoal contains unsupported fields";
    if (!parseGoalPanelEdit(e)) return "goal panel edit is invalid";
    const plan = p.expectedPlan;
    const planOptional = ["amend_objective", "accept_suggestion", "dismiss_suggestion"].includes(e.op);
    if (plan === undefined || plan === null) {
      if (!planOptional) return "expectedPlan is required for node edits";
    } else if (!record(plan) || !keys(plan, ["revision", "planSeq"]) || !limit(plan.revision, 1, Number.MAX_SAFE_INTEGER) || !limit(plan.planSeq, 1, Number.MAX_SAFE_INTEGER)) {
      return "expectedPlan must contain revision and planSeq";
    }
  }
  return null;
}
