// Why the engine's `ontology verify` said "fail", from its own typed fields (never its prose).
//
// Windows retest 2 (2026-10-24): a new empty Work project logged "Core ontology verification failed (status=fail,
// integrity=ok)" and nothing else. The cause was in the payload: every source read back as `source_deleted`, because the
// engine turned `file:///C:/...` into a path rooted on the current drive (fixed in Agentlas-OS ontology/runtime.py
// file_uri_path_text). The log line now carries the stale-source reasons, the durable-write probe and the schema.
//
// Pure — no Electron or engine import — so a plain-Node gate drives it (scripts/test-ontology-verify-detail.cjs).

const MAX_REASON_CHARS = 40;

function reasonOf(item: unknown): string {
  const reason = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>).reason : undefined;
  if (typeof reason !== "string") return "unknown";
  const clean = reason.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, MAX_REASON_CHARS);
  return clean || "unknown";
}

export function coreVerifyFailureDetail(payload: Record<string, unknown>): string {
  const parts = [`status=${String(payload.status)}`, `integrity=${String(payload.integrity_check)}`];
  const stale = Array.isArray(payload.stale_sources) ? payload.stale_sources : [];
  if (stale.length > 0) {
    const reasons = new Map<string, number>();
    for (const item of stale) reasons.set(reasonOf(item), (reasons.get(reasonOf(item)) ?? 0) + 1);
    parts.push(`stale_sources=${stale.length} (${[...reasons].map(([reason, count]) => `${reason}:${count}`).join(", ")})`);
  }
  if (payload.direct_durable_memory_write_blocked === false) parts.push("direct_durable_memory_write_blocked=false");
  if (payload.schema_version !== undefined) parts.push(`schema=${String(payload.schema_version)}`);
  return parts.join(", ");
}
