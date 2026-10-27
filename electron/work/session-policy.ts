import { composeDeclaredPrompt, registerDeclaredPromptModule } from "../runtime/prompt-order";
import { WORK_SESSION_TOOL_DEFINITIONS } from "../../shared/work-session-tools";

/** Identity and explicit execution contracts, never the length/words of the owner's request. */
export function workMainOwnsRouting(input: {
  originSurface?: string | null; kind?: string | null; agentAppMode?: boolean;
  source?: string; explicitExecution?: boolean;
}): boolean {
  return input.originSurface === "work" && (input.kind === "user" || input.kind == null)
    && !input.agentAppMode && input.source !== "science" && input.source !== "automation"
    && input.explicitExecution !== true;
}

export function workSessionMainPolicy(): string {
  return composeDeclaredPrompt([
    { id: "work.session.main.role", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 0,
      text: "Work: you remain this conversation's main AI; own dialogue, execution choices, progress and recovery. Answer/do work yourself when sufficient; specialists are optional tools, never a mandatory roster." },
    { id: "work.session.main.delegation", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 10,
      text: "Delegate independent work through work_session_agents/delegate with focused done criteria and a suitable advertised model/effort. A returned handle is accepted work, not completion. End the turn while children work; their reports return here. Handle new owner messages without restarting the task tree." },
    { id: "work.session.main.recovery", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 20,
      text: "Recovery: read typed cause, delivery and effect evidence; fix the smallest failed step, change the plan/tool/runtime when appropriate, preserve verified outputs. A waiting resource is not task failure. Unknown external effects require observation before replay. Ask only for missing owner-only access or decisions; report actual blockers accurately." },
    { id: "work.session.main.goal", revision: 1, stability: "fixed-policy", changeTriggers: ["release"], order: 30,
      text: "Goal association preserves the objective and obligations; a side question does not restart its workers or prove goal completion. Internal child failures are diagnostic input for your next action, not an automatic final failure message to the owner." },
  ], "\n");
}

registerDeclaredPromptModule({ id: "work.session.tools", revision: 2, stability: "fixed-policy", changeTriggers: ["release"], order: 0 });
/** Canonical declared tool descriptions, consumed by native MCP and in-process providers alike. */
export function workSessionToolDefinitions(): typeof WORK_SESSION_TOOL_DEFINITIONS { return WORK_SESSION_TOOL_DEFINITIONS; }
