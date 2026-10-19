/**


















 */
export function providerOutputSchema<T>(schema: T): T {
  return project(schema) as T;
}

const NAME_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
const LITERALS = new Set(["enum", "const", "default", "examples", "required"]);
const DROPPED = new Set(["maxLength", "maxProperties", "maxContains"]);

function project(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(project);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (DROPPED.has(key)) continue;
    if (key === "maxItems" && value !== 0) continue;
    if (key === "pattern" && typeof value === "string") {
      out[key] = value.replace(/\{(\d+),(\d+)\}/g, "{$1,}");
    } else if (LITERALS.has(key)) {
      out[key] = value;
    } else if (NAME_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([name, child]) => [name, project(child)]));
    } else {
      out[key] = project(value);
    }
  }
  return out;
}
