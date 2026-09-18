import { createHash } from "node:crypto";
import type { AdapterEffectReport } from "../invocation/adapter-effect-context";
import { mcpEffectOutputDigest, type MainMcpEffectReceipt } from "../mcp-tools/effect-receipts";

/** These synchronous read primitives have no background command/session handle.
 * DONE for shell, browser, MCP or delegated tools does not prove job quiescence. */
const SYNCHRONOUS_READS = new Set(["view_file", "list_dir"]);
const MAX_TRACKED_TOOLS = 4096;
const MAX_FRAME_KINDS = 128;
export class AntigravityEffectCoverage {
  private readonly tools = new Map<number, { id: string; name: string; started: boolean; completed: boolean; failed: boolean; parameters?: unknown; resultDigest: string | null; outputDigest: string | null }>();
  private readonly stepTypes = new Map<number, string>();
  private readonly metadataSteps = new Set<number>();
  private readonly reasons = new Set<string>();
  private readonly frames = new Set<string>();
  private terminal: string | null = null;
  private resultSeen = false;
  private conversationId: string | null = null;
  constructor(private readonly scopeId: string,
    private readonly claimMcpEffect?: (server: string, tool: string, args: unknown, failed: boolean, operationId: string, outputDigest: string | null) => MainMcpEffectReceipt | undefined,
    private readonly unmatchedMcpEffects?: () => number,
    private readonly attestMetadataSteps?: (conversationId: string, indices: readonly number[]) => boolean) {}
  toolId(id: string): string { return `${this.scopeId}:${id}`; }
  private frame(kind: string): void {
    if (this.frames.size < MAX_FRAME_KINDS || this.frames.has(kind)) this.frames.add(kind);
    else this.reasons.add("frame-kind-limit-exceeded");
  }
  /** The protocol may send sparse updates for an already identified step. Both
   * display/tool events and effect coverage must consume this identical frame. */
  normalizeLine(line: string): string {
    let value: any;
    try { value = JSON.parse(line); } catch { return line; }
    const step = value?.event === "step_update" ? value.step_update : null;
    if (!step || typeof step !== "object" || Array.isArray(step) || !Number.isSafeInteger(step.step_index) || step.step_index < 0) return line;
    const previous = this.stepTypes.get(step.step_index);
    if (step.step_type === undefined && previous) { step.step_type = previous; return JSON.stringify(value); }
    if (typeof step.step_type === "string") {
      if (previous && previous !== step.step_type) this.reasons.add("step-identity-reused");
      if (this.stepTypes.size < MAX_TRACKED_TOOLS || previous) this.stepTypes.set(step.step_index, step.step_type);
      else this.reasons.add("step-count-limit-exceeded");
    }
    return line;
  }
  observe(line: string): void {
    if (!line.trim()) return;
    let value: any;
    try { value = JSON.parse(this.normalizeLine(line)); } catch { this.reasons.add("unparsed-stream-frame"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { this.reasons.add("invalid-stream-frame"); return; }
    if (this.resultSeen) this.reasons.add("frame-after-terminal");
    const event = value.event;
    this.frame(typeof event === "string" && /^[a-z_]{1,40}$/.test(event) ? event : "unknown");
    for (const conversation of [value.conversation_id, value.result?.conversation_id, value.step_update?.conversation_id].filter(item => item !== undefined)) {
      if (typeof conversation !== "string" || !conversation || conversation.length > 256) this.reasons.add("conversation-identity-invalid");
      else if (this.conversationId && this.conversationId !== conversation) this.reasons.add("conversation-identity-changed");
      else this.conversationId = conversation;
    }
    if (event === "result") {
      if (this.resultSeen) this.reasons.add("duplicate-terminal");
      this.resultSeen = true;
      this.terminal = typeof value.result?.status === "string" ? value.result.status : null;
      if (this.terminal !== "SUCCESS" || value.result?.error != null || value.result?.error_code != null || value.result?.errorCode != null
        || (value.result?.denied_actions !== undefined && (!Array.isArray(value.result.denied_actions) || value.result.denied_actions.length))) this.reasons.add("terminal-not-successful");
      return;
    }
    if (event === "init" || event === "checkpoint") return;
    if (event !== "step_update" || !value.step_update || typeof value.step_update !== "object") { this.reasons.add("unsupported-stream-frame"); return; }
    const step = { ...value.step_update };
    this.frame(`step:${typeof step.step_type === "string" && /^[a-z_]{1,40}$/.test(step.step_type) ? step.step_type : "unknown"}`);
    if (step.step_type === "unknown" && step.state === "DONE" && Number.isSafeInteger(step.step_index) && step.step_index >= 0
      && Number.isFinite(step.duration_seconds) && step.duration_seconds >= 0
      && Object.keys(value).every(key => ["event", "conversation_id", "step_update"].includes(key))
      && Object.keys(step).every(key => ["conversation_id", "step_index", "state", "step_type", "duration_seconds"].includes(key))) {
      if (this.metadataSteps.size < MAX_TRACKED_TOOLS) this.metadataSteps.add(step.step_index);
      else this.reasons.add("step-count-limit-exceeded");
      return;
    }
    // Input/system messages are protocol frames, not operations. They cannot
    // carry a tool payload. Missing types are accepted only for a known index.
    if (step.step_type === "user_input" || step.step_type === "system_message" || step.step_type === "checkpoint") {
      if (step.tool_info !== undefined || step.tool_name !== undefined || step.subagent_info !== undefined
        || !["ACTIVE", "DONE"].includes(step.state)) this.reasons.add("invalid-metadata-step");
      return;
    }
    if (step.step_type === "agent_response") {
      if (step.tool_info !== undefined || step.tool_name !== undefined || step.subagent_info !== undefined) this.reasons.add("invalid-agent-step");
      if (step.state === "ERROR") this.reasons.add("agent-step-error");
      else if (step.state !== "ACTIVE" && step.state !== "DONE") this.reasons.add("unsupported-agent-state");
      return;
    }
    if (step.step_type !== "tool") { this.reasons.add("unsupported-step-type"); return; }
    const index = step.step_index, name = step.tool_name || step.tool_info?.name;
    if (!Number.isSafeInteger(index) || index < 0 || typeof name !== "string" || !name || name.length > 128) { this.reasons.add("tool-identity-missing"); return; }
    const prior = this.tools.get(index);
    if (!prior && this.tools.size >= MAX_TRACKED_TOOLS) { this.reasons.add("tool-count-limit-exceeded"); return; }
    if (prior && prior.name !== name) this.reasons.add("tool-identity-reused");
    const tool = prior ?? { id: this.toolId(`agy-tool:${name}:${index}`), name, started: false, completed: false, failed: false, resultDigest: null, outputDigest: null, parameters: step.tool_info?.parameters };
    if (step.tool_info?.parameters !== undefined) tool.parameters = step.tool_info.parameters;
    this.tools.set(index, tool);
    if (step.state === "ACTIVE") {
      if (tool.completed) this.reasons.add("tool-start-after-result");
      tool.started = true;
    } else if (step.state === "DONE" || step.state === "ERROR") {
      if (!tool.started) this.reasons.add("tool-start-missing");
      let output = step.tool_info?.output;
      if (typeof output === "string") { try { output = JSON.parse(output); } catch { /* Opaque display text. */ } }
      tool.failed ||= step.state === "ERROR" || step.tool_info?.error != null || output?.isError === true || output?.is_error === true;
      if (!step.tool_info || !Object.hasOwn(step.tool_info, "output")) this.reasons.add("tool-result-payload-missing");
      const digest = createHash("sha256").update(JSON.stringify(step.tool_info?.output) ?? "undefined").digest("hex");
      if (tool.resultDigest && tool.resultDigest !== digest) this.reasons.add("conflicting-tool-result");
      tool.resultDigest = digest; tool.outputDigest = mcpEffectOutputDigest(step.tool_info?.output); tool.completed = true;
    } else this.reasons.add("unsupported-tool-state");
  }
  finish(input: { exitCode: number | null; stdoutEnded: boolean; cancelled: boolean; failed: boolean }): AdapterEffectReport {
    if (!this.resultSeen) this.reasons.add("terminal-missing");
    if (!this.conversationId) this.reasons.add("conversation-identity-missing");
    if (this.metadataSteps.size) {
      if (!this.conversationId || !this.attestMetadataSteps?.(this.conversationId, [...this.metadataSteps])) this.reasons.add("unsupported-step-type");
      else this.frame("step:ephemeral_message");
    }
    if (input.exitCode !== 0 || !input.stdoutEnded || input.cancelled || input.failed) this.reasons.add("transport-not-successfully-drained");
    const settledFailureIds: string[] = [];
    for (const tool of this.tools.values()) {
      if (!tool.started || !tool.completed) this.reasons.add("tool-incomplete");
      let settled = SYNCHRONOUS_READS.has(tool.name), settledFailure = false;
      if (tool.name === "call_mcp_tool") {
        let call = tool.parameters as any;
        if (typeof call === "string") { try { call = JSON.parse(call); } catch { call = null; } }
        if (call && typeof call.ServerName === "string" && typeof call.ToolName === "string" && call.Arguments && typeof call.Arguments === "object" && !Array.isArray(call.Arguments)) {
          const receipt = this.claimMcpEffect?.(call.ServerName, call.ToolName, call.Arguments, tool.failed, tool.id, tool.outputDigest);
          settled = receipt?.state === "settled";
          if (receipt && receipt.failed !== tool.failed) this.reasons.add("host-tool-outcome-mismatch");
          settledFailure = settled && receipt?.failed === true && tool.failed;
        }
      }
      if (!settled) this.reasons.add("tool-quiescence-contract-unconfirmed");
      if (tool.failed && !settledFailure) this.reasons.add("tool-failed");
      if (settledFailure) settledFailureIds.push(tool.id);
    }
    if (this.unmatchedMcpEffects?.()) this.reasons.add("host-tool-receipt-unmatched");
    return { schemaVersion: "agentlas.adapter-effect-coverage.v1", protocol: this.claimMcpEffect ? "agy-stream-json-main-receipts.v2" : "agy-stream-json-synchronous-read.v1", complete: this.reasons.size === 0,
      terminal: this.terminal, operationIds: [...this.tools.values()].map(tool => tool.id).sort(), frameKinds: [...this.frames].sort(), reasons: [...this.reasons].sort(),
      ...(settledFailureIds.length ? { settledFailureIds: settledFailureIds.sort() } : {}) };
  }
}
