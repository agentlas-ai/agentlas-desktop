import { isHostPreflightTool } from "../../shared/tool-activity";
import type { McpInvocationEvent } from "../../shared/types";
import { getDb } from "../store/db";
import { recordRunEvent } from "../store/run-events";
import type { AdapterEffectAdmission, AdapterEffectReport } from "./adapter-effect-context";
import { boundEffectBoundary } from "./effect-metadata";
import { verifyScienceFailureSettlement, type ScienceToolCorrelation } from "./science-failure-settlement";

// These adapters forward a provider tool-result block or a completed Main tool
// dispatch with an explicit isError boolean. ACP/Antigravity and unknown
// adapters have incomplete result coverage and cannot attest quiescence here.
const RESULT_COVERAGE = new Set(["claude-code", "codex", "byok", "ollama", "lmstudio", "mlx", "agentlas-local"]);
/** Shared Main contract, not a provider-supplied no-tools attestation. */
export function hasCallbackResultCoverage(kind: string): boolean { return RESULT_COVERAGE.has(kind); }
/** Host capability/Goal notices lack provider operation identity, arguments and
 * typed outcome. A real provider operation sharing the display name still counts. */
export function isEffectStatusOnlyTool(tool: {name:string;id?:unknown;args?:unknown;isError?:unknown}): boolean {
  return (isHostPreflightTool(tool.name) || tool.name === "Goal")
    && tool.id === undefined && tool.args === undefined && tool.isError === undefined;
}
/** Main-stamped preparation may close only with a complete, empty effect report.
 * It never supplies operation proof or substitutes for a root adapter run. */
export function isSettledPreparationScope(scope: { purpose?: unknown; chatId: string | null; report: AdapterEffectReport | null }, chatId: string): boolean {
  return scope.purpose === "preparation" && scope.chatId === chatId && scope.report?.complete === true
    && scope.report.operationIds.length === 0 && (scope.report.settledFailureIds?.length ?? 0) === 0
    && scope.report.reasons.length === 0;
}
interface Operation {
  key: string; toolId: string | null; startObserved: boolean; resultObserved: boolean;
  outcome: "pending" | "succeeded" | "failed" | "unknown";
}
export interface RuntimeEffectBoundaryReceipt {
  schemaVersion: "agentlas.runtime-effect-boundary.v1";
  terminalEventId: string; terminalSeq: number;
  adapterKinds: string[]; coverage: "complete" | "unknown";
  effects: "settled" | "uncertain"; ledgerComplete: boolean; observedToolEventCount: number;
  operations: Operation[]; pendingEffectRefs: string[];
  adapterScopes?: Array<AdapterEffectAdmission & { report: AdapterEffectReport | null }>;
}
/** Main owns this instance from invocation start until the runner promise
 * settles. Tool text is never interpreted. Result arrival + typed provider error
 * status confirms dispatch settlement, not domain correctness or verification. */
export class InvocationEffectBoundaryTracker {
  private readonly operations = new Map<string, Operation>();
  private readonly adapters = new Set<string>();
  private readonly uncertainties = new Set<string>();
  private ledgerComplete = true;
  private observedTools = 0;
  private durableTools = 0;
  private readonly adapterScopes = new Map<string, AdapterEffectAdmission & { report: AdapterEffectReport | null }>();
  private readonly scienceCorrelations = new Map<string, ScienceToolCorrelation>();
  constructor(private readonly runId: string, private readonly chatId: string) {}
  nativeScienceTool(binding: ScienceToolCorrelation): void {
    if (binding.invocationRunId !== this.runId || binding.chatId !== this.chatId) { this.uncertainties.add("science-native-binding-mismatch"); return; }
    const previous = this.scienceCorrelations.get(binding.providerToolId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(binding)) this.uncertainties.add("science-native-binding-conflict");
      return;
    }
    this.scienceCorrelations.set(binding.providerToolId, binding);
    try { recordRunEvent({ runId: this.runId, chatId: this.chatId, kind: "runtime_science_tool_correlation",
      sourceEventId: `science-native:${this.runId}:${binding.providerToolId}`, payload: { ...binding } }); }
    catch { this.recordingFailed(); }
  }
  adapterStarted(admission: AdapterEffectAdmission): void {
    if (this.adapterScopes.has(admission.scopeId)) { this.uncertainties.add("adapter-scope-duplicate"); return; }
    this.adapterScopes.set(admission.scopeId, { ...admission, report: null });
    try { recordRunEvent({ runId: this.runId, chatId: this.chatId, kind: "runtime_adapter_effect_started", sourceEventId: `adapter-effect:${admission.scopeId}:started`, payload: { ...admission } }); }
    catch { this.recordingFailed(); }
  }
  adapterFinished(scopeId: string, report: AdapterEffectReport): void {
    const scope = this.adapterScopes.get(scopeId);
    if (!scope || scope.report) { this.uncertainties.add("adapter-scope-unbound-result"); return; }
    scope.report = structuredClone(report);
    try { recordRunEvent({ runId: this.runId, chatId: this.chatId, kind: "runtime_adapter_effect_completed", sourceEventId: `adapter-effect:${scopeId}:result`, payload: { ...scope } }); }
    catch { this.recordingFailed(); }
  }
  observe(event: McpInvocationEvent): void {
    if (event.notice?.code === "runtime-selected" && event.runtimeSelection) this.adapters.add(event.runtimeSelection.kind);
    if (event.kind === "error" || event.nodeState === "failed") this.uncertainties.add("runtime_reported_failure");
    if (event.kind !== "tool-use" || !event.tool || isEffectStatusOnlyTool(event.tool)) return;
    this.observedTools++;
    const tool = event.tool;
    const key = `${event.agentId ?? "root"}:${event.nodeId ?? "root"}:${tool.id || `unidentified-${this.observedTools}`}`;
    const prior = this.operations.get(key);
    const hasResult = typeof tool.result === "string";
    const outcome = hasResult ? (tool.isError === false && !tool.failureCode ? "succeeded" : tool.isError === true ? "failed" : "unknown") : "pending";
    // A failed/unknown outcome is never erased by a later successful-looking
    // duplicate. A new attempt must carry a different provider operation ID.
    this.operations.set(key, { key, toolId:tool.id || null,
      startObserved:prior?.startObserved === true || !hasResult,
      resultObserved:prior?.resultObserved === true || hasResult,
      outcome: prior?.outcome === "failed" || prior?.outcome === "unknown" ? prior.outcome : hasResult ? outcome : prior?.outcome ?? "pending" });
    if (!tool.id) this.uncertainties.add(`operation:${key}:identity-missing`);
    if (event.agentId || event.nodeId) this.uncertainties.add(`operation:${key}:nested-adapter-coverage-unconfirmed`);
  }
  recorded(event: McpInvocationEvent): void { if (event.kind === "tool-use" && event.tool && !isEffectStatusOnlyTool(event.tool)) this.durableTools++; }
  recordingFailed(): void { this.ledgerComplete = false; }
  /** Called only after the whole runtime promise settles, not on model final. */
  persist(): RuntimeEffectBoundaryReceipt | null {
    const db=getDb();
    return db.transaction(() => {
      const terminal=db.prepare("SELECT id, seq, kind FROM run_events WHERE run_id=? AND chat_id=? AND kind IN ('invoke_completed','invoke_failed','invoke_threw','invoke_cancelled','invoke_interrupted') ORDER BY seq DESC LIMIT 1")
        .get(this.runId,this.chatId) as {id:string;seq:number;kind:string}|undefined;
      if (!terminal) return null;
      const pending=new Set(this.uncertainties);
      const settledFailures = new Set([...this.adapterScopes.values()].filter(scope => scope.rootBound && scope.chatId === this.chatId && scope.report?.complete)
        .flatMap(scope => scope.report?.settledFailureIds ?? []));
      const dynamicCovered = (kind: string): boolean => {
        const scopes = [...this.adapterScopes.values()].filter(scope => scope.adapterKind === kind);
        return scopes.some(scope => scope.rootBound && scope.chatId === this.chatId && scope.report?.complete === true)
          && scopes.every(scope => scope.chatId === this.chatId && scope.report?.complete === true
            && (scope.rootBound || isSettledPreparationScope(scope, this.chatId)));
      };
      const coverage=this.adapters.size>0 && [...this.adapters].every(kind=>RESULT_COVERAGE.has(kind) || dynamicCovered(kind)) ? "complete" : "unknown";
      if (coverage === "unknown") pending.add("adapter-result-coverage-unconfirmed");
      const reportedIds = new Set<string>();
      for (const scope of this.adapterScopes.values()) {
        if (!scope.rootBound && !isSettledPreparationScope(scope, this.chatId)) pending.add(`adapter:${scope.scopeId}:nested-or-unbound`);
        if (!scope.rootBound && isSettledPreparationScope(scope, this.chatId) && !dynamicCovered(scope.adapterKind)) pending.add(`adapter:${scope.scopeId}:root-execution-unconfirmed`);
        if (scope.chatId !== this.chatId) pending.add(`adapter:${scope.scopeId}:chat-binding-mismatch`);
        if (!scope.report?.complete) pending.add(`adapter:${scope.scopeId}:incomplete`);
        for (const reason of scope.report?.reasons ?? []) pending.add(`adapter:${scope.scopeId}:${reason}`);
        for (const id of scope.report?.operationIds ?? []) {
          if (reportedIds.has(id)) pending.add(`adapter-operation:${id}:reused-across-dispatches`);
          reportedIds.add(id);
          const observed = this.operations.get(`root:root:${id}`);
          if (!observed?.startObserved || !observed.resultObserved || observed.outcome !== (settledFailures.has(id) ? "failed" : "succeeded")) pending.add(`adapter-operation:${id}:ledger-mismatch`);
        }
      }
      if ([...this.adapters].some(kind => !RESULT_COVERAGE.has(kind))) {
        for (const operation of this.operations.values()) if (!operation.toolId || !reportedIds.has(operation.toolId)) pending.add(`operation:${operation.key}:adapter-receipt-missing`);
      }
      if (terminal.kind !== "invoke_completed") pending.add(`terminal:${terminal.id}:not-successful`);
      const ledgerComplete=this.ledgerComplete && this.observedTools===this.durableTools;
      if (!ledgerComplete) pending.add("runtime-effect-ledger-incomplete");
      for (const operation of this.operations.values()) {
        const correlation = operation.toolId && this.scienceCorrelations.get(operation.toolId);
        if (operation.outcome !== "failed" || !correlation) continue;
        // Intentionally no producer: capture is not proof of effect settlement.
        // Adding a producer also requires durable reader/snapshot verification;
        // never retrofit the old immutable uncertain boundary in this loop.
        const decision = verifyScienceFailureSettlement(correlation);
        if (!decision.settled) pending.add(`operation:${operation.key}:${decision.code}`);
      }
      for(const operation of this.operations.values()) if(operation.outcome !== (operation.toolId && settledFailures.has(operation.toolId) ? "failed" : "succeeded")) pending.add(`operation:${operation.key}:${operation.outcome}`);
      const receipt=boundEffectBoundary({schemaVersion:"agentlas.runtime-effect-boundary.v1",terminalEventId:terminal.id,terminalSeq:terminal.seq,
        adapterKinds:[...this.adapters].sort(),coverage,effects:pending.size?"uncertain":"settled",ledgerComplete,observedToolEventCount:this.observedTools,
        operations:[...this.operations.values()].sort((a,b)=>a.key.localeCompare(b.key)),pendingEffectRefs:[...pending].sort(),adapterScopes:[...this.adapterScopes.values()]},this.runId);
      recordRunEvent({runId:this.runId,chatId:this.chatId,kind:"runtime_effect_boundary",sourceEventId:`runtime-effect-boundary:${this.runId}:${terminal.id}`,
        evidencePhase:receipt.effects==="settled"?"executed":"uncertain",payload:{...receipt}});
      return receipt;
    })();
  }
}
