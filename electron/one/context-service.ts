import { randomUUID } from "node:crypto";
import type { OneContextCapture, OneContextGrant, OneContextGrantInput, OneContextLeaseState, OneContextReadiness, OneContextScope, OneContextSnapshot, OneContextTarget, OneContextTargetSelection } from "../../shared/one-context";

export class OneContextError extends Error { constructor(readonly code: string) { super(code); this.name = "OneContextError"; } }
export interface ContextTarget extends OneContextTarget {
  fingerprint: string;
  owned?: boolean;
  pid?: number;
  processStartMs?: number;
  bounds?: { x: number; y: number; width: number; height: number };
}
export interface OneContextPorts {
  activeOneId(): string;
  assertTask(scope: OneContextScope): void;
  readiness(): OneContextReadiness;
  targets(kind: "window" | "display"): Promise<ContextTarget[]>;
  current(target: ContextTarget): Promise<boolean>;
  capture(target: ContextTarget, signal: AbortSignal): Promise<{ dataUrl: string; capturedAt: string }>;
  leaseState(): OneContextLeaseState;
  revokeLease(grantId: string, reasonCode: string): void;
  now?(): number;
  changed?(oneId: string): void;
}
interface HeldGrant { grant: OneContextGrant; target: ContextTarget; controller: AbortController; timer: NodeJS.Timeout; captureGeneration: number }
interface Selection extends OneContextScope { expiresAt: number; targets: ContextTarget[] }
const publicTarget = (target: ContextTarget): OneContextTarget => ({ kind: target.kind, sourceId: target.sourceId, label: target.label,
  captureAvailable: target.captureAvailable, interactionAvailable: target.interactionAvailable });
function id(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value !== value.trim() || /[\u0000-\u001f]/.test(value)) throw new OneContextError("one-context-invalid-identity");
  return value;
}
function object(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new OneContextError("one-context-invalid-input");
  return value as Record<string, unknown>;
}
const FALLBACK_READINESS = (): OneContextReadiness => ({ available: false, platform: process.platform, screenPermission: "unknown", accessibility: "unknown",
  session: "unknown", driverAvailable: false, humanBusy: true, observedAt: new Date().toISOString(), reasonCode: "one-context-readiness-unavailable" });

/** Session-only opt-in authority. Pixels are not retained in history, durable storage, transcripts or grant responses; platform capture may use a temporary file cleaned in finally. */
export class OneContextService {
  private grants = new Map<string, HeldGrant>();
  private selections = new Map<string, Selection>();
  private epochs = new Map<string,number>();
  private latest = new Map<string, OneContextCapture>();
  constructor(private readonly ports: OneContextPorts) {}
  private now(): number { return this.ports.now?.() ?? Date.now(); }
  private scope(value: Record<string, unknown>): OneContextScope {
    const scope = { oneId: id(value.oneId), taskId: id(value.taskId) };
    if (scope.oneId !== this.ports.activeOneId()) throw new OneContextError("one-context-identity-changed");
    this.ports.assertTask(scope); return scope;
  }
  private readiness(): OneContextReadiness { try { return this.ports.readiness(); } catch { return FALLBACK_READINESS(); } }
  private stop(record: HeldGrant, reason: string): void {
    if (record.grant.state !== "active") return;
    record.grant.state = reason === "one-context-expired" ? "expired" : "revoked";
    record.grant.reasonCode = reason;
    clearTimeout(record.timer); record.controller.abort();
    this.latest.delete(record.grant.grantId);
    this.ports.revokeLease(record.grant.grantId, reason);
    this.ports.changed?.(record.grant.oneId);
  }
  private prune(): void {
    const now = this.now();
    for (const record of this.grants.values()) if (Date.parse(record.grant.expiresAt) <= now) this.stop(record, "one-context-expired");
    for (const [key, selection] of this.selections) if (selection.expiresAt <= now) this.selections.delete(key);
    while (this.grants.size > 64) {
      const removable = [...this.grants].find(([, record]) => record.grant.state !== "active");
      if (!removable) break; this.grants.delete(removable[0]);
    }
  }
  private view(oneId: string, taskId?: string): OneContextSnapshot {
    this.prune();
    const readiness = this.readiness();
    const records = [...this.grants.values()].filter(record => record.grant.oneId === oneId && (!taskId || record.grant.taskId === taskId));
    const latest = records.map(record => this.latest.get(record.grant.grantId)).filter((value): value is OneContextCapture => !!value)
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt))[0] ?? null;
    return { oneId, observedAt: new Date(this.now()).toISOString(), grants: records.map(record => ({ ...record.grant, target: { ...record.grant.target } })), readiness,
      latest: latest ? { ...latest, target: { ...latest.target }, state: Date.parse(latest.staleAt) > this.now() ? "fresh" : "stale" } : null,
      lease: this.ports.leaseState() };
  }
  snapshot(value: unknown): OneContextSnapshot {
    const input = object(value, ["oneId"], ["taskId"]), oneId = id(input.oneId);
    if (oneId !== this.ports.activeOneId()) { this.revoke({ oneId }); throw new OneContextError("one-context-identity-changed"); }
    const taskId = input.taskId === undefined ? undefined : this.scope(input).taskId;
    const ready = this.readiness();
    if (ready.session !== "awake") this.blockSession(`one-context-${ready.session}`);
    return this.view(oneId, taskId);
  }
  async targets(value: unknown): Promise<OneContextTargetSelection> {
    const input = object(value, ["oneId", "taskId", "kind"]), scope = this.scope(input);
    if (input.kind !== "window" && input.kind !== "display") throw new OneContextError("one-context-invalid-target-kind");
    if (this.readiness().session !== "awake") throw new OneContextError("one-context-session-unavailable");
    const epoch=this.epochs.get(scope.oneId)??0;this.epochs.set(scope.oneId,epoch);
    const targets = await this.ports.targets(input.kind);
    if(epoch!==(this.epochs.get(scope.oneId)??0))throw new OneContextError("one-context-selection-revoked");
    this.scope(scope as unknown as Record<string, unknown>);
    if (this.readiness().session !== "awake") throw new OneContextError("one-context-session-unavailable");
    this.prune(); if (this.selections.size >= 64) throw new OneContextError("one-context-selection-capacity");
    const selectionId = randomUUID(), expiresAt = this.now() + 60_000;
    this.selections.set(selectionId, { ...scope, expiresAt, targets: targets.slice(0, 300) });
    return { selectionId, expiresAt: new Date(expiresAt).toISOString(), targets: targets.slice(0, 300).map(publicTarget) };
  }
  async grant(value: unknown): Promise<OneContextSnapshot> {
    const input = object(value, ["oneId", "taskId", "selectionId", "sourceId", "durationMs", "mode"]), scope = this.scope(input);
    this.prune(); const selection = this.selections.get(id(input.selectionId));
    if (!selection || selection.oneId !== scope.oneId || selection.taskId !== scope.taskId) throw new OneContextError("one-context-selection-stale");
    if (!Number.isSafeInteger(input.durationMs) || Number(input.durationMs) < 30_000 || Number(input.durationMs) > 30 * 60_000) throw new OneContextError("one-context-invalid-lifetime");
    if (input.mode !== "observe" && input.mode !== "interact") throw new OneContextError("one-context-invalid-mode");
    const target = selection.targets.find(candidate => candidate.sourceId === id(input.sourceId));
    if (!target || !await this.ports.current(target)) throw new OneContextError("one-context-target-stale");
    if(this.selections.get(String(input.selectionId))!==selection || selection.expiresAt<=this.now())throw new OneContextError("one-context-selection-stale");
    this.scope(input); const ready = this.readiness();
    if (ready.session !== "awake" || !target.captureAvailable || (!target.owned && ready.screenPermission !== "granted")) throw new OneContextError("one-context-capture-unavailable");
    if (input.mode === "interact" && (!target.interactionAvailable || !ready.driverAvailable || ready.accessibility !== "granted")) throw new OneContextError("one-context-input-unavailable");
    for (const held of this.grants.values()) if (held.grant.oneId === scope.oneId && held.grant.taskId === scope.taskId) this.stop(held, "one-context-replaced");
    if ([...this.grants.values()].filter(record => record.grant.state === "active").length >= 32) throw new OneContextError("one-context-grant-capacity");
    const now = this.now(), grantId = randomUUID();
    const grant: OneContextGrant = { ...scope, grantId, target: publicTarget(target), mode: input.mode, createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + Number(input.durationMs)).toISOString(), state: "active" };
    const controller = new AbortController();
    const timer = setTimeout(() => { const held = this.grants.get(grantId); if (held) this.stop(held, "one-context-expired"); }, Number(input.durationMs)); timer.unref?.();
    this.grants.set(grantId, { grant, target, controller, timer, captureGeneration: 0 }); this.selections.delete(String(input.selectionId)); this.ports.changed?.(scope.oneId);
    return this.view(scope.oneId, scope.taskId);
  }
  revoke(value: unknown): OneContextSnapshot {
    const input = object(value, ["oneId"], ["grantId"]), oneId = id(input.oneId), grantId = input.grantId === undefined ? undefined : id(input.grantId);
    this.epochs.set(oneId,(this.epochs.get(oneId)??0)+1);
    // Stop never depends on provider, current task, OS permission or fresh account metadata.
    for (const held of this.grants.values()) if (held.grant.oneId === oneId && (!grantId || held.grant.grantId === grantId)) this.stop(held, "one-context-revoked");
    for (const [key, selection] of this.selections) if (selection.oneId === oneId) this.selections.delete(key);
    return this.view(oneId);
  }
  authorize(scope: OneContextScope & { grantId: string }, mode: "observe" | "interact" = "observe"): { grant: OneContextGrant; target: ContextTarget; signal: AbortSignal; assertCurrent(): void } {
    this.prune(); const held = this.grants.get(id(scope.grantId));
    const assertCurrent = () => {
      this.prune(); this.scope(scope as unknown as Record<string, unknown>);
      if (!held || held.grant.oneId !== scope.oneId || held.grant.taskId !== scope.taskId || held.grant.state !== "active" || held.controller.signal.aborted
        || mode === "interact" && held.grant.mode !== "interact") throw new OneContextError("one-context-grant-unavailable");
      const ready = this.readiness();
      if (ready.session !== "awake" || !held.target.owned && ready.screenPermission !== "granted") { this.stop(held, "one-context-session-unavailable"); throw new OneContextError("one-context-session-unavailable"); }
      if (mode === "interact" && (!ready.driverAvailable || ready.accessibility !== "granted")) throw new OneContextError("one-context-input-unavailable");
    };
    assertCurrent(); return { grant: held!.grant, target: held!.target, signal: held!.controller.signal, assertCurrent };
  }
  async capture(value: unknown): Promise<OneContextSnapshot> {
    const input = object(value, ["oneId", "taskId", "grantId"]), scope = this.scope(input), permission = this.authorize({ ...scope, grantId: id(input.grantId) });
    if (!await this.ports.current(permission.target)) throw new OneContextError("one-context-target-stale");
    permission.assertCurrent();
    const held=this.grants.get(permission.grant.grantId)!;const generation=++held.captureGeneration;
    const captured = await this.ports.capture(permission.target, permission.signal);
    permission.assertCurrent();
    if (!await this.ports.current(permission.target)) throw new OneContextError("one-context-target-stale");
    permission.assertCurrent();
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(captured.dataUrl) || captured.dataUrl.length > 8_000_000) throw new OneContextError("one-context-capture-invalid");
    if(generation!==held.captureGeneration)throw new OneContextError("one-context-capture-superseded");
    const capturedAt = Number.isFinite(Date.parse(captured.capturedAt)) ? captured.capturedAt : new Date(this.now()).toISOString();
    this.latest.set(permission.grant.grantId, { grantId: permission.grant.grantId, target: publicTarget(permission.target), capturedAt,
      staleAt: new Date(this.now() + 30_000).toISOString(), state: "fresh", dataUrl: captured.dataUrl });
    this.ports.changed?.(scope.oneId); return this.view(scope.oneId, scope.taskId);
  }
  blockSession(reason: string): void { for(const oneId of new Set([...this.epochs.keys(),...this.grants.values()].map(value=>typeof value==="string"?value:value.grant.oneId)))this.epochs.set(oneId,(this.epochs.get(oneId)??0)+1); for (const held of this.grants.values()) this.stop(held, reason); this.selections.clear(); }
  dispose(): void { this.blockSession("one-context-host-closed"); this.grants.clear(); this.latest.clear(); }
}
let configured: OneContextService | null = null;
export function configureOneContextService(service: OneContextService): void { configured?.dispose(); configured = service; }
export function oneContextService(): OneContextService { if (!configured) throw new OneContextError("one-context-host-unavailable"); return configured; }
