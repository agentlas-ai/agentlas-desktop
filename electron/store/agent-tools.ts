// Agent-made local tools — durable registry for Tool Factory outputs.
// The generated runtime/MCP files live on disk; this table makes them
// first-class OS assets that survive chat reloads and can be installed as MCPs.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  JsonValue,
  ToolFactoryOperationKind,
  ToolFactoryOperationRecord,
  ToolFactoryScaffoldSnapshot,
  ToolFactoryToolRecord,
  ToolFactoryToolStatus,
} from "../../shared/types";

interface AgentToolRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  action_id: string | null;
  requested_tool_id: string;
  generated_tool_id: string;
  tool_name: string;
  domain: string;
  kind: string;
  root_path: string;
  config_path: string;
  tool_path: string;
  mcp_path: string;
  smoke_path: string;
  result_json: string;
  status: string;
  installed_server_id: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentToolOperationRow {
  id: string;
  tool_id: string;
  operation: string;
  ok: number;
  result_json: string;
  created_at: string;
}

export function recordScaffoldedTool(input: {
  chatId: string;
  projectId?: string | null;
  agentId: string;
  surfaceId: string;
  actionId?: string | null;
  scaffold: ToolFactoryScaffoldSnapshot;
}): ToolFactoryToolRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_tools (
       id, chat_id, project_id, agent_id, surface_id, action_id, requested_tool_id,
       generated_tool_id, tool_name, domain, kind, root_path, config_path, tool_path,
       mcp_path, smoke_path, result_json, status, installed_server_id, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scaffolded', NULL, ?, ?)
     ON CONFLICT(root_path) DO UPDATE SET
       chat_id = excluded.chat_id,
       project_id = excluded.project_id,
       agent_id = excluded.agent_id,
       surface_id = excluded.surface_id,
       action_id = excluded.action_id,
       requested_tool_id = excluded.requested_tool_id,
       generated_tool_id = excluded.generated_tool_id,
       tool_name = excluded.tool_name,
       domain = excluded.domain,
       kind = excluded.kind,
       config_path = excluded.config_path,
       tool_path = excluded.tool_path,
       mcp_path = excluded.mcp_path,
       smoke_path = excluded.smoke_path,
       result_json = excluded.result_json,
       status = 'scaffolded',
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.chatId,
    input.projectId ?? null,
    input.agentId,
    input.surfaceId,
    input.actionId ?? null,
    input.scaffold.requestedToolId,
    input.scaffold.toolId,
    input.scaffold.toolName,
    input.scaffold.domain,
    input.scaffold.kind,
    input.scaffold.rootPath,
    input.scaffold.configPath,
    input.scaffold.toolPath,
    input.scaffold.mcpPath,
    input.scaffold.smokePath,
    encodeJson(input.scaffold),
    now,
    now,
  );

  const tool = getAgentToolByRoot(input.scaffold.rootPath);
  if (!tool) throw new Error(`Agent tool registry write failed: ${input.scaffold.rootPath}`);
  recordAgentToolOperation(tool.id, "scaffold", true, input.scaffold, "scaffolded");
  return getAgentTool(tool.id) ?? tool;
}

export function recordAgentToolOperation(
  toolId: string,
  operation: ToolFactoryOperationKind,
  ok: boolean,
  result: unknown,
  status?: ToolFactoryToolStatus,
  installedServerId?: string | null,
): ToolFactoryOperationRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_tool_operations (id, tool_id, operation, ok, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, toolId, operation, ok ? 1 : 0, encodeJson(result), now);
  if (status) {
    if (installedServerId !== undefined) {
      db.prepare(
        `UPDATE agent_tools
         SET status = ?, installed_server_id = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, installedServerId, now, toolId);
    } else {
      db.prepare(
        `UPDATE agent_tools
         SET status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(status, now, toolId);
    }
  }
  const row = db
    .prepare("SELECT * FROM agent_tool_operations WHERE id = ?")
    .get(id) as AgentToolOperationRow | undefined;
  if (!row) throw new Error(`Agent tool operation write failed: ${operation}`);
  return toOperation(row);
}

export function listAgentTools(chatId?: string): ToolFactoryToolRecord[] {
  const rows = chatId
    ? (getDb()
        .prepare("SELECT * FROM agent_tools WHERE chat_id = ? ORDER BY updated_at DESC")
        .all(chatId) as AgentToolRow[])
    : (getDb()
        .prepare("SELECT * FROM agent_tools ORDER BY updated_at DESC")
        .all() as AgentToolRow[]);
  return rows.map(toTool);
}

export function getAgentTool(id: string): ToolFactoryToolRecord | null {
  const row = getDb().prepare("SELECT * FROM agent_tools WHERE id = ?").get(id) as
    | AgentToolRow
    | undefined;
  return row ? toTool(row) : null;
}

export function getAgentToolByRoot(rootPath: string): ToolFactoryToolRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_tools WHERE root_path = ?")
    .get(rootPath) as AgentToolRow | undefined;
  return row ? toTool(row) : null;
}

export function getAgentToolBySurface(
  chatId: string,
  surfaceId: string,
  requestedToolId?: string,
): ToolFactoryToolRecord | null {
  const row = requestedToolId
    ? (getDb()
        .prepare(
          `SELECT * FROM agent_tools
           WHERE chat_id = ? AND surface_id = ? AND requested_tool_id = ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(chatId, surfaceId, requestedToolId) as AgentToolRow | undefined)
    : (getDb()
        .prepare(
          `SELECT * FROM agent_tools
           WHERE chat_id = ? AND surface_id = ?
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(chatId, surfaceId) as AgentToolRow | undefined);
  return row ? toTool(row) : null;
}

export function listAgentToolOperations(toolId: string): ToolFactoryOperationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_tool_operations WHERE tool_id = ? ORDER BY created_at DESC")
    .all(toolId) as AgentToolOperationRow[];
  return rows.map(toOperation);
}

function toTool(row: AgentToolRow): ToolFactoryToolRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    actionId: row.action_id,
    requestedToolId: row.requested_tool_id,
    toolId: row.generated_tool_id,
    toolName: row.tool_name,
    domain: row.domain,
    kind: row.kind,
    rootPath: row.root_path,
    configPath: row.config_path,
    toolPath: row.tool_path,
    mcpPath: row.mcp_path,
    smokePath: row.smoke_path,
    scaffold: decodeJson(row.result_json, fallbackScaffold(row)) as unknown as ToolFactoryScaffoldSnapshot,
    status: isToolStatus(row.status) ? row.status : "scaffolded",
    installedServerId: row.installed_server_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOperation(row: AgentToolOperationRow): ToolFactoryOperationRecord {
  return {
    id: row.id,
    toolId: row.tool_id,
    operation: isOperationKind(row.operation) ? row.operation : "scaffold",
    ok: !!row.ok,
    result: decodeJson(row.result_json, null),
    createdAt: row.created_at,
  };
}

function fallbackScaffold(row: AgentToolRow): ToolFactoryScaffoldSnapshot {
  return {
    toolId: row.generated_tool_id,
    requestedToolId: row.requested_tool_id,
    toolName: row.tool_name,
    domain: row.domain,
    kind: row.kind,
    rootPath: row.root_path,
    configPath: row.config_path,
    toolPath: row.tool_path,
    mcpPath: row.mcp_path,
    smokePath: row.smoke_path,
    createdAt: row.created_at,
    files: [],
    summary: "Recovered from Agentlas tool registry.",
  };
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "null";
  return serialized;
}

function decodeJson(raw: string, fallback: JsonValue | ToolFactoryScaffoldSnapshot): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback as JsonValue;
  }
}

function isToolStatus(value: string): value is ToolFactoryToolStatus {
  return (
    value === "scaffolded" ||
    value === "smoke-passed" ||
    value === "smoke-failed" ||
    value === "mcp-installed" ||
    value === "restored" ||
    value === "archived"
  );
}

function isOperationKind(value: string): value is ToolFactoryOperationKind {
  return value === "scaffold" || value === "run-smoke-test" || value === "install-mcp" || value === "archive" || value === "restore";
}
