// Per-project rent consent for Hub bookmark agents.
//
// Semantics (owner decision 2026-08-18, per-work-order RENT):
//   allowed=1 → this agent may be auto-hired for this project's work orders
//               with NO per-send notice (the insufficient-credits paywall is
//               the only interruption).
//   no row / allowed=0 (default) → excluded from network auto-hire for this
//               project. Explicit user calls (/hep-call, @mention) are not
//               gated here.
//
// Keys are (projectId, slug). Slug is the Hub-namespace identity the lease and
// rate APIs use; it is stored lowercased so lookups match the lease cache.
import { getDb } from "./db";

function normalizeSlug(slug: string): string {
  return String(slug || "").trim().toLowerCase();
}

export function listRentAllowedSlugs(projectId: string): string[] {
  if (!projectId) return [];
  const rows = getDb()
    .prepare("SELECT slug FROM project_agent_rent_allow WHERE project_id = ? AND allowed = 1")
    .all(projectId) as Array<{ slug: string }>;
  return rows.map((row) => row.slug);
}

export function setRentAllowed(projectId: string, slug: string, allowed: boolean): string[] {
  const normalized = normalizeSlug(slug);
  if (projectId && normalized) {
    getDb()
      .prepare(
        `INSERT INTO project_agent_rent_allow (project_id, slug, allowed, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id, slug) DO UPDATE SET allowed = excluded.allowed, updated_at = excluded.updated_at`,
      )
      .run(projectId, normalized, allowed ? 1 : 0, new Date().toISOString());
  }
  return listRentAllowedSlugs(projectId);
}
