import { nativeStartDescriptor, makeNativePreparationWireRequest, type NativeStartDescriptor, type NativePreparationWireRequest } from "./native-start-protocol";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import { TextDecoder } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { defaultControlSocketPath, type ControlSocketPeer } from "./control-socket";
import { assertNativeAuthBinding, nativeAuthCanonical, nativeAuthError, nativeDaemonEnrollment, acceptNativeDaemonEnrollment, type NativeAuthBinding, type NativeCredential, type NativeIngressNoStartObservation, type NativeServiceObservation, validateNativeServiceObservationRequest, validateNativeIngressNoStartRequest, validateNativeTerminalPreparationRequest } from "./native-auth-credentials";
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
const MAX_BYTES = 1048576;
const methods = new Set(["invoke.nativeStart", "invoke.admission", "invoke.receipt", "invoke.currentTurn", "invoke.steerCurrentTurn", "invoke.currentTurnSteerReceipt", "invoke.cancel", "native.approvalReply", "native.attach", "native.detach"]);
const errorCode = (e: unknown) => { const c = (e as { code?: unknown })?.code; return typeof c === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(c) ? c : "native_operation_failed"; };
export function nativeAuthSocketPath(userData: string): string {
  const ordinary = defaultControlSocketPath(userData);
  if (process.platform === "win32") return ordinary + "-native";
  const name = "na-" + createHash("sha256").update(userData).digest("hex").slice(0, 16) + ".sock";
  const preferred = path.join(path.dirname(ordinary), name);
  // The native filename is longer than daemon.sock. Bound the final published
  // address too, otherwise bind can succeed while clients cannot connect.
  return Buffer.byteLength(preferred) <= 100 ? preferred : path.join(os.tmpdir(), name);
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
  type Reverse = { send(value: unknown): boolean; close(): void; pending: Map<string, { sequence: number; identity: NativeAuthenticatedIdentity; lane: "ordinary" | "terminal"; replyDomain: "agentlas.native.checkpointReply.v1" | "agentlas.native.terminalCheckpointReply.v1" | "agentlas.native.ingressNoStartReply.v1" | "agentlas.native.serviceObservationReply.v1"; ingressNoStart?: boolean; serviceObservation?: boolean; capability?: NativeTerminalCheckpointCapability; request?: NativePreparationWireRequest; resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }> };
  const reversePeers = new WeakMap<ControlSocketPeer, Reverse>();
  const terminalPorts = new WeakMap<NativeTerminalCheckpointPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const ingressPorts = new WeakMap<NativeIngressNoStartPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const observationPorts = new WeakMap<NativeServiceObservationPort, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor; capability: NativeTerminalCheckpointCapability }>();
  const requestCheckpoint = (peer: ControlSocketPeer, method: "native.checkpoint", params: unknown, capability?: NativeTerminalCheckpointCapability, ingress?: { proof: unknown }, observation?: { proof: unknown }): Promise<unknown> => {
    const state = reversePeers.get(peer), identity = auth.authenticatedPeerIdentity(peer);
    if (method !== "native.checkpoint" || !state || !identity) return Promise.reject(nativeAuthError("native_auth_checkpoint_unenrolled"));
    const lane = observation ? (validateNativeServiceObservationRequest(params).action === "finish" ? "terminal" : "ordinary") : capability ? "terminal" : "ordinary";
    if ([...state.pending.values()].filter(p => p.lane === lane).length >= (lane === "terminal" ? 2 : 8)) return Promise.reject(nativeAuthError("native_auth_checkpoint_busy"));
    const requestId = randomBytes(32).toString("hex");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => state.close(), 10000);
      state.pending.set(requestId, { sequence: 0, identity, lane, ingressNoStart: !!ingress, serviceObservation: !!observation, replyDomain: observation ? "agentlas.native.serviceObservationReply.v1" : ingress ? "agentlas.native.ingressNoStartReply.v1" : capability ? "agentlas.native.terminalCheckpointReply.v1" : "agentlas.native.checkpointReply.v1", capability, resolve, reject, timer });
      try { const frame = observation ? auth.serviceObservationCheckpoint(peer, capability!, requestId, params, observation.proof) : ingress ? auth.ingressNoStartCheckpoint(peer, capability!, requestId, params, ingress.proof) : capability ? auth.terminalCheckpoint(peer, capability, requestId, params) : auth.checkpoint(peer, requestId, params); const waiting = state.pending.get(requestId)!; waiting.sequence = frame.sequence; if (capability) waiting.request = (frame as ReturnType<typeof auth.terminalCheckpoint>).request; if (!state.send({ callback: frame.envelope })) state.close(); } catch (error) { state.close(); reject(error); }
    });
  };
  const server = net.createServer(socket => {
    if (sockets.size >= 64) { socket.destroy(); return; } sockets.add(socket); socket.setTimeout(30000, () => socket.destroy());
    let buffer = "", inFlight = 0, cancelInFlight = 0; const decoder = new TextDecoder("utf-8", { fatal: true }); const closed = new Set<() => void>();
    const send = (value: unknown) => { if (socket.destroyed) return false; const wire = nativeAuthCanonical(value) + "\n"; if (Buffer.byteLength(wire) - 1 > MAX_BYTES) { socket.destroy(); return false; } if (socket.writableLength + Buffer.byteLength(wire) > MAX_BYTES * 2) { socket.destroy(); return false; } socket.write(wire); return true; };
    const peer: ControlSocketPeer = { notify: (method, params) => { let frame: unknown; try { frame = auth.event(peer, method, params); } catch { return false; } try { return send({ event: frame }); } catch { socket.destroy(); return false; } }, onClose: listener => { if (socket.destroyed) { listener(); return () => {}; } closed.add(listener); return () => { closed.delete(listener); }; } };
    const reverse: Reverse = { send, close: () => socket.destroy(), pending: new Map() }; reversePeers.set(peer, reverse);
    const retire = () => { auth.close(peer); reversePeers.delete(peer); for (const p of reverse.pending.values()) { clearTimeout(p.timer); p.reject(nativeAuthError("native_auth_channel_lost")); } reverse.pending.clear(); sockets.delete(socket); buffer = ""; for (const f of closed) { try { f(); } catch {} } closed.clear(); }; socket.once("close", retire); socket.once("end", () => { retire(); socket.destroy(); }); socket.on("error", () => socket.destroy());
    socket.on("data", chunk => {
      try { buffer += decoder.decode(chunk, { stream: true }); } catch { socket.destroy(); return; }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); let message: Record<string, unknown>;
        try { const value = decodeNativeAuthLine(line); if (!value || typeof value !== "object" || Array.isArray(value)) throw nativeAuthError("native_auth_outer_frame_invalid"); message = value as Record<string, unknown>; } catch { socket.destroy(); return; }
        if (exactKeys(message, ["completion"])) {
          const requestId = (message.completion as { body?: { requestId?: unknown } })?.body?.requestId;
          const waiting = typeof requestId === "string" ? reverse.pending.get(requestId) : undefined;
          if (!waiting || auth.authenticatedPeerIdentity(peer) !== waiting.identity) { socket.destroy(); return; }
          try { if ((message.completion as { body?: { domain?: unknown } })?.body?.domain !== waiting.replyDomain) throw nativeAuthError("native_auth_checkpoint_reply_invalid"); const result = waiting.serviceObservation ? auth.serviceObservationReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : waiting.ingressNoStart ? auth.ingressNoStartReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : waiting.lane === "terminal" ? auth.terminalCheckpointReply(peer, waiting.capability!, message.completion, requestId as string, waiting.sequence, waiting.request!) : auth.checkpointReply(peer, message.completion, requestId as string, waiting.sequence); reverse.pending.delete(requestId as string); clearTimeout(waiting.timer); waiting.resolve(result); }
          catch (error) { reverse.pending.delete(requestId as string); clearTimeout(waiting.timer); waiting.reject(error); if (!["native_checkpoint_failed", "native_checkpoint_unavailable"].includes(errorCode(error))) { socket.destroy(); return; } }
          continue;
        }
        if (!exactKeys(message, ["id", "method", "params"]) || !Number.isSafeInteger(message.id) || Number(message.id) < 1) { socket.destroy(); return; }
        if (message.method === "native.auth.hello" || message.method === "native.auth.proof") { try { const result = message.method === "native.auth.hello" ? auth.challenge(peer, message.params) : auth.authenticate(peer, message.params); if (message.method === "native.auth.proof") socket.setTimeout(0); send({ id: message.id, result }); } catch (e) { send({ id: message.id, error: errorCode(e) }); socket.end(); } continue; }
        let request: ReturnType<typeof auth.authorize>;
        try { if (message.method !== "native.auth.request") throw nativeAuthError("native_auth_method_denied"); request = auth.authorize(peer, message.params); } catch (e) { send({ id: message.id, error: errorCode(e) }); socket.end(); continue; }
        const cancel = request.method === "invoke.cancel";
        if (!methods.has(request.method) || (cancel ? cancelInFlight >= 2 : inFlight >= 8)) { send({ id: message.id, result: auth.reply(peer, request.sequence, null, "native_auth_dispatch_denied") }); continue; }
        cancel ? cancelInFlight++ : inFlight++;
        const task = Promise.resolve().then(() => options.handle(request.method, request.params, peer)).then(result => { if (!socket.destroyed) send({ id: message.id, result: auth.reply(peer, request.sequence, result ?? null) }); }).catch(e => { if (!socket.destroyed) send({ id: message.id, result: auth.reply(peer, request.sequence, null, errorCode(e)) }); }).finally(() => { cancel ? cancelInFlight-- : inFlight--; tasks.delete(task); }); tasks.add(task);
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) socket.destroy();
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(bindAddress, resolve); }); if (privateDir) { fs.chmodSync(bindAddress, 0o600); const s = fs.lstatSync(bindAddress); identity = { dev: s.dev, ino: s.ino }; fs.linkSync(bindAddress, options.address); } } catch (e) { for (const s of sockets) s.destroy(); await new Promise<void>(r => server.close(() => r())); if (privateDir) { try { fs.rmdirSync(privateDir); } catch {} } throw e; }
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
export async function connectNativeGuiChannel(options: { address: string; binding: NativeAuthBinding; credential: NativeCredential; bootId: string; onEvent?: (method: string, params: unknown) => void; onRequest?: (method: "native.checkpoint", params: unknown, identity: NativeAuthenticatedIdentity) => Promise<unknown> | unknown }) {
  const auth = createNativeGuiAuthenticator(options.binding, options.credential, options.bootId), socket = net.connect(options.address);
  let nativeChannel: object | undefined;
  let buffer = "", id = 0, done = false, ordinary = 0, cancel = 0, callbackCount = 0, terminalCallbackCount = 0, completionWrites = 0, ordinaryCompletionWrites = 0, terminalCompletionWrites = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true }), closeListeners = new Set<() => void>();
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer: ReturnType<typeof setTimeout>; lane: "ordinary" | "cancel" }>();
  const completions: Array<{ prepare: () => unknown; terminal: boolean }> = [];
  const close = () => {
    if (done) return; done = true; auth.close(); socket.destroy(); buffer = ""; completions.length = 0;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(nativeAuthError("native_auth_channel_lost")); } pending.clear(); ordinary = cancel = 0;
    for (const listener of closeListeners) { try { listener(); } catch {} } closeListeners.clear();
  };
  const write = (value: unknown, callback?: () => void) => {
    if (done || socket.destroyed || !socket.writable) throw nativeAuthError("native_auth_channel_lost");
    const wire = nativeAuthCanonical(value) + "\n";
    if (Buffer.byteLength(wire) - 1 > MAX_BYTES || socket.writableLength + Buffer.byteLength(wire) > MAX_BYTES * 2) throw nativeAuthError("native_auth_frame_limit");
    // false means queued under backpressure, never evidence that the frame was not sent.
    socket.write(wire, callback);
  };
  const flushCompletions = () => {
    while (!done && completionWrites < 2 && completions.length) {
      const next = completions.shift()!; completionWrites++; next.terminal ? terminalCompletionWrites++ : ordinaryCompletionWrites++;
      try { write({ completion: next.prepare() }, () => { completionWrites--; next.terminal ? terminalCompletionWrites-- : ordinaryCompletionWrites--; flushCompletions(); }); } catch { close(); return; }
    }
  };
  socket.on("error", close); socket.on("close", close); socket.on("end", close); socket.on("data", chunk => {
    try { buffer += decoder.decode(chunk, { stream: true }); } catch { close(); return; }
    let n: number;
    while ((n = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); let value: unknown;
      try { value = decodeNativeAuthLine(line); } catch { close(); return; }
      if (!value || typeof value !== "object" || Array.isArray(value)) { close(); return; } const message = value as Record<string, unknown>;
      if (exactKeys(message, ["event"])) { try { const event = auth.event(message.event); options.onEvent?.(event.method, event.params); } catch { close(); return; } continue; }
      if (exactKeys(message, ["callback"])) {
        try {
          const incoming = auth.checkpoint(message.callback), captured = auth.authenticatedIdentity();
          const terminal = incoming.terminal, queued = completions.filter(c => c.terminal === terminal).length;
          if (terminal ? terminalCallbackCount + terminalCompletionWrites + queued >= 2 : callbackCount + ordinaryCompletionWrites + queued >= 8) throw nativeAuthError("native_auth_checkpoint_busy");
          if (!captured) throw nativeAuthError("native_auth_checkpoint_unenrolled");
          if (incoming.ingressNoStart) { if (!nativeChannel || !incoming.params || typeof incoming.params !== "object") throw nativeAuthError("native_auth_ingress_observation_required"); guiIngressObservations.set(incoming.params, { channel: nativeChannel, identity: captured, proof: incoming.ingressNoStart }); }
          if (incoming.serviceObservation) { if (!nativeChannel || !incoming.params || typeof incoming.params !== "object") throw nativeAuthError("native_auth_service_observation_required"); guiServiceObservations.set(incoming.params, { channel: nativeChannel, identity: captured, proof: incoming.serviceObservation }); }
          terminal ? terminalCallbackCount++ : callbackCount++;
          Promise.resolve().then(() => { if (done || auth.authenticatedIdentity() !== captured) throw nativeAuthError("native_auth_channel_lost"); if (!options.onRequest) throw nativeAuthError("native_checkpoint_unavailable"); return options.onRequest(incoming.method, incoming.params, captured); }).then(result => {
            if (done || auth.authenticatedIdentity() !== captured) return;
            completions.push({ prepare: () => incoming.complete(result ?? null), terminal }); flushCompletions();
          }, () => { if (done || auth.authenticatedIdentity() !== captured) return; completions.push({ prepare: () => incoming.complete(null, "native_checkpoint_failed"), terminal }); flushCompletions(); }).finally(() => { if (incoming.params && typeof incoming.params === "object") guiIngressObservations.delete(incoming.params); if (incoming.params && typeof incoming.params === "object") guiServiceObservations.delete(incoming.params); terminal ? terminalCallbackCount-- : callbackCount--; });
        } catch { close(); return; } continue;
      }
      if (!Number.isSafeInteger(message.id) || Number(message.id) < 1) { close(); return; }
      const requestId = Number(message.id), waiting = pending.get(requestId); if (!waiting) { close(); return; }
      pending.delete(requestId); clearTimeout(waiting.timer); waiting.lane === "cancel" ? cancel-- : ordinary--;
      if (exactKeys(message, ["id", "result"])) waiting.resolve(message.result);
      else { waiting.reject(nativeAuthError("native_auth_unsigned_error")); close(); return; }
    }
    if (Buffer.byteLength(buffer) > MAX_BYTES) close();
  });
  const call = (method: string, prepare: () => unknown, lane: "ordinary" | "cancel" = "ordinary"): Promise<unknown> => {
    // Reserve before signing. Known local capacity refusal must not consume a signed sequence.
    if (done || socket.destroyed || !socket.writable || (lane === "cancel" ? cancel >= 2 : ordinary >= 32) || id >= Number.MAX_SAFE_INTEGER - 1) return Promise.reject(nativeAuthError("native_auth_channel_closed_or_busy"));
    const requestId = ++id; lane === "cancel" ? cancel++ : ordinary++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(close, 10000); pending.set(requestId, { resolve, reject, timer, lane });
      try { write({ id: requestId, method, params: prepare() }); }
      catch (error) { pending.delete(requestId); clearTimeout(timer); lane === "cancel" ? cancel-- : ordinary--; reject(error); close(); } // Preserve the original diagnostic; signing/write uncertainty never rolls back or retries.
    });
  };
  try { const challenge = await call("native.auth.hello", () => auth.hello); auth.accept(await call("native.auth.proof", () => auth.proof(challenge))); } catch (error) { close(); throw error; }
  const channel = {
    /** Native-only; the integration must still validate captured admission/capsule authority. */
    async dispatch(method: string, params: unknown): Promise<unknown> {
      if (!methods.has(method)) throw nativeAuthError("native_auth_method_denied"); let sequence = 0;
      const result = await call("native.auth.request", () => { const frame = auth.request(method, params); sequence = frame.sequence; return frame.envelope; }, method === "invoke.cancel" ? "cancel" : "ordinary");
      try { return auth.reply(result, sequence); } catch (error) { if (["native_auth_reply_invalid", "native_auth_signature_invalid"].includes(errorCode(error))) close(); throw error; }
    },
    onClose(listener: () => void): () => void { if (done) { listener(); return () => {}; } closeListeners.add(listener); return () => { closeListeners.delete(listener); }; }, close,
  };
  nativeChannel = channel; guiChannelIdentities.set(channel, () => done || socket.destroyed ? undefined : auth.authenticatedIdentity());
  return channel;
}
