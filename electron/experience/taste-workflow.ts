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
import { getDb } from "../store/db";
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

function stableId(prefix: string, seed: string): string {
  return `${prefix}_${sha256(seed).slice(0, 48)}`;
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

function getWorkflow(workflowId: string): WorkflowRow {
  if (!SAFE_REF_RE.test(workflowId)) throw new Error("Taste workflow id is invalid.");
  const row = getDb().prepare("SELECT * FROM taste_chip_workflows WHERE workflow_id = ?").get(workflowId) as WorkflowRow | undefined;
  if (!row) throw new Error("Taste workflow was not found.");
  return row;
}

function cleanText(value: unknown, label: string, max: number): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text || text.length > max || /[\u0000-\u001f]/.test(text)) throw new Error(`${label} is invalid.`);
  return text;
}

function safeRef(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!SAFE_REF_RE.test(text) || text.includes("..")) throw new Error(`${label} is invalid.`);
  return text;
}

function privacyIssues(fields: string[]): string[] {
  return [...new Set(fields.flatMap((field) => publicExperienceSafetyIssues(field)))].sort();
}

function generalizedFields(value: {
  title: string;
  summary: string;
  ruleStatement: string;
  taskSignature: string;
  contexts: string[];
}): string[] {
  return [value.title, value.summary, value.ruleStatement, value.taskSignature, ...value.contexts];
}

function sourceMemory(draft: DraftRow): SourceMemoryRow | null {
  const memory = getDb().prepare(
    `SELECT id, agent_id, content, superseded_at
       FROM memory_entries
      WHERE id = ? AND agent_id = ? LIMIT 1`,
  ).get(draft.source_memory_id, draft.agent_id) as SourceMemoryRow | undefined;
  if (!memory || memory.superseded_at) return null;
  const currentHash = tasteDraftSourceMemoryHash({
    agentId: draft.agent_id,
    memoryId: memory.id,
    memoryContent: memory.content,
    basePackageHash: draft.base_package_hash,
    environmentKey: draft.environment_key,
  });
  return currentHash === draft.source_memory_hash ? memory : null;
}

function sourceCopyIssues(fields: string[], memory: SourceMemoryRow): string[] {
  return copiesPrivateSource(fields.join("\n"), memory.content) ? ["source-copy-overlap"] : [];
}

function generalizationHash(value: {
  draftId: string; agentId: string; basePackageHash: string; baseAgentDefinitionId: string;
  baseAgentReleaseId: string; environmentKey: string; title: string; summary: string;
  ruleStatement: string; axis: TasteAxis; taskSignature: string; contexts: string[];
}): string {
  return `sha256:${sha256(JSON.stringify(value))}`;
}

function draftForWorkflow(row: WorkflowRow): DraftRow | null {
  return getDb().prepare(
    "SELECT * FROM taste_draft_candidates WHERE id = ? AND agent_id = ? LIMIT 1",
  ).get(row.draft_id, row.agent_id) as DraftRow | undefined ?? null;
}

function liveGeneralizationHash(row: WorkflowRow): string {
  return generalizationHash({
    draftId: row.draft_id,
    agentId: row.agent_id,
    basePackageHash: row.base_package_hash,
    baseAgentDefinitionId: row.base_agent_definition_id,
    baseAgentReleaseId: row.base_agent_release_id,
    environmentKey: row.environment_key,
    title: row.title,
    summary: row.summary,
    ruleStatement: row.rule_statement,
    axis: row.axis,
    taskSignature: row.task_signature,
    contexts: jsonArray<string>(row.contexts_json),
  });
}

function invalidateWorkflow(row: WorkflowRow, issueCodes: string[]): WorkflowRow {
  const issues = [...new Set(issueCodes)].sort();
  const alreadyInvalidated = row.status === "proposal" && row.confirmed_at === null &&
    row.preview_grants_json === null && row.preview_names_json === null &&
    row.preview_digests_json === null && row.preview_provenance_json === null &&
    row.preview_rights === null && row.remote_preview_asset_ids_json === null &&
    JSON.stringify(jsonArray<string>(row.privacy_issue_codes_json).sort()) === JSON.stringify(issues);
  if (alreadyInvalidated) return row;
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE taste_chip_workflows
        SET status = 'proposal', confirmed_at = NULL,
            preview_grants_json = NULL, preview_names_json = NULL,
            preview_digests_json = NULL, preview_provenance_json = NULL,
            preview_rights = NULL, remote_preview_asset_ids_json = NULL,
            privacy_issue_codes_json = ?,
            remote_error_code = CASE WHEN remote_revision IS NULL THEN NULL ELSE 'local_material_changed' END,
            updated_at = ?
      WHERE workflow_id = ?`,
  ).run(JSON.stringify(issues), now, row.workflow_id);
  return getWorkflow(row.workflow_id);
}

/** Revalidates only against local hashes/content and persists value-free codes. */
function revalidateWorkflow(row: WorkflowRow): WorkflowRow {
  const draft = draftForWorkflow(row);
  const issues: string[] = [];
  if (!draft || draft.status !== "observation" ||
      draft.base_package_hash !== row.base_package_hash ||
      draft.base_agent_definition_id !== row.base_agent_definition_id ||
      draft.base_agent_release_id !== row.base_agent_release_id ||
      draft.environment_key !== row.environment_key) {
    issues.push("source-material-changed");
  }
  const memory = draft ? sourceMemory(draft) : null;
  if (!memory) issues.push("source-material-changed");
  if (liveGeneralizationHash(row) !== row.generalization_hash) issues.push("generalization-material-changed");
  const fields = generalizedFields({
    title: row.title,
    summary: row.summary,
    ruleStatement: row.rule_statement,
    taskSignature: row.task_signature,
    contexts: jsonArray<string>(row.contexts_json),
  });
  issues.push(...privacyIssues(fields));
  if (memory) issues.push(...sourceCopyIssues(fields, memory));
  return issues.length > 0 ? invalidateWorkflow(row, issues) : row;
}

export function listTasteChipWorkflows(agentId: string): TasteChipWorkflowRecord[] {
  const exactAgentId = safeRef(agentId, "agentId");
  return (getDb().prepare(
    "SELECT * FROM taste_chip_workflows WHERE agent_id = ? ORDER BY updated_at DESC, workflow_id ASC",
  ).all(exactAgentId) as WorkflowRow[]).map(revalidateWorkflow).map(fromRow);
}

export function saveTasteGeneralization(input: TasteGeneralizationInput): TasteChipWorkflowRecord {
  const draftId = safeRef(input.draftId, "draftId");
  const agentId = safeRef(input.agentId, "agentId");
  const draft = getDb().prepare("SELECT * FROM taste_draft_candidates WHERE id = ? AND agent_id = ?")
    .get(draftId, agentId) as DraftRow | undefined;
  if (!draft || draft.status !== "observation") throw new Error("The private Taste observation is unavailable.");
  if (!draft.base_agent_definition_id || !draft.base_agent_release_id || !HASH_RE.test(draft.base_package_hash)) {
    throw new Error("An exact Hub Agent definition and release binding is required.");
  }
  if (!AXES.has(input.axis)) throw new Error("Taste axis is invalid.");
  const allowedTasks = new Set(jsonArray<string>(draft.task_signatures_json));
  const taskSignature = safeRef(input.taskSignature, "taskSignature");
  if (!allowedTasks.has(taskSignature)) throw new Error("Task signature must come from this exact observation.");
  const contexts = [...new Set((input.contexts ?? []).map((item) => safeRef(item, "context")))].slice(0, 12);
  if (!contexts.length) throw new Error("At least one portable context is required.");
  const title = cleanText(input.title, "title", 120);
  const summary = cleanText(input.summary, "summary", 600);
  const ruleStatement = cleanText(input.ruleStatement, "ruleStatement", 320);
  const memory = sourceMemory(draft);
  if (!memory) throw new Error("The exact private source Memory changed or is unavailable. Create a new Taste observation.");
  const fields = generalizedFields({ title, summary, ruleStatement, taskSignature, contexts });
  const issues = [...new Set([...privacyIssues(fields), ...sourceCopyIssues(fields, memory)])].sort();
  if (issues.length) throw new Error(`Generalized Taste text is not public-safe: ${issues.join(", ")}`);
  const seed = `${draft.id}\0${draft.base_agent_definition_id}\0${draft.base_agent_release_id}`;
  const workflowId = stableId("twf", seed);
  const tasteStyleId = stableId("tst", `${draft.agent_id}\0${draft.base_package_hash}`);
  const releaseId = stableId("tsr", seed);
  const exact = {
    draftId, agentId, basePackageHash: draft.base_package_hash,
    baseAgentDefinitionId: draft.base_agent_definition_id,
    baseAgentReleaseId: draft.base_agent_release_id,
    environmentKey: draft.environment_key,
    title, summary, ruleStatement, axis: input.axis, taskSignature, contexts,
  };
  const hash = generalizationHash(exact);
  const existing = getDb().prepare("SELECT * FROM taste_chip_workflows WHERE draft_id = ?").get(draftId) as WorkflowRow | undefined;
  if (existing?.remote_revision && existing.generalization_hash !== hash) {
    throw new Error("A Hub draft already exists. Create a new Taste observation for changed rules.");
  }
  const now = new Date().toISOString();
  getDb().prepare(
    `INSERT INTO taste_chip_workflows (
       workflow_id, draft_id, agent_id, base_package_hash, base_agent_definition_id,
       base_agent_release_id, environment_key, taste_style_id, release_id, title,
       summary, rule_statement, axis, task_signature, contexts_json,
       generalization_hash, privacy_issue_codes_json, status, confirmed_at,
       preview_grants_json, preview_names_json, preview_digests_json, preview_rights,
       remote_preview_asset_ids_json, remote_revision, remote_error_code,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'proposal', NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(draft_id) DO UPDATE SET
       title = excluded.title, summary = excluded.summary,
       rule_statement = excluded.rule_statement, axis = excluded.axis,
       task_signature = excluded.task_signature, contexts_json = excluded.contexts_json,
       generalization_hash = excluded.generalization_hash,
       privacy_issue_codes_json = '[]',
       status = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.status ELSE 'proposal' END,
       confirmed_at = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.confirmed_at ELSE NULL END,
       preview_grants_json = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.preview_grants_json ELSE NULL END,
       preview_names_json = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.preview_names_json ELSE NULL END,
       preview_digests_json = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.preview_digests_json ELSE NULL END,
       preview_provenance_json = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.preview_provenance_json ELSE NULL END,
       preview_rights = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.preview_rights ELSE NULL END,
       remote_preview_asset_ids_json = CASE WHEN taste_chip_workflows.generalization_hash = excluded.generalization_hash
         THEN taste_chip_workflows.remote_preview_asset_ids_json ELSE NULL END,
       updated_at = excluded.updated_at`,
  ).run(
    workflowId, draftId, agentId, draft.base_package_hash, draft.base_agent_definition_id,
    draft.base_agent_release_id, draft.environment_key, tasteStyleId, releaseId,
    title, summary, ruleStatement, input.axis, taskSignature, JSON.stringify(contexts), hash, now, now,
  );
  return fromRow(getWorkflow(workflowId));
}

export function confirmTasteGeneralization(input: TasteGeneralizationConfirmInput): TasteChipWorkflowRecord {
  if (input.explicitConsent !== true) throw new Error("Explicit confirmation is required.");
  const row = revalidateWorkflow(getWorkflow(input.workflowId));
  if (jsonArray<string>(row.privacy_issue_codes_json).length > 0) {
    throw new Error("Taste proposal material changed or failed the privacy/generalization scan; review it again.");
  }
  if (input.generalizationHash !== row.generalization_hash) throw new Error("Taste proposal changed; review it again.");
  const issues = privacyIssues([row.title, row.summary, row.rule_statement, row.task_signature, ...jsonArray<string>(row.contexts_json)]);
  if (issues.length) throw new Error(`Generalized Taste text is not public-safe: ${issues.join(", ")}`);
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE taste_chip_workflows SET status = CASE WHEN status IN ('moderation-pending','ab-ready') THEN status ELSE 'confirmed' END,
       confirmed_at = COALESCE(confirmed_at, ?), privacy_issue_codes_json = '[]', remote_error_code = NULL, updated_at = ?
     WHERE workflow_id = ? AND generalization_hash = ?`,
  ).run(now, now, row.workflow_id, row.generalization_hash);
  return fromRow(getWorkflow(row.workflow_id));
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

export function prepareTastePreviews(input: TastePreviewPrepareInput): TasteChipWorkflowRecord {
  if (input.rightsAttested !== true || !RIGHTS.has(input.rightsStatus)) throw new Error("Explicit preview rights attestation is required.");
  if (input.externalGenerationAttested !== true) throw new Error("Explicit external generation attestation is required.");
  if (!/^sha256:[a-f0-9]{64}$/.test(input.canonicalTaskInputHash)) throw new Error("Canonical task input SHA-256 is required.");
  const generationCohortRef = cleanText(input.generationCohortRef, "generationCohortRef", 200);
  const row = revalidateWorkflow(getWorkflow(input.workflowId));
  if (jsonArray<string>(row.privacy_issue_codes_json).length > 0) {
    throw new Error("Taste proposal material changed or failed the privacy/generalization scan; review it again.");
  }
  if (!row.confirmed_at || row.status === "proposal") throw new Error("Confirm the generalized Taste proposal before selecting previews.");
  if (!Array.isArray(input.previews) || input.previews.length !== 2) throw new Error("Exactly two previews are required.");
  const previews = input.previews.map(previewMetadata) as ReturnType<typeof previewMetadata>[];
  if (previews[0].digest === previews[1].digest) throw new Error("A/B previews must be two different images.");
  const material = {
    schemaVersion: "agentlas.taste-style-release.v1",
    kind: "agentlas-taste-style-release",
    tasteStyleId: row.taste_style_id,
    releaseId: row.release_id,
    version: "0.1.0",
    title: row.title,
    summary: row.summary,
    baseCompatibility: { agentDefinitionId: row.base_agent_definition_id, compatibleBaseReleaseIds: [row.base_agent_release_id] },
    taskSignatures: [row.task_signature],
    preferenceAxes: [row.axis],
    rules: [{
      ruleId: stableId("tsr_rule", `${row.release_id}\0${row.axis}`),
      axis: row.axis,
      polarity: "prefer",
      statement: row.rule_statement,
      contexts: jsonArray<string>(row.contexts_json),
      confidence: row.axis ? 0.65 : 0.5,
    }],
    audienceTags: [],
  };
  const materialHash = canonicalHash(material);
  const generationCohortHash = /^sha256:[a-f0-9]{64}$/.test(generationCohortRef)
    ? generationCohortRef
    : `sha256:${sha256(`agentlas-taste-generation-cohort-v1\0${generationCohortRef}`)}`;
  const provenance: [TastePreviewTreatmentProvenance, TastePreviewTreatmentProvenance] = [
    {
      role: "chip-on",
      canonicalTaskInputHash: input.canonicalTaskInputHash,
      generationCohortHash,
      baseAgentDefinitionId: row.base_agent_definition_id,
      baseAgentReleaseId: row.base_agent_release_id,
      tasteStyleReleaseId: row.release_id,
      tasteMaterialHash: materialHash,
      noTasteOverlay: false,
      evidenceLevel: "owner-attested-external",
      ownerAttested: true,
    },
    {
      role: "control",
      canonicalTaskInputHash: input.canonicalTaskInputHash,
      generationCohortHash,
      baseAgentDefinitionId: row.base_agent_definition_id,
      baseAgentReleaseId: row.base_agent_release_id,
      tasteStyleReleaseId: row.release_id,
      tasteMaterialHash: null,
      noTasteOverlay: true,
      evidenceLevel: "owner-attested-external",
      ownerAttested: true,
    },
  ];
  const now = new Date().toISOString();
  getDb().prepare(
    `UPDATE taste_chip_workflows SET preview_grants_json = ?, preview_names_json = ?, preview_digests_json = ?, preview_provenance_json = ?, preview_rights = ?,
       remote_preview_asset_ids_json = NULL, status = 'confirmed', remote_error_code = NULL, updated_at = ?
     WHERE workflow_id = ?`,
  ).run(
    JSON.stringify(previews.map((item) => item.grant)),
    JSON.stringify(previews.map((item) => item.name)),
    JSON.stringify(previews.map((item) => item.digest)),
    JSON.stringify(provenance),
    input.rightsStatus,
    now,
    row.workflow_id,
  );
  return fromRow(getWorkflow(row.workflow_id));
}

function baseUrl(value: string, injected: boolean): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/") ||
      (!(url.protocol === "https:" && OFFICIAL_HOSTS.has(url.hostname.toLowerCase())) && !(injected && loopback && url.protocol === "http:"))) {
    throw new Error("Taste Hub origin is not approved.");
  }
  return `${url.protocol}//${url.host}`;
}

function normalizeCanonical(value: unknown, excluded: Set<string>, root = false): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeCanonical(item, excluded));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key, child]) => (!root || !excluded.has(key)) && child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, normalizeCanonical(child, excluded)]));
}

function canonicalHash(value: unknown, excluded: string[] = []): string {
  return `sha256:${sha256(JSON.stringify(normalizeCanonical(value, new Set(excluded), true)))}`;
}

function ownerRef(actor: { workspaceId: string; userId: string }): string {
  return `owner:${sha256(`agentlas-ontology-owner-v1\0${actor.workspaceId}\0${actor.userId}`).slice(0, 40)}`;
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

export async function uploadTasteDraft(input: TasteHubUploadInput, deps: TasteHubDependencies = {}): Promise<TasteChipWorkflowRecord> {
  if (input.explicitUpload !== true) throw new Error("Explicit Taste upload is required.");
  const row = revalidateWorkflow(getWorkflow(input.workflowId));
  if (jsonArray<string>(row.privacy_issue_codes_json).length > 0) {
    throw new Error("Taste proposal material changed or failed the privacy/generalization scan; upload is blocked.");
  }
  if (!row.confirmed_at || input.generalizationHash !== row.generalization_hash) throw new Error("Confirm the current generalized Taste proposal before upload.");
  const grants = pair<TastePreviewGrant>(row.preview_grants_json);
  if (!grants || !row.preview_rights) throw new Error("Exactly two rights-attested previews are required.");
  const previews = grants.map(previewMetadata) as ReturnType<typeof previewMetadata>[];
  if (previews[0].digest === previews[1].digest) throw new Error("A/B previews must be different.");
  const preparedDigests = pair<string>(row.preview_digests_json);
  if (!preparedDigests || previews.some((preview, index) => preview.digest !== preparedDigests[index])) {
    throw new Error("A selected preview changed after preparation; review the two files again.");
  }
  const provenance = pair<TastePreviewTreatmentProvenance>(row.preview_provenance_json);
  if (!provenance || provenance[0].role !== "chip-on" || provenance[1].role !== "control" ||
      provenance.some((item) => item.evidenceLevel !== "owner-attested-external" || item.ownerAttested !== true) ||
      provenance[0].canonicalTaskInputHash !== provenance[1].canonicalTaskInputHash ||
      provenance[0].generationCohortHash !== provenance[1].generationCohortHash) {
    throw new Error("Prepare one chip-on and one control preview with matching hashed generation provenance.");
  }
  const cookie = deps.cookieHeader ?? getSessionCookieHeader();
  const actor = deps.actor ?? getAuthenticatedActorIds();
  if (!cookie || !actor) throw new Error("Sign in to Agentlas Hub before uploading a Taste draft.");
  const fetcher = deps.fetch ?? globalThis.fetch;
  const origin = baseUrl(deps.baseUrl ?? process.env.AGENTLAS_WEB_BASE_URL ?? "https://agentlas.cloud", Boolean(deps.fetch));
  const confidence = row.axis ? 0.65 : 0.5;
  const rule = {
    ruleId: stableId("tsr_rule", `${row.release_id}\0${row.axis}`), axis: row.axis,
    polarity: "prefer" as const, statement: row.rule_statement,
    contexts: jsonArray<string>(row.contexts_json), confidence,
  };
  const draft = {
    schemaVersion: "agentlas.taste-style-release.v1" as const,
    kind: "agentlas-taste-style-release" as const,
    tasteStyleId: row.taste_style_id,
    releaseId: row.release_id,
    ownerRef: ownerRef(actor),
    version: "0.1.0",
    title: row.title,
    summary: row.summary,
    baseCompatibility: { agentDefinitionId: row.base_agent_definition_id, compatibleBaseReleaseIds: [row.base_agent_release_id] },
    taskSignatures: [row.task_signature], preferenceAxes: [row.axis], rules: [rule],
    pairwiseEvidenceReceiptIds: [], previewAssetRefs: [], audienceTags: [],
    aggregate: { sampleCount: 0, distinctRaterCount: 0, ruleAlignedCount: 0, alternativeCount: 0, tieCount: 0, skipCount: 0, disagreement: 0 },
    privacy: { rawRaterIdentityIncluded: false, rawLocalPathsIncluded: false, rawOutputsIncluded: false, credentialValuesIncluded: false, privateAssetBytesIncluded: false },
    contentHash: "sha256:" + "0".repeat(64), visibility: "private" as const, status: "draft" as const,
    createdAt: row.created_at,
  };
  const release = { ...draft, contentHash: canonicalHash(draft, ["contentHash"]) };
  try {
    const list = await responseJson(await fetcher(`${origin}/api/ontology/v1/taste-style-releases`, { headers: { cookie } }));
    const existing = (Array.isArray(list.releases) ? list.releases : []).map(record)
      .find((item) => record(item.release).releaseId === row.release_id);
    let revision = typeof existing?.revision === "string" ? existing.revision : null;
    const existingRelease = record(existing?.release);
    if (existing) {
      const withoutPreviews = { ...existingRelease, previewAssetRefs: [], contentHash: "sha256:" + "0".repeat(64) };
      const baseContentHash = canonicalHash(withoutPreviews, ["contentHash"]);
      if (baseContentHash !== release.contentHash) {
        throw Object.assign(new Error("The remote Taste draft conflicts with this local generalization."), { code: "remote_release_conflict" });
      }
    }
    if (!existing) {
      const created = await responseJson(await fetcher(`${origin}/api/ontology/v1/taste-style-releases`, {
        method: "POST", headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ release, precondition: { kind: "create" } }),
      }));
      revision = typeof record(created.record).revision === "string" ? String(record(created.record).revision) : null;
    }
    let assetIds = pair<string>(row.remote_preview_asset_ids_json);
    if (!assetIds) {
      const uploaded = await Promise.all(previews.map((preview) => uploadPreview(fetcher, origin, cookie, preview, row.preview_rights!)));
      const ids = uploaded.map((item) => String(record(item.asset).assetId ?? ""));
      if (ids.length !== 2 || ids.some((id) => !SAFE_REF_RE.test(id)) || ids[0] === ids[1]) throw new Error("Taste Hub did not return two distinct preview assets.");
      assetIds = [ids[0], ids[1]];
      getDb().prepare("UPDATE taste_chip_workflows SET remote_preview_asset_ids_json = ?, remote_revision = ?, updated_at = ? WHERE workflow_id = ?")
        .run(JSON.stringify(assetIds), revision, new Date().toISOString(), row.workflow_id);
    }
    const assetsPayload = await responseJson(await fetcher(`${origin}/api/ontology/v1/taste-preview-assets`, { headers: { cookie } }));
    const assets = Array.isArray(assetsPayload.assets) ? assetsPayload.assets.map(record) : [];
    const selected = assetIds.map((id) => assets.find((asset) => asset.assetId === id));
    const allPassed = selected.every((asset) => asset?.moderationState === "passed" && asset.storageState === "active");
    let status: TasteChipWorkflowRecord["status"] = "moderation-pending";
    if (allPassed) {
      const latestList = await responseJson(await fetcher(`${origin}/api/ontology/v1/taste-style-releases`, { headers: { cookie } }));
      const current = (Array.isArray(latestList.releases) ? latestList.releases : []).map(record)
        .find((item) => record(item.release).releaseId === row.release_id);
      const currentRefs = Array.isArray(record(current?.release).previewAssetRefs) ? record(current?.release).previewAssetRefs as unknown[] : [];
      revision = typeof current?.revision === "string" ? current.revision : revision;
      const currentTreatments = currentRefs.map((value) => record(record(value).treatment));
      const exactTreatmentReady = currentRefs.length === 2 && currentTreatments[0].role === "chip-on" && currentTreatments[1].role === "control";
      if (!exactTreatmentReady) {
        if (!revision) throw new Error("Taste Hub draft revision is unavailable.");
        const selectedResult = await responseJson(await fetcher(
          `${origin}/api/ontology/v1/taste-style-releases/${encodeURIComponent(row.release_id)}/preview-selection`,
          {
            method: "PUT",
            headers: { cookie, "content-type": "application/json" },
            body: JSON.stringify({
              revision,
              comparisons: assetIds.map((assetId, index) => ({ assetId, ...provenance[index] })),
            }),
          },
        ));
        revision = typeof record(selectedResult.record).revision === "string" ? String(record(selectedResult.record).revision) : revision;
      }
      status = "ab-ready";
    }
    const now = new Date().toISOString();
    getDb().prepare(
      "UPDATE taste_chip_workflows SET status = ?, remote_revision = ?, remote_error_code = NULL, updated_at = ? WHERE workflow_id = ?",
    ).run(status, revision, now, row.workflow_id);
    return fromRow(getWorkflow(row.workflow_id));
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "taste_hub_error";
    getDb().prepare("UPDATE taste_chip_workflows SET status = 'error', remote_error_code = ?, updated_at = ? WHERE workflow_id = ?")
      .run(code.slice(0, 96), new Date().toISOString(), row.workflow_id);
    throw error;
  }
}
