
















export function openAiStrictSchemaOrNull(schema: unknown): Record<string, unknown> | null {
  return isStrictNode(schema) ? (schema as Record<string, unknown>) : null;
}

function isStrictNode(node: unknown): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  const n = node as Record<string, unknown>;
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = n[key];
    if (branches !== undefined) {
      if (!Array.isArray(branches) || !branches.every(isStrictNode)) return false;
    }
  }
  const type = n.type;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("object")) {
    const props = n.properties;
    if (!props || typeof props !== "object" || Array.isArray(props)) return false;
    if (n.additionalProperties !== false) return false;
    const keys = Object.keys(props as Record<string, unknown>);
    const required = Array.isArray(n.required) ? n.required : [];
    if (!keys.every((k) => required.includes(k))) return false;
    if (!keys.every((k) => isStrictNode((props as Record<string, unknown>)[k]))) return false;
  }
  if (types.includes("array") && n.items !== undefined && !isStrictNode(n.items)) return false;
  return true;
}

/**
 * A schema codex cannot carry (not OpenAI-strict) is not dropped silently: the
 * runner contract (RunnerRequest.outputSchema) requires the instruction
 * fallback so the model still sees the exact shape. Dropping it without this
 * made the ordinary task-force planner answer in prose / omit workspaceAccess
 * (2026-09-28). Strict schemas travel natively and need no prose copy.
 *
 * The block text mirrors shared/runtime-capabilities.ts schemaFallbackInstruction;
 * it is inlined because this module must stay dependency-free (the codex
 * residency source-contract gate loads it in a sealed VM).
 */
export function codexSystemPromptWithSchemaFallback(req: {
  systemPrompt: string;
  outputSchema?: { schema: Record<string, unknown> };
}): string {
  if (!req.outputSchema || openAiStrictSchemaOrNull(req.outputSchema.schema)) return req.systemPrompt;
  return [
    req.systemPrompt,
    "[OUTPUT CONTRACT]",
    "Your final message must be exactly one JSON document matching this schema,",
    "with no prose, no explanation, and no code fence around it:",
    JSON.stringify(req.outputSchema.schema),
    "[/OUTPUT CONTRACT]",
  ].join("\n");
}
