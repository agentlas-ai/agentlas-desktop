import type Database from "better-sqlite3";
import { AliveLifetimeStore } from "../alive-core/lifetime-store";
import { AliveLifetimeService, type AliveLifetimeServiceOptions } from "../alive-core/lifetime-service";
import { aliveActionRegistration, registerAliveAction, validAliveAction } from "../alive-core/action-registry";
import type { AliveActionPacket, AliveActionResult, AliveAttachment, AlivePlaygroundObservation, AlivePlaygroundPort,
  AliveRuntimePort, AliveRuntimeReceipt, AliveRuntimeStart } from "../alive-core/contracts";
import { registerDeclaredPromptModule, type PromptOrderingMetadata } from "../runtime/prompt-order";

const KIND = "science.continue_research";
const EVENT = "host.science-wake-fence.v1";
const SHA = /^[a-f0-9]{64}$/i;
const EXPECTED_KEYS = ["loopSessionId", "loopVersion", "loopStateSha256", "conversationStopEpoch", "approvalPolicySha256"];
const validExpected = (f: Record<string, unknown>): boolean =>
  typeof f.loopSessionId === "string" && f.loopSessionId.length > 0 && f.loopSessionId.length <= 200
  && Number.isSafeInteger(f.loopVersion) && Number(f.loopVersion) >= 0
  && typeof f.loopStateSha256 === "string" && SHA.test(f.loopStateSha256)
  && Number.isSafeInteger(f.conversationStopEpoch) && Number(f.conversationStopEpoch) >= 0
  && typeof f.approvalPolicySha256 === "string" && SHA.test(f.approvalPolicySha256);
function registerScienceAction(): void {
  const existing = aliveActionRegistration(KIND);
  if (existing) {
    if (existing.validateExpected !== validExpected || existing.domains.join("|") !== "science" || existing.expectedKeys.join("|") !== [...EXPECTED_KEYS].sort().join("|"))
      throw new Error("science-alive-action-registration-conflict");
    return;
  }
  registerAliveAction({ kind: KIND, domains: ["science"], expectedKeys: EXPECTED_KEYS, validateExpected: validExpected });
}
export const SCIENCE_ALIVE_HOST_CONTEXT_MODULE = {
  id: "science.alive.host-context", revision: 1, stability: "turn-context",
  changeTriggers: ["owner-input", "validation-result", "child-result", "checkpoint", "model-output"],
} as const satisfies PromptOrderingMetadata;
/** Public controller state excludes authority retained only in the host's immutable event ledger. */
export function projectScienceAliveHostState(state: Record<string, unknown>): Record<string, unknown> {
  registerDeclaredPromptModule(SCIENCE_ALIVE_HOST_CONTEXT_MODULE);
  const { wakeObserved: _privateAuthority, ...publicState } = state;
  return publicState;
}
type DomainReceipt = Omit<AliveRuntimeReceipt, "decision"> & { decision?: unknown };
interface DomainRuntime {
  start(input: AliveRuntimeStart): { accepted: boolean; runId?: string; reasonCode?: string };
  cancel(runId: string): void;
  receipt(runId: string): DomainReceipt | null;
  onSettled(listener: (receipt: DomainReceipt) => void): () => void;
}
interface DomainPlayground {
  observe(attachment: AliveAttachment, nowMs: number): AlivePlaygroundObservation;
  execute?(attachment: AliveAttachment, packet: any, nowMs: number): AliveActionResult;
  actionReceipt?(actionId: string): AliveActionResult | null;
}
interface WakeFence {
  wakeId: string; controlEpoch: number; attachmentId: string; generation: number;
  scope: Record<string, unknown>; expected: Record<string, unknown>;
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
function readFence(store: AliveLifetimeStore, wakeId: string, attachmentId: string): WakeFence | null {
  if (typeof wakeId !== "string" || !wakeId || typeof attachmentId !== "string" || !attachmentId) return null;
  const agentId = store.wakeAgentId(wakeId);
  if (!agentId || !store.owns(agentId)) return null;
  const agent = store.get(agentId);
  const event = store.events(agentId).find(e => e.kind === EVENT && e.payload?.wakeId === wakeId);
  const fence: WakeFence | undefined = event?.payload?.attachments?.find((f: WakeFence) => f.attachmentId === attachmentId);
  const wake = store.db.prepare("SELECT control_epoch FROM alive_wakes WHERE wake_id=? AND agent_id=?").get(wakeId, agentId) as { control_epoch: number } | undefined;
  const attachment = store.attachments(agentId).find(a => a.attachmentId === attachmentId && a.domain === "science" && a.status === "attached");
  const generation = store.db.prepare(`SELECT sequence FROM alive_events WHERE agent_id=? AND kind IN ('attachment.attached','attachment.detached')
    AND json_extract(payload_json,'$.attachmentId')=? ORDER BY sequence DESC LIMIT 1`).get(agentId, attachmentId) as { sequence: number } | undefined;
  if (!agent || agent.status !== "enabled" || !wake || !fence || fence.wakeId !== wakeId
    || fence.controlEpoch !== wake.control_epoch || agent.controlEpoch !== wake.control_epoch
    || !attachment || !generation || generation.sequence !== fence.generation || !same(attachment.scope, fence.scope)
    || !validAliveAction({ kind: KIND, attachmentId, expected: fence.expected })) return null;
  return fence;
}
function normalizeReceipt(store: AliveLifetimeStore, receipt: DomainReceipt, admitted: (attachmentId: string, agentId: string) => boolean): AliveRuntimeReceipt {
  const decision = receipt.decision as any;
  if (decision?.kind !== "act" || decision.action?.kind !== KIND) return receipt as AliveRuntimeReceipt;
  const fence = readFence(store, receipt.runId, decision.action.attachmentId);
  if (!fence || !admitted(fence.attachmentId, store.wakeAgentId(receipt.runId)!)) { const { decision: _untrusted, ...measuredReceipt } = receipt; return measuredReceipt; }
  return { ...receipt, decision: { ...decision, action: { kind: KIND, attachmentId: fence.attachmentId, expected: { ...fence.expected } } } };
}

/** Only domain observations/packets are adapted; scheduling, settlement and usage remain canonical. */
export const scienceAliveCoreHost = {
  ensureSchema(db: Database.Database): void { AliveLifetimeStore.ensureSchema(db); },
  createStore(db: Database.Database, options?: { initializeSchema?: boolean; agentScope?: (agentId: string) => boolean }): AliveLifetimeStore {
    registerScienceAction();
    return new AliveLifetimeStore(db, options);
  },
  createService(store: AliveLifetimeStore, runtime: DomainRuntime, playgrounds: ReadonlyMap<string, DomainPlayground>,
    options: AliveLifetimeServiceOptions = {}): AliveLifetimeService {
    if (!(store instanceof AliveLifetimeStore)) throw new Error("science-alive-canonical-store-required");
    registerScienceAction();
    const clock = options.clock ?? Date.now;
    const attachmentAdmission = (attachment: AliveAttachment, nowMs: number): string | null => {
      const port = playgrounds.get("science");
      if (!port) return "science.alive.playground-unavailable";
      try { return port.observe(attachment, nowMs).blockedBy ?? null; }
      catch { return "science.alive.observation-unavailable"; }
    };
    const currentAdmission = (agentId: string, nowMs: number): string | null => {
      const agent = store.get(agentId);
      if (!agent || !store.owns(agentId)) return "science.alive.agent-unavailable";
      const operational = options.admission?.(agent, nowMs) ?? null;
      if (operational) return operational;
      const attached = store.attachments(agentId).filter(a => a.status === "attached");
      // Another playground retains its independent wake route; Science cannot veto its admission.
      if (attached.some(a => a.domain !== "science")) return null;
      return attached.length > 0 && attached.every(a => attachmentAdmission(a, nowMs) === "science.full-autonomy-off")
        ? "science.full-autonomy-off" : null;
    };
    const normalize = (receipt: DomainReceipt): AliveRuntimeReceipt => normalizeReceipt(store, receipt, (attachmentId, agentId) => {
      const attachment = store.attachments(agentId).find(a => a.attachmentId === attachmentId && a.domain === "science" && a.status === "attached");
      return !!attachment && currentAdmission(agentId, clock()) === null && attachmentAdmission(attachment, clock()) === null;
    });
    const hostRuntime: AliveRuntimePort = {
      start(input) {
        const denied = currentAdmission(input.agentId, clock());
        if (denied) return { accepted: false, reasonCode: denied };
        const attachments: WakeFence[] = [];
        for (const attachment of input.context.attachments.filter(a => a.domain === "science" && a.work === "paused" && !a.blockedBy)) {
          const principal = store.preparedToolPrincipal({ agentId: input.agentId, wakeId: input.wakeId,
            controlEpoch: input.controlEpoch, attachmentId: attachment.attachmentId, domain: "science" }, clock());
          if (!same(principal.scope, attachment.scope)) throw new Error("science-alive-wake-scope-stale");
          const loop = attachment.observation.loop as any;
          const authority = attachment.observation.continuationAuthority as any;
          const expected = { loopSessionId: loop?.id, loopVersion: loop?.version, loopStateSha256: loop?.stateSha256,
            conversationStopEpoch: authority?.conversationStopEpoch, approvalPolicySha256: authority?.approvalPolicySha256 };
          if (expected.loopSessionId !== attachment.scope.loopSessionId || !validExpected(expected)) continue;
          attachments.push({ wakeId: input.wakeId, controlEpoch: input.controlEpoch, attachmentId: attachment.attachmentId,
            generation: principal.attachmentGeneration, scope: { ...principal.scope }, expected });
        }
        const prior = store.events(input.agentId).find(e => e.kind === EVENT && e.payload?.wakeId === input.wakeId);
        const payload = { wakeId: input.wakeId, attachments };
        if (prior && !same(prior.payload, payload)) throw new Error("science-alive-wake-fence-conflict");
        if (!prior) store.event(input.agentId, EVENT, payload, clock());
        return runtime.start({ ...input, context: { ...input.context, state: projectScienceAliveHostState(input.context.state) } });
      },
      cancel: runId => runtime.cancel(runId),
      receipt: runId => { const receipt = runtime.receipt(runId); return receipt ? normalize(receipt) : null; },
      onSettled: listener => runtime.onSettled(receipt => listener(normalize(receipt))),
    };
    const adaptedPort = (domain: string): AlivePlaygroundPort | undefined => {
      const port = playgrounds.get(domain);
      if (!port || domain !== "science") return port;
      return {
        observe: (attachment, nowMs) => port.observe(attachment, nowMs),
        actionReceipt: port.actionReceipt ? id => port.actionReceipt!(id) : undefined,
        execute: port.execute ? (attachment, packet: AliveActionPacket, nowMs) => {
          // Old executing packets retain read-only receipt recovery; absence of a receipt never authorizes re-execution.
          if (packet.schema !== "agentlas.alive-action.v1") throw new Error("science-alive-legacy-action-acceptance-unknown");
          const action = store.pendingActions().find(a => a.actionId === packet.actionId && a.status === "executing");
          const fence = action ? readFence(store, action.wakeId, attachment.attachmentId) : null;
          if (!action || !fence || !same(fence.expected, packet.expected) || packet.action !== KIND || packet.domain !== "science"
            || !same(packet.scope, attachment.scope)) throw new Error("science-alive-action-fence-missing");
          const denied = currentAdmission(attachment.agentId, nowMs) ?? attachmentAdmission(attachment, nowMs);
          if (denied) throw new Error(denied);
          const { projectId, conversationId, loopSessionId } = attachment.scope;
          if (typeof projectId !== "string" || typeof conversationId !== "string" || typeof loopSessionId !== "string"
            || loopSessionId !== packet.expected.loopSessionId) throw new Error("science-alive-action-scope-invalid");
          const { loopSessionId: _boundLoop, ...expected } = packet.expected;
          return port.execute!(attachment, { schema: "agentlas.alive-science-action.v1", action: KIND,
            actionId: packet.actionId, attachmentId: packet.attachmentId, projectId, conversationId, loopSessionId, expected }, nowMs);
        } : undefined,
      };
    };
    // Keep the caller's live map: registration/removal after construction is an existing core contract.
    const ports = new Proxy(playgrounds, { get(target, key) {
      if (key === "get") return adaptedPort;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } }) as ReadonlyMap<string, AlivePlaygroundPort>;
    return new AliveLifetimeService(store, hostRuntime, ports, { ...options,
      admission: (agent, nowMs) => currentAdmission(agent.agentId, nowMs),
    });
  },
};
