import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
  humanViewInstanceId: string;
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
  "science:researchCompute:list", "science:researchCompute:read",
  "science:researchCompute:interrupt", "science:researchCompute:clearGeneration", "science:researchCompute:readHumanControl",
  "science:researchCompute:runConsole", "science:researchCompute:readConsoleRequest",
  "science:researchCompute:beginSession", "science:researchCompute:runSession", "science:researchCompute:readSession", "science:researchCompute:readSessionRequest", "science:researchCompute:stopSession",
  "science:researchCapabilities:inspect",
  "science:researchLoops:inspect", "science:researchLoops:start", "science:researchLoops:transition",
  "science:composer:start", "science:composer:steer", "science:composer:reconcileSteering",
  "science:composer:steering", "science:composer:cancel", "science:composer:attach", "science:composer:receipt",
  "science:conversations:list", "science:messages:list",
  "science:researchLifecycle:get", "science:researchLifecycle:revisions",
  "science:researcherQuestions:register", "science:researcherQuestions:list", "science:researcherQuestions:answer",
  "science:toolApprovals:state", "science:toolApprovals:setAlwaysApproved", "science:toolApprovals:resolve",
  "science:askUser:list", "science:askUser:answer",
  "science:projectSpace:inspect", "science:projectSpace:snapshot", "science:projectSpace:link",
  "science:projects:updateDeliverable",
  "science:workspace:get", "science:workspace:updateNavigation", "science:workspace:replaceTabs",
] as const;

/** Channels owned by this daemon IPC registration; Main must not keep parallel handlers for them. */
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
  /** Explicit actual signed view only; must deny app-control even when it holds a recorded view event. */
  assertHumanComputeSender?(event: IpcMainInvokeEvent, envelope: unknown): { releaseId: string };
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
    const viewer: Viewer = { humanViewInstanceId: randomUUID(), sender: event.sender, scope: null, lifecycleProjectId: null, approvals: null,
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
  for (const action of ["list", "read"] as const) register(`science:researchCompute:${action}`, async (event, envelope) => {
    const payload = input(envelope); scope(payload);
    // A deadline makes this an observation: commandObserved must not heal/start
    // the daemon when the native compute monitor is opened.
    const result = await client.commandObserved({ op: `compute.${action}`, input: payload } as DaemonScienceCommand,
      { observationDeadlineMs: performance.now() + 5_000, timeoutMs: 5_000 });
    admit(event, envelope);
    return result;
  });
  for (const action of ["interrupt", "clearGeneration", "readHumanControl"] as const) ipcMain.handle(`science:researchCompute:${action}`, async (event, envelope) => {
    let attempted = false;
    let payload: Row | null = null;
    const publicAction = action === "clearGeneration" ? "clear-generation" : action === "readHumanControl" ? "read-control" : action;
    try {
      admit(event, envelope);
      if (!options.assertHumanComputeSender || !client.commandHuman) throw Error("science-human-compute-unavailable");
      const release = options.assertHumanComputeSender(event, envelope);
      if (typeof release.releaseId !== "string" || release.releaseId.length < 1 || release.releaseId.length > 200 || /[\u0000-\u001f]/u.test(release.releaseId)) throw Error("science-human-compute-release-invalid");
      const raw = input(envelope);
      const keys = action === "readHumanControl" ? ["projectId", "conversationId", "requestId"] :
        ["projectId", "conversationId", "requestId", "executionId", "kernelId", "kernelGeneration", "codeSha256", "environmentSha256", "turnId", "invocationRunId", "originMessageId"];
      if (Object.keys(raw).length !== keys.length || Object.keys(raw).some(key => !keys.includes(key))) throw Error("science-human-compute-input-invalid");
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      for (const key of keys.filter(key => !["kernelGeneration", "codeSha256", "environmentSha256","turnId","invocationRunId"].includes(key))) {
        if (typeof raw[key] !== "string" || !UUID.test(raw[key] as string)) throw Error("science-human-compute-input-invalid");
      }
      if (action !== "readHumanControl" && (!(raw.turnId===null&&raw.invocationRunId===null||[raw.turnId,raw.invocationRunId].every(v=>typeof v==="string"&&UUID.test(v)))||!Number.isSafeInteger(raw.kernelGeneration) || Number(raw.kernelGeneration) < 1
        || !/^[a-f0-9]{64}$/.test(String(raw.codeSha256)) || !/^[a-f0-9]{64}$/.test(String(raw.environmentSha256)))) throw Error("science-human-compute-target-invalid");
      payload = Object.freeze({ ...raw });
      const viewer = viewerFor(event);
      const frame = event.senderFrame;
      const assertBeforeDispatch = () => {
        admit(event, envelope);
        const current = options.assertHumanComputeSender!(event, envelope);
        if (!live(viewer) || event.senderFrame !== frame || current.releaseId !== release.releaseId) throw Error("science-human-compute-admission-changed");
      };
      const result = await client.commandHuman({ assertBeforeDispatch, build(owner) {
        assertBeforeDispatch();
        attempted = true;
        return { op: `compute.${action}`, input: payload!, requester: { kind: "signed-science-main-frame", viewInstanceId: viewer.humanViewInstanceId,
          releaseId: release.releaseId, ...owner } } as DaemonScienceCommand;
      } }, { observationDeadlineMs: performance.now() + 5_000, timeoutMs: 5_000 });
      assertBeforeDispatch();
      return result;
    } catch (error) {
      // Do not rely on Electron's stringified exceptions for effect certainty.
      // A late admission failure or a remote rejection may follow a real effect.
      const transport = error instanceof ScienceDaemonClientError ? error.failure : null;
      const outcome = transport?.outcome === "not-dispatched" || !attempted && !transport ? "not-dispatched" : "unknown";
      const code = transport?.code ?? (error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message) ? error.message : "science-human-compute-unconfirmed");
      return { schema: "agentlas.science-human-compute-transport.v1", outcome, code, action: publicAction,
        ...(payload ? { projectId: payload.projectId, conversationId: payload.conversationId, requestId: payload.requestId,
          ...(action === "readHumanControl" ? {} : { target: Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "requestId")) }) } : {}) };
    }
  });
  for (const action of ["runConsole", "readConsoleRequest"] as const) ipcMain.handle(`science:researchCompute:${action}`, async (event, envelope) => {
    let attempted = false;
    let payload: Row | null = null;
    const publicAction = action === "runConsole" ? "run-console" : "read-console";
    try {
      admit(event, envelope);
      if (!options.assertHumanComputeSender || !client.commandHuman) throw Error("science-human-compute-console-unavailable");
      const release = options.assertHumanComputeSender(event, envelope);
      if (typeof release.releaseId !== "string" || release.releaseId.length < 1 || release.releaseId.length > 200 || /[\u0000-\u001f]/u.test(release.releaseId)) throw Error("science-human-compute-release-invalid");
      const raw = input(envelope), target = row(raw.target);
      const allowed = action === "runConsole" ? ["requestId", "target", "code", "inputs", "outputs", "timeoutMs"] : ["requestId", "target"];
      const targetKeys = ["projectId", "conversationId", "executionId", "kernelId", "kernelGeneration", "codeSha256", "environmentSha256", "turnId", "invocationRunId", "originMessageId"];
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const HASH = /^[a-f0-9]{64}$/;
      if (Object.keys(raw).some(key => !allowed.includes(key)) || typeof raw.requestId !== "string" || !UUID.test(raw.requestId)
        || !target || Object.keys(target).length !== targetKeys.length || Object.keys(target).some(key => !targetKeys.includes(key))
        || targetKeys.filter(key => !["kernelGeneration", "codeSha256", "environmentSha256"].includes(key)).some(key => typeof target[key] !== "string" || !UUID.test(target[key] as string))
        || !Number.isSafeInteger(target.kernelGeneration) || Number(target.kernelGeneration) < 1
        || typeof target.codeSha256 !== "string" || !HASH.test(target.codeSha256) || typeof target.environmentSha256 !== "string" || !HASH.test(target.environmentSha256)) throw Error("science-human-compute-console-input-invalid");
      const relative = (p: unknown): p is string => typeof p === "string" && p.length > 0 && p.length <= 2000 && !/[\\\u0000-\u001f]/u.test(p)
        && !p.startsWith("/") && !p.split("/").some(part => !part || part === "." || part === "..");
      if (action === "runConsole" && (typeof raw.code !== "string" || !raw.code.trim() || Buffer.byteLength(raw.code, "utf8") > 65536
        || raw.timeoutMs !== undefined && (!Number.isSafeInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 1000 || Number(raw.timeoutMs) > 86400000)
        || raw.inputs !== undefined && (!Array.isArray(raw.inputs) || raw.inputs.length > 40 || raw.inputs.some(pin => !row(pin) || Object.keys(pin).sort().join(",") !== "path,sha256" || !relative(pin.path) || typeof pin.sha256 !== "string" || !HASH.test(pin.sha256)) || new Set(raw.inputs.map(pin => pin.path)).size !== raw.inputs.length)
        || raw.outputs !== undefined && (!Array.isArray(raw.outputs) || raw.outputs.length > 40 || raw.outputs.some(p => !relative(p)) || new Set(raw.outputs).size !== raw.outputs.length))) throw Error("science-human-compute-console-input-invalid");
      // Own immutable request bytes across the asynchronous no-heal preflight.
      payload = Object.freeze({ requestId: raw.requestId, target: Object.freeze({ ...target }),
        ...(action === "runConsole" ? { code: raw.code,
          ...(raw.inputs === undefined ? {} : { inputs: Object.freeze((raw.inputs as Row[]).map(pin => Object.freeze({ ...pin }))) }),
          ...(raw.outputs === undefined ? {} : { outputs: Object.freeze([...(raw.outputs as string[])]) }),
          ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }) } : {}) });
      const viewer = viewerFor(event), frame = event.senderFrame;
      const assertBeforeDispatch = () => {
        admit(event, envelope);
        const current = options.assertHumanComputeSender!(event, envelope);
        if (!live(viewer) || event.senderFrame !== frame || current.releaseId !== release.releaseId) throw Error("science-human-compute-admission-changed");
      };
      const result = await client.commandHuman({ assertBeforeDispatch, build(owner) {
        assertBeforeDispatch(); attempted = true;
        return { op: `compute.${action}`, input: payload!, requester: { kind: "signed-science-main-frame", viewInstanceId: viewer.humanViewInstanceId,
          releaseId: release.releaseId, ...owner } } as DaemonScienceCommand;
      } }, { observationDeadlineMs: performance.now() + 5_000, timeoutMs: 5_000 });
      assertBeforeDispatch();
      return result;
    } catch (error) {
      const transport = error instanceof ScienceDaemonClientError ? error.failure : null;
      const outcome = transport?.outcome === "not-dispatched" || !attempted && !transport ? "not-dispatched" : "unknown";
      const code = transport?.code ?? (error instanceof Error && /^[a-zA-Z0-9_-]{1,128}$/.test(error.message) ? error.message : "science-human-compute-console-unconfirmed");
      return { schema: "agentlas.science-human-compute-console-transport.v1", outcome, code, action: publicAction,
        ...(payload ? { requestId: payload.requestId, target: payload.target } : {}) };
    }
  });

  for(const action of ["beginSession","runSession","readSession","readSessionRequest","stopSession"] as const) ipcMain.handle(`science:researchCompute:${action}`,async(event,envelope)=>{
    let attempted=false,payload:Row|null=null;
    const publicAction={beginSession:"begin-session",runSession:"run-session",readSession:"read-session",readSessionRequest:"read-session-request",stopSession:"stop-session"}[action];
    try {
      admit(event,envelope);
      if(!options.assertHumanComputeSender||!client.commandHuman)throw Error("science-human-compute-session-unavailable");
      const release=options.assertHumanComputeSender(event,envelope);
      if(typeof release.releaseId!=="string"||release.releaseId.length<1||release.releaseId.length>200||/[\u0000-\u001f]/u.test(release.releaseId))throw Error("science-human-compute-release-invalid");
      const raw=input(envelope),UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,HASH=/^[a-f0-9]{64}$/;
      const keys=action==="beginSession"?(raw.mode==="bootstrap-python"?["requestId","projectId","conversationId","mode","originMessageId","language","environment","limits"]:["requestId","projectId","conversationId","anchorTarget","mode","limits"]):action==="runSession"?["requestId","projectId","conversationId","sessionId","sessionEpoch","code","inputs","outputs","timeoutMs"]:action==="readSession"?["projectId","conversationId","sessionId","requestId"]:action==="stopSession"?["projectId","conversationId","sessionId","requestId","sessionEpoch"]:["projectId","conversationId","sessionId","requestId"];
      if(Object.keys(raw).some(k=>!keys.includes(k))||![raw.projectId,raw.conversationId].every(v=>typeof v==="string"&&UUID.test(v)))throw Error("science-human-compute-session-input-invalid");
      if(action==="readSession") {
        if((raw.sessionId===undefined)===(raw.requestId===undefined)||typeof(raw.sessionId??raw.requestId)!=="string"||!UUID.test(String(raw.sessionId??raw.requestId)))throw Error("science-human-compute-session-input-invalid");
      }else if(typeof raw.requestId!=="string"||!UUID.test(raw.requestId)||action!=="beginSession"&&(typeof raw.sessionId!=="string"||!UUID.test(raw.sessionId))||["runSession","stopSession"].includes(action)&&(!Number.isSafeInteger(raw.sessionEpoch)||Number(raw.sessionEpoch)<1))throw Error("science-human-compute-session-input-invalid");
      if(action==="beginSession") {
        if(raw.mode==="bootstrap-python") {const environment=row(raw.environment);if(typeof raw.originMessageId!=="string"||!UUID.test(raw.originMessageId)||raw.language!=="python"||!environment||Object.keys(environment).length!==1||environment.kind!=="system")throw Error("science-human-compute-session-input-invalid");}
        else {const target=row(raw.anchorTarget),targetKeys=["projectId","conversationId","executionId","kernelId","kernelGeneration","codeSha256","environmentSha256","turnId","invocationRunId","originMessageId"];
        if(!target||Object.keys(target).length!==targetKeys.length||Object.keys(target).some(k=>!targetKeys.includes(k))||target.projectId!==raw.projectId||target.conversationId!==raw.conversationId||targetKeys.filter(k=>!["kernelGeneration","codeSha256","environmentSha256"].includes(k)).some(k=>typeof target[k]!=="string"||!UUID.test(target[k] as string))||!Number.isSafeInteger(target.kernelGeneration)||Number(target.kernelGeneration)<1||typeof target.codeSha256!=="string"||!HASH.test(target.codeSha256)||typeof target.environmentSha256!=="string"||!HASH.test(target.environmentSha256)||!["reuse-live","fresh-generation"].includes(String(raw.mode)))throw Error("science-human-compute-session-input-invalid");}
        const ceilings:Row={wallTimeMs:28800000,maxCells:1000,maxActiveRuntimeMs:14400000,maxCellTimeMs:600000},limits=raw.limits===undefined?null:row(raw.limits);
        if(raw.limits!==undefined&&(!limits||Object.keys(limits).some(k=>!Object.hasOwn(ceilings,k))||Object.entries(limits).some(([k,v])=>!Number.isSafeInteger(v)||Number(v)<(k==="maxCells"?1:1000)||Number(v)>Number(ceilings[k]))))throw Error("science-human-compute-session-input-invalid");
      }
      if(action==="runSession") {
        const relative=(p:unknown)=>typeof p==="string"&&p.length>0&&p.length<=2000&&!/[\\\u0000-\u001f]/u.test(p)&&!p.startsWith("/")&&!p.split("/").some(x=>!x||x==="."||x==="..");
        if(typeof raw.code!=="string"||!raw.code.trim()||Buffer.byteLength(raw.code,"utf8")>65536||raw.timeoutMs!==undefined&&(!Number.isSafeInteger(raw.timeoutMs)||Number(raw.timeoutMs)<1000||Number(raw.timeoutMs)>600000)||raw.inputs!==undefined&&(!Array.isArray(raw.inputs)||raw.inputs.length>40||raw.inputs.some(p=>!row(p)||Object.keys(p).sort().join(",")!=="path,sha256"||!relative(p.path)||typeof p.sha256!=="string"||!HASH.test(p.sha256))||new Set(raw.inputs.map(p=>p.path)).size!==raw.inputs.length)||raw.outputs!==undefined&&(!Array.isArray(raw.outputs)||raw.outputs.length>40||raw.outputs.some(p=>!relative(p))||new Set(raw.outputs).size!==raw.outputs.length))throw Error("science-human-compute-session-input-invalid");
      }
      const owned=JSON.parse(JSON.stringify(raw)) as Row; // no renderer-owned mutable nested values survive preflight
      if(row(owned.anchorTarget))Object.freeze(owned.anchorTarget);
      if(row(owned.environment))Object.freeze(owned.environment);
      if(row(owned.limits))Object.freeze(owned.limits);
      if(Array.isArray(owned.inputs)){owned.inputs.forEach(Object.freeze);Object.freeze(owned.inputs);}
      if(Array.isArray(owned.outputs))Object.freeze(owned.outputs);
      payload=Object.freeze(owned);
      const viewer=viewerFor(event),frame=event.senderFrame;
      const assertBeforeDispatch=()=>{admit(event,envelope);const current=options.assertHumanComputeSender!(event,envelope);if(!live(viewer)||event.senderFrame!==frame||current.releaseId!==release.releaseId)throw Error("science-human-compute-admission-changed");};
      const result=await client.commandHuman({assertBeforeDispatch,build(owner){assertBeforeDispatch();attempted=true;return {op:`compute.${action}`,input:payload!,requester:{kind:"signed-science-main-frame",viewInstanceId:viewer.humanViewInstanceId,releaseId:release.releaseId,...owner}} as DaemonScienceCommand;}},{observationDeadlineMs:performance.now()+5000,timeoutMs:5000});
      assertBeforeDispatch();return result;
    }catch(error){const transport=error instanceof ScienceDaemonClientError?error.failure:null,outcome=transport?.outcome==="not-dispatched"||!attempted&&!transport?"not-dispatched":"unknown",code=transport?.code??(error instanceof Error&&/^[a-zA-Z0-9_-]{1,128}$/.test(error.message)?error.message:"science-human-compute-session-unconfirmed");
      return {schema:"agentlas.science-human-compute-session-transport.v1",outcome,code,action:publicAction,...(payload?{input:payload}:{})};}
  });
  register("science:researchCapabilities:inspect", async (event, envelope) => {
    const payload = input(envelope); scope(payload);
    const result = await client.commandObserved({ op: "capability.inspect", input: payload } as DaemonScienceCommand,
      { observationDeadlineMs: performance.now() + 5_000, timeoutMs: 5_000 });
    // A navigation/release change during the read cannot receive an old scope's
    // reply. This query never prepares a connector or starts/heals the daemon.
    admit(event, envelope);
    return result;
  });
  for (const action of ["inspect", "snapshot", "link"] as const) register(`science:projectSpace:${action}`, (_event, envelope) => {
    const payload = input(envelope);
    id(payload.projectId);
    // The daemon owns both retrieval-cache writes and explicit relation writes.
    return dispatch(`space.${action}`, payload, false);
  }, "science:projects");
  register("science:projects:updateDeliverable", (_event, envelope) => {
    const payload = input(envelope);
    const exactKeys = (value: Row, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
    if (!exactKeys(payload, ["requestId", "projectId", "deliverable"])) throw new Error("science-project-deliverable-input-invalid");
    const uuid = (value: unknown) => typeof value === "string"
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
    if (!uuid(payload.requestId) || !uuid(payload.projectId)) throw new Error("science-project-deliverable-input-invalid");
    const deliverable = payload.deliverable;
    if (deliverable !== null) {
      const value = row(deliverable);
      if (!value || !exactKeys(value, ["kind", "pagesMin", "pagesMax"])
        || !["paper", "consulting-report", "gaejosik-report"].includes(String(value.kind))) {
        throw new Error("science-project-deliverable-invalid");
      }
      for (const page of [value.pagesMin, value.pagesMax]) {
        if (page !== undefined && page !== null && (!Number.isSafeInteger(page) || Number(page) < 1 || Number(page) > 2000)) {
          throw new Error("science-project-deliverable-pages-invalid");
        }
      }
      if (value.pagesMin != null && value.pagesMax != null && Number(value.pagesMin) > Number(value.pagesMax)) {
        throw new Error("science-project-deliverable-pages-invalid");
      }
    }
    return dispatch("projects.updateDeliverable", payload, false);
  }, "science:projects");
  register("science:workspace:get", (_event, envelope) => {
    const projectId = id(row(envelope)?.projectId);
    return dispatch("workspace.get", { projectId }, false);
  }, "science:projects");
  register("science:workspace:updateNavigation", (_event, envelope) => {
    const payload = input(envelope);
    id(payload.projectId);
    return dispatch("workspace.updateNavigation", payload, false);
  }, "science:projects");
  register("science:workspace:replaceTabs", (_event, envelope) => {
    const payload = input(envelope);
    id(payload.projectId);
    return dispatch("workspace.replaceTabs", payload, false);
  }, "science:projects");
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
