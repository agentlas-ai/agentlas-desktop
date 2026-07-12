// Project CRUD — Claude Desktop의 "Projects" 와 동일 개념.
// 프로젝트는 0개 이상의 chats를 grouping. 기본 에이전트와 컨텍스트 노트를 가질 수 있다.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
import type { Project } from "../../shared/types";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  default_agent_id: string | null;
  context_note: string | null;
  folder_path: string | null;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    defaultAgentId: row.default_agent_id,
    contextNote: row.context_note,
    folderPath: row.folder_path ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
  defaultAgentId?: string | null;
  contextNote?: string | null;
  folderPath?: string | null;
}): Project {
  const id = randomUUID();
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO projects (id, name, description, default_agent_id, context_note, folder_path, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`,
    )
    .run(id, input.name.trim() || "새 프로젝트", input.defaultAgentId ?? null, input.contextNote ?? null, input.folderPath ?? null, now, now);
  const project = getProject(id) as Project;
  emitDesktopStoreChange({ entity: "project", id });
  return project;
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, "name" | "contextNote" | "defaultAgentId" | "folderPath">>,
): Project {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getProject(id);
  if (!existing) throw new Error(`Project not found: ${id}`);

  db.prepare(
    `UPDATE projects
        SET name = ?, context_note = ?, default_agent_id = ?, folder_path = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    patch.name ?? existing.name,
    patch.contextNote ?? existing.contextNote,
    patch.defaultAgentId === undefined ? existing.defaultAgentId : patch.defaultAgentId,
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
