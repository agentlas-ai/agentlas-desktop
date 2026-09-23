import type { ChatContinuitySnapshot, RuntimeSelection } from "../../shared/types";
import { decodeRuntimeEvidence } from "../../shared/runtime-evidence";
import { getDb } from "../store/db";
import { getChatGoalContract, getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId } from "../store/long-runs";
import { getAutomation, getAutomationLiveRunId, getAutomationLiveRunState } from "../store/automations";
import { latestGoalWaitSubscription } from "./wait-subscriptions";
import { isGoalObserving } from "./effect-observation-tickets";
import { getGoalRuntimeSelectionEvidence } from "./runtime-handoff";
import { latestRuntimePlan } from "./plan";
import { isCurrentGoalAutomationBinding } from "./automation-provenance";

type EventRow = { id: string; run_id: string; seq: number; kind: string; ts: string; payload_json: string };
type AutomationRow = { id: string; goal_id: string | null; enabled: number; next_run_at: string | null };
type AutomationRunRow = { id: string; status: string; started_at: string | null; last_activity_at: string | null };

function code(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^(?:verification|runtime|goal|checkpoint|budget|stall|effect|usage|approval|user|app|worker|model|provider|control)[_-][a-z0-9_-]{1,95}$/.test(value)
    ? value : "goal_blocked_unclassified";
}

function publicModel(value: RuntimeSelection | null): { kind: string; backend: string | null; model: string | null; effort: string | null } | null {
  return value ? { kind: value.kind, backend: value.backend ?? null, model: value.model ?? null, effort: value.effort ?? null } : null;
}

function selectedModel(row: EventRow | undefined, runId: string): { kind: string; backend: string | null; model: string | null } | null {
  if (!row) return null;
  try {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    const evidence = decodeRuntimeEvidence(payload.runtimeEvidence);
    if (payload.eventKind !== "runtime-selected" || payload.runtimeRole !== "orchestrator"
      || evidence?.sourceEventId !== row.id || evidence.phase !== "observed"
      || evidence.correlation.invocationRunId !== runId
      || typeof payload.runtimeKind !== "string" || !payload.runtimeKind.trim()) return null;
    return { kind: payload.runtimeKind,
      backend: typeof payload.runtimeBackend === "string" ? payload.runtimeBackend : null,
      model: typeof payload.runtimeModel === "string" ? payload.runtimeModel : null };
  } catch { return null; }
}

function phase(kind: string, terminal: boolean): NonNullable<ChatContinuitySnapshot["invocation"]>["phase"] {
  if (terminal) return "terminal";
  if (kind === "invoke_started") return "started";
  if (kind === "runtime_selection") return "runtime_selected";
  if (kind.includes("tool") || kind.includes("approval")) return "tool_activity";
  if (kind.includes("partial") || kind.includes("thinking") || kind.includes("usage")) return "model_activity";
  return "other_activity";
}

/** A synchronous Main-owned observation. All durable rows come from one SQLite
 * read transaction. In-memory liveness is supplied separately by Main, so a
 * stale invoke_started row is never promoted to a claim that AI is running. */
export function getChatContinuitySnapshot(chatId: string, hostActiveRunId: string | null, now = new Date()): ChatContinuitySnapshot | null {
  if (!chatId.trim()) return null;
  return getDb().transaction(() => {
    const db = getDb();
    const chat = db.prepare("SELECT id, goal_id FROM chats WHERE id=?").get(chatId) as { id: string; goal_id: string | null } | undefined;
    if (!chat) return null;
    const observedAt = now.toISOString();
    const goalId = chat.goal_id;
    const revision = goalId ? getChatGoalRevision(goalId) : null;
    const contract = goalId ? getChatGoalContract(goalId) : null;
    const run = goalId ? getLongRunByGoalId(goalId) : null;
    const wait = goalId && revision ? latestGoalWaitSubscription(goalId) : null;
    const boundWait = wait && wait.chatId === chat.id && wait.goalRevision === revision?.revision ? wait : null;
    const plan = run && revision ? latestRuntimePlan(run.id) : null;
    const strategy = plan && revision && plan.goalRevision === revision.revision
      && plan.episodeStrategy?.goalRevision === revision.revision ? plan.episodeStrategy : null;
    const goal: ChatContinuitySnapshot["goal"] = goalId ? {
      goalId, lifecycle: revision?.lifecycle ?? null, goalRevision: revision?.revision ?? null,
      contractStatus: contract?.status ?? null, runId: run?.id ?? null, runStatus: run?.status ?? null,
      runVersion: run?.version ?? null, blockedReason: code(run?.blockedReason), eventSeq: run?.lastEventSeq ?? null,
      episodeStrategy: strategy && plan ? { planRevision: plan.revision, state: strategy.state,
        nextAction: strategy.nextAction, reasonCode: strategy.reasonCode, metrics: strategy.metrics,
        nextWakeAt: strategy.nextWakeAt } : null,
      wait: boundWait ? { waitId: boundWait.waitId, state: boundWait.state, subjectKind: boundWait.intent.subject.kind,
        nextCheckAt: boundWait.nextCheckAt, executionAvailability: "app-running" } : null,
      effectObservation: isGoalObserving(goalId) ? "checking" : null,
    } : null;

    const start = db.prepare(`SELECT id, run_id, seq, kind, ts, payload_json FROM run_events
      WHERE chat_id=? AND kind='invoke_started' ORDER BY ts DESC, rowid DESC LIMIT 1`)
      .get(chat.id) as EventRow | undefined;
    let invocation: ChatContinuitySnapshot["invocation"] = null;
    let lastDurableAt: string | null = null;
    if (start) {
      const latest = db.prepare("SELECT id, run_id, seq, kind, ts, payload_json FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1")
        .get(start.run_id) as EventRow | undefined;
      const terminal = db.prepare(`SELECT id, run_id, seq, kind, ts, payload_json FROM run_events WHERE run_id=?
        AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted')
        ORDER BY seq DESC LIMIT 1`).get(start.run_id) as EventRow | undefined;
      const modelEvent = db.prepare(`SELECT id, run_id, seq, kind, ts, payload_json FROM run_events WHERE run_id=?
        AND kind='runtime_selection' AND node_id IS NULL ORDER BY seq DESC LIMIT 1`)
        .get(start.run_id) as EventRow | undefined;
      const last = latest ?? start;
      const isTerminal = Boolean(terminal);
      const exactGoalAttempt = run && db.prepare(`SELECT 1 FROM long_run_worker_attempts
        WHERE run_id=? AND invocation_run_id=? LIMIT 1`).get(run.id, start.run_id);
      invocation = { runId: start.run_id, state: isTerminal ? "terminal" : hostActiveRunId === start.run_id ? "active" : "unconfirmed",
        relationship: exactGoalAttempt ? "goal-bound" : "unverified",
        phase: phase(last.kind, isTerminal), startedAt: start.ts, phaseAt: last.ts,
        lastEventSeq: last.seq, model: selectedModel(modelEvent, start.run_id) };
      lastDurableAt = last.ts;
    }

    // Goal-bound and exact-origin monitors belong here. Other automations are
    // omitted even if they share a model, agent or similar-looking prompt.
    const candidates = db.prepare(`SELECT id, goal_id, enabled, next_run_at FROM automations
      WHERE (goal_id IS NOT NULL AND goal_id = ?)
        OR (CASE WHEN json_valid(trigger_json) THEN json_extract(trigger_json,'$.monitor.originChatId') = ? ELSE 0 END)
        OR id IN (SELECT automation_id FROM automation_sessions WHERE ledger_chat_id = ?)
      ORDER BY COALESCE(last_run_at,next_run_at,created_at) DESC, id DESC LIMIT 8`)
      .all(goalId, chat.id, chat.id) as AutomationRow[];
    const automations: ChatContinuitySnapshot["automations"] = candidates.flatMap(row => {
      const automation = getAutomation(row.id);
      const goalBound = Boolean(goalId && revision && isCurrentGoalAutomationBinding({
        goalId, expectedGoalRevision: revision.revision, chatId: chat.id, automationId: row.id,
      }));
      const goalDeclared = Boolean(goalId && row.goal_id === goalId);
      const exactOrigin = automation?.monitor?.originChatId === chat.id;
      const exactSession = Boolean(db.prepare("SELECT 1 FROM automation_sessions WHERE automation_id=? AND ledger_chat_id=? LIMIT 1")
        .get(row.id, chat.id));
      if (!goalBound && !goalDeclared && !exactOrigin && !exactSession) return [];
      const liveState = getAutomationLiveRunState(row.id, now);
      const liveRunId = liveState ? getAutomationLiveRunId(row.id) : null;
      const recent = db.prepare(`SELECT id, status, started_at, last_activity_at FROM automation_runs
        WHERE automation_id=? ORDER BY started_at DESC, rowid DESC LIMIT 1`).get(row.id) as AutomationRunRow | undefined;
      const current = liveState === "running" && liveRunId
        ? db.prepare("SELECT id, status, started_at, last_activity_at FROM automation_runs WHERE id=? AND automation_id=?")
          .get(liveRunId, row.id) as AutomationRunRow | undefined : undefined;
      const observed = current ?? recent;
      const lastRunStatus = observed?.status === "running" || observed?.status === "ok" || observed?.status === "error"
        ? observed.status : null;
      return [{ automationId: row.id, relationship: goalBound ? "goal-bound" as const
        : goalDeclared ? "unverified" as const : "independent" as const,
        goalId: row.goal_id, enabled: row.enabled === 1, liveState, runId: liveRunId,
        liveStateEvidence: liveState === "running" ? "recent-durable-run" as const
          : liveState === "queued" ? "scheduler-lease" as const : null,
        startedAt: observed?.started_at ?? null, lastActivityAt: observed?.last_activity_at ?? null,
        nextRunAt: automation?.nextRunAt ?? row.next_run_at, lastRunStatus }];
    });

    const handoff = goalId ? getGoalRuntimeSelectionEvidence(chat.id, goalId) : null;
    const modelHandoff: ChatContinuitySnapshot["modelHandoff"] = handoff ? {
      selectionRevision: handoff.selectionRevision, state: handoff.state,
      requested: publicModel(handoff.requested)!, effective: publicModel(handoff.effective),
    } : null;
    if (run) {
      const event = db.prepare("SELECT occurred_at FROM long_run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1")
        .get(run.id) as { occurred_at: string } | undefined;
      if (event?.occurred_at && (!lastDurableAt || Date.parse(event.occurred_at) > Date.parse(lastDurableAt))) lastDurableAt = event.occurred_at;
    }
    for (const row of automations) {
      if (row.lastActivityAt && (!lastDurableAt || Date.parse(row.lastActivityAt) > Date.parse(lastDurableAt))) lastDurableAt = row.lastActivityAt;
    }
    const elapsed = lastDurableAt ? Math.max(0, now.getTime() - Date.parse(lastDurableAt)) : null;
    return { schemaVersion: "agentlas.continuity-snapshot.v1" as const, chatId: chat.id, observedAt, source: "main-store" as const,
      hostActiveChat: Boolean(hostActiveRunId), freshness: { lastDurableEventAt: lastDurableAt, elapsedMs: elapsed !== null && Number.isFinite(elapsed) ? elapsed : null },
      goal, invocation, automations, modelHandoff };
  })();
}
