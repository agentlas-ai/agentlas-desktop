import { createHash } from "node:crypto";
import type { AdapterEffectReport } from "../invocation/adapter-effect-context";

/** These synchronous read primitives have no background command/session handle.
 * DONE for shell, browser, MCP or delegated tools does not prove job quiescence. */
const SYNCHRONOUS_READS = new Set(["view_file", "list_dir"]);
const MAX_TRACKED_TOOLS = 4096;
const MAX_FRAME_KINDS = 128;
export class AntigravityEffectCoverage {
  private readonly tools = new Map<number, { id: string; name: string; started: boolean; completed: boolean; resultDigest: string | null }>();
  private readonly reasons = new Set<string>();
  private readonly frames = new Set<string>();
  private terminal: string | null = null;
  private resultSeen = false;
  private conversationId: string | null = null;
  constructor(private readonly scopeId: string) {}
  toolId(id: string): string { return `${this.scopeId}:${id}`; }
  private frame(kind: string): void {
    if (this.frames.size < MAX_FRAME_KINDS || this.frames.has(kind)) this.frames.add(kind);
    else this.reasons.add("frame-kind-limit-exceeded");
  }
  observe(line: string): void {
    if (!line.trim()) return;
    let value: any;
    try { value = JSON.parse(line); } catch { this.reasons.add("unparsed-stream-frame"); return; }
    if (!value || typeof value !== "object" || Array.isArray(value)) { this.reasons.add("invalid-stream-frame"); return; }
    if (this.resultSeen) this.reasons.add("frame-after-terminal");
    const event = value.event;
    this.frame(typeof event === "string" && /^[a-z_]{1,40}$/.test(event) ? event : "unknown");
    const conversation = value.conversation_id ?? value.result?.conversation_id ?? value.step_update?.conversation_id;
    if (conversation !== undefined) {
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
    const step = value.step_update;
    this.frame(`step:${typeof step.step_type === "string" && /^[a-z_]{1,40}$/.test(step.step_type) ? step.step_type : "unknown"}`);
    if (step.step_type === "agent_response") {
      if (step.state === "ERROR") this.reasons.add("agent-step-error");
      else if (step.state !== "ACTIVE" && step.state !== "DONE") this.reasons.add("unsupported-agent-state");
      return;
    }
    if (step.step_type !== "tool") { this.reasons.add("unsupported-step-type"); return; }
    const index = step.step_index, name = step.tool_name || step.tool_info?.name;
    if (!Number.isSafeInteger(index) || index < 0 || typeof name !== "string" || !name || name.length > 128) { this.reasons.add("tool-identity-missing"); return; }
    if (!SYNCHRONOUS_READS.has(name)) this.reasons.add("tool-quiescence-contract-unconfirmed");
    const prior = this.tools.get(index);
    if (!prior && this.tools.size >= MAX_TRACKED_TOOLS) { this.reasons.add("tool-count-limit-exceeded"); return; }
    if (prior && prior.name !== name) this.reasons.add("tool-identity-reused");
    const tool = prior ?? { id: this.toolId(`agy-tool:${name}:${index}`), name, started: false, completed: false, resultDigest: null };
    this.tools.set(index, tool);
    if (step.state === "ACTIVE") {
      if (tool.completed) this.reasons.add("tool-start-after-result");
      tool.started = true;
    } else if (step.state === "DONE" || step.state === "ERROR") {
      if (!tool.started) this.reasons.add("tool-start-missing");
      if (step.state === "ERROR" || step.tool_info?.error != null) this.reasons.add("tool-failed");
      if (!step.tool_info || !Object.hasOwn(step.tool_info, "output")) this.reasons.add("tool-result-payload-missing");
      const digest = createHash("sha256").update(JSON.stringify(step.tool_info?.output) ?? "undefined").digest("hex");
      if (tool.resultDigest && tool.resultDigest !== digest) this.reasons.add("conflicting-tool-result");
      tool.resultDigest = digest; tool.completed = true;
    } else this.reasons.add("unsupported-tool-state");
  }
  finish(input: { exitCode: number | null; stdoutEnded: boolean; cancelled: boolean; failed: boolean }): AdapterEffectReport {
    if (!this.resultSeen) this.reasons.add("terminal-missing");
    if (!this.conversationId) this.reasons.add("conversation-identity-missing");
    if (input.exitCode !== 0 || !input.stdoutEnded || input.cancelled || input.failed) this.reasons.add("transport-not-successfully-drained");
    for (const tool of this.tools.values()) if (!tool.started || !tool.completed) this.reasons.add("tool-incomplete");
    return { schemaVersion: "agentlas.adapter-effect-coverage.v1", protocol: "agy-stream-json-synchronous-read.v1", complete: this.reasons.size === 0,
      terminal: this.terminal, operationIds: [...this.tools.values()].map(tool => tool.id).sort(), frameKinds: [...this.frames].sort(), reasons: [...this.reasons].sort() };
  }
}
