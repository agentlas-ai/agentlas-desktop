/**
 * AliveRuntimePort for One/Work lives — one wake = one light, decision-only controller call (light-wake.ts).
 *
 * Differences from desktopAliveRuntime (Science), which stays unchanged:
 *  - No hidden chat, no Work invocation, no tools/MCP/CLI conventions: the runner's judgment no-tools path with
 *    the controller's own system prompt and a compact observation (controller-prompt.ts).
 *  - The model is resolved per wake from the dashboard role pool (model-order.ts); the resolved runtime is
 *    recorded on an alive event and projected onto the wake receipt, never onto the life's binding.
 *  - hostLost: a wake reserved by an earlier process lifetime is reported as interrupted instead of holding
 *    "wake.active" forever. Charge per invariant (c): no attempt row = a known 0; an attempt row without
 *    usage = unknown (fail-closed; the owner's re-grant is the way out).
 */
import type { AliveRuntimePort, AliveRuntimeReceipt, AliveRuntimeStart, AliveWakeRuntimeRecord } from "../alive-core/contracts";
import type { AliveLifetimeStore } from "../alive-core/lifetime-store";
import type { RuntimeSelection, RuntimeStatus } from "../../shared/types";
import { aliveActionRegistration } from "../alive-core/action-registry";
import { ALIVE_GOAL_DECISION_OUTPUT_SCHEMA, parseAliveGoalDecision } from "./goal-decision";
import { ALIVE_GOAL_CONTROLLER_PROMPT, compactWakeInput } from "./controller-prompt";
import type { LightWakeRow, LightWakeRunner } from "./light-wake";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const ALIVE_WAKE_RUNTIME_EVENT = "wake.runtime-selected";

export interface GoalRuntimeDeps {
  organism: "work" | "one";
  processStartedAtMs: number;
  resolveSelection(): { selection: RuntimeSelection; status: RuntimeStatus; record: AliveWakeRuntimeRecord } | null;
  light: LightWakeRunner;
  now(): number;
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
    // Invariant (c): every refusal before the light runner's attempt row charges 0 tokens.
    const resolved = this.deps.resolveSelection();
    if (!resolved) return { accepted: false, reasonCode: "alive-model-order-exhausted" };
    let userPrompt: string;
    try { userPrompt = compactWakeInput(input); } catch { return { accepted: false, reasonCode: "alive-runtime-context-invalid" }; }
    if (Buffer.byteLength(userPrompt, "utf8") > 16 * 1024) return { accepted: false, reasonCode: "alive-runtime-context-too-large" };
    this.store.event(input.agentId, ALIVE_WAKE_RUNTIME_EVENT, { wakeId: input.wakeId, ...resolved.record,
      processStartedAtMs: this.deps.processStartedAtMs }, this.deps.now());
    const started = this.deps.light.start({ wakeId: input.wakeId, agentId: input.agentId, status: resolved.status,
      selection: resolved.selection, systemPrompt: ALIVE_GOAL_CONTROLLER_PROMPT, userPrompt, schema: ALIVE_GOAL_DECISION_OUTPUT_SCHEMA });
    return started.accepted ? { accepted: true, runId: input.wakeId } : { accepted: false, reasonCode: started.reasonCode ?? "alive-runtime-start-failed" };
  }

  cancel(runId: string): void { if (UUID.test(runId)) this.deps.light.cancel(runId); }

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

  /** A wake no live owner can settle: reserved by an earlier process lifetime and not running here. */
  hostLost(wakeId: string): boolean {
    if (this.deps.light.isActive(wakeId)) return false;
    const wake = this.store.db.prepare("SELECT created_at_ms FROM alive_wakes WHERE wake_id=? AND status IN ('reserved','running')")
      .get(wakeId) as { created_at_ms: number } | undefined;
    return Boolean(wake && wake.created_at_ms < this.deps.processStartedAtMs);
  }

  private convert(row: LightWakeRow): AliveRuntimeReceipt | null {
    if (!this.store.owns(row.agentId) || row.status === "running") return null;
    const known = Number.isSafeInteger(row.inputTokens) && Number.isSafeInteger(row.outputTokens);
    const decision = row.status === "completed" && row.finalText ? parseAliveGoalDecision(row.finalText.trim()) : undefined;
    const runtime = this.runtimeRecord(row.agentId, row.wakeId);
    return { runId: row.wakeId, status: row.status,
      ...(known ? { tokensUsed: Number(row.inputTokens) + Number(row.outputTokens) } : {}),
      ...(row.finalText ? { finalText: row.finalText.slice(0, 4_096) } : {}),
      ...(row.errorCode ? { errorCode: row.errorCode } : {}),
      ...(decision ? { decision } : {}), ...(runtime ? { runtime } : {}) };
  }

  receipt(runId: string): AliveRuntimeReceipt | null {
    if (!UUID.test(runId)) return null;
    const row = this.deps.light.row(runId);
    if (row && row.status !== "running") return this.convert(row);
    if (!this.hostLost(runId)) return null;
    const agentId = row?.agentId ?? this.store.wakeAgentId(runId);
    if (!agentId || !this.store.owns(agentId)) return null;
    const runtime = this.runtimeRecord(agentId, runId);
    if (row) this.store.db.prepare("UPDATE alive_light_wakes SET status='interrupted',error_code='alive-host-lost',settled_at_ms=? WHERE wake_id=? AND status='running'")
      .run(this.deps.now(), runId);
    // An attempt row that never settled may have been billed: unknown. No row: the provider was never called.
    return { runId, status: "interrupted", errorCode: "alive-host-lost", ...(row ? {} : { tokensUsed: 0 }), ...(runtime ? { runtime } : {}) };
  }

  onSettled(listener: (receipt: AliveRuntimeReceipt) => void): () => void {
    return this.deps.light.onSettled((row) => {
      const receipt = this.convert(row);
      if (receipt) listener(receipt);
    });
  }
}
