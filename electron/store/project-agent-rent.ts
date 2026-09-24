// Per-project consent for automatic use of free public Hub agents.
// The historical table/IPC names stay for persisted-setting compatibility.
// allowed=1 permits auto staffing; explicit user calls are never gated here.
// Paid leases and creator settlement were permanently retired.
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
