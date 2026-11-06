import { redactOperationalSecrets } from "../invocation/event-secret-redaction";
import { nativeStartDescriptor, makeNativePreparationWireRequest, type NativeStartDescriptor, type NativePreparationWireRequest } from "./native-start-protocol";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { TextDecoder } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { boundedUnixSocketPath, defaultControlSocketPath, sweepStalePrivateSocketDirs, type ControlSocketPeer } from "./control-socket";
import { canonicalDaemonPath } from "./service-identity";
import { NATIVE_AUTH_MAX_FRAME_BYTES as MAX_BYTES, assertNativeAuthBinding, nativeAuthCanonical, nativeAuthError, nativeDaemonEnrollment, acceptNativeDaemonEnrollment, type NativeAuthBinding, type NativeCredential, type NativeIngressNoStartObservation, type NativeServiceObservation, validateNativeServiceObservationRequest, validateNativeIngressNoStartRequest, validateNativeTerminalPreparationRequest } from "./native-auth-credentials";
import { createNativeDaemonAuthenticator, createNativeGuiAuthenticator, decodeNativeAuthLine, type NativeAuthenticatedIdentity, type NativeTerminalCheckpointCapability, type NativeIngressNoStartConsumer, type NativeServiceObservationConsumer } from "./native-session-auth";
const guiChannelIdentities = new WeakMap<object, () => NativeAuthenticatedIdentity | undefined>();
export function nativeGuiChannelIdentity(channel: unknown): NativeAuthenticatedIdentity | undefined { return channel !== null && typeof channel === "object" ? guiChannelIdentities.get(channel)?.() : undefined; }
const guiIngressObservations = new WeakMap<object, { channel: object; identity: NativeAuthenticatedIdentity; proof: NativeIngressNoStartObservation }>();
export function consumeNativeGuiIngressNoStart(channel: unknown, identity: NativeAuthenticatedIdentity, exactIncomingWire: unknown): NativeIngressNoStartObservation {
  if (!channel || typeof channel !== "object" || !exactIncomingWire || typeof exactIncomingWire !== "object") throw nativeAuthError("native_auth_ingress_observation_required");
  const held = guiIngressObservations.get(exactIncomingWire);
  if (!held || held.channel !== channel || held.identity !== identity || nativeGuiChannelIdentity(channel) !== identity) throw nativeAuthError("native_auth_ingress_observation_required");
  guiIngressObservations.delete(exactIncomingWire); return held.proof;
}
const guiServiceObservations = new WeakMap<object, { channel: object; identity: NativeAuthenticatedIdentity; proof: NativeServiceObservation }>();
export function consumeNativeGuiServiceObservation(channel: unknown, identity: NativeAuthenticatedIdentity, exactIncomingWire: unknown): NativeServiceObservation {
  if (!channel || typeof channel !== "object" || !exactIncomingWire || typeof exactIncomingWire !== "object") throw nativeAuthError("native_auth_service_observation_required");
  const held = guiServiceObservations.get(exactIncomingWire);
  if (!held || held.channel !== channel || held.identity !== identity || nativeGuiChannelIdentity(channel) !== identity) throw nativeAuthError("native_auth_service_observation_required");
  guiServiceObservations.delete(exactIncomingWire); return held.proof;
}
export interface NativeServiceObservationPort { dispatch(request: NativePreparationWireRequest, opaqueServiceProof: unknown): Promise<unknown> }
export interface NativeIngressNoStartPort { dispatch(request: NativePreparationWireRequest, opaqueServiceProof: unknown): Promise<unknown> }
function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean { const keys = Object.keys(value).sort(), expected = [...fields].sort(); return keys.length === expected.length && keys.every((key, index) => key === expected[index]); }
export interface NativeTerminalCheckpointPort { dispatch(request: NativePreparationWireRequest): Promise<unknown>; request(action: "cancel" | "quiesce" | "finish" | "ingress.reject", payload: Readonly<Record<string, unknown>>): Promise<unknown> }
/**
 * invoke.nativeStart answers only after the daemon's whole start (preparation judges, runtime checks, first provider
 * dispatch). A 10 s bound closed the channel on a slow start, and nothing re-attaches it, so every later One action
 * failed until a restart (production 1.2.92, 2026-10-11T01:53:28.9Z request, 01:53:38.98Z native_auth_channel_lost).
 * The start carries its own preparation deadlines; this bound only catches a daemon that never answers.
 * The daemon's checkpoint calls back into Main (judge, team/memory/briefing prepare) run model calls inside that start
 * (a One judge took 24 s on 1.2.89), so they get the same bound instead of 10 s.
 */
const NATIVE_SEMANTIC_PREPARATION_BUDGET_MS = 300000;
// Transport delivery is separate from the model budget and fixed when the request starts.
const NATIVE_REPLY_DELIVERY_GRACE_MS = 10000;
const NATIVE_START_REPLY_TIMEOUT_MS = NATIVE_SEMANTIC_PREPARATION_BUDGET_MS + NATIVE_REPLY_DELIVERY_GRACE_MS;
/**
 * A reply that misses its bound fails that one request (native_auth_reply_timeout); the channel and every other request
 * in flight stay up (flow audit 2026-10-18, I-D5). Before, the per-request timer closed the whole channel: one slow
 * Main->daemon request (10 s) or daemon->Main callback (310 s) failed every steer, cancel, approval answer and device
 * request with it (the 3a807120 class at another spot). A late signed reply is verified, then dropped. The channel is
 * closed only when the peer looks wedged: this many requests in a row timed out with no frame of any kind from it in
 * between (any reply, event or callback proves it is alive), or, daemon side, every callback slot of a lane is held
 * by an unanswered request (Main counts those slots until it answers, so a new callback could not be admitted).
 */
const NATIVE_SILENT_PEER_TIMEOUTS = 3;
/** Requests a client keeps on the wire at once, and the daemon runs at once per connection. Equal on purpose: a client that holds its own excess in a local queue never makes the daemon wait, so the reply timer (which starts when the frame is written) is never spent in a queue. */
const NATIVE_WIRE_IN_FLIGHT_ORDINARY = 8;
const NATIVE_WIRE_IN_FLIGHT_CANCEL = 2;
/** Backstops, not limits: far above anything real (a phone opening Finance sends about four). Client: requests held back locally; reaching it refuses only the newest request with native_auth_channel_closed_or_busy, because a thousand waiting calls means a runaway loop and holding more would only grow memory. Daemon: requests waiting for a handler slot from a peer that ignores NATIVE_WIRE_IN_FLIGHT_*; reaching it answers the old native_auth_dispatch_denied for the newest.
 */
const NATIVE_CLIENT_QUEUE_BACKSTOP = 1024;
const NATIVE_DAEMON_QUEUE_BACKSTOP = 64;
const MAX_LATE_REPLIES = 256;
/** Only invoke.nativeStart (whole start) and native.attach (adoptSession + supervisor.recover) wait long; every other request keeps 10 s. */
export function nativeGuiReplyTimeoutMs(method: string): number { return method === "invoke.nativeStart" || method === "native.attach" ? NATIVE_START_REPLY_TIMEOUT_MS : 10000; }
// invoke.runKeyOutcome: the window's answer to a daemon-hosted run's API-key request (flow audit 2026-10-18, I-D2). An older
// service does not list it and answers native_auth_dispatch_denied (a signed reply; the channel stays up).
const methods = new Set(["invoke.nativeStart", "invoke.admission", "invoke.receipt", "invoke.currentTurn", "invoke.steerCurrentTurn", "invoke.currentTurnSteerReceipt", "invoke.cancel", "invoke.runKeyOutcome", "native.approvalReply", "native.attach", "native.detach"]);
const errorCode = (e: unknown): string => {
  if (e && (typeof e === "object" || typeof e === "function")) {
    try {
      let owner: object | null = e;
      for (let depth = 0; owner && depth < 3; depth += 1, owner = Object.getPrototypeOf(owner)) {
        const property = Object.getOwnPropertyDescriptor(owner, "code");
        if (!property) continue;
        const code = Object.hasOwn(property, "value") ? property.value : undefined;
        return typeof code === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(code) && redactOperationalSecrets(code) === code ? code : "native_operation_failed";
      }
    } catch { /* A hostile or revoked proxy supplies no trustworthy code. */ }
  }
  return "native_operation_failed";
};
/**
 * Both ends must name this socket from the same canonical userData. The daemon resolves its directory with
 * canonicalDaemonPath before calling here (daemon/main.ts startDaemon), while the GUI passed its configured
 * path. When userData is reached through a symlink or a Windows junction (/tmp -> /private/tmp in QA, or a
 * support folder the user moved and linked back), the two hashes differed and native_auth_channel_lost
 * repeated forever. Canonicalising here is idempotent: an already-canonical path, such as the installed
 * default with no link in it, yields exactly the bytes it did before, so existing daemons keep their name.
 */
export function nativeAuthSocketPath(userData: string): string {
  const canonical = canonicalDaemonPath(userData);
  const ordinary = defaultControlSocketPath(canonical);
  if (process.platform === "win32") return ordinary + "-native";
  const name = "na-" + createHash("sha256").update(canonical).digest("hex").slice(0, 16) + ".sock";
  const preferred = path.join(path.dirname(ordinary), name);
  // The native filename is longer than daemon.sock. Bound the final published
  // address too, otherwise bind can succeed while clients cannot connect.
  return boundedUnixSocketPath(preferred, name);
}
export async function writeNativeEnrollment(pipe: Writable, binding: NativeAuthBinding, gui: NativeCredential): Promise<void> {
  const wire = await nativeDaemonEnrollment(binding, gui);
  await new Promise<void>((resolve, reject) => { pipe.once("error", reject); pipe.end(wire, () => { pipe.removeListener("error", reject); resolve(); }); });
}
export async function readNativeEnrollment(pipe: Readable, binding: NativeAuthBinding): Promise<NativeCredential> {
  let wire = ""; pipe.setEncoding("utf8");
  const result = await new Promise<string>((resolve, reject) => { const fail = (code: string) => { cleanup(); pipe.destroy(); reject(nativeAuthError(code)); }; const timer = setTimeout(() => fail("native_auth_enrollment_timeout"), 5000); const data = (value: string) => { wire += value; if (Buffer.byteLength(wire) > 16384) fail("native_auth_enrollment_limit"); }; const end = () => { cleanup(); resolve(wire); }; const error = () => fail("native_auth_enrollment_lost"); const cleanup = () => { clearTimeout(timer); pipe.removeListener("data", data); pipe.removeListener("end", end); pipe.removeListener("error", error); }; pipe.on("data", data); pipe.once("end", end); pipe.once("error", error); });
  try { return await acceptNativeDaemonEnrollment(binding, result); } finally { wire = ""; pipe.destroy(); }
}
async function absent(address: string): Promise<boolean> { return new Promise(resolve => { const s = net.connect(address); const timer = setTimeout(() => done(false), 500); const done = (value: boolean) => { clearTimeout(timer); s.destroy(); resolve(value); }; s.once("connect", () => done(false)); s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" || e.code === "ENOENT")); }); }
/** A dedicated bounded privileged transport; existing ControlSocketPeer contract
 * is preserved. Legacy public ping remains a separate, unprivileged socket. */
export async function startNativeAuthChannel(options: { address: string; binding: NativeAuthBinding; credential: NativeCredential; bootId: string; consumeIngressNoStartProof?: NativeIngressNoStartConsumer; consumeServiceObservationProof?: NativeServiceObservationConsumer; handle(method: string, params: unknown, peer: ControlSocketPeer): Promise<unknown> | unknown }) {
  assertNativeAuthBinding(options.binding);
  if (process.platform !== "win32" && Buffer.byteLength(options.address) > 100) throw nativeAuthError("native_auth_socket_path_limit");
  const auth = createNativeDaemonAuthenticator(options.binding, options.credential, options.bootId, options.consumeIngressNoStartProof, options.consumeServiceObservationProof), sockets = new Set<net.Socket>();
  if (process.platform !== "win32") {
    try { const before = fs.lstatSync(options.address); if (!before.isSocket() || !await absent(options.address)) throw nativeAuthError("native_auth_socket_owned_or_unknown"); const after = fs.lstatSync(options.address); if (before.dev !== after.dev || before.ino !== after.ino) throw nativeAuthError("native_auth_socket_changed"); fs.unlinkSync(options.address); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  }
  let privateDir: string | null = null, bindAddress = options.address, identity: { dev: number; ino: number } | null = null;
  if (process.platform !== "win32") { if (Buffer.byteLength(path.join(path.dirname(options.address), ".n-XXXXXX", "s")) > 100) throw nativeAuthError("native_auth_socket_path_limit"); privateDir = fs.mkdtempSync(path.join(path.dirname(options.address), ".n-")); fs.chmodSync(privateDir, 0o700); bindAddress = path.join(privateDir, "s"); }
  const tasks = new Set<Promise<void>>();
  /*
   * The daemon runs with its stdio discarded, so a connection it ends left no trace anywhere (2026-10-21: Desktop lost the
   * channel four times in six hours and could only say "closed"). One line per ended connection, in <socket name>-close.log next to the socket, bounded:
   * a reason code only, never a payload.
   */
  const diag = (reason: string): void => {
    try {
      const file = `${options.address.replace(/\.sock$/u, "")}-close.log`;
      try { if (fs.statSync(file).size > 131072) fs.writeFileSync(file, fs.readFileSync(file, "utf8").slice(-32768), { mode: 0o600 }); } catch { /* new file */ }
      fs.appendFileSync(file, `${new Date().toISOString()} boot=${options.bootId.slice(0, 8)} ${reason.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 80)} sockets=${sockets.size}\n`, { mode: 0o600 });
    } catch { /* diagnostics only */ }
  };
  type Reverse = { send(value: unknown): boolean; close(): void; pending: Map<string, { sequence: number; identity: NativeAuthenticatedIdentity; lane: "ordinary" | "terminal"; replyDomain: "agentlas.native.checkpointReply.v1" | "agentlas.native.terminalCheckpointReply.v1" | "agentlas.native.ingressNoStartReply.v1" | "agentlas.native.serviceObservationReply.v1"; ingressNoStart?: boolean; serviceObservation?: boolean; capability?: NativeTerminalCheckpointCapability; request?: NativePreparationWireRequest; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout>; expired?: boolean }> };
  const reversePeers = new WeakMap<ControlSocketPeer, Reverse>();
  const terminalPorts = new WeakMap<NativeTerminalCheckpointPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const ingressPorts = new WeakMap<NativeIngressNoStartPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const observationPorts = new WeakMap<NativeServiceObservationPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const requestCheckpoint = (peer: ControlSocketPeer, method: "native.checkpoint", params: unknown, capability?: NativeTerminalCheckpointCapability, ingress?: { proof: unknown }, observation?: { proof: unknown }): Promise<unknown> => {
    const state = reversePeers.get(peer), identity = auth.authenticatedPeerIdentity(peer);
    if (method !== "native.checkpoint" || !state || !identity) return Promise.reject(nativeAuthError("native_auth_checkpoint_unenrolled"));
    const lane = observation ? (validateNativeServiceObservationRequest(params).action === "finish" ? "terminal" : "ordinary") : capability ? "terminal" : "ordinary";
    if ([...state.pending.values()].filter(p => p.lane === lane).length >= (lane === "terminal" ? 2 : 8)) return Promise.reject(nativeAuthError("native_auth_checkpoint_busy"));
    // Params the wire cannot carry (undefined, NaN, an instance) fail this request only: nothing is signed or sent and no
    // sequence is used, so the channel and the other pending requests stay up. Dev 2026-10-18: an app.call with no
    // arguments sent { args: undefined }, the frame build below threw, and its catch closed the whole channel.
    try { nativeAuthCanonical(params); } catch (error) { return Promise.reject(error); }
    const requestId = randomBytes(32).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiting = state.pending.get(requestId);
        if (!waiting || waiting.expired) return;
        // This request fails; its slot stays counted until Main's late completion arrives (verified, then dropped).
        waiting.expired = true; reject(nativeAuthError("native_auth_reply_timeout"));
        if ([...state.pending.values()].filter(p => p.lane === lane && p.expired).length >= (lane === "terminal" ? 2 : 8)) state.close();
      }, NATIVE_START_REPLY_TIMEOUT_MS);
      state.pending.set(requestId, { sequence: 0, identity, lane, ingressNoStart: !!ingress, serviceObservation: !!observation, replyDomain: observation ? "agentlas.native.serviceObservationReply.v1" : ingress ? "agentlas.native.ingressNoStartReply.v1" : capability ? "agentlas.native.terminalCheckpointReply.v1" : "agentlas.native.checkpointReply.v1", capability, resolve, reject, timer });
      try { const frame = observation ? auth.serviceObservationCheckpoint(peer, capability!, requestId, params, observation.proof) : ingress ? auth.ingressNoStartCheckpoint(peer, capability!, requestId, params, ingress.proof) : capability ? auth.terminalCheckpoint(peer, capability, requestId, params) : auth.checkpoint(peer, requestId, params); const waiting = state.pending.get(requestId)!; waiting.sequence = frame.sequence; if (capability) waiting.request = (frame as ReturnType<typeof auth.terminalCheckpoint>).request; if (!state.send({ callback: frame.envelope })) state.close(); } catch (error) { state.close(); reject(error); }
    });
  };
  const server = net.createServer(socket => {
    if (sockets.size >= 64) { diag("too_many_sockets"); socket.destroy(); return; } sockets.add(socket); socket.setTimeout(30000, () => { diag("preauth_idle_timeout"); socket.destroy(); });
    let buffer = "", inFlight = 0, cancelInFlight = 0; const queuedRequests: Array<{ id: number; request: { method: string; params: unknown; sequence: number }; cancel: boolean }> = []; const decoder = new TextDecoder("utf-8", { fatal: true }); const closed = new Set<() => void>();
    let why = "";
    const destroyFor = (reason: string) => { if (!why) { why = reason; diag(reason); } socket.destroy(); };
    const send = (value: unknown) => { if (socket.destroyed) return false; const wire = nativeAuthCanonical(value) + "\n"; if (Buffer.byteLength(wire) - 1 > MAX_BYTES) { destroyFor("outbound_frame_too_large"); return false; } if (socket.writableLength + Buffer.byteLength(wire) > MAX_BYTES * 2) { destroyFor("outbound_backpressure"); return false; } socket.write(wire); return true; };
    const peer: ControlSocketPeer = { notify: (method, params) => { let frame: unknown; try { frame = auth.event(peer, method, params); } catch { return false; } try { return send({ event: frame }); } catch { destroyFor("event_write_failed"); return false; } }, onClose: listener => { if (socket.destroyed) { listener(); return () => {}; } closed.add(listener); return () => { closed.delete(listener); }; } };
    const reverse: Reverse = { send, close: () => destroyFor("callback_expired_limit"), pending: new Map() }; reversePeers.set(peer, reverse);
    const startRequest = (entry: { id: number; request: { method: string; params: unknown; sequence: number }; cancel: boolean }) => {
      const { request, cancel } = entry;
      cancel ? cancelInFlight++ : inFlight++;
      const task = Promise.resolve().then(() => options.handle(request.method, request.params, peer)).then(result => { if (!socket.destroyed) send({ id: entry.id, result: auth.reply(peer, request.sequence, result ?? null) }); }).catch(e => { if (!socket.destroyed) send({ id: entry.id, result: auth.reply(peer, request.sequence, null, errorCode(e)) }); }).finally(() => { cancel ? cancelInFlight-- : inFlight--; tasks.delete(task); startQueued(); }); tasks.add(task);
    };
    const startQueued = () => {
      for (let i = 0; i < queuedRequests.length && !socket.destroyed;) {
        const next = queuedRequests[i];
        if (next.cancel ? cancelInFlight < NATIVE_WIRE_IN_FLIGHT_CANCEL : inFlight < NATIVE_WIRE_IN_FLIGHT_ORDINARY) { queuedRequests.splice(i, 1); startRequest(next); } else i++;
      }
    };
    const retire = () => { queuedRequests.length = 0; auth.close(peer); reversePeers.delete(peer); for (const p of reverse.pending.values()) { clearTimeout(p.timer); p.reject(nativeAuthError("native_auth_channel_lost")); } reverse.pending.clear(); sockets.delete(socket); buffer = ""; for (const f of closed) { try { f(); } catch {} } closed.clear(); }; socket.once("close", retire); socket.once("end", () => { retire(); destroyFor("peer_end"); }); socket.on("error", (error: NodeJS.ErrnoException) => destroyFor(`socket_error:${String(error?.code ?? "unknown")}`));
    socket.on("data", chunk => {
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { destroyFor("frame_not_utf8"); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let message: Record<string, unknown>;
        try { const value = decodeNativeAuthLine(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw nativeAuthError("native_auth_outer_frame_invalid"); message = value as Record<string, unknown>; } catch { destroyFor("frame_undecodable"); return; }
        if (exactKeys(message, ["completion"])) {
          const requestId = (message.completion as { body?: { requestId?: unknown } })?.body?.requestId;
          const waiting = typeof requestId === "string" ? reverse.pending.get(requestId) : undefined;
          if (!waiting || auth.authenticatedPeerIdentity(peer) !== waiting.identity) { destroyFor("completion_unexpected"); return; }
          try { if ((message.completion as { body?: { domain?: unknown } })?.body?.domain !== waiting.replyDomain) throw nativeAuthError("native_auth_checkpoint_reply_invalid"); const result = waiting.serviceObservation ? auth.serviceObservationReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : waiting.ingressNoStart ? auth.ingressNoStartReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : waiting.lane === "terminal" ? auth.terminalCheckpointReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : auth.checkpointReply(peer, message.completion, requestId as string, waiting.sequence); reverse.pending.delete(requestId as string); clearTimeout(waiting.timer); waiting.resolve(result); }
          catch (error) { reverse.pending.delete(requestId as string); clearTimeout(waiting.timer); waiting.reject(error); if (!auth.consumeCheckpointOperationError(error, peer, requestId as string, waiting.sequence)) { destroyFor("completion_invalid"); return; } }
          continue;
        }
        if (!exactKeys(message, ["id", "method", "params"]) || !Number.isSafeInteger(message.id) || Number(message.id) < 1) { destroyFor("frame_bad_shape"); return; }
        if (message.method === "native.auth.hello" || message.method === "native.auth.proof") { try { const result = message.method === "native.auth.hello" ? auth.challenge(peer, message.params) : auth.authenticate(peer, message.params); if (message.method === "native.auth.proof") socket.setTimeout(0); send({ id: message.id, result }); } catch (e) { diag(`handshake_rejected:${errorCode(e)}`); send({ id: message.id, error: errorCode(e) }); socket.end(); } continue; }
        let request: ReturnType<typeof auth.authorize>;
        try { if (message.method !== "native.auth.request") throw nativeAuthError("native_auth_method_denied"); request = auth.authorize(peer, message.params); } catch (e) { diag(`request_rejected:${errorCode(e)}`); send({ id: message.id, error: errorCode(e) }); socket.end(); continue; }
        const cancel = request.method === "invoke.cancel";
        if (!methods.has(request.method)) { send({ id: message.id, result: auth.reply(peer, request.sequence, null, "native_auth_dispatch_denied") }); continue; }
        // Over the per-connection concurrency cap a request waits its turn instead of being refused; the cap itself (handlers running at once per peer) is unchanged.
        // The queue is a backstop only: a current Main keeps at most NATIVE_WIRE_IN_FLIGHT_ORDINARY / _CANCEL on the wire, so it is never reached in normal use.
        // A peer that ignores its own cap gets the old denial once the backstop is full, which bounds the memory a connection can hold.
        const entry = { id: message.id as number, request, cancel };
        if (cancel ? cancelInFlight < NATIVE_WIRE_IN_FLIGHT_CANCEL : inFlight < NATIVE_WIRE_IN_FLIGHT_ORDINARY) startRequest(entry);
        else if (queuedRequests.length < NATIVE_DAEMON_QUEUE_BACKSTOP) queuedRequests.push(entry);
        else send({ id: message.id, result: auth.reply(peer, request.sequence, null, "native_auth_dispatch_denied") });
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) destroyFor("frame_too_large_in");
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(bindAddress, resolve); }); if (privateDir) { fs.chmodSync(bindAddress, 0o600); const s = fs.lstatSync(bindAddress); identity = { dev: s.dev, ino: s.ino }; fs.linkSync(bindAddress, options.address); } } catch (e) { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); if (privateDir) { try { fs.rmdirSync(privateDir); } catch {} } throw e; }
  // A crashed daemon leaves its ".n-XXXXXX/s" behind; once this address is ours, sweep dead ones in the background (perf MP-07).
  if (privateDir) void sweepStalePrivateSocketDirs(path.dirname(options.address), ".n-", privateDir).catch(() => 0);
  let closing: Promise<void> | null = null;
  return { address: options.address, request: (peer: ControlSocketPeer, method: "native.checkpoint", params: unknown) => requestCheckpoint(peer, method, params),
    createServiceObservationPort(peer: ControlSocketPeer, value: NativeStartDescriptor): NativeServiceObservationPort {
      const identity = auth.authenticatedPeerIdentity(peer); if (!identity || !reversePeers.has(peer)) throw nativeAuthError("native_auth_checkpoint_unenrolled");
      const start = nativeStartDescriptor(value), capability = auth.createTerminalCheckpointCapability(peer, start);
      const port: NativeServiceObservationPort = { dispatch(value, opaqueServiceProof) {
        const record = observationPorts.get(this); if (!record || auth.authenticatedPeerIdentity(record.peer) !== record.identity) return Promise.reject(nativeAuthError("native_auth_service_port_required"));
        let request: NativePreparationWireRequest; try { request = validateNativeServiceObservationRequest(value); if (request.start.handle !== record.start.handle || request.start.binding.chatId !== record.start.binding.chatId || request.start.binding.runId !== record.start.binding.runId || request.start.binding.inputDigest !== record.start.binding.inputDigest) throw nativeAuthError("native_auth_terminal_binding_changed"); } catch (error) { return Promise.reject(error); }
        return requestCheckpoint(record.peer, "native.checkpoint", request, record.capability, undefined, { proof: opaqueServiceProof });
      } }; observationPorts.set(port, { peer, identity, start, capability }); return Object.freeze(port);
    },
    createIngressNoStartPort(peer: ControlSocketPeer, value: NativeStartDescriptor): NativeIngressNoStartPort {
      const identity = auth.authenticatedPeerIdentity(peer); if (!identity || !reversePeers.has(peer)) throw nativeAuthError("native_auth_checkpoint_unenrolled");
      const start = nativeStartDescriptor(value), capability = auth.createTerminalCheckpointCapability(peer, start);
      const port: NativeIngressNoStartPort = { dispatch(value, opaqueServiceProof) {
        const record = ingressPorts.get(this); if (!record || auth.authenticatedPeerIdentity(record.peer) !== record.identity) return Promise.reject(nativeAuthError("native_auth_ingress_port_required"));
        let request: NativePreparationWireRequest; try { request = validateNativeIngressNoStartRequest(value); if (request.start.handle !== record.start.handle || request.start.binding.chatId !== record.start.binding.chatId || request.start.binding.runId !== record.start.binding.runId || request.start.binding.inputDigest !== record.start.binding.inputDigest) throw nativeAuthError("native_auth_terminal_binding_changed"); } catch (error) { return Promise.reject(error); }
        return requestCheckpoint(record.peer, "native.checkpoint", request, record.capability, { proof: opaqueServiceProof });
      } }; ingressPorts.set(port, { peer, identity, start, capability }); return Object.freeze(port);
    },
    createTerminalCheckpointPort(peer: ControlSocketPeer, value: NativeStartDescriptor): NativeTerminalCheckpointPort {
      const identity = auth.authenticatedPeerIdentity(peer); if (!identity || !reversePeers.has(peer)) throw nativeAuthError("native_auth_checkpoint_unenrolled");
      const start = nativeStartDescriptor(value), capability = auth.createTerminalCheckpointCapability(peer, start);
      const port: NativeTerminalCheckpointPort = { dispatch(value) {
        const record = terminalPorts.get(this); if (!record || auth.authenticatedPeerIdentity(record.peer) !== record.identity) return Promise.reject(nativeAuthError("native_auth_terminal_capability_required"));
        let request: NativePreparationWireRequest; try { request = validateNativeTerminalPreparationRequest(value); if (request.start.handle !== record.start.handle || request.start.binding.chatId !== record.start.binding.chatId || request.start.binding.runId !== record.start.binding.runId || request.start.binding.inputDigest !== record.start.binding.inputDigest) throw nativeAuthError("native_auth_terminal_binding_changed"); } catch (error) { return Promise.reject(error); }
        return requestCheckpoint(record.peer, "native.checkpoint", request, record.capability);
      }, request(action, payload) {
        const record = terminalPorts.get(this); if (!record) return Promise.reject(nativeAuthError("native_auth_terminal_capability_required"));
        let request: NativePreparationWireRequest; try { request = makeNativePreparationWireRequest(record.start, action, payload); } catch (error) { return Promise.reject(error); }
        return port.dispatch(request);
      } }; terminalPorts.set(port, { peer, identity, start, capability }); return Object.freeze(port);
    }, authenticatedPeerIdentity: auth.authenticatedPeerIdentity, get activePeerCount() { return sockets.size; }, close(): Promise<void> { return closing ??= (async () => { for (const s of sockets) s.destroy(); auth.shutdown(); await new Promise<void>(r => server.close(() => r())); if (identity) { try { const current = fs.lstatSync(options.address); if (current.dev === identity.dev && current.ino === identity.ino) fs.unlinkSync(options.address); } catch {} } if (privateDir) { try { fs.rmdirSync(privateDir); } catch {} } })(); }, async settleDispatched(): Promise<void> { await Promise.allSettled([...tasks]); } };
}
/** Where a value sits, with array positions collapsed so the set of paths stays small: `a.b[].c`. */
const pathKey = (parent: string, key: string | number) => typeof key === "number" ? `${parent}[]` : parent ? `${parent}.${key}` : key;
/** One warning per method and path for the life of the process; names only, never values. Bounded. */
const warnedValuePaths = new Set<string>();
function warnValueOnce(kind: "dropped" | "refused", method: string, valuePath: string): void {
  const key = `${kind}|${method}|${valuePath}`;
  if (warnedValuePaths.has(key) || warnedValuePaths.size >= 256) return;
  warnedValuePaths.add(key);
  console.warn(`[native-invocation] request value ${kind === "dropped" ? "undefined dropped" : "cannot be sent; request refused"} method=${method} path=${valuePath || "$"}`);
}
/** Caller values headed for the wire: a property whose value is undefined is absent (as in JSON); nothing else is changed. */
function wireValue(value: unknown, onDropped?: (valuePath: string) => void): unknown {
  let nodes = 0;
  const walk = (v: unknown, depth: number, at: string): unknown => {
    if (++nodes > 8192 || depth > 24) throw nativeAuthError("native_auth_value_limit");
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) { const out = new Array(v.length); for (let i = 0; i < v.length; i++) if (Object.hasOwn(v, i)) out[i] = walk(v[i], depth + 1, onDropped ? pathKey(at, i) : ""); return out; }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const out = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(v)) { const item = (v as Record<string, unknown>)[key]; if (item !== undefined) out[key] = walk(item, depth + 1, onDropped ? pathKey(at, key) : ""); else onDropped?.(pathKey(at, key)); }
    return out;
  };
  return walk(value, 0, "");
}
/** Path of the first part the wire cannot carry (undefined/hole in an array, NaN, Infinity, Date, Map, class instance...). Called only to name the part in a warning, after a request was refused for its value. */
function unsendablePath(value: unknown): string {
  let nodes = 0;
  const walk = (v: unknown, depth: number, at: string): string | undefined => {
    if (++nodes > 8192 || depth > 24) return at;
    if (v === null || typeof v === "boolean" || typeof v === "string") return undefined;
    if (typeof v === "number") return Number.isFinite(v) ? undefined : at;
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { if (!Object.hasOwn(v, i)) return pathKey(at, i); const hit = walk(v[i], depth + 1, pathKey(at, i)); if (hit !== undefined) return hit; } return undefined; }
    if (!v || typeof v !== "object") return at;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return at;
    for (const key of Object.keys(v)) { const hit = walk((v as Record<string, unknown>)[key], depth + 1, pathKey(at, key)); if (hit !== undefined) return hit; }
    return undefined;
  };
  return walk(value, 0, "") ?? "";
}
/** Raised before a sequence number is consumed or a byte is written: the request is refused, the channel is untouched. */
const localRefusals = new WeakSet<object>();
const LOCAL_VALUE_REFUSALS = new Set(["native_auth_value_invalid", "native_auth_value_limit", "native_auth_frame_limit"]);
/** Bytes a request adds around its params on the wire, taken at their widest: the outer frame, the signed body fields, and the newline. Variable parts (request id, sequence, connection nonce, signature) are padded above their real size, so this never under-counts. */
function requestEnvelopeBytes(method: string, scope = "", generation = "", serviceIdentity = "", bootId = ""): number {
  const body = { scope, generation, serviceIdentity, bootId, connection: "c".repeat(128), sequence: Number.MAX_SAFE_INTEGER, domain: "agentlas.native.request.v1", method, params: null };
  return Buffer.byteLength(nativeAuthCanonical({ id: Number.MAX_SAFE_INTEGER, method: "native.auth.request", params: { body, signature: "s".repeat(256) } })) + 1;
}
export async function connectNativeGuiChannel(options: { address: string; binding: NativeAuthBinding; credential: NativeCredential; bootId: string; onEvent?: (method: string, params: unknown) => void; onRequest?: (method: "native.checkpoint", params: unknown, identity: NativeAuthenticatedIdentity) => Promise<unknown> | unknown }) {
  const auth = createNativeGuiAuthenticator(options.binding, options.credential, options.bootId), socket = net.connect(options.address);
  let nativeChannel: object | undefined;
  let buffer = "", id = 0, done = false, ordinary = 0, cancel = 0, callbackCount = 0, terminalCallbackCount = 0, completionWrites = 0, ordinaryCompletionWrites = 0, terminalCompletionWrites = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true }), closeListeners = new Set<() => void>();
  // Requests held back because their lane is at its wire cap; started in order as replies free slots. Their reply timer has not started: it starts when the frame is written.
  const waiters: Array<{ lane: "ordinary" | "cancel"; launch(): void; reject(e: unknown): void }> = [];
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>; lane: "ordinary" | "cancel" }>();
  // Requests that timed out alone: their late signed reply is verified, then dropped (never "unknown id, close").
  const lateReplies = new Map<number, (result: unknown) => void>();
  let silentTimeouts = 0;
  // Why this channel closed, for the one line logged when it does. 2026-10-21: the Desktop <-> daemon channel was lost four
  // times in six hours and the log held no trace of the cause (every close path was silent).
  let closeReason = "";
  const completions: Array<{ prepare: () => unknown; terminal: boolean }> = [];
  const close = () => {
    if (done) return;
    console.info(`[native-invocation] channel closed reason=${closeReason || "unspecified"} pending=${pending.size} silentTimeouts=${silentTimeouts}`);
    done = true; auth.close(); socket.destroy(); buffer = ""; completions.length = 0; outbound.length = 0; lateReplies.clear();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(nativeAuthError("native_auth_channel_lost")); } pending.clear(); ordinary = cancel = 0; for (const w of waiters.splice(0)) w.reject(nativeAuthError("native_auth_channel_lost"));
    for (const listener of closeListeners) { try { listener(); } catch {} } closeListeners.clear();
  };
  const closeFor = (reason: string) => { if (!closeReason) closeReason = reason; close(); };
  // Frames wait here when the socket buffer is already full, and leave in the order they entered. The peer accepts request N only right after N-1 (native-session-auth authorize: sequence === last + 1), and a request's sequence is taken in call() in the same synchronous step that appends its frame here, so queue order is sequence order. Signing before queuing (not at write time) keeps that: nothing is signed out of order, and the queue is a pure byte buffer.
  // The queue is bounded by what already bounds the callers: NATIVE_WIRE_IN_FLIGHT_ORDINARY ordinary and _CANCEL cancel requests on the wire (the rest wait in `waiters`, whose own backstop is NATIVE_CLIENT_QUEUE_BACKSTOP), each frame at most MAX_BYTES; replies to the peer's checkpoints are one per peer request. A lost connection ends every waiting request through close() (native_auth_channel_lost).
  const outbound: Array<{ wire: string; callback?: () => void }> = [];
  let awaitingDrain = false;
  const flushOutbound = () => {
    if (awaitingDrain) return;
    while (outbound.length && !done && !socket.destroyed && socket.writable) {
      const next = outbound[0];
      if (socket.writableLength + Buffer.byteLength(next.wire) > MAX_BYTES * 2) { awaitingDrain = true; socket.once("drain", () => { awaitingDrain = false; flushOutbound(); }); return; } // an empty buffer always fits one frame
      outbound.shift(); socket.write(next.wire, next.callback);
    }
  };
  const write = (value: unknown, callback?: () => void) => {
    if (done || socket.destroyed || !socket.writable) throw nativeAuthError("native_auth_channel_lost");
    const wire = nativeAuthCanonical(value) + "\n";
    if (Buffer.byteLength(wire) - 1 > MAX_BYTES) throw nativeAuthError("native_auth_frame_limit");
    // A full socket buffer is backpressure, not a failure: wait for drain instead of refusing or closing.
    // socket.write returning false likewise means queued, never evidence that the frame was not sent.
    outbound.push({ wire, callback }); flushOutbound();
  };
  const flushCompletions = () => {
    while (!done && completionWrites < 2 && completions.length) {
      const next = completions.shift()!; completionWrites++; next.terminal ? terminalCompletionWrites++ : ordinaryCompletionWrites++;
      try { write({ completion: next.prepare() }, () => { completionWrites--; next.terminal ? terminalCompletionWrites-- : ordinaryCompletionWrites--; flushCompletions(); }); } catch { closeFor("completion_write_failed"); return; }
    }
  };
  socket.on("error", (error: NodeJS.ErrnoException) => closeFor(`socket_error:${String(error?.code ?? error?.name ?? "unknown").replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 40)}`));
  socket.on("close", () => closeFor("socket_close")); socket.on("end", () => closeFor("socket_end")); socket.on("data", chunk => {
    try { buffer += decoder.decode(chunk, { stream: true }); } catch { closeFor("frame_not_utf8"); return; }
    let n: number;
    while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); let value: unknown;
      try { value = decodeNativeAuthLine(line); } catch { closeFor("frame_undecodable"); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { closeFor("frame_not_object"); return; } const message = value as Record<string, unknown>;
      if (exactKeys(message, ["event"])) { try { const event = auth.event(message.event); silentTimeouts = 0; options.onEvent?.(event.method, event.params); } catch { closeFor("event_rejected"); return; } continue; }
      if (exactKeys(message, ["callback"])) {
        try {
          const incoming = auth.checkpoint(message.callback), captured = auth.authenticatedIdentity(); silentTimeouts = 0;
          const terminal = incoming.terminal, queued = completions.filter(c => c.terminal === terminal).length;
          if (terminal ? terminalCallbackCount + terminalCompletionWrites + queued >= 2 : callbackCount + ordinaryCompletionWrites + queued >= 8) throw nativeAuthError("native_auth_checkpoint_busy");
          if (!captured) throw nativeAuthError("native_auth_checkpoint_unenrolled");
          if (incoming.ingressNoStart) { if (!nativeChannel || !incoming.params || typeof incoming.params !== "object") throw nativeAuthError("native_auth_ingress_observation_required"); guiIngressObservations.set(incoming.params, { channel: nativeChannel, identity: captured, proof: incoming.ingressNoStart }); }
          if (incoming.serviceObservation) { if (!nativeChannel || !incoming.params || typeof incoming.params !== "object") throw nativeAuthError("native_auth_service_observation_required"); guiServiceObservations.set(incoming.params, { channel: nativeChannel, identity: captured, proof: incoming.serviceObservation }); }
          terminal ? terminalCallbackCount++ : callbackCount++;
          Promise.resolve().then(() => { if (done || auth.authenticatedIdentity() !== captured) throw nativeAuthError("native_auth_channel_lost"); if (!options.onRequest) throw nativeAuthError("native_checkpoint_unavailable"); return options.onRequest(incoming.method, incoming.params, captured); }).then(result => {
            if (done || auth.authenticatedIdentity() !== captured) return;
            completions.push({ prepare: () => incoming.complete(result ?? null), terminal }); flushCompletions();
          }, (reason) => { if (done || auth.authenticatedIdentity() !== captured) return; completions.push({ prepare: () => incoming.complete(null, errorCode(reason)), terminal }); flushCompletions(); }).finally(() => { if (incoming.params && typeof incoming.params === "object") guiIngressObservations.delete(incoming.params); if (incoming.params && typeof incoming.params === "object") guiServiceObservations.delete(incoming.params); terminal ? terminalCallbackCount-- : callbackCount--; });
        } catch (error) { closeFor(`callback_${errorCode(error)}`); return; } continue;
      }
      if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) { closeFor("frame_bad_id"); return; }
      const requestId = Number(message.id), waiting = pending.get(requestId);
      if (!waiting) {
        const late = lateReplies.get(requestId);
        if (!late || !exactKeys(message, ["id", "result"])) { closeFor("unknown_reply_id"); return; }
        lateReplies.delete(requestId); silentTimeouts = 0;
        try { late(message.result); } catch { closeFor("late_reply_invalid"); return; } // a forged or broken late reply still closes
        continue;
      }
      silentTimeouts = 0;
      pending.delete(requestId); clearTimeout(waiting.timer); release(waiting.lane);
      if (exactKeys(message, ["id", "result"])) waiting.resolve(message.result);
      else { waiting.reject(nativeAuthError("native_auth_unsigned_error")); closeFor("unsigned_error"); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_BYTES) closeFor("frame_too_large");
  });
  /** A wire slot of this lane is free again: count it down and start the longest-waiting request that now fits. */
  const release = (lane: "ordinary" | "cancel") => {
    lane === "cancel" ? cancel-- : ordinary--;
    for (let i = 0; i < waiters.length && !done;) {
      const w = waiters[i];
      if (w.lane === "cancel" ? cancel < NATIVE_WIRE_IN_FLIGHT_CANCEL : ordinary < NATIVE_WIRE_IN_FLIGHT_ORDINARY) { waiters.splice(i, 1); w.launch(); } else i++;
    }
  };
  const call = (method: string, prepare: () => unknown, lane: "ordinary" | "cancel" = "ordinary", timeoutMs = 10000, verifyLate?: (result: unknown) => void): Promise<unknown> => {
    // Reserve before signing. Known local capacity refusal must not consume a signed sequence.
    if (done || socket.destroyed || !socket.writable || id >= Number.MAX_SAFE_INTEGER - 1) return Promise.reject(nativeAuthError("native_auth_channel_closed_or_busy"));
    return new Promise((resolve, reject) => {
     const launch = () => {
      const requestId = ++id; lane === "cancel" ? cancel++ : ordinary++;
      // The handshake (hello/proof) has no late path: without it there is no channel, so its timeout closes.
      const timer = setTimeout(() => {
        if (!verifyLate) { closeFor("handshake_timeout"); return; }
        if (pending.get(requestId)?.timer !== timer) return;
        pending.delete(requestId); release(lane);
        lateReplies.set(requestId, verifyLate); if (lateReplies.size > MAX_LATE_REPLIES) lateReplies.delete(lateReplies.keys().next().value!);
        reject(nativeAuthError("native_auth_reply_timeout"));
        if (++silentTimeouts >= NATIVE_SILENT_PEER_TIMEOUTS) closeFor("silent_peer_timeouts");
      }, timeoutMs); pending.set(requestId, { resolve, reject, timer, lane });
      try { write({ id: requestId, method, params: prepare() }); }
      catch (error) {
        pending.delete(requestId); clearTimeout(timer); release(lane); reject(error);
        if (typeof error === "object" && error !== null && localRefusals.has(error)) return; // this request alone is refused; nothing was signed or written
        closeFor("request_write_failed");
      } // Preserve the original diagnostic; signing/write uncertainty never rolls back or retries.
     };
      // At the wire cap the request waits (FIFO) instead of being refused; its timer starts in launch(), when the frame is written.
      if ((lane === "cancel" ? cancel < NATIVE_WIRE_IN_FLIGHT_CANCEL : ordinary < NATIVE_WIRE_IN_FLIGHT_ORDINARY) && !waiters.some(w => w.lane === lane)) launch();
      else if (waiters.length < NATIVE_CLIENT_QUEUE_BACKSTOP) waiters.push({ lane, launch, reject });
      else reject(nativeAuthError("native_auth_channel_closed_or_busy"));
    });
  };
  try { const challenge = await call("native.auth.hello", () => auth.hello); auth.accept(await call("native.auth.proof", () => auth.proof(challenge))); } catch (error) { closeFor("handshake_failed"); throw error; }
  const channel = {
    /** Native-only; the integration must still validate captured admission/capsule authority. */
    async dispatch(method: string, params: unknown): Promise<unknown> {
      if (!methods.has(method)) throw nativeAuthError("native_auth_method_denied"); let sequence = 0;
      const wireParams = wireValue(params, valuePath => warnValueOnce("dropped", method, valuePath));
      // Refused before call(): no sequence number, no pending entry, no byte on the wire; the channel is untouched.
      try {
        // A body just under the frame limit grows past it once the signed envelope is added; that used to be found inside write(), after a sequence number was taken, and closed the channel.
        if (Buffer.byteLength(nativeAuthCanonical(wireParams)) + requestEnvelopeBytes(method, options.binding.scope, options.credential.generation, options.binding.serviceIdentity, options.bootId) > MAX_BYTES) { warnValueOnce("refused", method, "(frame size)"); throw nativeAuthError("native_auth_frame_limit"); }
      } catch (error) { if (typeof error === "object" && error !== null && LOCAL_VALUE_REFUSALS.has((error as { code?: string }).code ?? "")) warnValueOnce("refused", method, unsendablePath(wireParams)); throw error; }
      const result = await call("native.auth.request", () => {
        let frame: ReturnType<typeof auth.request>;
        // auth.request validates the whole body before it takes a sequence number, so a value refusal here consumed nothing.
        try { frame = auth.request(method, wireParams); } catch (error) { if (typeof error === "object" && error !== null && LOCAL_VALUE_REFUSALS.has((error as { code?: string }).code ?? "")) { localRefusals.add(error); warnValueOnce("refused", method, unsendablePath(wireParams)); } throw error; }
        sequence = frame.sequence; return frame.envelope;
      }, method === "invoke.cancel" ? "cancel" : "ordinary",
        nativeGuiReplyTimeoutMs(method), late => { try { auth.reply(late, sequence); } catch (error) { if (!auth.consumeReplyOperationError(error, sequence)) throw error; } });
      try { return auth.reply(result, sequence); } catch (error) { if (!auth.consumeReplyOperationError(error, sequence)) closeFor("reply_invalid"); throw error; }
    },
    onClose(listener: () => void): () => void { if (done) { listener(); return () => {}; } closeListeners.add(listener); return () => { closeListeners.delete(listener); }; }, close,
  };
  nativeChannel = channel; guiChannelIdentities.set(channel, () => done || socket.destroyed ? undefined : auth.authenticatedIdentity());
  return channel;
}
