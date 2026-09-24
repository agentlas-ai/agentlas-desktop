/**
 * Desktop Alive lifetime contracts — a generalized port of agentlas-science/src/alive/contracts.ts.
 *
 * The Science copy hard-codes one action kind (science.continue_research). Here an action is any kind a
 * playground registered in ./action-registry ("<family>.<verb>", e.g. goal.continue), with an `expected`
 * fence whose exact keys and value shapes that registration validates. Nothing in this directory knows
 * about One, Work, goals or model providers; the host glue lives in electron/alive-organisms/.
 */
export interface AliveBudget { tokenLimit: number | null; tokensUsed: number; deadlineMs: number | null }
export interface AliveAttachment {
  attachmentId: string; agentId: string; domain: string; scope: Record<string, unknown>; status: "attached" | "detached";
}
export interface AliveAgent {
  agentId: string; purpose: string; status: "enabled" | "suspended" | "retired"; controlEpoch: number;
  state: Record<string, unknown>; budget: AliveBudget;
  /**
   * The runtime POLICY this life runs under (for One/Work: the dashboard role-pool order), never the model a
   * particular wake resolved to. Writing a per-wake model here would read as a binding change every wake.
   */
  runtimeBinding: unknown; version: number;
}
export interface AliveRuntimeStart {
  agentId: string; wakeId: string; controlEpoch: number; runtimeBinding: unknown; purpose: string; reasonCode: string;
  context: {
    attachments: Array<{ attachmentId: string; domain: string; scope: Record<string, unknown>;
      work: AlivePlaygroundObservation["work"]; blockedBy: string | null; observation: Record<string, unknown> }>;
    state: Record<string, unknown>; budget: AliveBudget; capabilities: string[];
  };
}
/** A controller may propose one registered action; its identity and domain binding are host supplied. */
export interface AliveActionProposal {
  kind: string;
  attachmentId: string;
  expected: Record<string, unknown>;
}
/** Host-built packet; the playground receives exactly the proposal's fence plus host identity. */
export interface AliveActionPacket {
  schema: "agentlas.alive-action.v1";
  action: string;
  actionId: string;
  attachmentId: string;
  domain: string;
  scope: Record<string, unknown>;
  expected: Record<string, unknown>;
}
export interface AliveActionResult {
  ok: boolean; actionId: string; code: string; replayed?: boolean; invocationRunId?: string;
}
export type AliveDecision =
  | { kind: "wait" | "review"; reason: string; nextWakeAtMs: number | null }
  | { kind: "act"; reason: string; nextWakeAtMs: number | null; action: AliveActionProposal };
/** What actually executed one wake. Recorded on the wake receipt, never on the agent binding. */
export interface AliveWakeRuntimeRecord {
  role: "orchestrator" | "worker"; position: number; kind: string; backend: string | null; model: string; label: string;
}
export interface AliveRuntimeReceipt {
  runId: string; status: "completed" | "failed" | "cancelled" | "interrupted";
  tokensUsed?: number; finalText?: string; errorCode?: string;
  /** Only a validated structured controller result may populate this; never infer it from prose. */
  decision?: AliveDecision;
  runtime?: AliveWakeRuntimeRecord;
}
export interface AliveRuntimePort {
  /** wakeId is the stable invocation run id, including across crash recovery. */
  start(input: AliveRuntimeStart): { accepted: boolean; runId?: string; reasonCode?: string };
  cancel(runId: string): void;
  receipt(runId: string): AliveRuntimeReceipt | null;
  onSettled(listener: (receipt: AliveRuntimeReceipt) => void): () => void;
}
/** The containing app owns elapsed time; a playground does not own an agent's clock. */
export interface AliveClockPort {
  schedule(input: { ownerId: string; intervalMs: number; onBeat: () => void }): () => void;
}
export interface AlivePlaygroundObservation {
  work: "none" | "running" | "paused" | "terminal";
  observation: Record<string, unknown>;
  /** Stable, meaningful sensory change that may wake the agent; detail may change without spending a model turn. */
  salience?: Record<string, unknown>;
  /** Hard admission from the attached domain; a controller cannot bypass an explicit stop. */
  blockedBy?: string | null;
}
export interface AlivePlaygroundPort {
  observe(attachment: AliveAttachment, nowMs: number): AlivePlaygroundObservation;
  /** Must verify current domain authority and durably deduplicate actionId before any side effect. */
  execute?(attachment: AliveAttachment, action: AliveActionPacket, nowMs: number): AliveActionResult;
  /** Read-only recovery for a dispatch whose return receipt may have been lost. */
  actionReceipt?(actionId: string): AliveActionResult | null;
}
