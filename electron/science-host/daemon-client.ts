import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureDaemonRunning, type EnsureDaemonOptions } from "../daemon/app-launcher";
import { canonicalDaemonPath, daemonControlSocketPath, resolveDaemonServiceIdentity } from "../daemon/service-identity";
import type { InstallIdentity } from "../install-identity";
import type { DaemonScienceCommand, DaemonScienceEvent, DaemonScienceStatus } from "../daemon/science-service";
import { isIpcErrorCode } from "../../shared/ipc-error-code";

export interface ScienceDaemonClientOptions extends EnsureDaemonOptions {
  /** Actual opened GUI store, after the migration/admission barrier. Never guessed. */
  storePath: string;
  installIdentity: InstallIdentity;
  requiredSchemaVersion: number;
  connectTimeoutMs?: number;
}

export interface ScienceDaemonRequestOptions {
  /** Stops only this local wait. To stop computation, send cancelMath explicitly. */
  signal?: AbortSignal;
  /** Optional caller-selected reply deadline. Zero/omitted means no deadline. */
  timeoutMs?: number;
}

export interface ScienceDaemonSubscriptionOptions {
  /** Signed native viewers actually displaying the synchronous ask UI. */
  askUserScopes?: Array<{ projectId: string; conversationId: string }>;
}

export interface ScienceDaemonClientFailure {
  schema: "agentlas.science-daemon-client-error.v1";
  code: string;
  phase: "ensure" | "identity" | "connect" | "request" | "protocol" | "remote";
  /** A remote rejection can still contain persisted receipts; it does not prove no effects. */
  outcome: "not-dispatched" | "unknown" | "rejected";
  transportCode?: string;
  remoteCode?: number;
  remoteMessage?: string;
  remoteSourceCode?: string;
}

/** Transport state is machine-readable; remote prose is never parsed for causes. */
export class ScienceDaemonClientError extends Error {
  readonly code: string;
  constructor(readonly failure: ScienceDaemonClientFailure) {
    super(failure.code);
    this.name = "ScienceDaemonClientError";
    this.code = failure.code;
  }
  toJSON(): ScienceDaemonClientFailure { return { ...this.failure }; }
}

export interface ScienceDaemonClient {
  ensureStarted(): Promise<DaemonScienceStatus>;
  /** Read only: does not spawn a daemon or start Science. */
  status(): Promise<DaemonScienceStatus>;
  command(command: DaemonScienceCommand, options?: ScienceDaemonRequestOptions): Promise<unknown>;
  /** Current daemon only: no spawn, Science start, or automatic retry. */
  commandObserved(command: DaemonScienceCommand, options?: ScienceDaemonRequestOptions): Promise<unknown>;
  cancelMath(input: { projectId: string; requestId: string }): Promise<{ requested: boolean }>;
  /** One socket, no automatic reconnect. Reattach/replay explicitly after disconnect. */
  subscribe(onEvent: (event: DaemonScienceEvent) => void, onDisconnect?: (error: ScienceDaemonClientError) => void,
    options?: ScienceDaemonSubscriptionOptions): Promise<() => void>;
  /** Closes GUI-side waits, not autonomous work or the daemon service. */
  close(): void;
  readonly eventTransport: "push-and-replay";
}

interface VerifiedDaemon {
  pid: number;
  bootId: string;
  serviceIdentity: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const STATES = new Set(["idle", "starting", "disabled", "ready", "closing", "closed", "failed"]);

function failure(code: string, phase: ScienceDaemonClientFailure["phase"], outcome: ScienceDaemonClientFailure["outcome"],
  details: Partial<Pick<ScienceDaemonClientFailure, "transportCode" | "remoteCode" | "remoteMessage" | "remoteSourceCode">> = {}): ScienceDaemonClientError {
  return new ScienceDaemonClientError({ schema: "agentlas.science-daemon-client-error.v1", code, phase, outcome, ...details });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Native GUI client only. Authentication of the renderer and project happens in
 * Main before this boundary. No transport method is accepted from a renderer:
 * callers pass the Science service's discriminated command union.
 */
export function createScienceDaemonClient(options: ScienceDaemonClientOptions): ScienceDaemonClient {
  if (!path.isAbsolute(options.userDataDir) || !path.isAbsolute(options.storePath)
    || !Number.isSafeInteger(options.requiredSchemaVersion) || options.requiredSchemaVersion < 1
    || (options.connectTimeoutMs !== undefined && (!Number.isSafeInteger(options.connectTimeoutMs)
      || options.connectTimeoutMs < 1 || options.connectTimeoutMs > 30_000))) {
    throw failure("science_daemon_client_options_invalid", "identity", "not-dispatched");
  }
  let identity: ReturnType<typeof resolveDaemonServiceIdentity>;
  try {
    if (!fs.statSync(options.storePath).isFile()) throw new Error("not-file");
  } catch { throw failure("science_daemon_store_unavailable", "identity", "not-dispatched"); }
  try { identity = resolveDaemonServiceIdentity(options); }
  catch { throw failure("science_daemon_identity_unavailable", "identity", "not-dispatched"); }
  const socketPath = daemonControlSocketPath(identity.userDataDir);
  const pending = new Set<(reason: ScienceDaemonClientError) => void>();
  let closed = false;
  let starting: Promise<DaemonScienceStatus> | null = null;

  const assertIdentity = () => {
    if (closed) throw failure("science_daemon_client_closed", "request", "not-dispatched");
    try {
      if (!fs.statSync(identity.storePath).isFile()
        || resolveDaemonServiceIdentity(options).serviceIdentity !== identity.serviceIdentity) throw new Error("identity-changed");
    } catch { throw failure("science_daemon_local_identity_changed", "identity", "not-dispatched"); }
  };

  // Existing callControlSocket always imposes a reply timeout and does not
  // reject on EOF. Keep the same NDJSON protocol, but separate connection
  // admission from arbitrarily long scientific computation and handle EOF.
  function rpc(method: "daemon.ping" | "science.start" | "science.status" | "science.command" | "science.subscribe", params: unknown,
    request: ScienceDaemonRequestOptions = {}, stream?: { ownerEpoch: string;
      onEvent(event: DaemonScienceEvent): void; onDisconnect?(error: ScienceDaemonClientError): void }): Promise<unknown> {
    assertIdentity();
    const timeoutMs = request.timeoutMs ?? 0;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      return Promise.reject(failure("science_daemon_request_timeout_invalid", "request", "not-dispatched"));
    }
    if (request.signal?.aborted) return Promise.reject(failure("science_daemon_wait_aborted", "request", "not-dispatched"));
    const id = randomUUID();
    let payload: string;
    try { payload = `${JSON.stringify({ id, method, params })}\n`; }
    catch { return Promise.reject(failure("science_daemon_request_invalid", "request", "not-dispatched")); }
    if (Buffer.byteLength(payload, "utf8") > MAX_REQUEST_BYTES) return Promise.reject(failure("science_daemon_request_too_large", "request", "not-dispatched"));
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      socket.setEncoding("utf8");
      let finished = false;
      let sent = false;
      let subscribed = false;
      const beforeSubscribed: DaemonScienceEvent[] = [];
      let buffer = "";
      let receivedBytes = 0;
      let responseTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = () => sent ? "unknown" as const : "not-dispatched" as const;
      const done = (error?: ScienceDaemonClientError, result?: unknown) => {
        if (finished) return;
        finished = true;
        clearTimeout(connectTimer);
        if (responseTimer) clearTimeout(responseTimer);
        request.signal?.removeEventListener("abort", abort);
        pending.delete(cancel);
        socket.destroy();
        if (error) {
          if (subscribed && error.code !== "science_daemon_client_closed") {
            try { stream?.onDisconnect?.(error); } catch { /* Client observers cannot affect daemon work. */ }
          }
          reject(error);
        } else resolve(result);
      };
      const cancel = (error: ScienceDaemonClientError) => done(new ScienceDaemonClientError({ ...error.failure, outcome: outcome() }));
      const abort = () => done(failure("science_daemon_wait_aborted", "request", outcome()));
      const connectTimer = setTimeout(() => done(failure("science_daemon_connect_timeout", "connect", "not-dispatched")), options.connectTimeoutMs ?? 3_000);
      pending.add(cancel);
      request.signal?.addEventListener("abort", abort, { once: true });
      socket.once("connect", () => {
        clearTimeout(connectTimer);
        try { assertIdentity(); }
        catch (error) { done(error as ScienceDaemonClientError); return; }
        if (request.signal?.aborted) { abort(); return; }
        sent = true; // A disconnect from this point cannot prove non-execution.
        if (timeoutMs) responseTimer = setTimeout(() => done(failure("science_daemon_reply_timeout", "request", "unknown")), timeoutMs);
        socket.write(payload);
      });
      socket.on("data", (chunk: string) => {
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        if (receivedBytes > MAX_REPLY_BYTES) { done(failure("science_daemon_reply_too_large", "protocol", outcome())); return; }
        buffer += chunk;
        let newline: number;
        while (!finished && (newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let message: Record<string, unknown> | null;
          try { message = record(JSON.parse(line)); }
          catch { done(failure("science_daemon_reply_invalid", "protocol", outcome())); return; }
          if (stream && message?.method === "science.event") {
            const event = record(message.params);
            if (!event || event.schema !== "agentlas.science-daemon-event.v1" || event.ownerEpoch !== stream.ownerEpoch
              || !["turn", "lifecycle", "researcher-question", "tool-approval", "ask-user"].includes(String(event.kind))) {
              done(failure("science_daemon_event_identity_mismatch", "protocol", "unknown")); return;
            }
            if (subscribed) {
              try { stream.onEvent(event as unknown as DaemonScienceEvent); } catch { /* Renderer delivery is not execution. */ }
            } else {
              beforeSubscribed.push(event as unknown as DaemonScienceEvent);
              if (beforeSubscribed.length > 256) { done(failure("science_daemon_subscription_overflow", "protocol", "unknown")); return; }
            }
            receivedBytes = Buffer.byteLength(buffer, "utf8");
            continue;
          }
          if (!message || message.id !== id) { done(failure("science_daemon_reply_identity_mismatch", "protocol", outcome())); return; }
          const remote = record(message.error);
          if (remote) {
            done(failure("science_daemon_remote_rejected", "remote", "rejected", {
              ...(typeof remote.code === "number" ? { remoteCode: remote.code } : {}),
              ...(typeof remote.message === "string" ? { remoteMessage: remote.message.slice(0, 2_000) } : {}),
              ...(isIpcErrorCode(record(remote.data)?.sourceCode)
                ? { remoteSourceCode: record(remote.data)?.sourceCode as string } : {}),
            }));
          } else if (Object.prototype.hasOwnProperty.call(message, "result")) {
            if (stream) {
              const receipt = record(message.result);
              if (subscribed || receipt?.subscribed !== true || receipt.ownerEpoch !== stream.ownerEpoch) {
                done(failure("science_daemon_subscription_invalid", "protocol", "unknown")); return;
              }
              subscribed = true;
              if (responseTimer) clearTimeout(responseTimer);
              resolve(() => done());
              for (const event of beforeSubscribed.splice(0)) {
                try { stream.onEvent(event); } catch { /* Durable replay remains available. */ }
              }
              receivedBytes = Buffer.byteLength(buffer, "utf8");
            } else done(undefined, message.result);
          }
          else done(failure("science_daemon_reply_invalid", "protocol", outcome()));
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => done(failure("science_daemon_connection_failed", sent ? "request" : "connect", outcome(),
        typeof error.code === "string" ? { transportCode: error.code } : {})));
      socket.once("end", () => done(failure("science_daemon_connection_closed", "request", outcome())));
      socket.once("close", () => done(failure("science_daemon_connection_closed", "request", outcome())));
    });
  }

  async function inspectDaemon(): Promise<VerifiedDaemon> {
    const ping = record(await rpc("daemon.ping", undefined, { timeoutMs: 5_000 }));
    if (!ping || ping.ok !== true || ping.serviceProtocolVersion !== 2 || ping.lifetime !== "service"
      || ping.processRole !== "desktop-daemon" || ping.controlSocketReady !== true) {
      throw failure("science_daemon_protocol_incompatible", "identity", "not-dispatched");
    }
    if (ping.version !== options.appVersion || ping.storeSchemaVersion !== options.requiredSchemaVersion) {
      throw failure("science_daemon_version_mismatch", "identity", "not-dispatched");
    }
    let matchesPath = false;
    try { matchesPath = typeof ping.storePath === "string" && canonicalDaemonPath(ping.storePath) === identity.storePath; }
    catch { /* An unreadable path cannot establish the same store. */ }
    if (ping.serviceIdentity !== identity.serviceIdentity || !matchesPath) throw failure("science_daemon_service_identity_mismatch", "identity", "not-dispatched");
    if (typeof ping.bootId !== "string" || !UUID.test(ping.bootId)
      || !Number.isSafeInteger(ping.pid) || Number(ping.pid) <= 1) throw failure("science_daemon_boot_identity_invalid", "identity", "not-dispatched");
    return { pid: Number(ping.pid), bootId: ping.bootId, serviceIdentity: identity.serviceIdentity };
  }

  function statusReply(value: unknown, daemon: VerifiedDaemon): DaemonScienceStatus {
    const reply = record(value);
    if (!reply || reply.ownerEpoch !== daemon.bootId || typeof reply.state !== "string" || !STATES.has(reply.state)
      || typeof reply.settled !== "boolean") throw failure("science_daemon_status_invalid", "protocol", "unknown");
    // Before Science is first loaded, the daemon returns its minimal idle view.
    if (reply.state === "idle" && reply.schema === undefined) return {
      schema: "agentlas.science-daemon-status.v1", ownerEpoch: daemon.bootId, state: "idle", settled: reply.settled,
      extensionVersion: null, errorCode: null, activeToolRequests: null,
    };
    if (reply.schema !== "agentlas.science-daemon-status.v1"
      || (reply.extensionVersion !== null && typeof reply.extensionVersion !== "string")
      || (reply.errorCode !== null && typeof reply.errorCode !== "string")
      || (reply.activeToolRequests !== null && (!Number.isSafeInteger(reply.activeToolRequests) || Number(reply.activeToolRequests) < 0))) {
      throw failure("science_daemon_status_invalid", "protocol", "unknown");
    }
    return reply as unknown as DaemonScienceStatus;
  }

  function ensureStarted(): Promise<DaemonScienceStatus> {
    try { assertIdentity(); } catch (error) { return Promise.reject(error); }
    if (starting) return starting;
    starting = (async () => {
      const ensured = await ensureDaemonRunning({ ...options, ...identity });
      assertIdentity();
      if (ensured.status === "disabled") throw failure("science_daemon_disabled", "ensure", "not-dispatched");
      if (ensured.status === "failed") throw failure("science_daemon_ensure_failed", "ensure", "not-dispatched", { remoteMessage: ensured.reason });
      const daemon = await inspectDaemon();
      return statusReply(await rpc("science.start", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId }), daemon);
    })().finally(() => { starting = null; });
    return starting;
  }

  async function status(): Promise<DaemonScienceStatus> {
    const daemon = await inspectDaemon();
    return statusReply(await rpc("science.status", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId }, { timeoutMs: 5_000 }), daemon);
  }

  function waitForStart(signal?: AbortSignal): Promise<DaemonScienceStatus> {
    if (signal?.aborted) return Promise.reject(failure("science_daemon_wait_aborted", "request", "not-dispatched"));
    const shared = ensureStarted();
    if (!signal) return shared;
    return new Promise((resolve, reject) => {
      const abort = () => reject(failure("science_daemon_wait_aborted", "request", "not-dispatched"));
      signal.addEventListener("abort", abort, { once: true });
      void shared.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
    });
  }

  async function command(command: DaemonScienceCommand, request: ScienceDaemonRequestOptions = {}): Promise<unknown> {
    const started = await waitForStart(request.signal);
    if (started.state !== "ready") throw failure("science_daemon_science_unavailable", "ensure", "not-dispatched", { remoteMessage: started.errorCode ?? started.state });
    const daemon = await inspectDaemon();
    if (daemon.bootId !== started.ownerEpoch) throw failure("science_daemon_boot_changed", "identity", "not-dispatched");
    return rpc("science.command", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId, command }, request);
  }

  async function commandObserved(command: DaemonScienceCommand, request: ScienceDaemonRequestOptions = {}): Promise<unknown> {
    if (request.signal?.aborted) throw failure("science_daemon_wait_aborted", "request", "not-dispatched");
    const daemon = await inspectDaemon();
    const current = statusReply(await rpc("science.status", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId },
      { signal: request.signal, timeoutMs: 5_000 }), daemon);
    if (current.state !== "ready") throw failure("science_daemon_science_unavailable", "identity", "not-dispatched", {
      remoteMessage: current.errorCode ?? current.state,
    });
    // The server rejects a boot/identity mismatch before command admission. A
    // lost connection is unknown execution, never a reason to retry mutations.
    return rpc("science.command", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId, command }, request);
  }

  async function cancelMath(input: { projectId: string; requestId: string }): Promise<{ requested: boolean }> {
    // Independent connection: Stop never queues behind the long computation.
    // It targets the currently verified daemon without starting/recovering work.
    const daemon = await inspectDaemon();
    const reply = record(await rpc("science.command", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId,
      command: { op: "math.cancel", input } satisfies DaemonScienceCommand }, { timeoutMs: 5_000 }));
    if (typeof reply?.requested !== "boolean") throw failure("science_daemon_cancel_reply_invalid", "protocol", "unknown");
    return { requested: reply.requested };
  }

  async function subscribe(onEvent: (event: DaemonScienceEvent) => void,
    onDisconnect?: (error: ScienceDaemonClientError) => void, subscription: ScienceDaemonSubscriptionOptions = {}): Promise<() => void> {
    const askUserScopes = subscription.askUserScopes ?? [];
    if (!Array.isArray(askUserScopes) || askUserScopes.length > 128 || askUserScopes.some(scope => !scope
      || typeof scope.projectId !== "string" || !scope.projectId || scope.projectId.length > 256
      || typeof scope.conversationId !== "string" || !scope.conversationId || scope.conversationId.length > 256
      || /[\u0000-\u001f]/u.test(scope.projectId + scope.conversationId))) {
      throw failure("science_daemon_subscription_scope_invalid", "request", "not-dispatched");
    }
    const daemon = await inspectDaemon();
    return await rpc("science.subscribe", { serviceIdentity: daemon.serviceIdentity, bootId: daemon.bootId,
      askUserScopes: askUserScopes.map(({ projectId, conversationId }) => ({ projectId, conversationId })) },
      { timeoutMs: 5_000 }, { ownerEpoch: daemon.bootId, onEvent, onDisconnect }) as () => void;
  }

  return { ensureStarted, status, command, commandObserved, cancelMath, subscribe, eventTransport: "push-and-replay",
    close() {
      if (closed) return;
      closed = true;
      for (const cancel of [...pending]) cancel(failure("science_daemon_client_closed", "request", "unknown"));
    },
  };
}
