/**
 * AliveRuntimePort for One/Work lives: one hidden runtime chat per agentId (the same ⟦alive⟧ controller chat
 * desktopAliveRuntime uses for Science), one wake = one system-origin invocation whose run id is the wake id.
 *
 * Differences from desktopAliveRuntime (Science), which stays unchanged:
 *  - The model is resolved per wake from the dashboard role pool (model-order.ts), not from the life's stored
 *    binding; the resolved runtime is recorded on an alive event and projected onto the wake receipt.
 *  - Capabilities are the registered goal actions; the decision parser/schema is the goal vocabulary.
 *  - hostLost: a wake reserved by an earlier process lifetime with no invocation receipt (the app quit or crashed
 *    between reserve and start) is reported as interrupted instead of holding "wake.active" forever. Its charge
 *    follows invariant (c): no provider attempt marker = a known 0, a started attempt without usage = unknown.
 */
import type { AliveRuntimePort, AliveRuntimeReceipt, AliveRuntimeStart, AliveWakeRuntimeRecord } from "../alive-core/contracts";
import type { AliveLifetimeStore } from "../alive-core/lifetime-store";
import type { InvocationRunReceipt, McpInvocationRequest, RuntimeSelection } from "../../shared/types";
import { aliveActionRegistration } from "../alive-core/action-registry";
import { parseAliveGoalDecision } from "./goal-decision";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const ALIVE_WAKE_RUNTIME_EVENT = "wake.runtime-selected";

export interface GoalRuntimeDeps {
  organism: "work" | "one";
  processStartedAtMs: number;
  resolveSelection(): { selection: RuntimeSelection; record: AliveWakeRuntimeRecord } | null;
  ensureRuntimeChat(agentId: string): string;
  runtimeChatId(agentId: string): string;
  isAliveChat(chatId: string): boolean;
  finalResult(runId: string, chatId: string): { text: string; tokensUsed?: number } | null;
  measuredWakeUsage(runId: string, chatId: string): { attempts: boolean; tokensUsed?: number };
  locale(): string;
  invocation: {
    start(request: McpInvocationRequest, workspace: undefined, context: {
      source: "alive"; aliveGoal: { agentId: string; wakeId: string; controlEpoch: number; domain: "work" | "one" } }): { runId: string };
    cancel(runId: string): void;
    receipt(runId: string): InvocationRunReceipt | null;
    activeRunIds(): string[];
    onSettled(listener: (event: { receipt: InvocationRunReceipt | null }) => void): () => void;
  };
}

function wakePrompt(organism: "work" | "one", context: string): string {
  const scope = organism === "work"
    ? "the orchestrator of this Work project: you watch the project's ongoing Goal in the chat where the owner turned AGI on"
    : "the orchestrator (One) for this room's ongoing Goal";
  return `You are the Alive ${scope}. Seats and borrowed Hub/Cloud agents stay ordinary workers; you are the only continuously living controller. Review this host-observed state and return one bare JSON decision. For rest or reflection, use {"schema":"agentlas.alive-decision.v2","kind":"wait","reason":"brief reason","nextWakeAtMs":null,"action":null}; "review" is also valid, and nextWakeAtMs may be a nonnegative Unix-millisecond integer. Only if capabilities includes goal.continue AND an attachment's work is "paused" with blockedBy null, you may instead propose {"schema":"agentlas.alive-decision.v2","kind":"act","reason":"brief reason","nextWakeAtMs":null,"action":{"kind":"goal.continue","attachmentId":"observed attachment ID","expected":{"goalId":"observed goalId","runId":"observed runId","runVersion":1,"status":"paused or blocked, as observed"}}}. Copy the observed IDs, runVersion and status exactly; do not invent them. goal.continue resumes the Goal through the host's existing continuation path with its original permissions and budget; the host rechecks the owner's stop, approvals, budget and the exact run version before any effect, and refuses a stale proposal. Never propose continuing a Goal the owner stopped or that waits for an approval. Do not claim the Goal progressed or that any external effect happened until a later observation shows it.\n${context}`;
}

export class GoalAliveRuntime implements AliveRuntimePort {
  constructor(private readonly store: AliveLifetimeStore, private readonly deps: GoalRuntimeDeps) {}

  start(input: AliveRuntimeStart): { accepted: boolean; runId?: string; reasonCode?: string } {
    const caps = input?.context?.capabilities;
    if (!input || !UUID.test(input.agentId) || !UUID.test(input.wakeId) || !Number.isSafeInteger(input.controlEpoch)
      || input.controlEpoch < 0 || typeof input.purpose !== "string" || !input.purpose.trim() || input.purpose.length > 20_000
      || typeof input.reasonCode !== "string" || !/^[a-z][a-z0-9._-]{2,119}$/.test(input.reasonCode)
      || !Array.isArray(caps) || caps[0] !== "alive.record_decision"
      || caps.slice(1).some((kind) => !aliveActionRegistration(kind)?.domains.includes(this.deps.organism))) {
      return { accepted: false, reasonCode: "alive-runtime-input-invalid" };
    }
    // Invariant (c): every refusal below happens before a provider dispatch and charges 0 tokens.
    const resolved = this.deps.resolveSelection();
    if (!resolved) return { accepted: false, reasonCode: "alive-model-order-exhausted" };
    let chatId: string;
    try { chatId = this.deps.ensureRuntimeChat(input.agentId); }
    catch { return { accepted: false, reasonCode: "alive-runtime-binding-unavailable" }; }
    let context: string;
    try {
      context = JSON.stringify({ schema: "agentlas.alive-wake-context.v1", agentId: input.agentId,
        wakeId: input.wakeId, controlEpoch: input.controlEpoch, purpose: input.purpose,
        reasonCode: input.reasonCode, attachments: input.context.attachments,
        state: { lastReview: input.context.state.lastReview ?? null, lastAction: input.context.state.lastAction ?? null },
        budget: input.context.budget, capabilities: caps });
    } catch { return { accepted: false, reasonCode: "alive-runtime-context-invalid" }; }
    if (Buffer.byteLength(context, "utf8") > 64 * 1024) return { accepted: false, reasonCode: "alive-runtime-context-too-large" };
    // Durable before dispatch: the receipt (and a restarted process) can name the model this wake ran on.
    this.store.event(input.agentId, ALIVE_WAKE_RUNTIME_EVENT, { wakeId: input.wakeId, ...resolved.record,
      processStartedAtMs: this.deps.processStartedAtMs }, Date.now());
    try {
      const started = this.deps.invocation.start({ runId: input.wakeId, chatId,
        userPrompt: wakePrompt(this.deps.organism, context), promptOrigin: "system", taskIntent: "conversation",
        // The controller needs no tools: its only authority is the decision the host validates.
        // Antigravity cannot even read a long prompt file in read mode, so it gets its sandboxed write mode.
        permissions: resolved.selection.kind === "antigravity" ? "write" : "read",
        sessionRouting: false, runtimeSelection: resolved.selection, locale: this.deps.locale() } as McpInvocationRequest,
      undefined, { source: "alive", aliveGoal: { agentId: input.agentId, wakeId: input.wakeId,
        controlEpoch: input.controlEpoch, domain: this.deps.organism } });
      if (started.runId !== input.wakeId) {
        this.deps.invocation.cancel(started.runId);
        return { accepted: false, reasonCode: "alive-runtime-run-id-mismatch" };
      }
      return { accepted: true, runId: started.runId };
    } catch { return { accepted: false, reasonCode: "alive-runtime-start-failed" }; }
  }

  cancel(runId: string): void {
    if (!UUID.test(runId)) return;
    const receipt = this.deps.invocation.receipt(runId);
    if (receipt && this.deps.isAliveChat(receipt.chatId)) this.deps.invocation.cancel(runId);
  }

  private runtimeRecord(agentId: string, wakeId: string): AliveWakeRuntimeRecord | undefined {
    const row = this.store.db.prepare(`SELECT payload_json FROM alive_events WHERE agent_id=? AND kind=?
      AND json_extract(payload_json,'$.wakeId')=? ORDER BY sequence DESC LIMIT 1`).get(agentId, ALIVE_WAKE_RUNTIME_EVENT, wakeId) as { payload_json: string } | undefined;
    if (!row) return undefined;
    try {
      const p = JSON.parse(row.payload_json) as Record<string, unknown>;
      return { role: p.role === "worker" ? "worker" : "orchestrator", position: Number(p.position) || 0, kind: String(p.kind),
        backend: typeof p.backend === "string" ? p.backend : null, model: String(p.model), label: String(p.label ?? p.kind) };
    } catch { return undefined; }
  }

  /** A wake that no live owner can settle: reserved by an earlier process lifetime and not running here. */
  hostLost(wakeId: string): boolean {
    if (this.deps.invocation.activeRunIds().includes(wakeId)) return false;
    const wake = this.store.db.prepare("SELECT created_at_ms FROM alive_wakes WHERE wake_id=? AND status IN ('reserved','running')")
      .get(wakeId) as { created_at_ms: number } | undefined;
    return Boolean(wake && wake.created_at_ms < this.deps.processStartedAtMs);
  }

  private convert(receipt: InvocationRunReceipt): AliveRuntimeReceipt | null {
    if (!this.deps.isAliveChat(receipt.chatId)
      || (receipt.status !== "completed" && receipt.status !== "failed" && receipt.status !== "cancelled" && receipt.status !== "interrupted")) return null;
    const agentId = this.store.wakeAgentId(receipt.runId);
    if (!agentId || !this.store.owns(agentId) || this.deps.runtimeChatId(agentId) !== receipt.chatId) return null;
    const final = receipt.status === "completed" ? this.deps.finalResult(receipt.runId, receipt.chatId) : null;
    const decision = final ? parseAliveGoalDecision(final.text) : undefined;
    const measured = this.deps.measuredWakeUsage(receipt.runId, receipt.chatId);
    // Same rule as desktopAliveRuntime: no provider attempt on a run that did not complete = a known 0.
    const tokensUsed = measured.attempts ? measured.tokensUsed : receipt.status === "completed" ? final?.tokensUsed : 0;
    const runtime = this.runtimeRecord(agentId, receipt.runId);
    return { runId: receipt.runId, status: receipt.status,
      ...(tokensUsed === undefined ? {} : { tokensUsed }),
      ...(final?.text ? { finalText: final.text.slice(0, 4_096) } : {}),
      ...(receipt.errorCode ? { errorCode: receipt.errorCode } : {}),
      ...(decision ? { decision } : {}), ...(runtime ? { runtime } : {}) };
  }

  receipt(runId: string): AliveRuntimeReceipt | null {
    if (!UUID.test(runId)) return null;
    const receipt = this.deps.invocation.receipt(runId);
    if (receipt) return this.convert(receipt);
    if (!this.hostLost(runId)) return null;
    const agentId = this.store.wakeAgentId(runId);
    if (!agentId || !this.store.owns(agentId)) return null;
    const measured = this.deps.measuredWakeUsage(runId, this.deps.runtimeChatId(agentId));
    const runtime = this.runtimeRecord(agentId, runId);
    return { runId, status: "interrupted", errorCode: "alive-host-lost",
      ...(measured.attempts ? (measured.tokensUsed === undefined ? {} : { tokensUsed: measured.tokensUsed }) : { tokensUsed: 0 }),
      ...(runtime ? { runtime } : {}) };
  }

  onSettled(listener: (receipt: AliveRuntimeReceipt) => void): () => void {
    return this.deps.invocation.onSettled((event) => {
      if (!event.receipt || !this.store.wakeAgentId(event.receipt.runId)) return;
      const receipt = this.convert(event.receipt);
      if (receipt) listener(receipt);
    });
  }
}
