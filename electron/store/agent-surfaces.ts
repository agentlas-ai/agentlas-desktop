// Agent-made interactive surfaces — durable registry for Workbench manifests.
// Surfaces are the OS-level outcome layer before they become generated apps,
// local tools, exports, or automations.
import { getDb } from "./db";
import { emitDesktopStoreChange } from "./change-bus";
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
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactRevisionV2 } from "../../shared/artifact-revision";

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
  state_revision: number;
  artifact_revision: number;
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
  const result = getDb().transaction(() => {
    const now = new Date().toISOString();
    const existing = getDb().prepare("SELECT * FROM agent_surfaces WHERE id = ?").get(input.id) as AgentSurfaceRow | undefined;
    if (existing && (existing.chat_id !== input.chatId || existing.project_id !== (input.projectId ?? null))) {
      throw new Error("artifact_owner_mismatch");
    }
    const manifestJson = encodeJson(input.manifest);
    const changed = !existing || existing.manifest_json !== manifestJson;
    const revision = existing ? existing.artifact_revision + (changed ? 1 : 0) : 1;
    // Model updates own source, never the user's input overlay.
    const stateJson = existing?.state_json ?? encodeJson(input.state ?? {});
    getDb().prepare(`INSERT INTO agent_surfaces (
      id, chat_id, project_id, agent_id, title, domain, layout, manifest_json,
      state_json, provenance_json, created_at, updated_at, artifact_revision, state_revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET
      title=excluded.title, domain=excluded.domain, layout=excluded.layout,
      manifest_json=excluded.manifest_json, provenance_json=excluded.provenance_json,
      artifact_revision=excluded.artifact_revision, updated_at=excluded.updated_at`).run(
        input.id, input.chatId, input.projectId ?? null, existing?.agent_id ?? input.agentId,
        input.manifest.title, input.manifest.domain, input.manifest.layout, manifestJson,
        stateJson, encodeJson(input.manifest.provenance ?? []), now, now, revision,
      );
    if (changed) {
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      const reference: ArtifactRevisionV2 = {
        schemaVersion: "agentlas.artifact-revision.v2", artifactId: input.id,
        owner: { product: "desktop", chatId: input.chatId, projectId: input.projectId ?? null, agentId: existing?.agent_id ?? input.agentId },
        revision, parentRevision: existing?.artifact_revision ?? null,
        sourceDigest: digest(manifestJson), dataDigest: digest(encodeJson(input.manifest.data)),
        stateSchemaDigest: digest(encodeJson(input.manifest.stateSchema ?? {})),
        status: "drafted", createdAt: now,
      };
      getDb().prepare("INSERT INTO agent_surface_revisions VALUES (?, ?, ?, ?, ?)")
        .run(input.id, revision, manifestJson, encodeJson(reference), now);
    }
    syncSurfaceJobs({ chatId: input.chatId, projectId: input.projectId ?? null,
      agentId: existing?.agent_id ?? input.agentId, surfaceId: input.id, manifest: input.manifest });
    const surface = getAgentSurface(input.id);
    if (!surface) throw new Error(`Agent surface registry write failed: ${input.id}`);
    return surface;
  })();
  queueMicrotask(() => emitDesktopStoreChange({ entity: "surface", id: input.id }));
  return result;
}

export function getAgentSurfaceRevision(id: string, revision: number): ArtifactRevisionV2 | null {
  const row = getDb().prepare("SELECT reference_json FROM agent_surface_revisions WHERE surface_id = ? AND revision = ?")
    .get(id, revision) as { reference_json: string } | undefined;
  return row ? JSON.parse(row.reference_json) as ArtifactRevisionV2 : null;
}

export function listAgentSurfaceRevisions(id: string): ArtifactRevisionV2[] {
  const rows = getDb().prepare("SELECT reference_json FROM agent_surface_revisions WHERE surface_id = ? ORDER BY revision")
    .all(id) as Array<{ reference_json: string }>;
  return rows.map((row) => JSON.parse(row.reference_json) as ArtifactRevisionV2);
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
  const result = getDb().transaction(() => {
  const row = getDb().prepare("SELECT * FROM agent_surfaces WHERE id = ?").get(input.surfaceId) as
    | AgentSurfaceRow
    | undefined;
  if (!row) throw new Error(`Agent surface not found: ${input.surfaceId}`);

  if (input.chatId !== row.chat_id || input.projectId !== row.project_id) throw new Error("artifact_owner_mismatch");
  if (input.expectedArtifactRevision !== row.artifact_revision) throw new Error("artifact_revision_conflict");
  if (input.expectedStateRevision !== row.state_revision) throw new Error("artifact_state_conflict");
  const now = new Date().toISOString();
  const state = decodeJson(row.state_json, {}) as JsonObject;
  const previousValue = valueAtJsonPointer(state, input.path);
  const nextState = applyJsonPointerPatch(state, input.path, input.value);

  const tx = getDb().transaction(() => {
    getDb()
      .prepare("UPDATE agent_surfaces SET state_json = ?, state_revision = state_revision + 1, updated_at = ? WHERE id = ? AND state_revision = ? AND artifact_revision = ?")
      .run(encodeJson(nextState), now, input.surfaceId, input.expectedStateRevision, input.expectedArtifactRevision);
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
  })();
  queueMicrotask(() => emitDesktopStoreChange({ entity: "surface", id: input.surfaceId }));
  return result;
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
    stateRevision: row.state_revision,
    artifactRevision: row.artifact_revision,
    artifactRef: getAgentSurfaceRevision(row.id, row.artifact_revision) ?? undefined,
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
  if (!Number.isSafeInteger(input.expectedStateRevision) || input.expectedStateRevision < 0 ||
      !Number.isSafeInteger(input.expectedArtifactRevision) || input.expectedArtifactRevision < 1) {
    throw new Error("artifact_revision_required");
  }
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
    .map((part) => {
      const decoded = part.replace(/~1/g, "/").replace(/~0/g, "~");
      if (["__proto__", "prototype", "constructor"].includes(decoded)) throw new Error("artifact_state_path_invalid");
      if (/^\d+$/.test(decoded) && (!Number.isSafeInteger(Number(decoded)) || Number(decoded) > 100000)) throw new Error("artifact_state_path_invalid");
      return decoded;
    });
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
