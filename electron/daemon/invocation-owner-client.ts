import net from "node:net";
import { randomUUID } from "node:crypto";
import { canonicalDaemonPath, daemonControlSocketPath, resolveDaemonServiceIdentity, type DaemonServiceOptions } from "./service-identity";
import type { InvocationRunOwner } from "../store/invocation-owner-core";
import type { InvocationOwnerBrokerMethod } from "./invocation-owner-broker";

export interface InvocationOwnerControlRequest {
  requestId: string; ownerId: string; leaseId: string;
  chatId: string; runId: string; method: InvocationOwnerBrokerMethod; params: unknown;
}

export interface InvocationOwnerClientOptions extends DaemonServiceOptions {
  storePath: string;
  requiredSchemaVersion: number;
  ownerId: string;
  ownerKind: "desktop" | "terminal";
  onControl(input: InvocationOwnerControlRequest): unknown | Promise<unknown>;
  onDisconnect?(): void;
  timeoutMs?: number;
}

function unavailable(): Error & { code: string } {
  return Object.assign(new Error("invocation_owner_unavailable"), { code: "invocation_owner_unavailable" });
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const METHODS = ["invoke.currentTurn", "invoke.steerCurrentTurn", "invoke.currentTurnSteerReceipt", "invoke.cancel"];

/** Native local client. It observes the existing daemon only: no spawn, replay,
 * fallback brain, or reconnect timer. Every RPC has a distinct bounded wait. */
export function createInvocationOwnerClient(options: InvocationOwnerClientOptions) {
  if (!options.ownerId || !["desktop", "terminal"].includes(options.ownerKind)
    || !Number.isSafeInteger(options.requiredSchemaVersion) || options.requiredSchemaVersion < 1) throw unavailable();
  const identity = resolveDaemonServiceIdentity(options);
  const timeoutMs = options.timeoutMs ?? 8_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw unavailable();
  let socket: net.Socket | null = null;
  let connecting: Promise<void> | null = null;
  let guard: { serviceIdentity: string; bootId: string } | null = null;
  let registered = false, closed = false, controlsInFlight = 0;
  const beforeRegistered: unknown[] = [];
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  function disconnect(connection: net.Socket): void {
    if (socket !== connection) return;
    socket = null; registered = false; guard = null;
    beforeRegistered.length = 0;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(unavailable()); }
    pending.clear();
    connection.destroy();
    try { options.onDisconnect?.(); } catch { /* A viewer cannot stop an owner. */ }
  }

  function assertIdentity(): void {
    if (closed || resolveDaemonServiceIdentity(options).serviceIdentity !== identity.serviceIdentity) throw unavailable();
  }

  function rpc(method: string, params: unknown): Promise<unknown> {
    try { assertIdentity(); } catch { return Promise.reject(unavailable()); }
    const connection = socket;
    if (!connection || connection.destroyed || pending.size >= 128) return Promise.reject(unavailable());
    const id = randomUUID();
    let line: string;
    try { line = `${JSON.stringify({ id, method, params })}\n`; } catch { return Promise.reject(unavailable()); }
    if (Buffer.byteLength(line, "utf8") > 512_000 || connection.writableLength > 2 * 1024 * 1024) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(unavailable()); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { connection.write(line); } catch { disconnect(connection); }
    });
  }

  async function receiveControl(raw: unknown): Promise<void> {
    const input = record(raw);
    if (!registered || !guard || !input || input.ownerId !== options.ownerId
      || typeof input.requestId !== "string" || typeof input.leaseId !== "string"
      || typeof input.chatId !== "string" || typeof input.runId !== "string"
      || typeof input.method !== "string" || !METHODS.includes(input.method)
      || controlsInFlight >= 64) throw unavailable();
    const control = input as unknown as InvocationOwnerControlRequest;
    controlsInFlight += 1;
    try {
      let completion: { result?: unknown; error?: { code: string; message: string } };
      try { completion = { result: await options.onControl(control) }; }
      catch (error) {
        // Only a machine identifier crosses this custody channel; runtime
        // errors may contain paths, prompts, or provider credentials.
        const code = record(error)?.code;
        const safe = typeof code === "string" && /^[a-z][a-z0-9_:-]{0,159}$/.test(code)
          ? code : "invocation_owner_unavailable";
        completion = { error: { code: safe, message: safe } };
      }
      await rpc("invoke.ownerComplete", { ...guard, completion: { requestId: control.requestId,
        ownerId: control.ownerId, leaseId: control.leaseId, ...completion } });
    } finally { controlsInFlight -= 1; }
  }

  async function open(): Promise<void> {
    assertIdentity();
    const connection = net.connect(daemonControlSocketPath(identity.userDataDir));
    socket = connection;
    connection.setEncoding("utf8");
    let buffer = "";
    connection.on("data", (chunk) => {
      buffer += String(chunk);
      if (Buffer.byteLength(buffer, "utf8") > 4 * 1024 * 1024) { disconnect(connection); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message: Record<string, unknown> | null;
        try { message = record(JSON.parse(line)); } catch { disconnect(connection); return; }
        if (!message) { disconnect(connection); return; }
        if (message.method === "invoke.ownerControl" && message.id === undefined) {
          if (!registered) {
            if (beforeRegistered.length >= 64) { disconnect(connection); return; }
            beforeRegistered.push(message.params);
          } else void receiveControl(message.params).catch(() => { /* No resend on a lost ACK. */ });
          continue;
        }
        const entry = typeof message.id === "string" ? pending.get(message.id) : undefined;
        if (!entry) continue;
        pending.delete(message.id as string); clearTimeout(entry.timer);
        if (message.error !== undefined) entry.reject(unavailable());
        else if (Object.prototype.hasOwnProperty.call(message, "result")) entry.resolve(message.result);
        else { entry.reject(unavailable()); disconnect(connection); return; }
      }
    });
    connection.on("error", () => disconnect(connection));
    connection.on("close", () => disconnect(connection));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { disconnect(connection); reject(unavailable()); }, Math.min(timeoutMs, 3_000));
        connection.once("connect", () => { clearTimeout(timer); resolve(); });
        connection.once("error", () => { clearTimeout(timer); reject(unavailable()); });
        connection.once("close", () => { clearTimeout(timer); reject(unavailable()); });
      });
      const ping = record(await rpc("daemon.ping", {}));
      if (!ping || ping.ok !== true || ping.serviceIdentity !== identity.serviceIdentity
        || typeof ping.bootId !== "string" || !/^[0-9a-f-]{36}$/i.test(ping.bootId)
        || typeof ping.storePath !== "string" || canonicalDaemonPath(ping.storePath) !== identity.storePath
        || !Number.isSafeInteger(ping.storeSchemaVersion) || Number(ping.storeSchemaVersion) < options.requiredSchemaVersion) throw unavailable();
      guard = { serviceIdentity: identity.serviceIdentity, bootId: ping.bootId };
      const receipt = record(await rpc("invoke.ownerRegister", { ...guard, ownerId: options.ownerId, ownerKind: options.ownerKind }));
      if (!receipt || receipt.ownerId !== options.ownerId || receipt.ownerKind !== options.ownerKind) throw unavailable();
      registered = true;
      for (const input of beforeRegistered.splice(0)) void receiveControl(input).catch(() => { /* No resend. */ });
    } catch { disconnect(connection); throw unavailable(); }
  }

  function connect(): Promise<void> {
    if (closed) return Promise.reject(unavailable());
    if (registered) return Promise.resolve();
    if (!connecting) connecting = open().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    connect,
    async dispatch(owner: InvocationRunOwner, method: InvocationOwnerBrokerMethod, params: unknown): Promise<unknown> {
      if (!METHODS.includes(method) || (owner.state !== "active" && owner.state !== "settling")) throw unavailable();
      await connect();
      return rpc(method, { ...guard, owner: { chatId: owner.chatId, runId: owner.runId,
        ownerId: owner.ownerId, ownerKind: owner.ownerKind, leaseId: owner.leaseId }, control: params });
    },
    close(): void { closed = true; if (socket) disconnect(socket); },
  };
}
