/** Device bridge v1, window-process half (1.3.0 A3). The background service asks over the authenticated native channel
 * (the daemon -> Main callback path, validated by the channel's own signatures and the attached channel's identity) and
 * this module answers with a VALUE, never a thrown error, so the service always receives a machine-readable code.
 *
 *  - prepareOsExecution: Main prepares the per-run scoped OS execution with its own lease broker. Main validates the
 *    request against durable rows (supervisor request, run-owner row with ownerKind "daemon" for the attached boot,
 *    admission digest, supervisor domain generation); nothing the daemon sends is trusted by itself.
 *  - disposeOsExecution / channel close: the execution is revoked.
 *  - idle: lock state and idle seconds.
 * It also forwards powerMonitor lock-screen / unlock-screen / suspend / resume to the service as a device-state push. */
import {
  APP_CONTROL_MAIN_BUDGET_MS, DEVICE_BRIDGE_VERSION, DEVICE_STATE_VERSION, type DeviceOp, type DeviceSession,
} from "../daemon/device-bridge";
import { answerAppCallWithin, appCallKey, appCallPendingNotice } from "../app-control/pending-calls";

type Channel = object & { dispatch(method: string, params: unknown): Promise<unknown>; onClose(listener: () => void): () => void };
type Identity = object & { bootId: string };
export interface DeviceBridgeMainPorts {
  /** The identity of a live authenticated channel, or undefined once it is closed or replaced. */
  channelIdentity(channel: object): Identity | undefined;
  /** Prepare a scoped OS execution on this process's broker for a run hosted by the attached daemon. Throws a coded error. */
  prepare(input: { runId: string; chatId: string; permission: "read" | "write" | "full"; inputDigest: string; daemonBootId: string; channelCurrent(): boolean }): { capability: { version: "agentlas.one-os-execution.v1"; executionId: string; token: string }; dispose(): void };
  /** A2: release this process's idle resident runtime sessions of a chat; the service is taking the chat over. */
  releaseChat?(chatId: string, deadlineMs: number): Promise<{ busy: boolean; released: number; pending: number }>;
  /** Goal intake handed over by the service (2026-10-11): validate against durable rows and answer at once; the work runs in the background. */
  forwardGoalIntake?(input: { runId: string; chatId: string; sourceMessageId: string; permission: "read" | "write" | "full" }, signal?: AbortSignal): { ok: true; status: "accepted" | "duplicate" } | { ok: false; error: string };
  /** One's app-control, run by Main exactly as for a Main-hosted turn (same policy, same owner-turn rule, same handlers). */
  appControl?(input: { kind: "operations" | "call"; ownerTurn: boolean; permission?: "read" | "write" | "full"; input: Record<string, unknown> }): Promise<{ outcome: "value"; value: unknown } | { outcome: "error"; code: string; message: string }>;
  /** Gate-only: Main's answer budget for an app-control request, in place of APP_CONTROL_MAIN_BUDGET_MS. */
  appControlBudgetMs?: number;
  /** Run every intake the service could not hand over while this process was away. Called on each successful attach. */
  drainGoalIntake?(signal?: AbortSignal): void;
  /** Runtime installation, availability or configuration changed; the store notification carries no private content. */
  subscribeRuntimeChange?(listener: () => void): () => void;
  pendingGoalIntakeRetryDelay?(): number;
  /** NH21: execute a Goal action the service's Alive host reserved (Main owns Goal custody). Answers a value, never throws. */
  aliveAction?(input: { domain: "work" | "one"; actionId: string }): { ok: true; result: unknown } | { ok: false; error: string };
  /** NH21: a life changed in the service; refresh this process's screens. */
  aliveChanged?(event: Record<string, unknown>): boolean;
  session(): DeviceSession;
  idleSeconds(): number | null;
  subscribePower(handler: (event: "lock-screen" | "unlock-screen" | "suspend" | "resume") => void): () => void;
  log?(line: string): void;
}
const id = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code ?? (error as Error | null)?.message;
  return typeof code === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(code) ? code : "device_bridge_refused";
};
export function isDeviceBridgeFrame(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { version?: unknown }).version === DEVICE_BRIDGE_VERSION;
}

export function createDeviceBridgeMain(ports: DeviceBridgeMainPorts) {
  const executions = new Map<string, { channel: object; dispose(): void }>();
  const watched = new WeakSet<object>();
  let unsubscribePower: (() => void) | undefined, lastChannel: Channel | undefined;
  let powerEvent: DeviceSession = "awake";
  let intakeLifetime = new AbortController();
  let unsubscribeRuntime: (() => void) | undefined, intakeRetryWake: ReturnType<typeof setTimeout> | undefined;
  const cancelIntake = (): void => {
    intakeLifetime.abort();
    if (intakeRetryWake) clearTimeout(intakeRetryWake);
    intakeRetryWake = undefined;
  };
  const drainIntake = (): void => {
    if (intakeLifetime.signal.aborted) return;
    try { ports.drainGoalIntake?.(intakeLifetime.signal); }
    catch (error) { ports.log?.(`[device-bridge] goal intake drain failed: ${codeOf(error)}`); }
  };
  const scheduleRuntimeWake = (delay: number): void => {
    if (intakeRetryWake || intakeLifetime.signal.aborted) return;
    intakeRetryWake = setTimeout(() => {
      intakeRetryWake = undefined;
      if (intakeLifetime.signal.aborted) return;
      try {
        const remaining = ports.pendingGoalIntakeRetryDelay?.() ?? 0;
        // A classification admitted before the runtime changed may still be finishing. Wait for it rather than overlap it.
        if (remaining > 0) scheduleRuntimeWake(remaining);
        else drainIntake();
      } catch (error) { ports.log?.(`[device-bridge] goal intake wake failed: ${codeOf(error)}`); }
    }, delay);
    intakeRetryWake.unref?.();
  };
  const runtimeChanged = (): void => {
    if (intakeLifetime.signal.aborted) return;
    // Defer reads until the notifying store transaction commits. One delayed wake also respects durable intake cooldowns.
    setImmediate(drainIntake);
    scheduleRuntimeWake(60_000);
  };
  const session = (): DeviceSession => powerEvent !== "awake" ? powerEvent : ports.session();
  function disposeFor(channel: object): void {
    for (const [executionId, entry] of [...executions]) if (entry.channel === channel) { executions.delete(executionId); try { entry.dispose(); } catch { /* already revoked */ } }
  }
  async function pushState(channel: Channel | undefined = lastChannel): Promise<void> {
    if (!channel || !ports.channelIdentity(channel)) return;
    try { await channel.dispatch("native.attach", { version: DEVICE_STATE_VERSION, op: "state", session: session(), idleSeconds: ports.idleSeconds() }); }
    catch (error) { ports.log?.(`[device-bridge] state push failed: ${codeOf(error)}`); }
  }
  function onPower(event: "lock-screen" | "unlock-screen" | "suspend" | "resume"): void {
    powerEvent = event === "lock-screen" ? "locked" : event === "suspend" ? "sleeping" : "awake";
    void pushState();
  }
  /** One successful attach (initial or re-attach): revoke on close, forward power events, push the current state. */
  function attached(channel: Channel): void {
    if (lastChannel !== channel || intakeLifetime.signal.aborted) {
      cancelIntake();
      intakeLifetime = new AbortController();
    }
    lastChannel = channel;
    if (!watched.has(channel)) { watched.add(channel); channel.onClose(() => {
      disposeFor(channel);
      if (lastChannel === channel) cancelIntake();
    }); }
    unsubscribePower ??= ports.subscribePower(onPower);
    unsubscribeRuntime ??= ports.subscribeRuntimeChange?.(runtimeChanged);
    void pushState(channel);
    try {
      const delay = ports.pendingGoalIntakeRetryDelay?.() ?? 0;
      if (delay > 0) scheduleRuntimeWake(delay);
    } catch (error) { ports.log?.(`[device-bridge] goal intake cooldown read failed: ${codeOf(error)}`); }
    drainIntake();
  }
  async function handle(raw: unknown, channel: object, identity: object): Promise<Record<string, unknown>> {
    const live = ports.channelIdentity(channel);
    if (!live || live !== identity) return { ok: false, error: "device_bridge_disconnected" };
    if (!exactKeys(raw, ["version", "requestId", "op", "deadlineMs", "payload"]) || raw.version !== DEVICE_BRIDGE_VERSION || typeof raw.requestId !== "string"
      || !/^[a-f0-9]{64}$/.test(raw.requestId) || !raw.payload || typeof raw.payload !== "object" || Array.isArray(raw.payload)) return { ok: false, error: "device_bridge_refused" };
    const op = raw.op as DeviceOp, payload = raw.payload as Record<string, unknown>;
    try {
      if (op === "idle") {
        if (!exactKeys(payload, [])) return { ok: false, error: "device_bridge_refused" };
        return { ok: true, session: session(), idleSeconds: ports.idleSeconds() };
      }
      if (op === "releaseChatSessions") {
        if (!exactKeys(payload, ["chatId", "deadlineMs"]) || !id(payload.chatId) || typeof payload.deadlineMs !== "number" || !ports.releaseChat) return { ok: false, error: "device_bridge_refused" };
        return { ok: true, ...(await ports.releaseChat(payload.chatId, payload.deadlineMs)) };
      }
      if (op === "forwardGoalIntake") {
        if (!exactKeys(payload, ["runId", "chatId", "sourceMessageId", "permission"]) || !id(payload.runId) || !id(payload.chatId) || !id(payload.sourceMessageId)
          || !["read", "write", "full"].includes(String(payload.permission)) || !ports.forwardGoalIntake) return { ok: false, error: "device_bridge_refused" };
        return ports.forwardGoalIntake({ runId: payload.runId, chatId: payload.chatId, sourceMessageId: payload.sourceMessageId, permission: payload.permission as "read" | "write" | "full" }, intakeLifetime.signal);
      }
      if (op === "appControl") {
        if (!exactKeys(payload, Object.hasOwn(payload, "permission") ? ["kind", "ownerTurn", "permission", "input"] : ["kind", "ownerTurn", "input"]) || !["operations", "call"].includes(String(payload.kind)) || typeof payload.ownerTurn !== "boolean"
          || (payload.permission !== undefined && (typeof payload.permission !== "string" || !["read", "write", "full"].includes(payload.permission)))
          || !payload.input || typeof payload.input !== "object" || Array.isArray(payload.input) || JSON.stringify(payload.input).length > 65536 || !ports.appControl) return { ok: false, error: "device_bridge_refused" };
        // Main answers within the channel's limit (it closes for good on a request that outlives 10 s). A catalog read that runs longer is
        // reported; an operation call that runs longer keeps running here and the daemon asks again with the same payload: the call is
        // keyed by what it is, so the repeat joins the running operation (or takes its finished result once) instead of starting a second
        // one (app-control/pending-calls.ts). An older daemon passes the notice on to the model, which repeats the call the same way.
        const control = ports.appControl, kind = payload.kind as "operations" | "call", ownerTurn = payload.ownerTurn as boolean;
        const permission = payload.permission as "read" | "write" | "full" | undefined, request = payload.input as Record<string, unknown>;
        const budgetMs = ports.appControlBudgetMs ?? APP_CONTROL_MAIN_BUDGET_MS;
        const run = () => control({ kind, ownerTurn, permission, input: request });
        const operation = typeof request.operation === "string" ? request.operation.trim() : "";
        const answer = kind === "call"
          ? await answerAppCallWithin(appCallKey({ via: "bridge", kind, operation, args: request.args, scope: (request.scope as { chatId?: unknown } | undefined)?.chatId ?? null,
              ownerTurn, permission: permission ?? "read" }), run, budgetMs,
              () => ({ outcome: "value" as const, value: appCallPendingNotice(operation) }))
          : await Promise.race([run(),
              new Promise<{ outcome: "error"; code: string; message: string }>(resolve => { const t = setTimeout(() => resolve({ outcome: "error", code: "operation-timeout",
                message: "Agentlas did not finish this within the time allowed for a background request; it may still be running, so read its state before repeating it." }), budgetMs); t.unref?.(); })]);
        if (answer.outcome === "value" && JSON.stringify(answer.value ?? null).length > 600_000) return { ok: true, outcome: "error", code: "result-too-large", message: "The result is too large; narrow the query." };
        return { ok: true, ...answer };
      }
      if (op === "aliveAction") {
        if (!exactKeys(payload, ["domain", "actionId"]) || (payload.domain !== "work" && payload.domain !== "one") || !id(payload.actionId) || !ports.aliveAction) return { ok: false, error: "device_bridge_refused" };
        const answer = ports.aliveAction({ domain: payload.domain, actionId: payload.actionId });
        return answer.ok ? { ok: true, result: answer.result } : { ok: false, error: /^[a-z][a-z0-9_]{1,99}$/.test(answer.error) ? answer.error : "device_bridge_refused" };
      }
      if (op === "aliveChanged") {
        if (!ports.aliveChanged || !ports.aliveChanged(payload)) return { ok: false, error: "device_bridge_refused" };
        return { ok: true };
      }
      if (op === "disposeOsExecution") {
        if (!exactKeys(payload, ["executionId"]) || !id(payload.executionId)) return { ok: false, error: "device_bridge_refused" };
        const entry = executions.get(payload.executionId);
        if (entry && entry.channel === channel) { executions.delete(payload.executionId); entry.dispose(); }
        return { ok: true };
      }
      if (op === "prepareOsExecution") {
        if (!exactKeys(payload, ["runId", "chatId", "permission", "inputDigest"]) || !id(payload.runId) || !id(payload.chatId)
          || !["read", "write", "full"].includes(String(payload.permission)) || typeof payload.inputDigest !== "string" || !/^[a-f0-9]{64}$/.test(payload.inputDigest)) return { ok: false, error: "device_bridge_refused" };
        if (session() !== "awake") return { ok: false, error: "device_session_locked" };
        const prepared = ports.prepare({ runId: payload.runId, chatId: payload.chatId, permission: payload.permission as "read" | "write" | "full",
          inputDigest: payload.inputDigest, daemonBootId: identity && (identity as Identity).bootId, channelCurrent: () => ports.channelIdentity(channel) === identity });
        executions.set(prepared.capability.executionId, { channel, dispose: prepared.dispose });
        return { ok: true, capability: prepared.capability };
      }
      return { ok: false, error: "device_bridge_refused" };
    } catch (error) {
      const code = codeOf(error);
      return { ok: false, error: code === "supervisor_os_host_unavailable" || code === "one-os-lease-host-unavailable" ? "device_bridge_unavailable" : code.startsWith("supervisor_os_") ? "device_bridge_refused" : code };
    }
  }
  return Object.freeze({ attached, handle, pushState, onPower, session, get executionCount() { return executions.size; },
    dispose(): void { cancelIntake(); unsubscribeRuntime?.(); unsubscribeRuntime = undefined; unsubscribePower?.(); unsubscribePower = undefined; for (const entry of [...executions.values()]) { try { entry.dispose(); } catch { /* */ } } executions.clear(); } });
}

let instance: ReturnType<typeof createDeviceBridgeMain> | undefined;
/** The window process's bridge, wired to the real powerMonitor, broker preparation and the enrolled channel. */
export async function deviceBridgeMain(): Promise<ReturnType<typeof createDeviceBridgeMain>> {
  if (instance) return instance;
  const [{ nativeGuiChannelIdentity }, { prepareSupervisorOsExecution }, { releaseLocalChatSessions }, goalIntake, electron] = await Promise.all([
    import("../daemon/native-auth-channel"), import("../one/supervisor-os-execution"), import("../runtime/chat-host-handover"), import("./goal-intake-forward"), import("electron"),
  ]);
  const power = electron.powerMonitor;
  instance ??= createDeviceBridgeMain({
    channelIdentity: channel => nativeGuiChannelIdentity(channel) as Identity | undefined,
    prepare: input => {
      const out = prepareSupervisorOsExecution({ runId: input.runId, chatId: input.chatId, permission: input.permission,
        admissionCurrent: input.channelCurrent, remoteDaemon: { daemonBootId: input.daemonBootId, inputDigest: input.inputDigest } });
      if (!out) throw Object.assign(new Error("supervisor_os_original_command_required"), { code: "supervisor_os_original_command_required" });
      return out;
    },
    releaseChat: (chatId, deadlineMs) => releaseLocalChatSessions(chatId, deadlineMs),
    forwardGoalIntake: (input, signal) => goalIntake.acceptForwardedGoalIntake(input, signal),
    drainGoalIntake: signal => goalIntake.drainPendingGoalIntakes(signal),
    pendingGoalIntakeRetryDelay: () => goalIntake.pendingGoalIntakeRetryDelay(),
    subscribeRuntimeChange: listener => {
      const { onDesktopStoreChange } = require("../store/change-bus") as typeof import("../store/change-bus");
      return onDesktopStoreChange(change => { if (change.entity === "runtime") listener(); });
    },
    aliveAction: input => {
      try { return require("../alive-organisms").executeForwardedAliveAction(input); }
      catch (error) { return { ok: false, error: codeOf(error) === "device_bridge_refused" ? "alive_action_failed" : codeOf(error) }; }
    },
    aliveChanged: event => { try { return require("../alive-organisms").aliveChangedFromService(event) as boolean; } catch { return false; } },
    appControl: async input => {
      const service = await import("../app-control/service");
      try {
        return { outcome: "value", value: input.kind === "operations" ? service.appControlOperationsLocal(input.input)
          : await service.appControlCallLocal({ ownerTurn: input.ownerTurn, permission: input.permission }, input.input) };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const code = (error as { code?: unknown } | null)?.code;
        return { outcome: "error", code: typeof code === "string" ? code : "operation-failed", message: text.slice(0, 2000) };
      }
    },
    session: () => { try { const state = power.getSystemIdleState(1); return state === "locked" ? "locked" : state === "unknown" ? "unknown" : "awake"; } catch { return "unknown"; } },
    idleSeconds: () => { try { return power.getSystemIdleTime(); } catch { return null; } },
    subscribePower: handler => {
      const names = ["lock-screen", "unlock-screen", "suspend", "resume"] as const;
      const listeners = names.map(name => { const listener = () => handler(name); power.on(name as never, listener); return [name, listener] as const; });
      return () => { for (const [name, listener] of listeners) power.removeListener(name as never, listener); };
    },
    log: line => console.info(line),
  });
  return instance!;
}
