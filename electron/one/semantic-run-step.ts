import { createHash } from "node:crypto";
import type { McpInvocationEvent } from "../../shared/types";
import type { AdapterEffectAdmission } from "../invocation/adapter-effect-context";
import { statusOnlyDiagnosticKey } from "../store/runtime-fallback-diagnostic";

export interface SemanticRunStep {
  stepId: string;
  status: "running" | "completed" | "failed";
  publicSafeSummary: string;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Cache retention only: eviction causes fresh/unknown projection, never drops
// an operation or limits execution. All state also dies with its RunRecord.
const MAX_RETAINED_IDENTITIES = 4096;
function retain<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > MAX_RETAINED_IDENTITIES) map.delete(map.keys().next().value!);
}

function isSemanticProgress(event: McpInvocationEvent, sequence: number, chatId: string): boolean {
  // Workforce emits a typed tier in its actual status envelope. It is a
  // phase identity fact, not a tool/control receipt; no other extra is admitted.
  const { tier, ...diagnostic } = event;
  if (tier !== undefined && tier !== 1 && tier !== 2 && tier !== 3) return false;
  return statusOnlyDiagnosticKey({ chatId, userPrompt: "" }, { ...diagnostic, sequence }) !== undefined;
}

/** A projection of semantic transitions, not the original audit stream or an
 * execution authority. Owned by one RunRecord and released with that record.
 * Retain only identities/digests, never tool arguments, results or status copy. */
export class SemanticRunStepProjector {
  private readonly admittedScopes = new Set<string>();
  private authorityRevision = 0;
  private readonly phases = new Map<string, string>();
  private readonly proofs = new Map<string, string>();

  constructor(private readonly runId: string, private readonly chatId: string) {}

  /** Called only from Main's adapter-admission callback, never from event prose. */
  admitAdapter(admission: AdapterEffectAdmission): void {
    if (!admission.scopeId.startsWith(`${this.runId}:`) || admission.chatId !== this.chatId
      || this.admittedScopes.has(admission.scopeId)) return;
    this.admittedScopes.add(admission.scopeId);
    if (this.admittedScopes.size > MAX_RETAINED_IDENTITIES) {
      this.admittedScopes.delete(this.admittedScopes.values().next().value!);
    }
    this.authorityRevision += 1;
  }

  record(event: McpInvocationEvent, sequence: number, persist: (step: SemanticRunStep) => boolean): boolean {
    // Worker streams carry the role/phase tag on every delta. These live-only
    // updates do not create a new task step or consume a phase boundary, just
    // as recordMcpInvocationEvent keeps them out of the durable audit ledger.
    if (event.kind === "partial" || event.kind === "usage"
      || (event.kind === "reasoning" && event.reasoning?.phase === "delta")) return false;
    const actor = event.agentId ?? event.runtimeAgentId ?? "system";
    const phaseProof = digest([this.authorityRevision, event.phase, event.runtimeAgentId,
      event.nodeId, event.role, event.tier, event.modelRole, event.runtimeSelection]);
    const phaseChanged = Boolean(event.phase && this.phases.get(actor) !== phaseProof);
    // Closed diagnostic form, not keyword/status meaning. An actual tool,
    // result, control activity or unknown field cannot enter this branch.
    const progressOnly = isSemanticProgress(event, sequence, this.chatId);
    if (progressOnly && !phaseChanged) return false;

    let step: SemanticRunStep;
    let proof: string | undefined;
    if (event.kind === "tool-use" && !progressOnly) {
      const tool = event.tool;
      const completed = tool?.result !== undefined || tool?.observationDigest !== undefined;
      const status = tool?.isError ? "failed" : completed ? "completed" : "running";
      // Only Main-admitted qualified identities can reuse a semantic step.
      // Legacy/unidentified operational frames stay occurrence-bound unknowns.
      const scope = tool?.id && [...this.admittedScopes].find(id => tool.id!.startsWith(`${id}:`));
      const stepId = scope ? `step:${this.runId}:${digest([scope, tool!.id, actor])}` : `step:${this.runId}:${sequence}`;
      step = { stepId, status, publicSafeSummary: status === "failed" ? "A runtime tool step failed."
        : status === "completed" ? "A runtime tool step completed." : "A runtime tool step started." };
      if (scope) proof = digest([phaseProof, event.model, status, tool]);
    } else if (event.kind === "surface") {
      const id = event.oneSurface?.manifestId ?? event.surfaceId;
      step = { stepId: id ? `step:${this.runId}:${digest(["surface", id])}` : `step:${this.runId}:${sequence}`,
        status: "completed", publicSafeSummary: "Your result is ready." };
      if (id) proof = digest([phaseProof, event.model, event.oneSurface, event.surface, event.surfaceId]);
    } else if (event.agentId && event.phase) {
      step = { stepId: progressOnly ? `step:${this.runId}:${digest([actor, phaseProof])}` : `step:${this.runId}:${sequence}`,
        status: event.done ? "completed" : "running",
        publicSafeSummary: event.done ? "A team role completed its assigned step." : "A team role started an assigned step." };
    } else return false;

    if (proof && this.proofs.get(step.stepId) === proof) return false;
    // A refused/failed domain write is not a committed transition. Next real
    // observation remains eligible; original audit persistence is independent.
    try { if (!persist(step)) return false; } catch { return false; }
    if (proof) retain(this.proofs, step.stepId, proof);
    if (event.phase) retain(this.phases, actor, phaseProof);
    return true;
  }
}
