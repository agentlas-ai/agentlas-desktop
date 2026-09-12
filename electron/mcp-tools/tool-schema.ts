import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}
/** Includes the complete server descriptor, including annotations/output schema.
 * A prepared call cannot silently acquire changed semantics on reconnect. */
export function mcpToolSchemaDigest(tool: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(tool))).digest("hex");
}
