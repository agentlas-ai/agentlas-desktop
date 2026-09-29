/**
 * Real Main wiring of the AGI executor (P3) and its deterministic handler — every action goes through a path the
 * product already has. Kept out of monitor/actions so the contracts drive those with stubs.
 *
 * Seams owned by other work, never edited here:
 *  - login-recovery ladder (electron/browser/login-recovery.ts, being built by another agent): plugged with
 *    setAgiLoginRecoverySeam(fn). Until then run_login_recovery is refused as agi.login.ladder-unavailable, recorded, and
 *    the attempt moves on to the next alternative (never to the owner).
 *  - Agentlas Browser restart: setAgiBrowserRestartSeam(fn).
 */
import { randomUUID } from "node:crypto";
import { getDb } from "../store/db";
import { appendChatMessage } from "../store/chats";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, settleUncertainAttemptsByObservation } from "../store/long-runs";
import { readGoalPlan, updateGoalPlanNode, insertGoalPlanNode, recordGoalPlanDecision } from "../store/goal-plans";
import { recordPersistenceDecisionEvent } from "../store/run-events";
import { continueGoalForAlive } from "../long-run/blocked-goal-sweep";
import { invocationService } from "../invocation/service";
import { oneTeamCreateMember, oneTeamInvite, oneTeamList, oneTeamStartSession } from "../one/team-dispatch";
import { findAutomationByGoalId } from "../store/automations";
import { listInstalledServers } from "../mcp-tools/registry";
import { detectRuntimes } from "../runtime/detect";
import { pickRunner, runtimeForOwnerSelection } from "../runtime/selection";
import { noteRuntimeFailure } from "../runtime/runtime-cooldown";
import { runAliveServingDecision } from "../alive-organisms/serving-wake";
import { cachedAliveModelOrder } from "../alive-organisms/model-order";
import { callAgiReadTool } from "./read-tools";
import { AgiModelAttempt, type AgiModelCandidate } from "./model-attempt";
import { agiRestartAgentlasBrowser, agiRunLoginRecovery } from "./browser-seams";
import type { RuntimeSelection } from "../../shared/types";
import { currentUiLocale } from "../ui-locale";
import { PERSISTENCE_DECISION_SCHEMA, type FailureCauseKind } from "../../shared/persistence-policy";
import { AgiActionExecutor, type AgiExecutorDeps, type AgiGoalView, type AgiLoginRecoveryOutcome, type AgiPlanView } from "./actions";
import { createAgiDeterministicHandler, type AgiUnblockHandlerWithModel } from "./unblock-handler";

export const AGI_ACTION_NOTICE_AUTOMATION_ID = "agi-unblocker";

type LoginSeam = (input: { domain: string; goalId: string; runId: string; chatId: string | null }) => AgiLoginRecoveryOutcome | Promise<AgiLoginRecoveryOutcome>;
let loginSeam: LoginSeam | null = agiRunLoginRecovery;
let browserRestartSeam: (() => boolean | Promise<boolean>) | null = agiRestartAgentlasBrowser;
let defectListener: ((input: { defectId: string; goalId: string; chatId: string | null; code: string }) => void) | null = null;

/** The login-recovery ladder plugs in here (function seam; plan §3.5 run_login_recovery). */
export function setAgiLoginRecoverySeam(fn: LoginSeam | null): void { loginSeam = fn; }
/** The Agentlas Browser restart path plugs in here (D6: AGI may restart the browser, never the app). */
export function setAgiBrowserRestartSeam(fn: (() => boolean | Promise<boolean>) | null): void { browserRestartSeam = fn; }
/** The defect chip (D5) listens here. */
export function onAgiDefectFiled(fn: typeof defectListener): void { defectListener = fn; }

function goalPermission(goalId: string): AgiGoalView["permission"] {
  const refs = getChatGoalRevision(goalId)?.authorityRefs ?? [];
  for (const ref of [...refs].reverse()) {
    const match = /^invocation:[^:]+:permission:(read|write|full)$/.exec(ref);
    if (match) return match[1] as AgiGoalView["permission"];
  }
  return "read";
}

function planView(goalId: string): AgiPlanView | null {
  const plan = readGoalPlan(goalId);
  if (!plan) return null;
  return { revision: plan.revision, planSeq: plan.planSeq, tactics: plan.tactics.map((tactic) => ({ id: tactic.id, strategyId: tactic.strategy_id ?? null,
    status: tactic.status, ord: tactic.ord, description: tactic.description, doneWhen: tactic.done_when, failures: tactic.failures })) };
}

export function createAgiExecutor(): AgiActionExecutor {
  const deps: AgiExecutorDeps = {
    db: getDb(),
    now: Date.now,
    goal: (goalId) => {
      const run = getLongRunByGoalId(goalId);
      return run ? { goalId, runId: run.id, version: run.version, status: run.status, pauseReason: run.pauseReason, blockedReason: run.blockedReason,
        chatId: run.rootChatId, permission: goalPermission(goalId) } : null;
    },
    continueGoal: (runId, version) => continueGoalForAlive(runId, version, invocationService),
    settleUncertain: (runId, input) => {
      settleUncertainAttemptsByObservation(runId, { attemptIds: input.attemptIds, verdict: "done", evidence: input.evidence,
        observationInvocationRunId: input.evidenceRunId, observationDigest: `agi-evidence:${input.evidenceRunId}` });
    },
    // A later run in the goal's own chat with a successful outward tool call: run:<runId>[:tool:<name>].
    resolveEvidence: (goalId, ref) => {
      const match = /^run:([A-Za-z0-9._:-]{1,160}?)(?::tool:([a-z0-9._-]{1,80}))?$/i.exec(ref);
      const run = getLongRunByGoalId(goalId);
      if (!match || !run?.rootChatId) return null;
      const row = getDb().prepare(`SELECT run_id, json_extract(payload_json, '$.toolName') AS tool FROM run_events WHERE run_id = ? AND chat_id = ?
        AND kind = 'mcp_tool-use' AND COALESCE(json_extract(payload_json, '$.toolIsError'), 0) = 0
        ${match[2] ? "AND json_extract(payload_json, '$.toolName') LIKE ?" : ""} ORDER BY seq DESC LIMIT 1`)
        .get(...[match[1], run.rootChatId, ...(match[2] ? [`%${match[2]}%`] : [])]) as { run_id: string; tool: string } | undefined;
      return row ? { runId: row.run_id, summary: `later run ${row.run_id} recorded ${row.tool} without error` } : null;
    },
    team: {
      create: (chatId, permission, input) => {
        const made = oneTeamCreateMember({ chatId, permission }, { ...input, invite: true }) as { member_id: string; created?: boolean };
        return { memberId: made.member_id, created: made.created === true };
      },
      invite: (chatId, permission, member) => {
        const joined = oneTeamInvite({ chatId, permission }, { member }) as { member_id: string; name?: string; already_member?: boolean };
        return { memberId: joined.member_id, joined: joined.already_member !== true, ...(joined.name ? { memberName: joined.name } : {}) };
      },
      dispatch: (chatId, permission, input) => {
        const session = oneTeamStartSession({ chatId, permission }, { member: input.member, brief: input.brief }) as { session_id: string; teammate?: string };
        return { sessionId: session.session_id, ...(session.teammate ? { memberName: session.teammate } : {}) };
      },
    },
    plan: {
      read: planView,
      apply: (goalId, plan, ops) => {
        const key = { goalId, revision: plan.revision, planSeq: plan.planSeq };
        for (const op of ops) {
          if (op.op === "retire") updateGoalPlanNode(key, op.nodeId, { status: "retired" });
          else if (op.op === "reorder") updateGoalPlanNode(key, op.nodeId, { ord: op.ord });
          else if (op.op === "merge") for (const id of op.retire) updateGoalPlanNode(key, id, { status: "retired", payload: { mergedInto: op.keep } });
          else if (op.op === "split") {
            const parent = plan.tactics.find((tactic) => tactic.id === op.nodeId)!;
            op.into.forEach((part, index) => insertGoalPlanNode(key, { nodeId: `${op.nodeId}.${index + 1}`, kind: "tactic", parentId: parent.strategyId,
              status: "active", ord: parent.ord * 10 + index + 1,
              // The end state (done_when) is the parent's: a split changes the method, never the intent (R9).
              payload: { description: part.description.slice(0, 400), done_when: parent.doneWhen, kind: "one_off", splitFrom: op.nodeId } }));
            updateGoalPlanNode(key, op.nodeId, { status: "retired", payload: { splitInto: op.into.length } });
          }
        }
        recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "plan_op", createdAt: new Date().toISOString(),
          payload: { actor: "agi-unblocker", ops } });
      },
    },
    recordMove: (goalId, runId, move, detail) => recordAgiMove(goalId, runId, move, detail),
    installedPaths: () => agiInstalledPaths(),
    runLoginRecovery: (input) => loginSeam ? loginSeam(input) : "unavailable",
    restartAgentlasBrowser: () => browserRestartSeam ? browserRestartSeam() : false,
    announce: ({ chatId, actionId, text }) => {
      const runId = `agi-action:${actionId}`;
      const already = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND host_notice_json LIKE ? LIMIT 1")
        .get(chatId, `%"runId":${JSON.stringify(runId)}%`);
      if (already) return;
      appendChatMessage(chatId, "system", `AGI\n\n${currentUiLocale() === "ko" ? text.ko : text.en}`, {
        hostNotice: { purpose: "automation-report", runId, automationId: AGI_ACTION_NOTICE_AUTOMATION_ID },
      });
      emitDesktopStoreChange({ entity: "chat", id: chatId });
    },
    onDefectFiled: (input) => { defectListener?.(input); if (input.chatId) emitDesktopStoreChange({ entity: "chat", id: input.chatId }); },
  };
  return new AgiActionExecutor(deps);
}

/** Tool paths retry_node_with may name: enabled installed MCP servers plus the built-in surfaces. */
export function agiInstalledPaths(): string[] {
  let servers: string[] = [];
  try { servers = listInstalledServers().filter((server) => server.enabled).map((server) => server.id); } catch { servers = []; }
  return [...new Set(["agentlas-browser", "computer-use", "shell", ...servers])];
}

/**
 * switch_runtime / switch_tool must change what the NEXT turn does (not just be written down):
 *  - switch_runtime is recorded exactly as the scheduler's own persistence decision on the goal's continuation
 *    automation (surface automation, ownerLayer scheduler, sourceRunId = its latest run_history row), which
 *    planAutomationRuntimeForRun → persistenceSwitchFor already reads and turns into a handoff to the next pool
 *    member. A goal without a continuation automation has no next scheduled turn to switch: refused, so the model
 *    picks another path instead of believing a no-op worked.
 *  - switch_tool writes the chosen installed path into the tactic's guidance, which buildGoalPlanTurnContext puts in
 *    the next turn's plan context ("use <path> for this tactic now").
 */
export function recordAgiMove(goalId: string, runId: string, move: "switch_runtime" | "switch_tool", detail: Record<string, unknown>):
  { ok: true } | { ok: false; code: string } {
  const run = getLongRunByGoalId(goalId);
  if (move === "switch_tool") {
    const plan = planView(goalId);
    if (!plan || typeof detail.nodeId !== "string" || !plan.tactics.some((tactic) => tactic.id === detail.nodeId)) return { ok: false, code: "agi.retry.node-unknown" };
    updateGoalPlanNode({ goalId, revision: plan.revision, planSeq: plan.planSeq }, detail.nodeId,
      { payload: { guidance: { move: "switch_tool", cause: "tool_missing", at: null, boundary: null, path: String(detail.path ?? "") }, deferredUntil: null } });
    recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", createdAt: new Date().toISOString(),
      payload: { tacticId: detail.nodeId, status: "switch_tool", path: detail.path ?? null, actor: "agi-unblocker", runId } });
    return { ok: true };
  }
  const automation = findAutomationByGoalId(goalId);
  const latest = automation ? getDb().prepare("SELECT id FROM run_history WHERE automation_id = ? ORDER BY ran_at DESC, rowid DESC LIMIT 1")
    .get(automation.id) as { id: string } | undefined : undefined;
  if (!automation || !latest) return { ok: false, code: "agi.move.no-continuation-automation" };
  recordPersistenceDecisionEvent({ runId: `agi-move:${randomUUID()}`, automationId: automation.id, chatId: run?.rootChatId ?? null, payload: {
    schemaVersion: PERSISTENCE_DECISION_SCHEMA, surface: "automation", sourceRunId: latest.id,
    cause: "runtime_unavailable" as FailureCauseKind, causeBoundary: null, causeRetryAfterAt: null,
    move: "switch_runtime", moveAt: null, moveBoundary: null, moveReason: `agi:${String(detail.incidentId ?? "")}`.slice(0, 160),
    reasonCode: "ladder", sameMoveCount: 1, ladderStep: -1, ownerLayer: "scheduler" } });
  return { ok: true };
}

/** D4: the goal's own runtime (its latest controller attempt) first, then the owner's role-pool order. */
async function agiModelCandidates(goalId: string): Promise<AgiModelCandidate[]> {
  const out: AgiModelCandidate[] = [];
  const run = getLongRunByGoalId(goalId);
  if (run) {
    const row = getDb().prepare(`SELECT a.runtime_selection_json FROM long_run_worker_attempts a JOIN long_run_workers w ON w.id = a.worker_id
      WHERE a.run_id = ? AND w.role = 'controller' ORDER BY a.started_at DESC LIMIT 1`).get(run.id) as { runtime_selection_json: string } | undefined;
    if (row) {
      try {
        const selection = JSON.parse(row.runtime_selection_json) as RuntimeSelection;
        const status = runtimeForOwnerSelection(await detectRuntimes(), selection);
        if (status && selection.model) out.push({ selection, status, label: status.label ?? status.kind, source: "goal" });
      } catch { /* an unreadable binding falls to the pool */ }
    }
  }
  for (const entry of cachedAliveModelOrder()) {
    if (entry.exhausted || !entry.selection || !entry.status || !entry.selection.model) continue;
    if (out.some((candidate) => candidate.status.kind === entry.status!.kind && candidate.selection.model === entry.selection!.model)) continue;
    out.push({ selection: entry.selection, status: entry.status, label: entry.label, source: "pool" });
  }
  return out.slice(0, 3);
}

function mainLogPath(): string | null {
  try {
    const { app } = require("electron") as typeof import("electron");
    return require("node:path").join(app.getPath("logs"), "main.log") as string;
  } catch { return null; }
}

export function createAgiHandler(): AgiUnblockHandlerWithModel {
  const executor = createAgiExecutor();
  const model = new AgiModelAttempt({
    db: getDb(), now: Date.now, executor,
    candidates: agiModelCandidates,
    // The Agentlas-served runtime gets the decision-only serving call; every CLI runtime its judgment no-tools path.
    pickRunner: (status) => status.kind === "agentlas" ? { runner: runAliveServingDecision, label: "Agentlas" } : pickRunner(status),
    noteFailure: (status, failure) => { noteRuntimeFailure(status, failure); },
    read: (goalId, tool, args) => callAgiReadTool({ db: getDb(), mainLogPath: mainLogPath(),
      teamRoster: (chatId) => oneTeamList({ chatId, permission: "read" }) }, { goalId }, tool, args),
    installedPaths: agiInstalledPaths,
  });
  return createAgiDeterministicHandler(executor, undefined, model);
}
