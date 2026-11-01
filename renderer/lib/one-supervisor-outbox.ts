import type { OneSupervisorAPI, SupervisorCommandReceipt } from "../../shared/one-supervisor";

export type SupervisorWrite = "send" | "startWork" | "startScience" | "control" | "stopReply" | "stopTask" | "appearance";
export interface PendingSupervisorWrite { commandId: string; method: SupervisorWrite; input: Record<string, unknown> }
type OutboxStorage = Pick<Storage, "getItem" | "setItem"> & Partial<Pick<Storage, "removeItem" | "key" | "length">>;
const METHODS = new Set<string>(["send", "startWork", "startScience", "control", "stopReply", "stopTask", "appearance"]);

function readIntent(raw: string | null): PendingSupervisorWrite | null {
  if (raw === null || raw === "null") return null;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("supervisor_saved_request_invalid");
  const item = value as PendingSupervisorWrite;
  if (!METHODS.has(item.method) || typeof item.commandId !== "string" || !item.commandId
    || !item.input || typeof item.input !== "object" || item.input.commandId !== item.commandId) {
    throw new Error("supervisor_saved_request_invalid");
  }
  return item;
}

/**
 * Renderer retry cache, never execution authority. Each command owns one key;
 * windows never read/replace a shared array and lose each other's requests.
 * Host receipts remove exact intents. Retries keep their original ID, while
 * two deliberate identical submissions remain different commands.
 */
export class SupervisorOutbox {
  private readonly pending = new Map<string, PendingSupervisorWrite>();
  private readonly prefix: string;
  private readonly legacyKey: string;
  constructor(private readonly oneId: string, private readonly storage: OutboxStorage) {
    this.legacyKey = `agentlas.one.supervisor.outbox.${oneId}`;
    this.prefix = `${this.legacyKey}.command.`;
    this.migrateLegacy(); this.refresh();
  }
  private acknowledged(id: string): boolean { return this.storage.getItem(`${this.legacyKey}.received.${id}`) !== null; }
  /** A saved request that cannot be read is set aside, never fatal: one damaged record must not stop the composer from sending,
   * and the other saved requests keep working. The bytes stay under a `.quarantine.` key (named by their content, so a record
   * met again is not copied twice) for support; they are never replayed. */
  private setAside(raw: string | null): void {
    if (raw === null) return;
    let hash = 5381;
    for (let i = 0; i < raw.length; i++) hash = ((hash * 33) ^ raw.charCodeAt(i)) >>> 0;
    const key = `${this.legacyKey}.quarantine.${hash.toString(36)}.${raw.length}`;
    // A record met again is not counted twice: the owner is told once about each damaged request.
    try { if (this.storage.getItem(key) === null) this.setAsideCount += 1; } catch { this.setAsideCount += 1; }
    try { this.storage.setItem(key, raw); }
    catch { /* a full store cannot hold the copy; the damaged record is still skipped */ }
  }
  private setAsideCount = 0;
  /**
   * How many unreadable saved requests were set aside since this was last asked. The set-aside request leaves the list, so the composer says
   * so once (nothing the owner typed may disappear with no line); the bytes stay in the quarantine key, never replayed.
   */
  takeSetAside(): number { const count = this.setAsideCount; this.setAsideCount = 0; return count; }
  private quarantine(key: string, raw: string | null): void {
    this.setAside(raw);
    try {
      if (this.storage.removeItem) this.storage.removeItem(key);
      else this.storage.setItem(key, "null");
    } catch { /* the record stays unreadable but is skipped on every read */ }
  }
  private migrateLegacy(): void {
    const raw = this.storage.getItem(this.legacyKey);
    if (!raw) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { this.quarantine(this.legacyKey, raw); return; }
    if (!Array.isArray(value)) { this.quarantine(this.legacyKey, raw); return; }
    for (const item of value) {
      let intent: PendingSupervisorWrite | null;
      try { intent = readIntent(JSON.stringify(item)); } catch { this.setAside(JSON.stringify(item) ?? null); continue; }
      if (!intent || this.acknowledged(intent.commandId)) continue;
      const key = this.prefix + intent.commandId;
      if (this.storage.getItem(key) === null) this.storage.setItem(key, JSON.stringify(intent));
      this.pending.set(intent.commandId, intent);
    }
    // Additive migration. Per-ID host receipts prevent other windows from
    // resurrecting a request from the old shared-array representation.
  }
  private refresh(): void {
    if (typeof this.storage.key === "function" && typeof this.storage.length === "number") {
      const next = new Map<string, PendingSupervisorWrite>();
      const damaged: Array<[string, string | null]> = [];
      for (let i = 0; i < this.storage.length; i++) {
        const key = this.storage.key(i);
        if (!key?.startsWith(this.prefix)) continue;
        const raw = this.storage.getItem(key);
        let intent: PendingSupervisorWrite | null;
        try { intent = readIntent(raw); } catch { damaged.push([key, raw]); continue; }
        if (intent && key === this.prefix + intent.commandId && !this.acknowledged(intent.commandId)) next.set(intent.commandId, intent);
      }
      // Set aside after the scan: removing a key while indexing the store shifts the indexes.
      for (const [key, raw] of damaged) this.quarantine(key, raw);
      this.pending.clear();
      for (const [id, intent] of next) this.pending.set(id, intent);
    } else {
      for (const id of this.pending.keys()) if (this.acknowledged(id)) this.pending.delete(id);
    }
  }
  list(): PendingSupervisorWrite[] {
    this.refresh();
    return Array.from(this.pending.values(), item => ({ ...item, input: { ...item.input } }));
  }
  reconcile(receipts: SupervisorCommandReceipt[]): void {
    for (const receipt of receipts) {
      if (receipt.acknowledgement === "unknown") continue;
      const id = receipt.commandId;
      this.storage.setItem(`${this.legacyKey}.received.${id}`, JSON.stringify({ commandId: id, state: receipt.state }));
      if (this.storage.removeItem) this.storage.removeItem(this.prefix + id);
      else this.storage.setItem(this.prefix + id, "null");
      this.pending.delete(id);
    }
    this.refresh();
  }
  prepare(method: SupervisorWrite, input: Record<string, unknown>): PendingSupervisorWrite {
    if (!METHODS.has(method)) throw new Error("supervisor_saved_request_method_invalid");
    if (this.list().length >= 100) throw new Error("supervisor_saved_request_capacity");
    const commandId = crypto.randomUUID();
    const intent: PendingSupervisorWrite = { commandId, method, input: { ...input, commandId } };
    this.storage.setItem(this.prefix + commandId, JSON.stringify(intent));
    this.pending.set(commandId, intent);
    return intent;
  }
  async deliver(api: OneSupervisorAPI, intent: PendingSupervisorWrite): Promise<SupervisorCommandReceipt> {
    if (this.acknowledged(intent.commandId)) {
      const receiptApi = (api as OneSupervisorAPI & { receipt?: (input: { oneId: string; commandId: string }) => Promise<SupervisorCommandReceipt | null> }).receipt;
      const receipt = await receiptApi?.call(api, { oneId: this.oneId, commandId: intent.commandId });
      if (receipt) return receipt;
      throw new Error("supervisor_receipt_identity_unconfirmed");
    }
    const action = api[intent.method] as ((input: Record<string, unknown>) => Promise<SupervisorCommandReceipt>) | undefined;
    if (typeof action !== "function") throw new Error("supervisor_saved_request_method_unavailable");
    const receipt = await action.call(api, { ...intent.input, oneId: intent.input.oneId ?? this.oneId });
    if (receipt.commandId !== intent.commandId) throw new Error("supervisor_receipt_identity_unconfirmed");
    this.reconcile([receipt]); return receipt;
  }
}

/** In-memory stand-in for a store that cannot be used at all (blocked by the browser profile, full). */
function memoryOutboxStorage(): OutboxStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
    key: (index) => Array.from(map.keys())[index] ?? null,
    get length() { return map.size; },
  };
}

/**
 * Opens the retry cache for a conversation so that sending never depends on it. A damaged saved request is set aside by the
 * outbox itself; a store that cannot be used at all (private profile, quota) continues in memory, which only loses the retry after
 * a restart. The composer is never disabled for a stored request that could not be read.
 */
export function openSupervisorOutbox(oneId: string, storage: OutboxStorage | null): SupervisorOutbox {
  if (storage) {
    try { return new SupervisorOutbox(oneId, storage); } catch { /* memory below */ }
  }
  return new SupervisorOutbox(oneId, memoryOutboxStorage());
}
