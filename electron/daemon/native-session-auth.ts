import { randomBytes } from "node:crypto";
import { nativeStartDescriptor, sameNativeStartBinding, type NativeStartDescriptor, type NativePreparationWireRequest } from "./native-start-protocol";
import type { ControlSocketPeer } from "./control-socket";
import { assertNativeAuthBinding, createNativeServiceObservationSigner, validateNativeServiceObservation, validateNativeServiceObservationRequest, type NativeServiceObservation, createNativeIngressNoStartSigner, validateNativeIngressNoStartObservation, validateNativeIngressNoStartRequest, type NativeIngressNoStartObservation, createNativeTerminalAuthSigner, validateNativeTerminalPreparationRequest, nativeAuthCanonical, nativeAuthError, signNativeAuthFrame, verifyNativeAuthFrame, type NativeAuthBinding, type NativeCredential } from "./native-auth-credentials";
const nonce = () => randomBytes(32).toString("hex");
function denied(code: string): never { throw nativeAuthError(code); }
const exact = (value: unknown, fields: readonly string[]): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort(), expected = [...fields].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const bootValid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
type Transcript = Record<string, unknown> & { scope: string; generation: string; serviceIdentity: string; bootId: string; connection: string; clientNonce: string; serverNonce: string };
export type NativeAuthenticatedIdentity = Readonly<{ scope: string; generation: string; serviceIdentity: string; bootId: string; connection: string }>;
function authenticatedIdentity(t: Transcript): NativeAuthenticatedIdentity { return Object.freeze({ scope: t.scope, generation: t.generation, serviceIdentity: t.serviceIdentity, bootId: t.bootId, connection: t.connection }); }
type PeerState = { identity?: NativeAuthenticatedIdentity; transcript: Transcript; active: boolean; sequence: number; eventSequence: number; callbackSequence: number; timer: ReturnType<typeof setTimeout>; release: () => void };
export function decodeNativeAuthLine(line: string): unknown {
  if (Buffer.byteLength(line) > 1048576) denied("native_auth_frame_limit");
  let value: unknown; try { value = JSON.parse(line); } catch { denied("native_auth_json_invalid"); }
  if (nativeAuthCanonical(value) !== line) denied("native_auth_noncanonical_json"); return value;
}
function credentialMatches(binding: NativeAuthBinding, key: NativeCredential, role: "gui" | "daemon"): void {
  assertNativeAuthBinding(binding); if (key.scope !== binding.scope || key.role !== role) denied("native_auth_role_mismatch");
}
function signature(key: NativeCredential, frame: Record<string, unknown>): { body: Record<string, unknown>; signature: string } { return { body: frame, signature: signNativeAuthFrame(key, frame) }; }
function verifyEnvelope(key: NativeCredential, envelope: unknown, body: Record<string, unknown>): void {
  if (!exact(envelope, ["body", "signature"]) || nativeAuthCanonical(envelope.body) !== nativeAuthCanonical(body) || !verifyNativeAuthFrame(key, body, envelope.signature)) denied("native_auth_signature_invalid");
}
/** Peer identity is the actual socket object; no JSON/PID/ownerKind authority. */
export type NativeTerminalCheckpointCapability = Readonly<{ __nativeTerminalCheckpoint?: never }>;
export type NativeIngressNoStartConsumer = (peer: ControlSocketPeer, start: NativeStartDescriptor, request: NativePreparationWireRequest, proof: unknown) => NativeIngressNoStartObservation;
export type NativeServiceObservationConsumer = (peer: ControlSocketPeer, start: NativeStartDescriptor, request: NativePreparationWireRequest, proof: unknown) => NativeServiceObservation;
export function createNativeDaemonAuthenticator(binding: NativeAuthBinding, key: NativeCredential, bootId: string, consumeIngressNoStartProof?: NativeIngressNoStartConsumer, consumeServiceObservationProof?: NativeServiceObservationConsumer) {
  credentialMatches(binding, key, "daemon"); if (!bootValid(bootId)) denied("native_auth_boot_invalid");
  const peers = new WeakMap<ControlSocketPeer, PeerState>(), held = new Set<ControlSocketPeer>();
  const ingressSigner = createNativeIngressNoStartSigner(key), serviceSigner = createNativeServiceObservationSigner(key);
  const terminalSigner = createNativeTerminalAuthSigner(key), terminalCapabilities = new WeakMap<NativeTerminalCheckpointCapability, { peer: ControlSocketPeer; identity: NativeAuthenticatedIdentity; start: NativeStartDescriptor }>();
  const close = (peer: ControlSocketPeer) => { const p = peers.get(peer); if (p) { peers.delete(peer); held.delete(peer); clearTimeout(p.timer); p.release(); } };
  return {
    challenge(peer: ControlSocketPeer, hello: unknown): unknown {
      if (held.size >= 64) denied("native_auth_peer_limit"); if (peers.has(peer)) denied("native_auth_challenge_reused");
      if (!exact(hello, ["scope", "generation", "serviceIdentity", "clientNonce"]) || hello.scope !== binding.scope || hello.generation !== key.generation || hello.serviceIdentity !== binding.serviceIdentity || !hex(hello.clientNonce)) denied("native_auth_scope_mismatch");
      const transcript = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: nonce(), clientNonce: hello.clientNonce, serverNonce: nonce() };
      const timer = setTimeout(() => close(peer), 5000); timer.unref();
      const p: PeerState = { transcript, sequence: 0, eventSequence: 0, callbackSequence: 0, active: false, timer, release: () => {} };
      peers.set(peer, p); held.add(peer);
      try {
        const release = peer.onClose(() => close(peer));
        if (peers.get(peer) !== p) { release(); denied("native_auth_peer_closed"); }
        p.release = release;
      } catch (error) { close(peer); throw error; }
      return signature(key, { ...transcript, domain: "agentlas.native.challenge.v1" });
    },
    authenticate(peer: ControlSocketPeer, proof: unknown): unknown {
      const p = peers.get(peer); if (!p || p.active) denied("native_auth_challenge_missing_or_used");
      verifyEnvelope(key, proof, { ...p.transcript, domain: "agentlas.native.proof.v1" }); p.active = true; p.identity = authenticatedIdentity(p.transcript); clearTimeout(p.timer);
      return signature(key, { ...p.transcript, domain: "agentlas.native.accept.v1" });
    },
    authorize(peer: ControlSocketPeer, envelope: unknown): { method: string; params: unknown; sequence: number } {
      const p = peers.get(peer); if (!p?.active) denied("native_auth_peer_unenrolled");
      if (!exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["domain", "scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "method", "params"])) denied("native_auth_frame_invalid");
      const b = envelope.body;
      if (b.domain !== "agentlas.native.request.v1" || b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== bootId || b.connection !== p.transcript.connection) denied("native_auth_request_scope_mismatch");
      if (!Number.isSafeInteger(b.sequence) || b.sequence !== p.sequence + 1 || Number(b.sequence) > Number.MAX_SAFE_INTEGER - 1) denied("native_auth_request_replay");
      if (typeof b.method !== "string" || !/^[a-zA-Z][a-zA-Z0-9_.]{1,79}$/.test(b.method)) denied("native_auth_method_invalid");
      nativeAuthCanonical(b); if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid");
      p.sequence = Number(b.sequence); return { method: b.method, params: b.params, sequence: p.sequence };
    },
    reply(peer: ControlSocketPeer, sequence: number, result: unknown, error: string | null = null): unknown {
      const p = peers.get(peer); if (!p?.active || !Number.isSafeInteger(sequence) || sequence < 1 || sequence > p.sequence) denied("native_auth_reply_invalid");
      return signature(key, { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, domain: "agentlas.native.reply.v1", result, error });
    },
    event(peer: ControlSocketPeer, method: string, params: unknown): unknown {
      const p = peers.get(peer); if (!p?.active || p.eventSequence >= Number.MAX_SAFE_INTEGER - 1 || !/^[a-zA-Z][a-zA-Z0-9_.]{1,79}$/.test(method)) denied("native_auth_event_invalid");
      const sequence = p.eventSequence + 1; const body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, domain: "agentlas.native.event.v1", method, params };
      nativeAuthCanonical(body); const envelope = signature(key, body); p.eventSequence = sequence; return envelope;
    },
    checkpoint(peer: ControlSocketPeer, requestId: string, params: unknown): { envelope: unknown; sequence: number } {
      const p = peers.get(peer); if (!p?.active || !hex(requestId) || p.callbackSequence >= Number.MAX_SAFE_INTEGER - 1) denied("native_auth_checkpoint_invalid");
      const sequence = p.callbackSequence + 1;
      const body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, requestId, direction: "daemon-to-gui", domain: "agentlas.native.checkpoint.v1", method: "native.checkpoint", params };
      nativeAuthCanonical(body); const envelope = signature(key, body); p.callbackSequence = sequence; return { envelope, sequence };
    },
    createTerminalCheckpointCapability(peer: ControlSocketPeer, start: NativeStartDescriptor): NativeTerminalCheckpointCapability {
      const p = peers.get(peer); if (!p?.active || !p.identity) denied("native_auth_checkpoint_unenrolled");
      const capability = Object.freeze({}); terminalCapabilities.set(capability, { peer, identity: p.identity, start: nativeStartDescriptor(start) }); return capability;
    },
    terminalCheckpoint(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, requestId: string, value: unknown): { envelope: unknown; sequence: number; request: NativePreparationWireRequest } {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !hex(requestId) || p.callbackSequence >= Number.MAX_SAFE_INTEGER - 1) denied("native_auth_terminal_capability_required");
      const request = validateNativeTerminalPreparationRequest(value);
      if (request.start.handle !== held.start.handle || !sameNativeStartBinding(request.start.binding, held.start.binding)) denied("native_auth_terminal_binding_changed");
      const sequence = p.callbackSequence + 1, body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, requestId, direction: "daemon-to-gui", domain: "agentlas.native.terminalCheckpoint.v1", method: "native.checkpoint", params: request };
      nativeAuthCanonical(body); const envelope = { body, signature: terminalSigner(body) }; p.callbackSequence = sequence; return { envelope, sequence, request };
    },
    ingressNoStartCheckpoint(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, requestId: string, value: unknown, opaqueProof: unknown): { envelope: unknown; sequence: number; request: NativePreparationWireRequest } {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !hex(requestId) || p.callbackSequence >= Number.MAX_SAFE_INTEGER - 1) denied("native_auth_terminal_capability_required");
      const request = validateNativeIngressNoStartRequest(value);
      if (request.start.handle !== held.start.handle || !sameNativeStartBinding(request.start.binding, held.start.binding)) denied("native_auth_terminal_binding_changed");
      const sequence = p.callbackSequence + 1, body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, requestId, direction: "daemon-to-gui", domain: "agentlas.native.ingressNoStart.v1", method: "native.checkpoint", params: request };
      nativeAuthCanonical(body); if (!consumeIngressNoStartProof) denied("native_auth_ingress_consumer_required");
      const proof = validateNativeIngressNoStartObservation(consumeIngressNoStartProof(peer, held.start, request, opaqueProof), request);
      if (peers.get(peer) !== p || !p.active || p.identity !== held.identity || p.callbackSequence !== sequence - 1) denied("native_auth_peer_changed");
      const attested = { ...body, proof }; nativeAuthCanonical(attested); const envelope = { body: attested, signature: ingressSigner(attested) }; p.callbackSequence = sequence; return { envelope, sequence, request };
    },
    ingressNoStartReply(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, envelope: unknown, requestId: string, sequence: number, request: NativePreparationWireRequest): unknown {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"])) denied("native_auth_terminal_reply_invalid");
      const b = envelope.body, start = nativeStartDescriptor(b.start);
      if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== bootId || b.connection !== p.transcript.connection || b.requestId !== requestId || b.sequence !== sequence || b.direction !== "gui-to-daemon" || b.domain !== "agentlas.native.ingressNoStartReply.v1" || b.nonce !== request.requestId || start.handle !== held.start.handle || !sameNativeStartBinding(start.binding, held.start.binding) || !(b.error === null || typeof b.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(b.error))) denied("native_auth_terminal_reply_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); if (b.error) throw nativeAuthError(b.error); return b.result;
    },
    serviceObservationCheckpoint(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, requestId: string, value: unknown, opaqueProof: unknown): { envelope: unknown; sequence: number; request: NativePreparationWireRequest } {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !hex(requestId) || p.callbackSequence >= Number.MAX_SAFE_INTEGER - 1) denied("native_auth_terminal_capability_required");
      const request = validateNativeServiceObservationRequest(value);
      if (request.start.handle !== held.start.handle || !sameNativeStartBinding(request.start.binding, held.start.binding)) denied("native_auth_terminal_binding_changed");
      const sequence = p.callbackSequence + 1, body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId, connection: p.transcript.connection, sequence, requestId, direction: "daemon-to-gui", domain: "agentlas.native.serviceObservation.v1", method: "native.checkpoint", params: request };
      nativeAuthCanonical(body); if (!consumeServiceObservationProof) denied("native_auth_service_consumer_required");
      const proof = validateNativeServiceObservation(consumeServiceObservationProof(peer, held.start, request, opaqueProof), request);
      if (peers.get(peer) !== p || !p.active || p.identity !== held.identity || p.callbackSequence !== sequence - 1) denied("native_auth_peer_changed");
      const attested = { ...body, proof }; nativeAuthCanonical(attested); const envelope = { body: attested, signature: serviceSigner(attested) }; p.callbackSequence = sequence; return { envelope, sequence, request };
    },
    serviceObservationReply(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, envelope: unknown, requestId: string, sequence: number, request: NativePreparationWireRequest): unknown {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"])) denied("native_auth_terminal_reply_invalid");
      const b = envelope.body, start = nativeStartDescriptor(b.start);
      if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== bootId || b.connection !== p.transcript.connection || b.requestId !== requestId || b.sequence !== sequence || b.direction !== "gui-to-daemon" || b.domain !== "agentlas.native.serviceObservationReply.v1" || b.nonce !== request.requestId || start.handle !== held.start.handle || !sameNativeStartBinding(start.binding, held.start.binding) || !(b.error === null || typeof b.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(b.error))) denied("native_auth_terminal_reply_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); if (b.error) throw nativeAuthError(b.error); return b.result;
    },
    terminalCheckpointReply(peer: ControlSocketPeer, capability: NativeTerminalCheckpointCapability, envelope: unknown, requestId: string, sequence: number, request: NativePreparationWireRequest): unknown {
      const held = terminalCapabilities.get(capability), p = peers.get(peer);
      if (!held || held.peer !== peer || !p?.active || p.identity !== held.identity || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error", "start", "nonce"])) denied("native_auth_terminal_reply_invalid");
      const b = envelope.body, start = nativeStartDescriptor(b.start);
      if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== bootId || b.connection !== p.transcript.connection || b.requestId !== requestId || b.sequence !== sequence || b.direction !== "gui-to-daemon" || b.domain !== "agentlas.native.terminalCheckpointReply.v1" || b.nonce !== request.requestId || start.handle !== held.start.handle || !sameNativeStartBinding(start.binding, held.start.binding) || !(b.error === null || typeof b.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(b.error))) denied("native_auth_terminal_reply_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); if (b.error) throw nativeAuthError(b.error); return b.result;
    },
    checkpointReply(peer: ControlSocketPeer, envelope: unknown, requestId: string, sequence: number): unknown {
      const p = peers.get(peer); if (!p?.active || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "result", "error"])) denied("native_auth_checkpoint_reply_invalid");
      const b = envelope.body;
      if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== bootId || b.connection !== p.transcript.connection || b.requestId !== requestId || b.sequence !== sequence || b.direction !== "gui-to-daemon" || b.domain !== "agentlas.native.checkpointReply.v1" || !(b.error === null || typeof b.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(b.error))) denied("native_auth_checkpoint_reply_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); if (b.error) throw nativeAuthError(b.error); return b.result;
    },
    authenticatedPeerIdentity(peer: ControlSocketPeer): NativeAuthenticatedIdentity | undefined { const p = peers.get(peer); return p?.active ? p.identity : undefined; },
    close,
    shutdown(): void { for (const peer of [...held]) close(peer); },
    get activePeerCount(): number { return held.size; },
  };
}
/** Native Main holds this closure; caller only receives signed protocol frames,
 * never signing keys. No renderer/env/MCP payload creates its credential. */
export function createNativeGuiAuthenticator(binding: NativeAuthBinding, key: NativeCredential, expectedBootId: string) {
  credentialMatches(binding, key, "gui"); if (!bootValid(expectedBootId)) denied("native_auth_boot_invalid");
  const clientNonce = nonce(); let transcript: Transcript | null = null, active = false, sequence = 0, eventSequence = 0, callbackSequence = 0; let identity: NativeAuthenticatedIdentity | undefined;
  const terminalSigner = createNativeTerminalAuthSigner(key), ingressSigner = createNativeIngressNoStartSigner(key), serviceSigner = createNativeServiceObservationSigner(key);
  return {
    hello: { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, clientNonce },
    proof(envelope: unknown): unknown {
      if (transcript || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["domain", "scope", "generation", "serviceIdentity", "bootId", "connection", "clientNonce", "serverNonce"])) denied("native_auth_challenge_invalid");
      const b = envelope.body;
      if (b.domain !== "agentlas.native.challenge.v1" || b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== expectedBootId || b.clientNonce !== clientNonce || !hex(b.connection) || !hex(b.serverNonce)) denied("native_auth_scope_mismatch");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid");
      transcript = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId: expectedBootId, clientNonce, connection: b.connection, serverNonce: b.serverNonce };
      return signature(key, { ...transcript, domain: "agentlas.native.proof.v1" });
    },
    accept(envelope: unknown): void { if (!transcript || active) denied("native_auth_accept_invalid"); verifyEnvelope(key, envelope, { ...transcript, domain: "agentlas.native.accept.v1" }); active = true; identity = authenticatedIdentity(transcript); },
    request(method: string, params: unknown): { envelope: unknown; sequence: number } {
      if (!active || !transcript || sequence >= Number.MAX_SAFE_INTEGER - 1) denied("native_auth_client_closed");
      const body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId: expectedBootId, connection: transcript.connection, sequence: sequence + 1, domain: "agentlas.native.request.v1", method, params };
      nativeAuthCanonical(body); const envelope = signature(key, body); sequence++; return { envelope, sequence };
    },
    reply(envelope: unknown, expectedSequence: number): unknown {
      if (!active || !transcript || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "domain", "result", "error"])) denied("native_auth_reply_invalid");
      const b = envelope.body; if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== expectedBootId || b.connection !== transcript.connection || b.sequence !== expectedSequence || b.domain !== "agentlas.native.reply.v1" || !(b.error === null || typeof b.error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(b.error))) denied("native_auth_reply_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); if (b.error) throw nativeAuthError(b.error); return b.result;
    },
    event(envelope: unknown): { method: string; params: unknown } {
      if (!active || !transcript || !exact(envelope, ["body", "signature"]) || !exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "domain", "method", "params"])) denied("native_auth_event_invalid");
      const b = envelope.body; if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== expectedBootId || b.connection !== transcript.connection || b.sequence !== eventSequence + 1 || b.domain !== "agentlas.native.event.v1" || typeof b.method !== "string") denied("native_auth_event_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); eventSequence++; return { method: b.method, params: b.params };
    },
    checkpoint(envelope: unknown): { requestId: string; method: "native.checkpoint"; params: unknown; terminal: boolean; ingressNoStart?: NativeIngressNoStartObservation; serviceObservation?: NativeServiceObservation; complete(result: unknown, error?: string | null): unknown } {
      if (!active || !transcript || !exact(envelope, ["body", "signature"]) || !(exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "method", "params"]) || exact(envelope.body, ["scope", "generation", "serviceIdentity", "bootId", "connection", "sequence", "requestId", "direction", "domain", "method", "params", "proof"]) && (envelope.body.domain === "agentlas.native.ingressNoStart.v1" || envelope.body.domain === "agentlas.native.serviceObservation.v1"))) denied("native_auth_checkpoint_invalid");
      const b = envelope.body;
      if (b.scope !== binding.scope || b.generation !== key.generation || b.serviceIdentity !== binding.serviceIdentity || b.bootId !== expectedBootId || b.connection !== transcript.connection || b.sequence !== callbackSequence + 1 || !Number.isSafeInteger(b.sequence) || !hex(b.requestId) || b.direction !== "daemon-to-gui" || !(b.domain === "agentlas.native.checkpoint.v1" || b.domain === "agentlas.native.terminalCheckpoint.v1" || b.domain === "agentlas.native.ingressNoStart.v1" || b.domain === "agentlas.native.serviceObservation.v1") || b.method !== "native.checkpoint") denied("native_auth_checkpoint_invalid");
      if (!verifyNativeAuthFrame(key, b, envelope.signature)) denied("native_auth_signature_invalid"); const attested = b.domain === "agentlas.native.ingressNoStart.v1", observed = b.domain === "agentlas.native.serviceObservation.v1", request = observed ? validateNativeServiceObservationRequest(b.params) : attested ? validateNativeIngressNoStartRequest(b.params) : b.domain === "agentlas.native.terminalCheckpoint.v1" ? validateNativeTerminalPreparationRequest(b.params) : undefined; const ingressNoStart = attested ? validateNativeIngressNoStartObservation(b.proof, request!) : undefined, serviceObservation = observed ? validateNativeServiceObservation(b.proof, request!) : undefined, terminal = attested || b.domain === "agentlas.native.terminalCheckpoint.v1" || serviceObservation?.kind === "native-undispatched-start-v1"; callbackSequence++; const captured = transcript; let used = false;
      return { requestId: b.requestId, method: "native.checkpoint", params: b.params, terminal, ...(ingressNoStart ? { ingressNoStart } : {}), ...(serviceObservation ? { serviceObservation } : {}), complete(result, error = null): unknown {
        if (used || !active || transcript !== captured || !(error === null || typeof error === "string" && /^[a-z][a-z0-9_]{1,99}$/.test(error))) denied("native_auth_checkpoint_reply_invalid");
        const body = { scope: binding.scope, generation: key.generation, serviceIdentity: binding.serviceIdentity, bootId: expectedBootId, connection: captured.connection, sequence: b.sequence, requestId: b.requestId, direction: "gui-to-daemon", domain: observed ? "agentlas.native.serviceObservationReply.v1" : attested ? "agentlas.native.ingressNoStartReply.v1" : terminal ? "agentlas.native.terminalCheckpointReply.v1" : "agentlas.native.checkpointReply.v1", result, error, ...(request ? { start: request.start, nonce: request.requestId } : {}) };
        nativeAuthCanonical(body); const reply = observed ? { body, signature: serviceSigner(body) } : attested ? { body, signature: ingressSigner(body) } : terminal ? { body, signature: terminalSigner(body) } : signature(key, body); used = true; return reply;
      } };
    },
    authenticatedIdentity(): NativeAuthenticatedIdentity | undefined { return active ? identity : undefined; },
    close(): void { active = false; transcript = null; identity = undefined; },
  };
}
