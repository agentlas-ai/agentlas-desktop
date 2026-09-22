/**
 * One daemon owns the complete Science execution graph. The caller must publish
 * its exclusive control socket/store lease before start(), and keep that lease
 * through close(). GUI processes are authenticated clients, never co-owners.
 * Importing this module does not load Science, open a database, or recover work.
 */
type Science = typeof import("agentlas-science");
type Store = ReturnType<Science["scienceStore"]>;
type Conversations = ReturnType<Science["scienceConversationService"]>;
type Questions = ReturnType<Store["researcherQuestions"]>;
type Scope = { projectId: string; conversationId: string };
type TurnScope = Scope & { turnId: string };

/** Native, authenticated control operations, NOT an agent-callable tool surface. */
export type DaemonScienceCommand =
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
  | { op: "math.command"; input: { projectId: string; requestId: string; command: unknown } }
  | { op: "math.cancel"; input: { projectId: string; requestId: string } }
  | { op: "events.replay"; input: TurnScope & { afterSequence?: number; limit?: number } }
  | { op: "loops.events"; input: { projectId: string; loopSessionId: string; afterSequence?: number; limit?: number } }
  | { op: "projects.list" }
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
  kind: "turn" | "lifecycle" | "researcher-question";
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
  onEvent?(event: DaemonScienceEvent): void;
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

  const assertExecution = () => {
    options.assertOwner();
    if (state !== "ready" && state !== "starting") throw new Error("science_daemon_admission_closed");
  };
  const emit = (kind: DaemonScienceEvent["kind"], payload: unknown) => {
    try { options.onEvent?.({ schema: "agentlas.science-daemon-event.v1", ownerEpoch: options.ownerEpoch, kind, payload }); }
    catch { /* Durable turn/loop events are authoritative; a disconnected GUI cannot fail research. */ }
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
  async function runCommand(command: DaemonScienceCommand): Promise<unknown> {
    if (!command || typeof command !== "object" || Array.isArray(command) || typeof command.op !== "string") throw new Error("science_daemon_command_invalid");
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
      case "questions.answer": return store.researcherQuestions().answer({ ...command.input, source: "authenticated-user" });
      case "math.command":
      case "math.cancel": {
        const provider = (api as Science & { scienceMathWorkspace?: () => MathWorkspace }).scienceMathWorkspace;
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
