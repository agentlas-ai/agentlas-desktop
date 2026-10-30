/** Device bridge v1 (1.3.0 A3). The window process (Main) owns the screen: the input driver, the OS lease broker, the
 * computer-use control server, powerMonitor and OS notifications. The background service runs the models. This is the
 * service-side client of the authenticated native channel's reverse path: the service asks Main for a device operation
 * with a request id and a deadline, and Main answers with a value (never an exception: a thrown callback would lose its
 * machine-readable code). Its life is tied to the channel: when the channel drops, every pending request fails at once
 * with device_bridge_disconnected, and the lock state becomes unknown (the safe default: no screen operations).
 *
 * No electron import: the background service loads this without Electron (test-daemon-loads-without-electron). */
import { randomBytes } from "node:crypto";

export const DEVICE_BRIDGE_VERSION = "agentlas.device-bridge.v1";
export const DEVICE_STATE_VERSION = "agentlas.device-state.v1";
export const DEVICE_BRIDGE_DEFAULT_DEADLINE_MS = 15000;
/** The native channel closes for good on a request that outlives 10 s, so app-control stays well under it. */
export const APP_CONTROL_DEADLINE_MS = 8000;
export const APP_CONTROL_MAIN_BUDGET_MS = 7000;
/** Shown to the model when a computer-use tool call cannot run because the window process is not there. */
export const DEVICE_BRIDGE_UNAVAILABLE_MESSAGE = "화면 조작은 Agentlas 앱 창이 켜져 있을 때만 가능합니다";
export const DEVICE_SESSION_LOCKED_MESSAGE = "화면이 잠겨 있거나 절전 중이라 지금은 화면 조작을 할 수 없습니다";
export const OS_EXECUTION_UNAVAILABLE_VERSION = "agentlas.one-os-execution-unavailable.v1";

export type DeviceBridgeErrorCode =
  | "device_bridge_unavailable" | "device_bridge_disconnected" | "device_bridge_timeout" | "device_bridge_refused" | "device_session_locked";
export class DeviceBridgeError extends Error {
  constructor(readonly code: DeviceBridgeErrorCode | string, message?: string) { super(message ?? code); this.name = "DeviceBridgeError"; }
}
export type DeviceSession = "awake" | "locked" | "sleeping" | "unknown";
export interface DeviceStateSnapshot { session: DeviceSession; idleSeconds: number | null; observedAt: string }
export type DeviceOp = "prepareOsExecution" | "disposeOsExecution" | "idle" | "releaseChatSessions" | "forwardGoalIntake" | "appControl" | "aliveAction" | "aliveChanged";
export interface DeviceFrame { version: typeof DEVICE_BRIDGE_VERSION; requestId: string; op: DeviceOp; deadlineMs: number; payload: Record<string, unknown> }
export interface PreparedOsExecutionWire { capability: { version: "agentlas.one-os-execution.v1"; executionId: string; token: string } }

const SESSIONS = new Set<DeviceSession>(["awake", "locked", "sleeping", "unknown"]);
export function deviceStateSnapshot(value: unknown): DeviceStateSnapshot {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || !SESSIONS.has(v.session as DeviceSession)
    || !(v.idleSeconds === null || (typeof v.idleSeconds === "number" && Number.isFinite(v.idleSeconds) && v.idleSeconds >= 0))) throw new DeviceBridgeError("device_bridge_refused", "device_state_invalid");
  return { session: v.session as DeviceSession, idleSeconds: v.idleSeconds as number | null, observedAt: new Date().toISOString() };
}

export interface DeviceTransport { request(frame: DeviceFrame): Promise<unknown> }
type Pending = { reject(error: DeviceBridgeError): void; timer: ReturnType<typeof setTimeout> };

export function createDaemonDeviceBridge(options: { now?: () => number; newRequestId?: () => string; deadlineMs?: number; appControlDeadlineMs?: number } = {}) {
  let transport: DeviceTransport | null = null, owner: object | null = null;
  let snapshot: DeviceStateSnapshot = { session: "unknown", idleSeconds: null, observedAt: new Date(0).toISOString() };
  const pending = new Set<Pending>();
  const requestId = options.newRequestId ?? (() => randomBytes(32).toString("hex"));
  function failAll(code: DeviceBridgeErrorCode): void {
    for (const p of [...pending]) { pending.delete(p); clearTimeout(p.timer); p.reject(new DeviceBridgeError(code)); }
  }
  function ask(op: DeviceOp, payload: Record<string, unknown>, deadlineMs = options.deadlineMs ?? DEVICE_BRIDGE_DEFAULT_DEADLINE_MS): Promise<Record<string, unknown>> {
    const t = transport;
    if (!t) return Promise.reject(new DeviceBridgeError("device_bridge_unavailable"));
    const frame: DeviceFrame = { version: DEVICE_BRIDGE_VERSION, requestId: requestId(), op, deadlineMs, payload };
    return new Promise((resolve, reject) => {
      const entry: Pending = { reject, timer: setTimeout(() => { pending.delete(entry); reject(new DeviceBridgeError("device_bridge_timeout")); }, deadlineMs) };
      entry.timer.unref?.();
      pending.add(entry);
      let call: Promise<unknown>;
      try { call = Promise.resolve(t.request(frame)); } catch (error) { call = Promise.reject(error); }
      call.then(value => {
        if (!pending.delete(entry)) return; // already failed (disconnect or deadline)
        clearTimeout(entry.timer);
        const v = value as Record<string, unknown> | null;
        if (!v || typeof v !== "object") { reject(new DeviceBridgeError("device_bridge_refused", "device_reply_invalid")); return; }
        if (v.ok === false) { reject(new DeviceBridgeError(typeof v.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(v.error) ? v.error : "device_bridge_refused")); return; }
        resolve(v);
      }, (error: unknown) => {
        if (!pending.delete(entry)) return;
        clearTimeout(entry.timer);
        // The reverse path rejects when the channel is gone (lost) or Main could not answer at all, or when this request
        // could not be put on the wire (the channel stays up; the code names why).
        const code = (error as { code?: unknown } | null)?.code;
        if (typeof code === "string" && /^native_auth_(value|frame)_/.test(code)) { reject(new DeviceBridgeError("device_bridge_refused", code)); return; }
        const lost = code === "native_auth_channel_lost" || transport !== t;
        reject(new DeviceBridgeError(lost ? "device_bridge_disconnected" : "device_bridge_unavailable"));
      });
    });
  }
  return {
    /** The attached Main peer. A later attach replaces an earlier one (re-attach after a channel drop). */
    attach(peer: object, next: DeviceTransport): void {
      if (owner && owner !== peer) failAll("device_bridge_disconnected");
      owner = peer; transport = next;
    },
    /** Channel closed. Only the current owner detaches; pending requests fail at once; the lock state is unknown again. */
    detach(peer: object): void {
      if (owner !== peer) return;
      owner = null; transport = null;
      snapshot = { session: "unknown", idleSeconds: null, observedAt: new Date(options.now?.() ?? Date.now()).toISOString() };
      failAll("device_bridge_disconnected");
    },
    get attached(): boolean { return transport !== null; },
    get pendingCount(): number { return pending.size; },
    state(): DeviceStateSnapshot { return { ...snapshot }; },
    /** Main pushes this on lock, unlock, suspend, resume and right after every attach. */
    pushState(peer: object, value: unknown): DeviceStateSnapshot {
      if (owner !== peer) throw new DeviceBridgeError("device_bridge_unavailable");
      snapshot = deviceStateSnapshot(value); return { ...snapshot };
    },
    /** Safe default: refuse when Main is gone, when the session is not awake, or when the state is still unknown. */
    assertScreenAvailable(): void {
      if (!transport) throw new DeviceBridgeError("device_bridge_unavailable");
      if (snapshot.session !== "awake") throw new DeviceBridgeError("device_session_locked");
    },
    async idleSnapshot(): Promise<DeviceStateSnapshot> {
      const reply = await ask("idle", {}, Math.min(5000, options.deadlineMs ?? 5000));
      if (owner) snapshot = deviceStateSnapshot(reply);
      return { ...snapshot };
    },
    async prepareOsExecution(input: { runId: string; chatId: string; permission: "read" | "write" | "full"; inputDigest: string }): Promise<PreparedOsExecutionWire & { dispose(): void }> {
      if (!transport) throw new DeviceBridgeError("device_bridge_unavailable");
      // Learn the lock state first when it is still unknown (just attached): Main's answer is authoritative.
      if (snapshot.session === "unknown") await this.idleSnapshot();
      this.assertScreenAvailable();
      const reply = await ask("prepareOsExecution", { runId: input.runId, chatId: input.chatId, permission: input.permission, inputDigest: input.inputDigest });
      const capability = reply.capability as PreparedOsExecutionWire["capability"] | undefined;
      if (!capability || capability.version !== "agentlas.one-os-execution.v1" || typeof capability.executionId !== "string" || !/^[a-f0-9]{64}$/.test(String(capability.token))) throw new DeviceBridgeError("device_bridge_refused", "device_capability_invalid");
      let disposed = false;
      return { capability, dispose: () => {
        if (disposed) return; disposed = true;
        // Best effort: Main also revokes on channel close and when the run's owner row stops being active.
        void ask("disposeOsExecution", { executionId: capability.executionId }, 5000).catch(() => undefined);
      } };
    },
    /** A2 chat host handover: ask Main to release its idle resident runtime sessions for the chat (reply: busy/released/pending). */
    async releaseChatSessions(chatId: string, deadlineMs: number): Promise<{ busy: boolean; released: number; pending: number }> {
      const reply = await ask("releaseChatSessions", { chatId, deadlineMs }, deadlineMs + 2000);
      if (typeof reply.busy !== "boolean" || !Number.isSafeInteger(reply.released) || !Number.isSafeInteger(reply.pending)) throw new DeviceBridgeError("device_bridge_refused", "chat_handover_reply_invalid");
      return { busy: reply.busy, released: reply.released as number, pending: reply.pending as number };
    },
    /** Goal custody is Main's: hand an owner message that would become a Goal to Main (2026-10-11, run 97164057). Main answers
     * at once (accepted|duplicate) and does the classification and admission in the background, because the native channel
     * closes for good on a request that outlives its 10 s limit. */
    async forwardGoalIntake(input: { runId: string; chatId: string; sourceMessageId: string; permission: "read" | "write" | "full" }): Promise<{ status: "accepted" | "duplicate" }> {
      const reply = await ask("forwardGoalIntake", { runId: input.runId, chatId: input.chatId, sourceMessageId: input.sourceMessageId, permission: input.permission }, 8000);
      if (reply.status !== "accepted" && reply.status !== "duplicate") throw new DeviceBridgeError("device_bridge_refused", "goal_intake_reply_invalid");
      return { status: reply.status };
    },
    /** One's app-control (one_app_operations / one_app_call) belongs to Main: it owns the IPC handlers and the owner's windows.
     * Main answers with an outcome, never an exception, so an app-control error keeps its code and text. */
    async appControl(input: { kind: "operations" | "call"; ownerTurn: boolean; permission?: "read" | "write" | "full"; input: Record<string, unknown> }): Promise<{ outcome: "value"; value: unknown } | { outcome: "error"; code: string; message: string }> {
      const reply = await ask("appControl", { kind: input.kind, ownerTurn: input.ownerTurn, permission: input.permission ?? "read", input: input.input }, options.appControlDeadlineMs ?? APP_CONTROL_DEADLINE_MS);
      if (reply.outcome === "value") return { outcome: "value", value: reply.value };
      if (reply.outcome === "error" && typeof reply.code === "string" && typeof reply.message === "string") return { outcome: "error", code: reply.code, message: reply.message };
      throw new DeviceBridgeError("device_bridge_refused", "app_control_reply_invalid");
    },
    /** NH21: the service owns the Alive clock, Main owns Goal custody. Main re-reads this executing reservation from the
     * shared store, runs the Goal action once (durable action-id claim) and answers with the settled result. */
    async aliveAction(input: { domain: "work" | "one"; actionId: string }): Promise<{ result: unknown }> {
      const reply = await ask("aliveAction", { domain: input.domain, actionId: input.actionId }, 8000);
      return { result: reply.result };
    },
    /** A life changed: Main's screens and its phone projection refresh (no content, the same invalidation as Main's own). */
    async aliveChanged(event: { surface: "one" | "work"; chatId?: string; scopeId: string }): Promise<void> {
      if (!transport) return;
      await ask("aliveChanged", { surface: event.surface, scopeId: event.scopeId, ...(event.chatId !== undefined ? { chatId: event.chatId } : {}) }, 5000);
    },
    failPending: failAll,
  };
}
export type DaemonDeviceBridge = ReturnType<typeof createDaemonDeviceBridge>;
let shared: DaemonDeviceBridge | null = null;
export function daemonDeviceBridge(): DaemonDeviceBridge { return shared ??= createDaemonDeviceBridge(); }
