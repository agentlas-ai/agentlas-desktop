/**
 * Desktop Alive lifetime store — generalized port of agentlas-science/src/alive/lifetime-store.ts.
 *
 * Differences from the Science copy (which another session owns and which stays unchanged):
 *  - Action validation and claim use the action registry (./action-registry) instead of the single
 *    science.continue_research shape; the claimed packet must carry exactly the proposal's fence.
 *  - An optional agent scope predicate lets two organisms (work-organism, one-organism) share these side
 *    tables in the desktop DB without reconciling, dispatching, or listing each other's lives.
 *  - Science's per-wake MCP tool principal is not ported: One/Work wakes receive no tool grant.
 *
 * Tables are side tables created idempotently (like goal_plan_nodes); the schema ladder is not bumped.
 * Main is the single writer.
 */
import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { AliveActionPacket, AliveActionProposal, AliveActionResult, AliveAgent, AliveAttachment, AliveBudget, AliveRuntimeReceipt } from "./contracts";
import { validAliveAction } from "./action-registry";

type Row = Record<string, any>;
const SHA256 = /^[a-f0-9]{64}$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
// Failed actions remain retryable on the same observed world. The ceiling limits
// retry frequency, not the lifetime of an otherwise authorized agent.
const ACTION_RETRY_DELAYS_MS = [30_000, 120_000, 480_000, 960_000, 1_800_000] as const;
const actionRetryDelayMs = (failures: number): number =>
  ACTION_RETRY_DELAYS_MS[Math.min(failures, ACTION_RETRY_DELAYS_MS.length) - 1];
/** Canonical JSON of a flat fence: key order is not identity. */
const fenceJson = (value: Record<string, unknown>): string =>
  JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
export interface AliveActionReservation {
  actionId: string; wakeId: string; agentId: string; controlEpoch: number;
  status: "reserved" | "executing"; proposal: AliveActionProposal; packet: AliveActionPacket | null;
}
function validateBudget(budget: AliveBudget): void {
  if (!(Number.isSafeInteger(budget.tokensUsed) && budget.tokensUsed >= 0)
    || (budget.tokenLimit !== null && !(Number.isSafeInteger(budget.tokenLimit) && budget.tokenLimit > 0))
    || (budget.deadlineMs !== null && !(Number.isSafeInteger(budget.deadlineMs) && budget.deadlineMs > 0))) throw new Error("alive-budget-invalid");
}
export const aliveStableId = (key: string): string => {
  const h = createHash("sha256").update(key).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The host owns the database. No lifetime row depends on a playground row or its deletion. */
export class AliveLifetimeStore {
  static ensureSchema(db: Database.Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS alive_agents (
        agent_id TEXT PRIMARY KEY, purpose TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('enabled','suspended','retired')),
        control_epoch INTEGER NOT NULL DEFAULT 0, state_json TEXT NOT NULL CHECK(json_valid(state_json)),
        budget_json TEXT NOT NULL CHECK(json_valid(budget_json)), runtime_binding_json TEXT NOT NULL CHECK(json_valid(runtime_binding_json)),
        version INTEGER NOT NULL DEFAULT 1, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS alive_attachments (
        attachment_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES alive_agents(agent_id), domain TEXT NOT NULL,
        scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), status TEXT NOT NULL CHECK(status IN ('attached','detached')));
      CREATE TABLE IF NOT EXISTS alive_events (
        event_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES alive_agents(agent_id), sequence INTEGER NOT NULL,
        kind TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), created_at_ms INTEGER NOT NULL,
        UNIQUE(agent_id,sequence));
      CREATE TABLE IF NOT EXISTS alive_wakes (
        wake_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES alive_agents(agent_id), control_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','running','completed','failed','cancelled','interrupted')),
        runtime_binding_json TEXT NOT NULL CHECK(json_valid(runtime_binding_json)), receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
        created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS alive_one_active_wake ON alive_wakes(agent_id) WHERE status IN ('reserved','running');
      CREATE TABLE IF NOT EXISTS alive_actions (
        action_id TEXT PRIMARY KEY, wake_id TEXT NOT NULL UNIQUE REFERENCES alive_wakes(wake_id),
        agent_id TEXT NOT NULL REFERENCES alive_agents(agent_id), control_epoch INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('reserved','executing','completed','failed')),
        proposal_json TEXT NOT NULL CHECK(json_valid(proposal_json)),
        packet_json TEXT CHECK(packet_json IS NULL OR json_valid(packet_json)),
        result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
        created_at_ms INTEGER NOT NULL, settled_at_ms INTEGER);
      CREATE INDEX IF NOT EXISTS alive_pending_actions ON alive_actions(agent_id,status) WHERE status IN ('reserved','executing');
      CREATE TRIGGER IF NOT EXISTS alive_events_no_update BEFORE UPDATE ON alive_events BEGIN SELECT RAISE(ABORT,'alive-event-immutable'); END;
      CREATE TRIGGER IF NOT EXISTS alive_events_no_delete BEFORE DELETE ON alive_events BEGIN SELECT RAISE(ABORT,'alive-event-immutable'); END;
    `);
  }
  private readonly inScope: (agentId: string) => boolean;
  constructor(readonly db: Database.Database, options: { initializeSchema?: boolean;
    /** Lives this store instance lists, reconciles and dispatches. Omitted = every life. */
    agentScope?: (agentId: string) => boolean } = {}) {
    if (options.initializeSchema !== false) AliveLifetimeStore.ensureSchema(db);
    this.inScope = options.agentScope ?? (() => true);
  }
  /** Whether this store instance's organism owns the life. */
  owns(agentId: string): boolean { return this.inScope(agentId); }
  get(agentId: string): AliveAgent | null {
    const row = this.db.prepare("SELECT * FROM alive_agents WHERE agent_id=?").get(agentId) as Row | undefined;
    return row ? { agentId, purpose: row.purpose, status: row.status, controlEpoch: row.control_epoch,
      state: JSON.parse(row.state_json), budget: JSON.parse(row.budget_json), runtimeBinding: JSON.parse(row.runtime_binding_json), version: row.version } : null;
  }
  list(): AliveAgent[] {
    return (this.db.prepare("SELECT agent_id FROM alive_agents ORDER BY created_at_ms,agent_id").all() as Row[])
      .filter((r) => this.inScope(r.agent_id)).map((r) => this.get(r.agent_id)!);
  }
  create(input: { agentId: string; purpose: string; budget: AliveBudget; runtimeBinding: unknown; state?: Record<string, unknown>; enabled?: boolean }, nowMs: number): AliveAgent {
    if (!input.agentId || !input.purpose.trim() || input.purpose.length > 20_000) throw new Error("alive-agent-input-invalid");
    validateBudget(input.budget);
    return this.db.transaction(() => {
      const existing = this.get(input.agentId); if (existing) return existing;
      this.db.prepare("INSERT INTO alive_agents(agent_id,purpose,status,state_json,budget_json,runtime_binding_json,created_at_ms,updated_at_ms) VALUES (?,?,?,?,?,?,?,?)")
        .run(input.agentId, input.purpose, input.enabled === false ? "suspended" : "enabled", JSON.stringify(input.state ?? {}), JSON.stringify(input.budget), JSON.stringify(input.runtimeBinding ?? null), nowMs, nowMs);
      this.event(input.agentId, "agent.created", { purpose: input.purpose }, nowMs);
      return this.get(input.agentId)!;
    })();
  }
  update(agentId: string, patch: { state?: Record<string, unknown>; budget?: AliveBudget; runtimeBinding?: unknown }, nowMs: number): void {
    if (patch.budget) validateBudget(patch.budget);
    const current = this.get(agentId); if (!current) throw new Error("alive-agent-not-found");
    const changed = this.db.prepare("UPDATE alive_agents SET state_json=?,budget_json=?,runtime_binding_json=?,version=version+1,updated_at_ms=? WHERE agent_id=? AND version=?")
      .run(JSON.stringify(patch.state ?? current.state), JSON.stringify(patch.budget ?? current.budget), JSON.stringify("runtimeBinding" in patch ? patch.runtimeBinding ?? null : current.runtimeBinding), nowMs, agentId, current.version);
    if (changed.changes !== 1) throw new Error("alive-agent-version-conflict");
  }
  setEnabled(agentId: string, enabled: boolean, reasonCode: string, nowMs: number): void {
    this.db.transaction(() => {
      const agent = this.get(agentId); if (!agent || agent.status === "retired" || (agent.status === "enabled") === enabled) return;
      this.db.prepare("UPDATE alive_agents SET status=?,control_epoch=control_epoch+1,version=version+1,updated_at_ms=? WHERE agent_id=?")
        .run(enabled ? "enabled" : "suspended", nowMs, agentId);
      this.event(agentId, enabled ? "agent.enabled" : "agent.suspended", { reasonCode }, nowMs);
    })();
  }
  attach(input: AliveAttachment, nowMs: number): void {
    this.db.transaction(() => {
      const old = this.db.prepare("SELECT * FROM alive_attachments WHERE attachment_id=?").get(input.attachmentId) as Row | undefined;
      if (old && (old.agent_id !== input.agentId || old.domain !== input.domain)) throw new Error("alive-attachment-binding-conflict");
      const scope = JSON.stringify(input.scope);
      if (old?.scope_json === scope && old.status === input.status) return;
      this.db.prepare("INSERT INTO alive_attachments(attachment_id,agent_id,domain,scope_json,status) VALUES (?,?,?,?,?) ON CONFLICT(attachment_id) DO UPDATE SET scope_json=excluded.scope_json,status=excluded.status")
        .run(input.attachmentId, input.agentId, input.domain, scope, input.status);
      this.event(input.agentId, `attachment.${input.status}`, { attachmentId: input.attachmentId, domain: input.domain }, nowMs);
    })();
  }
  attachments(agentId: string): AliveAttachment[] {
    return (this.db.prepare("SELECT * FROM alive_attachments WHERE agent_id=? ORDER BY attachment_id").all(agentId) as Row[])
      .map((r) => ({ attachmentId: r.attachment_id, agentId, domain: r.domain, scope: JSON.parse(r.scope_json), status: r.status }));
  }
  event(agentId: string, kind: string, payload: unknown, nowMs: number): void {
    this.db.prepare("INSERT INTO alive_events(event_id,agent_id,sequence,kind,payload_json,created_at_ms) SELECT ?,?,COALESCE(MAX(sequence),0)+1,?,?,? FROM alive_events WHERE agent_id=?")
      .run(randomUUID(), agentId, kind, JSON.stringify(payload), nowMs, agentId);
  }
  events(agentId: string): Array<{ kind: string; payload: any }> {
    return (this.db.prepare("SELECT kind,payload_json FROM alive_events WHERE agent_id=? ORDER BY sequence").all(agentId) as Row[]).map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload_json) }));
  }
  activeWakes(): Array<{ wakeId: string; agentId: string; controlEpoch: number; status: string; createdAtMs: number }> {
    return (this.db.prepare("SELECT * FROM alive_wakes WHERE status IN ('reserved','running') ORDER BY created_at_ms").all() as Row[])
      .filter((r) => this.inScope(r.agent_id))
      .map((r) => ({ wakeId: r.wake_id, agentId: r.agent_id, controlEpoch: r.control_epoch, status: r.status, createdAtMs: r.created_at_ms }));
  }
  /** Most recent settled wakes of one life, newest first (status projection and receipts only). */
  recentWakes(agentId: string, limit = 5): Array<{ wakeId: string; status: string; receipt: AliveRuntimeReceipt | null; createdAtMs: number; settledAtMs: number | null }> {
    return (this.db.prepare("SELECT * FROM alive_wakes WHERE agent_id=? ORDER BY created_at_ms DESC LIMIT ?").all(agentId, Math.max(1, Math.min(50, limit))) as Row[])
      .map((r) => {
        let receipt: AliveRuntimeReceipt | null = null;
        try { receipt = r.receipt_json ? JSON.parse(r.receipt_json) : null; } catch { receipt = null; }
        return { wakeId: r.wake_id, status: r.status, receipt, createdAtMs: r.created_at_ms, settledAtMs: r.settled_at_ms ?? null };
      });
  }
  wakeAgentId(wakeId: string): string | null {
    const row = this.db.prepare("SELECT agent_id FROM alive_wakes WHERE wake_id=?").get(wakeId) as Row | undefined;
    return row ? row.agent_id : null;
  }
  pendingActions(): AliveActionReservation[] {
    return (this.db.prepare("SELECT * FROM alive_actions WHERE status IN ('reserved','executing') ORDER BY created_at_ms,action_id").all() as Row[])
      .filter((r) => this.inScope(r.agent_id))
      .map((r) => ({ actionId: r.action_id, wakeId: r.wake_id, agentId: r.agent_id,
        controlEpoch: r.control_epoch, status: r.status, proposal: JSON.parse(r.proposal_json),
        packet: r.packet_json ? JSON.parse(r.packet_json) : null }));
  }
  claimAction(packet: AliveActionPacket, nowMs: number): boolean {
    return this.db.transaction(() => {
      const actionId = packet.actionId;
      const action = this.pendingActions().find((row) => row.actionId === actionId);
      if (!action || action.status !== "reserved") return false;
      if (packet.schema !== "agentlas.alive-action.v1" || packet.action !== action.proposal.kind
        || packet.attachmentId !== action.proposal.attachmentId
        || !packet.expected || typeof packet.expected !== "object"
        || fenceJson(packet.expected) !== fenceJson(action.proposal.expected)) return false;
      const agent = this.get(action.agentId);
      if (!agent || agent.status !== "enabled" || agent.controlEpoch !== action.controlEpoch
        || (agent.budget.deadlineMs !== null && nowMs >= agent.budget.deadlineMs)
        || (agent.budget.tokenLimit !== null && (agent.budget.tokensUsed >= agent.budget.tokenLimit || agent.state.usageUnknown === true))) {
        this.finishAction({ ok: false, actionId, code: "alive.action-admission-changed" }, nowMs);
        return false;
      }
      // A controller awakened by another playground may still propose an
      // action omitted from its capabilities. The prompt is not an
      // authority boundary: enforce the same failure cooldown at dispatch.
      if (agent.state.actionFailureEpoch === agent.controlEpoch
        && agent.state.actionFailureGrantRevision === (agent.state.grantRevision ?? null)
        && agent.state.actionFailureFingerprint === agent.state.lastActionWorldSha) {
        const code = typeof agent.state.actionBackoffUntilMs === "number" && nowMs < agent.state.actionBackoffUntilMs
          ? "alive.action-backoff" : null;
        if (code) {
          this.finishAction({ ok: false, actionId, code }, nowMs);
          return false;
        }
      }
      const result = this.db.prepare("UPDATE alive_actions SET status='executing',packet_json=? WHERE action_id=? AND status='reserved'")
        .run(JSON.stringify(packet), actionId);
      if (result.changes !== 1) return false;
      this.event(action.agentId, "action.dispatching", { actionId }, nowMs);
      return true;
    })();
  }
  finishAction(result: AliveActionResult, nowMs: number): boolean {
    if (typeof result.actionId !== "string" || typeof result.ok !== "boolean"
      || typeof result.code !== "string" || !/^[a-z][a-z0-9._-]{2,119}$/.test(result.code)
      || (result.ok && (!result.invocationRunId || !UUID.test(result.invocationRunId)))
      || (result.invocationRunId !== undefined && !UUID.test(result.invocationRunId))) return false;
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT agent_id,status,control_epoch FROM alive_actions WHERE action_id=?").get(result.actionId) as Row | undefined;
      if (!row || !["reserved", "executing"].includes(row.status)) return false;
      this.db.prepare("UPDATE alive_actions SET status=?,result_json=?,settled_at_ms=? WHERE action_id=?")
        .run(result.ok ? "completed" : "failed", JSON.stringify(result), nowMs, result.actionId);
      const agent = this.get(row.agent_id)!;
      const sameEpoch = agent.controlEpoch === row.control_epoch && agent.status === "enabled";
      const priorFailures = agent.state.actionFailureEpoch === agent.controlEpoch
        && agent.state.actionFailureGrantRevision === (agent.state.grantRevision ?? null)
        && agent.state.actionFailureFingerprint === agent.state.lastActionWorldSha
        && Number.isSafeInteger(agent.state.failedActions)
        && Number(agent.state.failedActions) >= 0 ? Number(agent.state.failedActions) : 0;
      // A denied proposal did not attempt a domain action. In particular, an
      // out-of-capability act during cooldown must not extend that cooldown.
      const attempted = row.status === "executing"
        || result.code !== "alive.action-backoff" && result.code !== "alive.action-failure-limit";
      const failures = result.ok ? 0 : sameEpoch && attempted
        ? Math.min(Number.MAX_SAFE_INTEGER, priorFailures + 1) : priorFailures;
      this.update(agent.agentId, { state: { ...agent.state,
        lastAction: { actionId: result.actionId, ok: result.ok, code: result.code,
          invocationRunId: result.invocationRunId ?? null, atMs: nowMs },
        ...(sameEpoch ? { actionFailureEpoch: agent.controlEpoch,
          actionFailureGrantRevision: agent.state.grantRevision ?? null,
          actionFailureFingerprint: agent.state.lastActionWorldSha ?? null, failedActions: failures,
          actionBackoffUntilMs: result.ok ? null : attempted
            ? Math.min(Number.MAX_SAFE_INTEGER, nowMs + actionRetryDelayMs(failures))
            : agent.state.actionBackoffUntilMs ?? null } : {}) } }, nowMs);
      this.event(row.agent_id, "action.settled", { actionId: result.actionId, ok: result.ok,
        code: result.code, invocationRunId: result.invocationRunId ?? null }, nowMs);
      return true;
    })();
  }
  reserve(agentId: string, expectedEpoch: number, reasonCode: string, nowMs: number): string | null {
    return this.db.transaction(() => {
      const agent = this.get(agentId);
      if (!agent || agent.status !== "enabled" || agent.controlEpoch !== expectedEpoch
        || (agent.budget.deadlineMs !== null && nowMs >= agent.budget.deadlineMs)
        || (agent.budget.tokenLimit !== null && agent.budget.tokensUsed >= agent.budget.tokenLimit)
        || this.activeWakes().some((w) => w.agentId === agentId)
        || this.pendingActions().some((action) => action.agentId === agentId)) return null;
      const wakeId = randomUUID();
      this.db.prepare("INSERT INTO alive_wakes(wake_id,agent_id,control_epoch,status,runtime_binding_json,created_at_ms) VALUES (?,?,?,'reserved',?,?)")
        .run(wakeId, agentId, expectedEpoch, JSON.stringify(agent.runtimeBinding), nowMs);
      this.event(agentId, "wake.reserved", { wakeId, reasonCode, controlEpoch: expectedEpoch }, nowMs);
      return wakeId;
    })();
  }
  markRunning(wakeId: string): void { this.db.prepare("UPDATE alive_wakes SET status='running' WHERE wake_id=? AND status='reserved'").run(wakeId); }
  /**
   * usageUnknown stays fail-closed: an unmeasured charge could overrun the grant. It was also permanent -- nothing ever
   * cleared it -- so one wake whose runtime reported no usage ended a token-bounded agent for good (live QA 2026-09-24:
   * a wake that failed before any provider call left the agent on grant.usage-unavailable forever). Ask the runtime
   * again for exactly the settled wakes whose receipt carried no count. Only when every one of them now reports a
   * measured count are those counts charged and the flag cleared; any still-unknown wake keeps the agent waiting.
   */
  recoverUnknownUsage(agentId: string, readReceipt: (wakeId: string) => AliveRuntimeReceipt | null, nowMs: number): boolean {
    const agent = this.get(agentId);
    if (!agent || agent.state.usageUnknown !== true) return false;
    const measured = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
    const rows = this.db.prepare(`SELECT wake_id, receipt_json FROM alive_wakes WHERE agent_id=?
      AND status IN ('completed','failed','cancelled','interrupted') AND receipt_json IS NOT NULL`).all(agentId) as Row[];
    // A receipt the owner already acknowledged as unmeasurable (acknowledgeUnknownUsage) is not waited on again.
    const unknown = rows.filter((row) => { try { const r = JSON.parse(row.receipt_json); return !measured(r.tokensUsed) && typeof r.usageAcknowledgedAtMs !== "number"; } catch { return true; } });
    if (!unknown.length) return false;
    const recovered: Array<{ wakeId: string; receipt: Record<string, unknown>; tokensUsed: number }> = [];
    for (const row of unknown) {
      let receipt: AliveRuntimeReceipt | null = null;
      try { receipt = readReceipt(row.wake_id); } catch { return false; }
      if (!receipt || receipt.runId !== row.wake_id || !measured(receipt.tokensUsed)) return false;
      let stored: Record<string, unknown>;
      try { stored = JSON.parse(row.receipt_json); } catch { stored = { runId: row.wake_id }; }
      recovered.push({ wakeId: row.wake_id, receipt: { ...stored, tokensUsed: receipt.tokensUsed }, tokensUsed: receipt.tokensUsed });
    }
    const tokensUsed = recovered.reduce((total, item) => total + item.tokensUsed, 0);
    this.db.transaction(() => {
      for (const item of recovered) this.db.prepare("UPDATE alive_wakes SET receipt_json=? WHERE wake_id=?").run(JSON.stringify(item.receipt), item.wakeId);
      this.update(agentId, { budget: { ...agent.budget, tokensUsed: agent.budget.tokensUsed + tokensUsed },
        state: { ...agent.state, usageUnknown: false,
          controllerTokensUsed: Number(agent.state.controllerTokensUsed ?? 0) + tokensUsed } }, nowMs);
      this.event(agentId, "usage.recovered", { wakeIds: recovered.map((item) => item.wakeId), tokensUsed }, nowMs);
    })();
    return true;
  }
  /**
   * The owner's way out of a permanently unknown charge (desktop addition; Science keeps its own rule).
   * A wake killed after its provider attempt started (crash, force quit) can never report usage, so
   * recoverUnknownUsage alone would keep a token-bounded life waiting forever. Only an explicit owner
   * re-grant (setting the token limit) calls this: those exact wakes are stamped acknowledged (their charge
   * stays unknown and is never invented), the flag clears, and the event records which wakes were waived.
   */
  acknowledgeUnknownUsage(agentId: string, nowMs: number): string[] {
    const agent = this.get(agentId);
    if (!agent || agent.state.usageUnknown !== true) return [];
    const measured = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT wake_id, receipt_json FROM alive_wakes WHERE agent_id=?
        AND status IN ('completed','failed','cancelled','interrupted') AND receipt_json IS NOT NULL`).all(agentId) as Row[];
      const waived: string[] = [];
      for (const row of rows) {
        let receipt: Record<string, unknown>;
        try { receipt = JSON.parse(row.receipt_json); } catch { receipt = { runId: row.wake_id }; }
        if (measured(receipt.tokensUsed) || typeof receipt.usageAcknowledgedAtMs === "number") continue;
        this.db.prepare("UPDATE alive_wakes SET receipt_json=? WHERE wake_id=?").run(JSON.stringify({ ...receipt, usageAcknowledgedAtMs: nowMs }), row.wake_id);
        waived.push(row.wake_id);
      }
      this.update(agentId, { state: { ...agent.state, usageUnknown: false } }, nowMs);
      this.event(agentId, "usage.unknown-acknowledged", { wakeIds: waived }, nowMs);
      return waived;
    })();
  }
  settle(receipt: AliveRuntimeReceipt, nowMs: number): boolean {
    if (!["completed", "failed", "cancelled", "interrupted"].includes(receipt.status)) return false;
    return this.db.transaction(() => {
      const wake = this.db.prepare("SELECT * FROM alive_wakes WHERE wake_id=?").get(receipt.runId) as Row | undefined;
      if (!wake || !["reserved", "running"].includes(wake.status)) return false;
      const agent = this.get(wake.agent_id)!;
      const usageKnown = Number.isSafeInteger(receipt.tokensUsed) && receipt.tokensUsed! >= 0;
      const tokenUse = usageKnown ? receipt.tokensUsed! : 0;
      const errorCode = typeof receipt.errorCode === "string" && /^[a-z][a-z0-9._-]{2,119}$/.test(receipt.errorCode)
        ? receipt.errorCode : null;
      const runtimeBindingSha256 = createHash("sha256").update(wake.runtime_binding_json).digest("hex");
      const decision = receipt.decision;
      const validDecision = receipt.status === "completed" && decision && ["wait", "review", "act"].includes(decision.kind)
        && typeof decision.reason === "string" && decision.reason.length > 0 && decision.reason.length <= 500
        && (decision.nextWakeAtMs === null || (Number.isSafeInteger(decision.nextWakeAtMs) && decision.nextWakeAtMs >= 0))
        && (decision.kind !== "act" || validAliveAction(decision.action));
      // A completed review without a structured decision rests until observations change.
      // Failed calls use finite backoff; neither path guesses intent from the model's prose.
      const failures = receipt.status === "completed" ? 0 : Number(agent.state.failedReviews ?? 0) + 1;
      const nextWakeAtMs = validDecision ? (decision.nextWakeAtMs === null ? null : Math.max(nowMs + 60_000, decision.nextWakeAtMs!))
        : receipt.status === "completed" || errorCode === "agy_read_tools_unsupported"
          ? null : failures <= 3 ? nowMs + [30_000, 120_000, 480_000][failures - 1] : null;
      this.db.prepare("UPDATE alive_wakes SET status=?,receipt_json=?,settled_at_ms=? WHERE wake_id=?")
        .run(receipt.status, JSON.stringify(receipt), nowMs, receipt.runId);
      const sameEpoch = agent.controlEpoch === wake.control_epoch && agent.status === "enabled";
      const withinGrant = (agent.budget.deadlineMs === null || nowMs < agent.budget.deadlineMs)
        && (agent.budget.tokenLimit === null || (usageKnown && !agent.state.usageUnknown
          && agent.budget.tokensUsed + tokenUse < agent.budget.tokenLimit));
      this.update(agent.agentId, { budget: { ...agent.budget, tokensUsed: agent.budget.tokensUsed + tokenUse }, state: { ...agent.state,
        controllerTokensUsed: Number(agent.state.controllerTokensUsed ?? 0) + tokenUse,
        usageUnknown: Boolean(agent.state.usageUnknown) || (!usageKnown && agent.budget.tokenLimit !== null),
        ...(sameEpoch ? { nextWakeAtMs, lastReviewAtMs: nowMs, reviewPending: false, failedReviews: failures,
          lastReview: { runId: receipt.runId, status: receipt.status, errorCode,
            runtimeBindingSha256, grantRevision: agent.state.grantRevision ?? null,
            finalText: receipt.finalText?.slice(0, 16_000) ?? null, decision: validDecision ? decision : null } } : {}) } }, nowMs);
      this.event(agent.agentId, "wake.settled", { wakeId: receipt.runId, status: receipt.status,
        errorCode, sameEpoch, tokensUsed: tokenUse }, nowMs);
      if (validDecision && decision.kind === "act" && sameEpoch && withinGrant) {
        this.db.prepare("INSERT INTO alive_actions(action_id,wake_id,agent_id,control_epoch,status,proposal_json,created_at_ms) VALUES (?,?,?,?,'reserved',?,?)")
          .run(receipt.runId, receipt.runId, agent.agentId, wake.control_epoch, JSON.stringify(decision.action), nowMs);
        this.event(agent.agentId, "action.reserved", { actionId: receipt.runId, wakeId: receipt.runId,
          kind: decision.action.kind, attachmentId: decision.action.attachmentId }, nowMs);
      } else if (decision?.kind === "act") {
        this.event(agent.agentId, "action.rejected", { wakeId: receipt.runId,
          reasonCode: !validDecision ? "alive.action-invalid" : !sameEpoch ? "alive.action-epoch-changed" : "alive.action-grant-spent" }, nowMs);
      }
      return true;
    })();
  }
}
