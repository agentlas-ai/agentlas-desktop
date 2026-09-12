import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, canonical(item)]),
  );
  return value;
}

/** Main-only exact material. Values never enter the approval UI or grant row. */
export function mainToolConsentDigest(material: unknown): string {
  return createHash("sha256").update("agentlas-main-tool-consent-v2\0")
    .update(JSON.stringify(canonical(material))).digest("hex");
}

const resources = new WeakMap<object, string>();

/** A serialized ask or caller-supplied consentBinding cannot mint this value. */
export function bindMainToolConsentResource(ask: object, material: unknown): void {
  resources.set(ask, mainToolConsentDigest(material));
}

export function mainToolConsentResource(ask: object): string | undefined {
  return resources.get(ask);
}
