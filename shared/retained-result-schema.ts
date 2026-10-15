/** Complete retained-result read contract, shared by the canonical catalog and host discovery. */
export const RETAINED_RESULT_READ_SCHEMA = {
  type: "object",
  properties: {
    resultRef: { type: "string", minLength: 1 },
    part: { type: "string", enum: ["original", "structured", "artifact", "summary"] },
    cursor: { type: "string", pattern: "^[0-9]*$" },
    limit: { type: "integer", minimum: 1000, maximum: 256000 },
    index: { type: "integer", minimum: 0 },
    chatId: { type: "string", minLength: 1 },
  },
  required: ["resultRef", "part"],
  additionalProperties: false,
} as const;
