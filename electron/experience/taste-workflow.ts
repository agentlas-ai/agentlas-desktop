import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  TasteAxis,
  TasteChipWorkflowRecord,
  TasteGeneralizationConfirmInput,
  TasteGeneralizationInput,
  TasteHubUploadInput,
  TastePreviewGrant,
  TastePreviewPrepareInput,
  TastePreviewRights,
  TastePreviewTreatmentProvenance,
} from "../../shared/experience";
import { getAuthenticatedActorIds, getSessionCookieHeader } from "../auth";
import { pathFromGrant } from "../fs/access";
import { getMemoryDb as getDb } from "../memory/database";
import { copiesPrivateSource } from "./source-copy-guard";
import { publicExperienceSafetyIssues, tasteDraftSourceMemoryHash } from "./store";

const AXES = new Set<TasteAxis>([
  "composition", "color", "typography", "motion", "pacing", "density",
  "imagery", "editing", "spatial-rhythm",
]);
const RIGHTS = new Set<TastePreviewRights>([
  "owner-authorized", "licensed-for-public-preview", "public-domain",
]);
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const OFFICIAL_HOSTS = new Set(["agentlas.cloud", "www.agentlas.cloud", "api.agentlas.cloud", "staging.agentlas.cloud"]);

type WorkflowRow = {
  workflow_id: string;
  draft_id: string;
  agent_id: string;
  base_package_hash: string;
  base_agent_definition_id: string;
  base_agent_release_id: string;
  environment_key: string;
  taste_style_id: string;
  release_id: string;
  title: string;
  summary: string;
  rule_statement: string;
  axis: TasteAxis;
  task_signature: string;
  contexts_json: string;
  generalization_hash: string;
  privacy_issue_codes_json: string;
  status: TasteChipWorkflowRecord["status"];
  confirmed_at: string | null;
  preview_grants_json: string | null;
  preview_names_json: string | null;
  preview_digests_json: string | null;
  preview_provenance_json: string | null;
  preview_rights: TastePreviewRights | null;
  remote_preview_asset_ids_json: string | null;
  remote_revision: string | null;
  remote_error_code: string | null;
  created_at: string;
  updated_at: string;
};

type DraftRow = {
  id: string;
  agent_id: string;
  source_memory_id: string;
  source_memory_hash: string;
  environment_key: string;
  base_package_hash: string;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  axis_candidates_json: string;
  task_signatures_json: string;
  status: "observation" | "rejected";
};

type SourceMemoryRow = {
  id: string;
  agent_id: string;
  content: string;
  superseded_at: string | null;
};

export interface TasteHubDependencies {
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  cookieHeader?: string;
  actor?: { workspaceId: string; userId: string };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function jsonArray<T>(value: string | null, fallback: T[] = []): T[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : fallback;
  } catch {
    return fallback;
  }
}

function pair<T>(value: string | null): [T, T] | null {
  const values = jsonArray<T>(value);
  return values.length === 2 ? [values[0], values[1]] : null;
}

function fromRow(row: WorkflowRow): TasteChipWorkflowRecord {
  return {
    workflowId: row.workflow_id,
    draftId: row.draft_id,
    agentId: row.agent_id,
    basePackageHash: row.base_package_hash,
    baseAgentDefinitionId: row.base_agent_definition_id,
    baseAgentReleaseId: row.base_agent_release_id,
    environmentKey: row.environment_key,
    tasteStyleId: row.taste_style_id,
    releaseId: row.release_id,
    title: row.title,
    summary: row.summary,
    ruleStatement: row.rule_statement,
    axis: row.axis,
    taskSignature: row.task_signature,
    contexts: jsonArray<string>(row.contexts_json),
    generalizationHash: row.generalization_hash,
    privacyIssueCodes: jsonArray<string>(row.privacy_issue_codes_json),
    status: row.status,
    confirmedAt: row.confirmed_at,
    previewNames: pair<string>(row.preview_names_json),
    previewTreatments: pair<TastePreviewTreatmentProvenance>(row.preview_provenance_json),
    previewRights: row.preview_rights,
    remotePreviewAssetIds: pair<string>(row.remote_preview_asset_ids_json),
    remoteRevision: row.remote_revision,
    remoteErrorCode: row.remote_error_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeRef(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_REF_RE.test(text) || text.includes("..")) throw new Error(`${label} is invalid.`);
  return text;
}

/** Archived receipts are historical evidence; reading them never revalidates or rewrites their status. */
export function listTasteChipWorkflows(agentId: string): TasteChipWorkflowRecord[] {
  const exactAgentId = safeRef(agentId, "agentId");
  return (getDb().prepare(
    "SELECT * FROM taste_chip_workflows WHERE agent_id = ? ORDER BY updated_at DESC, workflow_id ASC",
  ).all(exactAgentId) as WorkflowRow[]).map(fromRow);
}

function previewMetadata(grant: TastePreviewGrant): { grant: TastePreviewGrant; name: string; bytes: Buffer; mimeType: string; digest: string } {
  const file = pathFromGrant(grant, "file");
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_PREVIEW_BYTES) {
    throw new Error("Each Taste preview must be a regular image up to 8 MB.");
  }
  const bytes = fs.readFileSync(file);
  const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
      ? "image/jpeg"
      : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP"
        ? "image/webp"
        : "";
  if (!mimeType) throw new Error("Taste previews must be PNG, JPEG, or WebP images.");
  return { grant, name: path.basename(file).slice(0, 120), bytes, mimeType, digest: sha256(bytes) };
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Taste Hub response is too large.");
  let value: unknown = {};
  try { value = text ? JSON.parse(text) : {}; } catch { throw new Error("Taste Hub returned malformed JSON."); }
  if (!response.ok) {
    const body = value && typeof value === "object" ? value as Record<string, unknown> : {};
    const error = typeof body.error === "string" ? body.error : `http_${response.status}`;
    throw Object.assign(new Error(typeof body.message === "string" ? body.message : error), { code: error });
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function uploadPreview(fetcher: typeof globalThis.fetch, origin: string, cookie: string, meta: ReturnType<typeof previewMetadata>, rights: TastePreviewRights) {
  const form = new FormData();
  form.set("file", new Blob([Uint8Array.from(meta.bytes)], { type: meta.mimeType }), meta.name);
  form.set("rightsStatus", rights);
  form.set("rightsAttested", "true");
  return responseJson(await fetcher(`${origin}/api/ontology/v1/taste-preview-assets`, {
    method: "POST", headers: { cookie }, body: form,
  }));
}

