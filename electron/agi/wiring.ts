import { captureAgiDecisionControl, assertAgiDecisionControl, releaseAgiDecisionControl, AGI_DECISION_CONTROL_CHANGED } from "./decision-control";
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
import { captureGoalEpisode, applyGoalEpisodeRest, drainGoalEpisodeNotices } from "../long-run/episode-disposition";
import { captureGoalStrategyEpisode, prepareGoalStrategyEpisode, commitGoalStrategyEpisode, type StrategyReorder,
  type PreparedGoalStrategyEpisode } from "../long-run/strategy-episode";
import type { GoalWaitIntent } from "../long-run/wait-emitter";
import { registerGoalWaitSubscription } from "../long-run/wait-subscriptions";
import { getDb } from "../store/db";
import { appendChatMessage } from "../store/chats";
import { reportHostAlertToOne } from "../one/host-alerts";
import { canonicalAskFenceText } from "../../shared/ask-fence-flatten";
import { agiOwnerAskCard } from "./owner-ask-card";
import { reportOwnerAsk } from "../owner-ask-alerts";
import { emitDesktopStoreChange } from "../store/change-bus";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId } from "../store/long-runs";
import { readGoalPlan, updateGoalPlanNode, insertGoalPlanNode, recordGoalPlanDecision } from "../store/goal-plans";
import { activeNativeHarness } from "../long-run/goal-shaping";
import { recordPersistenceDecisionEvent } from "../store/run-events";
import { aliveGoalContinuationRefusal, continueGoalForAlive } from "../long-run/blocked-goal-sweep";
import { hostGoalWake } from "../long-run/wake-arbiter";
import { invocationService } from "../invocation/service";
import { oneTeamCreateMember, oneTeamDispatchAllowedFor, oneTeamInvite, oneTeamList, oneTeamStartSession } from "../one/team-dispatch";
import { listInstalledServers } from "../mcp-tools/registry";
import { detectRuntimes } from "../runtime/detect";
import { pickRunner, runtimeForOwnerSelection } from "../runtime/selection";
import { noteRuntimeFailure } from "../runtime/runtime-cooldown";
import { runAliveServingDecision } from "../alive-organisms/serving-wake";
import { freshAliveModelOrder, type AliveModelOrderEntry } from "../alive-organisms/model-order";
import { callAgiReadTool } from "./read-tools";
import { AgiModelAttempt, type AgiModelCandidate } from "./model-attempt";
import { agiRestartAgentlasBrowser, agiRunLoginRecovery } from "./browser-seams";
import type { RuntimeSelection } from "../../shared/types";
import { runtimeRequestRefusal } from "../../shared/runtime-capabilities";
import { currentUiLocale } from "../ui-locale";
import { PERSISTENCE_DECISION_SCHEMA, type FailureCauseKind } from "../../shared/persistence-policy";
import { AgiActionExecutor, type AgiExecutorDeps, type AgiGoalView, type AgiLoginRecoveryOutcome, type AgiLoginRecoveryControl, type AgiLoginRecoveryResult, type AgiPlanView, type AgiStrategyBatch } from "./actions";
import { createAgiDeterministicHandler, type AgiUnblockHandlerWithModel } from "./unblock-handler";
import { goalControllerAttempt, goalRuntimeSwitchTarget, type AgiTurnReceipt } from "./goal-facts";

export { AGI_ACTION_NOTICE_AUTOMATION_ID } from "../../shared/chat-host-notice";
import { AGI_ACTION_NOTICE_AUTOMATION_ID } from "../../shared/chat-host-notice";

type LoginSeam = (input: { domain: string; goalId: string; runId: string; chatId: string | null }, control?: AgiLoginRecoveryControl) => AgiLoginRecoveryOutcome | AgiLoginRecoveryResult | Promise<AgiLoginRecoveryOutcome | AgiLoginRecoveryResult>;
let loginSeam: LoginSeam | null = agiRunLoginRecovery;
let browserRestartSeam: AgiExecutorDeps["restartAgentlasBrowser"] | null = agiRestartAgentlasBrowser;
let defectListener: ((input: { defectId: string; goalId: string; chatId: string | null; code: string }) => void) | null = null;

/** The login-recovery ladder plugs in here (function seam; plan §3.5 run_login_recovery). */
export function setAgiLoginRecoverySeam(fn: LoginSeam | null): void { loginSeam = fn; }
/** The Agentlas Browser restart path plugs in here (D6: AGI may restart the browser, never the app). */
export function setAgiBrowserRestartSeam(fn: AgiExecutorDeps["restartAgentlasBrowser"] | null): void { browserRestartSeam = fn; }
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

/**
 * The Goal's own controller turn, read live: the episode baseline an AGI rest or strategy captures must name the run
 * the monitor reads later, never the room's newest run (a teammate's report turn, an owner side question; ID-2).
 */
function goalTurnReceipt(goalId: string): AgiTurnReceipt | null {
  const run = getLongRunByGoalId(goalId);
  const runId = run ? goalControllerAttempt(getDb(), run.id)?.invocationRunId : null;
  const receipt = runId ? invocationService.receipt(runId) : null;
  return receipt ? { runId: receipt.runId, status: receipt.status, errorCode: receipt.errorCode ?? null } : null;
}

function planView(goalId: string): AgiPlanView | null {
  const plan = readGoalPlan(goalId);
  if (!plan) return null;
  return { revision: plan.revision, planSeq: plan.planSeq, tactics: plan.tactics.map((tactic) => ({ id: tactic.id, strategyId: tactic.strategy_id ?? null,
    status: tactic.status, ord: tactic.ord, description: tactic.description, doneWhen: tactic.done_when, failures: tactic.failures })) };
}

function strategyBatchInput(batch: AgiStrategyBatch): { captureId: string; op: StrategyReorder; intent: GoalWaitIntent } {
  const plan = batch.plan.args, rest = batch.rest.args;
  if (!plan || Object.keys(plan).join(",") !== "ops" || !Array.isArray(plan.ops) || plan.ops.length !== 1
    || !rest || Object.keys(rest).sort().join(",") !== "reason,untilIso" || typeof rest.untilIso !== "string"
    || !Number.isFinite(Date.parse(rest.untilIso)) || Date.parse(rest.untilIso) <= Date.now()
    || typeof rest.reason !== "string" || !rest.reason.trim() || rest.reason.length > 1000
    || !batch.plan.episodeCaptureId) throw new Error("goal_strategy_args_invalid");
  const op = plan.ops[0];
  if (!op || typeof op !== "object" || Array.isArray(op) || Object.keys(op).sort().join(",") !== "nodeId,op,ord"
    || op.op !== "reorder" || typeof op.nodeId !== "string" || !Number.isSafeInteger(op.ord)) throw new Error("goal_strategy_ops_invalid");
  return { captureId: batch.plan.episodeCaptureId, op,
    intent: { schemaVersion: "agentlas.goal-wait-intent.v1", subject: { kind: "timer", notBefore: rest.untilIso },
      condition: "due", nextAction: rest.reason, deadline: null } };
}

export function createAgiExecutor(): AgiActionExecutor {
  const deps: AgiExecutorDeps = {
    db: getDb(),
    now: Date.now,
    captureEpisode: (captureId, goalId) => {
      captureGoalEpisode({ captureId, goalId });
      captureGoalStrategyEpisode(captureId, goalId);
    },
    strategy: {
      prepare: (batch, decision) => prepareGoalStrategyEpisode(strategyBatchInput(batch),decision),
      commit: (batch, prepared, decision) => commitGoalStrategyEpisode({ ...strategyBatchInput(batch), requestId: batch.rest.actionId,
        prepared: prepared as PreparedGoalStrategyEpisode, latestReceipt: () => goalTurnReceipt(batch.rest.fence.goalId) },decision),
    },
    rest: request => {
      const until = request.args?.untilIso, reason = request.args?.reason;
      const intent = typeof until === "string" && Number.isFinite(Date.parse(until)) && typeof reason === "string" && reason.trim()
        ? { schemaVersion: "agentlas.goal-wait-intent.v1" as const, subject: { kind: "timer" as const, notBefore: until },
          condition: "due" as const, nextAction: reason.slice(0, 1000), deadline: null } : null;
      return applyGoalEpisodeRest({ requestId: request.actionId, captureId: request.episodeCaptureId ?? `unavailable:${request.actionId}`,
        goalId: request.fence.goalId, intent, refusal: request.episodeRefusal,
        latestReceipt: () => goalTurnReceipt(request.fence.goalId),
      }, registerGoalWaitSubscription);
    },
    afterRest: drainGoalEpisodeNotices,
    goal: (goalId) => {
      const run = getLongRunByGoalId(goalId);
      return run ? { goalId, runId: run.id, version: run.version, status: run.status, pauseReason: run.pauseReason, blockedReason: run.blockedReason,
        chatId: run.rootChatId, permission: goalPermission(goalId) } : null;
    },
    continueGoal: (runId, version) => continueGoalForAlive(runId, version, invocationService),
    continuationRefusal: (runId, version) => aliveGoalContinuationRefusal(runId, version),
    team: {
      available: (chatId) => oneTeamDispatchAllowedFor(chatId),
      create: (chatId, permission, input) => {
        const made = oneTeamCreateMember({ chatId, permission }, { ...input, invite: true }) as { member_id: string; created?: boolean };
        return { memberId: made.member_id, created: made.created === true };
      },
      invite: (chatId, permission, member) => {
        const joined = oneTeamInvite({ chatId, permission }, { member }) as { member_id: string; name?: string; already_member?: boolean };
        return { memberId: joined.member_id, joined: joined.already_member !== true, ...(joined.name ? { memberName: joined.name } : {}) };
      },
      dispatch: (chatId, permission, input) => {
        // A teammate session the AGI starts is a host start for the Goal: the wake budget answers first (owner first, 48 a day).
        // The session runs at the cap the executor passes (write), never at One's full delegation default (team-dispatch.ts).
        const start = () => oneTeamStartSession({ chatId, permission }, { member: input.member, brief: input.brief }, { delegationPermission: input.delegationPermission }) as
          { session_id: string; teammate?: string; already_started?: boolean };
        const session = input.runId
          ? hostGoalWake({ runId: input.runId, chatId, source: "agi", cause: `teammate:${input.member}` }, start, (made) => made.already_started !== true)
          : start();
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
    canSwitchRuntime: (goalId) => { const target = goalRuntimeSwitchTarget(getDb(), goalId); return target === undefined ? undefined : target !== null; },
    recordMove: (goalId, runId, move, detail) => recordAgiMove(goalId, runId, move, detail),
    installedPaths: () => agiInstalledPaths(),
    runLoginRecovery: (input, control) => loginSeam ? loginSeam(input, control) : "unavailable",
    restartAgentlasBrowser: (control) => browserRestartSeam ? browserRestartSeam(control) : false,
    announce: ({ chatId, actionId, text, card }) => {
      const runId = `agi-action:${actionId}`;
      const already = getDb().prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND host_notice_json LIKE ? LIMIT 1")
        .get(chatId, `%"runId":${JSON.stringify(runId)}%`);
      if (already) return;
      // One line, not a report card with a separate "AGI" name line (soak 1.2.50 owner screenshot).
      appendChatMessage(chatId, "system", currentUiLocale() === "ko" ? text.ko : text.en, {
        hostNotice: { purpose: "automation-report", runId, automationId: AGI_ACTION_NOTICE_AUTOMATION_ID },
      });
      // An ask to the owner is a decision card, never a line alone (owner 2026-10-20: "묻는건 무조건 카드로 주고 알림
      // 울리게해"). The line above explains; the card is how the owner answers, from the desktop or the phone, and it rings
      // like a model-authored card (desktop run alert, phone push). Guarded by the line's own idempotency above.
      if (card) {
        // noGoalResult: a host-written card is not the Goal's answer, so it must never wait for a verification verdict.
        appendChatMessage(chatId, "assistant", canonicalAskFenceText([agiOwnerAskCard(card, currentUiLocale() === "ko" ? "ko" : "en")]), { noGoalResult: true });
        reportOwnerAsk({ chatId, source: "agi", key: runId });
      }
      emitDesktopStoreChange({ entity: "chat", id: chatId });
    },
    onDefectFiled: (input) => {
      defectListener?.(input);
      if (input.chatId) {
        emitDesktopStoreChange({ entity: "chat", id: input.chatId });
        // The monitor found this Goal stuck on an app defect and filed a report: One tells the owner (owner 2026-10-05).
        reportHostAlertToOne({ chatId: input.chatId, code: `agi:${input.code}`,
          detail: currentUiLocale() === "ko"
            ? `앱 점검이 이 방의 목표가 앱 결함으로 막힌 것을 발견해 결함 보고를 보냈습니다(${input.code}). 앱이 우회 방법을 시도합니다.`
            : `The app's monitor found this conversation's Goal stuck on an app defect and filed a report (${input.code}). The app is trying a workaround.` });
      }
    },
  };
  const executor = new AgiActionExecutor(deps);
  // A claim an earlier process left (it died between claiming an action and settling it) would block that action for the Goal for ever.
  // Only a claim older than this process AND older than two minutes is dead: the Alive domain moves between Main and the background
  // service, and the other side may still be inside an action it claimed a moment ago.
  try { executor.settleInterruptedClaims(Math.min(Date.now() - Math.round(process.uptime() * 1000), Date.now() - 120_000)); } catch (error) { console.warn("[agi] interrupted claims not settled:", error); }
  return executor;
}

/** Tool paths retry_node_with may name: enabled installed MCP servers plus the built-in surfaces. */
export function agiInstalledPaths(): string[] {
  let servers: string[] = [];
  try { servers = listInstalledServers().filter((server) => server.enabled).map((server) => server.id); } catch { servers = []; }
  return [...new Set(["agentlas-browser", "computer-use", "shell", ...servers])];
}

/**
 * switch_runtime / switch_tool must change what the NEXT turn does (not just be written down):
 *  - switch_runtime is recorded exactly as the scheduler's own persistence decision on a live automation of the goal
 *    (surface automation, ownerLayer scheduler, sourceRunId = its latest run_history row), which
 *    planAutomationRuntimeForRun → persistenceSwitchFor already reads and turns into a handoff to the next pool
 *    member. Since 034d8584e a Goal's own next turn is woken by the host and no continuation row exists (the legacy rows
 *    are retired history, never a target), so for a Goal there is normally nothing to switch: refused with a typed code,
 *    and the classifier does not propose it (goal-facts goalRuntimeSwitchTarget → continuationAutomation false).
 *  - switch_tool writes the chosen installed path into the tactic's guidance, which buildGoalPlanTurnContext puts in
 *    the next turn's plan context ("use <path> for this tactic now").
 */
export function recordAgiMove(goalId: string, runId: string, move: "switch_runtime" | "switch_tool" | "native_harness", detail: Record<string, unknown>):
  { ok: true } | { ok: false; code: string } {
  const run = getLongRunByGoalId(goalId);
  if (move === "native_harness") {
    // The plan context of every turn carries a live harness notice (goal-shaping activeNativeHarness); without a plan
    // there is no turn context to carry it.
    const plan = planView(goalId);
    if (!plan) return { ok: false, code: "agi.harness.plan-missing" };
    const capability = String(detail.capability ?? "tool");
    if (activeNativeHarness(goalId, plan.revision, plan.planSeq, Date.now()).some((entry) => entry.capability === capability)) return { ok: true };
    recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "native_harness", createdAt: new Date().toISOString(),
      payload: { capability, defect: String(detail.defect ?? "our_defect"), incidentId: detail.incidentId ?? null, actor: "agi-unblocker", runId } });
    return { ok: true };
  }
  if (move === "switch_tool") {
    const plan = planView(goalId);
    if (!plan || typeof detail.nodeId !== "string" || !plan.tactics.some((tactic) => tactic.id === detail.nodeId)) return { ok: false, code: "agi.retry.node-unknown" };
    updateGoalPlanNode({ goalId, revision: plan.revision, planSeq: plan.planSeq }, detail.nodeId,
      { payload: { guidance: { move: "switch_tool", cause: "tool_missing", at: null, boundary: null, path: String(detail.path ?? "") }, deferredUntil: null } });
    recordGoalPlanDecision({ goalId, revision: plan.revision, planSeq: plan.planSeq, kind: "tactic_status", createdAt: new Date().toISOString(),
      payload: { tacticId: detail.nodeId, status: "switch_tool", path: detail.path ?? null, actor: "agi-unblocker", runId } });
    return { ok: true };
  }
  // The only thing a switch_runtime can move is a live (non-retired) automation of the Goal with a recorded run. A Goal's
  // own next turn is woken by the host (034d8584e) and its runtime comes from the runner's cooldown plus the goal-pass-stop
  // persistence decision, neither of which reads an AGI move: there is no target, so the move is refused, typed.
  const target = goalRuntimeSwitchTarget(getDb(), goalId);
  if (!target) return { ok: false, code: "agi.move.no-continuation-automation" };
  recordPersistenceDecisionEvent({ runId: `agi-move:${randomUUID()}`, automationId: target.automationId, chatId: run?.rootChatId ?? null, payload: {
    schemaVersion: PERSISTENCE_DECISION_SCHEMA, surface: "automation", sourceRunId: target.latestRunId,
    cause: "runtime_unavailable" as FailureCauseKind, causeBoundary: null, causeRetryAfterAt: null,
    move: "switch_runtime", moveAt: null, moveBoundary: null, moveReason: `agi:${String(detail.incidentId ?? "")}`.slice(0, 160),
    reasonCode: "ladder", sameMoveCount: 1, ladderStep: -1, ownerLayer: "scheduler" } });
  return { ok: true };
}

/** D4: the goal's own runtime (its latest controller attempt) first, then the owner's role-pool order. */
export async function agiModelCandidates(goalId: string, pool: () => Promise<AliveModelOrderEntry[]> = freshAliveModelOrder): Promise<AgiModelCandidate[]> {
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
  for (const entry of await pool()) {
    if (entry.exhausted || !entry.selection || !entry.status || !entry.selection.model) continue;
    if (out.some((candidate) => candidate.status.kind === entry.status!.kind && candidate.selection.model === entry.selection!.model)) continue;
    out.push({ selection: entry.selection, status: entry.status, label: entry.label, source: "pool" });
  }
  // R-090: AGI asks read-only, no-tools judgment calls (model-attempt.ts); a runtime whose declared limits refuse that
  // request (the Goal's own controller included) would only spend one of the three slots on a refusal.
  return out.filter((candidate) => !runtimeRequestRefusal(candidate.status.kind,
    { permission: "read", untrustedNoTools: true, judgmentOnly: true })).slice(0, 3);
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
  const handler = createAgiDeterministicHandler(executor, undefined, model);
  const admitted = ((input) => {
    let decisionControl: ReturnType<typeof captureAgiDecisionControl>;
    try { decisionControl = captureAgiDecisionControl(input); }
    catch { return { outcome: "rested", code: AGI_DECISION_CONTROL_CHANGED }; }
    const refresh = input.refreshFence;
    try {
      return handler({ ...input, decisionControl, refreshFence: () => {
        assertAgiDecisionControl(decisionControl);
        return refresh ? refresh() : null;
      } });
    } finally { releaseAgiDecisionControl(decisionControl); }
  }) as AgiUnblockHandlerWithModel;
  admitted.isBusy = handler.isBusy;
  admitted.settled = handler.settled;
  return admitted;
}
