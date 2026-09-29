import type { AliveState } from "../../shared/alive";
import type { AgiTokenLimitsView } from "../../shared/agi";
import type { GoalPanelEditResult, GoalPanelView } from "../../shared/goal-panel";
import { validateMobileGoalControlParams, type MobileGoalControlMethod } from "../../shared/mobile-goal-control";
import type { MobileBridgeJsonValue } from "../../shared/mobile-bridge";
import { sanitizeMobileBridgeText, mobileBridgeJsonBytes } from "./sanitize";

/** Main-owned operations; no store, runtime, or IPC instance is created by the remote adapter. */
export interface MobileGoalControlServices {
  chatSurface(chatId: string): "one" | "work" | null;
  readAliveState(input: unknown): Promise<AliveState>;
  setAliveEnabled(input: unknown): Promise<AliveState>;
  setAliveTokenLimit(input: unknown): AliveState;
  getAgiTokenLimits(): AgiTokenLimitsView;
  setAgiTokenLimits(input: unknown): AgiTokenLimitsView;
  readGoalPanel(chatId: string): GoalPanelView | null;
  pauseGoal(chatId: string, expectedGoalId: string): void;
  deleteGoal(chatId: string, expectedGoalId: string): void;
  editGoalPanel(input: unknown): GoalPanelEditResult;
  shapeGoalPanel(chatId: string, expectedGoalId: string): GoalPanelEditResult & { done?: Promise<void> };
}

/** Lazy Main wiring keeps contract tests independent of Electron and of the owner's live database. */
export function desktopGoalControlServices(): MobileGoalControlServices {
  const alive = require("../alive-organisms") as typeof import("../alive-organisms");
  const goals = require("../long-run/goal-panel") as typeof import("../long-run/goal-panel");
  const { getChat } = require("../store/chats") as typeof import("../store/chats");
  const { isMobileBridgeOneChat } = require("./projector") as typeof import("./projector");
  const { invocationService } = require("../invocation/service") as typeof import("../invocation/service");
  return {
    ...alive,
    chatSurface(chatId) {
      const chat = getChat(chatId);
      if (!chat) return null;
      if (isMobileBridgeOneChat(chat)) return "one";
      return chat.originSurface === "work" || chat.projectId ? "work" : null;
    },
    readGoalPanel: goals.readGoalPanel,
    pauseGoal: (chatId, goalId) => invocationService.pauseGoal(chatId, goalId),
    deleteGoal: (chatId, goalId) => invocationService.deleteGoal(chatId, goalId),
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
function actions(value: unknown): unknown {
  if (value == null) return null;
  const row = fields(value, ["nodeId", "at", "text"]);
  return { ...row, text: text(row.text) };
}
function suggestions(value: unknown): unknown[] {
  return Array.isArray(value) ? value.map((row) => fields(row, ["id", "nodeId", "field", "text", "at"])) : [];
}
function node(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 2) throw new Error("goal_control_projection_invalid");
  const row = fields(value, ["id", "kind", "intent", "method", "doneWhen", "state", "stateReason", "current", "progress", "recurring", "runs", "ownerPaused", "agi", "suggestions", "children"]);
  return { ...row, method: text(row.method), stateReason: text(row.stateReason), progress: nullable(row.progress, ["done", "total"]),
    agi: actions(row.agi), suggestions: suggestions(row.suggestions), children: Array.isArray(row.children) ? row.children.map((child) => node(child, depth + 1)) : [] };
}
function goalView(value: unknown): unknown {
  if (value == null) return null;
  const row = fields(value, ["schemaVersion", "chatId", "goalId", "lifecycle", "revision", "plan", "planBehindRevision", "shape", "provisional", "state", "stateReason", "root", "deadlineAt", "budget", "pendingAmendments", "nodes", "agiWorking", "canShape", "shaping", "shapeFailed", "limits"]);
  const root = fields(row.root, ["intent", "intentFull", "ownerUpdates", "method", "diagnosis", "doneWhen", "progress", "agi", "suggestions"]);
  return { ...row, plan: nullable(row.plan, ["revision", "planSeq"]), stateReason: text(row.stateReason),
    root: { ...root, method: text(root.method), progress: nullable(root.progress, ["done", "total"]), agi: actions(root.agi), suggestions: suggestions(root.suggestions) },
    budget: fields(row.budget, ["maxCycles", "cycleCount", "maxCostUsd", "costUsedUsd", "wallclockDeadline"]),
    nodes: Array.isArray(row.nodes) ? row.nodes.map((child) => node(child)) : [], agiWorking: nullable(row.agiWorking, ["attempts"]), limits: fields(row.limits, ["strategies", "tactics"]) };
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
        case "alive.getState": return reply({ ok: true, state: await this.services.readAliveState(input) });
        case "alive.setEnabled": return reply({ ok: true, state: await this.services.setAliveEnabled(input) });
        case "alive.setTokenLimit": return reply({ ok: true, state: this.services.setAliveTokenLimit(input) });
        case "agi.getTokenLimits": return reply({ ok: true, limits: this.services.getAgiTokenLimits() });
        case "agi.setTokenLimits": return reply({ ok: true, limits: this.services.setAgiTokenLimits(input) });
        case "chats.pauseGoal":
        case "chats.deleteGoal": {
          const operation = method === "chats.pauseGoal" ? this.services.pauseGoal : this.services.deleteGoal;
          operation(chatId!, input.expectedGoalId as string);
          return reply({ ok: true, outcome: "applied", view: this.services.readGoalPanel(chatId!) });
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
      const stopCode = error instanceof Error && ["goal_control_binding_changed", "goal_control_scope_mismatch", "goal_control_not_started"].includes(error.message) ? error.message : null;
      const code = typeof raw === "string" && /^[a-z][a-z0-9_.:-]{2,100}$/.test(raw) ? raw : stopCode ?? "goal_control_failed";
      // A refusal is accompanied by a new authoritative read, never an optimistic echo of the requested edit.
      let current: Record<string, unknown> = {};
      try {
        if (method.startsWith("alive.") && chatId) current = { state: await this.services.readAliveState({ surface: input.surface, chatId }) };
        else if ((method.startsWith("goalPanel.") || method.startsWith("chats.")) && chatId) current = { view: this.services.readGoalPanel(chatId) };
        else if (method.startsWith("agi.")) current = { limits: this.services.getAgiTokenLimits() };
      } catch { /* The machine refusal remains honest even while the host is unavailable. */ }
      try { return reply({ ok: false, code, ...current }); }
      catch { return { ...base, ok: false, code: "goal_control_projection_invalid" }; }
    }
  }
}
