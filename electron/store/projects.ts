// Project CRUD — 프로젝트가 소스, 지시, 직접 선택한 에이전트 풀을 소유한다.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { agentlasHomeDir } from "../agents/home";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import { removeProjectApprovalGrants } from "./capability-grants";
import { PROJECT_AGENT_POOL_MAX, projectPoolMemberKey, projectPoolMemberReferences } from "../../shared/project-agent-pool";
import { consumeProjectAgentLimitGrant, type ProjectAgentLimitGrant } from "../billing";
import type { Project, ProjectAgentPoolMember, ProjectSourceType } from "../../shared/types";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  agent_pool_json: string;
  source_type: unknown;
  source_ref: string | null;
  folder_path: string | null;
  created_at: string;
  updated_at: string;
}

const PROJECT_SOURCE_TYPES = new Set<ProjectSourceType>(["local", "github", "empty", "sample"]);

export function isProjectSourceType(value: unknown): value is ProjectSourceType {
  return typeof value === "string" && PROJECT_SOURCE_TYPES.has(value as ProjectSourceType);
}

function normalizedPersistedProjectSourceType(value: unknown): ProjectSourceType {
  // Old databases predate source_type and were migrated as local. Keep the same
  // safe fallback for a malformed row instead of projecting an unknown source.
  return isProjectSourceType(value) ? value : "local";
}

function normalizedSourceRef(sourceType: ProjectSourceType, value: string | null | undefined): string | null {
  if (sourceType === "local" || sourceType === "empty") return null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function managedProjectSlug(name: string): string {
  const normalized = name
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(normalized || "project").slice(0, 48).join("");
}

function assertManagedProjectsRoot(root: string): string {
  const resolved = path.resolve(root);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("managed_empty_project_root_invalid");
  }
  return resolved;
}

/** The one place that names the managed projects folder: `~/.agentlas/projects`, or `$AGENTLAS_HOME/projects` for an isolated run. */
export function defaultManagedProjectsRoot(): string {
  return path.join(agentlasHomeDir(), "projects");
}

/**
 * Allocate a Main-owned folder for an explicit empty-project save.
 *
 * The optional root is dependency injection for isolated verification only;
 * production callers always use <agentlas home>/projects (~/.agentlas/projects; AGENTLAS_HOME moves it, like every other store).
 */
export function createManagedEmptyProjectDirectory(
  projectId: string,
  projectName: string,
  managedProjectsRoot = defaultManagedProjectsRoot(),
): string {
  const root = assertManagedProjectsRoot(managedProjectsRoot);
  const base = `${managedProjectSlug(projectName)}-${projectId}`;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const leaf = attempt === 0 ? base : `${base}-${randomUUID().slice(0, 8)}`;
    const candidate = path.join(root, leaf);
    if (path.dirname(candidate) !== root) throw new Error("managed_empty_project_path_invalid");
    try {
      fs.mkdirSync(candidate, { mode: 0o700 });
      const stat = fs.lstatSync(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("managed_empty_project_path_invalid");
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error("managed_empty_project_path_collision");
}

function isReusableManagedEmptyProjectDirectory(folderPath: string | null, root: string): boolean {
  if (!folderPath) return false;
  const resolvedRoot = path.resolve(root);
  const resolvedFolder = path.resolve(folderPath);
  if (path.dirname(resolvedFolder) !== resolvedRoot) return false;
  try {
    const stat = fs.lstatSync(resolvedFolder);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

interface ProjectMutationOptions {
  /** Private verification seam; never accepted from renderer IPC. */
  managedProjectsRoot?: string;
  /** Only the explicit projects:update save boundary may request allocation. */
  allocateManagedEmptyFolder?: boolean;
  /** Main-only result of a fresh server entitlement check; consumed on addition. */
  projectAgentGrant?: ProjectAgentLimitGrant;
}

function toProject(row: ProjectRow): Project {
  let agentPool: ProjectAgentPoolMember[] = [];
  try {
    const parsed = JSON.parse(row.agent_pool_json || "[]") as unknown;
    if (Array.isArray(parsed)) agentPool = parsed.flatMap((item) => {
      const normalized = normalizeProjectAgentPoolMember(item);
      return normalized ? [normalized] : [];
    });
  } catch {
    agentPool = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    agentPool,
    sourceType: normalizedPersistedProjectSourceType(row.source_type),
    sourceRef: row.source_ref,
    folderPath: row.folder_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeProjectAgentPoolMember(value: unknown): ProjectAgentPoolMember | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const source = item.source;
  const releaseId = item.releaseId;
  const nameSnapshot = item.nameSnapshot;
  if ((source !== "local" && source !== "cloud" && source !== "hub")
    || (releaseId !== null && typeof releaseId !== "string")
    || typeof nameSnapshot !== "string") return null;

  if (item.entityKind === "team") {
    const targetId = typeof item.targetId === "string" ? item.targetId.trim() : "";
    const firmId = typeof item.firmId === "string" && item.firmId.trim() ? item.firmId.trim() : null;
    const controllerAgentId = typeof item.controllerAgentId === "string" && item.controllerAgentId.trim()
      ? item.controllerAgentId.trim()
      : null;
    if (!targetId || (source === "local" && !firmId)) return null;
    return { entityKind: "team", targetId, agentId: null, firmId, controllerAgentId, source, releaseId, nameSnapshot };
  }

  const legacyAgentId = typeof item.agentId === "string" && item.agentId.trim() ? item.agentId.trim() : null;
  const targetId = typeof item.targetId === "string" ? item.targetId.trim() : legacyAgentId;
  if (!targetId || (source === "local" && !legacyAgentId)) return null;
  return {
    entityKind: "agent",
    targetId,
    agentId: legacyAgentId,
    firmId: null,
    controllerAgentId: null,
    source,
    releaseId,
    nameSnapshot,
  };
}

function normalizeAgentPool(value: ProjectAgentPoolMember[] | undefined): ProjectAgentPoolMember[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const normalized = value.flatMap((item) => {
    const member = normalizeProjectAgentPoolMember(item);
    return member ? [member] : [];
  }).filter((member) => {
    const key = `${member.source}:${member.entityKind}:${member.targetId}:${member.releaseId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return normalized;
}

/** Identity changes count as additions; removal, reordering, and metadata edits do not. */
export function projectPoolAddsMembers(previous: ProjectAgentPoolMember[], requested: ProjectAgentPoolMember[] | undefined): boolean {
  if (requested === undefined) return false;
  const before = new Set(previous.map(projectPoolMemberKey));
  return normalizeAgentPool(requested).some((member) => !before.has(projectPoolMemberKey(member)));
}

function assertProjectPoolCapacity(previous: ProjectAgentPoolMember[], next: ProjectAgentPoolMember[], grant?: ProjectAgentLimitGrant): void {
  if (!projectPoolAddsMembers(previous, next)) return;
  // A legacy pool may already exceed the current ceiling. Preserve it on
  // metadata edits, reorder, and removals; apply the ceiling only to additions.
  if (next.length > PROJECT_AGENT_POOL_MAX) {
    throw new Error(`[agentlas:code=project-agent-safety-limit] A project supports at most ${PROJECT_AGENT_POOL_MAX} agents and teams.`);
  }
  const limit = consumeProjectAgentLimitGrant(grant);
  if (limit === null) {
    throw new Error("[agentlas:code=project-agent-entitlement-unavailable] Verify your plan before adding project agents or teams.");
  }
  if (next.length > limit) {
    throw new Error(`[agentlas:code=project-agent-limit-reached] Your plan allows ${limit} agents and teams per project (${next.length} selected).`);
  }
}

export function listProjects(): Project[] {
  const rows = getDb()
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all() as ProjectRow[];
  return rows.map(toProject);
}

export function getProject(id: string): Project | null {
  const row = getDb()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  return row ? toProject(row) : null;
}

export function createProject(input: {
  name: string;
  description?: string | null;
  systemPrompt?: string | null;
  agentPool?: ProjectAgentPoolMember[];
  sourceType: ProjectSourceType;
  sourceRef?: string | null;
  folderPath?: string | null;
}, options: ProjectMutationOptions = {}): Project {
  const id = randomUUID();
  const now = new Date().toISOString();
  const name = input.name.trim() || "New project";
  const sourceType = normalizedPersistedProjectSourceType(input.sourceType);
  if (sourceType === "empty" && input.folderPath) throw new Error("empty_project_folder_must_be_managed");
  const agentPool = normalizeAgentPool(input.agentPool);
  assertProjectPoolCapacity([], agentPool, options.projectAgentGrant);
  let createdFolderPath: string | null = null;
  const folderPath = sourceType === "empty"
    ? (createdFolderPath = createManagedEmptyProjectDirectory(id, name, options.managedProjectsRoot))
    : sourceType === "sample" ? null : input.folderPath ?? null;
  try {
    getDb()
      .prepare(
        `INSERT INTO projects (id, name, description, system_prompt, agent_pool_json, source_type, source_ref, folder_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.description?.trim().slice(0, 1_200) || null,
        input.systemPrompt?.trim() || null,
        JSON.stringify(agentPool),
        sourceType,
        normalizedSourceRef(sourceType, input.sourceRef),
        folderPath,
        now,
        now,
      );
  } catch (error) {
    // Roll back only the directory created by this failed insert. Never recurse:
    // if another actor wrote into it, preserving those bytes wins.
    if (createdFolderPath) {
      try { fs.rmdirSync(createdFolderPath); } catch { /* non-empty or already removed */ }
    }
    throw error;
  }
  const project = getProject(id) as Project;
  emitDesktopStoreChange({ entity: "project", id });
  return project;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "description" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef" | "folderPath">>,
  options: ProjectMutationOptions = {},
): Project {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);
  const agentPool = patch.agentPool === undefined ? existing.agentPool : normalizeAgentPool(patch.agentPool);
  assertProjectPoolCapacity(existing.agentPool, agentPool, options.projectAgentGrant);

  const sourceType = patch.sourceType === undefined
    ? existing.sourceType
    : normalizedPersistedProjectSourceType(patch.sourceType);
  const sourceChanged = patch.sourceType !== undefined && sourceType !== existing.sourceType;
  const sourceRef = patch.sourceRef !== undefined
    ? normalizedSourceRef(sourceType, patch.sourceRef)
    : patch.sourceType === undefined
      ? existing.sourceRef
      : normalizedSourceRef(sourceType, sourceChanged ? null : existing.sourceRef);
  let folderPath = patch.folderPath === undefined
    ? (sourceChanged ? null : existing.folderPath)
    : patch.folderPath;
  let createdFolderPath: string | null = null;
  if (sourceType === "sample" && (patch.sourceType !== undefined || patch.folderPath !== undefined)) {
    folderPath = null;
  } else if (sourceType === "empty") {
    if (patch.folderPath) throw new Error("empty_project_folder_must_be_managed");
    const managedRoot = options.managedProjectsRoot ?? defaultManagedProjectsRoot();
    if (options.allocateManagedEmptyFolder) {
      folderPath = !sourceChanged && existing.sourceType === "empty"
        && isReusableManagedEmptyProjectDirectory(existing.folderPath, managedRoot)
        ? existing.folderPath
        : (createdFolderPath = createManagedEmptyProjectDirectory(id, patch.name ?? existing.name, managedRoot));
    }
  }

  try {
    db.prepare(
      `UPDATE projects
          SET name = ?, description = ?, system_prompt = ?, agent_pool_json = ?, source_type = ?, source_ref = ?, folder_path = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      patch.name ?? existing.name,
      patch.description === undefined ? existing.description : (patch.description?.trim().slice(0, 1_200) || null),
      patch.systemPrompt === undefined ? existing.systemPrompt : patch.systemPrompt,
      // undefined preserves the pool; [] is an intentional full removal.
      JSON.stringify(agentPool),
      sourceType,
      sourceRef,
      folderPath,
      now,
      id,
    );
  } catch (error) {
    if (createdFolderPath) {
      try { fs.rmdirSync(createdFolderPath); } catch { /* non-empty or already removed */ }
    }
    throw error;
  }
  const project = getProject(id) as Project;
  emitDesktopStoreChange({ entity: "project", id });
  return project;
}

/**
 * Explicit removal must reach the project pools that reference the asset.
 *
 * The pool is JSON in a TEXT column, so the "project references follow their
 * existing SQLite FK contracts" assumption never held — nothing cascades here.
 * Detachment used to live in the agents page as two hand-written filters keyed
 * on local ids only (`member.agentId`, `member.firmId`), which meant a Cloud or
 * Hub row — whose agentId is null and whose targetId is a slug or definition id
 * — survived every delete and kept showing up in the project forever. Any other
 * removal surface skipped detachment entirely.
 *
 * Making it a consequence of the removal itself covers every caller, and it
 * matches identity the way the roster builds it: local rows by installed id or
 * firm id, remote rows by their own source-namespace target id.
 */
export function detachProjectPoolReferences(refs: {
  agentIds?: readonly string[];
  firmIds?: readonly string[];
  remoteTargetIds?: readonly string[];
}): number {
  const agentIds = new Set((refs.agentIds ?? []).filter(Boolean));
  const firmIds = new Set((refs.firmIds ?? []).filter(Boolean));
  const remoteTargetIds = new Set(
    (refs.remoteTargetIds ?? []).map((value) => String(value ?? "").trim().toLowerCase()).filter(Boolean),
  );
  if (agentIds.size === 0 && firmIds.size === 0 && remoteTargetIds.size === 0) return 0;

  const removed = { agentIds, firmIds, remoteTargetIds };
  let detached = 0;
  for (const project of listProjects()) {
    const kept = project.agentPool.filter((member) => !projectPoolMemberReferences(member, removed));
    if (kept.length === project.agentPool.length) continue;
    detached += project.agentPool.length - kept.length;
    updateProject(project.id, { agentPool: kept });
  }
  return detached;
}

export function removeProject(id: string): void {
  // read the folder before the row goes — the memory chain below names the project by id and folder. It does nothing while the memory layout switch is OFF.
  let folderPath: string | null = null;
  try { folderPath = getProject(id)?.folderPath ?? null; } catch { /* the row is removed anyway */ }
  const result = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (result.changes > 0) {
    void import("../memory/store-delete").then(async (chain) => {
      await chain.forgetProjectTraces({ id, path: folderPath });
      await chain.retryPendingProjectForgets({ except: id }); // the one that just failed is not retried at once
    }).catch(() => undefined);
    // the project's code index in its memory folder goes with the row (best effort; a folder that is already gone leaves an orphan the engine prunes after 30 days). The map inside the
    // user's own project folder (`.agentlas/code-map/`) is never touched. It does nothing while no index exists in the memory folder, and it creates nothing.
    // Another project row for the same folder keeps the map (it is named by the folder, not by the row): only the last row of a folder removes it (G).
    let folderStillUsed = false;
    try { folderStillUsed = Boolean(folderPath && getDb().prepare("SELECT 1 FROM projects WHERE folder_path = ? LIMIT 1").get(folderPath)); } catch { /* the index is removed as before */ }
    if (!folderStillUsed) void (async () => {
      const index = await import("../memory/project-index");
      let active: string[] = [];
      try {
        const database = await import("../memory/database");
        if (fs.existsSync(path.join(database.memoryRoot(), "owners"))) active = [database.getMemoryStoreInfo().ownerNamespace];
      } catch { /* no store yet: the engine's own owner is the only one */ }
      const removal = await index.removeProjectIndex({ id, path: folderPath }, index.defaultIndexContext(active));
      if (removal.left > 0) console.warn(`[project-index] ${removal.left} index folder(s) of a removed project could not be deleted`);
    })().catch(() => undefined);
    // The "always allow" answers kept for this project go with it.
    removeProjectApprovalGrants(id);
    emitDesktopStoreChange({ entity: "project", id });
  }
}

export function touchProject(id: string): void {
  const result = getDb()
    .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "project", id });
}
