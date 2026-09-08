import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ExperienceBaseReleaseResolution,
  ExperienceCloudExportResult,
  ExperienceCloudLocalState,
  ExperienceCloudSaveInput,
  ExperienceCloudServerStatus,
  ExperienceCloudUploadReceipt,
  ExperienceCloudUploadRecord,
  ExperienceCloudWithdrawInput,
  PortableExperienceBundle,
  PortableExperienceVisibility,
} from "../../shared/types";
import { getSessionCookieHeader } from "../auth";
import { readCloudAgentRestoreMarker } from "../cloud-agents/restore";
import { getAgentById } from "../mcp/registry";
import { getDb } from "../store/db";
import {
  materializePortableExperienceBundle,
  portableExperienceBundleHashPayload,
  portableExperienceCanonicalJson,
  validatePortableExperienceBundle,
} from "./portable";

const BASE_RESOLUTION_SCHEMA = "agentlas.experience-base-resolution.v1" as const;
const UPLOAD_RECEIPT_SCHEMA = "agentlas.experience-upload-receipt.v1" as const;
const HASH_RE = /^sha256:[0-9a-f]{64}$/;
const RAW_HASH_RE = /^[0-9a-f]{64}$/;
const SAFE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{2,255}$/;
const SAFE_ERROR_CODE_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const UPLOAD_ID_RE = /^exu_[0-9a-f]{48}$/;
const BUNDLE_ID_RE = /^exb_[0-9a-f]{48}$/;
const REVISION_RE = /^rev_[0-9a-f]{32}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,95}$/;
const PACKAGE_HASH_VERSIONS = new Set(["path-sha256-v1", "path-sha256-executable-v2"]);
const RFC3339_DATE_TIME = z.string().datetime({ offset: true });
const OFFICIAL_EXPERIENCE_CLOUD_HOSTS = new Set([
  "agentlas.cloud",
  "www.agentlas.cloud",
  "api.agentlas.cloud",
  "staging.agentlas.cloud",
]);
const SERVER_STATUSES = new Set<ExperienceCloudServerStatus>([
  "draft-saved",
  "verification-requested",
  "verification-pending",
  "verified-private",
  "public-active",
  "conflict",
  "withdrawn",
  "rejected",
]);
const MAX_JSON_RESPONSE_BYTES = 4 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type CloudPackRow = {
  id: string;
  agent_id: string;
  base_package_hash: string | null;
  base_agent_definition_id: string | null;
  base_agent_release_id: string | null;
  base_package_hash_version: string | null;
  status: "active" | "archived";
};

type CloudUploadRow = {
  id: string;
  pack_id: string;
  requested_visibility: "private" | "public";
  bundle_id: string;
  bundle_hash: string;
  canonical_bundle_json: string;
  idempotency_key: string;
  remote_upload_id: string | null;
  remote_revision: string | null;
  remote_status: ExperienceCloudLocalState;
  remote_error_code: string | null;
  remote_error_message: string | null;
  remote_receipt_json: string | null;
  attempt_count: number;
  created_at: string;
  updated_at: string;
};

export interface ExperienceCloudDependencies {
  fetch?: FetchLike;
  cookieHeader?: string;
  baseUrl?: string;
  now?: () => Date;
}

export class ExperienceCloudHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly currentReceipt: ExperienceCloudUploadReceipt | null = null,
  ) {
    super(message);
    this.name = "ExperienceCloudHttpError";
  }
}

export class ExperienceCloudTransportError extends Error {
  constructor(readonly code: "network_unavailable" | "request_timeout") {
    super(code === "request_timeout" ? "Experience Cloud request timed out." : "Experience Cloud network is unavailable.");
    this.name = "ExperienceCloudTransportError";
  }
}

function safeBaseUrl(value: string, allowLoopback = false): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  const official = url.protocol === "https:" && OFFICIAL_EXPERIENCE_CLOUD_HOSTS.has(url.hostname.toLowerCase());
  if (
    (!official && !(allowLoopback && loopback && url.protocol === "http:")) ||
    url.username || url.password || url.port && !loopback ||
    (url.pathname !== "" && url.pathname !== "/") || url.search || url.hash
  ) {
    throw new Error("Agentlas Experience Cloud origin is not an approved official or injected loopback endpoint.");
  }
  return `${url.protocol}//${url.host}`;
}

function clientFromDependencies(deps: ExperienceCloudDependencies = {}): ExperienceCloudHttpClient {
  const cookie = deps.cookieHeader ?? getSessionCookieHeader();
  if (!cookie) throw new Error("Sign in to agentlas.cloud before saving an Experience.");
  if (!/^agentlas_session=[^;\r\n]{8,}$/.test(cookie)) throw new Error("Agentlas sign-in session is invalid.");
  return new ExperienceCloudHttpClient({
    baseUrl: deps.baseUrl ?? process.env.AGENTLAS_WEB_BASE_URL ?? "https://agentlas.cloud",
    cookieHeader: cookie,
    fetch: deps.fetch,
    allowLoopback: Boolean(deps.fetch) || process.env.AGENTLAS_E2E === "1" || process.env.NODE_ENV === "development",
  });
}

function normalizePackageHash(value: string): string {
  if (RAW_HASH_RE.test(value)) return value;
  if (HASH_RE.test(value)) return value.slice("sha256:".length);
  throw new Error("Experience base package hash is invalid.");
}

function safeRef(value: unknown, label: string): string {
  const clean = typeof value === "string" ? value.trim() : "";
  if (!SAFE_REF_RE.test(clean)) throw new Error(`${label} is invalid.`);
  return clean;
}

function iso(value: unknown, label: string): string {
  const parsed = RFC3339_DATE_TIME.safeParse(value);
  if (!parsed.success) throw new Error(`${label} is invalid.`);
  return parsed.data;
}

async function readResponseJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("Experience Cloud response is too large.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_RESPONSE_BYTES) {
    throw new Error("Experience Cloud response is too large.");
  }
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Experience Cloud returned malformed JSON.");
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function responseReceiptPayload(value: unknown): unknown {
  const outer = record(value);
  return outer.receipt && typeof outer.receipt === "object" ? outer.receipt : value;
}

export function validateExperienceBaseResolution(
  value: unknown,
  expected: { packageHash: string; packageHashVersion?: string; slug?: string; cloudId?: string },
): ExperienceBaseReleaseResolution {
  const json = record(value);
  const packageHash = normalizePackageHash(String(json.packageHash ?? ""));
  const expectedHash = normalizePackageHash(expected.packageHash);
  const result: ExperienceBaseReleaseResolution = {
    schema: json.schema === BASE_RESOLUTION_SCHEMA ? BASE_RESOLUTION_SCHEMA : (() => { throw new Error("Experience base resolution schema mismatch."); })(),
    agentDefinitionId: safeRef(json.agentDefinitionId, "agentDefinitionId"),
    agentReleaseId: safeRef(json.agentReleaseId, "agentReleaseId"),
    packageHash,
    packageHashVersion: String(json.packageHashVersion ?? ""),
    cloudId: safeRef(json.cloudId, "cloudId"),
    slug: String(json.slug ?? ""),
  };
  if (!PACKAGE_HASH_VERSIONS.has(result.packageHashVersion)) throw new Error("Experience base package hash version is invalid.");
  if (!SLUG_RE.test(result.slug)) throw new Error("Experience base Agent slug is invalid.");
  if (result.packageHash !== expectedHash) throw new Error("Experience base resolution returned the wrong package hash.");
  if (expected.packageHashVersion && result.packageHashVersion !== expected.packageHashVersion) {
    throw new Error("Experience base resolution returned the wrong package hash version.");
  }
  if (expected.slug && result.slug !== expected.slug) throw new Error("Experience base resolution returned the wrong Agent slug.");
  if (expected.cloudId && result.cloudId !== expected.cloudId) throw new Error("Experience base resolution returned the wrong Cloud id.");
  return result;
}

export function validateExperienceCloudReceipt(
  value: unknown,
  expected: {
    bundleId?: string;
    bundleHash?: string;
    experiencePackId?: string;
    experienceReleaseId?: string;
    requestedVisibility?: PortableExperienceVisibility;
    uploadId?: string;
    allowedStatuses?: ReadonlySet<ExperienceCloudServerStatus>;
  } = {},
): ExperienceCloudUploadReceipt {
  const json = record(responseReceiptPayload(value));
  const status = String(json.status ?? "") as ExperienceCloudServerStatus;
  if (json.schema !== UPLOAD_RECEIPT_SCHEMA) throw new Error("Experience upload receipt schema mismatch.");
  if (!SERVER_STATUSES.has(status)) throw new Error("Experience upload receipt status is invalid.");
  const bundleHash = String(json.bundleHash ?? "");
  const requestedVisibility = String(json.requestedVisibility ?? "") as PortableExperienceVisibility;
  if (!HASH_RE.test(bundleHash)) throw new Error("Experience upload receipt bundle hash is invalid.");
  if (!new Set(["private", "unlisted", "public"]).has(requestedVisibility)) {
    throw new Error("Experience upload receipt visibility is invalid.");
  }
  const receipt: ExperienceCloudUploadReceipt = {
    schema: UPLOAD_RECEIPT_SCHEMA,
    uploadId: safeRef(json.uploadId, "uploadId"),
    bundleId: safeRef(json.bundleId, "bundleId"),
    bundleHash,
    experiencePackId: safeRef(json.experiencePackId, "experiencePackId"),
    experienceReleaseId: safeRef(json.experienceReleaseId, "experienceReleaseId"),
    ownerWorkspaceRef: safeRef(json.ownerWorkspaceRef, "ownerWorkspaceRef"),
    status,
    requestedVisibility,
    revision: safeRef(json.revision, "revision"),
    createdAt: iso(json.createdAt, "receipt createdAt"),
    updatedAt: iso(json.updatedAt, "receipt updatedAt"),
    ...(typeof json.errorCode === "string" && SAFE_ERROR_CODE_RE.test(json.errorCode)
      ? { errorCode: json.errorCode }
      : {}),
  };
  if (!UPLOAD_ID_RE.test(receipt.uploadId)) throw new Error("Experience upload receipt upload id is invalid.");
  if (!BUNDLE_ID_RE.test(receipt.bundleId)) throw new Error("Experience upload receipt bundle id is invalid.");
  if (!REVISION_RE.test(receipt.revision)) throw new Error("Experience upload receipt revision is invalid.");
  if (expected.bundleId && receipt.bundleId !== expected.bundleId) throw new Error("Experience upload receipt bundle id mismatch.");
  if (expected.bundleHash && receipt.bundleHash !== expected.bundleHash) throw new Error("Experience upload receipt bundle hash mismatch.");
  if (expected.experiencePackId && receipt.experiencePackId !== expected.experiencePackId) {
    throw new Error("Experience upload receipt Pack id mismatch.");
  }
  if (expected.experienceReleaseId && receipt.experienceReleaseId !== expected.experienceReleaseId) {
    throw new Error("Experience upload receipt release id mismatch.");
  }
  if (expected.requestedVisibility && receipt.requestedVisibility !== expected.requestedVisibility) {
    throw new Error("Experience upload receipt visibility mismatch.");
  }
  if (expected.uploadId && receipt.uploadId !== expected.uploadId) throw new Error("Experience upload receipt id mismatch.");
  if (expected.allowedStatuses && !expected.allowedStatuses.has(receipt.status)) {
    throw new Error("Experience upload receipt lifecycle transition is not legal for this request.");
  }
  return receipt;
}

function legalStatuses(visibility: PortableExperienceVisibility, initial: boolean): ReadonlySet<ExperienceCloudServerStatus> {
  if (initial) {
    return new Set(visibility === "private" ? ["draft-saved"] : ["verification-requested"]);
  }
  return new Set(visibility === "private"
    ? ["draft-saved", "conflict", "withdrawn", "rejected"]
    : ["verification-requested", "verification-pending", "verified-private", "public-active", "conflict", "withdrawn", "rejected"]);
}

function assertEtag(response: Response, receipt: ExperienceCloudUploadReceipt): void {
  if (response.headers.get("etag") !== `"${receipt.revision}"`) {
    throw new Error("Experience Cloud ETag does not match its revision receipt.");
  }
}

async function errorFromResponse(response: Response): Promise<ExperienceCloudHttpError> {
  let value: unknown = {};
  try { value = await readResponseJson(response); } catch { value = {}; }
  const json = record(value);
  const codeValue = typeof json.errorCode === "string"
    ? json.errorCode
    : typeof json.code === "string"
      ? json.code
      : typeof json.error === "string"
        ? json.error
        : "http_error";
  const code = SAFE_ERROR_CODE_RE.test(codeValue) ? codeValue : "http_error";
  let current: ExperienceCloudUploadReceipt | null = null;
  if (response.status === 412 && (json.receipt || json.schema === UPLOAD_RECEIPT_SCHEMA)) {
    try {
      current = validateExperienceCloudReceipt(value);
      assertEtag(response, current);
    } catch {
      current = null;
    }
  }
  return new ExperienceCloudHttpError(response.status, code, `Experience Cloud request failed (${response.status}:${code}).`, current);
}

export class ExperienceCloudHttpClient {
  private readonly baseUrl: string;
  private readonly cookieHeader: string;
  private readonly fetchImpl: FetchLike;

  constructor(input: { baseUrl: string; cookieHeader: string; fetch?: FetchLike; allowLoopback?: boolean }) {
    this.baseUrl = safeBaseUrl(input.baseUrl, input.allowLoopback === true);
    this.cookieHeader = input.cookieHeader;
    this.fetchImpl = input.fetch ?? globalThis.fetch.bind(globalThis);
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      try {
        return await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          ...init,
          redirect: "error",
          signal: controller.signal,
          headers: {
            accept: "application/json",
            cookie: this.cookieHeader,
            origin: new URL(this.baseUrl).origin,
            ...(init.body ? { "content-type": "application/json" } : {}),
            ...(init.headers ?? {}),
          },
        });
      } catch (error) {
        const timedOut = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
        throw new ExperienceCloudTransportError(timedOut ? "request_timeout" : "network_unavailable");
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /** Read-only canonical identities; package ownership and hash authority still
   * come from the owner shelf and resolveBase, respectively. */
  async listAgentDefinitionIdentities(): Promise<Array<{
    id: string;
    slug: string;
    entityKind: "agent" | "team";
    currentReleaseId: string;
    state: string;
  }>> {
    const response = await this.request("/api/experience/v1/agent-definitions", { method: "GET" });
    if (!response.ok) throw await errorFromResponse(response);
    const json = record(await readResponseJson(response));
    if (!Array.isArray(json.definitions)) throw new Error("Cloud definition inventory schema mismatch.");
    return json.definitions.map((value) => {
      const row = record(value);
      if (row.entityKind !== "agent" && row.entityKind !== "team") {
        throw new Error("Cloud definition entity kind is invalid.");
      }
      return {
        id: safeRef(row.id, "agentDefinitionId"),
        slug: String(row.slug ?? ""),
        entityKind: row.entityKind,
        currentReleaseId: typeof row.currentReleaseId === "string" ? row.currentReleaseId : "",
        state: String(row.state ?? ""),
      };
    });
  }

  async resolveBase(input: {
    slug?: string;
    cloudId?: string;
    packageHash: string;
    packageHashVersion?: string;
  }): Promise<ExperienceBaseReleaseResolution> {
    const response = await this.request("/api/experience/v1/base-releases/resolve", {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!response.ok) throw await errorFromResponse(response);
    return validateExperienceBaseResolution(await readResponseJson(response), input);
  }

  async upload(
    bundle: PortableExperienceBundle,
    idempotencyKey: string,
  ): Promise<ExperienceCloudUploadReceipt> {
    const response = await this.request("/api/experience/v1/uploads", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        // A same-key replay is still create-only safe on the server. Keeping the
        // precondition fixes the case where the first POST never reached it.
        "If-None-Match": "*",
      },
      body: JSON.stringify({ bundle }),
    });
    if (!response.ok) throw await errorFromResponse(response);
    const receipt = validateExperienceCloudReceipt(await readResponseJson(response), {
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      experiencePackId: bundle.pack.experiencePackId,
      experienceReleaseId: bundle.pack.releaseId,
      requestedVisibility: bundle.requestedVisibility,
      allowedStatuses: legalStatuses(bundle.requestedVisibility, true),
    });
    assertEtag(response, receipt);
    return receipt;
  }

  async findUpload(bundle: PortableExperienceBundle, idempotencyKey: string): Promise<ExperienceCloudUploadReceipt | null> {
    const response = await this.request(`/api/experience/v1/uploads?bundleId=${encodeURIComponent(bundle.bundleId)}`, {
      method: "GET",
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw await errorFromResponse(response);
    const receipt = validateExperienceCloudReceipt(await readResponseJson(response), {
      bundleId: bundle.bundleId,
      bundleHash: bundle.bundleHash,
      experiencePackId: bundle.pack.experiencePackId,
      experienceReleaseId: bundle.pack.releaseId,
      requestedVisibility: bundle.requestedVisibility,
      allowedStatuses: legalStatuses(bundle.requestedVisibility, false),
    });
    assertEtag(response, receipt);
    return receipt;
  }

  async getUpload(uploadId: string, expected: PortableExperienceBundle): Promise<ExperienceCloudUploadReceipt> {
    const response = await this.request(`/api/experience/v1/uploads/${encodeURIComponent(safeRef(uploadId, "uploadId"))}`, { method: "GET" });
    if (!response.ok) throw await errorFromResponse(response);
    const receipt = validateExperienceCloudReceipt(await readResponseJson(response), {
      uploadId,
      bundleId: expected.bundleId,
      bundleHash: expected.bundleHash,
      experiencePackId: expected.pack.experiencePackId,
      experienceReleaseId: expected.pack.releaseId,
      requestedVisibility: expected.requestedVisibility,
      allowedStatuses: legalStatuses(expected.requestedVisibility, false),
    });
    assertEtag(response, receipt);
    return receipt;
  }

  async exportUpload(uploadId: string, expected: PortableExperienceBundle): Promise<ExperienceCloudExportResult> {
    const response = await this.request(`/api/experience/v1/uploads/${encodeURIComponent(safeRef(uploadId, "uploadId"))}/export`, { method: "GET" });
    if (!response.ok) throw await errorFromResponse(response);
    const json = record(await readResponseJson(response));
    const bundle = validatePortableExperienceBundle(json.bundle as PortableExperienceBundle);
    const receipt = validateExperienceCloudReceipt(json.receipt, {
      uploadId,
      bundleId: expected.bundleId,
      bundleHash: expected.bundleHash,
      experiencePackId: expected.pack.experiencePackId,
      experienceReleaseId: expected.pack.releaseId,
      requestedVisibility: expected.requestedVisibility,
      allowedStatuses: legalStatuses(expected.requestedVisibility, false),
    });
    if (bundle.pack.ownerRef !== receipt.ownerWorkspaceRef) {
      throw new Error("Experience Cloud export owner does not match the authenticated receipt owner.");
    }
    // The server replaces the submitted ownerRef and may advance lifecycle
    // presentation fields without changing immutable Experience content.
    // Compare the exact identity payload, not byte equality of the envelope.
    if (
      bundle.bundleHash !== expected.bundleHash ||
      portableExperienceCanonicalJson(portableExperienceBundleHashPayload(bundle)) !==
        portableExperienceCanonicalJson(portableExperienceBundleHashPayload(expected))
    ) {
      throw new Error("Experience Cloud export does not match the canonical local Experience content.");
    }
    assertEtag(response, receipt);
    return { bundle, receipt };
  }

  async withdraw(uploadId: string, revision: string, expected: PortableExperienceBundle): Promise<ExperienceCloudUploadReceipt> {
    const response = await this.request(`/api/experience/v1/uploads/${encodeURIComponent(safeRef(uploadId, "uploadId"))}`, {
      method: "DELETE",
      headers: { "If-Match": `"${safeRef(revision, "revision")}"` },
    });
    if (!response.ok) throw await errorFromResponse(response);
    const receipt = validateExperienceCloudReceipt(await readResponseJson(response), {
      uploadId,
      bundleId: expected.bundleId,
      bundleHash: expected.bundleHash,
      experiencePackId: expected.pack.experiencePackId,
      experienceReleaseId: expected.pack.releaseId,
      requestedVisibility: expected.requestedVisibility,
      allowedStatuses: new Set(["withdrawn"]),
    });
    if (receipt.status !== "withdrawn") throw new Error("Experience Cloud withdraw did not return withdrawn status.");
    assertEtag(response, receipt);
    return receipt;
  }
}

function getPack(packId: string): CloudPackRow {
  const row = getDb().prepare("SELECT * FROM experience_packs WHERE id = ?").get(packId) as CloudPackRow | undefined;
  if (!row) throw new Error("Experience Pack not found.");
  if (row.status !== "active") throw new Error("Archived Experience Packs cannot be uploaded.");
  return row;
}

function packageIdentity(pack: CloudPackRow): {
  slug: string;
  cloudId?: string;
  packageHash: string;
  packageHashVersion: string;
} {
  const agent = getAgentById(pack.agent_id);
  if (!agent) throw new Error("Experience Pack has no installed agent.");
  // 팩 자신이 기준을 안 갖고 있는 것은 데이터 결손이라 여전히 막는다 (판 불일치와는 다르다).
  if (!pack.base_package_hash) throw new Error("Experience Pack has no recorded base package.");
  // 위 내보내기와 같은 이유로 막지 않는다. 서버가 판을 확정해 되쓰는 경로이므로
  // 지금 설치본과 팩의 기준이 달라도 해석 자체는 성립한다.
  if (agent.packageHash !== pack.base_package_hash) {
    console.log(`[experience] resolving cloud base for pack ${pack.id} measured on an older build`);
  }
  const marker = agent.localPath ? readCloudAgentRestoreMarker(agent.localPath) : null;
  const registration = marker?.registrations?.["owner-private"] ?? marker?.registrations?.["hub-public"];
  // A legacy local import can keep an install-only slug (for example a
  // collision suffix) after the exact package is registered in Agent Cloud.
  // Once a signed Cloud registration exists, its slug and cloudId are the
  // authoritative pair. Mixing the old local slug with the new cloudId makes
  // the server correctly reject Experience binding as a reference mismatch.
  const registeredSlug = registration?.slug?.trim();
  return {
    slug: registeredSlug || agent.slug,
    ...(registration?.cloudId ? { cloudId: registration.cloudId } : {}),
    packageHash: pack.base_package_hash,
    packageHashVersion: pack.base_package_hash_version ?? marker?.packageHashVersion ?? "path-sha256-executable-v2",
  };
}

function storeBaseResolution(packId: string, resolved: ExperienceBaseReleaseResolution): void {
  getDb().prepare(
    `UPDATE experience_packs
        SET base_agent_definition_id = ?, base_agent_release_id = ?,
            base_package_hash_version = ?, updated_at = updated_at
      WHERE id = ?`,
  ).run(resolved.agentDefinitionId, resolved.agentReleaseId, resolved.packageHashVersion, packId);
}

function idempotencyKey(bundle: PortableExperienceBundle): string {
  const digest = createHash("sha256")
    .update("agentlas-experience-upload-idempotency-v1\0")
    .update(bundle.bundleHash)
    .update("\0")
    .update(bundle.requestedVisibility)
    .digest("hex");
  return `exu:${bundle.requestedVisibility}:${digest}`;
}

function uploadFromRow(row: CloudUploadRow): ExperienceCloudUploadRecord {
  const bundle = validatePortableExperienceBundle(JSON.parse(row.canonical_bundle_json) as PortableExperienceBundle);
  if (portableExperienceCanonicalJson(bundle) !== row.canonical_bundle_json) {
    throw new Error("Stored Experience Cloud bundle is not canonical.");
  }
  let receipt: ExperienceCloudUploadReceipt | null = null;
  if (row.remote_receipt_json) {
    receipt = validateExperienceCloudReceipt(JSON.parse(row.remote_receipt_json), {
      bundleId: row.bundle_id,
      bundleHash: row.bundle_hash,
      experiencePackId: bundle.pack.experiencePackId,
      experienceReleaseId: bundle.pack.releaseId,
      requestedVisibility: row.requested_visibility,
      allowedStatuses: legalStatuses(row.requested_visibility, false),
      ...(row.remote_upload_id ? { uploadId: row.remote_upload_id } : {}),
    });
  }
  return {
    id: row.id,
    packId: row.pack_id,
    requestedVisibility: row.requested_visibility,
    bundleId: row.bundle_id,
    bundleHash: row.bundle_hash,
    bundle,
    idempotencyKey: row.idempotency_key,
    remoteUploadId: row.remote_upload_id,
    remoteRevision: row.remote_revision,
    state: row.remote_status,
    errorCode: row.remote_error_code,
    errorMessage: row.remote_error_message,
    receipt,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getUploadRow(localId: string): CloudUploadRow {
  const row = getDb().prepare("SELECT * FROM experience_cloud_uploads WHERE id = ?").get(localId) as CloudUploadRow | undefined;
  if (!row) throw new Error("Local Experience Cloud upload was not found.");
  return row;
}

function ensureUploadRecord(packId: string, bundle: PortableExperienceBundle, now: string): CloudUploadRow {
  const key = idempotencyKey(bundle);
  const existing = getDb().prepare(
    `SELECT * FROM experience_cloud_uploads
      WHERE pack_id = ? AND bundle_hash = ? AND requested_visibility = ?`,
  ).get(packId, bundle.bundleHash, bundle.requestedVisibility) as CloudUploadRow | undefined;
  const canonical = portableExperienceCanonicalJson(bundle);
  if (existing) {
    if (existing.bundle_id !== bundle.bundleId || existing.idempotency_key !== key || existing.canonical_bundle_json !== canonical) {
      throw new Error("Existing Experience upload identity conflicts with the canonical bundle.");
    }
    return existing;
  }
  if (bundle.requestedVisibility === "public") {
    const privateDraft = getDb().prepare(
      `SELECT * FROM experience_cloud_uploads
        WHERE pack_id = ? AND bundle_hash = ? AND requested_visibility = 'private'
        ORDER BY rowid DESC LIMIT 1`,
    ).get(packId, bundle.bundleHash) as CloudUploadRow | undefined;
    if (privateDraft) {
      getDb().prepare(
        `UPDATE experience_cloud_uploads
            SET requested_visibility = 'public', canonical_bundle_json = ?,
                idempotency_key = ?, remote_status = 'local-ready',
                remote_error_code = NULL, remote_error_message = NULL,
                remote_receipt_json = NULL,
                updated_at = ?
          WHERE id = ?`,
      ).run(canonical, key, now, privateDraft.id);
      return getUploadRow(privateDraft.id);
    }
  } else {
    const publicRequest = getDb().prepare(
      `SELECT 1 FROM experience_cloud_uploads
        WHERE pack_id = ? AND bundle_hash = ? AND requested_visibility = 'public'
        LIMIT 1`,
    ).get(packId, bundle.bundleHash);
    if (publicRequest) throw new Error("A public verification request cannot be downgraded to a new private upload.");
  }
  const id = randomUUID();
  getDb().prepare(
    `INSERT INTO experience_cloud_uploads (
       id, pack_id, requested_visibility, bundle_id, bundle_hash,
       canonical_bundle_json, idempotency_key, remote_status,
       attempt_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'local-ready', 0, ?, ?)`,
  ).run(id, packId, bundle.requestedVisibility, bundle.bundleId, bundle.bundleHash, canonical, key, now, now);
  return getUploadRow(id);
}

function localStateForServer(receipt: ExperienceCloudUploadReceipt): ExperienceCloudLocalState {
  const mapping: Record<ExperienceCloudServerStatus, ExperienceCloudLocalState> = {
    "draft-saved": "private-saved",
    "verification-requested": "verification-requested",
    "verification-pending": "verification-pending",
    "verified-private": "verified-private",
    "public-active": "public-active",
    conflict: "conflict",
    withdrawn: "withdrawn",
    rejected: "rejected",
  };
  return mapping[receipt.status];
}

function persistReceipt(localId: string, receipt: ExperienceCloudUploadReceipt, now: string): ExperienceCloudUploadRecord {
  getDb().prepare(
    `UPDATE experience_cloud_uploads
        SET remote_upload_id = ?, remote_revision = ?, remote_status = ?,
            remote_error_code = ?, remote_error_message = NULL,
            remote_receipt_json = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    receipt.uploadId,
    receipt.revision,
    localStateForServer(receipt),
    receipt.errorCode ?? null,
    portableExperienceCanonicalJson(receipt),
    now,
    localId,
  );
  return uploadFromRow(getUploadRow(localId));
}

function persistFailure(
  localId: string,
  state: "offline" | "conflict" | "error",
  code: string,
  message: string,
  now: string,
): ExperienceCloudUploadRecord {
  const safeCode = SAFE_ERROR_CODE_RE.test(code) ? code : "request_failed";
  const safeMessage = message.slice(0, 240).replace(/[\r\n]+/g, " ");
  getDb().prepare(
    `UPDATE experience_cloud_uploads
        SET remote_status = ?, remote_error_code = ?, remote_error_message = ?, updated_at = ?
      WHERE id = ?`,
  ).run(state, safeCode, safeMessage, now, localId);
  return uploadFromRow(getUploadRow(localId));
}

function isOfflineError(error: unknown): boolean {
  return error instanceof ExperienceCloudTransportError || (error instanceof ExperienceCloudHttpError && error.status >= 500);
}

function failureCode(error: unknown): string {
  if (error instanceof ExperienceCloudHttpError || error instanceof ExperienceCloudTransportError) return error.code;
  return "invalid_server_response";
}

async function tryLostResponseRecovery(
  client: ExperienceCloudHttpClient,
  row: CloudUploadRow,
  bundle: PortableExperienceBundle,
): Promise<ExperienceCloudUploadReceipt | null> {
  try {
    return await client.findUpload(bundle, row.idempotency_key);
  } catch {
    return null;
  }
}

export function listExperienceCloudUploads(packId: string): ExperienceCloudUploadRecord[] {
  getPack(packId);
  return (getDb().prepare(
    "SELECT * FROM experience_cloud_uploads WHERE pack_id = ? ORDER BY updated_at DESC, rowid DESC",
  ).all(packId) as CloudUploadRow[]).map(uploadFromRow);
}

export async function saveExperienceToCloud(
  input: ExperienceCloudSaveInput,
  deps: ExperienceCloudDependencies = {},
): Promise<ExperienceCloudUploadRecord> {
  if (!input || typeof input !== "object" || !new Set(["private", "public"]).has(input.requestedVisibility)) {
    throw new Error("Experience Cloud save requires private or public requested visibility.");
  }
  const pack = getPack(input.packId);
  const identity = packageIdentity(pack);
  const client = clientFromDependencies(deps);
  const now = (deps.now?.() ?? new Date()).toISOString();

  let resolution: ExperienceBaseReleaseResolution;
  try {
    resolution = await client.resolveBase(identity);
    storeBaseResolution(pack.id, resolution);
  } catch (error) {
    // If this exact base was resolved before, retain it only to create a
    // recoverable offline row. It is never submitted without a fresh server
    // resolution in this call.
    if (pack.base_agent_definition_id && pack.base_agent_release_id && pack.base_package_hash_version) {
      const bundle = materializePortableExperienceBundle(pack.id, input.requestedVisibility);
      const row = ensureUploadRecord(pack.id, bundle, now);
      return persistFailure(row.id, isOfflineError(error) ? "offline" : "error", failureCode(error), "Base release could not be revalidated; nothing was uploaded.", now);
    }
    throw error;
  }

  const bundle = materializePortableExperienceBundle(pack.id, input.requestedVisibility);
  let row = ensureUploadRecord(pack.id, bundle, now);

  // A previous process may have committed remotely and crashed before saving
  // its response. Query by bundle + idempotency before any replay.
  if (row.attempt_count > 0 && !row.remote_upload_id) {
    const recovered = await tryLostResponseRecovery(client, row, bundle);
    if (recovered) return persistReceipt(row.id, recovered, now);
  }

  const pendingState = input.requestedVisibility === "public" ? "requesting-verification" : "saving-private";
  getDb().prepare(
    `UPDATE experience_cloud_uploads
        SET remote_status = ?, remote_error_code = NULL, remote_error_message = NULL,
            attempt_count = attempt_count + 1, updated_at = ?
      WHERE id = ?`,
  ).run(pendingState, now, row.id);
  row = getUploadRow(row.id);
  try {
    const receipt = await client.upload(bundle, row.idempotency_key);
    return persistReceipt(row.id, receipt, now);
  } catch (error) {
    const recovered = await tryLostResponseRecovery(client, row, bundle);
    if (recovered) return persistReceipt(row.id, recovered, now);
    if (error instanceof ExperienceCloudHttpError && error.currentReceipt) {
      persistReceipt(row.id, error.currentReceipt, now);
      return persistFailure(row.id, "conflict", "stale_revision", "Cloud state changed; reconcile before retrying.", now);
    }
    const state = error instanceof ExperienceCloudHttpError && (error.status === 409 || error.status === 412)
      ? "conflict"
      : isOfflineError(error)
        ? "offline"
        : "error";
    return persistFailure(
      row.id,
      state,
      failureCode(error),
      state === "offline" ? "Connection was unavailable; the same idempotent upload can be resumed." : "Experience Cloud rejected the request.",
      now,
    );
  }
}

export async function reconcileExperienceCloudUpload(
  localUploadId: string,
  deps: ExperienceCloudDependencies = {},
): Promise<ExperienceCloudUploadRecord> {
  const row = getUploadRow(localUploadId);
  const bundle = uploadFromRow(row).bundle;
  const client = clientFromDependencies(deps);
  const now = (deps.now?.() ?? new Date()).toISOString();
  try {
    const receipt = row.remote_upload_id
      ? await client.getUpload(row.remote_upload_id, bundle)
      : await client.findUpload(bundle, row.idempotency_key);
    if (!receipt) return persistFailure(row.id, "error", "remote_not_found", "No matching owner-scoped Cloud upload was found.", now);
    return persistReceipt(row.id, receipt, now);
  } catch (error) {
    return persistFailure(
      row.id,
      isOfflineError(error) ? "offline" : "error",
      failureCode(error),
      isOfflineError(error) ? "Connection was unavailable; local Experience remains intact." : "Cloud status could not be reconciled.",
      now,
    );
  }
}

export async function exportExperienceFromCloud(
  localUploadId: string,
  deps: ExperienceCloudDependencies = {},
): Promise<ExperienceCloudExportResult> {
  const row = getUploadRow(localUploadId);
  if (!row.remote_upload_id) throw new Error("Experience has not been saved to Cloud yet.");
  return clientFromDependencies(deps).exportUpload(row.remote_upload_id, uploadFromRow(row).bundle);
}

export async function withdrawExperienceFromCloud(
  input: ExperienceCloudWithdrawInput,
  deps: ExperienceCloudDependencies = {},
): Promise<ExperienceCloudUploadRecord> {
  const row = getUploadRow(input.localUploadId);
  if (!row.remote_upload_id || !row.remote_revision) throw new Error("Experience Cloud receipt is required before withdrawal.");
  const bundle = uploadFromRow(row).bundle;
  const now = (deps.now?.() ?? new Date()).toISOString();
  try {
    const receipt = await clientFromDependencies(deps).withdraw(row.remote_upload_id, row.remote_revision, bundle);
    return persistReceipt(row.id, receipt, now);
  } catch (error) {
    if (error instanceof ExperienceCloudHttpError && error.currentReceipt) {
      persistReceipt(row.id, error.currentReceipt, now);
      return persistFailure(row.id, "conflict", "stale_revision", "Cloud revision changed; reconcile and confirm withdrawal again.", now);
    }
    return persistFailure(
      row.id,
      isOfflineError(error) ? "offline" : "error",
      failureCode(error),
      isOfflineError(error) ? "Connection was unavailable; nothing was withdrawn." : "Experience withdrawal was rejected.",
      now,
    );
  }
}
