/** Main-owned final-answer shape for an independent Alive wake. */
export const ALIVE_DECISION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    schema: { type: "string", enum: ["agentlas.alive-decision.v2"] },
    kind: { type: "string", enum: ["wait", "review", "act"] },
    reason: { type: "string" },
    nextWakeAtMs: { type: ["integer", "null"] },
    // Structured-output runtimes require every property. The host accepts
    // action=null only for wait/review; act still needs the exact typed binding.
    action: {
      type: ["object", "null"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["science.continue_research"] },
        attachmentId: { type: "string" },
        expected: {
          type: "object",
          additionalProperties: false,
          properties: {
            loopSessionId: { type: "string" },
            loopVersion: { type: "integer" },
            loopStateSha256: { type: "string" },
            conversationStopEpoch: { type: "integer" },
            approvalPolicySha256: { type: "string" },
          },
          required: ["loopSessionId", "loopVersion", "loopStateSha256", "conversationStopEpoch", "approvalPolicySha256"],
        },
      },
      required: ["kind", "attachmentId", "expected"],
    },
  },
  required: ["schema", "kind", "reason", "nextWakeAtMs", "action"],
};
