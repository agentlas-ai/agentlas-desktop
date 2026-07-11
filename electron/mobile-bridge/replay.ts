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

export interface MobileBridgeReplayStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
  instanceId?: string;
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

  constructor(
    private readonly userDataPath: string,
    options: MobileBridgeReplayStoreOptions = {},
  ) {
    this.ttlMs = Math.max(60_000, options.ttlMs ?? DEFAULT_TTL_MS);
    this.maxEntries = Math.max(1, Math.min(10_000, options.maxEntries ?? DEFAULT_MAX_ENTRIES));
    this.now = options.now ?? (() => new Date());
    this.instanceId = options.instanceId ?? randomUUID();
    if (!this.instanceId || this.instanceId.length > 128 || /[\u0000-\u001f]/.test(this.instanceId)) {
      throw new Error("Invalid Mobile Bridge replay instance id");
    }
  }

  begin(deviceId: string, key: string, fingerprint: string): MobileBridgeReplayBeginResult {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const ledger = this.readLedger();
    const now = this.checkedNow();
    const changed = this.prune(ledger, now);
    const existing = ledger.entries.find((entry) => entry.deviceId === deviceId && entry.keyHash === keyHash);
    if (existing) {
      if (changed) this.writeLedger(ledger);
      if (existing.fingerprint !== fingerprint) return { kind: "conflict" };
      if (existing.state === "completed" && existing.response) {
        return { kind: "replay", response: existing.response };
      }
      if (existing.state === "uncertain" || existing.ownerInstanceId !== this.instanceId) {
        return { kind: "uncertain" };
      }
      return { kind: "in-progress" };
    }
    if (ledger.entries.length >= this.maxEntries) {
      if (changed) this.writeLedger(ledger);
      throw new Error("Mobile Bridge replay ledger is full; retry after the safety window expires");
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
    this.writeLedger(ledger);
    return { kind: "execute" };
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
    const ledger = this.readLedger();
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (!entry || entry.fingerprint !== fingerprint || entry.ownerInstanceId !== this.instanceId) {
      throw new Error("Mobile Bridge replay ownership was lost before completion");
    }
    entry.state = "completed";
    entry.response = response;
    entry.updatedAt = this.checkedNow().toISOString();
    this.writeLedger(ledger);
  }

  markUncertain(deviceId: string, key: string, fingerprint: string): void {
    this.assertIdentity(deviceId, key, fingerprint);
    const keyHash = createHash("sha256").update(key, "utf8").digest("hex");
    const ledger = this.readLedger();
    const entry = ledger.entries.find((candidate) => candidate.deviceId === deviceId && candidate.keyHash === keyHash);
    if (!entry || entry.fingerprint !== fingerprint || entry.ownerInstanceId !== this.instanceId) return;
    entry.state = "uncertain";
    entry.response = null;
    entry.updatedAt = this.checkedNow().toISOString();
    this.writeLedger(ledger);
  }

  private readLedger(): StoredReplayLedger {
    const target = mobileBridgeReplayStorePath(this.userDataPath);
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

  private writeLedger(ledger: StoredReplayLedger): void {
    writePrivateJsonAtomic(mobileBridgeReplayStorePath(this.userDataPath), ledger);
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
