/**
 * Real wiring of the One/Work Alive organisms (Main only) and their IPC surface.
 * The host logic lives in ./host.ts behind injectable deps so contracts can drive it without Electron.
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
import { AliveHostError, AliveOrganismHost, parseAliveSurfaceChat, parseAliveTokenLimit, type AliveHostDeps } from "./host";
import type { GoalPlaygroundDeps, GoalRunView } from "./goal-playground";
import type { AliveChangedEvent, AliveState, AliveSurface } from "../../shared/alive";
import { AgiGoalMonitor } from "../agi/monitor";
import { listAgiMonitoredGoalIds, readAgiBlockerFacts } from "../agi/goal-facts";
import { createAgiHandler } from "../agi/wiring";
import { AgiBugReports } from "../agi/bug-report";
import { callAgiReadTool } from "../agi/read-tools";
import { AGI_MAX_TOKEN_LIMIT, AGI_MIN_TOKEN_LIMIT, readAgiTokenLimits, writeAgiTokenLimits } from "../agi/budget";
import { getSessionCookieHeader, webBaseUrl } from "../auth";
import type { AgiBugReportDraftInput, AgiTokenLimitsView } from "../../shared/agi";

const PROCESS_STARTED_AT_MS = Date.now();
let host: AliveOrganismHost | null = null;
let agiMonitor: AgiGoalMonitor | null = null;

let agiBugReports: AgiBugReports | null = null;
let agiBugReportTimer: ReturnType<typeof setInterval> | null = null;

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
    return chat ? { id: chat.id, title: chat.title, goalId: chat.goalId ?? null, projectId: chat.projectId ?? null,
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

/** App ready, after DB migration and after the long-run coordinator opened admission. Idempotent. */
export function startAliveOrganisms(): AliveOrganismHost {
  if (host) return host;
  // D3 (owner 2026-09-28): every One/Work goal is monitored, with or without an AGI life. No model calls.
  agiMonitor = new AgiGoalMonitor({
    db: getDb(),
    now: Date.now,
    listGoalIds: () => listAgiMonitoredGoalIds(getDb()),
    readFacts: (goalId) => readAgiBlockerFacts({
      db: getDb(), nowMs: Date.now,
      latestReceipt: (chatId) => {
        const receipt = invocationService.latestReceipt(chatId);
        return receipt ? { status: receipt.status, errorCode: receipt.errorCode ?? null, runId: receipt.runId ?? null } : null;
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
  monitor.setHandler(createAgiHandler());
  const deps: AliveHostDeps = {
    db: getDb(),
    now: Date.now,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    clock: desktopAliveClock,
    intervalMs: aliveOrganismTickMs(),
    playground: playgroundDeps,
    light: {
      // The Agentlas-served runtime gets the decision-only serving call (own prompt, strict schema, measured usage),
      // not the chat harness runner; every CLI runtime uses its runner's judgment no-tools path.
      pickRunner: (status) => status.kind === "agentlas" ? { runner: runAliveServingDecision, label: "Agentlas" } : pickRunner(status),
      // Quota/auth marks the member cooling, so the next wake falls down the pool order.
      noteFailure: (status, failure) => { noteRuntimeFailure(status, failure); },
    },
    projectName: (projectId) => getProject(projectId)?.name ?? null,
    controllerInstalled: () => Boolean(getDb().prepare("SELECT id FROM installed_agents WHERE id=? AND slug=? AND builtin=1")
      .get(builtinAgentId(ALIVE_CONTROLLER_SLUG), ALIVE_CONTROLLER_SLUG)),
    refreshModelOrder: (facts) => refreshAliveModelOrder(Date.now(), facts),
    cachedModelOrder: cachedAliveModelOrder,
    checkPlanAccess: checkAliveAgentAccess,
    emit: broadcast,
    onGoalStoreChanged: (listener) => onDesktopStoreChange((change) => {
      if (change.entity === "long-run" || change.entity === "chat") listener();
    }),
    registerShutdown: (stop) => {
      registerAppRuntimeParticipant("alive-organisms", { closeAdmission: stop, interrupt: () => { stop(); monitor.stop(); },
        isSettled: () => true });
    },
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
  host = new AliveOrganismHost(deps);
  host.start();
  monitor.start();
  // D5 offline queue: only reports the owner pressed Send on are retried (same clientReportId, backoff).
  if (!agiBugReportTimer) {
    const flush = () => { void agiBugReportSender().flush().catch((error) => console.warn("[agi-bug-report] flush failed:", error)); };
    agiBugReportTimer = setInterval(flush, 60_000);
    agiBugReportTimer.unref?.();
    setTimeout(flush, 5_000).unref?.();
  }
  return host;
}

export function stopAliveOrganisms(): void {
  host?.stop(); agiMonitor?.stop();
  if (agiBugReportTimer) clearInterval(agiBugReportTimer);
  agiBugReportTimer = null;
}

function agiTokenLimitsView(): AgiTokenLimitsView {
  return { ...readAgiTokenLimits(getDb()), min: AGI_MIN_TOKEN_LIMIT, max: AGI_MAX_TOKEN_LIMIT };
}

const offState = (reasonCode: string): AliveState => ({ available: false, reasonCode, enabled: false, scope: null,
  needsGoal: true, status: "off", budget: { tokenLimit: null, tokensUsed: 0 }, modelOrder: [] });

function requireHost(): AliveOrganismHost {
  if (!host || !host.isRunning()) throw new AliveHostError("alive-host-not-running");
  return host;
}

export function registerAliveIpc(deps: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  deps.ipc.handle("alive:getState", async (event, input: unknown): Promise<AliveState> => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId"]);
    if (!host || !host.isRunning()) return offState("alive-host-not-running");
    await host.refreshPlanAccess();
    return host.getState(row.surface as AliveSurface, row.chatId as string);
  });
  deps.ipc.handle("alive:setEnabled", async (event, input: unknown): Promise<AliveState> => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId", "enabled", "tokenLimit", "moveFrom"]);
    if (typeof row.enabled !== "boolean" || (row.moveFrom !== undefined && typeof row.moveFrom !== "boolean")) throw new AliveHostError("alive-input-invalid");
    const target = requireHost();
    if (row.enabled) await target.refreshPlanAccess();
    return target.setEnabled({ surface: row.surface as AliveSurface, chatId: row.chatId as string, enabled: row.enabled,
      ...(row.tokenLimit !== undefined ? { tokenLimit: parseAliveTokenLimit(row.tokenLimit) } : {}),
      ...(row.moveFrom === true ? { moveFrom: true } : {}) });
  });
  // AGI goal manager: token limits (D1) and defect reports (D5). Sending needs the owner's press on a preview.
  deps.ipc.handle("agi:getTokenLimits", (event): AgiTokenLimitsView => { deps.assertTrustedSender(event); return agiTokenLimitsView(); });
  deps.ipc.handle("agi:setTokenLimits", (event, input: unknown): AgiTokenLimitsView => {
    deps.assertTrustedSender(event);
    const row = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const pick = (key: string): number | undefined => typeof row[key] === "number" ? row[key] as number : undefined;
    writeAgiTokenLimits(getDb(), { attemptTokenLimit: pick("attemptTokenLimit"), dailyGoalTokenLimit: pick("dailyGoalTokenLimit") }, Date.now());
    return agiTokenLimitsView();
  });
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
  deps.ipc.handle("alive:setTokenLimit", (event, input: unknown): AliveState => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId", "tokenLimit"]);
    if (!("tokenLimit" in row)) throw new AliveHostError("alive-input-invalid");
    return requireHost().setTokenLimit({ surface: row.surface as AliveSurface, chatId: row.chatId as string,
      tokenLimit: parseAliveTokenLimit(row.tokenLimit) });
  });
}
