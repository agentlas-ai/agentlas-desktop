// Auto-activation: the first meaningful Agentlas contact with a folder asks
// Agentlas Core to install the canonical local memory/code-map/ontology setup.
import { getDb } from "../store/db";
import { ensureProjectMemory } from "../memory/project-files";
import { runHephaestus } from "../hephaestus/engine";

export interface VisitResult {
  visits: number;
  activated: boolean;
  /** True only on the turn activation first happened (for UI/log surfacing). */
  justActivated: boolean;
}

const projectBootstrapRuns = new Map<string, Promise<boolean>>();

async function ensureCoreProject(projectPath: string, projectName?: string): Promise<boolean> {
  const existing = projectBootstrapRuns.get(projectPath);
  if (existing) return existing;
  const pending = (async () => {
    const result = await runHephaestus<{
      schemaVersion?: string;
      status?: string;
      missing?: unknown[];
      mergeOnly?: boolean;
      overwritten?: unknown[];
      privacyBlockInstalled?: boolean;
      privateModeCompliant?: boolean;
      permissionIssues?: unknown[];
    }>(
      "agentlas_cloud",
      ["project", "ensure", "--project", projectPath, "--reason", "desktop-first-contact"],
      { cwd: projectPath, timeoutMs: 120_000 },
    );
    const receipt = result.json;
    const canonical = Boolean(
      result.ok
      && receipt?.schemaVersion === "agentlas.project-bootstrap.v1"
      && ["active", "privacy_warning"].includes(receipt.status ?? "")
      && receipt.mergeOnly === true
      && receipt.privacyBlockInstalled === true
      && receipt.privateModeCompliant === true
      && Array.isArray(receipt.missing)
      && receipt.missing.length === 0
      && Array.isArray(receipt.overwritten)
      && receipt.overwritten.length === 0
      && Array.isArray(receipt.permissionIssues)
      && receipt.permissionIssues.length === 0
    );
    if (canonical) return true;
    // Older/missing Core builds retain the merge-only Desktop seed as a safe
    // continuity fallback; the next contact retries the canonical Core path.
    projectBootstrapRuns.delete(projectPath);
    ensureProjectMemory(projectPath, projectName);
    return false;
  })();
  projectBootstrapRuns.set(projectPath, pending);
  return pending;
}

/**
 * Record the first writable contact with a working folder and ensure the
 * canonical Core-owned project architecture. Idempotent and merge-only.
 */
export async function recordFolderVisit(projectPath: string, projectName?: string): Promise<VisitResult> {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits, activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number; activated_at: string | null } | undefined;

  let visits: number;
  let activatedAt: string | null;
  if (row) {
    visits = row.visits + 1;
    activatedAt = row.activated_at;
    db.prepare("UPDATE folder_activity SET visits = ?, last_seen = ? WHERE path = ?").run(
      visits,
      now,
      projectPath,
    );
  } else {
    visits = 1;
    activatedAt = null;
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, ?, NULL, ?, ?)",
    ).run(projectPath, visits, now, now);
  }

  let justActivated = false;
  if (!activatedAt) {
    db.prepare("UPDATE folder_activity SET activated_at = ? WHERE path = ?").run(now, projectPath);
    activatedAt = now;
    justActivated = true;
  }

  await ensureCoreProject(projectPath, projectName);

  return { visits, activated: Boolean(activatedAt), justActivated };
}

export function isFolderActivated(projectPath: string): boolean {
  const row = getDb()
    .prepare("SELECT activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { activated_at: string | null } | undefined;
  return Boolean(row?.activated_at);
}

/** Force-activate now (used by explicit UI/CLI actions). */
export async function activateFolder(projectPath: string, projectName?: string): Promise<void> {
  const db = getDb();
  const now = new Date().toISOString();
  const row = db
    .prepare("SELECT visits FROM folder_activity WHERE path = ?")
    .get(projectPath) as { visits: number } | undefined;
  if (row) {
    db.prepare("UPDATE folder_activity SET activated_at = COALESCE(activated_at, ?), last_seen = ? WHERE path = ?").run(
      now,
      now,
      projectPath,
    );
  } else {
    db.prepare(
      "INSERT INTO folder_activity (path, visits, activated_at, first_seen, last_seen) VALUES (?, 1, ?, ?, ?)",
    ).run(projectPath, now, now, now);
  }
  await ensureCoreProject(projectPath, projectName);
}
