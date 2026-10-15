import { openAiStrictSchemaOrNull } from "./strict-output-schema";

/** Conservative intersection for Agentlas serving's primary and fallback transports.
 * Exact unsupported contracts remain in the declared text fallback and host validator.
 * No constraints are removed or rewritten to make a native request appear compatible.
 */
export function portableServingStrictSchemaOrNull(schema: unknown): Record<string, unknown> | null {
  const strict = openAiStrictSchemaOrNull(schema);
  if (!strict) return null;
  const check = (node: unknown, active: Set<object>): boolean => {
    if (!node || typeof node !== "object" || Array.isArray(node)) return false;
    if (active.has(node)) return false;
    const next = new Set(active); next.add(node);
    const value = node as Record<string, unknown>;
    // Anthropic raw structured outputs reject these constraints; SDK rewriting
    // would weaken native semantics, so this transport keeps the full text contract.
    if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "pattern"].some(key => value[key] !== undefined)) return false;
    if (value.minItems !== undefined && value.minItems !== 0 && value.minItems !== 1) return false;
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.some(item => item !== null && !["string", "number", "boolean"].includes(typeof item)))) return false;
    if (value.$ref !== undefined) {
      let target: unknown = strict;
      for (const part of value.$ref === "#" ? [] : String(value.$ref).slice(2).split("/")) {
        const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!target || typeof target !== "object" || Array.isArray(target)) return false;
        target = (target as Record<string, unknown>)[key];
      }
      if (!check(target, next)) return false;
    }
    for (const key of ["properties", "$defs", "definitions"] as const) {
      const children = value[key];
      if (children && (!children || typeof children !== "object" || Array.isArray(children) || !Object.values(children).every(child => check(child, next)))) return false;
    }
    if (value.items !== undefined && !check(value.items, next)) return false;
    if (Array.isArray(value.anyOf) && !value.anyOf.every(child => check(child, next))) return false;
    return true;
  };
  return check(strict, new Set()) ? strict : null;
}
