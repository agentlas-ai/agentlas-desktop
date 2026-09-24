/**
 * Desktop Alive lifetime service — generalized port of agentlas-science/src/alive/lifetime-service.ts.
 *
 * Heartbeat gate order is unchanged from Science: enabled → active wake → pending action → deadline →
 * tokens spent → usage unknown → observe → (host runtime admission) → reserve → runtime.start.
 * Generalized:
 *  - the action route is whatever the attachment's domain registered (./action-registry), not Science only;
 *  - dispatch validates the packet against the attachment's current scope (not Science project/loop ids);
 *  - an optional host `admission` hook runs right before reserve, so "no model in the pool can run now"
 *    is a visible wait code, not a failed wake that burns the failure backoff (a pre-dispatch failure
 *    would charge 0 tokens anyway, invariant c, but it would also push the next review out to "rest").
 */
import { createHash } from "node:crypto";
import type { AliveActionPacket, AliveAgent, AlivePlaygroundObservation, AlivePlaygroundPort, AliveRuntimePort, AliveRuntimeStart } from "./contracts";
import { aliveActionKindsForDomain, aliveActionRegistration } from "./action-registry";
import { AliveLifetimeStore } from "./lifetime-store";

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface AliveLifetimeBeat { agentId: string; outcome: "wait" | "dispatched" | "failed"; reasonCode: string }
export interface AliveLifetimeServiceOptions {
  clock?: () => number;
  /** Host admission just before a wake is reserved; a returned code is a wait, never a failed wake. */
  admission?: (agent: AliveAgent, nowMs: number) => string | null;
}

/** Agent time belongs to the host clock, and survives the completion or removal of a playground. */
export class AliveLifetimeService {
  private accepting = true;
  private readonly unsubscribe: () => void;
  private readonly clock: () => number;
  constructor(readonly store: AliveLifetimeStore, private readonly runtime: AliveRuntimePort,
    private readonly playgrounds: ReadonlyMap<string, AlivePlaygroundPort>, private readonly options: AliveLifetimeServiceOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.unsubscribe = runtime.onSettled((receipt) => {
      const nowMs = this.clock();
      if (this.store.settle(receipt, nowMs)) this.dispatchActions(nowMs);
    });
  }
  close(): void { this.accepting = false; this.unsubscribe(); }
  setAdmission(open: boolean): void { this.accepting = open; }
  private wait(agent: AliveAgent, reasonCode: string, nowMs: number): AliveLifetimeBeat {
    if (agent.state.lastWaitCode !== reasonCode) {
      this.store.update(agent.agentId, { state: { ...agent.state, lastWaitCode: reasonCode } }, nowMs);
      this.store.event(agent.agentId, "agent.waiting", { reasonCode }, nowMs);
    }
    return { agentId: agent.agentId, outcome: "wait", reasonCode };
  }
  private withinGrant(agent: AliveAgent, nowMs: number): boolean {
    return agent.status === "enabled"
      && !(agent.budget.deadlineMs !== null && nowMs >= agent.budget.deadlineMs)
      && !(agent.budget.tokenLimit !== null && (agent.budget.tokensUsed >= agent.budget.tokenLimit || agent.state.usageUnknown === true));
  }
  private dispatchActions(nowMs: number): void {
    for (const reserved of this.store.pendingActions()) {
      const portFor = () => this.store.attachments(reserved.agentId)
        .find((attachment) => attachment.attachmentId === reserved.proposal.attachmentId && attachment.status === "attached");
      const attachment = portFor();
      const registration = aliveActionRegistration(reserved.proposal.kind);
      const port = attachment ? this.playgrounds.get(attachment.domain) : undefined;
      if (reserved.status === "executing") {
        let settled = false;
        // Recovery reads the receipt from every port that registered this kind: a detached attachment
        // must not hide an effect that already crossed the domain boundary.
        for (const domain of registration?.domains ?? []) {
          const recoveryPort = this.playgrounds.get(domain);
          if (settled || !recoveryPort?.actionReceipt) continue;
          try {
            const receipt = recoveryPort.actionReceipt(reserved.actionId);
            if (receipt && receipt.actionId === reserved.actionId) settled = this.store.finishAction(receipt, nowMs);
          } catch { /* Unknown domain acceptance keeps the exact reservation. */ }
        }
        if (settled || !this.accepting || !reserved.packet || !attachment || !port?.execute || !port.actionReceipt) continue;
        const packet = reserved.packet;
        const current = this.store.get(reserved.agentId);
        if (!current || current.controlEpoch !== reserved.controlEpoch || !this.withinGrant(current, nowMs)
          || !registration?.domains.includes(attachment.domain) || attachment.attachmentId !== packet.attachmentId
          || packet.domain !== attachment.domain || JSON.stringify(attachment.scope) !== JSON.stringify(packet.scope)) continue;
        // Only the port's actionId-deduplicated route may replay after a crash between its effect and receipt.
        try {
          const result = port.execute(attachment, packet, nowMs);
          if (result.actionId === reserved.actionId) this.store.finishAction(result, nowMs);
        } catch { /* Keep the exact executing reservation for the next read-through. */ }
        continue;
      }
      if (!this.accepting) continue;
      if (!attachment || !registration || !registration.domains.includes(attachment.domain) || !port?.execute) {
        this.store.finishAction({ ok: false, actionId: reserved.actionId, code: "alive.action-binding-invalid" }, nowMs);
        continue;
      }
      let observation: AlivePlaygroundObservation;
      try { observation = port.observe(attachment, nowMs); }
      catch { this.store.finishAction({ ok: false, actionId: reserved.actionId, code: "alive.action-observation-unavailable" }, nowMs); continue; }
      if (observation.blockedBy || observation.work !== "paused") {
        this.store.finishAction({ ok: false, actionId: reserved.actionId,
          code: observation.blockedBy ?? "alive.action-target-not-paused" }, nowMs);
        continue;
      }
      const action: AliveActionPacket = {
        schema: "agentlas.alive-action.v1", action: reserved.proposal.kind,
        actionId: reserved.actionId, attachmentId: attachment.attachmentId, domain: attachment.domain,
        scope: attachment.scope, expected: { ...reserved.proposal.expected },
      };
      if (!this.store.claimAction(action, nowMs)) continue;
      const current = this.store.get(reserved.agentId);
      const currentAttachment = portFor();
      if (!current || current.status !== "enabled" || current.controlEpoch !== reserved.controlEpoch
        || !currentAttachment || currentAttachment.domain !== action.domain
        || JSON.stringify(currentAttachment.scope) !== JSON.stringify(action.scope)) {
        this.store.finishAction({ ok: false, actionId: reserved.actionId, code: "alive.action-admission-changed" }, nowMs);
        continue;
      }
      try {
        const result = port.execute(currentAttachment, action, nowMs);
        if (result.actionId === reserved.actionId) this.store.finishAction(result, nowMs);
        // A mismatched or thrown reply may have crossed the action boundary; retain the reservation.
      } catch { this.store.event(reserved.agentId, "action.acceptance-uncertain", { actionId: reserved.actionId }, nowMs); }
    }
  }
  /** Unknown acceptance is not a licence to start another invocation after a crash. */
  reconcile(nowMs = this.clock()): void {
    for (const wake of this.store.activeWakes()) {
      const agent = this.store.get(wake.agentId)!;
      if (agent.status !== "enabled" || agent.controlEpoch !== wake.controlEpoch) {
        try { this.runtime.cancel(wake.wakeId); } catch { /* cancellation receipt remains authoritative */ }
      }
      let receipt = null;
      // The runtime port answers for a wake whose host died (hostLost) with an interrupted receipt.
      try { receipt = this.runtime.receipt(wake.wakeId); } catch { /* retain the reservation */ }
      if (receipt && receipt.runId === wake.wakeId) this.store.settle(receipt, nowMs);
      // Missing receipts keep the existing reservation, without writing one idle event per beat.
    }
    this.dispatchActions(nowMs);
  }
  heartbeat(nowMs = this.clock()): AliveLifetimeBeat[] {
    if (!this.accepting) return [];
    this.reconcile(nowMs);
    const beats: AliveLifetimeBeat[] = [];
    for (const listed of this.store.list()) {
      let agent = listed;
      if (agent.status !== "enabled") continue;
      if (agent.budget.tokenLimit !== null && agent.state.usageUnknown === true
        && !this.store.activeWakes().some((wake) => wake.agentId === agent.agentId)
        && this.store.recoverUnknownUsage(agent.agentId, (wakeId) => this.runtime.receipt(wakeId), nowMs)) {
        agent = this.store.get(agent.agentId) ?? agent;
      }
      if (this.store.activeWakes().some((wake) => wake.agentId === agent.agentId)) { beats.push(this.wait(agent, "wake.active", nowMs)); continue; }
      if (this.store.pendingActions().some((action) => action.agentId === agent.agentId)) { beats.push(this.wait(agent, "action.pending", nowMs)); continue; }
      if (agent.budget.deadlineMs !== null && nowMs >= agent.budget.deadlineMs) { beats.push(this.wait(agent, "grant.deadline-spent", nowMs)); continue; }
      if (agent.budget.tokenLimit !== null && agent.budget.tokensUsed >= agent.budget.tokenLimit) { beats.push(this.wait(agent, "grant.tokens-spent", nowMs)); continue; }
      if (agent.budget.tokenLimit !== null && agent.state.usageUnknown === true) { beats.push(this.wait(agent, "grant.usage-unavailable", nowMs)); continue; }
      const lastReview = agent.state.lastReview as { errorCode?: unknown; runtimeBindingSha256?: unknown; grantRevision?: unknown } | undefined;
      const runtimeBindingChanged = Boolean(lastReview && lastReview.runtimeBindingSha256 !== digest(agent.runtimeBinding));
      const grantChanged = Boolean(lastReview && lastReview.grantRevision !== (agent.state.grantRevision ?? null));
      const attached = this.store.attachments(agent.agentId).filter((attachment) => attachment.status === "attached");
      const observations = attached.map((attachment) => {
        const port = this.playgrounds.get(attachment.domain);
        let result: AlivePlaygroundObservation;
        try { result = port ? port.observe(attachment, nowMs) : { work: "none", observation: { availability: "unavailable" } }; }
        catch { result = { work: "none", observation: { availability: "observation-failed" }, blockedBy: "playground.observation-unavailable" }; }
        return { attachment, result };
      });
      const hasActionRoute = (domain: string) => !!this.playgrounds.get(domain)?.execute && aliveActionKindsForDomain(domain).length > 0;
      // A domain block or an active turn belongs to that attachment, not to the agent's entire life.
      const eligible = ({ attachment, result }: typeof observations[number]) => !result.blockedBy
        && result.work !== "running"
        && (result.work !== "paused" || hasActionRoute(attachment.domain));
      const continuable = ({ attachment, result }: typeof observations[number]) => !result.blockedBy
        && result.work === "paused" && hasActionRoute(attachment.domain);
      const available = observations.some(eligible);
      const otherAvailable = observations.some((entry) => eligible(entry) && !continuable(entry));
      if (observations.length > 0 && !available) {
        const blocked = observations.find(({ result }) => result.blockedBy)?.result.blockedBy;
        beats.push(this.wait(agent, blocked ?? "playground.owns-work", nowMs)); continue;
      }
      const canAct = observations.some(continuable);
      const contextAttachments = observations.map(({ attachment, result }) => ({ attachmentId: attachment.attachmentId,
        domain: attachment.domain, scope: attachment.scope, work: result.work,
        blockedBy: result.blockedBy ?? null, observation: result.observation }));
      const observationSha = digest(observations.map(({ attachment, result }) => ({ attachmentId: attachment.attachmentId,
        domain: attachment.domain, scope: attachment.scope, work: result.work, blockedBy: result.blockedBy ?? null,
        salience: result.salience ?? result.observation })));
      // Retry limits are scoped to the same observed action world, not to volatile revisions a failed
      // dispatch itself may change.
      const actionWorldSha = digest(observations.filter(({ attachment }) => hasActionRoute(attachment.domain))
        .map(({ attachment, result }) => ({ attachmentId: attachment.attachmentId, scope: attachment.scope,
          world: result.observation.world ?? result.salience ?? null })));
      if (lastReview?.errorCode === "agy_read_tools_unsupported" && !runtimeBindingChanged && !grantChanged
        && agent.state.lastActionWorldSha === actionWorldSha) {
        beats.push(this.wait(agent, "runtime.read-tools-unsupported", nowMs)); continue;
      }
      let actionWait: string | null = null;
      const sameActionFailureWorld = agent.state.actionFailureEpoch === agent.controlEpoch
        && agent.state.actionFailureGrantRevision === (agent.state.grantRevision ?? null)
        && agent.state.actionFailureFingerprint === actionWorldSha;
      if (sameActionFailureWorld && typeof agent.state.actionBackoffUntilMs === "number"
        && nowMs < agent.state.actionBackoffUntilMs) actionWait = "action.backoff";
      // A failed action only cools down that route. It cannot veto a changed observation elsewhere.
      if (actionWait && !otherAvailable) { beats.push(this.wait(agent, actionWait, nowMs)); continue; }
      const canContinue = canAct && !actionWait;
      const changed = agent.state.lastObservationSha !== observationSha;
      const periodicPausedReview = canContinue && agent.state.nextWakeAtMs === null
        && typeof agent.state.lastReviewAtMs === "number" && nowMs - agent.state.lastReviewAtMs >= 30 * 60_000;
      const actionRetryDue = canContinue && sameActionFailureWorld
        && typeof agent.state.actionBackoffUntilMs === "number"
        && nowMs >= agent.state.actionBackoffUntilMs
        && (typeof agent.state.lastReviewAtMs !== "number"
          || agent.state.lastReviewAtMs < agent.state.actionBackoffUntilMs);
      const due = typeof agent.state.nextWakeAtMs === "number" && nowMs >= agent.state.nextWakeAtMs
        || periodicPausedReview || actionRetryDue || runtimeBindingChanged || grantChanged;
      if (!changed && !due) { beats.push(this.wait(agent, "agent.resting", nowMs)); continue; }
      if (agent.runtimeBinding === null || agent.runtimeBinding === undefined) { beats.push(this.wait(agent, "runtime.selection-unavailable", nowMs)); continue; }
      const admissionCode = this.options.admission?.(agent, nowMs) ?? null;
      if (admissionCode) { beats.push(this.wait(agent, admissionCode, nowMs)); continue; }
      const reasonCode = changed ? "agent.observation-changed"
        : runtimeBindingChanged || grantChanged ? "agent.runtime-or-grant-changed"
          : actionRetryDue ? "agent.action-retry-due"
            : periodicPausedReview ? "agent.unfinished-review-due" : "agent.review-due";
      const wakeId = this.store.reserve(agent.agentId, agent.controlEpoch, reasonCode, nowMs);
      if (!wakeId) { beats.push(this.wait(this.store.get(agent.agentId)!, "wake.admission-changed", nowMs)); continue; }
      const current = this.store.get(agent.agentId)!;
      if (!this.accepting || current.status !== "enabled" || current.controlEpoch !== agent.controlEpoch
        || JSON.stringify(current.runtimeBinding) !== JSON.stringify(agent.runtimeBinding)) {
        this.store.settle({ runId: wakeId, status: "cancelled", tokensUsed: 0, errorCode: "wake.admission-changed" }, nowMs);
        beats.push({ agentId: agent.agentId, outcome: "wait", reasonCode: "wake.admission-changed" }); continue;
      }
      this.store.update(agent.agentId, { state: { ...current.state, lastObservationSha: observationSha,
        lastActionWorldSha: actionWorldSha, nextWakeAtMs: null, reviewPending: true, lastWaitCode: null } }, nowMs);
      const actionKinds = canContinue
        ? [...new Set(observations.filter(continuable).flatMap(({ attachment }) => aliveActionKindsForDomain(attachment.domain)))].sort()
        : [];
      const input: AliveRuntimeStart = { agentId: agent.agentId, wakeId, controlEpoch: current.controlEpoch,
        runtimeBinding: current.runtimeBinding, purpose: current.purpose, reasonCode,
        context: { attachments: contextAttachments, state: current.state, budget: current.budget,
          // A capability is a proposal route, never a permission grant to the model.
          capabilities: ["alive.record_decision", ...actionKinds] } };
      try {
        const result = this.runtime.start(input);
        if (!result.accepted || result.runId !== wakeId) {
          if (result.accepted && result.runId) { try { this.runtime.cancel(result.runId); } catch { /* report the invalid binding */ } }
          this.store.settle({ runId: wakeId, status: "failed", ...(!result.accepted ? { tokensUsed: 0 } : {}), errorCode: result.reasonCode ?? "runtime.run-binding-invalid" }, nowMs);
          beats.push({ agentId: agent.agentId, outcome: "failed", reasonCode: result.reasonCode ?? "runtime.run-binding-invalid" });
        } else {
          this.store.markRunning(wakeId); // a synchronous receipt already settled it; this is then a no-op
          beats.push({ agentId: agent.agentId, outcome: "dispatched", reasonCode });
        }
      } catch {
        // A thrown start might have crossed the provider boundary. Keep the exact reservation
        // and reconcile its receipt; replacing it with a new wake would duplicate execution.
        this.store.event(agent.agentId, "wake.acceptance-uncertain", { wakeId }, nowMs);
        beats.push({ agentId: agent.agentId, outcome: "failed", reasonCode: "wake.acceptance-uncertain" });
      }
    }
    return beats;
  }
}
