/** Main-owned final-answer shape for an independent Alive wake. */
export const ALIVE_DECISION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["agentlas.alive-decision.v2"] },
    kind: { type: "string", enum: ["wait", "review", "act"] },
    reason: { type: "string" },
    nextWakeAtMs: { type: ["integer", "null"] },
    // Structured-output runtimes require every property. The host accepts action=null only for wait/review. An act
    // names the attachment only: Science fills the staleness guard (loop version, hashes) from what that wake showed,
    // because a model re-typing 64-hex hashes changed a character and silently lost the decision (live 2026-09-26).
    action: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["science.continue_research"] },
        attachmentId: { type: "string" },
      },
      required: ["kind", "attachmentId"],
    },
  },
  required: ["schema", "kind", "reason", "nextWakeAtMs", "action"],
};
