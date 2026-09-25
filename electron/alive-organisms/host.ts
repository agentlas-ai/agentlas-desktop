/**
 * Alive organisms for One and Work — Main-owned lives on the desktop DB.
 *
 *   work-organism: one life per Work project (alive:work-project:v1:<projectId>). It is the project's orchestrator,
 *                  attached to the chat where AGI was turned on and following that chat's ongoing Goal(s).
 *                  At most one per project: enabling from another chat returns a conflict; moveFrom moves it.
 *                  Enabling needs a Goal in that chat at that moment (alive-goal-required); afterwards the life
 *                  stays on at project level and waits (goal.none) between that chat's Goals.
 *   one-organism:  one life per One Goal (alive:one-goal:v1:<goalId>) — the orchestrator for that room's Goal.
 *                  Seats stay workers. When the Goal ends the life is suspended (attachment.goal-terminal).
 *
 * Each organism has its own clock owner (work-organism / one-organism), its own store scope and lifetime service
 * over the shared alive_* side tables. Before every beat the dashboard role-pool order is refreshed; a wake is
 * admitted only when some member can run now (otherwise wait code model.order-exhausted, never a failed wake).
 * Token limit reached = the life sleeps on grant.tokens-spent; raising the limit continues it.
 */
import type Database from "better-sqlite3";
import type { AliveAgent, AliveAttachment, AliveClockPort, AliveWakeRuntimeRecord } from "../alive-core/contracts";
import type { RuntimeStatus } from "../../shared/types";
import type { AliveAgentAccess } from "../billing";
import { AliveLifetimeStore, aliveStableId } from "../alive-core/lifetime-store";
import { AliveLifetimeService } from "../alive-core/lifetime-service";
import { GoalAlivePlayground, attachedGoalId, type GoalPlaygroundDeps } from "./goal-playground";
import { GoalAliveRuntime } from "./goal-runtime";
import { LightWakeRunner, type LightWakeDeps } from "./light-wake";
import { ALIVE_POOL_RUNTIME_POLICY, aliveSelectionFromPool, type AliveModelOrderEntry } from "./model-order";
import { ALIVE_DEFAULT_TOKEN_LIMIT, ALIVE_MAX_TOKEN_LIMIT, type AliveChangedEvent, type AliveModelOrderItem,
  type AliveSetEnabledInput, type AliveSetTokenLimitInput, type AliveState, type AliveStatus, type AliveSurface } from "../../shared/alive";

export type AliveOrganism = "work" | "one";

export class AliveHostError extends Error {
  constructor(readonly code: string, message = code) { super(`[agentlas:code=${code}] ${message}`); this.name = "AliveHostError"; }
}

export interface AliveHostDeps {
  db: Database.Database;
  now(): number;
  processStartedAtMs: number;
  clock: AliveClockPort;
  intervalMs: number;
  playground: GoalPlaygroundDeps;
  /** The light decision-only runner's edges (runtime runner pick, cooldown note, timeout). */
  light: Pick<LightWakeDeps, "pickRunner" | "noteFailure" | "timeoutMs">;
  /** Minimum spacing between unchanged-world wakes, escalating by consecutive unchanged reviews. */
  reviewFloorsMs?: readonly number[];
  /** Quiet period after an accepted action (the playground's own next step changes the world meanwhile). */
  actionSpacingMs?: number;
  projectName(projectId: string): string | null;
  controllerInstalled(): boolean;
  refreshModelOrder(facts: (status: RuntimeStatus) => readonly string[]): Promise<AliveModelOrderEntry[]>;
  cachedModelOrder(): AliveModelOrderEntry[];
  checkPlanAccess(): Promise<AliveAgentAccess>;
  emit(event: AliveChangedEvent): void;
  registerShutdown?(stop: () => void): void;
  /** Goal/chat store changes (goal deleted, ended, cancelled, rebound). Returns an unsubscribe. */
  onGoalStoreChanged?(listener: () => void): () => void;
}

/** No wake for this long after an action the goal accepted. */
export const ALIVE_ACTION_SPACING_MS = 10 * 60_000;
/** Spacing between model wakes while the observed world is unchanged. */
export const ALIVE_REVIEW_FLOORS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

const WORK_KEY = (projectId: string) => `alive:work-project:v1:${projectId}`;
const ONE_KEY = (goalId: string) => `alive:one-goal:v1:${goalId}`;
const ID = /^[A-Za-z0-9._:-]{1,200}$/;
const BLOCKED_WAITS = new Set(["model.order-exhausted", "runtime.selection-unavailable", "playground.observation-unavailable",
  "runtime.read-tools-unsupported", "grant.deadline-spent", "action.backoff",
  "alive-sign-in-required", "alive-plan-required", "alive-entitlement-unavailable"]);

function ensureLivesSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS alive_organism_lives (
    agent_id TEXT PRIMARY KEY, organism TEXT NOT NULL CHECK(organism IN ('work','one')),
    life_key TEXT NOT NULL UNIQUE, scope_id TEXT NOT NULL, created_at_ms INTEGER NOT NULL)`);
}

interface Organism {
  kind: AliveOrganism;
  store: AliveLifetimeStore;
  playground: GoalAlivePlayground;
  runtime: GoalAliveRuntime;
  service: AliveLifetimeService;
  releaseClock: (() => void) | null;
  beating: boolean;
  digests: Map<string, string>;
}

export class AliveOrganismHost {
  private readonly lives = new Map<string, AliveOrganism>();
  private readonly organisms: Record<AliveOrganism, Organism>;
  private running = false;
  private unsubscribeSettled: Array<() => void> = [];
  private readonly light: LightWakeRunner;
  private planAccess: AliveAgentAccess = "alive-entitlement-unavailable";
  private accessRefresh: Promise<AliveAgentAccess> | null = null;

  constructor(private readonly deps: AliveHostDeps) {
    AliveLifetimeStore.ensureSchema(deps.db);
    ensureLivesSchema(deps.db);
    for (const row of deps.db.prepare("SELECT agent_id, organism FROM alive_organism_lives").all() as Array<{ agent_id: string; organism: AliveOrganism }>) {
      this.lives.set(row.agent_id, row.organism);
    }
    this.light = new LightWakeRunner({ ...deps.light, db: deps.db, processStartedAtMs: deps.processStartedAtMs, now: deps.now });
    const floors = deps.reviewFloorsMs ?? ALIVE_REVIEW_FLOORS_MS;
    const build = (kind: AliveOrganism): Organism => {
      const store = new AliveLifetimeStore(deps.db, { initializeSchema: false, agentScope: (agentId) => this.lives.get(agentId) === kind });
      const playground = new GoalAlivePlayground(kind, deps.db, deps.playground);
      const runtime = new GoalAliveRuntime(store, { organism: kind, processStartedAtMs: deps.processStartedAtMs, now: deps.now,
        light: this.light, resolveSelection: () => aliveSelectionFromPool(deps.cachedModelOrder()) });
      const service = new AliveLifetimeService(store, runtime, new Map([[kind, playground]]), {
        clock: deps.now,
        // No member can run now: a visible wait, re-checked every beat (cooldowns expire on their own).
        admission: () => this.planAccess !== "allowed"
          ? this.planAccess
          : aliveSelectionFromPool(deps.cachedModelOrder()) ? null : "model.order-exhausted",
        actionAdmission: () => this.planAccess === "allowed" ? null : this.planAccess,
        refreshActionAdmission: async () => {
          const access = await this.refreshPlanAccess();
          return access === "allowed" ? null : access;
        },
        // Nothing changed: never every beat. 5m → 15m → 60m between unchanged reviews; a salience change wakes now.
        actionSpacingMs: deps.actionSpacingMs ?? ALIVE_ACTION_SPACING_MS,
        reviewFloorMs: (agent) => floors[Math.min(floors.length - 1, Math.max(0, Number(agent.state.unchangedReviews ?? 0)))] ?? 0,
      });
      return { kind, store, playground, runtime, service, releaseClock: null, beating: false, digests: new Map() };
    };
    this.organisms = { work: build("work"), one: build("one") };
  }

  /** App ready (after DB migration). Enabled lives resume on their own: the first beat reconciles lost wakes. */
  start(): void {
    if (this.running) return;
    this.running = true;
    for (const organism of Object.values(this.organisms)) {
      organism.service.setAdmission(true);
      organism.releaseClock = this.deps.clock.schedule({ ownerId: `${organism.kind}-organism`, intervalMs: this.deps.intervalMs,
        onBeat: () => { void this.beat(organism.kind); } });
    }
    // A wake settles outside a beat: tell the screens now, not at the next beat.
    for (const kind of ["work", "one"] as const) {
      this.unsubscribeSettled.push(this.organisms[kind].runtime.onSettled(() => { setImmediate(() => this.emitChanges(kind)); }));
    }
    // A Goal that ends, is deleted or cancelled between beats: re-beat soon (suspends a finished One life) and
    // tell the screens now. Debounced — the store can emit several changes for one owner action.
    if (this.deps.onGoalStoreChanged) {
      let pending: ReturnType<typeof setTimeout> | null = null;
      this.unsubscribeSettled.push(this.deps.onGoalStoreChanged(() => {
        if (pending || !this.running) return;
        pending = setTimeout(() => {
          pending = null;
          for (const kind of ["work", "one"] as const) void this.beat(kind);
        }, 750);
        pending.unref?.();
      }));
    }
    this.deps.registerShutdown?.(() => this.stop());
    for (const kind of ["work", "one"] as const) void this.beat(kind);
  }

  /**
   * Quit/SIGTERM: close admission, release clocks and stop listening for settlements (the DB is about to close).
   * Durable rows carry every life to the next launch; a wake cut off here is reconciled from its durable
   * invocation receipt (or hostLost) by the next process. Final: a stopped host is not restarted.
   */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.light.cancelAll();
    for (const organism of Object.values(this.organisms)) {
      organism.service.close();
      try { organism.releaseClock?.(); } catch { /* clock already released */ }
      organism.releaseClock = null;
    }
    for (const unsubscribe of this.unsubscribeSettled.splice(0)) { try { unsubscribe(); } catch { /* already gone */ } }
  }

  close(): void { this.stop(); }

  isRunning(): boolean { return this.running; }

  /** Share overlapping reads, then fetch again for each later enable or beat. */
  refreshPlanAccess(): Promise<AliveAgentAccess> {
    if (this.accessRefresh) return this.accessRefresh;
    const pending = Promise.resolve().then(() => this.deps.checkPlanAccess())
      .catch((): AliveAgentAccess => "alive-entitlement-unavailable")
      .then((access) => {
        this.planAccess = access;
        return access;
      })
      .finally(() => { this.accessRefresh = null; });
    this.accessRefresh = pending;
    return pending;
  }

  /** One organism beat: refresh the pool order, heartbeat, end finished One lives, broadcast changes. */
  async beat(kind: AliveOrganism): Promise<void> {
    const organism = this.organisms[kind];
    if (!this.running || organism.beating) return;
    organism.beating = true;
    try {
      try { await this.deps.refreshModelOrder((status) => this.light.facts(status)); } catch { /* the last cached order stays authoritative */ }
      if (!this.running) return;
      // A prior grant never authorizes a new wake after a downgrade.
      await this.refreshPlanAccess();
      if (!this.running) return;
      // A One life ends with its Goal: suspend before the heartbeat so a finished Goal costs no model turn.
      if (kind === "one") this.suspendFinishedOneLives();
      organism.service.heartbeat(this.deps.now());
    } catch (error) {
      console.warn(`[alive-organisms] ${kind} beat failed`, error);
    } finally {
      organism.beating = false;
      this.emitChanges(kind);
    }
  }

  private suspendFinishedOneLives(): void {
    const organism = this.organisms.one;
    for (const agent of organism.store.list()) {
      if (agent.status !== "enabled") continue;
      const attachment = organism.store.attachments(agent.agentId).find((row) => row.status === "attached");
      if (!attachment) continue;
      let terminal = false;
      try { terminal = organism.playground.observe(attachment, this.deps.now()).work === "terminal"; } catch { terminal = false; }
      if (terminal && !organism.store.activeWakes().some((wake) => wake.agentId === agent.agentId)
        && !organism.store.pendingActions().some((action) => action.agentId === agent.agentId)) {
        this.suspendLife(organism, agent.agentId, "attachment.goal-terminal");
      }
    }
  }

  /** Suspend and replace the stale wait code (e.g. playground.owns-work) with the reason the life stopped. */
  private suspendLife(organism: Organism, agentId: string, reasonCode: string): void {
    const nowMs = this.deps.now();
    organism.store.setEnabled(agentId, false, reasonCode, nowMs);
    const current = organism.store.get(agentId);
    if (current && current.state.lastWaitCode !== reasonCode) {
      organism.store.update(agentId, { state: { ...current.state, lastWaitCode: reasonCode, reviewPending: false } }, nowMs);
    }
  }

  private lifeDigest(organism: Organism, agent: AliveAgent): string {
    const attachment = organism.store.attachments(agent.agentId).find((row) => row.status === "attached");
    const active = organism.store.activeWakes().find((wake) => wake.agentId === agent.agentId);
    // The attached Goal's own state (deleted, ended, cancelled, needs a goal) changes what the composer shows.
    let goal: unknown = null;
    if (attachment) {
      try {
        const seen = organism.playground.observe(attachment, this.deps.now());
        goal = [seen.work, seen.blockedBy ?? null, (seen.salience as { goalId?: unknown; status?: unknown } | undefined)?.goalId ?? null,
          (seen.salience as { status?: unknown } | undefined)?.status ?? null];
      } catch { goal = "unobservable"; }
    }
    return JSON.stringify([this.planAccess, goal, agent.status, agent.controlEpoch, agent.state.lastWaitCode ?? null, agent.budget,
      agent.state.usageUnknown ?? null, attachment?.attachmentId ?? null, active?.wakeId ?? null,
      (agent.state.lastReview as { runId?: string } | undefined)?.runId ?? null]);
  }

  private emitChanges(kind: AliveOrganism, force?: string): void {
    const organism = this.organisms[kind];
    for (const agent of organism.store.list()) {
      const digest = this.lifeDigest(organism, agent);
      if (organism.digests.get(agent.agentId) === digest && force !== agent.agentId) continue;
      organism.digests.set(agent.agentId, digest);
      const attachment = organism.store.attachments(agent.agentId).find((row) => row.status === "attached");
      const scopeId = (this.deps.db.prepare("SELECT scope_id FROM alive_organism_lives WHERE agent_id=?").get(agent.agentId) as { scope_id: string } | undefined)?.scope_id ?? agent.agentId;
      try {
        this.deps.emit({ surface: kind, ...(typeof attachment?.scope.chatId === "string" ? { chatId: attachment.scope.chatId } : {}), scopeId });
      } catch { /* a closing window cannot stop the life */ }
    }
  }

  // ── projections ───────────────────────────────────────────────────────────

  private scopeFor(surface: AliveSurface, chatId: string): {
    available: boolean; reasonCode?: string; chatTitle: string; goalId: string | null; needsGoal: boolean;
    key: string | null; agentId: string | null; scope: AliveState["scope"]; scopeId: string | null; projectId: string | null;
  } {
    const unavailable = (reasonCode: string, extra: Partial<ReturnType<AliveOrganismHost["scopeFor"]>> = {}) => ({
      available: false, reasonCode, chatTitle: "", goalId: null, needsGoal: true, key: null, agentId: null, scope: null,
      scopeId: null, projectId: null, ...extra });
    if (!this.running) return unavailable("alive-host-not-running");
    if (!this.deps.controllerInstalled()) return unavailable("alive-controller-not-installed");
    const chat = this.deps.playground.chat(chatId);
    if (!chat) return unavailable("alive-chat-not-found");
    if (chat.originSurface && chat.originSurface !== surface) return unavailable("alive-surface-mismatch");
    const run = chat.goalId ? this.deps.playground.runForGoal(chat.goalId) : null;
    const goalId = run ? chat.goalId : null;
    const needsGoal = !goalId;
    if (surface === "work") {
      if (!chat.projectId || !ID.test(chat.projectId)) return unavailable("alive-work-project-required", { chatTitle: chat.title, goalId, needsGoal });
      const key = WORK_KEY(chat.projectId);
      return { available: true, chatTitle: chat.title, goalId, needsGoal, key, agentId: aliveStableId(key), projectId: chat.projectId,
        scopeId: chat.projectId, scope: { kind: "work-project", id: chat.projectId,
          label: (this.deps.projectName(chat.projectId) ?? chat.projectId).slice(0, 120) } };
    }
    if (!goalId || !ID.test(goalId)) {
      return { available: true, chatTitle: chat.title, goalId: null, needsGoal: true, key: null, agentId: null, scope: null, scopeId: null, projectId: null };
    }
    const key = ONE_KEY(goalId);
    return { available: true, chatTitle: chat.title, goalId, needsGoal, key, agentId: aliveStableId(key), projectId: null,
      scopeId: goalId, scope: { kind: "one-goal", id: goalId, label: (run?.objective ?? chat.title).replace(/\s+/g, " ").trim().slice(0, 120) } };
  }

  private attachmentFor(surface: AliveSurface, agentId: string, scopeId: string, chatId: string, goalId: string | null): AliveAttachment {
    return surface === "work"
      ? { attachmentId: aliveStableId(`alive:work-attachment:v1:${scopeId}:${chatId}`), agentId, domain: "work", status: "attached",
        scope: { surface: "work", projectId: scopeId, chatId } }
      : { attachmentId: aliveStableId(`alive:one-attachment:v1:${scopeId}:${chatId}`), agentId, domain: "one", status: "attached",
        scope: { surface: "one", chatId, goalId } };
  }

  private modelOrder(organism: Organism, agentId: string | null): AliveModelOrderItem[] {
    const entries = this.deps.cachedModelOrder();
    let running: AliveWakeRuntimeRecord | null = null;
    if (agentId) {
      const active = organism.store.activeWakes().find((wake) => wake.agentId === agentId);
      if (active) {
        const row = this.deps.db.prepare(`SELECT payload_json FROM alive_events WHERE agent_id=? AND kind='wake.runtime-selected'
          AND json_extract(payload_json,'$.wakeId')=? ORDER BY sequence DESC LIMIT 1`).get(agentId, active.wakeId) as { payload_json: string } | undefined;
        try { running = row ? JSON.parse(row.payload_json) as AliveWakeRuntimeRecord : null; } catch { running = null; }
      }
    }
    const next = entries.findIndex((entry) => !entry.exhausted);
    return entries.map((entry, index) => ({ role: entry.role, runtimeId: entry.runtimeId, model: entry.model, label: entry.label,
      exhausted: entry.exhausted,
      current: running ? running.role === entry.role && running.position === entry.position : index === next }));
  }

  private statusOf(organism: Organism, agent: AliveAgent): { status: AliveStatus; code?: string } {
    if (organism.store.activeWakes().some((wake) => wake.agentId === agent.agentId)) return { status: "running", code: "wake.active" };
    if (organism.store.pendingActions().some((action) => action.agentId === agent.agentId)) return { status: "running", code: "action.pending" };
    if (this.planAccess !== "allowed") return { status: "blocked", code: this.planAccess };
    const code = typeof agent.state.lastWaitCode === "string" ? agent.state.lastWaitCode : undefined;
    if (agent.budget.tokenLimit !== null && agent.budget.tokensUsed >= agent.budget.tokenLimit) return { status: "tokens-spent", code: "grant.tokens-spent" };
    if (agent.budget.tokenLimit !== null && agent.state.usageUnknown === true) return { status: "usage-unknown", code: "grant.usage-unavailable" };
    if (!code) {
      const review = agent.state.lastReview as { errorCode?: string | null } | undefined;
      return { status: "waiting", ...(review?.errorCode ? { code: review.errorCode } : {}) };
    }
    if (code === "agent.resting") return { status: "resting", code };
    if (BLOCKED_WAITS.has(code) || (code.startsWith("goal.") && code !== "goal.none") || code.startsWith("work.")) return { status: "blocked", code };
    return { status: "waiting", code };
  }

  getState(surface: AliveSurface, chatId: string): AliveState {
    const organism = this.organisms[surface];
    const resolved = this.scopeFor(surface, chatId);
    const base: AliveState = { available: resolved.available, ...(resolved.reasonCode ? { reasonCode: resolved.reasonCode } : {}),
      ...(this.planAccess !== "allowed" ? { accessReasonCode: this.planAccess } : {}),
      enabled: false, scope: resolved.scope, needsGoal: resolved.needsGoal, status: "off",
      budget: { tokenLimit: null, tokensUsed: 0 }, modelOrder: this.modelOrder(organism, resolved.agentId) };
    if (!resolved.available || !resolved.agentId) return base;
    const agent = organism.store.get(resolved.agentId);
    if (!agent) return base;
    base.budget = { tokenLimit: agent.budget.tokenLimit, tokensUsed: agent.budget.tokensUsed };
    const attachment = organism.store.attachments(agent.agentId).find((row) => row.status === "attached");
    const attachedChat = typeof attachment?.scope.chatId === "string" ? attachment.scope.chatId : null;
    if (surface === "work" && attachedChat && attachedChat !== chatId) {
      if (agent.status === "enabled") {
        const other = this.deps.playground.chat(attachedChat);
        base.conflict = { chatId: attachedChat, title: (other?.title ?? "").slice(0, 120) };
      }
      return base;
    }
    base.enabled = agent.status === "enabled";
    if (!base.enabled) return base;
    const status = this.statusOf(organism, agent);
    base.status = status.status;
    if (status.code) base.statusReasonCode = status.code;
    return base;
  }

  // ── owner controls ────────────────────────────────────────────────────────

  setEnabled(input: AliveSetEnabledInput): AliveState {
    const { surface, chatId, enabled } = input;
    const organism = this.organisms[surface];
    const resolved = this.scopeFor(surface, chatId);
    if (!resolved.available) throw new AliveHostError(resolved.reasonCode ?? "alive-unavailable");
    const nowMs = this.deps.now();
    if (!enabled) {
      if (!resolved.agentId) return this.getState(surface, chatId);
      const agent = organism.store.get(resolved.agentId);
      const attachment = agent ? organism.store.attachments(agent.agentId).find((row) => row.status === "attached") : undefined;
      if (agent && (surface === "one" || attachment?.scope.chatId === chatId)) {
        this.suspendLife(organism, agent.agentId, "owner.disabled");
        for (const wake of organism.store.activeWakes().filter((row) => row.agentId === agent.agentId)) {
          try { organism.runtime.cancel(wake.wakeId); } catch { /* the next reconcile cancels by epoch */ }
        }
      }
      this.emitChanges(surface, resolved.agentId);
      return this.getState(surface, chatId);
    }
    if (this.planAccess !== "allowed") throw new AliveHostError(this.planAccess);
    if (resolved.needsGoal || !resolved.goalId || !resolved.agentId || !resolved.key || !resolved.scopeId) {
      throw new AliveHostError("alive-goal-required", "Start a goal in this chat first.");
    }
    const tokenLimit = input.tokenLimit === undefined ? undefined : input.tokenLimit;
    const agentId = resolved.agentId;
    const existing = organism.store.get(agentId);
    const current = existing ? organism.store.attachments(agentId).find((row) => row.status === "attached") : undefined;
    if (surface === "work" && existing?.status === "enabled" && current && current.scope.chatId !== chatId && input.moveFrom !== true) {
      return this.getState(surface, chatId); // carries conflict {chatId,title}; nothing changes
    }
    const attachment = this.attachmentFor(surface, agentId, resolved.scopeId, chatId, resolved.goalId);
    this.deps.db.transaction(() => {
      if (!existing) {
        const purpose = surface === "work"
          ? `Keep the Work project "${resolved.scope?.label ?? resolved.scopeId}" moving toward its ongoing Goal as its orchestrator, continuing stopped work within the owner's grants and never past an owner stop or approval.`
          : `Keep this One room's Goal "${resolved.scope?.label ?? resolved.scopeId}" moving as its orchestrator, continuing stopped work within the owner's grants and never past an owner stop or approval.`;
        organism.store.create({ agentId, purpose, runtimeBinding: ALIVE_POOL_RUNTIME_POLICY,
          budget: { tokenLimit: tokenLimit === undefined ? ALIVE_DEFAULT_TOKEN_LIMIT : tokenLimit, tokensUsed: 0, deadlineMs: null } }, nowMs);
        this.deps.db.prepare("INSERT INTO alive_organism_lives(agent_id,organism,life_key,scope_id,created_at_ms) VALUES (?,?,?,?,?) ON CONFLICT(agent_id) DO NOTHING")
          .run(agentId, surface, resolved.key, resolved.scopeId, nowMs);
        this.lives.set(agentId, surface);
      } else {
        if (tokenLimit !== undefined) {
          const agent = organism.store.get(agentId)!;
          organism.store.update(agentId, { budget: { ...agent.budget, tokenLimit } }, nowMs);
        }
        organism.store.setEnabled(agentId, true, "owner.enabled", nowMs);
      }
      for (const row of organism.store.attachments(agentId)) {
        if (row.status === "attached" && row.attachmentId !== attachment.attachmentId) {
          organism.store.attach({ ...row, status: "detached" }, nowMs);
          organism.store.event(agentId, "attachment.moved", { from: row.scope.chatId ?? null, to: chatId }, nowMs);
        }
      }
      organism.store.attach(attachment, nowMs);
    })();
    this.emitChanges(surface, agentId);
    if (this.running) setImmediate(() => { void this.beat(surface); });
    return this.getState(surface, chatId);
  }

  setTokenLimit(input: AliveSetTokenLimitInput): AliveState {
    const organism = this.organisms[input.surface];
    const resolved = this.scopeFor(input.surface, input.chatId);
    if (!resolved.available) throw new AliveHostError(resolved.reasonCode ?? "alive-unavailable");
    const agent = resolved.agentId ? organism.store.get(resolved.agentId) : null;
    if (!agent) throw new AliveHostError("alive-life-missing", "Turn AGI on first.");
    const attachment = organism.store.attachments(agent.agentId).find((row) => row.status === "attached");
    if (input.surface === "work" && attachment && attachment.scope.chatId !== input.chatId) throw new AliveHostError("alive-attached-elsewhere");
    organism.store.update(agent.agentId, { budget: { ...agent.budget, tokenLimit: input.tokenLimit } }, this.deps.now());
    organism.store.event(agent.agentId, "grant.token-limit-changed", { tokenLimit: input.tokenLimit }, this.deps.now());
    // An owner re-grant is the way out of usage-unknown: wakes that can never report usage are acknowledged.
    organism.store.acknowledgeUnknownUsage(agent.agentId, this.deps.now());
    this.emitChanges(input.surface, agent.agentId);
    if (this.running) setImmediate(() => { void this.beat(input.surface); });
    return this.getState(input.surface, input.chatId);
  }

  /** Test/diagnostic view of one organism's store. */
  storeOf(kind: AliveOrganism): AliveLifetimeStore { return this.organisms[kind].store; }
  observeGoal(kind: AliveOrganism, attachment: AliveAttachment) { return attachedGoalId(attachment, this.deps.playground); }
}

/** Strict IPC input parsing — unknown keys and wrong shapes are refused, never repaired. */
export function parseAliveSurfaceChat(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AliveHostError("alive-input-invalid");
  const row = value as Record<string, unknown>;
  // developmentIpcBoundary normalizes undefined-valued keys away; anything left must be known.
  if (Object.keys(row).some((key) => !allowed.includes(key))) throw new AliveHostError("alive-input-invalid");
  if (row.surface !== "one" && row.surface !== "work") throw new AliveHostError("alive-input-invalid");
  if (typeof row.chatId !== "string" || !row.chatId.trim() || row.chatId.length > 200) throw new AliveHostError("alive-input-invalid");
  return row;
}

export function parseAliveTokenLimit(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > ALIVE_MAX_TOKEN_LIMIT) throw new AliveHostError("alive-token-limit-invalid");
  return Number(value);
}
