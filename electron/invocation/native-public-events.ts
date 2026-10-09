import { createHash, randomBytes } from "node:crypto";
import type { McpInvocationEvent, InvocationRunReceipt } from "../../shared/types";
import type { InvocationService, InvocationEventEnvelope, InvocationSettledEnvelope } from "./service";
import type { NativeAuthenticatedIdentity } from "../daemon/native-session-auth";
export const NATIVE_PUBLIC_EVENT_READY = "invocation.public.ready";
export const NATIVE_PUBLIC_EVENT_READ = "invocation.public.read";
export const NATIVE_PUBLIC_EVENT_ACK = "invocation.public.ack";
export const NATIVE_PUBLIC_EVENT_CHUNK_BYTES = 98304;
const VERSION = "agentlas.native-public-event.v1";
const EVENT_KEYS = ["delivery", "kind", "sequence", "observedAt", "durableMessageId", "goalResult", "lifecycle", "status", "activity", "text", "userDecisionRequest", "imageDataUrls", "delta", "textLen", "error", "notice", "surfaceId", "surface", "oneSurface", "oneArtifacts", "oneFriendlyFollowups", "tool", "keyRequest", "tokens", "observedUsage", "reasoning", "agentId", "runtimeAgentId", "agentName", "role", "modelRole", "tier", "phase", "delegateTo", "done", "model", "observedModel", "runtimeSelection", "agentMessage", "agentLifecycle", "nodeId", "nodeState"] as const satisfies readonly (keyof McpInvocationEvent)[];
const RECEIPT_KEYS = ["runId", "chatId", "status", "startedAt", "updatedAt", "finishedAt", "eventCount", "resultFolder", "hasImages", "borrowAgents", "taskForceTargets", "model", "errorCode", "errorMessage", "runtimeFailure", "executionPermission", "steeringRecovery", "interruptionCause", "hostStopCause"] as const satisfies readonly (keyof InvocationRunReceipt)[];
const SETTLED_KEYS = ["runId", "chatId", "agentId", "receipt", "oneMode", "pendingQuestion", "browserLoginWaiting", "userDecisionRequest"] as const;
const KINDS = new Set(["lifecycle", "thinking", "tool-use", "partial", "final", "error", "surface", "usage", "reasoning", "mcp-key-request", "notice"]);
export type NativePublicSettlement = Omit<InvocationSettledEnvelope, "goal" | "workspaceBinding">;
type PublicValue = {
    version: typeof VERSION;
    kind: "event";
    value: {
        runId: string;
        chatId: string;
        event: McpInvocationEvent;
    };
} | {
    version: typeof VERSION;
    kind: "activeChats";
    value: string[];
} | {
    version: typeof VERSION;
    kind: "settled";
    value: NativePublicSettlement;
};
export interface NativePublicDescriptor {
    version: typeof VERSION;
    stream: string;
    sequence: number;
    bytes: number;
    sha256: string;
}
export interface NativePublicReadRequest {
    version: typeof VERSION;
    stream: string;
    sequence: number;
    offset: number;
}
export interface NativePublicChunk extends NativePublicReadRequest {
    data: string;
    eof: boolean;
}
export interface NativePublicAck {
    version: typeof VERSION;
    stream: string;
    sequence: number;
    sha256: string;
}
export class NativePublicEventError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.name = "NativePublicEventError"; this.code = code; }
}
function fail(code: string): never { throw new NativePublicEventError(code); }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function record(v: unknown): v is Record<string, unknown> { return !!v && typeof v === "object" && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null); }
function exact(v: unknown, keys: readonly string[]): v is Record<string, unknown> { if (!record(v))
    return false; const actual = Object.keys(v).sort(), expected = [...keys].sort(); return actual.length === expected.length && actual.every((k, i) => k === expected[i]); }
function pick<T>(value: T, keys: readonly string[]): T { if (!record(value))
    fail("native_public_projection_invalid"); const out: Record<string, unknown> = {}; for (const key of keys)
    if (Object.hasOwn(value as object, key) && (value as Record<string, unknown>)[key] !== undefined)
        out[key] = (value as Record<string, unknown>)[key]; return out as T; }
function bounded(value: number, code: string): number { if (!Number.isSafeInteger(value) || value < 1)
    fail(code); return value; }
function id(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function descriptor(v: unknown): NativePublicDescriptor { if (!exact(v, ["version", "stream", "sequence", "bytes", "sha256"]) || v.version !== VERSION || typeof v.stream !== "string" || !/^[a-f0-9]{64}$/.test(v.stream) || !Number.isSafeInteger(v.sequence) || Number(v.sequence) < 1 || !Number.isSafeInteger(v.bytes) || Number(v.bytes) < 1 || typeof v.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(v.sha256))
    fail("native_public_descriptor_invalid"); return v as unknown as NativePublicDescriptor; }
function validate(value: unknown): PublicValue {
    if (!exact(value, ["version", "kind", "value"]) || value.version !== VERSION)
        fail("native_public_payload_invalid");
    if (value.kind === "event") {
        const v = value.value;
        if (!exact(v, ["runId", "chatId", "event"]) || !id(v.runId) || !id(v.chatId) || !record(v.event) || !KINDS.has(String(v.event.kind)) || Object.keys(v.event).some(k => !EVENT_KEYS.includes(k as typeof EVENT_KEYS[number])))
            fail("native_public_event_invalid");
    }
    else if (value.kind === "activeChats") {
        if (!Array.isArray(value.value) || !value.value.every(id) || new Set(value.value).size !== value.value.length)
            fail("native_public_active_invalid");
    }
    else if (value.kind === "settled") {
        const v = value.value;
        if (!record(v) || Object.keys(v).some(k => !SETTLED_KEYS.includes(k as typeof SETTLED_KEYS[number])) || !id(v.runId) || !id(v.chatId) || typeof v.oneMode !== "boolean" || !record(v.receipt) || v.receipt.runId !== v.runId || v.receipt.chatId !== v.chatId || !["waiting_input", "completed", "failed", "cancelled", "interrupted"].includes(String(v.receipt.status)) || Object.keys(v.receipt).some(k => !RECEIPT_KEYS.includes(k as typeof RECEIPT_KEYS[number])))
            fail("native_public_settled_invalid");
    }
    else
        fail("native_public_payload_kind_invalid");
    return value as unknown as PublicValue;
}
/** One genuine authenticated peer owns one non-replayable subscription and process-local queue. */
export function createNativeInvocationPublicPublisher(options: {
    service: Pick<InvocationService, "onEvent" | "onActiveChats" | "onSettled" | "activeChatIds">;
    identity: NativeAuthenticatedIdentity;
    getIdentity(): NativeAuthenticatedIdentity | null;
    notify(method: typeof NATIVE_PUBLIC_EVENT_READY, descriptor: NativePublicDescriptor): boolean;
    acceptsRun(runId: string, chatId: string): boolean;
    acceptsChat(chatId: string): boolean;
    maxRetainedBytes: number;
    maxItems: number;
    onFault(error: NativePublicEventError): void;
}) {
    const capacity = bounded(options.maxRetainedBytes, "native_public_capacity_invalid"), maxItems = bounded(options.maxItems, "native_public_capacity_invalid"), stream = randomBytes(32).toString("hex");
    type Item = {
        descriptor: NativePublicDescriptor;
        bytes: Buffer;
        releaseObservation?: string;
    };
    const queue: Item[] = [];
    const observedRuns = new Map<string, string>();
    let retainedBytes = 0, observationBytes = 0, sequence = 0, available = true, announced = false;
    const releases: Array<() => void> = [];
    const current = () => { if (!available || options.getIdentity() !== options.identity)
        fail("native_public_identity_changed"); };
    const close = (error?: NativePublicEventError) => { if (!available)
        return; available = false; for (const release of releases.splice(0))
        release(); queue.length = 0; observedRuns.clear(); retainedBytes = 0; observationBytes = 0; if (error)
        options.onFault(error); };
    const announce = () => { current(); if (!announced && queue.length) {
        announced = true;
        if (!options.notify(NATIVE_PUBLIC_EVENT_READY, queue[0].descriptor))
            fail("native_public_channel_unavailable");
    } };
    const publish = (value: PublicValue) => { if (!available)
        return; try {
        current();
        const bytes = Buffer.from(JSON.stringify(validate(value)), "utf8");
        if (bytes.length > capacity - retainedBytes - observationBytes || queue.length >= maxItems || sequence >= Number.MAX_SAFE_INTEGER - 1)
            fail("native_public_capacity_exhausted");
        const d = Object.freeze({ version: VERSION, stream, sequence: ++sequence, bytes: bytes.length, sha256: hash(bytes) });
        queue.push({ descriptor: d, bytes, ...(value.kind === "settled" ? { releaseObservation: value.value.runId } : {}) });
        retainedBytes += bytes.length;
        announce();
    }
    catch (e) {
        close(e instanceof NativePublicEventError ? e : new NativePublicEventError("native_public_projection_invalid"));
    } };
    // Observation associations are not control/lease custody. Native physical release
    // precedes publishSettled; retain only a source-observed pair until settled ACK.
    const event = (e: InvocationEventEnvelope) => {
        if (!available) return;
        try {
            const prior = observedRuns.get(e.runId);
            if (prior !== undefined && prior !== e.chatId) fail("native_public_run_binding_changed");
            if (prior === undefined) {
                if (!options.acceptsRun(e.runId, e.chatId)) return;
                const bindingBytes = Buffer.byteLength(e.runId) + Buffer.byteLength(e.chatId);
                if (observedRuns.size >= maxItems || bindingBytes > capacity - retainedBytes - observationBytes) fail("native_public_capacity_exhausted");
                observedRuns.set(e.runId, e.chatId);
                observationBytes += bindingBytes;
            }
            publish({ version: VERSION, kind: "event", value: { runId: e.runId, chatId: e.chatId, event: pick(e.event, EVENT_KEYS) } });
        } catch (e) { close(e instanceof NativePublicEventError ? e : new NativePublicEventError("native_public_projection_invalid")); }
    };
    const active = (chatIds: string[]) => publish({ version: VERSION, kind: "activeChats", value: chatIds.filter(options.acceptsChat) });
    const settled = (e: InvocationSettledEnvelope) => { if (observedRuns.get(e.runId) === e.chatId) {
        const value = pick(e, SETTLED_KEYS) as NativePublicSettlement;
        value.receipt = pick(e.receipt, RECEIPT_KEYS);
        publish({ version: VERSION, kind: "settled", value });
    } };
    releases.push(options.service.onEvent(event), options.service.onActiveChats(active), options.service.onSettled(settled));
    active(options.service.activeChatIds());
    return {
        read(identity: NativeAuthenticatedIdentity, input: unknown): NativePublicChunk { current(); if (identity !== options.identity)
            fail("native_public_identity_changed"); if (!exact(input, ["version", "stream", "sequence", "offset"]) || input.version !== VERSION || input.stream !== stream || !Number.isSafeInteger(input.offset) || Number(input.offset) < 0)
            fail("native_public_read_invalid"); const item = queue[0]; if (!item || input.sequence !== item.descriptor.sequence || Number(input.offset) >= item.bytes.length || Number(input.offset) % NATIVE_PUBLIC_EVENT_CHUNK_BYTES !== 0)
            fail("native_public_read_sequence"); const offset = Number(input.offset), end = Math.min(item.bytes.length, offset + NATIVE_PUBLIC_EVENT_CHUNK_BYTES); return { version: VERSION, stream, sequence: item.descriptor.sequence, offset, data: item.bytes.subarray(offset, end).toString("base64"), eof: end === item.bytes.length }; },
        ack(identity: NativeAuthenticatedIdentity, input: unknown): void { current(); if (identity !== options.identity)
            fail("native_public_identity_changed"); const item = queue[0]; if (!exact(input, ["version", "stream", "sequence", "sha256"]) || input.version !== VERSION || input.stream !== stream || !item || input.sequence !== item.descriptor.sequence || input.sha256 !== item.descriptor.sha256)
            fail("native_public_ack_invalid"); queue.shift(); if (item.releaseObservation) { const chatId = observedRuns.get(item.releaseObservation); if (chatId !== undefined) observationBytes -= Buffer.byteLength(item.releaseObservation) + Buffer.byteLength(chatId); observedRuns.delete(item.releaseObservation); } retainedBytes -= item.bytes.length; announced = false; announce(); },
        dispose: () => close(), get available() { return available && options.getIdentity() === options.identity; }, get retainedBytes() { return retainedBytes; }, get pendingItems() { return queue.length; }, get observationBytes() { return observationBytes; },
    };
}
/** Feed only authenticated native channel notifications. Identity is the actual captured local object. */
export function createNativeInvocationPublicReceiver(options: {
    identity: NativeAuthenticatedIdentity;
    getIdentity(): NativeAuthenticatedIdentity | null;
    maxRetainedBytes: number;
    read(input: NativePublicReadRequest): Promise<unknown>;
    ack(input: NativePublicAck): Promise<unknown>;
    onEvent(envelope: Pick<InvocationEventEnvelope, "runId" | "chatId" | "event">): void;
    onActiveChats(chatIds: string[]): void;
    onSettled(envelope: NativePublicSettlement): void;
    onFault(error: NativePublicEventError): void;
}) {
    const capacity = bounded(options.maxRetainedBytes, "native_public_capacity_invalid");
    let activeChats: string[] = [];
    let available = true, stream: string | undefined, sequence = 0, pending: Promise<void> | undefined, next: NativePublicDescriptor | undefined;
    const current = () => { if (!available || options.getIdentity() !== options.identity)
        fail("native_public_identity_changed"); };
    const close = (error?: NativePublicEventError) => { if (!available)
        return; available = false; if (error)
        options.onFault(error); };
    const consume = async (d: NativePublicDescriptor) => { current(); const chunks: Buffer[] = []; let offset = 0; while (offset < d.bytes) {
        const raw = await options.read({ version: VERSION, stream: d.stream, sequence: d.sequence, offset });
        current();
        if (!exact(raw, ["version", "stream", "sequence", "offset", "data", "eof"]) || raw.version !== VERSION || raw.stream !== d.stream || raw.sequence !== d.sequence || raw.offset !== offset || typeof raw.data !== "string" || raw.data.length > 131072 || typeof raw.eof !== "boolean" || raw.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data))
            fail("native_public_chunk_invalid");
        const bytes = Buffer.from(raw.data, "base64"), remaining = d.bytes - offset;
        if (bytes.toString("base64") !== raw.data || bytes.length !== Math.min(remaining, NATIVE_PUBLIC_EVENT_CHUNK_BYTES) || raw.eof !== (bytes.length === remaining))
            fail("native_public_chunk_invalid");
        chunks.push(bytes);
        offset += bytes.length;
    } const bytes = Buffer.concat(chunks); if (hash(bytes) !== d.sha256)
        fail("native_public_digest_mismatch"); const text = bytes.toString("utf8"); if (!Buffer.from(text, "utf8").equals(bytes))
        fail("native_public_utf8_invalid"); const value: PublicValue = (() => { try {
        return validate(JSON.parse(text));
    }
    catch {
        return fail("native_public_payload_invalid");
    } })(); current(); if (value.kind === "event")
        options.onEvent(value.value);
    else if (value.kind === "activeChats") { activeChats = [...value.value]; options.onActiveChats(value.value); }
    else
        options.onSettled(value.value); current(); sequence = d.sequence; await options.ack({ version: VERSION, stream: d.stream, sequence: d.sequence, sha256: d.sha256 }); current(); };
    const begin = (d: NativePublicDescriptor) => { const operation = consume(d); pending = operation; void operation.catch(e => close(e instanceof NativePublicEventError ? e : new NativePublicEventError("native_public_delivery_failed"))).finally(() => { if (pending === operation)
        pending = undefined; const queued = next; next = undefined; if (queued && available)
        begin(queued); }); };
    return { accept(method: string, input: unknown): void { if (method !== NATIVE_PUBLIC_EVENT_READY)
            return; try {
            current();
            const d = descriptor(input);
            if (d.sequence !== sequence + 1 || (stream !== undefined && stream !== d.stream) || d.bytes > capacity || next)
                fail("native_public_sequence_or_capacity");
            stream = d.stream;
            if (pending) {
                next = d;
            }
            else
                begin(d);
        }
        catch (e) {
            close(e instanceof NativePublicEventError ? e : new NativePublicEventError("native_public_delivery_failed"));
        } }, dispose: () => close(), async quiesce() { while (pending)
            await pending.catch(() => { }); }, activeChatIds: () => [...activeChats], get available() { return available && options.getIdentity() === options.identity; } };
}
export type NativePublicAttachmentOperation = {
    version: "agentlas.native-public-read.v1";
    read: NativePublicReadRequest;
} | {
    version: "agentlas.native-public-ack.v1";
    ack: NativePublicAck;
};
export function nativePublicReadOperation(read: NativePublicReadRequest): NativePublicAttachmentOperation { return { version: "agentlas.native-public-read.v1", read }; }
export function nativePublicAckOperation(ack: NativePublicAck): NativePublicAttachmentOperation { return { version: "agentlas.native-public-ack.v1", ack }; }
export function nativePublicAttachmentOperation(value: unknown): NativePublicAttachmentOperation | null {
    if (!record(value) || !["agentlas.native-public-read.v1", "agentlas.native-public-ack.v1"].includes(String(value.version)))
        return null;
    if (value.version === "agentlas.native-public-read.v1") {
        if (!exact(value, ["version", "read"]) || !exact(value.read, ["version", "stream", "sequence", "offset"]))
            fail("native_public_read_invalid");
    }
    else if (!exact(value, ["version", "ack"]) || !exact(value.ack, ["version", "stream", "sequence", "sha256"]))
        fail("native_public_ack_invalid");
    return value as unknown as NativePublicAttachmentOperation;
}
