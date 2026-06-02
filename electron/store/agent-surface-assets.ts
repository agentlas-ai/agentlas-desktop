// Agent-made surface asset packs — durable registry for reusable media/storyboard exports.
// The files live on disk; this table makes them first-class Agentlas OS objects
// that can be archived, reopened, and reused by later agents.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getDb } from "./db";
import type {
  AgentlasSurfaceManifest,
  JsonValue,
  SurfaceAssetPackOperationKind,
  SurfaceAssetPackOperationRecord,
  SurfaceAssetPackRecord,
  SurfaceAssetPackSnapshot,
  SurfaceAssetPackStatus,
} from "../../shared/types";

interface SurfaceAssetPackRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  action_id: string | null;
  pack_name: string;
  domain: string;
  layout: string;
  root_path: string;
  manifest_path: string;
  index_path: string;
  assets_path: string;
  manifest_json: string;
  result_json: string;
  status: string;
  created_at: string;
  updated_at: string;
}

interface SurfaceAssetPackOperationRow {
  id: string;
  pack_id: string;
  operation: string;
  ok: number;
  result_json: string;
  created_at: string;
}

export function recordMaterializedSurfaceAssetPack(input: {
  chatId: string;
  projectId?: string | null;
  agentId: string;
  surfaceId: string;
  actionId?: string | null;
  manifest: AgentlasSurfaceManifest;
  snapshot: SurfaceAssetPackSnapshot;
}): SurfaceAssetPackRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_surface_asset_packs (
       id, chat_id, project_id, agent_id, surface_id, action_id, pack_name,
       domain, layout, root_path, manifest_path, index_path, assets_path,
       manifest_json, result_json, status, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'materialized', ?, ?)
     ON CONFLICT(root_path) DO UPDATE SET
       chat_id = excluded.chat_id,
       project_id = excluded.project_id,
       agent_id = excluded.agent_id,
       surface_id = excluded.surface_id,
       action_id = excluded.action_id,
       pack_name = excluded.pack_name,
       domain = excluded.domain,
       layout = excluded.layout,
       manifest_path = excluded.manifest_path,
       index_path = excluded.index_path,
       assets_path = excluded.assets_path,
       manifest_json = excluded.manifest_json,
       result_json = excluded.result_json,
       status = 'materialized',
       updated_at = excluded.updated_at`,
  ).run(
    id,
    input.chatId,
    input.projectId ?? null,
    input.agentId,
    input.surfaceId,
    input.actionId ?? null,
    input.snapshot.packName,
    input.manifest.domain,
    input.manifest.layout,
    input.snapshot.rootPath,
    input.snapshot.manifestPath,
    input.snapshot.indexPath,
    input.snapshot.assetsPath,
    encodeJson(input.manifest),
    encodeJson(input.snapshot),
    now,
    now,
  );

  const pack = getSurfaceAssetPackByRoot(input.snapshot.rootPath);
  if (!pack) throw new Error(`Surface asset pack registry write failed: ${input.snapshot.rootPath}`);
  recordSurfaceAssetPackOperation(pack.id, "materialize", true, input.snapshot, "materialized");
  return getSurfaceAssetPack(pack.id) ?? pack;
}

export function recordSurfaceAssetPackOperation(
  packId: string,
  operation: SurfaceAssetPackOperationKind,
  ok: boolean,
  result: unknown,
  status?: SurfaceAssetPackStatus,
): SurfaceAssetPackOperationRecord {
  const id = randomUUID();
  const now = new Date().toISOString();
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_surface_asset_pack_operations (id, pack_id, operation, ok, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, packId, operation, ok ? 1 : 0, encodeJson(result), now);
  if (status) {
    db.prepare(
      "UPDATE agent_surface_asset_packs SET status = ?, updated_at = ? WHERE id = ?",
    ).run(status, now, packId);
  }
  const row = db
    .prepare("SELECT * FROM agent_surface_asset_pack_operations WHERE id = ?")
    .get(id) as SurfaceAssetPackOperationRow | undefined;
  if (!row) throw new Error(`Surface asset pack operation write failed: ${operation}`);
  return toOperation(row);
}

export function listSurfaceAssetPacks(chatId?: string): SurfaceAssetPackRecord[] {
  const rows = chatId
    ? (getDb()
        .prepare("SELECT * FROM agent_surface_asset_packs WHERE chat_id = ? ORDER BY updated_at DESC")
        .all(chatId) as SurfaceAssetPackRow[])
    : (getDb()
        .prepare("SELECT * FROM agent_surface_asset_packs ORDER BY updated_at DESC")
        .all() as SurfaceAssetPackRow[]);
  return rows.map(toPack);
}

export function getSurfaceAssetPack(id: string): SurfaceAssetPackRecord | null {
  const row = getDb().prepare("SELECT * FROM agent_surface_asset_packs WHERE id = ?").get(id) as
    | SurfaceAssetPackRow
    | undefined;
  return row ? toPack(row) : null;
}

export function getSurfaceAssetPackByRoot(rootPath: string): SurfaceAssetPackRecord | null {
  const row = getDb()
    .prepare("SELECT * FROM agent_surface_asset_packs WHERE root_path = ?")
    .get(rootPath) as SurfaceAssetPackRow | undefined;
  return row ? toPack(row) : null;
}

export function getSurfaceAssetPackBySurface(
  chatId: string,
  surfaceId: string,
): SurfaceAssetPackRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_surface_asset_packs
       WHERE chat_id = ? AND surface_id = ?
       ORDER BY updated_at DESC LIMIT 1`,
    )
    .get(chatId, surfaceId) as SurfaceAssetPackRow | undefined;
  return row ? toPack(row) : null;
}

export function listSurfaceAssetPackOperations(packId: string): SurfaceAssetPackOperationRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_surface_asset_pack_operations WHERE pack_id = ? ORDER BY created_at DESC")
    .all(packId) as SurfaceAssetPackOperationRow[];
  return rows.map(toOperation);
}

function toPack(row: SurfaceAssetPackRow): SurfaceAssetPackRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    actionId: row.action_id,
    packName: row.pack_name,
    domain: row.domain,
    layout: row.layout,
    rootPath: row.root_path,
    manifestPath: row.manifest_path,
    indexPath: row.index_path,
    assetsPath: row.assets_path,
    manifest: decodeJson(row.manifest_json, fallbackManifest(row)) as AgentlasSurfaceManifest,
    snapshot: decodeJson(row.result_json, fallbackSnapshot(row)) as unknown as SurfaceAssetPackSnapshot,
    status: isStatus(row.status) ? row.status : "materialized",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toOperation(row: SurfaceAssetPackOperationRow): SurfaceAssetPackOperationRecord {
  return {
    id: row.id,
    packId: row.pack_id,
    operation: isOperation(row.operation) ? row.operation : "materialize",
    ok: !!row.ok,
    result: decodeJson(row.result_json, null),
    createdAt: row.created_at,
  };
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "null";
  return serialized;
}

function decodeJson(raw: string, fallback: JsonValue | AgentlasSurfaceManifest | SurfaceAssetPackSnapshot): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback as JsonValue;
  }
}

function fallbackManifest(row: SurfaceAssetPackRow): AgentlasSurfaceManifest {
  return {
    version: "0.1",
    kind: "surface",
    title: row.pack_name,
    domain: row.domain,
    layout: row.layout,
    data: {},
    widgets: [],
  };
}

function fallbackSnapshot(row: SurfaceAssetPackRow): SurfaceAssetPackSnapshot {
  return {
    packId: row.id,
    packName: row.pack_name,
    rootPath: row.root_path,
    manifestPath: row.manifest_path,
    indexPath: row.index_path,
    assetsPath: row.assets_path,
    fileUrl: pathToFileURL(row.index_path).toString(),
    createdAt: row.created_at,
    files: [],
    remoteAssets: [],
    summary: "Surface asset pack metadata could not be decoded.",
  };
}

function isStatus(value: string): value is SurfaceAssetPackStatus {
  return value === "materialized" || value === "restored" || value === "archived";
}

function isOperation(value: string): value is SurfaceAssetPackOperationKind {
  return value === "materialize" || value === "archive" || value === "restore";
}
