// Durable approval ledger for Agentlas Surface actions.
// This records what the user approved: capability scope, payment quote, browser
// delegation, credential request, or budget gate. It never stores passwords,
// API key values, cookies, card numbers, CVV/CVC, or one-time codes.
import { randomUUID } from "node:crypto";
import { getDb } from "./db";
import type {
  JsonObject,
  JsonValue,
  SurfaceApprovalCheckRequest,
  SurfaceApprovalGrantRequest,
  SurfaceApprovalRecord,
} from "../../shared/types";

interface ApprovalSurfaceRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
}

interface ApprovalRow {
  id: string;
  chat_id: string;
  project_id: string | null;
  agent_id: string;
  surface_id: string;
  action_id: string | null;
  action_type: string;
  kind: string;
  scope_key: string;
  title: string;
  summary: string;
  metadata_json: string;
  revoked_at: string | null;
  created_at: string;
}

const SECRETISH_RE =
  /(api[_-]?key|token|secret|password|authorization|cookie|session|private[_-]?key|card[_-]?number|cvv|cvc|otp|one[_-]?time)/i;

export function approveAgentSurface(input: SurfaceApprovalGrantRequest): SurfaceApprovalRecord {
  validateApprovalInput(input);
  const surface = getApprovalSurface(input.surfaceId);
  if (!surface) throw new Error(`Agent surface not found: ${input.surfaceId}`);

  const now = new Date().toISOString();
  const existing = getActiveApproval(input.surfaceId, input.scopeKey);
  if (existing) return existing;

  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO agent_surface_approvals (
         id, chat_id, project_id, agent_id, surface_id, action_id, action_type,
         kind, scope_key, title, summary, metadata_json, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      surface.chat_id,
      surface.project_id,
      surface.agent_id,
      surface.id,
      input.actionId ?? null,
      input.actionType,
      input.kind,
      input.scopeKey,
      input.title,
      input.summary,
      encodeJson(scrubMetadata(input.metadata ?? {})),
      null,
      now,
    );

  const row = getDb().prepare("SELECT * FROM agent_surface_approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!row) throw new Error(`Surface approval write failed: ${id}`);
  return toApproval(row);
}

export function hasAgentSurfaceApproval(input: SurfaceApprovalCheckRequest): boolean {
  validateApprovalCheck(input);
  return Boolean(getActiveApproval(input.surfaceId, input.scopeKey));
}

export function listAgentSurfaceApprovals(surfaceId: string): SurfaceApprovalRecord[] {
  if (!surfaceId.trim()) throw new Error("surfaceId is required.");
  const rows = getDb()
    .prepare("SELECT * FROM agent_surface_approvals WHERE surface_id = ? ORDER BY created_at DESC")
    .all(surfaceId) as ApprovalRow[];
  return rows.map(toApproval);
}

export function revokeAgentSurfaceApproval(id: string): SurfaceApprovalRecord {
  if (!id.trim()) throw new Error("approval id is required.");
  const row = getDb().prepare("SELECT * FROM agent_surface_approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!row) throw new Error(`Surface approval not found: ${id}`);
  const now = new Date().toISOString();
  getDb().prepare("UPDATE agent_surface_approvals SET revoked_at = ? WHERE id = ?").run(now, id);
  const updated = getDb().prepare("SELECT * FROM agent_surface_approvals WHERE id = ?").get(id) as ApprovalRow | undefined;
  if (!updated) throw new Error(`Surface approval revoke failed: ${id}`);
  return toApproval(updated);
}

function getActiveApproval(surfaceId: string, scopeKey: string): SurfaceApprovalRecord | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM agent_surface_approvals
       WHERE surface_id = ? AND scope_key = ? AND revoked_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(surfaceId, scopeKey) as ApprovalRow | undefined;
  return row ? toApproval(row) : null;
}

function getApprovalSurface(surfaceId: string): ApprovalSurfaceRow | null {
  const row = getDb()
    .prepare("SELECT id, chat_id, project_id, agent_id FROM agent_surfaces WHERE id = ?")
    .get(surfaceId) as ApprovalSurfaceRow | undefined;
  return row ?? null;
}

function validateApprovalInput(input: SurfaceApprovalGrantRequest): void {
  validateApprovalCheck(input);
  for (const [key, value] of Object.entries({
    actionType: input.actionType,
    kind: input.kind,
    title: input.title,
    summary: input.summary,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  }
  if (containsSecretishKey(input.metadata ?? {})) {
    throw new Error("Surface approval metadata must not contain secret, token, password, cookie, OTP, or card fields.");
  }
}

function validateApprovalCheck(input: SurfaceApprovalCheckRequest): void {
  if (!input.surfaceId.trim()) throw new Error("surfaceId is required.");
  if (!input.scopeKey.trim()) throw new Error("scopeKey is required.");
}

function scrubMetadata(metadata: JsonObject): JsonObject {
  return JSON.parse(JSON.stringify(metadata)) as JsonObject;
}

function containsSecretishKey(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(containsSecretishKey);
  if (!isJsonObject(value)) return false;
  return Object.entries(value).some(([key, nested]) => SECRETISH_RE.test(key) || containsSecretishKey(nested));
}

function toApproval(row: ApprovalRow): SurfaceApprovalRecord {
  return {
    id: row.id,
    chatId: row.chat_id,
    projectId: row.project_id,
    agentId: row.agent_id,
    surfaceId: row.surface_id,
    actionId: row.action_id,
    actionType: row.action_type,
    kind: row.kind,
    scopeKey: row.scope_key,
    title: row.title,
    summary: row.summary,
    metadata: decodeJson(row.metadata_json, {}) as JsonObject,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function encodeJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized || "null";
}

function decodeJson(raw: string, fallback: JsonValue): JsonValue {
  try {
    return JSON.parse(raw) as JsonValue;
  } catch {
    return fallback;
  }
}
