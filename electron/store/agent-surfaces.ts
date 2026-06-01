// Agent-made interactive surfaces — durable registry for Workbench manifests.
// Surfaces are the OS-level outcome layer before they become generated apps,
// local tools, exports, or automations.
import { getDb } from "./db";
import { getSurfaceJobSummary, syncSurfaceJobs } from "./agent-surface-jobs";
import type {
  AgentlasSurfaceManifest,
  AgentlasSurfaceProvenance,
  AgentlasSurfaceRecord,
  JsonObject,
  JsonValue,
  SurfaceStateEventRecord,
  SurfaceStatePatchRequest,
} from "../../shared/types";
import { randomUUID } from "node:crypto";

interface AgentSurfaceRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  title: string;
  domain: string;
  layout: string;
  manifest_json: string;
  state_json: string;
  provenance_json: string;
  created_at: string;
  updated_at: string;
}

interface AgentSurfaceEventRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  actor: string;
  event_type: string;
  path: string;
  value_json: string;
  previous_value_json: string | null;
  label: string | null;
  created_at: string;
}

const FORBIDDEN_STATE_PATH_RE = /(api[_-]?key|token|secret|password|authorization|cookie|session|private[_-]?key)/i;

export function recordAgentSurface(input: {
  id: string;
  chatId: string;
  projectId?: string | null;
  agentId: string;
  manifest: AgentlasSurfaceManifest;
  state?: JsonObject;
}): AgentlasSurfaceRecord {
  const now = new Date().toISOString();
  const state = input.state ?? getExistingSurfaceState(input.id) ?? {};
  const provenance = input.manifest.provenance ?? [];
  getDb()
    .prepare(
      `INSERT INTO agent_surfaces (
         id, chat_id, project_id, agent_id, title, domain, layout,
         manifest_json, state_json, provenance_json, created_at, updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         chat_id = excluded.chat_id,
         project_id = excluded.project_id,
         agent_id = excluded.agent_id,
         title = excluded.title,
         domain = excluded.domain,
         layout = excluded.layout,
         manifest_json = excluded.manifest_json,
         state_json = excluded.state_json,
         provenance_json = excluded.provenance_json,
         updated_at = excluded.updated_at`,
    )
    .run(
      input.id,
      input.chatId,
      input.projectId ?? null,
      input.agentId,
      input.manifest.title,
      input.manifest.domain,
      input.manifest.layout,
      encodeJson(input.manifest),
      encodeJson(state),
      encodeJson(provenance),
      now,
      now,
    );

  syncSurfaceJobs({
    chatId: input.chatId,
    projectId: input.projectId ?? null,
    agentId: input.agentId,
    surfaceId: input.id,
    manifest: input.manifest,
  });

  const surface = getAgentSurface(input.id);
  if (!surface) throw new Error(`Agent surface registry write failed: ${input.id}`);
  return surface;
}

export function listAgentSurfaces(chatId?: string): AgentlasSurfaceRecord[] {
  const rows = chatId
    ? (getDb()
        .prepare("SELECT * FROM agent_surfaces WHERE chat_id = ? ORDER BY updated_at DESC")
        .all(chatId) as AgentSurfaceRow[])
    : (getDb()
        .prepare("SELECT * FROM agent_surfaces ORDER BY updated_at DESC")
        .all() as AgentSurfaceRow[]);
  return rows.map(toSurface);
}

export function getAgentSurface(id: string): AgentlasSurfaceRecord | null {
  const row = getDb().prepare("SELECT * FROM agent_surfaces WHERE id = ?").get(id) as
    | AgentSurfaceRow
    | undefined;
  return row ? toSurface(row) : null;
}

export function patchAgentSurfaceState(input: SurfaceStatePatchRequest): AgentlasSurfaceRecord {
  validateStatePatch(input);
  const row = getDb().prepare("SELECT * FROM agent_surfaces WHERE id = ?").get(input.surfaceId) as
    | AgentSurfaceRow
    | undefined;
  if (!row) throw new Error(`Agent surface not found: ${input.surfaceId}`);

  const now = new Date().toISOString();
  const state = decodeJson(row.state_json, {}) as JsonObject;
  const previousValue = valueAtJsonPointer(state, input.path);
  const nextState = applyJsonPointerPatch(state, input.path, input.value);

  const tx = getDb().transaction(() => {
    getDb()
      .prepare("UPDATE agent_surfaces SET state_json = ?, updated_at = ? WHERE id = ?")
      .run(encodeJson(nextState), now, input.surfaceId);
    getDb()
      .prepare(
        `INSERT INTO agent_surface_events (
           id, chat_id, project_id, agent_id, surface_id, actor, event_type,
           path, value_json, previous_value_json, label, created_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomUUID(),
        row.chat_id,
        row.project_id,
        row.agent_id,
        row.id,
        input.actor || "user",
        "state-patch",
        input.path,
        encodeJson(input.value),
        previousValue === undefined ? null : encodeJson(previousValue),
        input.label ?? null,
        now,
      );
  });
  tx();

  const surface = getAgentSurface(input.surfaceId);
  if (!surface) throw new Error(`Agent surface state patch failed: ${input.surfaceId}`);
  return surface;
}

export function listAgentSurfaceEvents(surfaceId: string): SurfaceStateEventRecord[] {
  const rows = getDb()
    .prepare("SELECT * FROM agent_surface_events WHERE surface_id = ? ORDER BY created_at DESC")
    .all(surfaceId) as AgentSurfaceEventRow[];
  return rows.map(toEvent);
}

export function applyJsonPointerPatch(state: JsonObject, path: string, value: JsonValue): JsonObject {
  const segments = parseJsonPointer(path);
  if (segments.length === 0) {
    if (!isJsonObject(value)) throw new Error("Root surface state must be a JSON object.");
    return value;
  }
  const next = cloneJsonObject(state);
  let cursor: JsonObject | JsonValue[] = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    const nextSegment = segments[i + 1];
    const shouldBeArray = /^\d+$/.test(nextSegment);
    const existing = Array.isArray(cursor)
      ? cursor[Number(segment)]
      : (cursor as JsonObject)[segment];
    const child =
      shouldBeArray
        ? Array.isArray(existing)
          ? existing
          : []
        : isJsonObject(existing)
          ? existing
          : {};
    if (Array.isArray(cursor)) cursor[Number(segment)] = child;
    else (cursor as JsonObject)[segment] = child;
    cursor = child as JsonObject | JsonValue[];
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) cursor[Number(last)] = value;
  else (cursor as JsonObject)[last] = value;
  return next;
}

export function valueAtJsonPointer(state: JsonValue, path: string): JsonValue | undefined {
  const segments = parseJsonPointer(path);
  let cursor: JsonValue | undefined = state;
  for (const segment of segments) {
    if (Array.isArray(cursor)) cursor = cursor[Number(segment)];
    else if (isJsonObject(cursor)) cursor = cursor[segment] as JsonValue | undefined;
    else return undefined;
  }
  return cursor;
}

function toSurface(row: AgentSurfaceRow): AgentlasSurfaceRecord {
  const fallbackManifest: AgentlasSurfaceManifest = {
    version: "0.1",
    kind: "surface",
    title: row.title,
    domain: row.domain,
    layout: row.layout,
    data: {},
    widgets: [],
  };
  const manifest = decodeJson(row.manifest_json, fallbackManifest) as unknown as AgentlasSurfaceManifest;
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    title: row.title,
    domain: row.domain,
    layout: row.layout,
    manifest,
    state: decodeJson(row.state_json, {}) as JsonObject,
    provenance: decodeJson(row.provenance_json, []) as unknown as AgentlasSurfaceProvenance[],
    jobSummary: getSurfaceJobSummary(row.id, manifest.budget) ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toEvent(row: AgentSurfaceEventRow): SurfaceStateEventRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    actor: row.actor,
    eventType: row.event_type,
    path: row.path,
    value: decodeJson(row.value_json, null),
    previousValue: row.previous_value_json ? decodeJson(row.previous_value_json, null) : null,
    label: row.label,
    createdAt: row.created_at,
  };
}

function getExistingSurfaceState(id: string): JsonObject | null {
  const row = getDb().prepare("SELECT state_json FROM agent_surfaces WHERE id = ?").get(id) as
    | { state_json: string }
    | undefined;
  if (!row) return null;
  const decoded = decodeJson(row.state_json, {});
  return isJsonObject(decoded) ? decoded : {};
}

function validateStatePatch(input: SurfaceStatePatchRequest): void {
  if (!input.surfaceId.trim()) throw new Error("surfaceId is required.");
  if (!input.path.startsWith("/")) throw new Error("Surface state path must be a JSON Pointer.");
  if (FORBIDDEN_STATE_PATH_RE.test(input.path)) {
    throw new Error("Surface state path looks like it may contain a secret.");
  }
}

function parseJsonPointer(path: string): string[] {
  if (path === "") return [];
  if (!path.startsWith("/")) throw new Error("JSON Pointer must start with /.");
  return path
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function cloneJsonObject(value: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) return "null";
  return serialized;
}

function decodeJson(raw: string, fallback: JsonValue | AgentlasSurfaceManifest): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback as JsonValue;
  }
}
