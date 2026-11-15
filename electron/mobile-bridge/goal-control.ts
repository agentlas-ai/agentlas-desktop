import type { GoalPanelEditResult, GoalPanelView } from "../../shared/goal-panel";
import { validateMobileGoalControlParams, type MobileGoalControlMethod } from "../../shared/mobile-goal-control";
import type { MobileBridgeJsonValue } from "../../shared/mobile-bridge";
import { sanitizeMobileBridgeText, mobileBridgeJsonBytes } from "./sanitize";

/**
 * The AGI unblocker and its token limits are gone, but a phone of an earlier build opens its Goal sheet with agi.getTokenLimits and
 * shows a failure when it is refused (mobile goal_management_models.dart decodes four keys, min <= value <= max). So the method stays and
 * answers the defaults the owner last saw, as constants, and the setter refuses with one code ("this feature no longer exists", the
 * phone shows its own plain refusal text) together with the same limits, so a phone's own re-read agrees with what is shown.
 */
export const GOAL_CONTROL_AGI_LIMITS = { attemptTokenLimit: 60_000, dailyGoalTokenLimit: 200_000, min: 5_000, max: 50_000_000 } as const;
export const GOAL_CONTROL_AGI_REMOVED_CODE = "agi_limits_removed";
/**
 * The One/Work Alive switch is gone for the same reason: a phone of an earlier build opens its Goal sheet with alive.getState and its
 * decoder accepts a closed key set (all seven keys, scope may be null). So the method stays and always answers "off, nothing to
 * configure", and the two setters refuse with one code together with that same state (the phone's own re-read agrees with it).
 */
export const GOAL_CONTROL_ALIVE_STATE = Object.freeze({
  available: false, enabled: false, scope: null, needsGoal: false, status: "off",
  budget: Object.freeze({ tokenLimit: null, tokensUsed: 0 }), modelOrder: Object.freeze([]),
});
export const GOAL_CONTROL_ALIVE_REMOVED_CODE = "alive_removed";

/** Main-owned operations; no store, runtime, or IPC instance is created by the remote adapter. */
export interface MobileGoalControlServices {
  chatSurface(chatId: string): "one" | "work" | null;
  readGoalPanel(chatId: string): GoalPanelView | null;
  pauseGoal(chatId: string, expectedGoalId: string): void;
  deleteGoal(chatId: string, expectedGoalId: string): void;
  /** The owner's Resume from the phone: the chip's own path (long-run/goal-owner-resume.ts) at the Goal's current version. */
  resumeGoal(chatId: string, expectedGoalId: string): Promise<unknown>;
  editGoalPanel(input: unknown): GoalPanelEditResult;
  shapeGoalPanel(chatId: string, expectedGoalId: string): GoalPanelEditResult & { done?: Promise<void> };
}

/** Lazy Main wiring keeps contract tests independent of Electron and of the owner's live database. */
export function desktopGoalControlServices(): MobileGoalControlServices {
  const goals = require("../long-run/goal-panel") as typeof import("../long-run/goal-panel");
  const { getChat } = require("../store/chats") as typeof import("../store/chats");
  const { isMobileBridgeOneChat } = require("./projector") as typeof import("./projector");
  const { invocationService } = require("../invocation/service") as typeof import("../invocation/service");
  const { stopInvocationGoal } = require("../runtime/invocation-owner-control") as typeof import("../runtime/invocation-owner-control");
  return {
    chatSurface(chatId) {
      const chat = getChat(chatId);
      if (!chat) return null;
      if (isMobileBridgeOneChat(chat)) return "one";
      return chat.originSurface === "work" || chat.projectId ? "work" : null;
    },
    readGoalPanel: goals.readGoalPanel,
    pauseGoal: (chatId, goalId) => stopInvocationGoal(chatId, goalId, "pause"),
    deleteGoal: (chatId, goalId) => stopInvocationGoal(chatId, goalId, "delete"),
    resumeGoal: (chatId, goalId) => {
      const { resumeGoalAsOwner } = require("../long-run/goal-owner-resume") as typeof import("../long-run/goal-owner-resume");
      return resumeGoalAsOwner({ chatId, expectedGoalId: goalId, expectedVersion: null }, invocationService);
    },
    editGoalPanel: (input) => goals.editGoalPanel(input, { activeChatIds: () => invocationService.activeChatIds() }),
    shapeGoalPanel: goals.requestGoalPanelShape,
  };
}

function fields(value: unknown, names: readonly string[]): Record<string, unknown> {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(names.filter((name) => row[name] !== undefined).map((name) => [name, row[name]]));
}
function nullable(value: unknown, names: readonly string[]): unknown { return value == null ? null : fields(value, names); }
function text(value: unknown): unknown { return nullable(value, ["ko", "en"]); }
function node(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 2) throw new Error("goal_control_projection_invalid");
  const row = fields(value, ["id", "kind", "intent", "method", "doneWhen", "state", "stateReason", "current", "progress", "recurring", "runs", "ownerPaused", "agi", "suggestions", "children"]);
  return { ...row, method: text(row.method), stateReason: text(row.stateReason), progress: nullable(row.progress, ["done", "total"]),
    agi: null, suggestions: [], children: Array.isArray(row.children) ? row.children.map((child) => node(child, depth + 1)) : [] };
}
function goalView(value: unknown): unknown {
  if (value == null) return null;
  const row = fields(value, ["schemaVersion", "chatId", "goalId", "lifecycle", "revision", "plan", "planBehindRevision", "shape", "provisional", "state", "stateReason", "root", "deadlineAt", "budget", "pendingAmendments", "nodes", "agiWorking", "canShape", "shaping", "shapeFailed", "limits"]);
  const root = fields(row.root, ["intent", "intentFull", "ownerUpdates", "method", "diagnosis", "doneWhen", "progress", "agi", "suggestions"]);
  return { ...row, plan: nullable(row.plan, ["revision", "planSeq"]), stateReason: text(row.stateReason),
    root: { ...root, method: text(root.method), progress: nullable(root.progress, ["done", "total"]), agi: null, suggestions: [] },
    budget: fields(row.budget, ["maxCycles", "cycleCount", "maxCostUsd", "costUsedUsd", "wallclockDeadline"]),
    nodes: Array.isArray(row.nodes) ? row.nodes.map((child) => node(child)) : [], agiWorking: null, limits: fields(row.limits, ["strategies", "tactics"]) };
}
function safeResult(value: Record<string, unknown>): Record<string, unknown> {
  const result = fields(value, ["ok", "code", "outcome", "pending", "replayable"]);
  if ("state" in value) {
    const row = fields(value.state, ["available", "reasonCode", "accessReasonCode", "enabled", "scope", "needsGoal", "status", "statusReasonCode", "budget", "tokenLimitAppliesOnEnable", "modelOrder", "conflict"]);
    result.state = { ...row, scope: nullable(row.scope, ["kind", "id", "label"]), budget: fields(row.budget, ["tokenLimit", "tokensUsed"]),
      modelOrder: Array.isArray(row.modelOrder) ? row.modelOrder.map((item) => fields(item, ["role", "runtimeId", "model", "label", "exhausted", "current"])) : [],
      ...(row.conflict ? { conflict: fields(row.conflict, ["chatId", "title"]) } : {}) };
  }
  if ("limits" in value) result.limits = fields(value.limits, ["attemptTokenLimit", "dailyGoalTokenLimit", "min", "max"]);
  if ("view" in value) result.view = goalView(value.view);
  return result;
}

/** Mark altered fields so clients never silently write a redacted/truncated display value back. */
export function projectGoalControlValue(value: unknown): { value: MobileBridgeJsonValue; redactedFields: string[] } {
  const redactedFields: string[] = [];
  const visit = (item: unknown, path: string, depth: number): MobileBridgeJsonValue => {
    if (depth > 12) throw new Error("goal_control_projection_invalid");
    if (item === null) return null;
    if (typeof item === "string") {
      const safe = sanitizeMobileBridgeText(item, 48_000);
      if (safe !== item) redactedFields.push(path);
      return safe;
    }
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) return item;
    if (Array.isArray(item)) {
      if (item.length > 256) throw new Error("goal_control_projection_invalid");
      return item.map((child, index) => visit(child, `${path}[${index}]`, depth + 1));
    }
    if (item && typeof item === "object") {
      const out: Record<string, MobileBridgeJsonValue> = {};
      for (const [key, child] of Object.entries(item)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("goal_control_projection_invalid");
        if (child !== undefined) out[key] = visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
      return out;
    }
    throw new Error("goal_control_projection_invalid");
  };
  const projected = visit(value, "", 0);
  if (mobileBridgeJsonBytes(projected) > 192 * 1024) throw new Error("goal_control_projection_too_large");
  return { value: projected, redactedFields };
}

export class MobileGoalControl {
  constructor(private readonly hostId: string, private readonly services: MobileGoalControlServices) {}

  async request(method: MobileGoalControlMethod, params: Record<string, unknown>): Promise<MobileBridgeJsonValue> {
    const base = { schemaVersion: 1, hostId: this.hostId };
    const validation = validateMobileGoalControlParams(method, params);
    if (validation) return { ...base, ok: false, code: "invalid_params" };
    if (params.expectedHostId !== this.hostId) return { ...base, ok: false, code: "goal_control_host_changed" };
    const { expectedHostId: _host, ...input } = params;
    const chatId = typeof input.chatId === "string" ? input.chatId : null;
    const reply = (result: Record<string, unknown>): MobileBridgeJsonValue => {
      const projected = projectGoalControlValue(safeResult(result));
      return { ...base, ...(chatId ? { chatId } : {}), ...(projected.value as Record<string, MobileBridgeJsonValue>), redactedFields: projected.redactedFields };
    };
    try {
      if (chatId) {
        const surface = this.services.chatSurface(chatId);
        if (!surface) return reply({ ok: false, code: "goal_control_chat_unavailable" });
        if (input.surface !== undefined && input.surface !== surface) return reply({ ok: false, code: "alive-surface-mismatch" });
      }
      switch (method) {
        case "alive.getState": return reply({ ok: true, state: GOAL_CONTROL_ALIVE_STATE });
        case "alive.setEnabled":
        case "alive.setTokenLimit": return reply({ ok: false, code: GOAL_CONTROL_ALIVE_REMOVED_CODE, state: GOAL_CONTROL_ALIVE_STATE });
        case "agi.getTokenLimits": return reply({ ok: true, limits: GOAL_CONTROL_AGI_LIMITS });
        case "agi.setTokenLimits": return reply({ ok: false, code: GOAL_CONTROL_AGI_REMOVED_CODE, limits: GOAL_CONTROL_AGI_LIMITS });
        case "chats.pauseGoal":
        case "chats.deleteGoal": {
          const operation = method === "chats.pauseGoal" ? this.services.pauseGoal : this.services.deleteGoal;
          operation(chatId!, input.expectedGoalId as string);
          return reply({ ok: true, outcome: "applied", view: this.services.readGoalPanel(chatId!) });
        }
        case "chats.resumeGoal": {
          const outcome = await this.services.resumeGoal(chatId!, input.expectedGoalId as string);
          const view = this.services.readGoalPanel(chatId!);
          if (outcome === "no_run" || outcome === "not_stopped") {
            return reply({ ok: false, code: outcome === "no_run" ? "goal_resume_no_run" : "goal_resume_not_stopped", view });
          }
          return reply({ ok: true, outcome: "applied", view });
        }
        case "goalPanel.view": return reply({ ok: true, view: this.services.readGoalPanel(chatId!) });
        case "goalPanel.edit": return reply(this.services.editGoalPanel(input));
        case "goalPanel.shape": {
          const { done, ...result } = this.services.shapeGoalPanel(chatId!, input.expectedGoalId as string);
          // Main owns completion and change events. This acknowledgement never claims the plan is finished.
          if (done) void done.catch(() => undefined);
          return reply(result.ok ? { ...result, outcome: "accepted", pending: true, replayable: false } : result);
        }
      }
    } catch (error) {
      const raw = error && typeof error === "object" ? (error as { code?: unknown }).code : null;
      // A machine code thrown as the message (resume: long_run_resume_version_conflict, auto_goal_resume_attempt_live, ...)
      // is returned as is, so the phone can say what is true instead of a generic failure.
      const stopCode = error instanceof Error && /^[a-z][a-z0-9_]{2,80}(?::[a-z0-9_-]{1,40})?$/.test(error.message) ? error.message : null;
      const code = typeof raw === "string" && /^[a-z][a-z0-9_.:-]{2,100}$/.test(raw) ? raw : stopCode ?? "goal_control_failed";
      // A refusal is accompanied by a new authoritative read, never an optimistic echo of the requested edit.
      let current: Record<string, unknown> = {};
      try {
        if (method.startsWith("alive.") && chatId) current = { state: GOAL_CONTROL_ALIVE_STATE };
        else if ((method.startsWith("goalPanel.") || method.startsWith("chats.")) && chatId) current = { view: this.services.readGoalPanel(chatId) };
        else if (method.startsWith("agi.")) current = { limits: GOAL_CONTROL_AGI_LIMITS };
      } catch { /* The machine refusal remains honest even while the host is unavailable. */ }
      try { return reply({ ok: false, code, ...current }); }
      catch { return { ...base, ok: false, code: "goal_control_projection_invalid" }; }
    }
  }
}
