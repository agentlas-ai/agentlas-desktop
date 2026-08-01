// Project CRUD — 프로젝트가 소스, 지시, 직접 선택한 에이전트 풀을 소유한다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import type { Project, ProjectAgentPoolMember, ProjectSourceType } from "../../shared/types";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  system_prompt: string | null;
  agent_pool_json: string;
  source_type: ProjectSourceType;
  source_ref: string | null;
  folder_path: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  let agentPool: ProjectAgentPoolMember[] = [];
  try {
    const parsed = JSON.parse(row.agent_pool_json || "[]") as unknown;
    if (Array.isArray(parsed)) agentPool = parsed.filter(isProjectAgentPoolMember);
  } catch {
    agentPool = [];
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    systemPrompt: row.system_prompt,
    agentPool,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    folderPath: row.folder_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isProjectAgentPoolMember(value: unknown): value is ProjectAgentPoolMember {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<ProjectAgentPoolMember>;
  return typeof item.agentId === "string"
    && (item.source === "local" || item.source === "cloud" || item.source === "hub")
    && (item.releaseId === null || typeof item.releaseId === "string")
    && typeof item.nameSnapshot === "string";
}

function normalizeAgentPool(value: ProjectAgentPoolMember[] | undefined): ProjectAgentPoolMember[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.filter(isProjectAgentPoolMember).filter((member) => {
    const key = `${member.source}:${member.agentId}:${member.releaseId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 32);
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
  systemPrompt?: string | null;
  agentPool?: ProjectAgentPoolMember[];
  sourceType: ProjectSourceType;
  sourceRef?: string | null;
  folderPath?: string | null;
}): Project {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, description, system_prompt, agent_pool_json, source_type, source_ref, folder_path, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.name.trim() || "New project",
      input.systemPrompt?.trim() || null,
      JSON.stringify(normalizeAgentPool(input.agentPool)),
      input.sourceType,
      input.sourceRef?.trim() || null,
      input.folderPath ?? null,
      now,
      now,
    );
  const project = getProject(id) as Project;
  emitDesktopStoreChange({ entity: "project", id });
  return project;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "systemPrompt" | "agentPool" | "sourceType" | "sourceRef" | "folderPath">>,
): Project {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);

  db.prepare(
    `UPDATE projects
        SET name = ?, system_prompt = ?, agent_pool_json = ?, source_type = ?, source_ref = ?, folder_path = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.name ?? existing.name,
    patch.systemPrompt === undefined ? existing.systemPrompt : patch.systemPrompt,
    JSON.stringify(patch.agentPool === undefined ? existing.agentPool : normalizeAgentPool(patch.agentPool)),
    patch.sourceType ?? existing.sourceType,
    patch.sourceRef === undefined ? existing.sourceRef : patch.sourceRef,
    patch.folderPath === undefined ? existing.folderPath : patch.folderPath,
    now,
    id,
  );
  const project = getProject(id) as Project;
  emitDesktopStoreChange({ entity: "project", id });
  return project;
}

export function removeProject(id: string): void {
  const result = getDb().prepare("DELETE FROM projects WHERE id = ?").run(id);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "project", id });
}

export function touchProject(id: string): void {
  const result = getDb()
    .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
    .run(new Date().toISOString(), id);
  if (result.changes > 0) emitDesktopStoreChange({ entity: "project", id });
}
