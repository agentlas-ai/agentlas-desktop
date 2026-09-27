/**
 * OpenAI-strict output schemas — codex forwards `--output-schema` / app-server
 * `outputSchema` to the Responses API as `text.format` with `strict: true`.
 * That API refuses the whole turn (400 invalid_json_schema) unless every
 * object lists all of its properties in `required` and sets
 * `additionalProperties: false`. An open object (`{ type: "object" }`, used by
 * the ordinary task-force planner for `allocation` / `synthesis`, which the
 * host normalizes itself) can never satisfy that.
 *
 * Measured 2026-09-27 on the owner's X Marketing taskforce: every codex planner
 * turn failed in 27s with "'additionalProperties' is required to be supplied
 * and to be false" at packets.items.properties.allocation.
 *
 * Rule: send a schema to codex only when it is strict-valid; otherwise send
 * none. The prompt still carries the response contract and the host still
 * validates the answer, so dropping the transport-level schema loses no safety.
 */
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
