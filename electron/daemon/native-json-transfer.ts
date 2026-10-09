import { createHash, randomUUID } from "node:crypto";
import { TextDecoder } from "node:util";

/** Transport data only. An owner is a private issuer object supplied by native
 * bootstrap; neither a descriptor nor this module grants invocation authority. */
export type NativeJsonTransferKind = "original-request" | "checkpoint-value";
export interface NativeJsonTransferDescriptor {
  readonly version: "agentlas.native-json.v1";
  readonly transferId: string;
  readonly kind: NativeJsonTransferKind;
  readonly byteLength: number;
  readonly digest: string;
}
export interface NativeJsonTransferChunk {
  readonly transferId: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly done: boolean;
  readonly data: string;
}
export const NATIVE_JSON_CHUNK_BYTES = 96 * 1024;
export class NativeJsonTransferError extends Error {
  constructor(readonly code: string) { super(code); }
}
function denied(code: string): never { throw new NativeJsonTransferError(code); }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
}
function budget(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) denied("native_json_budget_invalid");
}
function descriptor(value: unknown, maxBytes: number): NativeJsonTransferDescriptor {
  budget(maxBytes);
  if (!exact(value, ["version", "transferId", "kind", "byteLength", "digest"])
    || value.version !== "agentlas.native-json.v1"
    || typeof value.transferId !== "string" || !/^[a-f0-9-]{36}$/.test(value.transferId)
    || (value.kind !== "original-request" && value.kind !== "checkpoint-value")
    || !Number.isSafeInteger(value.byteLength) || Number(value.byteLength) < 1 || Number(value.byteLength) > maxBytes
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)) denied("native_json_descriptor_invalid");
  return Object.freeze({ ...value }) as unknown as NativeJsonTransferDescriptor;
}
interface Snapshot {
  owner: object;
  descriptor: NativeJsonTransferDescriptor;
  bytes: Buffer;
  nextOffset: number;
  lastChunk?: NativeJsonTransferChunk;
}
/** The caller supplies schema limits from the original producer. There is no
 * smaller default content limit, timeout cleanup, implicit retry, or file read. */
export function createNativeJsonTransfers(options: {
  isCurrent(owner: object): boolean;
  maxPending: number;
  maxRetainedBytes: number;
}) {
  budget(options.maxPending); budget(options.maxRetainedBytes);
  const snapshots = new Map<string, Snapshot>();
  let retainedBytes = 0;
  function current(owner: object): void {
    if (!owner || typeof owner !== "object" || !options.isCurrent(owner)) denied("native_json_owner_changed");
  }
  function issue(owner: object, kind: NativeJsonTransferKind, value: unknown, maxBytes: number): NativeJsonTransferDescriptor {
    current(owner); budget(maxBytes);
    if (kind !== "original-request" && kind !== "checkpoint-value") denied("native_json_kind_invalid");
    if (snapshots.size >= options.maxPending) denied("native_json_snapshot_capacity");
    // Optional absent properties are omitted by source JSON semantics. Native
    // private claim tokens must be excluded by the issuer before this boundary.
    let json: string | undefined;
    try { json = JSON.stringify(value); } catch { denied("native_json_value_invalid"); }
    if (json === undefined) denied("native_json_value_invalid");
    const byteLength = Buffer.byteLength(json, "utf8");
    if (byteLength > maxBytes) denied("native_json_value_limit");
    if (byteLength > options.maxRetainedBytes - retainedBytes) denied("native_json_snapshot_capacity");
    const bytes = Buffer.from(json, "utf8");
    current(owner);
    const valueDescriptor = Object.freeze({ version: "agentlas.native-json.v1" as const, transferId: randomUUID(), kind,
      byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") });
    snapshots.set(valueDescriptor.transferId, { owner, descriptor: valueDescriptor, bytes, nextOffset: 0 });
    retainedBytes += bytes.length;
    return valueDescriptor;
  }
  function read(owner: object, transferId: string, offset: number): NativeJsonTransferChunk {
    current(owner);
    const snapshot = snapshots.get(transferId);
    if (!snapshot || snapshot.owner !== owner) denied("native_json_snapshot_unavailable");
    if (!Number.isSafeInteger(offset) || offset < 0) denied("native_json_offset_invalid");
    // Re-observe the last immutable chunk after an uncertain read ACK. This
    // never repeats an issuer/claim/start or advances a different offset.
    if (snapshot.lastChunk?.offset === offset) return snapshot.lastChunk;
    if (offset !== snapshot.nextOffset || offset >= snapshot.bytes.length) denied("native_json_offset_invalid");
    const nextOffset = Math.min(snapshot.bytes.length, offset + NATIVE_JSON_CHUNK_BYTES);
    const chunk = Object.freeze({ transferId, offset, nextOffset, done: nextOffset === snapshot.bytes.length,
      data: snapshot.bytes.subarray(offset, nextOffset).toString("base64") });
    current(owner);
    snapshot.nextOffset = nextOffset; snapshot.lastChunk = chunk;
    return chunk;
  }
  /** Private custody owner only. Disconnect is never an automatic release. */
  function release(owner: object): void {
    for (const [id, snapshot] of snapshots) if (snapshot.owner === owner) {
      retainedBytes -= snapshot.bytes.length; snapshots.delete(id);
    }
  }
  return { issue, read, release, get pendingCount() { return snapshots.size; }, get retainedBytes() { return retainedBytes; } };
}

/** Reads original retained operations to settlement. Stop cannot race away an
 * in-flight read; checks happen before and after every actual transport await. */
export async function importNativeJsonValue(value: unknown, options: {
  kind: NativeJsonTransferKind;
  maxBytes: number;
  signal: AbortSignal;
  assertCurrent(): void;
  read(transferId: string, offset: number): Promise<unknown>;
}): Promise<unknown> {
  options.assertCurrent(); options.signal.throwIfAborted();
  const captured = descriptor(value, options.maxBytes);
  if (captured.kind !== options.kind) denied("native_json_kind_invalid");
  const chunks: Buffer[] = [], hash = createHash("sha256");
  let offset = 0;
  while (offset < captured.byteLength) {
    options.assertCurrent(); options.signal.throwIfAborted();
    const raw = await options.read(captured.transferId, offset);
    options.assertCurrent(); options.signal.throwIfAborted();
    if (!exact(raw, ["transferId", "offset", "nextOffset", "done", "data"])
      || raw.transferId !== captured.transferId || raw.offset !== offset
      || !Number.isSafeInteger(raw.nextOffset) || Number(raw.nextOffset) <= offset
      || Number(raw.nextOffset) !== Math.min(captured.byteLength, offset + NATIVE_JSON_CHUNK_BYTES)
      || raw.done !== (Number(raw.nextOffset) === captured.byteLength)
      || typeof raw.data !== "string" || raw.data.length > NATIVE_JSON_CHUNK_BYTES / 3 * 4
      || raw.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(raw.data)) denied("native_json_chunk_invalid");
    const bytes = Buffer.from(raw.data, "base64");
    if (bytes.length !== Number(raw.nextOffset) - offset || bytes.toString("base64") !== raw.data) denied("native_json_chunk_invalid");
    chunks.push(bytes); hash.update(bytes); offset = Number(raw.nextOffset);
  }
  if (hash.digest("hex") !== captured.digest) denied("native_json_digest_mismatch");
  let text: string, parsed: unknown;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, captured.byteLength)); parsed = JSON.parse(text); }
  catch { denied("native_json_value_invalid"); }
  if (JSON.stringify(parsed) !== text) denied("native_json_value_invalid");
  options.assertCurrent(); options.signal.throwIfAborted();
  return parsed;
}
