import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { MobileBridgeConnectionContext } from "./server";
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
interface Registry { version: 1; registrations: Registration[]; delivered: string[] }
export interface MobilePushServiceOptions {
  userDataPath: string;
  hostId: string;
  currentWorkspaceId(): string | null;
  deviceWorkspaceId(deviceId: string): string | null;
  supportsPlatform(platform: "ios" | "android"): boolean;
  publish(payload: MobilePushRelayPayload): Promise<MobilePushOutcome>;
  retryMs?: number;
  expiryMs?: number;
}
const preference = { oneMessage: "one", resultReady: "completed", failure: "failures", approval: "approval" } as const;

/** Device-bound subscriptions; no phone-presence heuristic can suppress a push. */
export class MobilePushService {
  private readonly file: string;
  private registry: Registry;
  private readonly queued = new Set<string>();
  private readonly timers = new Map<NodeJS.Timeout, () => void>();
  private stopped = false;
  constructor(private readonly options: MobilePushServiceOptions) {
    this.file = path.join(options.userDataPath, "mobile-bridge", "push.json");
    this.registry = this.read();
    this.prune();
  }
  private read(): Registry {
    if (!fs.existsSync(this.file)) return { version: 1, registrations: [], delivered: [] };
    if (fs.statSync(this.file).size > 4 * 1024 * 1024) throw new Error("mobile_push_store_invalid");
    const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Registry;
    if (raw.version !== 1 || !Array.isArray(raw.registrations) || raw.registrations.length > 128 ||
      !Array.isArray(raw.delivered) || raw.delivered.length > 2048 || raw.delivered.some(id => typeof id !== "string" || id.length > 1024) ||
      raw.registrations.some(item => !item || typeof item.deviceId !== "string" || typeof item.workspaceId !== "string" ||
        item.hostId !== this.options.hostId || validateMobilePushParams("notifications.register", {
          schemaVersion: item.schemaVersion, token: item.token, platform: item.platform, locale: item.locale, preferences: item.preferences,
        }) !== null)) throw new Error("mobile_push_store_invalid");
    return raw;
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
    if (registrations.length !== this.registry.registrations.length) this.persist({ ...this.registry, registrations });
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
    await Promise.all(this.registry.registrations.map(item => this.deliver(item, notice, stillCurrent)));
  }
  private async deliver(item: Registration, notice: MobilePushNotice, stillCurrent: () => boolean): Promise<void> {
    const key = `${item.deviceId}:${notice.dedupeKey}`;
    if (this.queued.has(key) || this.registry.delivered.includes(key) || !item.preferences[preference[notice.category]]) return;
    if (this.queued.size >= 256) return;
    this.queued.add(key);
    const expires = Date.now() + (this.options.expiryMs ?? 90_000);
    try {
      for (let attempt = 0; attempt < 3 && Date.now() < expires; attempt++) {
        const current = this.registry.registrations.find(candidate => candidate.deviceId === item.deviceId && candidate.token === item.token);
        // Re-evaluate on every retry, after token rotation, account changes,
        // pairing revocation and preference updates; never reuse stale consent.
        if (this.stopped || !stillCurrent() || !current || !this.allowed(current) || !current.preferences[preference[notice.category]]) return;
        let outcome: MobilePushOutcome;
        try { outcome = await this.options.publish({ token: current.token, platform: current.platform, locale: current.locale, notification: { ...notice, deviceId: current.deviceId } }); }
        catch { outcome = "unavailable"; }
        if (this.stopped) return;
        if (outcome === "accepted") {
          this.persist({ ...this.registry, delivered: [...this.registry.delivered, key].slice(-2048) });
          return;
        }
        if (outcome === "unregistered") {
          this.persist({ ...this.registry, registrations: this.registry.registrations.filter(candidate => candidate.deviceId !== current.deviceId || candidate.token !== current.token) });
          return;
        }
        if (outcome === "refused" || attempt === 2) return;
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, Math.min((this.options.retryMs ?? 2_000) * 2 ** attempt, Math.max(0, expires - Date.now())));
          this.timers.set(timer, resolve); timer.unref?.();
        });
      }
    } finally { this.queued.delete(key); }
  }
  dispose(): void {
    this.stopped = true;
    for (const [timer, resolve] of this.timers) { clearTimeout(timer); resolve(); }
    this.timers.clear();
  }
}
