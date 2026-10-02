/** An exact view of one alternative in an MCP input contract. The complete
 * descriptor stays in Main and the server still validates the original schema. */
export interface ToolSchemaVariant {
  index: number;
  alternatives: number[];
  selector: Record<string, string | number | boolean | null>;
  schema: Record<string, unknown>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function containsReference(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsReference);
  return object(value) && Object.entries(value).some(([key, item]) =>
    ["$ref", "$dynamicRef", "$recursiveRef"].includes(key) || containsReference(item));
}

/** Selecting an alternative preserves every root constraint and every field of
 * that alternative. References are deliberately excluded: moving an array
 * element could change the meaning of a JSON pointer into the original schema. */
export function toolSchemaVariants(schema: unknown): ToolSchemaVariant[] | null {
  if (!object(schema) || containsReference(schema)) return null;
  const keyword = Array.isArray(schema.oneOf) && !schema.anyOf ? "oneOf"
    : Array.isArray(schema.anyOf) && !schema.oneOf ? "anyOf" : null;
  if (!keyword) return null;
  const branches = schema[keyword] as unknown[];
  if (!branches.length || branches.length > 1_024 || branches.some(branch => !object(branch))) return null;
  const alternatives = branches.map((branch, index) => {
    const alternative = branch as Record<string, unknown>;
    const selector: ToolSchemaVariant["selector"] = {};
    const properties = object(alternative.properties) ? alternative.properties : {};
    const required = Array.isArray(alternative.required) ? alternative.required : [];
    for (const [key, property] of Object.entries(properties)) {
      if (!required.includes(key) || !object(property) || !Object.hasOwn(property, "const")) continue;
      const value = property.const;
      if (value === null || ["string", "number", "boolean"].includes(typeof value)) {
        selector[key] = value as ToolSchemaVariant["selector"][string];
      }
    }
    return { index, selector, schema: alternative };
  });
  const disjoint = (left: typeof alternatives[number], right: typeof alternatives[number]) =>
    Object.entries(left.selector).some(([key, value]) => Object.hasOwn(right.selector, key) && right.selector[key] !== value);
  const remaining = new Set(alternatives.map(item => item.index));
  const result: ToolSchemaVariant[] = [];
  while (remaining.size) {
    const first = remaining.values().next().value as number;
    const group = [first]; remaining.delete(first);
    // oneOf means exactly one branch, so potentially overlapping alternatives
    // must stay together. This also keeps both confidence-interval forms; no
    // operation disappears merely because it shares the same method constant.
    if (keyword === "oneOf") for (let cursor = 0; cursor < group.length; cursor++) {
      for (const index of remaining) if (!disjoint(alternatives[group[cursor]], alternatives[index])) {
        group.push(index); remaining.delete(index);
      }
    }
    const selector = Object.fromEntries(Object.entries(alternatives[first].selector).filter(([key, value]) =>
      group.every(index => Object.hasOwn(alternatives[index].selector, key) && alternatives[index].selector[key] === value)));
    result.push({ index: first, alternatives: group, selector, schema: { ...schema, [keyword]: group.map(index => alternatives[index].schema) } });
  }
  return result;
}
