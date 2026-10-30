import { scienceQuestionHost } from "../science-host/question-continuation";
import type { ScienceQuestionReadInput, ScienceQuestionAnswerInput } from "../science-host/question-ipc";
/**
 * One daemon owns the complete Science execution graph. The caller must publish
 * its exclusive control socket/store lease before start(), and keep that lease
 * through close(). GUI processes are authenticated clients, never co-owners.
 * Importing this module does not load Science, open a database, or recover work.
 */
import type { ToolApprovalDecision, ToolApprovalRequestEvent, AskUserRequestEvent } from "../../shared/types";
import { sendRefusalCode, startOwnerSendOrAcceptRefusal } from "../../shared/transient-send-refusal";
import { randomUUID } from "node:crypto";
import { captureScienceAliveOwnerControl, recordScienceAliveOwnerControl, recordScienceHostGoalOwnerControl, readScienceHostGoalWake } from "../science-host/goal-wake";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { dispatchSciencePublicationCommand, type DaemonSciencePublicationCommand } from "./science-publication-commands";
type Science = typeof import("agentlas-science");
type Store = ReturnType<Science["scienceStore"]>;
type Conversations = ReturnType<Science["scienceConversationService"]>;
type Questions = ReturnType<Store["researcherQuestions"]>;
type Scope = { projectId: string; conversationId: string };
type TurnScope = Scope & { turnId: string };
type ComputeReadInput = Scope & { executionId: string; afterCursor?: number; maxEvents?: number; waitMs?: number };
type ComputeListInput = Scope & { limit?: number };
export type NativeHumanComputeRequester = { kind: "signed-science-main-frame"; viewInstanceId: string; releaseId: string; ownerServiceIdentity: string; ownerBootId: string };
type HumanComputeInput = Scope & { turnId:string|null; originMessageId: string; invocationRunId: string|null; executionId: string; kernelId: string;
  kernelGeneration: number; codeSha256: string; environmentSha256: string; requestId: string };
type HumanComputeReadInput = Scope & { requestId: string };
type HumanComputeTarget = Omit<HumanComputeInput, "requestId">;
type HumanComputeConsoleInput = { requestId: string; target: HumanComputeTarget; code: string;
  inputs?: { path: string; sha256: string }[]; outputs?: string[]; timeoutMs?: number };
type HumanComputeConsoleReadInput = { requestId: string; target: HumanComputeTarget };
type HumanSessionBeginInput = Scope & ({requestId:string;mode:"bootstrap-python";originMessageId:string;language:"python";environment:{kind:"system"};limits?:Partial<{wallTimeMs:number;maxCells:number;maxActiveRuntimeMs:number;maxCellTimeMs:number}>}|{requestId:string;anchorTarget:HumanComputeTarget;mode:"reuse-live"|"fresh-generation";limits?:Partial<{wallTimeMs:number;maxCells:number;maxActiveRuntimeMs:number;maxCellTimeMs:number}>});
type HumanSessionRunInput = Scope & {requestId:string;sessionId:string;sessionEpoch:number;code:string;inputs?:{path:string;sha256:string}[];outputs?:string[];timeoutMs?:number};
type HumanSessionReadInput = Scope & {sessionId?:string;requestId?:string};
type HumanSessionRequestReadInput = Scope & {sessionId:string;requestId:string};
type HumanSessionStopInput = HumanSessionRequestReadInput & {sessionEpoch:number};
type HumanSessionInput = HumanSessionBeginInput | HumanSessionRunInput | HumanSessionReadInput | HumanSessionRequestReadInput | HumanSessionStopInput;
type HumanComputeGuard = (requester: NativeHumanComputeRequester) => void;
type HumanComputeService = {
  interruptHuman(requester: NativeHumanComputeRequester, input: HumanComputeInput, guard: HumanComputeGuard): unknown;
  clearGenerationHuman(requester: NativeHumanComputeRequester, input: HumanComputeInput, guard: HumanComputeGuard): unknown;
  readHumanControl(requester: NativeHumanComputeRequester, input: HumanComputeReadInput, guard: HumanComputeGuard): unknown;
  runHuman?(requester: NativeHumanComputeRequester, input: HumanComputeConsoleInput, guard: HumanComputeGuard): unknown;
  readHumanConsole?(requester: NativeHumanComputeRequester, input: HumanComputeConsoleReadInput, guard: HumanComputeGuard): unknown;
  beginHumanSession?(requester: NativeHumanComputeRequester,input: HumanSessionBeginInput,guard:HumanComputeGuard):unknown;
  runHumanSession?(requester: NativeHumanComputeRequester,input: HumanSessionRunInput,guard:HumanComputeGuard):unknown;
  readHumanSession?(requester: NativeHumanComputeRequester,input: HumanSessionReadInput,guard:HumanComputeGuard):unknown;
  readHumanSessionRequest?(requester: NativeHumanComputeRequester,input: HumanSessionRequestReadInput,guard:HumanComputeGuard):unknown;
  stopHumanSession?(requester: NativeHumanComputeRequester,input: HumanSessionStopInput,guard:HumanComputeGuard):unknown;
};
// Signed older Science packages may lack native compute. Keep that case an
// explicit unavailable response rather than constructing a GUI execution owner.
type ComputeUiApi = {
  createScientificComputeUiControls?: (ports: { authorize(scope: Scope, action: "interrupt" | "clear-generation" | "read-control" | "run-console" | "read-console" | "begin-session" | "run-session" | "read-session" | "read-session-request" | "stop-session"): NativeHumanComputeRequester;
    store: Store; service: HumanComputeService }) => { interrupt(input: HumanComputeInput): Promise<unknown>;
      clearGeneration(input: HumanComputeInput): Promise<unknown>; readHumanControl(input: HumanComputeReadInput): Promise<unknown>;
      runConsole?(input: HumanComputeConsoleInput): Promise<unknown>; readConsoleRequest?(input: HumanComputeConsoleReadInput): Promise<unknown>;
      beginSession?(input: HumanSessionBeginInput): Promise<unknown>;
      runSession?(input: HumanSessionRunInput): Promise<unknown>;
      readSession?(input: HumanSessionReadInput): Promise<unknown>;
      readSessionRequest?(input: HumanSessionRequestReadInput): Promise<unknown>;
      stopSession?(input: HumanSessionStopInput): Promise<unknown>;
    };
  createScientificComputeUiReader?: (ports: { authorize(): void; store: Store; service: {
    list(input: ComputeListInput): unknown; read(input: Required<ComputeReadInput>): Promise<unknown>;
  } }) => { list(input: ComputeListInput): Promise<unknown>; read(input: ComputeReadInput): Promise<unknown> };
  scienceScientificExecutionService?: () => {
    list(projectId: string, conversationId: string, limit?: number): unknown;
    wait(projectId: string, conversationId: string, executionId: string, afterCursor?: number, maxEvents?: number, waitMs?: number): Promise<unknown>;
  } & Partial<HumanComputeService>;
};
type CapabilityUiApi = {
  createScientificCapabilityUiReader?: (ports: { authorize(scope: Scope): void; inspect(scope: Scope): unknown }) => { inspect(scope: Scope): Promise<unknown> };
  inspectScientificCapabilityContext?: (store: Store, scope: Scope) => unknown;
};

/** Native, authenticated control operations, NOT an agent-callable tool surface. */
export type DaemonScienceCommand = (
  | DaemonSciencePublicationCommand
  | { op: "space.inspect"; input: { projectId: string; options?: Parameters<ReturnType<Science["scienceProjectSpaceService"]>["inspect"]>[1] } }
  | { op: "space.snapshot"; input: { projectId: string } }
  | { op: "space.link"; input: { projectId: string; link: Parameters<ReturnType<Science["scienceProjectSpaceService"]>["link"]>[1] } }
  | { op: "workspace.get"; input: { projectId: Parameters<Store["getProjectWorkspaceState"]>[0] } }
  | { op: "workspace.updateNavigation"; input: Parameters<Store["updateProjectNavigation"]>[0] }
  | { op: "workspace.replaceTabs"; input: Parameters<Store["replaceProjectWorkspaceTabs"]>[0] }
  | { op: "projects.updateDeliverable"; input: Parameters<Store["updateProjectDeliverable"]>[0] }
  | { op: "runtime.inspect"; input: Parameters<Science["inspectScienceRuntime"]>[1] }
  | { op: "runtime.select"; input: Parameters<Science["selectScienceRuntime"]>[1] }
  | { op: "compute.list"; input: ComputeListInput }
  | { op: "compute.read"; input: ComputeReadInput }
  | { op: "compute.interrupt" | "compute.clearGeneration"; input: HumanComputeInput; requester: NativeHumanComputeRequester }
  | { op: "compute.readHumanControl"; input: HumanComputeReadInput; requester: NativeHumanComputeRequester }
  | { op: "compute.runConsole"; input: HumanComputeConsoleInput; requester: NativeHumanComputeRequester }
  | { op: "compute.readConsoleRequest"; input: HumanComputeConsoleReadInput; requester: NativeHumanComputeRequester }
  | { op: "compute.beginSession"; input: HumanSessionBeginInput; requester: NativeHumanComputeRequester }
  | { op: "compute.runSession"; input: HumanSessionRunInput; requester: NativeHumanComputeRequester }
  | { op: "compute.readSession"; input: HumanSessionReadInput; requester: NativeHumanComputeRequester }
  | { op: "compute.readSessionRequest"; input: HumanSessionRequestReadInput; requester: NativeHumanComputeRequester }
  | { op: "compute.stopSession"; input: HumanSessionStopInput; requester: NativeHumanComputeRequester }
  | { op: "capability.inspect"; input: Scope }
  | { op: "loops.inspect"; input: { projectId: string } }
  | { op: "loops.start"; input: Parameters<Store["startLoopSession"]>[0] }
  | { op: "loops.transition"; input: Parameters<Store["transitionLoopSession"]>[0] }
  | { op: "composer.start"; input: Parameters<Conversations["start"]>[0] & { acceptSteeringOnBusy?: true } }
  | { op: "composer.runStatus"; input: Parameters<Conversations["getRunStatus"]>[0] }
  | { op: "composer.steer"; input: Parameters<Conversations["steer"]>[0] & { acceptSteeringOnBusy?: true } }
  | { op: "composer.reconcile" | "composer.cancel" | "composer.receipt"; input: TurnScope }
  | { op: "composer.steering"; input: Scope & { requestId?: string } }
  | { op: "composer.steeringCapability"; input: Scope }
  | { op: "composer.attach" | "questions.list" | "messages.list"; input: Scope }
  | { op: "questions.register" }
  | { op: "questions.answer"; input: Omit<Parameters<Questions["answer"]>[0], "source"> }
  | { op: "toolApprovals.state"; input: { projectId: string; chatId: string } }
  | { op: "toolApprovals.setAlwaysApproved"; input: { projectId: string; chatId: string; enabled: boolean } }
  | { op: "toolApprovals.resolve"; input: { projectId: string; chatId: string; requestId: string; decision: ToolApprovalDecision } }
  | { op: "toolApprovals.receipt"; input: { projectId: string; chatId: string; requestId: string } }
  | { op: "questionDecisions.read"; input:ScienceQuestionReadInput }
  | { op: "questionDecisions.answer"; input:ScienceQuestionAnswerInput }
  | { op: "askUser.list" }
  | { op: "askUser.answer"; input: { requestId: string; answer: string | null } }
  | { op: "lifecycle.get"; input: { projectId: string } }
  | { op: "lifecycle.revisions"; input: { projectId: string; studyId: string } }
  | { op: "math.command"; input: { projectId: string; requestId: string; command: unknown } }
  | { op: "math.cancel"; input: { projectId: string; requestId: string } }
  | { op: "events.replay"; input: TurnScope & { afterSequence?: number; limit?: number } }
  | { op: "loops.events"; input: { projectId: string; loopSessionId: string; afterSequence?: number; limit?: number } }
  | { op: "projects.list" }
  | { op: "autostart.hasRecoverableScienceWork" }
  | { op: "conversations.list"; input: { projectId: string } }
  | { op: "runtime.adoptSession"; input: { session: { cookieValue: string; userId?: string; workspaceId?: string; expiresAt?: number } | null } }
  | { op: "styles.list" }
  | { op: "styles.templateCatalog"; input: { lang: "ko" | "en" } }
  | { op: "styles.getProjectTemplate"; input: { projectId: string } }
  | { op: "styles.applyTemplate"; input: { projectId: string; templateId: string | null } }
  | { op: "styles.import"; input: { bytesBase64: string; fileName: string; name?: string } }
  | { op: "styles.rename"; input: { sha256: string; name: string } }
  | { op: "styles.delete" | "styles.saveEdited"; input: { sha256: string } }
  | { op: "styles.applyToProject"; input: { sha256: string; projectId: string } }
  | { op: "styles.samplePreview" | "styles.openForEditing"; input: { sha256: string; lang: "ko" | "en" } }) & {
  /** Main's validated native view or authenticated mobile owner producer only; never read from input. */
  nativeOwnerIntent?: true;
  /** Stable authenticated native/Mobile human request; never copied from model command fields. */
  ownerRequestId?: string;
};

export interface DaemonScienceStatus {
  schema: "agentlas.science-daemon-status.v1";
  ownerEpoch: string;
  state: "idle" | "starting" | "disabled" | "ready" | "closing" | "closed" | "failed";
  extensionVersion: string | null;
  errorCode: string | null;
  settled: boolean;
  activeToolRequests: number | null;
  hostGoalWakePending?: boolean;
}

export interface DaemonScienceEvent {
  schema: "agentlas.science-daemon-event.v1";
  ownerEpoch: string;
  kind: "turn" | "lifecycle" | "researcher-question" | "tool-approval" | "ask-user";
  payload: unknown;
}

export interface DaemonScienceService {
  start(): Promise<DaemonScienceStatus>;
  status(): DaemonScienceStatus;
  settled(): boolean;
  dispatch(command: DaemonScienceCommand): Promise<unknown>;
  close(): Promise<void>;
}

interface MathWorkspace {
  command(projectId: string, requestId: string, command: unknown): Promise<Record<string, unknown>>;
  cancel(projectId: string, requestId: string): { requested: boolean };
}

let executionOwner: string | null = null;
const errorCode = (error: unknown) => (error instanceof Error ? error.message : "science_daemon_operation_failed").slice(0, 240);

export function createDaemonScienceService(options: {
  ownerEpoch: string;
  /** Native daemon constructor identity; absent older hosts cannot admit human controls. */
  ownerServiceIdentity?: string;
  assertOwner(): void;
  onEvent?(event: DaemonScienceEvent): boolean | void;
  shutdownTimeoutMs?: number;
}): DaemonScienceService {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,199}$/.test(options.ownerEpoch)) throw new Error("science_daemon_owner_epoch_invalid");
  if (options.shutdownTimeoutMs !== undefined && (!Number.isSafeInteger(options.shutdownTimeoutMs)
    || options.shutdownTimeoutMs < 1_000 || options.shutdownTimeoutMs > 60_000)) throw new Error("science_daemon_shutdown_timeout_invalid");
  let state: DaemonScienceStatus["state"] = "idle";
  let extensionVersion: string | null = null;
  let lastError: string | null = null;
  let science: Science | null = null;
  let adapter: ReturnType<Science["createScienceDesktopLongRunAdapter"]> | null = null;
  let host: ReturnType<typeof import("./science-host")["installDaemonScienceHost"]> | null = null;
  let startPromise: Promise<DaemonScienceStatus> | null = null;
  let closePromise: Promise<void> | null = null;
  let runtimeOpened = false;
  let terminalStore: Store | null = null;
  let terminalConversations: Conversations | null = null;
  let activeToolCount: (() => number) | null = null;
  const commands = new Set<Promise<unknown>>();
  const unsubscribe: Array<() => void> = [];
  let approvals: typeof import("../runtime/tool-approval") | null = null;
  let grants: typeof import("../store/capability-grants") | null = null;
  let questionsUi: typeof import("../confirm/ask-user") | null = null;
  const approvalScopes = new Map<string, Scope>();

  const assertExecution = () => {
    options.assertOwner();
    if (state !== "ready" && state !== "starting") throw new Error("science_daemon_admission_closed");
  };
  const emit = (kind: DaemonScienceEvent["kind"], payload: unknown) => {
    try { return options.onEvent?.({ schema: "agentlas.science-daemon-event.v1", ownerEpoch: options.ownerEpoch, kind, payload }) === true; }
    catch { return false; /* A disconnected GUI cannot fail research. */ }
  };
  const questionProjection = (request: AskUserRequestEvent) => {
    if (!request.chatId || !science || !runtimeOpened) return null;
    const scope = science.scienceStore().getConversationScopeForRuntimeChat(request.chatId);
    // The canonical transport binding proves the audience. Provider labels
    // (codex/claude/byok) never decide whether an owner's card is reachable.
    return scope ? { ...request, ...scope, askedBy: "agentlas-science", chatId: scope.conversationId } : null;
  };
  const approvalProjection = (request: ToolApprovalRequestEvent) => {
    if (!request.chatId || !science || !runtimeOpened) return null;
    const scope = science.scienceStore().getConversationScopeForRuntimeChat(request.chatId);
    if (!scope) return null;
    approvalScopes.set(request.id, scope);
    // Match the existing bounded resolution ledger; active requests can always
    // recover their scope from the authoritative pending map.
    if (approvalScopes.size > 1_000) approvalScopes.delete(approvalScopes.keys().next().value!);
    return { ...request, ...scope, chatId: scope.conversationId };
  };
  const settled = () => adapter ? adapter.isSettled() : state !== "starting" && !runtimeOpened;
  const hostGoalWakePending = (): boolean => {
    if(!runtimeOpened)return false;
    try{options.assertOwner();}catch{return false;}
    const read=(science as {scienceHasDeferredHostGoalWake?:()=>boolean}|null)?.scienceHasDeferredHostGoalWake;
    if(!read)return false; // Older SDKs retain their existing residency contract.
    try{return read()===true;}catch{return true;} // Read failure is not proof of idleness.
  };
  const status = (): DaemonScienceStatus => ({
    schema: "agentlas.science-daemon-status.v1", ownerEpoch: options.ownerEpoch, state,
    extensionVersion, errorCode: lastError, settled: settled(), hostGoalWakePending:hostGoalWakePending(),
    activeToolRequests: runtimeOpened && activeToolCount ? activeToolCount() : null,
  });

  async function start(): Promise<DaemonScienceStatus> {
    options.assertOwner();
    if (state === "ready") return status();
    if (startPromise) return startPromise;
    // A start that failed before claiming execution or opening the store left nothing behind (live 2026-09-27~29: the
    // extension loader could not find 'electron' and Science stayed dead until the app was reinstalled). Such a start
    // may simply run again; one that failed after acquiring anything still needs a fresh process.
    if (state === "failed" && executionOwner === null && !runtimeOpened) { state = "idle"; lastError = null; }
    if (state === "closed" || state === "closing" || state === "failed") throw new Error("science_daemon_restart_requires_new_process");
    state = "starting";
    startPromise = (async () => {
      const extension = await import("../extensions/science");
      assertExecution();
      const installed = extension.scienceExtensionStatus();
      extensionVersion = installed.version ?? null;
      if (installed.phase !== "installed" || !installed.enabled) {
        state = "disabled";
        lastError = installed.errorCode ?? null;
        return status();
      }
      if (executionOwner !== null) throw new Error("science_daemon_execution_owner_already_claimed");
      executionOwner = options.ownerEpoch;
      science = await import("agentlas-science");
      assertExecution();
      science.configureScienceRuntimeRole("execution-owner");
      science.configureScienceServiceAvailability(() => {
        const current = extension.scienceExtensionStatus();
        return current.phase === "installed" && current.enabled;
      });
      const bootstrap = await import("./science-host");
      assertExecution();
      host = bootstrap.installDaemonScienceHost({ ...options, assertExecution,
        presentQuestion: question => emit("researcher-question", question) });
      const projection = await import("../long-run/science-projection");
      assertExecution();
      // Opening the store is not recovery. Adoption must precede every startup
      // reconciliation/projection and only changes proven Science-owned rows.
      terminalStore = science.scienceStore();
      runtimeOpened = true;
      [approvals, grants, questionsUi] = await Promise.all([
        import("../runtime/tool-approval"), import("../store/capability-grants"), import("../confirm/ask-user"),
      ]);
      assertExecution();
      // A verified Science build has a durable question inbox and an
      // authenticated answer command even when no renderer is attached yet.
      // Register that build capability before recovery can open a headless
      // turn; registration is not evidence that a person saw or answered it.
      host.registerQuestionUi();
      for (const request of approvals.listPendingToolApprovals()) approvalProjection(request);
      unsubscribe.push(approvals.onToolApprovalRequested(request => {
        const projected = approvalProjection(request);
        if (projected) emit("tool-approval", { type: "requested", projectId: projected.projectId,
          conversationId: projected.conversationId, chatId: projected.chatId, request: projected });
      }));
      unsubscribe.push(approvals.onToolApprovalResolved((requestId) => {
        const scope = approvalScopes.get(requestId);
        if (scope) emit("tool-approval", { type: "resolved", ...scope, chatId: scope.conversationId, requestId,
          outcome: approvals!.getToolApprovalResolution(requestId) });
      }));
      unsubscribe.push(questionsUi.onAskUserLifecycle(request => {
        const projected = questionProjection(request);
        return projected ? emit("ask-user", projected) : false;
      }));
      const gateway = science.scienceToolGateway();
      activeToolCount = () => gateway.activeRequestCount();
      projection.adoptScienceLongRunOwnership({ appInstanceId: options.ownerEpoch, assertOwner: options.assertOwner });
      adapter = science.createScienceDesktopLongRunAdapter({ project: host.project }, { shutdownTimeoutMs: options.shutdownTimeoutMs });
      terminalConversations = science.scienceConversationService();
      unsubscribe.push(terminalConversations.onEvent(event => emit("turn", event)));
      unsubscribe.push(science.scienceStore().onResearchLifecycleChanged(event => emit("lifecycle", event)));
      assertExecution();
      await adapter.recoverAndProjectAtStartup();
      assertExecution();
      lastError = null;
      state = "ready";
      return status();
    })().catch(error => {
      lastError = errorCode(error);
      if (state !== "closing") state = "failed";
      // Recovery can have scheduled a clock before a later recovery step fails.
      host?.stopClock();
      adapter?.closeAdmission();
      throw error;
    }).finally(() => { startPromise = null; });
    return startPromise;
  }

  const ready = (terminal = false) => {
    options.assertOwner();
    if (state !== "ready" || !science || !host) throw new Error("science_daemon_not_ready");
    // Runtime/model discovery crosses awaits. Recheck admission at the actual
    // store access so a late discovery result cannot mutate a closed runtime.
    // Only withdrawal may use already-open resources. It must neither reload
    // the extension nor re-enter its fresh-availability gate to stop an owner.
    const sourceStore = terminal ? terminalStore : science.scienceStore();
    const conversations = terminal ? terminalConversations : science.scienceConversationService();
    if (!sourceStore || !conversations) throw new Error("science_daemon_not_ready");
    const store = new Proxy(sourceStore, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? (...args: unknown[]) => {
          assertExecution();
          return Reflect.apply(value, target, args);
        } : value;
      },
    });
    return { api: science, store, conversations, host };
  };
  const page = (input: { afterSequence?: number; limit?: number }) => {
    const after = input.afterSequence ?? 0;
    const limit = input.limit ?? 250;
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 999) {
      throw new Error("science_daemon_event_cursor_invalid");
    }
    return { after, limit };
  };
  const approvalScope = (store: Store, input: { projectId: string; chatId: string }) => {
    if (typeof input.projectId !== "string" || !input.projectId.trim() || input.projectId.length > 256) throw new Error("science-tool-approval-project-invalid");
    if (typeof input.chatId !== "string" || !input.chatId.trim() || input.chatId.length > 256) throw new Error("science-tool-approval-chat-invalid");
    if (!store.listConversations(input.projectId).some(row => row.id === input.chatId)) throw new Error("science-tool-approval-chat-not-found");
    const binding = store.getConversationRuntimeBinding(input.projectId, input.chatId);
    return { projectId: input.projectId, conversationId: input.chatId, runtimeChatId: binding?.runtimeChatId ?? null };
  };
  const approvalState = (store: Store, input: { projectId: string; chatId: string }) => {
    const scope = approvalScope(store, input);
    return { projectId: input.projectId, chatId: input.chatId,
      alwaysApproved: Boolean(scope.runtimeChatId && grants!.isChatAlwaysApproved(scope.runtimeChatId)),
      pending: approvals!.listPendingToolApprovals().filter(request => request.chatId === scope.runtimeChatId)
        .map(request => approvalProjection(request)).filter(request => request !== null) };
  };
  const recordAcceptedAliveOwnerControl = (input: Parameters<typeof recordScienceAliveOwnerControl>[0]) => {
    try { assertExecution(); recordScienceAliveOwnerControl(input); }
    catch (error) { console.error("[science-daemon] alive owner control withheld", errorCode(error)); }
  };
  async function runCommand(command: DaemonScienceCommand): Promise<unknown> {
    if (!command || typeof command !== "object" || Array.isArray(command) || typeof command.op !== "string") throw new Error("science_daemon_command_invalid");
    if (command.op === "autostart.hasRecoverableScienceWork") {
      options.assertOwner();
      if (state !== "ready" || !science || !runtimeOpened) throw new Error("science_daemon_not_ready");
      // listProjects() is capped at 500. Use the published databasePath with a
      // separate read-only connection: this existence check covers every project
      // without loading a conversation service, migrating, or recovering work.
      const databasePath = science.scienceStore().databasePath;
      const { default: Database } = await import("better-sqlite3");
      assertExecution();
      const db = new Database(databasePath, { readonly: true, fileMustExist: true });
      try {
        const row = db.prepare(`SELECT (
          EXISTS (SELECT 1 FROM science_turns WHERE status IN ('queued','running','cancelling'))
          OR EXISTS (SELECT 1 FROM loop_sessions WHERE status IN ('running','queued','pausing'))
          -- An enabled Alive agent is durable work even when its next wake is
          -- observation-driven or a periodic review rather than a timestamp.
          OR EXISTS (SELECT 1 FROM alive_agents WHERE status='enabled')
          -- The owner can enable Full Autonomy while this GUI is already open.
          -- Its latest durable policy is work even before the next Alive sync
          -- materializes/enables the corresponding agent row.
          OR EXISTS (
            SELECT 1 FROM project_approval_policies p
            WHERE p.revision=(SELECT MAX(latest.revision) FROM project_approval_policies latest WHERE latest.project_id=p.project_id)
              AND p.mode='autonomous'
              AND EXISTS (SELECT 1 FROM json_each(p.scopes_json) WHERE value='full-autonomy')
          )
          -- Reconcile a wake/action that crossed a runtime boundary before
          -- shutdown, including one whose agent was suspended meanwhile.
          OR EXISTS (SELECT 1 FROM alive_wakes WHERE status IN ('reserved','running'))
          OR EXISTS (SELECT 1 FROM alive_actions WHERE status IN ('reserved','executing'))
          OR EXISTS (
            SELECT 1 FROM loop_sessions s
            JOIN conversation_runtime_bindings b ON b.runtime_chat_id=s.runtime_chat_id AND b.project_id=s.project_id
            JOIN loop_events e ON e.loop_session_id=s.id
            WHERE s.status='paused' AND json_extract(e.payload_json,'$.version')=s.version
              AND e.sequence=(SELECT MAX(later.sequence) FROM loop_events later
                WHERE later.loop_session_id=s.id
                  AND json_extract(later.payload_json,'$.version')=s.version
                  AND (later.code IN ('loop.retry_scheduled','loop.retry_withheld','loop.controller_settled_paused','loop.resume_failed','loop.pause')
                    OR later.code LIKE 'loop.paused.%'))
              AND (e.code='loop.retry_scheduled'
                OR (e.code IN ('loop.paused.app_closed','loop.paused.crash_recovery')
                  AND json_extract(e.payload_json,'$.stateSha256')=s.state_sha256))
          )
        ) AS has_work`).get() as { has_work: number };
        // A paused quota/auth failure is not a retry intent. In particular, an
        // older host-boundary event cannot override a later/current-version pause.
        return row.has_work === 1;
      } finally { db.close(); }
    }
    const terminal = command.op === "composer.cancel" || command.op === "composer.steer" && command.input.intent === "stop";
    const { api, store, conversations, host: activeHost } = ready(terminal);
    const ownerIntent = command.nativeOwnerIntent === true;
    const currentLife = (scope: Scope) => {
      try { return store.aliveLifetime().get(store.scienceAliveAgentId(scope.projectId)); }
      catch (error) { if ((error as { code?: string })?.code === "science_alive_core_unavailable") return null; throw error; }
    };
    const assertNonOwnerControl = (scope: Scope) => {
      if (store.scienceConversationStopped(scope.conversationId)) throw Error("science-steering-user-stopped");
      const life = currentLife(scope);
      if (life && life.status !== "enabled") throw Error("science-alive-owner-resume-required");
    };
    const lookupSteering = (store as Store & { getSteeringByRequestId?: (requestId: string) => ReturnType<Store["listSteering"]>[number] | null }).getSteeringByRequestId;
    const acceptedOwnerText = (input: Scope & { requestId: string; content?: unknown }, allowed: boolean) => {
      const priorSteering = typeof lookupSteering === "function" ? lookupSteering.call(store, input.requestId) : null;
      if (!priorSteering) return null;
      if (!allowed) throw Error("science-idempotency-input-conflict");
      // A receipt replay is read-only: it never restarts its target or grants a new owner intent.
      const target = store.getTurnForProject(input.projectId, priorSteering.targetTurnId);
      const message = store.getMessageForProject(input.projectId, input.conversationId, priorSteering.messageId);
      if (priorSteering.projectId !== input.projectId || priorSteering.conversationId !== input.conversationId
        || priorSteering.content !== (typeof input.content === "string" ? input.content.replace(/\r\n/g, "\n").trim() : "")
        || priorSteering.intent !== "steer" || priorSteering.runtimeSelection != null
        || !target || target.projectId !== input.projectId || target.conversationId !== input.conversationId
        || !message || message.role !== "user" || message.visibility !== "visible" || message.content !== priorSteering.content)
        throw Error("science-idempotency-input-conflict");
      const consumedStart = store.getTurnByRequestId(input.requestId);
      if (consumedStart && (priorSteering.status !== "applied" || consumedStart.id !== priorSteering.successorTurnId
        || consumedStart.projectId !== input.projectId || consumedStart.conversationId !== input.conversationId
        || consumedStart.parentTurnId !== target.id || consumedStart.origin !== "loop-continuation"
        || consumedStart.continuationBasis?.schema !== "agentlas.science-steering-continuation.v1"
        || !Array.isArray(consumedStart.continuationBasis.requestIds)
        || !consumedStart.continuationBasis.requestIds.includes(priorSteering.requestId)))
        throw Error("science-idempotency-input-conflict");
      // The opt-in queued branch reads the accepted owner text, not a new model-selection request.
      // Its target may have been retargeted at a later boundary; no selection or run is applied here.
      return { accepted: true, queued: true, steering: priorSteering };
    };
    const currentOwnerTextTarget = (input: Scope, selection?: unknown) => {
      const target = store.getActiveTurn(input.projectId, input.conversationId) ?? store.getLatestTurn(input.projectId, input.conversationId);
      if (!target || target.projectId !== input.projectId || target.conversationId !== input.conversationId
        || !["queued", "running", "cancelling", "completed", "failed", "cancelled", "interrupted"].includes(target.status))
        throw Error("science-steering-target-mismatch");
      // The approved revision governs future work; a historical target may have run a different model.
      const currentPin = api.normalizeScienceRuntimeSelection(store.executionRevision(input.projectId, input.conversationId).runtimeSelection
        ?? target.runtimeSelection);
      if (!currentPin?.model || selection !== undefined && JSON.stringify(selection) !== JSON.stringify(currentPin))
        throw Error("science-turn-runtime-selection-conflict");
      return target;
    };
    const assertOwnerTextCurrent = (input: Scope, epoch: number, lifeEpoch: number | null) => {
      assertExecution();
      const life = currentLife(input);
      if (store.scienceConversationControlState(input.conversationId).epoch !== epoch
        || (life?.controlEpoch ?? null) !== lifeEpoch || store.scienceConversationStopped(input.conversationId))
        throw Error("science-steering-user-stopped");
      if (life && life.status !== "enabled") throw Error("science-alive-owner-resume-required");
    };
    const steerOwnerInput = async (input: Parameters<Conversations["steer"]>[0] & { acceptSteeringOnBusy?: true },
      observation?: Parameters<typeof recordScienceAliveOwnerControl>[0]["observation"]) => {
      const ownerObservation = observation ?? (ownerIntent && input.intent !== "stop" ? captureScienceAliveOwnerControl({ ...input, control: "message" }) : undefined);
      const ownerStopEpoch = input.intent === "stop" ? null : store.scienceConversationControlState(input.conversationId).epoch;
      const lifetimeEpoch = input.intent === "stop" ? null : currentLife(input)?.controlEpoch ?? null;
      if (!ownerIntent && input.intent !== "stop") assertNonOwnerControl(input);
      // The opt-in belongs to host admission, never the domain steering digest or model input.
      const { acceptSteeringOnBusy: _acceptSteeringOnBusy, ...domainInput } = input;
      const result=await conversations.steer(domainInput);
      // Keep the accepted receipt; stale ownership or a later Stop/Pause withholds authority.
      let ownerControlCurrent = true;
      if (input.intent !== "stop") {
        try {
          assertExecution();
          ownerControlCurrent = store.scienceConversationControlState(input.conversationId).epoch === ownerStopEpoch
            && (currentLife(input)?.controlEpoch ?? null) === lifetimeEpoch;
        } catch (error) { ownerControlCurrent = false; console.error("[science-daemon] owner control withheld", errorCode(error)); }
      }
      if(ownerIntent&&input.intent!=="stop"&&ownerControlCurrent)recordScienceHostGoalOwnerControl({projectId:input.projectId,
        conversationId:input.conversationId,loopSessionId:store.getActiveLoopSession(input.projectId)?.id??null,
        requestId:input.requestId,control:"message"});
      if(ownerIntent&&input.intent!=="stop"&&ownerControlCurrent && ["accepted","applied"].includes(result.status)) recordAcceptedAliveOwnerControl({
        projectId:input.projectId,conversationId:input.conversationId,requestId:input.requestId,control:"message",observation:ownerObservation!});
      return result;
    };
    switch (command.op) {
      case "compute.beginSession":
      case "compute.runSession":
      case "compute.readSession":
      case "compute.readSessionRequest":
      case "compute.stopSession":
      case "compute.interrupt":
      case "compute.clearGeneration":
      case "compute.runConsole":
      case "compute.readConsoleRequest":
      case "compute.readHumanControl": {
        const compute = api as unknown as ComputeUiApi;
        if (!options.ownerServiceIdentity || typeof compute.createScientificComputeUiControls !== "function" || typeof compute.scienceScientificExecutionService !== "function") throw Error("science_native_compute_human_unavailable");
        const requester = command.requester;
        const assertRequester = () => {
          assertExecution(); // Includes the current exclusive native owner lease.
          const keys = ["kind", "viewInstanceId", "releaseId", "ownerServiceIdentity", "ownerBootId"];
          if (!requester || Object.keys(requester).length !== keys.length || Object.keys(requester).some(key => !keys.includes(key))
            || requester.kind !== "signed-science-main-frame" || keys.some(key => typeof requester[key as keyof NativeHumanComputeRequester] !== "string"
              || requester[key as keyof NativeHumanComputeRequester].length < 1 || requester[key as keyof NativeHumanComputeRequester].length > 200
              || /[\u0000-\u001f]/u.test(requester[key as keyof NativeHumanComputeRequester]))
            || requester.ownerBootId !== options.ownerEpoch || requester.ownerServiceIdentity !== options.ownerServiceIdentity) throw Error("science_native_compute_human_owner_invalid");
        };
        assertRequester();
        const execution = () => { assertRequester(); return compute.scienceScientificExecutionService!(); };
        const call = (method: keyof HumanComputeService, supplied: NativeHumanComputeRequester, input: HumanComputeInput | HumanComputeReadInput | HumanComputeConsoleInput | HumanComputeConsoleReadInput | HumanSessionInput, guard: HumanComputeGuard) => {
          assertRequester();
          const service = execution();
          if (typeof service[method] !== "function") throw Error("science_native_compute_human_unavailable");
          return (service[method] as (r: NativeHumanComputeRequester, i: HumanComputeInput | HumanComputeReadInput | HumanComputeConsoleInput | HumanComputeConsoleReadInput | HumanSessionInput, g: HumanComputeGuard) => unknown).call(service, supplied, input, guard);
        };
        const controls = compute.createScientificComputeUiControls({ authorize: () => { assertRequester(); return { ...requester }; }, store,
          service: { interruptHuman: (r, i, g) => call("interruptHuman", r, i, g), clearGenerationHuman: (r, i, g) => call("clearGenerationHuman", r, i, g),
            readHumanControl: (r, i, g) => call("readHumanControl", r, i, g),
            runHuman: (r, i, g) => call("runHuman", r, i, g), readHumanConsole: (r, i, g) => call("readHumanConsole", r, i, g),
            beginHumanSession: (r,i,g)=>call("beginHumanSession",r,i,g),
            runHumanSession: (r,i,g)=>call("runHumanSession",r,i,g),
            readHumanSession: (r,i,g)=>call("readHumanSession",r,i,g),
            readHumanSessionRequest: (r,i,g)=>call("readHumanSessionRequest",r,i,g),
            stopHumanSession: (r,i,g)=>call("stopHumanSession",r,i,g) } });
        if (command.op === "compute.runConsole" && typeof controls.runConsole !== "function"
          || command.op === "compute.readConsoleRequest" && typeof controls.readConsoleRequest !== "function") throw Error("science_native_compute_human_console_unavailable");
        const sessionPort = {"compute.beginSession":"beginSession","compute.runSession":"runSession","compute.readSession":"readSession","compute.readSessionRequest":"readSessionRequest","compute.stopSession":"stopSession"} as const;
        if(command.op in sessionPort) {
          const method=sessionPort[command.op as keyof typeof sessionPort],fn=controls[method];
          if(typeof fn!=="function")throw Error("science_native_compute_human_session_unavailable");
          const result=await (fn as (input:HumanSessionInput)=>Promise<unknown>).call(controls,command.input as HumanSessionInput);assertRequester();return result;
        }
        const result = await (command.op === "compute.runConsole" ? controls.runConsole!(command.input)
          : command.op === "compute.readConsoleRequest" ? controls.readConsoleRequest!(command.input)
          : command.op === "compute.interrupt" ? controls.interrupt(command.input) : command.op === "compute.clearGeneration" ? controls.clearGeneration(command.input) : command.op === "compute.readHumanControl" ? controls.readHumanControl(command.input) : Promise.reject(Error("science_native_compute_human_command_invalid")));
        assertRequester();
        return result;
      }
      case "capability.inspect": {
        const capability = api as unknown as CapabilityUiApi;
        if (typeof capability.createScientificCapabilityUiReader !== "function" || typeof capability.inspectScientificCapabilityContext !== "function") {
          throw new Error("science_capability_context_ui_unavailable");
        }
        const reader = capability.createScientificCapabilityUiReader({ authorize: assertExecution,
          inspect: s => { assertExecution(); return capability.inspectScientificCapabilityContext!(store, s); } });
        return reader.inspect(command.input);
      }
      case "compute.list":
      case "compute.read": {
        const compute = api as unknown as ComputeUiApi;
        if (typeof compute.createScientificComputeUiReader !== "function" || typeof compute.scienceScientificExecutionService !== "function") {
          throw new Error("science_native_compute_ui_unavailable");
        }
        // The exclusive daemon lease is rechecked at authorization and each
        // service access. The execution service stays lazy in the owning daemon.
        const execution = () => { assertExecution(); return compute.scienceScientificExecutionService!(); };
        const reader = compute.createScientificComputeUiReader({ authorize: assertExecution, store, service: {
          list: i => execution().list(i.projectId, i.conversationId, i.limit),
          read: i => execution().wait(i.projectId, i.conversationId, i.executionId, i.afterCursor, i.maxEvents, i.waitMs),
        } });
        return command.op === "compute.list" ? reader.list(command.input) : reader.read(command.input);
      }
      case "space.inspect": return api.scienceProjectSpaceService().inspect(command.input.projectId, command.input.options);
      case "space.snapshot": return api.scienceProjectSpaceService().snapshot(command.input.projectId);
      case "space.link": return api.scienceProjectSpaceService().link(command.input.projectId, command.input.link);
      case "workspace.get": return store.getProjectWorkspaceState(command.input.projectId);
      case "workspace.updateNavigation": return store.updateProjectNavigation(command.input);
      case "workspace.replaceTabs": return store.replaceProjectWorkspaceTabs(command.input);
      case "projects.updateDeliverable": return store.updateProjectDeliverable(command.input);
      case "runtime.inspect": return api.inspectScienceRuntime(store, command.input);
      case "runtime.select": {
        const result = await api.selectScienceRuntime(store, command.input);
        assertExecution();
        if (result.pending && result.steering) await conversations.reconcileSteering({ ...command.input, turnId: result.steering.targetTurnId });
        return result;
      }
      case "loops.inspect": {
        const sessions = store.listLoopSessions(command.input.projectId);
        const session = store.getActiveLoopSession(command.input.projectId) ?? sessions[0] ?? null;
        return { schema: "agentlas.science.research-loop-inspection/v1",
          active: session !== null && ["queued", "running", "pausing", "paused"].includes(session.status), session,
          episodes: session ? store.listResearchEpisodes(command.input.projectId, session.id) : [],
          events: session ? store.listLoopEvents(session.id, 0, 1_000) : [],
          // Facts that split one lifecycle phase into the stages a researcher sees (data collection vs analysis, drafting
          // vs peer review). Optional: an older pinned Science has no such export and the overview falls back to phases.
          stageFacts: (() => {
            const read = (api as { scienceStudyStageFacts?: (store: unknown, projectId: string) => unknown }).scienceStudyStageFacts;
            try { return typeof read === "function" ? read(store, command.input.projectId) : null; } catch { return null; }
          })() };
      }
      case "loops.start": {
        const runtimeSelection = await api.resolveScienceRuntimeSelection(store, command.input);
        assertExecution();
        if (!runtimeSelection?.model) throw new Error("science-runtime-selection-required");
        return store.startLoopSession({ ...command.input, runtimeSelection });
      }
      case "loops.transition": {
        const record = command.input;
        const prior = store.getLoopSessionForProject(record.projectId, record.loopSessionId);
        const ownerConversation = ownerIntent && record.action === "resume" && prior ? store.listConversations(record.projectId).find(candidate =>
          store.getConversationRuntimeBinding(record.projectId, candidate.id)?.runtimeChatId === prior.runtimeChatId) : null;
        const ownerObservation = ownerConversation ? captureScienceAliveOwnerControl({ projectId: record.projectId,
          conversationId: ownerConversation.id, requestId: record.requestId, control: "resume" }) : undefined;
        if (record.action === "resume" && !ownerIntent && prior) {
          const conversation = store.listConversations(record.projectId).find(candidate =>
            store.getConversationRuntimeBinding(record.projectId, candidate.id)?.runtimeChatId === prior.runtimeChatId);
          if (!conversation) throw Error("science-loop-resume-conversation-missing");
          assertNonOwnerControl({ projectId: record.projectId, conversationId: conversation.id });
        }
        if(record.action==="resume"&&prior?.status==="queued"){
          if(prior.version!==record.expectedLoopVersion||prior.stateSha256!==record.expectedLoopStateSha256)throw new Error("science-loop-version-conflict");
          const conversation=store.listConversations(record.projectId).find(candidate=>store.getConversationRuntimeBinding(record.projectId,candidate.id)?.runtimeChatId===prior.runtimeChatId);
          const turn=conversation?store.getActiveTurn(record.projectId,conversation.id):null;
          if(turn&&readScienceHostGoalWake({projectId:record.projectId,conversationId:turn.conversationId,turnId:turn.id,
            invocationRunId:turn.invocationRunId,loopSessionId:prior.id})){
            if (ownerIntent) recordScienceHostGoalOwnerControl({projectId:record.projectId,conversationId:turn.conversationId,loopSessionId:prior.id,requestId:record.requestId,control:"resume"});
            const accepted = conversations.resumeLoop({requestId:record.requestId,projectId:record.projectId,conversationId:turn.conversationId,
              loopSessionId:prior.id,expectedLoopVersion:prior.version,expectedLoopStateSha256:prior.stateSha256,locale:record.locale,clearUserStop:ownerIntent});
            if (ownerIntent && accepted.accepted === true) recordAcceptedAliveOwnerControl({projectId:record.projectId,conversationId:turn.conversationId,
              requestId:record.requestId,control:"resume",resumeLoopSessionId:prior.id,observation:ownerObservation!});
            return {session:store.getLoopSessionForProject(record.projectId,prior.id)??prior,replayed:true,proceed:true as const,advisories:[]};
          }
        }
        const result = store.transitionLoopSession(record);
        if ((record.action === "pause" || record.action === "cancel") && prior?.activeRunId) {
          const turn = store.getTurnByInvocationRunId(prior.activeRunId);
          if (turn?.projectId === record.projectId) {
            try { conversations.cancel({ projectId: turn.projectId, conversationId: turn.conversationId, turnId: turn.id }); }
            catch (error) { console.error("[science-daemon] loop cancellation failed", errorCode(error)); }
          }
        }
        if (record.action !== "resume" || result.session.status !== "queued") return result;
        try {
          if (!result.session.runtimeSelection?.model) throw new Error("science-runtime-selection-required");
          const conversation = store.listConversations(record.projectId).find(candidate =>
            store.getConversationRuntimeBinding(record.projectId, candidate.id)?.runtimeChatId === result.session.runtimeChatId);
          if (!conversation) throw new Error("science-loop-resume-conversation-missing");
          if (ownerIntent) recordScienceHostGoalOwnerControl({projectId:record.projectId,conversationId:conversation.id,
            loopSessionId:result.session.id,requestId:record.requestId,control:"resume"});
          const accepted = conversations.resumeLoop({ requestId: record.requestId, projectId: record.projectId, conversationId: conversation.id,
            loopSessionId: result.session.id, expectedLoopVersion: result.session.version,
            expectedLoopStateSha256: result.session.stateSha256, locale: record.locale, clearUserStop:ownerIntent });
          if (ownerIntent && accepted.accepted === true) recordAcceptedAliveOwnerControl({projectId:record.projectId,conversationId:conversation.id,
            requestId:record.requestId,control:"resume",resumeLoopSessionId:result.session.id,observation:ownerObservation!});
          return { ...result, session: store.getLoopSessionForProject(record.projectId, result.session.id) ?? result.session };
        } catch (error) {
          const current = store.getLoopSessionForProject(record.projectId, result.session.id);
          if (current?.status === "queued" && current.version === result.session.version && current.stateSha256 === result.session.stateSha256) {
            try { store.failLoopResumeDispatch({ projectId: current.projectId, loopSessionId: current.id,
              expectedLoopVersion: current.version, expectedLoopStateSha256: current.stateSha256, errorCode: errorCode(error) }); }
            catch { /* A concurrent canonical transition wins. */ }
          }
          throw error;
        }
      }
      case "composer.start": {
        const input = command.input;
        const canSteer = ownerIntent && input.acceptSteeringOnBusy === true && input.mode === "append-user-message"
          && input.parentTurnId == null;
        if (canSteer && typeof lookupSteering !== "function") throw Error("science-steering-admission-unavailable");
        const priorSteering = acceptedOwnerText(input, canSteer);
        if (priorSteering) return priorSteering;
        const ownerObservation = ownerIntent ? captureScienceAliveOwnerControl({ ...command.input, control: "message" }) : undefined;
        const ownerStopEpoch = store.scienceConversationControlState(command.input.conversationId).epoch;
        const lifetimeEpoch = currentLife(command.input)?.controlEpoch ?? null;
        if (!ownerIntent) assertNonOwnerControl(command.input);
        const runtimeSelection = api.normalizeScienceRuntimeSelection(command.input.runtimeSelection
          ?? await api.resolveScienceRuntimeSelection(store, command.input));
        // Another delivery of this same owner text may have been accepted/applied during model discovery.
        const acceptedDuringDiscovery = acceptedOwnerText(input, canSteer);
        if (acceptedDuringDiscovery) return acceptedDuringDiscovery;
        assertExecution();
        if (store.scienceConversationControlState(command.input.conversationId).epoch !== ownerStopEpoch
          || (currentLife(command.input)?.controlEpoch ?? null) !== lifetimeEpoch) throw Error("science-steering-user-stopped");
        if (!ownerIntent) assertNonOwnerControl(command.input);
        if (!runtimeSelection?.model) throw new Error("science-runtime-selection-required");
        const binding=store.getConversationRuntimeBinding(command.input.projectId,command.input.conversationId);
        if(ownerIntent&&binding)recordScienceHostGoalOwnerControl({projectId:command.input.projectId,conversationId:command.input.conversationId,
          loopSessionId:store.getActiveLoopSession(command.input.projectId)?.id??null,requestId:command.input.requestId,control:"message"});
        const acceptBusy = async () => {
          const accepted = acceptedOwnerText(input, canSteer);
          if (accepted) return accepted;
          assertOwnerTextCurrent(input, ownerStopEpoch, lifetimeEpoch);
          // A committed start must always keep its original run/message receipt.
          if (store.getTurnByRequestId(input.requestId)) throw Error("science-turn-request-already-started");
          const target = currentOwnerTextTarget(input, runtimeSelection);
          const steering = await steerOwnerInput({ requestId: input.requestId, projectId: input.projectId,
            conversationId: input.conversationId, targetTurnId: target.id,
            content: input.mode === "append-user-message" ? input.content : "", intent: "steer" }, ownerObservation);
          return { accepted: true as const, queued: true as const, steering };
        };
        return startOwnerSendOrAcceptRefusal(() => {
          const accepted = typeof conversations.acceptResearcherRun === "function"
            ? conversations.acceptResearcherRun({ ...input, runtimeSelection })
            : conversations.start({ ...input, runtimeSelection });
          if (ownerIntent && accepted.accepted === true) recordAcceptedAliveOwnerControl({projectId:input.projectId,
            conversationId:input.conversationId,requestId:input.requestId,control:"message",observation:ownerObservation!});
          return accepted;
        }, cause => canSteer && sendRefusalCode(cause) === "science-turn-already-active" ? acceptBusy() : null);
      }
      case "composer.steer": {
        const input = command.input;
        const canSteer = ownerIntent && input.intent === "steer" && input.acceptSteeringOnBusy === true;
        if (!canSteer) return steerOwnerInput(input);
        if (typeof lookupSteering !== "function") throw Error("science-steering-admission-unavailable");
        const accepted = acceptedOwnerText(input, true);
        if (accepted) return accepted;
        const original = store.getTurnForProject(input.projectId, input.targetTurnId);
        if (!original || original.projectId !== input.projectId || original.conversationId !== input.conversationId)
          throw Error("science-steering-target-mismatch");
        const observation = captureScienceAliveOwnerControl({ ...input, control: "message" });
        const epoch = store.scienceConversationControlState(input.conversationId).epoch;
        const lifeEpoch = currentLife(input)?.controlEpoch ?? null;
        return startOwnerSendOrAcceptRefusal(() => steerOwnerInput(input, observation), async cause => {
          if (sendRefusalCode(cause) !== "science-steering-target-stale") return null;
          const prior = acceptedOwnerText(input, true);
          if (prior) return prior;
          assertOwnerTextCurrent(input, epoch, lifeEpoch);
          if (store.getTurnByRequestId(input.requestId)) throw Error("science-turn-request-already-started");
          const target = currentOwnerTextTarget(input);
          const steering = await steerOwnerInput({ ...input, targetTurnId: target.id }, observation);
          return { accepted: true, queued: true, steering };
        });
      }
      case "composer.reconcile": return conversations.reconcileSteering(command.input);
      case "composer.cancel": return conversations.cancel(command.input);
      case "composer.receipt": return conversations.receipt(command.input);
      case "composer.runStatus": return conversations.getRunStatus(command.input);
      case "composer.attach": return conversations.attach(command.input);
      case "composer.steeringCapability": {
        if (!store.listConversations(command.input.projectId, { includeReferee: true }).some(item => item.id === command.input.conversationId))
          throw Error("science-conversation-not-found");
        return { supported: typeof (store as Store & { getSteeringByRequestId?: unknown }).getSteeringByRequestId === "function" };
      }
      case "composer.steering": {
        const input = command.input;
        if (input.requestId === undefined) {
          // A Science build on the common steering path (PLAN S3) lists its directions from the common current-turn store
          // too; an older build has only its own rows.
          const listOwnerDirections = (conversations as Conversations & { listOwnerDirections?: (projectId: string, conversationId: string) => unknown }).listOwnerDirections;
          return typeof listOwnerDirections === "function" ? listOwnerDirections.call(conversations, input.projectId, input.conversationId)
            : store.listSteering(input.projectId, input.conversationId);
        }
        if (typeof input.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId))
          throw Error("science-steering-request-id-required");
        const lookup = (store as Store & { getSteeringByRequestId?: (requestId: string) => ReturnType<Store["listSteering"]>[number] | null }).getSteeringByRequestId;
        if (typeof lookup !== "function") throw Error("science-steering-admission-unavailable");
        let receipt = lookup.call(store, input.requestId);
        if (!receipt) {
          // A direction sent on the common steering path (PLAN S3) has no Science steering row: its receipt is the host's. The
          // phone's lost-reply recovery asks for it by request ID, so answer from the merged list or it would wait for ever.
          const listOwnerDirections = (conversations as Conversations & { listOwnerDirections?: (projectId: string, conversationId: string) => ReturnType<Store["listSteering"]> }).listOwnerDirections;
          receipt = typeof listOwnerDirections === "function"
            ? listOwnerDirections.call(conversations, input.projectId, input.conversationId).find(row => row.requestId === input.requestId) ?? null
            : null;
        }
        if (!receipt) return [];
        const target = store.getTurnForProject(input.projectId, receipt.targetTurnId);
        const message = store.getMessageForProject(input.projectId, input.conversationId, receipt.messageId);
        if (receipt.projectId !== input.projectId || receipt.conversationId !== input.conversationId
          || !target || target.projectId !== input.projectId || target.conversationId !== input.conversationId
          || !message || message.role !== "user" || message.visibility !== "visible" || message.content !== receipt.content)
          throw Error("science-steering-target-mismatch");
        return [receipt];
      }
      case "questions.register": return activeHost.registerQuestionUi();
      case "questions.list": return store.researcherQuestions().list(command.input.projectId, command.input.conversationId);
      case "questions.answer": {
        const answered = store.researcherQuestions().answer({ ...command.input, source: "authenticated-user" });
        emit("researcher-question", answered);
        return answered;
      }
      case "toolApprovals.state": return approvalState(store, command.input);
      case "toolApprovals.setAlwaysApproved": {
        const scope = approvalScope(store, command.input);
        if (!scope.runtimeChatId) {
          // The user can choose standing consent before the first research turn.
          // Establish the same durable runtime-chat binding the composer uses;
          // this creates no invocation or model call.
          const { ensureScienceRuntimeChat } = await import("../store/chats");
          assertExecution();
          const conversation = store.listConversations(scope.projectId).find(row => row.id === scope.conversationId)!;
          const chat = ensureScienceRuntimeChat({ conversationId: scope.conversationId, title: conversation.title });
          store.bindConversationRuntime({ requestId: randomUUID(), projectId: scope.projectId,
            conversationId: scope.conversationId, runtimeChatId: chat.id });
          scope.runtimeChatId = chat.id;
        }
        if (command.input.enabled === true) {
          // Commit the standing grant before releasing any pending runtime waiters.
          grants!.grantChatAlwaysApproval(scope.runtimeChatId, "science-dropdown");
          for (const request of approvals!.listPendingToolApprovals()) {
            if (request.chatId !== scope.runtimeChatId) continue;
            approvalProjection(request);
            approvals!.resolveToolApproval(request.id, "allow_session", toolApprovalActionId(request.id, "allow_session"));
          }
        } else grants!.revokeChatAlwaysApproval(scope.runtimeChatId);
        return approvalState(store, command.input);
      }
      case "toolApprovals.resolve":
      case "toolApprovals.receipt": {
        const scope = approvalScope(store, command.input);
        const { requestId } = command.input;
        if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 256) throw new Error("science-tool-approval-request-invalid");
        if (command.op === "toolApprovals.resolve" && !["allow_once", "allow_session", "allow_always", "deny"].includes(command.input.decision)) throw new Error("science-tool-approval-decision-invalid");
        const pending = approvals!.listPendingToolApprovals().find(request => request.id === requestId);
        if (pending) {
          if (pending.chatId !== scope.runtimeChatId) throw new Error("science-tool-approval-chat-mismatch");
          approvalProjection(pending);
          return command.op === "toolApprovals.receipt" ? approvals!.getToolApprovalResolution(requestId)
            : approvals!.resolveToolApproval(requestId, command.input.decision, toolApprovalActionId(requestId, command.input.decision));
        }
        const priorScope = approvalScopes.get(requestId);
        if (priorScope && (priorScope.projectId !== scope.projectId || priorScope.conversationId !== scope.conversationId)) throw new Error("science-tool-approval-chat-mismatch");
        const receipt = approvals!.getToolApprovalResolution(requestId);
        if (!priorScope && receipt.status !== "not_found") throw new Error("science-tool-approval-request-scope-unavailable");
        if (priorScope && receipt.status === "not_found" && command.op === "toolApprovals.resolve") {
          // Explicit post-denial consent applies to future calls only. Receipt
          // replay above never replays an action or invents a missing grant.
          return approvals!.resolveToolApproval(requestId, command.input.decision, toolApprovalActionId(requestId, command.input.decision));
        }
        return receipt;
      }
      case "questionDecisions.read": return scienceQuestionHost().read(command.input);
      case "questionDecisions.answer": {
        assertExecution();
        if(!ownerIntent || !command.ownerRequestId) throw new Error("science-question-owner-intent-required");
        return scienceQuestionHost().answerFromOwner(command.input,{requestId:command.ownerRequestId});
      }
      case "askUser.list": return questionsUi!.listPendingAskUserRequests().map(questionProjection).filter(question => question !== null);
      case "askUser.answer": {
        const pending = questionsUi!.listPendingAskUserRequests().find(question => question.requestId === command.input.requestId);
        if (!pending || !questionProjection(pending)) return false;
        return questionsUi!.submitAskUserAnswer(pending.requestId, typeof command.input.answer === "string" ? command.input.answer : null);
      }
      case "lifecycle.get": {
        const lifecycle = store.getResearchLifecycleForProject(command.input.projectId);
        if (!lifecycle) throw new Error("science-research-lifecycle-canonical-missing");
        return lifecycle;
      }
      case "lifecycle.revisions": {
        const lifecycle = store.getResearchLifecycleForProject(command.input.projectId);
        if (!lifecycle || lifecycle.studyId !== command.input.studyId) throw new Error("science-research-lifecycle-noncanonical-study");
        return store.listResearchLifecycleRevisions(command.input.projectId, command.input.studyId);
      }
      case "publication.getPublicationPreference": case "publication.setPublicationPreference":
      case "publication.prepareRenderJob": case "publication.createRenderJob":
      case "publication.getRenderJob": case "publication.listRenderJobs":
      case "publication.retryRenderJob": case "publication.cancelRenderJob":
      case "publication.readRenderOutput": case "publication.listTypesetProfiles":
      case "manuscripts.render": case "manuscripts.editNode":
      case "journal.listJournalProfiles": case "journal.inspectOfficialGuidelines":
      case "journal.recordManualGuidelineText": case "journal.ensureNeutralJournalProfile":
      case "journal.inspectGuidelineMirror": case "journal.createJournalProfile":
      case "journal.confirmJournalIdentity": case "journal.confirmHumanAttestation":
      case "journal.createSubmissionExport": case "journal.validate":
        return dispatchSciencePublicationCommand(api, store, command, assertExecution);
      case "runtime.adoptSession": {
        // Main hands over the signed-in session so Agentlas serving is listed and usable for Science (auth.ts).
        const auth = await import("../auth");
        const adopted = auth.adoptHostSessionHandoff(command.input.session);
        (await import("../runtime/detect")).clearDetectCache();
        return { adopted };
      }
      case "styles.list": case "styles.import": case "styles.rename": case "styles.delete":
      case "styles.templateCatalog": case "styles.getProjectTemplate": case "styles.applyTemplate":
      case "styles.applyToProject": case "styles.samplePreview": case "styles.openForEditing": case "styles.saveEdited": {
        // A Science build without the style library answers with an update request, never a crash.
        const provider = (api as unknown as { scienceStyleLibrary?: () => Record<string, (input?: unknown) => unknown> }).scienceStyleLibrary;
        if (!provider) throw new Error("science-style-library-update-required");
        const library = provider();
        if ((command.op === "styles.applyToProject" || command.op === "styles.getProjectTemplate" || command.op === "styles.applyTemplate") && !store.getProject(command.input.projectId)) throw new Error("science-project-not-found");
        const method = command.op.slice("styles.".length);
        if (typeof library[method] !== "function") throw new Error("science-style-library-update-required");
        return "input" in command ? library[method]!(command.input) : library[method]!();
      }
      case "math.command":
      case "math.cancel": {
        const provider = (api as unknown as { scienceMathWorkspace?: () => MathWorkspace }).scienceMathWorkspace;
        if (!provider) throw new Error("science-math-service-update-required");
        if (!store.getProject(command.input.projectId)) throw new Error("science-project-not-found");
        if (typeof command.input.requestId !== "string" || !command.input.requestId.trim()
          || command.input.requestId.length > 200 || /[\u0000-\u001f]/u.test(command.input.requestId)) throw new Error("science-math-request-invalid");
        return command.op === "math.command"
          ? provider().command(command.input.projectId, command.input.requestId, command.input.command)
          : provider().cancel(command.input.projectId, command.input.requestId);
      }
      case "events.replay": {
        conversations.receipt(command.input); // Verifies exact project/conversation/turn ownership.
        const { after, limit } = page(command.input);
        const rows = store.listTurnEvents(command.input.projectId, command.input.turnId, after, limit + 1);
        const events = rows.slice(0, limit);
        return { events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
      }
      case "loops.events": {
        if (!store.getLoopSessionForProject(command.input.projectId, command.input.loopSessionId)) throw new Error("science-loop-session-not-found");
        const { after, limit } = page(command.input);
        const rows = store.listLoopEvents(command.input.loopSessionId, after, limit + 1);
        const events = rows.slice(0, limit);
        return { events, nextSequence: events.at(-1)?.sequence ?? after, hasMore: rows.length > limit };
      }
      case "projects.list": return store.listProjects();
      case "conversations.list": return store.listConversations(command.input.projectId);
      case "messages.list": return store.listMessagesForProject(command.input.projectId, command.input.conversationId);
      default: throw new Error("science_daemon_operation_not_allowed");
    }
  }

  function dispatch(command: DaemonScienceCommand): Promise<unknown> {
    const running = runCommand(command);
    commands.add(running);
    void running.then(() => commands.delete(running), () => commands.delete(running));
    return running;
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise;
    if (state === "closed") return Promise.resolve();
    state = "closing";
    host?.stopClock();
    adapter?.closeAdmission();
    const deadline = Date.now() + (options.shutdownTimeoutMs ?? 8_000);
    const withinDeadline = async <T>(pending: Promise<T>): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([pending, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("science_daemon_shutdown_timed_out")), Math.max(1, deadline - Date.now()));
        })]);
      } finally { if (timer) clearTimeout(timer); }
    };
    closePromise = (async () => {
      // start() may be crossing an await boundary; it will observe admission
      // closed before doing further recovery. Only then may resources close.
      if (startPromise) await withinDeadline(startPromise.catch(() => undefined));
      host?.stopClock();
      adapter?.closeAdmission();
      if (adapter) await withinDeadline(adapter.interrupt());
      // Do not close SQLite underneath an in-flight model discovery/Math call.
      await withinDeadline(Promise.allSettled([...commands]));
      for (const release of unsubscribe.splice(0)) release();
      if (runtimeOpened && science) await science.closeScienceStore();
      runtimeOpened = false;
      terminalStore = null;
      terminalConversations = null;
      adapter = null;
      state = "closed";
    })().catch(error => { lastError = errorCode(error); state = "failed"; throw error; });
    return closePromise;
  }
  return { start, status, settled, dispatch, close };
}
