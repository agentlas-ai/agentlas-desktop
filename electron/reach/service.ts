import type { Actuator } from "./actuator";
import { exploreApp, type ExploreReport } from "./explorer";
import { isSensitiveApp } from "./explore-policy";
import { levelOf, isUsable, type ReachScan } from "./map";
import { findMenuWindow } from "./menu-probe";
import { bundleIdOfKey, findLiveCandidates, findRecordOf, firstWithWindow } from "./app-match";
import { repairDialogCapability } from "./repair";
import type { CapabilityRegistry } from "./registry";
import { MENU_COMMAND_TRAIT, type AppRecord, type Capability, type ReachMap } from "./types";

// The background half of Reach: it draws the map by itself, and, only while the owner's switch is on, quietly turns what it finds into
// things an agent can use, repairs what an update broke, and shares what was proven. It never shows anything and never asks anything.
//
//  - the map is built once for a new feature version (a first install or an update brings one), then refreshed daily; this needs no switch
//    and touches no app (it reads dictionaries and manifests);
//  - exploration (the GUI part) runs only with the switch on AND the owner away: idle for ten minutes, screen unlocked, on mains power,
//    no agent run in progress. The moment any of that stops being true it finishes the dialog it has open, closes it, and stops;
//  - turning the switch off stops it at once and lets the driver go.

export const REACH_FEATURE_VERSION = 2;

// The driver only drives screens on macOS in this version. Elsewhere the map is still built and read, and this is not an error to show.
export const GUI_UNSUPPORTED = "gui_not_supported_on_this_platform";

export interface ReachStamp { feature: number; appVersion: string; completedAt: number; installSignature?: string }

export interface ReachStatus {
  enabled: boolean;
  mapAt: string | null;
  apps: number;
  green: number;
  amber: number;
  gray: number;
  usable: number;
  exploring: boolean;
  lastError: string | null;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PowerPorts {
  idleSeconds(): number | null;
  onBattery(): boolean | null;
  locked(): boolean | null;
  // true while an agent run or another heavy job holds the machine
  busy(): boolean;
}

export interface ActuatorPorts {
  // Gets the driver onto the machine (download, hash and signature check) without starting it. Never throws: says why not.
  prepare(): Promise<{ ok: true } | { ok: false; error: string }>;
  // Starts the driver (preparing it first if needed). Never throws: says why not.
  ensure(): Promise<{ ok: true; actuator: Actuator } | { ok: false; error: string }>;
  release(): Promise<void>;
}

export interface ReachServicePorts {
  allowed(): boolean;
  exploreEnabled(): boolean;
  stamp: { get(): Promise<ReachStamp | null>; set(stamp: ReachStamp): Promise<void> };
  buildMap(): Promise<ReachScan>;
  // The set of installed apps in one short string (see install-watch.ts); when it moves between ticks an app was installed or removed.
  installSignature?(): Promise<string>;
  // An app whose dictionary could only be read while it runs is running now (so a scan can read it, without starting anything).
  dictionaryWaiting?(): Promise<boolean>;
  writeScan(scan: ReachScan): Promise<void>;
  readMap(): Promise<ReachMap | null>;
  registry: CapabilityRegistry;
  actuator: ActuatorPorts;
  power: PowerPorts;
  flushUploads(): Promise<void>;
  writeStatus(status: ReachStatus): void;
  appVersion: string;
  timers: Timers;
  now(): number;
  day(): string;
  log(line: string): void;
  // Waiting between screen steps. Absent: real timers; a gate passes an instant one.
  sleep?: (ms: number) => Promise<void>;
}

export interface ReachServiceOptions {
  firstDelayMs?: number;
  tickMs?: number;
  refreshMs?: number;
  // The shortest wait between two maps drawn because the set of installed apps moved (an installer touching many folders is one change).
  installRebuildMinMs?: number;
  idleRequiredSec?: number;
  stopBelowIdleSec?: number;
  explorePassMs?: number;
  appsPerPass?: number;
  cooldownMs?: number;
  watchdogMs?: number;
  // How many already-explored capabilities of one app are looked at again per pass.
  revisitsPerApp?: number;
}

const DEFAULTS: Required<ReachServiceOptions> = {
  firstDelayMs: 90_000,
  tickMs: 5 * 60_000,
  refreshMs: 24 * 3_600_000,
  installRebuildMinMs: 10 * 60_000,
  idleRequiredSec: 600,
  stopBelowIdleSec: 30,
  explorePassMs: 15 * 60_000,
  appsPerPass: 8,
  cooldownMs: 5 * 60_000,
  watchdogMs: 5_000,
  revisitsPerApp: 3,
};

export class ReachService {
  private readonly o: Required<ReachServiceOptions>;
  private timer: unknown = null;
  private watchdog: unknown = null;
  private stopped = true;
  private working = false;
  private abort: AbortController | null = null;
  private lastPassAt = 0;
  private provisionBackoffUntil = 0;
  private status: ReachStatus = { enabled: false, mapAt: null, apps: 0, green: 0, amber: 0, gray: 0, usable: 0, exploring: false, lastError: null };
  private mapBuilding = false;
  // One entry per job that last failed; a job clears its own entry when it works again, so one job's success never hides another's failure.
  private readonly errors = new Map<string, string>();

  constructor(private readonly p: ReachServicePorts, options: ReachServiceOptions = {}) {
    this.o = { ...DEFAULTS, ...options };
  }

  start(): void {
    if (!this.p.allowed() || !this.stopped) return;
    this.stopped = false;
    this.schedule(this.o.firstDelayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) this.p.timers.clearTimeout(this.timer);
    this.timer = null;
    this.stopWatchdog();
    this.abort?.abort();
    await this.p.actuator.release();
  }

  // The switch was flipped. Off: stop everything now. On: start soon, but not at once (the owner just opened Settings).
  notifyExploreChanged(enabled: boolean): void {
    if (this.stopped) return;
    if (!enabled) {
      this.abort?.abort();
      void this.p.actuator.release();
      this.publish({ exploring: false, enabled: false });
      return;
    }
    this.publish({ enabled: true });
    this.schedule(60_000);
  }

  getStatus(): ReachStatus { return { ...this.status }; }

  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.p.timers.clearTimeout(this.timer);
    this.timer = this.p.timers.setTimeout(() => { this.timer = null; void this.tick(); }, ms);
  }

  private setError(source: string, code: string | null): void {
    if (code === null) this.errors.delete(source); else { this.errors.delete(source); this.errors.set(source, code); }
    const latest = [...this.errors.values()].at(-1) ?? null;
    if (latest !== this.status.lastError) this.publish({ lastError: latest });
  }

  private publish(change: Partial<ReachStatus>): void {
    this.status = { ...this.status, ...change };
    try { this.p.writeStatus(this.status); } catch { /* a status that cannot be written must not stop the work */ }
  }

  // One round: map if due, then (switch on) the driver, exploration and the upload. Always re-arms itself.
  async tick(): Promise<void> {
    if (this.stopped || this.working) { this.schedule(this.o.tickMs); return; }
    this.working = true;
    try {
      await this.ensureMap();
      const enabled = this.p.exploreEnabled();
      this.publish({ enabled });
      if (!enabled) { await this.p.actuator.release(); this.publish({ exploring: false }); return; }
      // Downloading the driver does not disturb anyone, so it does not wait for the owner to be away.
      await this.safely("prepare", () => this.prepareDriver(), false); // it reports its own result
      // Explore first: what the revisit proved today is what goes out first (the server takes 30 requests an hour per installation, and the
      // bulk of published descriptions must not use that up before the proven ones are eligible).
      await this.safely("explore", () => this.explorePass());
      await this.safely("upload", () => this.p.flushUploads());
    } finally {
      this.working = false;
      this.schedule(this.o.tickMs);
    }
  }

  private async prepareDriver(): Promise<void> {
    if (this.p.now() < this.provisionBackoffUntil) return;
    const ready = await this.p.actuator.prepare();
    if (!ready.ok && ready.error === GUI_UNSUPPORTED) return;
    if (!ready.ok) {
      this.provisionBackoffUntil = this.p.now() + 3_600_000;
      this.setError("prepare", ready.error);
    } else this.setError("prepare", null);
  }

  private async safely(what: string, work: () => Promise<void>, clearOnSuccess = true): Promise<void> {
    try { await work(); if (clearOnSuccess) this.setError(what, null); } catch (error) {
      this.p.log(`[reach] ${what} failed: ${error instanceof Error ? error.name : "error"}`);
      this.setError(what, `${what}_failed`);
    }
  }

  // ---- the map ------------------------------------------------------------------------------------------------------------------
  private async ensureMap(): Promise<void> {
    if (this.mapBuilding || this.stopped) return;
    const stamp = await this.p.stamp.get();
    // Read before anything is built: an app installed while the map is being drawn moves the signature, and the next tick sees it.
    const signature = await this.p.installSignature?.().catch(() => undefined);
    const installed = !!stamp && stamp.installSignature !== undefined && signature !== undefined && signature !== stamp.installSignature
      && this.p.now() - stamp.completedAt >= this.o.installRebuildMinMs;
    // Drawn for a new feature version (a first install and an update that changes Reach both bring one), when the apps on the machine
    // changed, and at the latest once a day. None of this needs the switch and none of it says anything to the owner.
    const aged = !stamp || stamp.feature < REACH_FEATURE_VERSION || installed || this.p.now() - stamp.completedAt > this.o.refreshMs;
    // An app the owner just opened whose dictionary is only readable while it runs: draw again (at most as often as for an installation).
    const waiting = !aged && !!stamp && this.p.now() - stamp.completedAt >= this.o.installRebuildMinMs && (await this.p.dictionaryWaiting?.().catch(() => false)) === true;
    const due = aged || waiting;
    if (!due) {
      // A stamp written before the signature existed learns it now, without drawing the map again.
      if (stamp && stamp.installSignature === undefined && signature !== undefined) await this.p.stamp.set({ ...stamp, installSignature: signature });
      await this.refreshStatusFromDisk();
      return;
    }
    if (this.p.power.busy()) return; // try again next tick
    this.mapBuilding = true;
    try {
      const scan = await this.p.buildMap();
      await this.p.writeScan(scan);
      await this.p.stamp.set({ feature: REACH_FEATURE_VERSION, appVersion: this.p.appVersion, completedAt: this.p.now(), ...(signature !== undefined ? { installSignature: signature } : {}) });
      this.publishMap(scan.map);
    } catch (error) {
      this.p.log(`[reach] map failed: ${error instanceof Error ? error.name : "error"}`);
    } finally {
      this.mapBuilding = false;
    }
  }

  private publishMap(map: ReachMap): void {
    this.publish({
      mapAt: map.generatedAt, apps: map.totals.apps, green: map.totals.byLevel.scriptable, amber: map.totals.byLevel.partial, gray: map.totals.byLevel.unmapped, usable: map.totals.usable,
    });
  }

  private async refreshStatusFromDisk(): Promise<void> {
    if (this.status.apps > 0) return;
    const map = await this.p.readMap();
    if (map) this.publishMap(map);
  }

  // The map's levels follow what exploration proved: recount from the stored map plus the registry, without reading any app again.
  private async recount(): Promise<void> {
    const map = await this.p.readMap();
    if (!map) return;
    let green = 0; let amber = 0; let gray = 0; let usable = 0;
    for (const app of map.apps) {
      const learned = await this.p.registry.capabilities(app.key);
      const extra = learned.filter(isUsable).length;
      const total = app.usableCount + extra;
      usable += total;
      const level = levelOf(total, app.capabilityCount + learned.length > 0);
      if (level === "scriptable") green += 1; else if (level === "partial") amber += 1; else gray += 1;
    }
    this.publish({ green, amber, gray, usable });
  }

  // ---- exploration and repair ----------------------------------------------------------------------------------------------------
  private away(): boolean {
    const idle = this.p.power.idleSeconds();
    return idle !== null && idle >= this.o.idleRequiredSec && this.p.power.locked() === false && this.p.power.onBattery() === false && !this.p.power.busy();
  }

  private stillAway(): boolean {
    const idle = this.p.power.idleSeconds();
    return this.p.exploreEnabled() && idle !== null && idle >= this.o.stopBelowIdleSec && this.p.power.locked() !== true && this.p.power.onBattery() !== true && !this.p.power.busy();
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) this.p.timers.clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private armWatchdog(): void {
    this.stopWatchdog();
    const check = (): void => {
      if (!this.abort || this.abort.signal.aborted) return;
      if (!this.stillAway()) { this.abort.abort(); return; }
      this.watchdog = this.p.timers.setTimeout(check, this.o.watchdogMs);
    };
    this.watchdog = this.p.timers.setTimeout(check, this.o.watchdogMs);
  }

  private async explorePass(): Promise<void> {
    if (!this.away()) return;
    if (this.p.now() - this.lastPassAt < this.o.cooldownMs) return;
    if (this.p.now() < this.provisionBackoffUntil) return;
    const map = await this.p.readMap();
    if (!map) return;
    const ready = await this.p.actuator.ensure();
    if (!ready.ok) {
      // An agent is using the screen right now: not a failure, look again next round.
      if (ready.error === "gui_busy" || ready.error === GUI_UNSUPPORTED) return;
      this.provisionBackoffUntil = this.p.now() + 3_600_000;
      this.setError("ensure", ready.error);
      return;
    }
    this.setError("ensure", null);
    this.publish({ exploring: true });
    this.abort = new AbortController();
    this.armWatchdog();
    const signal = this.abort.signal;
    const deadline = this.p.now() + this.o.explorePassMs;
    try {
      const running = await ready.actuator.listApps({ signal });
      const targets: Array<{ app: AppRecord; bundleId?: string; name: string }> = [];
      for (const live of running.filter((item) => item.running)) {
        const record = findRecordOf(live, map.apps);
        if (!record || targets.some((target) => target.app.key === record.key) || isSensitiveApp({ name: live.name, bundleId: live.bundleId }) || isSensitiveApp({ name: record.name, bundleId: bundleIdOfKey(record.key) ?? undefined })) continue;
        targets.push({ app: record, ...(live.bundleId ? { bundleId: live.bundleId } : {}), name: live.name });
      }
      // unexplored and weaker apps first; an app explored for this fingerprint goes last
      const order = new Map<string, number>();
      for (const target of targets) {
        const file = await this.p.registry.read(target.app.key);
        const done = !!file?.exploredAt && file.fingerprint === target.app.fingerprint;
        order.set(target.app.key, (done ? 100 : 0) + (target.app.level === "scriptable" ? 10 : 0));
      }
      targets.sort((a, b) => (order.get(a.app.key) ?? 0) - (order.get(b.app.key) ?? 0));

      let explored = 0;
      for (const target of targets) {
        if (signal.aborted || this.p.now() > deadline || explored >= this.o.appsPerPass) break;
        const file = await this.p.registry.read(target.app.key);
        if (file?.exploredAt && file.fingerprint === target.app.fingerprint && !(await this.hasDegraded(target.app.key)) && !(await this.hasStale(target.app.key)) && !(await this.hasMenuCommandToRevive(target.app.key, file.exploredAt))) continue;
        const report = await this.exploreOne(ready.actuator, target, signal, Math.max(5_000, deadline - this.p.now()));
        explored += 1;
        this.p.log(`[reach] explored ${report.app}: ${report.verified} verified, ${report.failed} failed${report.skipped ? `, skipped ${report.skipped}` : ""}${report.blocked ? ", blocked" : ""}`);
        await this.recount();
        if (report.blocked) break;
      }
      this.lastPassAt = this.p.now();
    } finally {
      this.stopWatchdog();
      this.abort = null;
      this.publish({ exploring: false });
      // The driver is only kept while there is work for it.
      await this.p.actuator.release();
    }
  }

  private async hasStale(appKey: string): Promise<boolean> {
    const today = this.p.day();
    return (await this.p.registry.capabilities(appKey)).some((capability) => capability.tier === "explored" && capability.status === "verified" && capability.body?.kind === "steps" && capability.evidence?.lastSeenDay !== today);
  }

  // A plain menu command a call found gone is looked for again in the menu bar once a day (the sighting revives it); nothing is pressed for it.
  private async hasMenuCommandToRevive(appKey: string, exploredAt: string): Promise<boolean> {
    if (exploredAt.slice(0, 10) === this.p.day()) return false;
    return (await this.p.registry.capabilities(appKey)).some((capability) => capability.tier === "structure" && capability.status === "degraded" && capability.traits?.includes(MENU_COMMAND_TRAIT) === true);
  }

  private async hasDegraded(appKey: string): Promise<boolean> {
    // Only a dialog capability is repaired by opening its dialog again. A plain menu command that was refused (the item was gone, or switched off) is
    // never "repaired": repairing would press it. It is revived by the next natural look at the menu bar (registry.upsert), so it does not
    // call an app back for another pass either.
    return (await this.p.registry.capabilities(appKey)).some((capability) => capability.tier === "explored" && capability.status === "degraded" && capability.body?.kind === "steps");
  }

  private async exploreOne(actuator: Actuator, target: { app: AppRecord; bundleId?: string; name: string }, signal: AbortSignal, remainingMs: number): Promise<ExploreReport> {
    const common = { actuator, registry: this.p.registry, day: () => this.p.day(), now: () => this.p.now(), shouldStop: () => signal.aborted || !this.stillAway(), signal, log: (line: string) => this.p.log(line), ...(this.p.sleep ? { sleep: this.p.sleep } : {}) };
    // repair first: something that worked and then stopped is worth more than something new
    const degraded = (await this.p.registry.capabilities(target.app.key)).filter((capability) => capability.tier === "explored" && capability.status === "degraded" && capability.body?.kind === "steps");
    // one budget for the whole app: the repairs and the daily look come out of the same time as the exploration (review 3, R3)
    const until = this.p.now() + Math.min(240_000, remainingMs);
    if (degraded.length > 0) await this.repair(actuator, target, degraded, signal, until);
    await this.revisit(actuator, target, signal, until);
    // the app gets at most the time that is left of this pass (it was only checked before an app was started, so a pass could run a whole app past its end)
    return exploreApp(common, { key: target.app.key, name: target.name, ...(target.bundleId ? { bundleId: target.bundleId } : {}), fingerprint: target.app.fingerprint, sensors: target.app.signals.some((signal) => signal.startsWith("sensor:")) }, { maxMillis: Math.max(1_000, Math.min(240_000, until - this.p.now())) });
  }

  // The window that carries the app's menu bar now, or null when it has none on screen.
  private async liveWindow(actuator: Actuator, target: { app: AppRecord; bundleId?: string; name: string }, signal: AbortSignal): Promise<{ pid: number; windowId: number } | null> {
    const apps = await actuator.listApps({ signal });
    const found = await firstWithWindow(findLiveCandidates(target.app, apps), (live) => findMenuWindow(actuator, live.pid, signal));
    return found ? found.window : null;
  }

  // What was explored is looked at again once a day: a dialog that is still there as it was earns another day of evidence (what makes it
  // worth sharing); one that changed is rewritten with a new revision; one that is gone is marked failed so the next round repairs or
  // drops it, before an agent runs into it.
  private async revisit(actuator: Actuator, target: { app: AppRecord; bundleId?: string; name: string }, signal: AbortSignal, until: number): Promise<void> {
    const today = this.p.day();
    const stale = (await this.p.registry.capabilities(target.app.key))
      .filter((capability) => capability.tier === "explored" && capability.status === "verified" && capability.body?.kind === "steps" && capability.evidence?.lastSeenDay !== today)
      .slice(0, this.o.revisitsPerApp);
    if (stale.length === 0) return;
    const at = await this.liveWindow(actuator, target, signal);
    if (!at) return;
    for (const capability of stale) {
      if (signal.aborted || !this.stillAway() || this.p.now() >= until) return; // what is left waits for the next round
      const result = await repairDialogCapability({ actuator, target: at, appKey: target.app.key, fingerprint: target.app.fingerprint, day: today, signal, ...(this.p.sleep ? { sleep: this.p.sleep } : {}) }, capability);
      if (result.status === "repaired") {
        const unchanged = result.how === "same" && JSON.stringify(result.capability.parameters) === JSON.stringify(capability.parameters);
        await this.p.registry.upsert(target.app.key, target.app.fingerprint, [unchanged ? capability : result.capability], today);
      } else {
        await this.p.registry.recordOutcome(target.app.key, target.app.fingerprint, capability.id, { ok: false, code: result.reason }, today);
      }
    }
  }

  private async repair(actuator: Actuator, target: { app: AppRecord; bundleId?: string; name: string }, degraded: Capability[], signal: AbortSignal, until: number): Promise<void> {
    const at = await this.liveWindow(actuator, target, signal);
    if (!at) return;
    for (const capability of degraded) {
      if (signal.aborted || !this.stillAway() || this.p.now() >= until) return;
      const attemptKey = `repair:${capability.id}`;
      if (await this.p.registry.shouldSkip(target.app.key, attemptKey)) continue;
      const result = await repairDialogCapability({ actuator, target: at, appKey: target.app.key, fingerprint: target.app.fingerprint, day: this.p.day(), signal, ...(this.p.sleep ? { sleep: this.p.sleep } : {}) }, capability);
      if (result.status === "repaired") {
        await this.p.registry.upsert(target.app.key, target.app.fingerprint, [result.capability], this.p.day());
        await this.p.registry.recordAttempt(target.app.key, target.app.fingerprint, attemptKey, true, "ok", this.p.day());
        this.p.log(`[reach] repaired ${capability.name} (${result.how})`);
      } else {
        await this.p.registry.recordAttempt(target.app.key, target.app.fingerprint, attemptKey, false, result.reason, this.p.day());
      }
    }
  }

  // A real call just finished (the agent used a capability). Success proves it; failure marks it, and the next idle round repairs it.
  async onInvokeOutcome(appKey: string, fingerprint: string, capabilityId: string, outcome: { ok: boolean; code?: string; repairable?: boolean }): Promise<void> {
    try {
      await this.p.registry.recordOutcome(appKey, fingerprint, capabilityId, outcome, this.p.day());
      if (!this.stopped) this.schedule(this.p.exploreEnabled() ? 2 * 60_000 : this.o.tickMs);
    } catch (error) {
      this.p.log(`[reach] outcome not recorded: ${error instanceof Error ? error.name : "error"}`);
    }
  }
}
