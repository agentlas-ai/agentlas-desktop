// First writable Desktop contact delegates the canonical project architecture
// to Agentlas Core. Restricted read and Site Agent App runs never enter here.
import { getDb } from "../store/db";
import {
  ensureDesktopProjectBootstrap,
  projectBootstrapAccessAllowed,
  type ProjectBootstrapAccess,
  type ProjectBootstrapResult,
} from "./project-bootstrap";

export interface VisitResult {
  visits: number;
  activated: boolean;
  /** True only on the turn activation first happened (for UI/log surfacing). */
  justActivated: boolean;
  bootstrapMode: ProjectBootstrapResult["mode"];
}

/**
 * Record the first authorized writable contact, await canonical setup, and then
 * mark the folder active. Later calls reuse the process-local bootstrap result.
 */
export async function recordFolderVisit(
  projectPath: string,
  projectName: string | undefined,
  access: ProjectBootstrapAccess,
): Promise<VisitResult> {
  if (!projectBootstrapAccessAllowed(access)) {
    throw new Error("Project activation is unavailable outside an interactive writable Desktop run.");
  }
  const bootstrap = await ensureDesktopProjectBootstrap({
    projectPath,
    projectName,
    access,
    reason: "desktop-first-contact",
  });
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
  // The tiny Desktop fallback is intentionally not promoted to active memory:
  // doing so would let legacy curator code expand it beyond the safe seed.
  if (bootstrap.mode === "core" && !activatedAt) {
    db.prepare("UPDATE folder_activity SET activated_at = ? WHERE path = ?").run(now, projectPath);
    activatedAt = now;
    justActivated = true;
  }

  return {
    visits,
    activated: bootstrap.mode === "core" && Boolean(activatedAt),
    justActivated,
    bootstrapMode: bootstrap.mode,
  };
}

export function isFolderActivated(projectPath: string): boolean {
  const row = getDb()
    .prepare("SELECT activated_at FROM folder_activity WHERE path = ?")
    .get(projectPath) as { activated_at: string | null } | undefined;
  return Boolean(row?.activated_at);
}

/** Force-activate now (used by explicit UI/CLI actions). */
export async function activateFolder(
  projectPath: string,
  projectName: string | undefined,
  access: ProjectBootstrapAccess,
): Promise<ProjectBootstrapResult["mode"]> {
  if (!projectBootstrapAccessAllowed(access)) {
    throw new Error("Project activation is unavailable outside an interactive writable Desktop run.");
  }
  const bootstrap = await ensureDesktopProjectBootstrap({
    projectPath,
    projectName,
    access,
    reason: "desktop-explicit-activation",
  });
  if (bootstrap.mode !== "core") return bootstrap.mode;
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
  return bootstrap.mode;
}
