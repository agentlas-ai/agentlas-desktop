import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  MOBILE_BRIDGE_PROTOCOL_VERSION,
  isMobileBridgeJsonValue,
  type MobileBridgeJsonValue,
  type MobileBridgeRpcFailure,
  type MobileBridgeRpcRequest,
  type MobileBridgeRpcSuccess,
} from "../../shared/mobile-bridge";
import { mobileBridgeJsonBytes } from "./sanitize";
import { LONG_OPS_LONGEST_WRITE_MAX_MS } from "./long-ops";

const BRIDGE_DIR = "mobile-bridge";
const REPLAY_FILE = "request-replays.json";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 2_048;
const MAX_STORED_RESPONSE_BYTES = 256 * 1024;

export type MobileBridgeReplayResponse = MobileBridgeRpcSuccess | MobileBridgeRpcFailure;

interface StoredReplayEntry {
  deviceId: string;
  keyHash: string;
  fingerprint: string;
  state: "pending" | "uncertain" | "completed";
  ownerInstanceId: string;
  response: MobileBridgeReplayResponse | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredReplayLedger {
  version: typeof MOBILE_BRIDGE_PROTOCOL_VERSION;
  entries: StoredReplayEntry[];
}

export type MobileBridgeReplayBeginResult =
  | { kind: "execute" }
  | { kind: "replay"; response: MobileBridgeReplayResponse }
  | { kind: "in-progress" }
  | { kind: "uncertain" }
  | { kind: "conflict" };

export type MobileBridgeReplayLookupResult =
  | { kind: "missing" }
  | { kind: "completed"; response: MobileBridgeReplayResponse }
  | { kind: "in-progress" }
  | { kind: "uncertain" }
  | { kind: "conflict" };

export interface MobileBridgeReplayStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
  instanceId?: string;
  /** Tests only: whether a process number belongs to a running process (default: signal 0). */
  processAlive?: (pid: number) => boolean;
  /** Tests only: this process's number (default process.pid). */
  pid?: number;
}

/**
 * The owner mark of a ledger line is `<uuid>@<process number>` (no new column: the mark was already a free string of at most 128 characters).
 * A line written before this carries no number and is read as before (an owner that is not this instance is gone).
 */
const OWNER_PID_SUFFIX = /@(\d{1,10})$/;
export function mobileBridgeOwnerPid(ownerInstanceId: string): number | null {
  const match = OWNER_PID_SUFFIX.exec(ownerInstanceId);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists and belongs to someone else - it is alive. ESRCH (or anything else): gone.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validReplayDeviceId(value: string): boolean {
  return value === "device_dev_bootstrap" || /^device_[a-f0-9]{32}$/.test(value);
}

function canonicalJson(value: MobileBridgeJsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export function fingerprintMobileBridgeRequest(request: MobileBridgeRpcRequest): string {
  return createHash("sha256")
    .update(canonicalJson({ method: request.method, params: request.params }), "utf8")
    .digest("hex");
}

export function mobileBridgeReplayStorePath(userDataPath: string): string {
  return path.join(userDataPath, BRIDGE_DIR, REPLAY_FILE);
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(directory, 0o700);
}

function writePrivateJsonAtomic(target: string, value: unknown): void {
  const directory = path.dirname(target);
  ensurePrivateDirectory(directory);
  const temporary = path.join(
    directory,
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    const handle = fs.openSync(temporary, "wx", 0o600);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    if (process.platform !== "win32") fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, target);
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
    if (process.platform !== "win32") {
      const directoryHandle = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryHandle); } finally { fs.closeSync(directoryHandle); }
    }
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch {}
  }
}

function validResponse(value: unknown): value is MobileBridgeReplayResponse {
  if (!isRecord(value) || value.v !== MOBILE_BRIDGE_PROTOCOL_VERSION || value.type !== "response") return false;
  if (!isMobileBridgeJsonValue(value)) return false;
  if (value.ok === true) return typeof value.id === "string" && Object.hasOwn(value, "result");
  return value.ok === false && (typeof value.id === "string" || value.id === null) && isRecord(value.error);
}

function validEntry(value: unknown): value is StoredReplayEntry {
  if (!isRecord(value)) return false;
  return (
    typeof value.deviceId === "string" && validReplayDeviceId(value.deviceId) &&
    typeof value.keyHash === "string" && /^[a-f0-9]{64}$/.test(value.keyHash) &&
    typeof value.fingerprint === "string" && /^[a-f0-9]{64}$/.test(value.fingerprint) &&
    (value.state === "pending" || value.state === "uncertain" || value.state === "completed") &&
    typeof value.ownerInstanceId === "string" && value.ownerInstanceId.length > 0 && value.ownerInstanceId.length <= 128 &&
    (value.response === null || validResponse(value.response)) &&
    (value.state === "completed" ? value.response !== null : value.response === null) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))
  );
}

/**
 * Durable write-ahead replay ledger. A write is recorded before authority runs;
 * a crash or timeout leaves an explicit uncertain record, so Desktop never
 * guesses whether a state-changing command should be executed twice.
 */
export class MobileBridgeRequestReplayStore {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => Date;
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly processAlive: (pid: number) => boolean;
  private lastOverflowPruneAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly userDataPath: string,
    options: MobileBridgeReplayStoreOptions = {},
  ) {
    this.ttlMs = Math.max(60_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, Math.min(10_000, options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.processAlive = options.processAlive ?? processIsAlive;
    this.instanceId = options.instanceId ?? `${randomUUID()}@${this.pid}`;
    if (!this.instanceId || this.instanceId.length > 128 || /[\u0000-\u001f]/.test(this.instanceId)) {
      throw new Error("Invalid Mobile Bridge replay instance id");
    }
  }

  /**
   * Audit 62 (bridge B11): can the ledger be read? A machine code the desktop's state and log can show: `ok`, or `ledger_invalid` (the file is not the ledger: not JSON, another version, an entry that does not validate) /
   * `ledger_unreadable`. While it is not `ok` every phone write is `idempotency_unavailable` (fail-closed, on purpose). What ends it is the OWNER's act: quit the app, move `<user data>/mobile-bridge/request-replays.json` (and the
   * `request-replays-overflow` folder) out of the way, start the app again: the ledger starts empty and the keys of the last 24 hours are "new" once (a command whose answer was lost may run again - the owner decides).
   */
  health(): { ok: true } | { ok: false; code: "ledger_invalid" | "ledger_unreadable" } {
    try { this.readLedger(mobileBridgeReplayStorePath(this.userDataPath)); return { ok: true }; }
    catch (error) { return { ok: false, code: error instanceof SyntaxError || /invalid/i.test(String((error as Error)?.message)) ? "ledger_invalid" : "ledger_unreadable" }; }
  }

  begin(deviceId: string, key: string, fingerprint: string): MobileBridgeReplayBeginResult {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    let { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const now = this.checkedNow();
    const changed = this.prune(ledger, now);
    this.pruneOverflow(now);
    const existing = ledger.entries.find((entry) => entry.deviceId === deviceId && entry.keyHash === keyHash);
    if (existing) {
      if (changed) this.writeLedger(ledger, target);
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      if (existing.state === "completed" && existing.response) {
        return { kind: "replay", response: existing.response };
      }
      if (existing.state === "uncertain") return { kind: "uncertain" };
      if (existing.ownerInstanceId !== this.instanceId && !this.liveForeignOwner(existing, now.getTime())) return { kind: "uncertain" };
      return { kind: "in-progress" };
    }
    if (ledger.entries.length >= this.maxEntries) {
      if (changed) this.writeLedger(ledger, target);
      // Keep every unexpired identity. Capacity in the legacy page must never
      // evict an earlier command or reject a different owner's command.
      target = this.overflowPath(deviceId, keyHash);
      ledger = { version: MOBILE_BRIDGE_PROTOCOL_VERSION, entries: [] };
    }
    const timestamp = now.toISOString();
    ledger.entries.push({
      deviceId,
      keyHash,
      fingerprint,
      state: "pending",
      ownerInstanceId: this.instanceId,
      response: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.writeLedger(ledger, target);
    return { kind: "execute" };
  }

  /**
   * Read-only reconciliation for a client that lost a write acknowledgement.
   * Missing and expired entries are reported, never created, so this path can
   * never execute the original command.
   */
  lookup(deviceId: string, key: string, fingerprint: string): MobileBridgeReplayLookupResult {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger } = this.readLedgerForKey(deviceId, keyHash);
    const now = this.checkedNow().getTime();
    const entry = ledger.entries.find(
      (candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash,
    );
    if (!entry || Date.parse(entry.updatedAt) < now - this.ttlMs) return { kind: "missing" };
    if (entry.fingerprint !== fingerprint) return { kind: "conflict" };
    if (entry.state === "completed" && entry.response) {
      return { kind: "completed", response: entry.response };
    }
    if (entry.state === "uncertain") return { kind: "uncertain" };
    if (entry.ownerInstanceId !== this.instanceId && !this.liveForeignOwner(entry, now)) return { kind: "uncertain" };
    return { kind: "in-progress" };
  }

  /**
   * L1 D5 (contracts/phone-long-ops.md C3): a pending line whose owner is ANOTHER process that is still running is "in progress", not "unknown" - the
   * Main <-> background-service hand-off leaves the work running in the process that started it, and a new owner must neither run it again nor call it lost.
   * Only a line that names a process number can be live (older lines never are), never this very process (another instance in it is gone, as before), and
   * only while the line is younger than the longest bound of any write: past that the work cannot still be going, so a process number the system
   * reused for something else cannot hold a key "in progress" for a day. Read-only.
   */
  private liveForeignOwner(entry: StoredReplayEntry, nowMs: number): boolean {
    if (entry.state !== "pending") return false;
    const pid = mobileBridgeOwnerPid(entry.ownerInstanceId);
    if (pid === null || pid === this.pid) return false;
    if (nowMs - Date.parse(entry.updatedAt) > LONG_OPS_LONGEST_WRITE_MAX_MS) return false;
    try { return this.processAlive(pid); } catch { return false; }
  }

  capability(): { schemaVersion: 1; retentionMs: number } {
    return { schemaVersion: 1, retentionMs: this.ttlMs };
  }

  complete(
    deviceId: string,
    key: string,
    fingerprint: string,
    response: MobileBridgeReplayResponse,
  ): void {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    if (!validResponse(response) || mobileBridgeJsonBytes(response) > MAX_STORED_RESPONSE_BYTES) {
      this.markUncertain(deviceId, key, fingerprint);
      throw new Error("Mobile Bridge replay response cannot be stored safely");
    }
    const { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (!entry || entry.fingerprint !== fingerprint || entry.ownerInstanceId !== this.instanceId) {
      throw new Error("Mobile Bridge replay ownership was lost before completion");
    }
    entry.state = "completed";
    entry.response = response;
    entry.updatedAt = this.checkedNow().toISOString();
    this.writeLedger(ledger, target);
  }

  /**
   * Forget a pending entry this process owns, so the SAME key may run again.
   * Only for a command whose own downstream layer is idempotent on a key
   * derived from this one (mail.send → web Idempotency-Key `mob-<key>`) and
   * whose answer was "not decided" (outcome unknown, transient outage). Storing
   * such an answer as final would replay the failure forever, and the phone's
   * only way out would be a new key — a second real email (EDGE-CASES M1/M7).
   */
  release(deviceId: string, key: string, fingerprint: string): void {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const index = ledger.entries.findIndex((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (index < 0) return;
    const entry = ledger.entries[index];
    if (entry.fingerprint !== fingerprint || entry.ownerInstanceId !== this.instanceId) return;
    if (entry.state === "completed") return;
    ledger.entries.splice(index, 1);
    this.writeLedger(ledger, target);
  }

  /**
   * Whether this key's entry was left unsettled by a PREVIOUS Desktop instance (it was pending, or marked uncertain, when
   * that process ended). Nothing alive can ever settle such an entry: it answers "uncertain" until it expires unless the
   * caller can prove the outcome from the command's own durable footprint (releaseOrphan / adoptOrphan). Read-only.
   */
  isOrphan(deviceId: string, key: string, fingerprint: string): boolean {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger } = this.readLedgerForKey(deviceId, keyHash);
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    const nowMs = this.checkedNow().getTime();
    return Boolean(entry && entry.fingerprint === fingerprint && entry.state !== "completed" && entry.ownerInstanceId !== this.instanceId
      && Date.parse(entry.updatedAt) >= nowMs - this.ttlMs && !this.liveForeignOwner(entry, nowMs));
  }

  /**
   * Forget an unsettled entry that a PREVIOUS Desktop instance left behind, so the SAME key may run again. Only for a
   * command whose own downstream layer is idempotent on a key derived from this one (see orphan-rerun-policy.ts):
   * then re-running it can never run it twice, and the entry would otherwise answer "uncertain" until it expires, with
   * the phone unable to resend it or to prove it arrived. Never touches a completed entry, an entry of another
   * fingerprint, or an entry this process owns (a live command settles that one itself). Returns whether it removed one.
   */
  releaseOrphan(deviceId: string, key: string, fingerprint: string): boolean {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const index = ledger.entries.findIndex((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (index < 0) return false;
    const entry = ledger.entries[index];
    if (entry.fingerprint !== fingerprint || entry.ownerInstanceId === this.instanceId || entry.state === "completed") return false;
    if (this.liveForeignOwner(entry, this.checkedNow().getTime())) return false;
    ledger.entries.splice(index, 1);
    this.writeLedger(ledger, target);
    return true;
  }

  /**
   * Settle an entry a previous Desktop instance left behind with the answer the Desktop's own durable rows prove (the
   * message was taken), so a resend of the key replays it. Same guards as releaseOrphan. Returns whether it settled one.
   */
  adoptOrphan(deviceId: string, key: string, fingerprint: string, response: MobileBridgeReplayResponse): boolean {
    this.assertIdentity(deviceId, key, fingerprint);
    if (!validResponse(response) || mobileBridgeJsonBytes(response) > MAX_STORED_RESPONSE_BYTES) return false;
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (!entry || entry.fingerprint !== fingerprint || entry.ownerInstanceId === this.instanceId || entry.state === "completed") return false;
    if (this.liveForeignOwner(entry, this.checkedNow().getTime())) return false;
    entry.state = "completed";
    entry.response = response;
    entry.ownerInstanceId = this.instanceId;
    entry.updatedAt = this.checkedNow().toISOString();
    this.writeLedger(ledger, target);
    return true;
  }

  markUncertain(deviceId: string, key: string, fingerprint: string): void {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const { ledger, target } = this.readLedgerForKey(deviceId, keyHash);
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (!entry || entry.fingerprint !== fingerprint || entry.ownerInstanceId !== this.instanceId) return;
    entry.state = "uncertain";
    entry.response = null;
    entry.updatedAt = this.checkedNow().toISOString();
    this.writeLedger(ledger, target);
  }

  private overflowPath(deviceId: string, keyHash: string): string {
    const identity = createHash("sha256").update(`${deviceId}\0${keyHash}`).digest("hex");
    return path.join(this.userDataPath, BRIDGE_DIR, "request-replays-overflow", `${identity}.json`);
  }

  private readLedgerForKey(deviceId: string, keyHash: string): { ledger: StoredReplayLedger; target: string } {
    const overflow = this.overflowPath(deviceId, keyHash);
    const target = fs.existsSync(overflow) ? overflow : mobileBridgeReplayStorePath(this.userDataPath);
    return { ledger: this.readLedger(target), target };
  }

  /** Expired spill records contain no remaining replay guarantee. Never delete
   * a live entry merely to make room, and never follow a directory symlink. */
  private pruneOverflow(now: Date): void {
    if (now.getTime() - this.lastOverflowPruneAt < 60_000) return;
    const directory = path.join(this.userDataPath, BRIDGE_DIR, "request-replays-overflow");
    if (!fs.existsSync(directory)) return;
    if (!fs.lstatSync(directory).isDirectory()) throw new Error("Invalid Mobile Bridge replay overflow directory");
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const target = path.join(directory, name);
      if (!fs.lstatSync(target).isFile()) throw new Error("Invalid Mobile Bridge replay overflow record");
      const ledger = this.readLedger(target);
      if (ledger.entries.every((entry) => Date.parse(entry.updatedAt) < now.getTime() - this.ttlMs)) {
        fs.unlinkSync(target);
      }
    }
    this.lastOverflowPruneAt = now.getTime();
  }

  private readLedger(target: string): StoredReplayLedger {
    if (!fs.existsSync(target)) return { version: MOBILE_BRIDGE_PROTOCOL_VERSION, entries: [] };
    const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.version !== MOBILE_BRIDGE_PROTOCOL_VERSION ||
      !Array.isArray(parsed.entries) ||
      !parsed.entries.every(validEntry)
    ) {
      throw new Error("Agentlas Mobile Bridge replay ledger is invalid; writes are fail-closed");
    }
    if (process.platform !== "win32") fs.chmodSync(target, 0o600);
    return parsed as unknown as StoredReplayLedger;
  }

  private writeLedger(ledger: StoredReplayLedger, target: string): void {
    writePrivateJsonAtomic(target, ledger);
  }

  private prune(ledger: StoredReplayLedger, now: Date): boolean {
    const oldest = now.getTime() - this.ttlMs;
    const retained = ledger.entries.filter((entry) => Date.parse(entry.updatedAt) >= oldest);
    if (retained.length === ledger.entries.length) return false;
    ledger.entries = retained;
    return true;
  }

  private checkedNow(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid Mobile Bridge replay timestamp");
    return now;
  }

  private assertIdentity(deviceId: string, key: string, fingerprint: string): void {
    if (!validReplayDeviceId(deviceId)) throw new Error("Invalid Mobile Bridge replay device id");
    if (!key || key.length > 160 || /[\u0000-\u001f]/.test(key)) {
      throw new Error("Invalid Mobile Bridge idempotency key");
    }
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("Invalid Mobile Bridge request fingerprint");
  }
}
