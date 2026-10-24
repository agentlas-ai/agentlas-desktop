/**
 * The decoding copy of a host schema: what a provider receives as its output contract, with no grammar-level cap on
 * the text or lists the model writes.
 *
 * Why (2026-10-16, Yotube room 5d37e4cc): codex decodes an output schema strictly, and so do OpenAI-compatible strict
 * `json_schema` lanes and the Ollama / LM Studio / MLX grammars. A cap is enforced while decoding. Once a list is at
 * `maxItems` the item separator is masked, and a model that still has items to write keeps writing them inside the last
 * open string: 257,684 characters over 56 minutes until codex's output cap, and a 3-hour room run was lost. A `maxLength`
 * cuts the text mid-sentence at exactly N characters and the cut answer is accepted as if whole (measured, gpt-6.1-sol).
 * Lanes that only validate (Claude `--json-schema`, agy's `finish` tool, grok) show the cap to the model, which then drops
 * the items it could not fit (measured: 2 of 6 kept, no error).
 *
 * A bound that matters to the product stays in the host validator that reads the decoded answer and reports overflow
 * as a typed result (or trims with a typed note). It never travels in the grammar. The host schema keeps every bound;
 * only this copy is sent.
 *
 * Removed: `maxItems` (except 0, a constant-empty list no item can open), `maxLength`, `maxProperties`, `maxContains`.
 * A bounded repetition `{m,n}` in a `pattern` becomes `{m,}`; an exact width `{n}` (a digest, a fixed code) stays.
 * Literal data (`enum`, `const`, `default`, `examples`) is copied verbatim; property-name maps keep their keys.
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
