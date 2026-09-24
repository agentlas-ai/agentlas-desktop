/**
 * Real wiring of the One/Work Alive organisms (Main only) and their IPC surface.
 * The host logic lives in ./host.ts behind injectable deps so contracts can drive it without Electron.
 */
import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { getDb } from "../store/db";
import { getChat } from "../store/chats";
import { getProject } from "../store/projects";
import { getChatGoalRevision } from "../store/chat-goals";
import { getLongRunByGoalId, pendingBlockedGoalRetry } from "../store/long-runs";
import { latestGoalWaitSubscription } from "../long-run/wait-subscriptions";
import { continueGoalForAlive } from "../long-run/blocked-goal-sweep";
import { registerAppRuntimeParticipant } from "../long-run/app-runtime-coordinator";
import { listPendingToolApprovals } from "../runtime/tool-approval";
import { invocationService } from "../invocation/service";
import { pickRunner } from "../runtime/selection";
import { noteRuntimeFailure } from "../runtime/runtime-cooldown";
import { desktopAliveClock } from "../alive-clock";
import { ALIVE_CONTROLLER_SLUG, builtinAgentId } from "../architecture/manifest";
import { cachedAliveModelOrder, refreshAliveModelOrder } from "./model-order";
import { AliveHostError, AliveOrganismHost, parseAliveSurfaceChat, parseAliveTokenLimit, type AliveHostDeps } from "./host";
import type { GoalPlaygroundDeps, GoalRunView } from "./goal-playground";
import type { AliveChangedEvent, AliveState, AliveSurface } from "../../shared/alive";

const PROCESS_STARTED_AT_MS = Date.now();
let host: AliveOrganismHost | null = null;

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
  chatBusy: (chatId) => invocationService.activeChatIds().includes(chatId),
  pendingApproval: (chatId) => listPendingToolApprovals().some((request) => request.chatId === chatId),
  nextSafeRunAt: (run) => {
    const retry = pendingBlockedGoalRetry(run.id);
    if (retry) return retry.nextAt;
    const wait = latestGoalWaitSubscription(run.goalId);
    return wait && (wait.state === "pending" || wait.state === "claimed") ? wait.nextCheckAt : null;
  },
  latestReceipt: (chatId) => {
    const receipt = invocationService.latestReceipt(chatId);
    return receipt ? { status: receipt.status, errorCode: receipt.errorCode ?? null, finishedAt: receipt.finishedAt ?? null } : null;
  },
  continueGoal: (runId, expectedVersion) => continueGoalForAlive(runId, expectedVersion, invocationService),
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
  const deps: AliveHostDeps = {
    db: getDb(),
    now: Date.now,
    processStartedAtMs: PROCESS_STARTED_AT_MS,
    clock: desktopAliveClock,
    intervalMs: aliveOrganismTickMs(),
    playground: playgroundDeps,
    light: {
      pickRunner: (status) => pickRunner(status),
      // Quota/auth marks the member cooling, so the next wake falls down the pool order.
      noteFailure: (status, failure) => { noteRuntimeFailure(status, failure); },
    },
    projectName: (projectId) => getProject(projectId)?.name ?? null,
    controllerInstalled: () => Boolean(getDb().prepare("SELECT id FROM installed_agents WHERE id=? AND slug=? AND builtin=1")
      .get(builtinAgentId(ALIVE_CONTROLLER_SLUG), ALIVE_CONTROLLER_SLUG)),
    refreshModelOrder: () => refreshAliveModelOrder(),
    cachedModelOrder: cachedAliveModelOrder,
    emit: broadcast,
    registerShutdown: (stop) => {
      registerAppRuntimeParticipant("alive-organisms", { closeAdmission: stop, interrupt: stop, isSettled: () => true });
    },
  };
  host = new AliveOrganismHost(deps);
  host.start();
  return host;
}

export function stopAliveOrganisms(): void { host?.stop(); }

const offState = (reasonCode: string): AliveState => ({ available: false, reasonCode, enabled: false, scope: null,
  needsGoal: true, status: "off", budget: { tokenLimit: null, tokensUsed: 0 }, modelOrder: [] });

function requireHost(): AliveOrganismHost {
  if (!host || !host.isRunning()) throw new AliveHostError("alive-host-not-running");
  return host;
}

export function registerAliveIpc(deps: { ipc: Pick<IpcMain, "handle">; assertTrustedSender: (event: IpcMainInvokeEvent) => unknown }): void {
  deps.ipc.handle("alive:getState", (event, input: unknown): AliveState => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId"]);
    if (!host || !host.isRunning()) return offState("alive-host-not-running");
    return host.getState(row.surface as AliveSurface, row.chatId as string);
  });
  deps.ipc.handle("alive:setEnabled", (event, input: unknown): AliveState => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId", "enabled", "tokenLimit", "moveFrom"]);
    if (typeof row.enabled !== "boolean" || (row.moveFrom !== undefined && typeof row.moveFrom !== "boolean")) throw new AliveHostError("alive-input-invalid");
    return requireHost().setEnabled({ surface: row.surface as AliveSurface, chatId: row.chatId as string, enabled: row.enabled,
      ...(row.tokenLimit !== undefined ? { tokenLimit: parseAliveTokenLimit(row.tokenLimit) } : {}),
      ...(row.moveFrom === true ? { moveFrom: true } : {}) });
  });
  deps.ipc.handle("alive:setTokenLimit", (event, input: unknown): AliveState => {
    deps.assertTrustedSender(event);
    const row = parseAliveSurfaceChat(input, ["surface", "chatId", "tokenLimit"]);
    if (!("tokenLimit" in row)) throw new AliveHostError("alive-input-invalid");
    return requireHost().setTokenLimit({ surface: row.surface as AliveSurface, chatId: row.chatId as string,
      tokenLimit: parseAliveTokenLimit(row.tokenLimit) });
  });
}
