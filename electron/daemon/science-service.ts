/**
 * One daemon owns the complete Science execution graph. The caller must publish
 * its exclusive control socket/store lease before start(), and keep that lease
 * through close(). GUI processes are authenticated clients, never co-owners.
 * Importing this module does not load Science, open a database, or recover work.
 */
import type { ToolApprovalDecision, ToolApprovalRequestEvent, AskUserRequestEvent } from "../../shared/types";
import { randomUUID } from "node:crypto";
import { toolApprovalActionId } from "../../shared/tool-approval-action";
import { dispatchSciencePublicationCommand, type DaemonSciencePublicationCommand } from "./science-publication-commands";
type Science = typeof import("agentlas-science");
type Store = ReturnType<Science["scienceStore"]>;
type Conversations = ReturnType<Science["scienceConversationService"]>;
type Questions = ReturnType<Store["researcherQuestions"]>;
type Scope = { projectId: string; conversationId: string };
type TurnScope = Scope & { turnId: string };

/** Native, authenticated control operations, NOT an agent-callable tool surface. */
export type DaemonScienceCommand =
  | DaemonSciencePublicationCommand
  | { op: "runtime.inspect"; input: Parameters<Science["inspectScienceRuntime"]>[1] }
  | { op: "runtime.select"; input: Parameters<Science["selectScienceRuntime"]>[1] }
  | { op: "loops.inspect"; input: { projectId: string } }
  | { op: "loops.start"; input: Parameters<Store["startLoopSession"]>[0] }
  | { op: "loops.transition"; input: Parameters<Store["transitionLoopSession"]>[0] }
  | { op: "composer.start"; input: Parameters<Conversations["start"]>[0] }
  | { op: "composer.steer"; input: Parameters<Conversations["steer"]>[0] }
  | { op: "composer.reconcile" | "composer.cancel" | "composer.receipt"; input: TurnScope }
  | { op: "composer.attach" | "composer.steering" | "questions.list" | "messages.list"; input: Scope }
  | { op: "questions.register" }
  | { op: "questions.answer"; input: Omit<Parameters<Questions["answer"]>[0], "source"> }
  | { op: "toolApprovals.state"; input: { projectId: string; chatId: string } }
  | { op: "toolApprovals.setAlwaysApproved"; input: { projectId: string; chatId: string; enabled: boolean } }
  | { op: "toolApprovals.resolve"; input: { projectId: string; chatId: string; requestId: string; decision: ToolApprovalDecision } }
  | { op: "toolApprovals.receipt"; input: { projectId: string; chatId: string; requestId: string } }
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
  | { op: "conversations.list"; input: { projectId: string } };

export interface DaemonScienceStatus {
  schema: "agentlas.science-daemon-status.v1";
  ownerEpoch: string;
  state: "idle" | "starting" | "disabled" | "ready" | "closing" | "closed" | "failed";
  extensionVersion: string | null;
  errorCode: string | null;
  settled: boolean;
  activeToolRequests: number | null;
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
    if (request.askedBy !== "agentlas-science" || !request.chatId || !science || !runtimeOpened) return null;
    const scope = science.scienceStore().getConversationScopeForRuntimeChat(request.chatId);
    return scope ? { ...request, ...scope, chatId: scope.conversationId } : null;
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
  const status = (): DaemonScienceStatus => ({
    schema: "agentlas.science-daemon-status.v1", ownerEpoch: options.ownerEpoch, state,
    extensionVersion, errorCode: lastError, settled: settled(),
    activeToolRequests: runtimeOpened && activeToolCount ? activeToolCount() : null,
  });

  async function start(): Promise<DaemonScienceStatus> {
    options.assertOwner();
    if (state === "ready") return status();
    if (startPromise) return startPromise;
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
      science.scienceStore();
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
      unsubscribe.push(science.scienceConversationService().onEvent(event => emit("turn", event)));
      unsubscribe.push(science.scienceStore().onResearchLifecycleChanged(event => emit("lifecycle", event)));
      assertExecution();
      await adapter.recoverAndProjectAtStartup();
      assertExecution();
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

  const ready = () => {
    options.assertOwner();
    if (state !== "ready" || !science || !host) throw new Error("science_daemon_not_ready");
    // Runtime/model discovery crosses awaits. Recheck admission at the actual
    // store access so a late discovery result cannot mutate a closed runtime.
    const store = new Proxy(science.scienceStore(), {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return typeof value === "function" ? (...args: unknown[]) => {
          assertExecution();
          return Reflect.apply(value, target, args);
        } : value;
      },
    });
    return { api: science, store, conversations: science.scienceConversationService(), host };
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
    const { api, store, conversations, host: activeHost } = ready();
    switch (command.op) {
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
          events: session ? store.listLoopEvents(session.id, 0, 1_000) : [] };
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
          conversations.resumeLoop({ requestId: record.requestId, projectId: record.projectId, conversationId: conversation.id,
            loopSessionId: result.session.id, expectedLoopVersion: result.session.version,
            expectedLoopStateSha256: result.session.stateSha256, locale: record.locale });
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
        const runtimeSelection = api.normalizeScienceRuntimeSelection(command.input.runtimeSelection
          ?? await api.resolveScienceRuntimeSelection(store, command.input));
        assertExecution();
        if (!runtimeSelection?.model) throw new Error("science-runtime-selection-required");
        return conversations.start({ ...command.input, runtimeSelection });
      }
      case "composer.steer": return conversations.steer(command.input);
      case "composer.reconcile": return conversations.reconcileSteering(command.input);
      case "composer.cancel": return conversations.cancel(command.input);
      case "composer.receipt": return conversations.receipt(command.input);
      case "composer.attach": return conversations.attach(command.input);
      case "composer.steering": return store.listSteering(command.input.projectId, command.input.conversationId);
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
      if (runtimeOpened && science) science.closeScienceStore();
      runtimeOpened = false;
      adapter = null;
      state = "closed";
    })().catch(error => { lastError = errorCode(error); state = "failed"; throw error; });
    return closePromise;
  }
  return { start, status, settled, dispatch, close };
}
