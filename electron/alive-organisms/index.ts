import { AliveOwnerIntentGate, DurableAliveOwnerIntents, type DurableAliveOwnerIntent } from "./owner-intent";
import { isAppControlEvent } from "../app-control/ipc-registry";
import { emitGoalControlChange } from "../goal-control-events";
/**
 * Real wiring of the One/Work Alive organisms and their IPC surface.
 * The host logic lives in ./host.ts behind injectable deps so contracts can drive it without Electron.
 *
 * One owner process (NH21): the background service runs the organism host while it holds the Alive domain lease
 * (domain-owner.ts); the window process runs it only while no service holds it, and otherwise forwards owner edits
 * to the service and executes the Goal actions the service hands it (Goal custody stays with the window process).
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { getDb } from "../store/db";
import { appendChatMessage, getChat } from "../store/chats";
import { emitDesktopStoreChange, onDesktopStoreChange } from "../store/change-bus";
import { getProject } from "../store/projects";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, longRunOwnerHold, pendingBlockedGoalRetry } from "../store/long-runs";
import { findAutomationByGoalId, listRunHistory } from "../store/automations";
import { currentUiLocale } from "../ui-locale";
import { ALIVE_ACTION_NOTICE_AUTOMATION_ID, aliveActionNoticeRunId, aliveActionNoticeText } from "./action-notice";
import { latestGoalWaitSubscription } from "../long-run/wait-subscriptions";
import { continueGoalForAlive } from "../long-run/blocked-goal-sweep";
import { findExplicitGoalGrant } from "../long-run/explicit-goal-authority";
import { registerAppRuntimeParticipant } from "../long-run/app-runtime-coordinator";
import { listPendingToolApprovals } from "../runtime/tool-approval";
import { invocationService } from "../invocation/service";
import { pickRunner } from "../runtime/selection";
import { noteRuntimeFailure } from "../runtime/runtime-cooldown";
import { desktopAliveClock } from "../alive-clock";
import { checkAliveAgentAccess } from "../billing";
import { ALIVE_CONTROLLER_SLUG, builtinAgentId } from "../architecture/manifest";
import { cachedAliveModelOrder, refreshAliveModelOrder } from "./model-order";
import { runAliveServingDecision } from "./serving-wake";
import { createLocalAliveDecisionTransport, createAliveDecisionTransport } from "../daemon/alive-decision-port";
import { withAgentContext } from "../runtime/agent-context";
import { agentContextOwnerBinding } from "../runtime/agent-context-admission";
import { configuredNativeGuiChannel, configuredNativeGuiOwner } from "../invocation/native-gui-startup";
import { nativeGuiChannelIdentity } from "../daemon/native-auth-channel";
import { AliveHostError, AliveOrganismHost, parseAliveSurfaceChat, parseAliveTokenLimit, type AliveHostDeps } from "./host";
import { GoalAlivePlayground, type GoalPlaygroundDeps, type GoalRunView } from "./goal-playground";
import { AliveDomainOwner } from "./domain-owner";
import { createAliveDomainParticipant, type AliveDomainParticipant } from "./domain-participant";
import { ALIVE_RUNTIME_BUDGET_MS, ALIVE_RUNTIME_OPS, ALIVE_RUNTIME_PROTOCOL, type AliveRuntimeOp, type AliveRuntimeRequest } from "./runtime-protocol";
import { AliveLifetimeStore } from "../alive-core/lifetime-store";
import { executeCustodianAliveAction, type CustodianActionAnswer } from "./custodian-action";
import { invocationRunOwners } from "../store/invocation-run-owners";
import { onHostShutdown } from "../host-lifecycle";
import type { AliveChangedEvent, AliveState, AliveSurface, AliveResumeBarrier } from "../../shared/alive";
import { AgiGoalMonitor } from "../agi/monitor";
import { listAgiMonitoredGoalIds, readAgiBlockerFacts } from "../agi/goal-facts";
import { effectiveGoalIdForChat } from "../store/goal-binding-repair";
import { createAgiHandler } from "../agi/wiring";
import { AgiBugReports } from "../agi/bug-report";
import { callAgiReadTool } from "../agi/read-tools";
import { AGI_MAX_TOKEN_LIMIT, AGI_MIN_TOKEN_LIMIT, readAgiTokenLimits, writeAgiTokenLimits } from "../agi/budget";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import type { AgiBugReportDraftInput, AgiTokenLimitsView } from "../../shared/agi";

/** The organism host running in THIS process: present only while this process holds the Alive domain. */
let host: AliveOrganismHost | null = null;
let participant: AliveDomainParticipant | null = null;
let agiMonitor: AgiGoalMonitor | null = null;
const ownerIntentGate = new AliveOwnerIntentGate();

let agiBugReports: AgiBugReports | null = null;
let agiBugReportTimer: ReturnType<typeof setInterval> | null = null;
let agiBugReportFirstFlush: ReturnType<typeof setTimeout> | null = null;

function mainLogPath(): string | null {
  try {
    const { app } = require("electron") as typeof import("electron");
    return require("node:path").join(app.getPath("logs"), "main.log") as string;
  } catch { return null; }
}

/** D5 sender (lazy: the IPC can be called before the organisms start). */
export function agiBugReportSender(): AgiBugReports {
  if (agiBugReports) return agiBugReports;
  const { app } = require("electron") as typeof import("electron");
  agiBugReports = new AgiBugReports({
    db: getDb(),
    now: Date.now,
    appVersion: () => app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    locale: () => currentUiLocale(),
    sessionToken: () => {
      const header = getSessionCookieHeader();
      const at = header ? header.indexOf("=") : -1;
      return header && at > 0 ? header.slice(at + 1) : null;
    },
    baseUrl: webBaseUrl,
    fetch: async (url, init) => {
      const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      return { status: response.status, json: () => response.json() };
    },
    goalRunIds: (goalId) => {
      const run = getLongRunByGoalId(goalId);
      if (!run) return [];
      const invocations = run.rootChatId ? (getDb().prepare(`SELECT DISTINCT run_id FROM run_events WHERE chat_id = ? ORDER BY ts DESC LIMIT 20`)
        .all(run.rootChatId) as Array<{ run_id: string }>).map((row) => row.run_id) : [];
      return [run.id, ...invocations];
    },
    logExcerpt: ({ goalId, family, sinceMs }) => {
      const result = callAgiReadTool({ db: getDb(), mainLogPath: mainLogPath() }, { goalId }, "main_log_slice",
        { family, since: new Date(sinceMs).toISOString() });
      if (!result.ok) return null;
      const rows = (JSON.parse(result.text) as { rows?: Array<{ line?: string }> }).rows ?? [];
      return rows.map((row) => row.line ?? "").filter(Boolean).join("\n") || null;
    },
  });
  return agiBugReports;
}

/** The deterministic AGI goal monitor (plan P1). Null before startAliveOrganisms. */
export function currentAgiMonitor(): AgiGoalMonitor | null { return agiMonitor; }

function continuationParkedForOwner(goalId: string): boolean {
  const automation = findAutomationByGoalId(goalId);
  if (!automation || automation.enabled) return false;
  const last = listRunHistory(automation.id, 1)[0];
  return Boolean(last && (last.status === "needs_input" || last.outcome === "needs_input"));
}

function runView(goalId: string): GoalRunView | null {
  const run = getLongRunByGoalId(goalId);
  if (!run || (run.surface !== "one" && run.surface !== "work")) return null;
  return { id: run.id, goalId: run.goalId, surface: run.surface, rootChatId: run.rootChatId, status: run.status,
    pauseReason: run.pauseReason, blockedReason: run.blockedReason, version: run.version, objective: run.objective,
    cycleCount: run.cycleCount, criteriaCount: run.acceptanceCriteria.length };
}

const playgroundDeps: GoalPlaygroundDeps = {
  chat: (chatId) => {
    const chat = getChat(chatId);
    // The goal comes from the contract table when the chat binding was detached from a still-live goal, so a

    return chat ? { id: chat.id, title: chat.title, goalId: effectiveGoalIdForChat(getDb(), chat.id, chat.goalId ?? null), projectId: chat.projectId ?? null,
      originSurface: chat.originSurface ?? null } : null;
  },
  runForGoal: runView,
  goalRevision: (goalId) => getChatGoalRevision(goalId)?.revision ?? null,
  explicitGrantRecorded: (goalId) => Boolean(findExplicitGoalGrant(getDb(), goalId)),
  chatBusy: (chatId) => invocationService.activeChatIds().includes(chatId),
  pendingApproval: (chatId) => listPendingToolApprovals().some((request) => request.chatId === chatId),
  nextSafeRunAt: (run) => {
    const retry = pendingBlockedGoalRetry(run.id);
    if (retry) return retry.nextAt;
    const wait = latestGoalWaitSubscription(run.goalId);
    return wait && (wait.state === "pending" || wait.state === "claimed") ? wait.nextCheckAt : null;
  },
  hostRetryPending: (runId) => Boolean(pendingBlockedGoalRetry(runId)),
  latestReceipt: (chatId) => {
    const receipt = invocationService.latestReceipt(chatId);
    return receipt ? { status: receipt.status, errorCode: receipt.errorCode ?? null, finishedAt: receipt.finishedAt ?? null } : null;
  },
  continueGoal: (runId, expectedVersion) => continueGoalForAlive(runId, expectedVersion, invocationService),
  ownerHold: (runId) => longRunOwnerHold(runId),
  // goal-continuation-hold parks a needs_input continuation by turning its row off; the owner's next turn turns it on.
  continuationParkedForOwner,
  agiMonitorOwnsBlocked: () => agiMonitor !== null,
  announceAction: (notice) => {
    const runId = aliveActionNoticeRunId(notice.actionId);
    const db = getDb();
    const already = db.prepare("SELECT id FROM chat_messages WHERE chat_id = ? AND role = 'system' AND host_notice_json LIKE ? LIMIT 1")
      .get(notice.chatId, `%"runId":${JSON.stringify(runId)}%`);
    if (already) return;
    appendChatMessage(notice.chatId, "system", aliveActionNoticeText(notice, currentUiLocale()), {
      hostNotice: { purpose: "automation-report", runId, automationId: ALIVE_ACTION_NOTICE_AUTOMATION_ID },
    });
    emitDesktopStoreChange({ entity: "chat", id: notice.chatId });
  },
};

function broadcast(event: AliveChangedEvent): void {
  emitGoalControlChange({ kind: "alive", ...event });
  // Lazy: this module is also loaded by contracts that have no Electron.
  const { BrowserWindow } = require("electron") as typeof import("electron");
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    window.webContents.send("alive:changed", event);
  }
}

export function aliveOrganismTickMs(): number {
  const configured = Number(process.env.AGENTLAS_ALIVE_ORGANISM_TICK_MS);
  return Number.isSafeInteger(configured) && configured >= 1_000 ? configured : 30_000;
}

/** Main's local decision transport, or the service's decision port while Main owns the domain beside an enrolled service. */
function mainDecisionTransport(): NonNullable<AliveHostDeps["light"]["decisionTransport"]> {
  return configuredNativeGuiOwner()?createAliveDecisionTransport({
    ownerBinding:agentContextOwnerBinding,
    async dispatch(wire){
      const channel=configuredNativeGuiChannel(),identity=channel && nativeGuiChannelIdentity(channel);
      if(!channel || !identity)throw Object.assign(new Error("alive_decision_native_channel_unavailable"),{code:"alive_decision_native_channel_unavailable"});
      const result=await channel.dispatch("native.attach",wire);
      if(configuredNativeGuiChannel()!==channel || nativeGuiChannelIdentity(channel)!==identity)
        throw Object.assign(new Error("alive_decision_native_channel_changed"),{code:"alive_decision_native_channel_changed"});
      return result;
    },
  }):localDecisionTransport();
}

function localDecisionTransport(): NonNullable<AliveHostDeps["light"]["decisionTransport"]> {
  return createLocalAliveDecisionTransport({db:getDb(),ownerBinding:agentContextOwnerBinding,now:Date.now,
    pickRunner:(status)=>status.kind === "agentlas" ? {runner:withAgentContext(runAliveServingDecision,{kind:"agentlas"}),label:"Agentlas"} : pickRunner(status)});
}

/** Deps every owner shares; `processStartedAtMs` is the moment this process took the domain (a wake reserved before
 * that belongs to an earlier owner and is reconciled as host-lost). */
function sharedHostDeps(fence: () => boolean): Omit<AliveHostDeps, "playground" | "light" | "emit"> {
  return {
    db: getDb(),
    now: Date.now,
    processStartedAtMs: Date.now(),
    clock: desktopAliveClock,
    intervalMs: aliveOrganismTickMs(),
    projectName: (projectId) => getProject(projectId)?.name ?? null,
    controllerInstalled: () => Boolean(getDb().prepare("SELECT id FROM installed_agents WHERE id=? AND slug=? AND builtin=1")
      .get(builtinAgentId(ALIVE_CONTROLLER_SLUG), ALIVE_CONTROLLER_SLUG)),
    refreshModelOrder: (facts) => refreshAliveModelOrder(Date.now(), facts),
    cachedModelOrder: cachedAliveModelOrder,
    checkPlanAccess: checkAliveAgentAccess,
    onGoalStoreChanged: (listener) => onDesktopStoreChange((change) => {
      if (change.entity === "long-run" || change.entity === "chat") listener();
    }),
    fence,
  };
}

const lightEdges = {
  // The Agentlas-served runtime gets the decision-only serving call (own prompt, strict schema, measured usage),
  // not the chat harness runner; every CLI runtime uses its runner's judgment no-tools path.
  pickRunner: (status: Parameters<typeof pickRunner>[0]) => status.kind === "agentlas" ? { runner: runAliveServingDecision, label: "Agentlas" } : pickRunner(status),
  // Quota/auth marks the member cooling, so the next wake falls down the pool order.
  noteFailure: (status: Parameters<typeof noteRuntimeFailure>[0], failure: Parameters<typeof noteRuntimeFailure>[1]) => { noteRuntimeFailure(status, failure); },
};

function mainHostDeps(fence: () => boolean, monitor: AgiGoalMonitor): AliveHostDeps {
  return {
    ...sharedHostDeps(fence),
    playground: playgroundDeps,
    light: { decisionTransport: mainDecisionTransport(), ...lightEdges },
    emit: broadcast,
    // Decision point unblock_attempt_due (6fdcf31b) → the monitor's single per-state attempt for that goal.
    unblockAttempt: (input) => {
      const goalId = typeof input.observation.goalId === "string" ? input.observation.goalId
        : typeof input.attachment.scope.goalId === "string" ? input.attachment.scope.goalId : null;
      if (!goalId) return { outcome: "failed", code: "agi.goal-unknown" };
      if (input.admissionCode) return { outcome: "failed", code: "agi.admission-closed" };
      const { result } = monitor.reconcile(goalId, "alive-hook");
      const outcome = result?.outcome;
      return outcome === "acted" ? { outcome: "acted" } : outcome === "needs-human" ? { outcome: "needs-human", code: result?.code }
        : { outcome: "failed", code: result?.code ?? "agi.attempt-already-spent" };
    },
  };
}

function hostHandle(created: AliveOrganismHost) {
  host = created;
  return {
    start: () => created.start(),
    stop: () => { created.stop(); if (host === created) host = null; },
    isRunning: () => created.isRunning(),
    quiescent: () => created.quiescent(),
  };
}

/**
 * App ready, after DB migration and after the long-run coordinator opened admission. Idempotent.
 * Main always runs the AGI monitor (it owns Goal custody) and takes the organism host only when no background
 * service holds the Alive domain.
 */
export function startAliveOrganisms(): AliveOrganismHost | null {
  if (participant) return host;
  // D3 (owner 2026-09-28): every One/Work goal is monitored, with or without an AGI life. No model calls.
  agiMonitor = new AgiGoalMonitor({
    db: getDb(),
    now: Date.now,
    listGoalIds: () => listAgiMonitoredGoalIds(getDb()),
    readFacts: (goalId) => readAgiBlockerFacts({
      db: getDb(), nowMs: Date.now,
      // The Goal's own controller turn by its exact invocation id, live (ID-2), never the room's newest run.
      runReceipt: (runId) => {
        const receipt = invocationService.receipt(runId);
        return receipt ? { status: receipt.status, errorCode: receipt.errorCode ?? null, runId: receipt.runId ?? null, errorMessage: receipt.errorMessage ?? null } : null;
      },
      chatBusy: (chatId) => invocationService.activeChatIds().includes(chatId),
      continuationParkedForOwner,
      pendingApproval: (chatId) => listPendingToolApprovals().some((request) => request.chatId === chatId),
    }, goalId),
    onChanged: (goalId) => {
      const run = getLongRunByGoalId(goalId);
      if (run) emitDesktopStoreChange({ entity: "long-run", id: run.id });
    },
  });
  const monitor = agiMonitor;
  // P3: the typed executor behind the deterministic handler (one attempt per exact blocked state).
  const agiHandler = createAgiHandler();
  monitor.setHandler(agiHandler);
  const seat = createAliveDomainParticipant({
    kind: "main", db: getDb(),
    createHost: (_lease, fence) => hostHandle(new AliveOrganismHost(mainHostDeps(fence, monitor))),
    // Without a channel to the service the owner's AGI switches would have nowhere to go: keep the domain here.
    canHandOver: () => Boolean(configuredNativeGuiChannel()),
    log: (line) => console.info(line),
    // The screens follow the owner: a handover changes who answers for every life.
    onChange: () => { emitGoalControlChange({ kind: "alive" }); },
  });
  participant = seat;
  registerAppRuntimeParticipant("alive-organisms", { closeAdmission: () => seat.stop(), interrupt: () => {
    seat.stop(); monitor.stop();
    return agiHandler.settled();
  }, isSettled: () => true });
  seat.start();
  monitor.start();
  // D5 offline queue: only reports the owner pressed Send on are retried (same clientReportId, backoff).
  if (!agiBugReportTimer) {
    const flush = () => { void agiBugReportSender().flush().catch((error) => console.warn("[agi-bug-report] flush failed:", error)); };
    agiBugReportTimer = setInterval(flush, 60_000);
    agiBugReportTimer.unref?.();
    agiBugReportFirstFlush = setTimeout(flush, 5_000);
    agiBugReportFirstFlush.unref?.();
  }
  return host;
}

export function stopAliveOrganisms(): void {
  participant?.stop(); agiMonitor?.stop();
  if (agiBugReportTimer) clearInterval(agiBugReportTimer);
  agiBugReportTimer = null;
  if (agiBugReportFirstFlush) clearTimeout(agiBugReportFirstFlush);
  agiBugReportFirstFlush = null;
}

// ── background service owner (NH21) ─────────────────────────────────────────────────────────────────────────────

/** The service's reverse path to the window process (daemon/device-bridge.ts). */
export interface AliveDaemonBridge {
  /** Main executes this exact executing reservation as the Goal custodian; resolves after Main settled its receipt. */
  action(input: { domain: "work" | "one"; actionId: string }): Promise<unknown>;
  /** Tell Main's screens a life changed (best effort; Main may be closed). */
  changed(event: AliveChangedEvent): Promise<unknown>;
}

function daemonHostDeps(fence: () => boolean, bridge: AliveDaemonBridge): AliveHostDeps {
  const inFlight = new Set<string>();
  return {
    ...sharedHostDeps(fence),
    playground: {
      ...playgroundDeps,
      // Work turns run in the window process: its durable run custody is the cross-process busy signal.
      chatBusy: (chatId) => invocationService.activeChatIds().includes(chatId) || invocationRunOwners.getActiveOwner(chatId) !== null,
      // The AGI monitor runs beside Goal custody in the window process; with it gone nobody can continue a Goal anyway.
      agiMonitorOwnsBlocked: () => true,
      forwardAction: (input) => {
        if (inFlight.has(input.actionId)) return;
        inFlight.add(input.actionId);
        void bridge.action(input).catch(() => { /* Main closed or busy: the reservation stays executing for the next beat */ })
          .finally(() => {
            inFlight.delete(input.actionId);
            // Main settled the durable receipt: read it now instead of at the next beat.
            setImmediate(() => { if (host?.isRunning()) void host.beat(input.domain); });
          });
      },
    },
    light: { decisionTransport: localDecisionTransport(), ...lightEdges },
    emit: (event) => {
      emitGoalControlChange({ kind: "alive", ...event });
      void bridge.changed(event).catch(() => { /* no window to tell */ });
    },
  };
}

/** Started by the enrolled background service. Idempotent; the host-lifecycle shutdown hook stops it and releases. */
export function startDaemonAliveOrganisms(bridge: AliveDaemonBridge): void {
  if (participant) return;
  const seat = createAliveDomainParticipant({
    kind: "daemon", db: getDb(),
    createHost: (_lease, fence) => hostHandle(new AliveOrganismHost(daemonHostDeps(fence, bridge))),
    log: (line) => console.info(line),
    onChange: (state) => { emitGoalControlChange({ kind: "alive" }); console.info(`[alive-domain] service ${state.role}`); },
  });
  participant = seat;
  onHostShutdown(() => seat.stop());
  seat.start();
}

/** The service holds the domain and at least one life is on: idle exit must not cut it (daemon/idle-exit.ts). */
export function daemonAliveResident(): boolean {
  if (!participant?.owns()) return false;
  try {
    return Boolean(getDb().prepare(`SELECT 1 FROM alive_agents a JOIN alive_organism_lives l ON l.agent_id=a.agent_id
      WHERE a.status='enabled' LIMIT 1`).get());
  } catch { return false; }
}

function agiTokenLimitsView(): AgiTokenLimitsView {
  return { ...readAgiTokenLimits(getDb()), min: AGI_MIN_TOKEN_LIMIT, max: AGI_MAX_TOKEN_LIMIT };
}

const offState = (reasonCode: string): AliveState => ({ available: false, reasonCode, enabled: false, scope: null,
  needsGoal: true, status: "off", budget: { tokenLimit: null, tokensUsed: 0 }, modelOrder: [] });

function requireHost(): AliveOrganismHost {
  if (!host || !host.isRunning()) throw new AliveHostError("alive-host-not-running");
  host.assertOwner();
  return host;
}

const errorCode = (error: unknown): string => error instanceof AliveHostError ? error.code : "alive-owner-unreachable";

/** No host here, and a live background service holds the domain: owner edits go there (NH21). */
function remoteOwner(): boolean {
  if (host?.isRunning()) return false;
  try { return new AliveDomainOwner(getDb()).heldElsewhere()?.kind === "daemon"; } catch { return false; }
}

async function forwardAliveOp(op: AliveRuntimeOp, input: Record<string, unknown>, ownerIntentId?: string): Promise<AliveState> {
  const channel = configuredNativeGuiChannel(), identity = channel && nativeGuiChannelIdentity(channel);
  if (!channel || !identity) throw new AliveHostError("alive-owner-unreachable");
  let reply: Record<string, unknown> | null;
  try { reply = await channel.dispatch("native.attach", { version: ALIVE_RUNTIME_PROTOCOL, op, input, ...(ownerIntentId ? { ownerIntentId } : {}) } satisfies AliveRuntimeRequest) as Record<string, unknown> | null; }
  catch { throw new AliveHostError("alive-owner-unreachable"); }
  if (configuredNativeGuiChannel() !== channel || nativeGuiChannelIdentity(channel) !== identity) throw new AliveHostError("alive-owner-changed");
  if (!reply || typeof reply !== "object" || reply.version !== ALIVE_RUNTIME_PROTOCOL || reply.bootId !== identity.bootId) throw new AliveHostError("alive-owner-reply-invalid");
  if (reply.ok !== true) {
    throw new AliveHostError(typeof reply.code === "string" && /^[a-z][a-z0-9._-]{2,119}$/.test(reply.code) ? reply.code : "alive-owner-refused");
  }
  if (!reply.state || typeof reply.state !== "object" || Array.isArray(reply.state)) throw new AliveHostError("alive-owner-reply-invalid");
  return reply.state as AliveState;
}

/** Room stops also fence a pending first enable; Work rooms share their project life fence. Attached lives
 * remain stoppable after a chat/Goal binding disappears. This reads trusted store facts, never model metadata. */
function aliveOwnerIntentScopes(surface: AliveSurface, chatId: string): string[] {
  const keys = new Set([`chat:${surface}:${chatId}`]);
  const chat = getChat(chatId);
  if (surface === "work" && chat?.projectId) keys.add(`life:alive:work-project:v1:${chat.projectId}`);
  if (surface === "one" && chat) {
    const goalId = effectiveGoalIdForChat(getDb(), chat.id, chat.goalId ?? null);
    if (goalId) keys.add(`life:alive:one-goal:v1:${goalId}`);
  }
  try {
    const lives = getDb().prepare(`SELECT DISTINCT l.life_key FROM alive_organism_lives l JOIN alive_attachments a ON a.agent_id=l.agent_id
      WHERE l.organism=? AND a.status='attached' AND json_extract(a.scope_json,'$.chatId')=?`).all(surface, chatId) as Array<{ life_key: string }>;
    for (const life of lives) keys.add(`life:${life.life_key}`);
  } catch (error) { if (!/no such table/i.test(String((error as Error)?.message))) throw error; }
  return [...keys].sort();
}

function applyAliveOwnerIntent<T>(intent: DurableAliveOwnerIntent, surface: AliveSurface, chatId: string, apply: () => T): T {
  const answer = new DurableAliveOwnerIntents(getDb()).commit(intent, () => aliveOwnerIntentScopes(surface, chatId), apply);
  if (!answer.applied) throw new AliveHostError("alive-owner-intent-superseded");
  return answer.value;
}

/**
 * Stop is unconditional (an owner stop never waits on a reachable owner): with no local host and no reachable owner,
 * the lives attached to this chat are turned off in the shared store. The control epoch moves, so the owner's wake in
 * flight cannot act and its next beat sees the life off.
 */
function stopAliveInStore(surface: AliveSurface, chatId: string, reasonCode: string, intent: DurableAliveOwnerIntent): AliveState {
  return applyAliveOwnerIntent(intent, surface, chatId, () => {
  const db = getDb();
  try {
    const lives = new Set((db.prepare("SELECT agent_id FROM alive_organism_lives WHERE organism=?").all(surface) as Array<{ agent_id: string }>).map((row) => row.agent_id));
    const store = new AliveLifetimeStore(db, { initializeSchema: false, agentScope: (agentId) => lives.has(agentId) });
    for (const agent of store.list()) {
      if (agent.status !== "enabled" || !store.attachments(agent.agentId).some((row) => row.status === "attached" && row.scope.chatId === chatId)) continue;
      store.setEnabled(agent.agentId, false, "owner.disabled", Date.now());
    }
  } catch (error) {
    // No Alive table yet means no life to stop.
    if (!/no such table/i.test(String((error as Error)?.message))) throw error;
  }
  emitGoalControlChange({ kind: "alive", surface, chatId });
  return offState(reasonCode);
  });
}

export function registerAliveIpc(deps: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  deps.ipc.handle("alive:resumeUncertainWake", (event,input:unknown) => {
    deps.assertTrustedSender(event);
    if (isAppControlEvent(event)) throw new AliveHostError("alive-resume-human-required");
    return resumeAliveUncertainWake(input);
  });
  deps.ipc.handle("alive:getState", (event, input: unknown) => { deps.assertTrustedSender(event); return readAliveState(input); });
  deps.ipc.handle("alive:setEnabled", (event, input: unknown) => { deps.assertTrustedSender(event); return setAliveEnabled(input); });
  deps.ipc.handle("agi:getTokenLimits", (event) => { deps.assertTrustedSender(event); return getAgiTokenLimits(); });
  deps.ipc.handle("agi:setTokenLimits", (event, input: unknown) => { deps.assertTrustedSender(event); return setAgiTokenLimits(input); });
  deps.ipc.handle("agi:defectsForChat", (event, chatId: unknown) => {
    deps.assertTrustedSender(event);
    return typeof chatId === "string" && chatId ? agiBugReportSender().defectsForChat(chatId) : [];
  });
  deps.ipc.handle("agi:bugReportPreview", (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const str = (key: string, max: number): string | undefined => typeof row[key] === "string" ? (row[key] as string).slice(0, max) : undefined;
    const draft: AgiBugReportDraftInput = {
      defectId: str("defectId", 200) ?? null, chatId: str("chatId", 200) ?? null, title: str("title", 400), summary: str("summary", 8_000),
      category: str("category", 20) as AgiBugReportDraftInput["category"], failureCode: str("failureCode", 160), runId: str("runId", 200),
      steps: Array.isArray(row.steps) ? row.steps.filter((step): step is string => typeof step === "string").slice(0, 20) : undefined,
    };
    return agiBugReportSender().preview(draft);
  });
  deps.ipc.handle("agi:bugReportSend", async (event, input: unknown) => {
    deps.assertTrustedSender(event);
    const id = input && typeof input === "object" ? (input as { clientReportId?: unknown }).clientReportId : null;
    if (typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new AliveHostError("agi-input-invalid");
    return agiBugReportSender().send(id);
  });
  deps.ipc.handle("agi:bugReportList", async (event) => { deps.assertTrustedSender(event); return agiBugReportSender().list(); });
  deps.ipc.handle("alive:setTokenLimit", (event, input: unknown) => { deps.assertTrustedSender(event); return setAliveTokenLimit(input); });
}

export function getAgiTokenLimits(): AgiTokenLimitsView { return agiTokenLimitsView(); }

export async function readAliveState(input: unknown): Promise<AliveState> {
  const row = parseAliveSurfaceChat(input, ["surface", "chatId"]);
  const notLocal = async (): Promise<AliveState> => {
    if (!remoteOwner()) return offState("alive-host-not-running");
    try { return await forwardAliveOp("getState", { surface: row.surface, chatId: row.chatId }); }
    catch (error) { return offState(errorCode(error)); }
  };
  const local = host;
  if (!local || !local.isRunning()) return notLocal();
  await local.refreshPlanAccess();
  // Startup hands the domain to the background service; when that lands during the await, the local host is gone
  // (production 1.3.67 first launch, 2026-10-18 00:11:03Z: "Cannot read properties of null (reading 'getState')").
  if (host !== local || !local.isRunning()) return notLocal();
  return local.getState(row.surface as AliveSurface, row.chatId as string);
}

export async function setAliveEnabled(input: unknown, forwardedIntentId?: string): Promise<AliveState> {
  const row = parseAliveSurfaceChat(input, ["surface", "chatId", "enabled", "tokenLimit", "moveFrom"]);
  if (typeof row.enabled !== "boolean" || (row.moveFrom !== undefined && typeof row.moveFrom !== "boolean")) throw new AliveHostError("alive-input-invalid");
  const surface = row.surface as AliveSurface, chatId = row.chatId as string;
  if (row.tokenLimit !== undefined) row.tokenLimit = parseAliveTokenLimit(row.tokenLimit);
  const intents = new DurableAliveOwnerIntents(getDb());
  let intent: DurableAliveOwnerIntent;
  try { intent = forwardedIntentId === undefined ? intents.issue(row, aliveOwnerIntentScopes(surface, chatId), Date.now()) : intents.accept(forwardedIntentId, row); }
  catch (error) { throw new AliveHostError(error instanceof Error ? error.message : "alive-owner-intent-invalid"); }
  if (!intents.current(intent, aliveOwnerIntentScopes(surface, chatId))) throw new AliveHostError("alive-owner-intent-superseded");
  if (!host || !host.isRunning()) {
    if (remoteOwner()) {
      try { return await forwardAliveOp("setEnabled", row, intent.intentId); }
      catch (error) { if (row.enabled === false) return stopAliveInStore(surface, chatId, errorCode(error), intent); throw error; }
    }
    if (row.enabled === false) return stopAliveInStore(surface, chatId, "alive-host-not-running", intent);
  }
  const target = requireHost();
  const next = { surface: row.surface as AliveSurface, chatId: row.chatId as string, enabled: row.enabled,
    ...(row.tokenLimit !== undefined ? { tokenLimit: parseAliveTokenLimit(row.tokenLimit) } : {}),
    ...(row.moveFrom === true ? { moveFrom: true } : {}) };
  const current = target.getState(next.surface, next.chatId);
  // Work toggles in different chats still control one project life. A pending enable must share that fence.
  const scopeKey = `${next.surface}:${current.scope?.kind ?? "chat"}:${current.scope?.id ?? next.chatId}`;
  return ownerIntentGate.run(scopeKey, next.enabled, {
    refreshAccess: () => target.refreshPlanAccess(),
    read: () => target.getState(next.surface, next.chatId),
    apply: () => applyAliveOwnerIntent(intent, surface, chatId, () => target.setEnabled(next)),
  });
}

export async function resumeAliveUncertainWake(input:unknown): Promise<AliveState> {
  const row = parseAliveSurfaceChat(input,["surface","chatId","intentId","expected"]);
  if (typeof row.intentId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(row.intentId)
    || !row.expected || typeof row.expected !== "object" || Array.isArray(row.expected)) throw new AliveHostError("alive-input-invalid");
  const value = row.expected as Record<string,unknown>;
  const keys = ["agentId","agentVersion","controlEpoch","wakeId","settledSequence","latestSequence","receiptDigest","errorCode","goalBinding"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key=>!keys.includes(key))
    || ["agentId","wakeId","errorCode"].some(key=>typeof value[key]!=="string" || !(value[key] as string).length || (value[key] as string).length>200)
    || ["agentVersion","controlEpoch","settledSequence","latestSequence"].some(key=>!Number.isSafeInteger(value[key]) || Number(value[key])<0)
    || typeof value.receiptDigest!=="string" || !/^[a-f0-9]{64}$/.test(value.receiptDigest)) throw new AliveHostError("alive-input-invalid");
  const binding = value.goalBinding as Record<string,unknown>|undefined;
  if (!binding || typeof binding!=="object" || Array.isArray(binding)
    || Object.keys(binding).length!==3 || Object.keys(binding).some(key=>!["goalId","runId","runVersion"].includes(key))
    || ["goalId","runId"].some(key=>typeof binding[key]!=="string" || !(binding[key] as string).length || (binding[key] as string).length>200)
    || !Number.isSafeInteger(binding.runVersion) || Number(binding.runVersion)<0) throw new AliveHostError("alive-input-invalid");
  value.goalBinding = {goalId:binding.goalId,runId:binding.runId,runVersion:binding.runVersion};
  const expected = Object.fromEntries(keys.map(key=>[key,value[key]])) as unknown as AliveResumeBarrier;
  if ((!host || !host.isRunning()) && remoteOwner()) return forwardAliveOp("resumeUncertainWake", { surface: row.surface, chatId: row.chatId, intentId: row.intentId, expected });
  const target = requireHost(); const surface = row.surface as AliveSurface; const chatId = row.chatId as string;
  const current = target.getState(surface,chatId);
  const scopeKey = `${surface}:${current.scope?.kind ?? "chat"}:${current.scope?.id ?? chatId}`;
  return ownerIntentGate.run(scopeKey,true,{refreshAccess:()=>target.refreshPlanAccess(),read:()=>target.getState(surface,chatId),
    apply:()=>target.resumeUncertainWake({surface,chatId,intentId:row.intentId as string,expected})});
}

export function setAgiTokenLimits(input: unknown): AgiTokenLimitsView {
  const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const pick = (key: string): number | undefined => typeof row[key] === "number" ? row[key] as number : undefined;
  writeAgiTokenLimits(getDb(), { attemptTokenLimit: pick("attemptTokenLimit"), dailyGoalTokenLimit: pick("dailyGoalTokenLimit") }, Date.now());
  emitGoalControlChange({ kind: "agi-limits" });
  return agiTokenLimitsView();
}

export function setAliveTokenLimit(input: unknown): AliveState | Promise<AliveState> {
  const row = parseAliveSurfaceChat(input, ["surface", "chatId", "tokenLimit"]);
  if (!("tokenLimit" in row)) throw new AliveHostError("alive-input-invalid");
  const tokenLimit = parseAliveTokenLimit(row.tokenLimit);
  if ((!host || !host.isRunning()) && remoteOwner()) return forwardAliveOp("setTokenLimit", { surface: row.surface, chatId: row.chatId, tokenLimit });
  return requireHost().setTokenLimit({ surface: row.surface as AliveSurface, chatId: row.chatId as string, tokenLimit });
}

// ── the two halves of the cross-process owner (NH21) ────────────────────────────────────────────────────────────

/** Service side: answer an owner edit the window process forwarded (native.attach, ALIVE_RUNTIME_PROTOCOL). */
export async function answerAliveRuntimeRequest(params: unknown, bootId: string): Promise<Record<string, unknown>> {
  const fail = (code: string) => ({ version: ALIVE_RUNTIME_PROTOCOL, bootId, ok: false, code });
  const p = params as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((key) => !["version", "op", "input", "ownerIntentId"].includes(key))
    || p.version !== ALIVE_RUNTIME_PROTOCOL || !(ALIVE_RUNTIME_OPS as readonly unknown[]).includes(p.op)
    || !p.input || typeof p.input !== "object" || Array.isArray(p.input)) return fail("alive-runtime-request-invalid");
  if (p.ownerIntentId !== undefined && (p.op !== "setEnabled" || typeof p.ownerIntentId !== "string" || !/^[a-f0-9-]{36}$/i.test(p.ownerIntentId))) return fail("alive-runtime-request-invalid");
  if (!host || !host.isRunning()) return fail("alive-host-not-owner");
  const op = p.op as AliveRuntimeOp;
  const run: Promise<AliveState> = op === "getState" ? readAliveState(p.input) : op === "setEnabled" ? setAliveEnabled(p.input, p.ownerIntentId as string | undefined)
    : op === "setTokenLimit" ? Promise.resolve().then(() => setAliveTokenLimit(p.input)) : resumeAliveUncertainWake(p.input);
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const state = await Promise.race([run, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AliveHostError("alive-owner-timeout")), ALIVE_RUNTIME_BUDGET_MS);
      timer.unref?.();
    })]);
    return { version: ALIVE_RUNTIME_PROTOCOL, bootId, ok: true, state };
  } catch (error) {
    return fail(error instanceof AliveHostError ? error.code : "alive-owner-failed");
  } finally { if (timer) clearTimeout(timer); }
}

const custodianPlaygrounds = new Map<"work" | "one", GoalAlivePlayground>();

/** Window side: the service holds the Alive clock and reserved this action; Goal custody is here (custodian-action.ts). */
export function executeForwardedAliveAction(input: { domain: "work" | "one"; actionId: string }): CustodianActionAnswer {
  if (host?.isRunning()) return { ok: false, error: "alive_action_owner_is_local" };
  const db = getDb();
  return executeCustodianAliveAction({ db, domain: input.domain, actionId: input.actionId,
    ownerIsService: () => new AliveDomainOwner(db).heldElsewhere()?.kind === "daemon",
    playground: (domain) => {
      let playground = custodianPlaygrounds.get(domain);
      if (!playground) { playground = new GoalAlivePlayground(domain, db, playgroundDeps); custodianPlaygrounds.set(domain, playground); }
      return playground;
    } });
}

/** Window side: a life changed in the service; tell this process's screens and projections. */
export function aliveChangedFromService(event: unknown): boolean {
  const row = event as Record<string, unknown> | null;
  if (!row || typeof row !== "object" || Array.isArray(row) || (row.surface !== "one" && row.surface !== "work")
    || typeof row.scopeId !== "string" || row.scopeId.length > 200 || (row.chatId !== undefined && (typeof row.chatId !== "string" || row.chatId.length > 200))
    || Object.keys(row).some((key) => !["surface", "chatId", "scopeId"].includes(key))) return false;
  if (host?.isRunning()) return false;
  broadcast({ surface: row.surface, scopeId: row.scopeId, ...(typeof row.chatId === "string" ? { chatId: row.chatId } : {}) });
  return true;
}
