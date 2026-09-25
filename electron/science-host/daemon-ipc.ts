import { randomUUID } from "node:crypto";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import type { ProductExtensionPermission } from "../../shared/product-extension";
import type { DaemonScienceCommand, DaemonScienceEvent } from "../daemon/science-service";
import { ScienceDaemonClientError, type ScienceDaemonClient } from "./daemon-client";
import { onAuthSessionInvalidated, onAuthSessionRestored, sessionForDaemonHandoff } from "../auth";
import { registerScienceMathHandlers } from "./math-ipc";
import { registerSciencePublicationIpc, SCIENCE_PUBLICATION_IPC_CHANNELS } from "./publication-ipc";
import { registerScienceStyleLibraryIpc, SCIENCE_STYLE_LIBRARY_IPC_CHANNELS } from "./style-library-ipc";

type Row = Record<string, unknown>;
type Scope = { projectId: string; conversationId: string };
type Cursor = { sequence: number; target: number };
interface Viewer {
  sender: WebContents;
  scope: Scope | null;
  lifecycleProjectId: string | null;
  approvals: Scope | null;
  questions: Scope | null;
  asks: boolean;
  approvalIds: Set<string>;
  askRequests: Map<string, Row>;
  cursors: Map<string, Cursor>;
  draining: Promise<void> | null;
  dispose(): void;
}

export interface ScienceDaemonObservation {
  connected: boolean;
  ownerEpoch: string | null;
  errorCode: string | null;
  subscribers: number;
}

export interface ScienceDaemonExecutionIpc {
  /** Observation only: never starts a daemon, a Science runtime, or a turn. */
  reconnect(): Promise<ScienceDaemonObservation>;
  /** Detaches the GUI only. It must not cancel daemon-owned work. */
  close(): void;
}

const CORE_CHANNELS = [
  "science:runtime:inspect", "science:runtime:select",
  "science:researchLoops:inspect", "science:researchLoops:start", "science:researchLoops:transition",
  "science:composer:start", "science:composer:steer", "science:composer:reconcileSteering",
  "science:composer:steering", "science:composer:cancel", "science:composer:attach", "science:composer:receipt",
  "science:conversations:list", "science:messages:list",
  "science:researchLifecycle:get", "science:researchLifecycle:revisions",
  "science:researcherQuestions:register", "science:researcherQuestions:list", "science:researcherQuestions:answer",
  "science:toolApprovals:state", "science:toolApprovals:setAlwaysApproved", "science:toolApprovals:resolve",
  "science:askUser:list", "science:askUser:answer",
] as const;

/** Main removes its old handlers for exactly this set before registering once. */
export const SCIENCE_DAEMON_EXECUTION_IPC_CHANNELS: readonly string[] = [
  ...CORE_CHANNELS, "science:math:command", "science:math:cancel", ...SCIENCE_PUBLICATION_IPC_CHANNELS, ...SCIENCE_STYLE_LIBRARY_IPC_CHANNELS,
];

function row(value: unknown): Row | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : null;
}
function input(value: unknown): Row {
  const result = row(row(value)?.input);
  if (!result) throw new Error("science-daemon-input-invalid");
  return result;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f]/u.test(value)) {
    throw new Error("science-daemon-scope-invalid");
  }
  return value;
}
function scope(value: Row): Scope { return { projectId: id(value.projectId), conversationId: id(value.conversationId) }; }
function matches(left: Scope | null, right: Row | null): boolean {
  return !!left && !!right && left.projectId === right.projectId && left.conversationId === right.conversationId;
}
function failureCode(error: unknown): string {
  const code = row(error)?.code;
  return typeof code === "string" ? code : "science_daemon_observation_failed";
}

/**
 * Native Science execution boundary. No Science runtime/store imports, no local
 * fallback, no timers. The signed view supplies intent; agentlasd owns execution.
 */
export function registerScienceDaemonExecutionIpc(options: {
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">;
  assertScienceSender(event: IpcMainInvokeEvent, envelope: unknown, permission?: ProductExtensionPermission): unknown;
  /** Revalidates the active signed release at every event delivery. */
  assertScienceViewPermission(senderId: number, permission: ProductExtensionPermission): unknown;
  client: ScienceDaemonClient;
  onConnectionState?(state: ScienceDaemonObservation): void;
}): ScienceDaemonExecutionIpc {
  const { ipcMain, client } = options;
  const handOverSession = () => {
    void client.command({ op: "runtime.adoptSession", input: { session: sessionForDaemonHandoff() } }).catch(() => { /* daemon not ready: the next restore or reconnect retries */ });
  };
  const viewers = new Map<number, Viewer>();
  let closed = false;
  let unsubscribe: (() => void) | null = null;
  let connecting: Promise<ScienceDaemonObservation> | null = null;
  let generation = 0;
  let ownerEpoch: string | null = null;
  let subscribedScopes = "";

  const observation = (connected: boolean, errorCode: string | null = null): ScienceDaemonObservation => ({
    connected, ownerEpoch, errorCode, subscribers: viewers.size,
  });
  const report = (state: ScienceDaemonObservation) => {
    try { options.onConnectionState?.(state); } catch { /* Observer cannot change execution. */ }
    return state;
  };
  const release = () => { generation++; unsubscribe?.(); unsubscribe = null; ownerEpoch = null; subscribedScopes = ""; };
  const remove = (viewer: Viewer) => {
    if (viewers.get(viewer.sender.id) !== viewer) return;
    viewers.delete(viewer.sender.id);
    viewer.dispose();
    if (!viewers.size) { release(); report(observation(false)); }
    else if (!closed && unsubscribe) void reconnect();
  };
  const live = (viewer: Viewer) => !closed && viewers.get(viewer.sender.id) === viewer && !viewer.sender.isDestroyed();
  const send = (viewer: Viewer, channel: string, payload: unknown, permission: ProductExtensionPermission = "science:agent-runtime") => {
    if (!live(viewer)) { remove(viewer); return false; }
    try {
      options.assertScienceViewPermission(viewer.sender.id, permission);
      viewer.sender.send(channel, payload);
      return true;
    } catch { remove(viewer); return false; }
  };
  const admit = (event: IpcMainInvokeEvent, envelope: unknown, permission: ProductExtensionPermission = "science:agent-runtime") => {
    if (closed) throw new Error("science-daemon-ipc-closed");
    options.assertScienceSender(event, envelope, permission);
    if (event.senderFrame !== event.sender.mainFrame) throw new Error("science-extension-subframe-denied");
  };
  const viewerFor = (event: IpcMainInvokeEvent): Viewer => {
    const existing = viewers.get(event.sender.id);
    if (existing && existing.sender === event.sender) return existing;
    if (existing) remove(existing);
    const destroyed = () => remove(viewer);
    const navigated = (_event: unknown, _url: string, _inPlace: boolean, mainFrame: boolean) => { if (mainFrame) remove(viewer); };
    const viewer: Viewer = { sender: event.sender, scope: null, lifecycleProjectId: null, approvals: null,
      questions: null, asks: false, approvalIds: new Set(), askRequests: new Map(), cursors: new Map(), draining: null,
      dispose() { viewer.sender.removeListener("destroyed", destroyed); viewer.sender.removeListener("did-start-navigation", navigated); } };
    viewers.set(event.sender.id, viewer);
    event.sender.once("destroyed", destroyed);
    event.sender.on("did-start-navigation", navigated);
    return viewer;
  };
  const watch = (viewer: Viewer, next: Scope) => {
    if (!matches(viewer.scope, next)) { viewer.scope = next; viewer.cursors.clear(); }
  };
  const cursor = (viewer: Viewer, turnId: string): Cursor => {
    let found = viewer.cursors.get(turnId);
    if (!found) {
      // Keep bounded per-view history. Evicted turns remain available durably.
      if (viewer.cursors.size >= 64) viewer.cursors.delete(viewer.cursors.keys().next().value!);
      found = { sequence: 0, target: 0 };
      viewer.cursors.set(turnId, found);
    }
    return found;
  };
  const deliverTurn = (viewer: Viewer, value: unknown): boolean => {
    const event = row(value);
    if (!event || !matches(viewer.scope, event) || typeof event.turnId !== "string"
      || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1) return false;
    const position = cursor(viewer, event.turnId);
    if (Number(event.sequence) <= position.sequence) return true;
    if (Number(event.sequence) !== position.sequence + 1) return false;
    if (!send(viewer, "science:turnEvent", event)) return false;
    position.sequence = Number(event.sequence);
    position.target = Math.max(position.target, position.sequence);
    return true;
  };

  async function drain(viewer: Viewer): Promise<void> {
    if (viewer.draining) {
      const priorGeneration = generation;
      try { await viewer.draining; }
      catch (error) { if (priorGeneration === generation) throw error; }
      if (!live(viewer)) return;
      return drain(viewer);
    }
    const boundScope = viewer.scope;
    const boundGeneration = generation;
    viewer.draining = (async () => {
      if (!boundScope) return;
      for (const [turnId, position] of viewer.cursors) {
        // Capture a finite committed target. New pushes schedule another drain;
        // a running model cannot turn one recovery into an unbounded replay.
        const target = position.target;
        while (live(viewer) && matches(viewer.scope, boundScope) && generation === boundGeneration && position.sequence < target) {
          const reply = row(await client.commandObserved({ op: "events.replay", input: {
            ...boundScope, turnId, afterSequence: position.sequence, limit: 500,
          } }));
          if (!live(viewer) || !matches(viewer.scope, boundScope) || generation !== boundGeneration) return;
          if (!Array.isArray(reply?.events) || !reply.events.length) throw new Error("science-daemon-replay-gap");
          const before = position.sequence;
          for (const value of reply.events) {
            if (Number(row(value)?.sequence) > target) break;
            if (!deliverTurn(viewer, value)) throw new Error("science-daemon-replay-sequence-invalid");
          }
          if (position.sequence <= before) throw new Error("science-daemon-replay-stalled");
        }
      }
    })().finally(() => { viewer.draining = null; });
    return viewer.draining;
  }
  const kickDrain = (viewer: Viewer) => {
    void drain(viewer).then(() => {
      if (live(viewer) && unsubscribe && [...viewer.cursors.values()].some(value => value.target > value.sequence)) kickDrain(viewer);
    }, error => report(observation(!!unsubscribe, failureCode(error))));
  };

  const askMatches = (viewer: Viewer, value: unknown) => {
    const request = row(value);
    return viewer.asks && !!request && request.askedBy === "agentlas-science" && matches(viewer.scope, request);
  };
  const askUserScopes = (): Scope[] => {
    const scopes = new Map<string, Scope>();
    for (const viewer of [...viewers.values()]) {
      if (!viewer.asks || !live(viewer)) continue;
      try { options.assertScienceViewPermission(viewer.sender.id, "science:agent-runtime"); }
      catch { continue; }
      if (viewer.scope) scopes.set(JSON.stringify(viewer.scope), viewer.scope);
    }
    // Native view count is bounded in the shell. Reject, never advertise an
    // arbitrary subset if that invariant changes.
    if (scopes.size > 128) throw new Error("science-daemon-subscription-scope-limit");
    return [...scopes.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
  };
  const sendApproval = (viewer: Viewer, value: unknown) => {
    const request = row(value);
    if (typeof request?.id !== "string") return;
    if (send(viewer, "science:toolApprovalRequest", request)) viewer.approvalIds.add(request.id);
  };
  const sendAsk = (viewer: Viewer, value: unknown) => {
    const request = row(value);
    if (typeof request?.requestId !== "string" || !askMatches(viewer, request)) return;
    if (!send(viewer, "science:askUser", request)) return;
    if (Number(request.expiresAt) > 0) viewer.askRequests.set(request.requestId, request);
    else viewer.askRequests.delete(request.requestId);
  };
  function onEvent(event: DaemonScienceEvent): void {
    const payload = row(event.payload);
    if (!payload) return;
    for (const viewer of [...viewers.values()]) {
      if (event.kind === "turn" && matches(viewer.scope, payload)) {
        if (typeof payload.turnId !== "string" || !Number.isSafeInteger(payload.sequence) || Number(payload.sequence) < 1) continue;
        cursor(viewer, payload.turnId).target = Math.max(cursor(viewer, payload.turnId).target, Number(payload.sequence));
        if (!deliverTurn(viewer, payload)) kickDrain(viewer);
      } else if (event.kind === "lifecycle" && viewer.lifecycleProjectId === payload.projectId) {
        send(viewer, "science:researchLifecycleChanged", payload, "science:projects");
      } else if (event.kind === "researcher-question") {
        const receipt = row(payload.receipt);
        if (matches(viewer.questions, receipt) || matches(viewer.scope, receipt)) {
          send(viewer, "science:researcherQuestionChanged", { receipt: { projectId: receipt!.projectId, conversationId: receipt!.conversationId } });
        }
      } else if (event.kind === "tool-approval" && matches(viewer.approvals, payload)) {
        if (payload.type === "requested") sendApproval(viewer, payload.request);
        else if (payload.type === "resolved" && typeof payload.requestId === "string") {
          viewer.approvalIds.delete(payload.requestId);
          send(viewer, "science:toolApprovalResolution", { ...row(payload.outcome), requestId: payload.requestId });
        }
      } else if (event.kind === "ask-user") sendAsk(viewer, payload);
    }
  }

  async function recover(viewer: Viewer): Promise<void> {
    const boundScope = viewer.scope;
    if (boundScope) {
      // Recover the previously observed turn even when a newer autonomous turn
      // is now current. A new turn must not hide the previous final receipt.
      for (const [turnId, position] of viewer.cursors) {
        const receipt = row(await client.commandObserved({ op: "composer.receipt", input: { ...boundScope, turnId } }));
        if (!live(viewer) || !matches(viewer.scope, boundScope)) return;
        if (Number.isSafeInteger(receipt?.lastSequence)) position.target = Math.max(position.target, Number(receipt!.lastSequence));
      }
      const attached = row(await client.commandObserved({ op: "composer.attach", input: boundScope }));
      if (!live(viewer) || !matches(viewer.scope, boundScope)) return;
      const turn = row(attached?.turn);
      if (turn && typeof turn.id === "string" && Number.isSafeInteger(turn.lastSequence)) {
        cursor(viewer, turn.id).target = Math.max(cursor(viewer, turn.id).target, Number(turn.lastSequence));
      }
      await drain(viewer);
    }
    if (!live(viewer)) return;
    if (viewer.lifecycleProjectId) {
      const projectId = viewer.lifecycleProjectId;
      const revision = row(await client.commandObserved({ op: "lifecycle.get", input: { projectId } }));
      if (viewer.lifecycleProjectId === projectId && revision) send(viewer, "science:researchLifecycleChanged", {
        projectId, studyId: revision.studyId, revision: revision.revision, phase: revision.phase,
        status: revision.status, stateSha256: revision.stateSha256,
      }, "science:projects");
    }
    if (viewer.questions) send(viewer, "science:researcherQuestionChanged", { receipt: { ...viewer.questions } });
    if (viewer.approvals) {
      const watched = viewer.approvals;
      const state = row(await client.commandObserved({ op: "toolApprovals.state", input: { projectId: watched.projectId, chatId: watched.conversationId } }));
      if (matches(viewer.approvals, watched) && Array.isArray(state?.pending)) {
        const pendingIds = new Set(state.pending.map(request => row(request)?.id));
        for (const requestId of viewer.approvalIds) if (!pendingIds.has(requestId)) {
          const receipt = await client.commandObserved({ op: "toolApprovals.receipt", input: {
            projectId: watched.projectId, chatId: watched.conversationId, requestId,
          } });
          if (!matches(viewer.approvals, watched)) break;
          send(viewer, "science:toolApprovalResolution", receipt);
          viewer.approvalIds.delete(requestId);
        }
        for (const request of state.pending) sendApproval(viewer, request);
      }
    }
    if (viewer.asks) {
      const requests = await client.commandObserved({ op: "askUser.list" });
      if (Array.isArray(requests)) {
        const pendingIds = new Set(requests.map(request => row(request)?.requestId));
        for (const [requestId, request] of viewer.askRequests) if (!pendingIds.has(requestId)) sendAsk(viewer, { ...request, expiresAt: 0 });
        for (const request of requests) sendAsk(viewer, request);
      }
    }
  }

  function reconnect(automatic = false): Promise<ScienceDaemonObservation> {
    if (closed || !viewers.size) return Promise.resolve(observation(false));
    if (connecting) return connecting.then(state => {
      if (closed || !viewers.size) return observation(false);
      return state.connected && JSON.stringify(askUserScopes()) !== subscribedScopes ? reconnect(automatic) : state;
    });
    let scopes: Scope[];
    try { scopes = askUserScopes(); } catch (error) { return Promise.resolve(report(observation(false, failureCode(error)))); }
    const scopesKey = JSON.stringify(scopes);
    if (unsubscribe && scopesKey === subscribedScopes) return Promise.resolve(observation(true));
    if (unsubscribe) release();
    const attempt = ++generation;
    let pendingStop: (() => void) | null = null;
    connecting = (async () => {
      const status = await client.status();
      if (status.state !== "ready") return report(observation(false, "science_daemon_science_unavailable"));
      handOverSession();
      if (closed || !viewers.size || generation !== attempt) return observation(false);
      const stop = await client.subscribe(event => {
        if (generation === attempt && event.ownerEpoch === status.ownerEpoch) onEvent(event);
      }, error => {
        if (generation !== attempt) return;
        release();
        report(observation(false, failureCode(error)));
        // One attempt per observed disconnect. Failed connections stay offline
        // until a real UI request or explicit caller reattach; there is no poll.
        if (!automatic && !connecting && viewers.size && !closed) void reconnect(true);
      }, { askUserScopes: scopes });
      pendingStop = stop;
      if (closed || !viewers.size || generation !== attempt) { stop(); return observation(false); }
      const after = await client.status();
      if (after.ownerEpoch !== status.ownerEpoch || after.state !== "ready") {
        stop(); return report(observation(false, "science_daemon_boot_changed"));
      }
      unsubscribe = stop;
      subscribedScopes = scopesKey;
      pendingStop = null;
      ownerEpoch = status.ownerEpoch;
      for (const viewer of [...viewers.values()]) {
        try { await recover(viewer); } catch (error) { report(observation(true, failureCode(error))); }
      }
      return report(observation(true));
    })().catch(error => { pendingStop?.(); return report(observation(false, failureCode(error))); }).finally(() => { connecting = null; });
    return connecting;
  }

  const connectForIntent = async (event: IpcMainInvokeEvent, envelope: unknown, start = false) => {
    if (start) await client.ensureStarted();
    admit(event, envelope);
    await reconnect();
    admit(event, envelope);
  };
  const dispatch = (op: DaemonScienceCommand["op"], payload: Row, observed = true) => {
    const command = { op, input: payload } as DaemonScienceCommand;
    return observed ? client.commandObserved(command) : client.command(command);
  };
  const register = (channel: string, handler: (event: IpcMainInvokeEvent, envelope: unknown) => unknown,
    permission: ProductExtensionPermission = "science:agent-runtime") => ipcMain.handle(channel, (event, envelope: unknown) => {
      admit(event, envelope, permission);
      return handler(event, envelope);
    });

  for (const action of ["inspect", "select"] as const) register(`science:runtime:${action}`, (event, envelope) => {
    const payload = input(envelope); scope(payload);
    return dispatch(`runtime.${action}`, payload);
  });
  register("science:researchLoops:inspect", (_event, envelope) => dispatch("loops.inspect", { projectId: id(row(envelope)?.projectId) }), "science:projects");
  register("science:researchLoops:start", (_event, envelope) => dispatch("loops.start", input(envelope), false));
  register("science:researchLoops:transition", (_event, envelope) => {
    const payload = input(envelope);
    return dispatch("loops.transition", payload, payload.action !== "resume");
  });
  for (const action of ["start", "attach"] as const) register(`science:composer:${action}`, async (event, envelope) => {
    const payload = input(envelope), watched = scope(payload), viewer = viewerFor(event);
    watch(viewer, watched);
    await connectForIntent(event, envelope, action === "start");
    try {
      return await dispatch(`composer.${action}`, action === "attach" ? watched : payload, true);
    } catch (error) {
      // Only this store refusal proves that the existing message was already bound.
      // Keep every other remote failure as a transport failure with uncertain effects.
      if (action === "start" && error instanceof ScienceDaemonClientError
        && error.failure.remoteSourceCode === "science-user-message-already-used") {
        throw Object.assign(new Error(error.failure.remoteSourceCode), { code: error.failure.remoteSourceCode });
      }
      throw error;
    }
  });
  for (const [channel, op] of [
    ["steer", "composer.steer"], ["reconcileSteering", "composer.reconcile"], ["steering", "composer.steering"],
    ["cancel", "composer.cancel"], ["receipt", "composer.receipt"],
  ] as const) register(`science:composer:${channel}`, (_event, envelope) => dispatch(op, input(envelope)));
  register("science:conversations:list", (_event, envelope) => dispatch("conversations.list", { projectId: id(row(envelope)?.projectId) }), "science:projects");
  register("science:messages:list", (_event, envelope) => dispatch("messages.list", scope(row(envelope) ?? {})), "science:projects");
  for (const action of ["get", "revisions"] as const) register(`science:researchLifecycle:${action}`, async (event, envelope) => {
    const payload = row(envelope) ?? {}, projectId = id(payload.projectId);
    viewerFor(event).lifecycleProjectId = projectId;
    admit(event, envelope, "science:projects");
    await reconnect();
    return dispatch(`lifecycle.${action}`, { projectId, ...(action === "revisions" ? { studyId: id(payload.studyId) } : {}) }, true);
  }, "science:projects");
  register("science:researcherQuestions:register", async () => {
    await client.commandObserved({ op: "questions.register" });
    return { ok: true };
  });
  register("science:researcherQuestions:list", async (event, envelope) => {
    const watched = scope(row(envelope) ?? {}), viewer = viewerFor(event);
    viewer.questions = watched;
    await connectForIntent(event, envelope);
    return client.commandObserved({ op: "questions.list", input: watched });
  });
  register("science:researcherQuestions:answer", (_event, envelope) => {
    const payload = input(envelope);
    if (typeof payload.answer !== "string") throw new Error("science-researcher-question-answer-invalid");
    return client.commandObserved({ op: "questions.answer", input: { ...scope(payload), requestId: randomUUID(),
      questionId: id(payload.questionId), expectedSequence: 1, answer: payload.answer } });
  });
  for (const action of ["state", "setAlwaysApproved"] as const) register(`science:toolApprovals:${action}`, async (event, envelope) => {
    const payload = row(envelope) ?? {}, projectId = id(payload.projectId), chatId = id(payload.chatId);
    const viewer = viewerFor(event), watched = { projectId, conversationId: chatId };
    if (!matches(viewer.approvals, watched)) viewer.approvalIds.clear();
    viewer.approvals = watched;
    await connectForIntent(event, envelope);
    const state = await dispatch(`toolApprovals.${action}`, { projectId, chatId, ...(action === "setAlwaysApproved" ? { enabled: payload.enabled === true } : {}) }, true);
    const pending = row(state)?.pending;
    if (matches(viewer.approvals, watched) && Array.isArray(pending)) {
      viewer.approvalIds = new Set(pending.flatMap(request => typeof row(request)?.id === "string" ? [String(row(request)!.id)] : []));
    }
    return state;
  });
  register("science:toolApprovals:resolve", (_event, envelope) => dispatch("toolApprovals.resolve", input(envelope), true));
  register("science:askUser:list", async (event, envelope) => {
    const viewer = viewerFor(event); viewer.asks = true;
    await connectForIntent(event, envelope);
    const requests = await client.commandObserved({ op: "askUser.list" });
    return Array.isArray(requests) ? requests.filter(request => askMatches(viewer, request)) : [];
  });
  register("science:askUser:answer", async (event, envelope) => {
    const payload = row(envelope) ?? {}, requestId = id(payload.requestId);
    if (payload.answer !== null && typeof payload.answer !== "string") throw new Error("science-ask-user-answer-invalid");
    const viewer = viewers.get(event.sender.id);
    const requests = await client.commandObserved({ op: "askUser.list" });
    if (!viewer || !Array.isArray(requests) || !requests.some(request => row(request)?.requestId === requestId && askMatches(viewer, request))) {
      throw new Error("science-ask-user-request-not-found");
    }
    admit(event, envelope);
    return client.commandObserved({ op: "askUser.answer", input: { requestId, answer: payload.answer as string | null } });
  });
  registerScienceMathHandlers({ ipcMain, client, assertScienceSender: (event, envelope) => admit(event, envelope, "science:projects") });
  registerSciencePublicationIpc({ ipc: ipcMain, client, assertScienceSender: (event, envelope, permission) => admit(event, envelope, permission) });
  registerScienceStyleLibraryIpc({ ipc: ipcMain, client, assertScienceSender: (event, envelope, permission) => admit(event, envelope, permission) });
  // Science lists models and runs turns in the daemon, which cannot restore the session itself; hand it over now and on
  // every restore/invalidation so Agentlas serving (credits) is available to Science like it is to Work.
  handOverSession();
  const stopSessionRestored = onAuthSessionRestored(() => handOverSession());
  const stopSessionInvalidated = onAuthSessionInvalidated(() => handOverSession());
  return { reconnect, close() {
    if (closed) return;
    closed = true;
    stopSessionRestored(); stopSessionInvalidated();
    release();
    for (const viewer of [...viewers.values()]) remove(viewer);
    for (const channel of SCIENCE_DAEMON_EXECUTION_IPC_CHANNELS) ipcMain.removeHandler(channel);
    client.close();
  } };
}
