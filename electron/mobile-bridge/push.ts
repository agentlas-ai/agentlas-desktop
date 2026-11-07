import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MobileBridgeConnectionContext } from "./server";
import { isOneQuietHour } from "../../shared/one-briefing";
import { validateMobilePushParams, type MobilePushRegistration } from "../../shared/mobile-bridge";

export type MobilePushOutcome = "accepted" | "unregistered" | "unavailable" | "refused";
export interface MobilePushNotice {
  category: "oneMessage" | "resultReady" | "failure" | "approval";
  destination: "personalOne" | "thread" | "approvals" | "automation";
  dedupeKey: string;
  hostId: string;
  entityId: string;
  subject: string;
  body?: string;
  occurredAt: string;
  messageId?: string;
  /**
   * An AI is waiting for the owner's answer on a decision card (owner 2026-10-20). Additive: the relay that knows it words
   * the lock-screen text for a question; a relay that does not know it ignores the field and shows the generic text, and
   * the category, destination and preference gate stay those of an ordinary result, so released phones route it unchanged.
   */
  reason?: "ownerAnswer";
  /**
   * The message is a check-in One ran on its own schedule, not an answer to something the owner just asked. Only these wait for
   * the owner's quiet hours to end. Host-side only: it is removed before the notice goes to the relay.
   */
  quietEligible?: boolean;
}
export interface MobilePushRelayPayload {
  token: string;
  platform: "ios" | "android";
  locale: "ko" | "en";
  notification: MobilePushNotice & { deviceId: string };
}
interface Registration extends MobilePushRegistration {
  deviceId: string;
  workspaceId: string;
  hostId: string;
}
/**
 * A push that could not be sent yet. Written by deliver() when FCM stayed unreachable ("transient") or the owner's quiet hours
 * held a check-in ("quiet"); read by flushPending() on a connection/start signal or at the quiet-hours end; deleted when it is
 * sent, refused, 24 hours old, or past the newest 50. A token that is invalid or refused is never queued.
 */
interface PendingPush {
  key: string;
  deviceId: string;
  notice: MobilePushNotice;
  cause: "transient" | "quiet";
  queuedAt: number;
  notBefore: number;
}
interface Registry { version: 1; registrations: Registration[]; delivered: string[]; pending?: PendingPush[] }
const PENDING_LIMIT = 50;
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
export interface MobilePushQuietHours { enabled: boolean; startHour: number; endHour: number }
export interface MobilePushServiceOptions {
  userDataPath: string;
  hostId: string;
  currentWorkspaceId(): string | null;
  deviceWorkspaceId(deviceId: string): string | null;
  supportsPlatform(platform: "ios" | "android"): boolean;
  publish(payload: MobilePushRelayPayload): Promise<MobilePushOutcome>;
  retryMs?: number;
  expiryMs?: number;
  /** The owner's quiet hours (One Briefing preferences). Absent or disabled: nothing is held. */
  quietHours?(): MobilePushQuietHours | null;
  /**
   * A queued push is re-checked before it is sent again. false: gone (a decision card answered meanwhile), the entry is deleted.
   * "keep": the check itself could not run (store error), the entry stays queued for the next signal.
   */
  revalidate?(notice: MobilePushNotice): boolean | "keep";
  /**
   * The queue keeps a message's id, never its text. The text for the lock screen is made again from the saved message when the
   * push is sent; null means the message no longer exists, so nothing is sent and the entry is deleted.
   */
  resolveBody?(notice: MobilePushNotice): { body?: string } | null;
  now?(): number;
}
function quietHoursEnd(quiet: MobilePushQuietHours, at: number): number {
  const end = new Date(at);
  end.setHours(quiet.endHour, 0, 0, 0);
  if (end.getTime() <= at) end.setDate(end.getDate() + 1);
  return end.getTime();
}
/** Which queued pushes go first when the queue is over its limit: scheduled check-ins, then results, then answers and failures; a decision card last. */
function keepRank(item: PendingPush): number {
  if (item.notice.category === "approval") return 3;
  if (item.notice.quietEligible) return 0;
  return item.notice.category === "resultReady" ? 1 : 2;
}
/** Drops what is 24 hours old, then, over the limit, the least important and oldest first. `overflow` receives how many were cut for size. */
function trimPending(list: PendingPush[], now: number, overflow?: (count: number) => void): PendingPush[] {
  const live = list.filter(item => now - item.queuedAt < PENDING_TTL_MS && item.queuedAt <= now + 60_000);
  if (live.length <= PENDING_LIMIT) return live;
  const order = new Map(live.map((item, index) => [item, index])); // later in the list = newer, also when the clock ties
  const keep = new Set([...live].sort((a, b) => keepRank(b) - keepRank(a) || order.get(b)! - order.get(a)!).slice(0, PENDING_LIMIT));
  overflow?.(live.length - PENDING_LIMIT);
  return live.filter(item => keep.has(item));
}
const preference = { oneMessage: "one", resultReady: "completed", failure: "failures", approval: "approval" } as const;

/** Device-bound subscriptions; no phone-presence heuristic can suppress a push. */
export class MobilePushService {
  private readonly file: string;
  private registry: Registry;
  private readonly queued = new Set<string>();
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private stopped = false;
  private flushing = false;
  private releaseTimer: NodeJS.Timeout | null = null;
  constructor(private readonly options: MobilePushServiceOptions) {
    this.file = path.join(options.userDataPath, "mobile-bridge", "push.json");
    this.registry = this.read();
    this.prune();
  }
  /**
   * The store is a cache of what the phones told us: a phone registers again every time it connects. So a file that cannot
   * be trusted (unparseable, oversize, a bad record, written by another host identity) is never a reason to switch push
   * off for the whole session, and never a reason to throw at start-up: the bad part is set aside (not read, not printed)
   * and the rest keeps working. Round 3, mobile 183: one such file used to disable push on every launch.
   */
  private read(): Registry {
    const empty = (): Registry => ({ version: 1, registrations: [], delivered: [], pending: [] });
    if (!fs.existsSync(this.file)) return empty();
    let raw: unknown;
    try {
      if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw new Error("mobile_push_store_invalid");
      raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch { this.setAside(); return empty(); }
    const stored = raw as Partial<Registry> | null;
    if (!stored || typeof stored !== "object" || stored.version !== 1 || !Array.isArray(stored.registrations) || !Array.isArray(stored.delivered)) {
      this.setAside();
      return empty();
    }
    const registrations = (stored.registrations as unknown[]).filter((item): item is Registration => this.validRecord(item)).slice(-128);
    const delivered = (stored.delivered as unknown[]).filter((id): id is string => typeof id === "string" && id.length <= 1024).slice(-2048);
    const storedPending = Array.isArray(stored.pending) ? stored.pending as unknown[] : [];
    const pending = trimPending(storedPending.filter((item): item is PendingPush => this.validPending(item)), this.clock());
    if (registrations.length === stored.registrations.length && delivered.length === stored.delivered.length) return { version: 1, registrations, delivered, pending };
    this.setAside();
    const kept: Registry = { version: 1, registrations, delivered, pending };
    if (registrations.length > 0 || delivered.length > 0 || pending.length > 0) { try { this.persist(kept); } catch { /* kept in memory; the next write replaces the file */ } }
    return kept;
  }
  private clock(): number { return this.options.now?.() ?? Date.now(); }
  private validPending(item: unknown): item is PendingPush {
    if (!item || typeof item !== "object") return false;
    const record = item as PendingPush;
    const notice = record.notice as MobilePushNotice | undefined;
    return typeof record.key === "string" && record.key.length <= 1024 && typeof record.deviceId === "string" &&
      (record.cause === "transient" || record.cause === "quiet") && Number.isFinite(record.queuedAt) && Number.isFinite(record.notBefore) &&
      !!notice && typeof notice === "object" && notice.hostId === this.options.hostId && typeof notice.dedupeKey === "string" &&
      typeof notice.category === "string" && notice.category in preference;
  }
  private validRecord(item: unknown): item is Registration {
    if (!item || typeof item !== "object") return false;
    const record = item as Registration;
    return typeof record.deviceId === "string" && typeof record.workspaceId === "string" && record.hostId === this.options.hostId &&
      validateMobilePushParams("notifications.register", {
        schemaVersion: record.schemaVersion, token: record.token, platform: record.platform, locale: record.locale, preferences: record.preferences,
      }) === null;
  }
  /** Moves the store to `push.json.quarantine-<time>` (same private mode, never read or printed) and keeps the newest three. */
  private setAside(): void {
    const directory = path.dirname(this.file);
    const prefix = `${path.basename(this.file)}.quarantine-`;
    try { fs.renameSync(this.file, path.join(directory, `${prefix}${Date.now()}`)); } catch { /* the next write replaces the file anyway */ }
    try {
      const old = fs.readdirSync(directory).filter(name => name.startsWith(prefix)).sort();
      for (const name of old.slice(0, Math.max(0, old.length - 3))) { try { fs.unlinkSync(path.join(directory, name)); } catch {} }
    } catch {}
    console.warn("[mobile-push] the push registration store could not be used as it was; it was set aside and push starts empty (phones register again when they connect)");
  }
  private persist(next: Registry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      this.registry = next;
    } finally { try { fs.unlinkSync(temporary); } catch {} }
  }
  private allowed(item: Registration): boolean {
    const active = this.options.currentWorkspaceId();
    return active !== null && active === item.workspaceId &&
      this.options.deviceWorkspaceId(item.deviceId) === item.workspaceId;
  }
  prune(): void {
    const active = this.options.currentWorkspaceId();
    const registrations = this.registry.registrations.filter(item =>
      this.options.deviceWorkspaceId(item.deviceId) === item.workspaceId &&
      (active === null || active === item.workspaceId));
    const pending = trimPending(this.pendingList(), this.clock());
    if (registrations.length !== this.registry.registrations.length || pending.length !== this.pendingList().length) this.persist({ ...this.registry, registrations, pending });
  }
  register(input: Record<string, unknown>, context: MobileBridgeConnectionContext): { registered: true; provider: "fcm"; hostId: string } {
    const invalid = validateMobilePushParams("notifications.register", input);
    if (invalid) throw new TypeError(invalid);
    const workspaceId = this.options.currentWorkspaceId();
    if (this.stopped || context.devBootstrap || !workspaceId ||
        this.options.deviceWorkspaceId(context.deviceId) !== workspaceId || context.devicePlatform !== input.platform) {
      throw new Error("mobile_push_authority_refused");
    }
    if (!this.options.supportsPlatform(input.platform as "ios" | "android")) throw new Error("mobile_push_provider_unavailable");
    this.prune();
    const registration: Registration = {
      ...(input as unknown as MobilePushRegistration), preferences: { ...(input as unknown as MobilePushRegistration).preferences },
      deviceId: context.deviceId, workspaceId, hostId: this.options.hostId,
    };
    // A rotated/re-paired installation cannot stay subscribed under two device
    // identities to the same physical token.
    const registrations = this.registry.registrations.filter(item => item.deviceId !== context.deviceId && item.token !== registration.token);
    if (registrations.length >= 128) throw new Error("mobile_push_registration_limit");
    this.persist({ ...this.registry, registrations: [...registrations, registration] });
    // A phone registers every time it connects: that is the "connection is back" signal for what could not be sent.
    if (this.pendingList().length > 0) void this.flushPending().catch(() => console.warn("[mobile-push] queue flush unavailable"));
    return { registered: true, provider: "fcm", hostId: this.options.hostId };
  }
  unregister(input: Record<string, unknown>, context: MobileBridgeConnectionContext): { registered: false } {
    const invalid = validateMobilePushParams("notifications.unregister", input);
    if (invalid) throw new TypeError(invalid);
    const workspaceId = this.options.currentWorkspaceId();
    if (context.devBootstrap || !workspaceId || this.options.deviceWorkspaceId(context.deviceId) !== workspaceId) throw new Error("mobile_push_authority_refused");
    this.persist({ ...this.registry, registrations: this.registry.registrations.filter(item =>
      item.deviceId !== context.deviceId || (input.token !== undefined && item.token !== input.token)) });
    return { registered: false };
  }
  async dispatch(notice: MobilePushNotice, stillCurrent: () => boolean = () => true): Promise<void> {
    if (this.stopped || notice.hostId !== this.options.hostId) return;
    this.prune();
    await Promise.all(this.registry.registrations.map(item => this.deliver(item, notice, stillCurrent, false)));
  }
  private pendingList(): PendingPush[] { return this.registry.pending ?? []; }
  private pendingKeyHeld(key: string): boolean { return this.pendingList().some(item => item.key === key); }
  /** Adds or refreshes one queue entry; the first queuedAt is kept so the 24 hours count from the first failure. Writes only on change. */
  private enqueue(key: string, deviceId: string, notice: MobilePushNotice, cause: PendingPush["cause"], notBefore: number): boolean {
    const now = this.clock();
    const existing = this.pendingList().find(item => item.key === key);
    if (existing && existing.cause === cause && (cause === "transient" || existing.notBefore === notBefore)) return false;
    const { body: _text, ...reference } = notice; // the id stays, the text is made again when it is sent
    const entry: PendingPush = { key, deviceId, notice: reference, cause, queuedAt: existing?.queuedAt ?? now, notBefore };
    try {
      this.persist({ ...this.registry, pending: trimPending([...this.pendingList().filter(item => item.key !== key), entry], now,
        count => console.warn(`[mobile-push] gave up category=${notice.category} reason=queue_full dropped=${count}`)) });
    }
    catch { console.warn("[mobile-push] the push queue could not be saved"); return false; }
    this.scheduleRelease();
    return true;
  }
  private dropPending(keys: string[]): Registry {
    if (keys.length === 0 || !this.pendingList().some(item => keys.includes(item.key))) return this.registry;
    return { ...this.registry, pending: this.pendingList().filter(item => !keys.includes(item.key)) };
  }
  /** One timer, for the earliest quiet-hours end. Connection and start signals cover the transient entries, so there is no polling. */
  private scheduleRelease(): void {
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
    if (this.stopped) return;
    const quiet = this.pendingList().filter(item => item.cause === "quiet");
    if (quiet.length === 0) return;
    const wait = Math.min(2 ** 31 - 1, Math.max(1_000, Math.min(...quiet.map(item => item.notBefore)) - this.clock()));
    this.releaseTimer = setTimeout(() => { this.releaseTimer = null; void this.flushPending().catch(() => console.warn("[mobile-push] queue flush unavailable")); }, wait);
    this.releaseTimer.unref?.();
  }
  /**
   * Sends what waited. Called when the phone registers (it does so on every connection), when the relay reports push ready,
   * once at start, and at the end of the owner's quiet hours. Quiet-hours check-ins go out as ONE push per phone (the newest;
   * its tap opens the conversation that holds all of them) and the older ones are marked delivered. Each queued push gets a
   * single attempt per signal: a failure keeps it queued with its original age.
   */
  async flushPending(): Promise<void> {
    if (this.stopped || this.flushing || this.pendingList().length === 0) return;
    this.flushing = true;
    try {
      const now = this.clock();
      const live = trimPending(this.pendingList(), now);
      if (live.length !== this.pendingList().length) { try { this.persist({ ...this.registry, pending: live }); } catch { /* retried at the next write */ } }
      const due = live.filter(item => item.notBefore <= now);
      const collapsed = new Set<string>();
      const batch: PendingPush[] = [];
      for (const item of [...due].reverse()) {
        if (item.cause === "quiet") {
          if (collapsed.has(item.deviceId)) { batch.push({ ...item, cause: "quiet", notBefore: -1 }); continue; }
          collapsed.add(item.deviceId);
        }
        batch.push(item);
      }
      const older = batch.filter(item => item.notBefore === -1).map(item => item.key);
      if (older.length > 0) {
        try { this.persist({ ...this.dropPending(older), delivered: [...this.registry.delivered, ...older].slice(-2048) }); } catch { /* the entries age out */ }
      }
      await Promise.all(batch.filter(item => item.notBefore !== -1).map(async entry => {
        const registration = this.registry.registrations.find(candidate => candidate.deviceId === entry.deviceId);
        if (!registration || !this.allowed(registration) || !registration.preferences[preference[entry.notice.category]] ||
            this.registry.delivered.includes(entry.key)) {
          try { this.persist(this.dropPending([entry.key])); } catch { /* ages out */ }
          return;
        }
        const still = this.options.revalidate?.(entry.notice);
        if (still === "keep") return; // the check could not run: stays queued for the next signal
        const resolved = still === false ? null : this.options.resolveBody ? this.options.resolveBody(entry.notice) : {};
        if (!resolved) { try { this.persist(this.dropPending([entry.key])); } catch { /* ages out */ } return; }
        // Sent now, so it carries now: the relay refuses a push whose occurredAt is more than an hour old (web mobile-push.mjs),
        // and a refused push leaves the queue. The dedupe key and message id stay, so the phone still shows it once.
        await this.deliver(registration, { ...entry.notice, occurredAt: new Date(this.clock()).toISOString(), ...(resolved.body ? { body: resolved.body } : {}) },
          () => this.options.revalidate?.(entry.notice) !== false, true);
      }));
    } finally { this.flushing = false; this.scheduleRelease(); }
  }
  private async deliver(item: Registration, notice: MobilePushNotice, stillCurrent: () => boolean, fromQueue: boolean): Promise<void> {
    const key = `${item.deviceId}:${notice.dedupeKey}`;
    if (this.queued.has(key) || this.registry.delivered.includes(key) || !item.preferences[preference[notice.category]]) return;
    const quiet = notice.quietEligible ? this.options.quietHours?.() ?? null : null;
    if (quiet && isOneQuietHour(quiet, new Date(this.clock()).getHours())) {
      // Quiet hours cover the whole day: no check-in ever rings, it only stays in the conversation, which the owner sees on opening
      // the app. Nothing is queued, because there is no end to wait for.
      if (quiet.startHour === quiet.endHour) {
        // A check-in queued before the owner made the whole day quiet is deleted now (its message stays in the conversation);
        // returning with it still queued would make the release timer fire again every second.
        if (this.pendingKeyHeld(key)) { try { this.persist(this.dropPending([key])); } catch { /* ages out */ } }
        return;
      }
      // A check-in One made while the owner sleeps waits for the end of the quiet hours; a chat answer never does.
      this.enqueue(key, item.deviceId, notice, "quiet", quietHoursEnd(quiet, this.clock()));
      return;
    }
    if (!fromQueue && this.pendingKeyHeld(key)) return; // the same notice is already waiting; its flush sends it
    if (this.queued.size >= 256) return;
    this.queued.add(key);
    const expires = this.clock() + (this.options.expiryMs ?? 90_000);
    let last: MobilePushOutcome | null = null;
    const attempts = fromQueue ? 1 : 3;
    try {
      for (let attempt = 0; attempt < attempts && this.clock() < expires; attempt++) {
        const current = this.registry.registrations.find(candidate => candidate.deviceId === item.deviceId && candidate.token === item.token);
        // Re-evaluate on every retry, after token rotation, account changes,
        // pairing revocation and preference updates; never reuse stale consent.
        if (this.stopped || !stillCurrent() || !current || !this.allowed(current) || !current.preferences[preference[notice.category]]) {
          if (fromQueue) { try { this.persist(this.dropPending([key])); } catch { /* ages out */ } }
          return;
        }
        let outcome: MobilePushOutcome;
        const { quietEligible: _host, ...wire } = notice;
        try { outcome = await this.options.publish({ token: current.token, platform: current.platform, locale: current.locale, notification: { ...wire, deviceId: current.deviceId } }); }
        catch { outcome = "unavailable"; }
        if (this.stopped) return;
        last = outcome;
        if (outcome === "accepted") {
          this.persist({ ...this.dropPending([key]), delivered: [...this.registry.delivered, key].slice(-2048) });
          return;
        }
        if (outcome === "unregistered") {
          this.persist({ ...this.dropPending([key]), registrations: this.registry.registrations.filter(candidate => candidate.deviceId !== current.deviceId || candidate.token !== current.token) });
          console.warn(`[mobile-push] gave up category=${notice.category} reason=token_unregistered queued=false`);
          return;
        }
        if (outcome === "refused") {
          this.persist(this.dropPending([key]));
          console.warn(`[mobile-push] gave up category=${notice.category} reason=refused queued=false`);
          return;
        }
        if (attempt === attempts - 1) break;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, Math.min((this.options.retryMs ?? 2_000) * 2 ** attempt, Math.max(0, expires - this.clock())));
          this.timers.set(timer, resolve); timer.unref?.();
        });
      }
      if (this.stopped) return;
      // Out of attempts or out of time while the relay/FCM stayed unreachable (network, 5xx, 429): keep it for the next signal.
      // `last` is null only when the window was already spent before a first try; that is the same transient case.
      const transient = last === null || last === "unavailable";
      if (transient) {
        if (this.enqueue(key, item.deviceId, notice, "transient", this.clock())) {
          console.warn(`[mobile-push] gave up category=${notice.category} reason=unavailable queued=true`);
        }
      }
    } finally { this.queued.delete(key); }
  }
  dispose(): void {
    this.stopped = true;
    for (const [timer, resolve] of this.timers) { clearTimeout(timer); resolve(); }
    this.timers.clear();
    if (this.releaseTimer) { clearTimeout(this.releaseTimer); this.releaseTimer = null; }
  }
}
