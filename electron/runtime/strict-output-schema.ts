/** Conservative native subset; every other contract travels intact as text. */
export function openAiStrictSchemaOrNull(schema: unknown): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)
    || (schema as Record<string, unknown>).type !== "object"
    || (schema as Record<string, unknown>).anyOf !== undefined) return null;
  return isStrictNode(schema, schema, new Set()) ? schema as Record<string, unknown> : null;
}

function isStrictNode(node: unknown, root: unknown, seen: Set<object>): boolean {
  if (!node || typeof node !== "object" || Array.isArray(node)) return false;
  if (seen.has(node)) return true; // Valid local recursive references.
  seen.add(node);
  const n = node as Record<string, unknown>;
  const allowed = new Set(["type", "properties", "required", "additionalProperties", "items", "anyOf",
    "$defs", "definitions", "$ref", "title", "description", "enum", "pattern", "format",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
    "minLength", "maxLength"]);
  if (Object.keys(n).some(key => !allowed.has(key))) return false;
  if (n.$ref !== undefined) {
    if (typeof n.$ref !== "string" || (n.$ref !== "#" && !n.$ref.startsWith("#/"))) return false;
    let target = root;
    for (const part of n.$ref === "#" ? [] : n.$ref.slice(2).split("/")) {
      if (/~(?:[^01]|$)/.test(part)) return false;
      const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!target || typeof target !== "object" || Array.isArray(target)
        || !Object.prototype.hasOwnProperty.call(target, key)) return false;
      target = (target as Record<string, unknown>)[key];
    }
    if (!isStrictNode(target, root, seen)) return false;
  }
  if (n.anyOf !== undefined && (!Array.isArray(n.anyOf) || !n.anyOf.length
    || !n.anyOf.every(child => isStrictNode(child, root, seen)))) return false;
  for (const key of ["$defs", "definitions"] as const) {
    const definitions = n[key];
    if (definitions !== undefined && (!definitions || typeof definitions !== "object" || Array.isArray(definitions)
      || !Object.values(definitions).every(child => isStrictNode(child, root, seen)))) return false;
  }
  const type = n.type;
  const types = Array.isArray(type) ? type : [type];
  if (type === undefined && n.anyOf === undefined && typeof n.$ref !== "string") return false;
  if (type !== undefined && (!types.length
    || types.some(value => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(String(value))))) return false;
  if (types.includes("object")) {
    const props = n.properties;
    if (!props || typeof props !== "object" || Array.isArray(props) || n.additionalProperties !== false) return false;
    const keys = Object.keys(props);
    const required = Array.isArray(n.required) ? n.required : [];
    if (required.length !== keys.length || new Set(required).size !== required.length
      || !keys.every(key => required.includes(key))) return false;
    if (!Object.values(props).every(child => isStrictNode(child, root, seen))) return false;
  }
  if (types.includes("array") && !isStrictNode(n.items, root, seen)) return false;
  if (n.format !== undefined && !["date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid"].includes(String(n.format))) return false;
  return true;
}

/**
 * A schema codex cannot carry (not OpenAI-strict) is not dropped silently: the
 * runner contract (RunnerRequest.outputSchema) requires the instruction
 * fallback so the model still sees the exact shape. Dropping it without this
 * made the ordinary task-force planner answer in prose / omit workspaceAccess
 * (2026-09-28). Strict schemas travel natively and need no prose copy.
 *
 * This dependency-free leaf renders only the exact fallback block (including
 * its original leading separator). The concrete adapter declares composition
 * before any resulting host instructions reach the model.
 */
export function codexOutputSchemaFallbackBlock(req: {
  outputSchema?: { schema: Record<string, unknown> };
}): string {
  if (!req.outputSchema || openAiStrictSchemaOrNull(req.outputSchema.schema)) return "";
  return [
    "",
    "[OUTPUT CONTRACT]",
    "final message: exactly one JSON document matching this schema; no prose, no fence:",
    JSON.stringify(req.outputSchema.schema),
    "[/OUTPUT CONTRACT]",
  ].join("\n");
}
