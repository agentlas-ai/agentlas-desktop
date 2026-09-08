// MCP source — agentlas.cloud/api/mcp/v1 HTTPS 호출.
// Node 20+ 글로벌 fetch. 인증 토큰은 옵션 (anonymous read-only).
//
// Desktop Hub는 공개 Hub 프로필 전체 목록을 우선 읽고, 실패 시에만 live MCP 검색을 보조로 사용한다.
// 응답 실패/타임아웃 시 하드코딩 카탈로그로 대체하지 않는다.
import type {
  AgentEnvRequirement,
  CloudAgentCombination,
  CloudAgentCombinationMemberRef,
  CloudAgentDeleteResult,
  CloudAgentPackageDownload,
  CloudAgentPackageDownloadFile,
  CloudAgentRevisionIdentity,
  FirmListing,
  MarketplaceListing,
  PluginAuthKind,
  PluginKind,
  TeamBundle,
} from "../../shared/types";
import type { MarketplaceSource, SeedListingFull } from "./source";
import { readCanonicalPromptFromPackageFiles } from "../agents/prompt-authority";

const PUBLIC_AGENT_CACHE_MS = 60_000;
/**
 * 소유자 Agent Cloud 선반 페이지 크기.
 *
 * 서버는 한 응답을 50건에서 자른다(SEARCH_RESULT_CAP). 그보다 큰 값을 보내도
 * 50건이 오므로 요청부터 50으로 맞추고, 나머지는 offset 으로 이어 받는다.
 */
const MY_CLOUD_PAGE_SIZE = 50;
/** 페이지 반복 상한 — 서버가 이상하게 굴어도 여기서 멈춘다(2,500행이면 충분하다). */
const MY_CLOUD_PAGE_BUDGET = 50;

/**
 * 선반이 그대로인지 한 번의 왕복으로 판정하기 위한 값.
 *
 * 서버에 컬렉션 ETag 가 없으므로 첫 페이지의 신원+리비전을 지문으로 쓴다. 행이
 * 추가·삭제되면 `total` 이 움직이고, 어떤 행이 갱신되면 revision 이 움직인다.
 */
export interface OwnerCloudShelfSnapshot {
  total: number;
  fingerprint: string;
  rows: MarketplaceListing[];
}

export class OwnerCloudShelfIncompleteError extends Error {
  readonly code = "project-cloud-catalog-incomplete";
  constructor(
    readonly listed: number,
    readonly total: number | null,
    readonly reason: "http_error" | "request_failed" | "pagination_incomplete",
    readonly httpStatus?: number,
  ) {
    super("project-cloud-catalog-incomplete");
    this.name = "OwnerCloudShelfIncompleteError";
  }
}

class McpSourceHttpError extends Error {
  constructor(method: string, readonly httpStatus: number) {
    super(`MCP ${method} ${httpStatus}`);
    this.name = "McpSourceHttpError";
  }
}

function throwIfOwnerReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Owner Cloud read cancelled", "AbortError");
}

function ownerReadRetryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfOwnerReadAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Owner Cloud read cancelled", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export interface OwnerCloudShelfResult {
  rows: MarketplaceListing[];
  snapshot: OwnerCloudShelfSnapshot;
  /** true면 첫 페이지만 부치고 끝났다는 뜻 — 나머지 페이지는 아예 요청하지 않았다. */
  revalidatedOnly: boolean;
}

function ownerCloudPageFingerprint(rows: readonly MarketplaceListing[]): string {
  return rows
    .map((row) => {
      const id = cleanString(row.cloudId) || cleanString(row.packageHash) || cleanString(row.slug);
      const revision = typeof row.revision === "number" ? String(row.revision) : cleanString(row.revision);
      return `${id}@${revision}`;
    })
    .join("|");
}

export class PartialHubResultError<T> extends Error {
  constructor(
    message: string,
    readonly partialValue: T,
  ) {
    super(message);
    this.name = "PartialHubResultError";
  }
}

export class OwnerPackageRestoreError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
  ) {
    // Keep the server code as the exact Error.message so callers can branch on
    // owner_only / no_cloud_package without parsing translated prose.
    super(code);
    this.name = "OwnerPackageRestoreError";
  }
}

/**
 * Owner-only Agent Cloud action refusal (delete_agent / combinations). The
 * server code (owner_only, agent_not_found, insufficient_credits, …) is the
 * exact Error.message so callers can surface it verbatim — never as success.
 */
export class OwnerCloudActionError extends Error {
  constructor(
    readonly code: string,
    readonly detail?: string,
    readonly refusal: {
      retryable?: boolean;
      expectedRevision?: number;
      currentRevision?: number;
      packageBytesRetained?: boolean;
      actionState?: "not-committed" | "partially-committed" | "unknown";
    } = {},
  ) {
    super(code);
    this.name = "OwnerCloudActionError";
  }
}

interface OwnerPackageRestorePayload {
  schema: "agentlas.agent_cloud.restore.v1";
  source: "cloud";
  owner: true;
  slug: string;
  name: string;
  nameEn: string;
  tagline: string;
  taglineEn: string;
  registration: CloudAgentRevisionIdentity;
  cloudPackage: CloudAgentPackageDownload;
  agentDefinitionId?: string;
  agentReleaseId?: string;
}

interface McpSourceOptions {
  baseUrl: string;
  /** Public full Hub list endpoint. Defaults to `${origin}/api/marketplace/agents`. */
  publicAgentsUrl?: string;
  /** Public Hub plugin endpoint. Defaults to `${origin}/api/plugins`. */
  publicPluginsUrl?: string;
  /** 인증 토큰 (있으면 cargo/builder 호출 가능) */
  bearer?: string;
  /** 요청 타임아웃 (ms) — 기본 15000 */
  timeoutMs?: number;
  /** 매 호출 직전에 평가되는 cookie 헤더 — agentlas_session=... 또는 null. 로그인 상태가 바뀔 수 있어 함수로 받는다. */
  cookieProvider?: () => string | null;
}

export interface HubCatalogProbeResult {
  online: boolean;
  error: string | null;
}

/** 원격 result를 배열로 정규화. 서버가 배열을 직접 주거나 {agents|firms|bundles|listings|items|results:[...]}
 *  로 감싸 주거나, 단일 객체를 줄 수 있다. 어떤 경우든 caller(.filter 등)가 깨지지 않도록 배열로 만든다. */
function asArray<T>(raw: unknown, ...keys: string[]): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    for (const k of [...keys, "items", "results", "data"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
}

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function englishListingText(value: unknown, fallback: string): string {
  const clean = cleanString(value);
  return clean && !/[\uac00-\ud7af]/.test(clean) ? clean : fallback;
}

function cleanNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cleanIsoString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function trustGrade(value: unknown): MarketplaceListing["trustGrade"] {
  return value === "A" || value === "B" || value === "C" || value === "unknown" ? value : "unknown";
}

function restoreError(raw: Record<string, unknown>): never {
  const code = cleanString(raw.error, "invalid_restore_contract");
  throw new OwnerPackageRestoreError(code, cleanString(raw.message) || undefined);
}

/** cargo.* owner actions return refusals inside the result payload (restore
 * pattern). Surface the exact server code; never coerce it into success. */
function throwIfOwnerActionRefusal(raw: unknown): void {
  const root = asRecord(raw);
  if (root && typeof root.error === "string" && root.error.trim()) {
    const code = root.error.trim();
    const knownNoCommit = new Set([
      "owner_only",
      "agent_not_found",
      "combination_not_found",
      "insufficient_credits",
      "invalid_combination",
      "invalid_combination_revision",
      "cloud_delete_commit_failed",
      "cloud_revision_conflict",
      "combination_revision_conflict",
      "combination_write_conflict",
    ]);
    const positiveRevision = (value: unknown): number | undefined =>
      Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : undefined;
    throw new OwnerCloudActionError(
      code,
      cleanString(root.message) || undefined,
      {
        ...(typeof root.retryable === "boolean" ? { retryable: root.retryable } : {}),
        ...(positiveRevision(root.expectedRevision) !== undefined
          ? { expectedRevision: positiveRevision(root.expectedRevision) }
          : {}),
        ...(positiveRevision(root.currentRevision) !== undefined
          ? { currentRevision: positiveRevision(root.currentRevision) }
          : {}),
        ...(typeof root.packageBytesRetained === "boolean"
          ? { packageBytesRetained: root.packageBytesRetained }
          : {}),
        actionState: code === "workforce_withdrawal_pending"
          ? "partially-committed"
          : knownNoCommit.has(code)
            ? "not-committed"
            : "unknown",
      },
    );
  }
}

function normalizeDeleteResult(raw: unknown, requestedSlug: string): CloudAgentDeleteResult | null {
  const root = asRecord(raw);
  if (!root || root.schema !== "agentlas.agent_cloud.delete.v1" || root.deleted !== true) return null;
  const slug = cleanString(root.slug);
  const scope = root.scope;
  const deletionMode = root.deletionMode;
  const deletedResource = root.deletedResource;
  const operation = root.operation;
  const revision = cleanString(root.revision);
  const deletedAt = cleanString(root.deletedAt);
  if (
    slug !== requestedSlug ||
    (scope !== "owner-private" && scope !== "hub-public") ||
    !/^(?:rev_[a-f0-9]{32}|legacy_[a-f0-9]{64})$/.test(revision) ||
    !Number.isFinite(Date.parse(deletedAt))
  ) return null;
  if (scope === "owner-private") {
    if (
      deletionMode !== "hard-delete" ||
      deletedResource !== "cloud-package" ||
      root.packageBytesRetained !== false ||
      operation !== undefined ||
      root.reconciled !== undefined
    ) return null;
    return {
      schema: "agentlas.agent_cloud.delete.v1",
      deleted: true,
      slug,
      scope,
      deletionMode,
      deletedResource,
      packageBytesRetained: false,
      revision,
      deletedAt,
    };
  }
  if (
    deletionMode !== "soft-unpublish" ||
    deletedResource !== "hub-listing" ||
    root.packageBytesRetained !== true ||
    (operation !== "unpublished" && operation !== "already_unpublished") ||
    typeof root.reconciled !== "boolean"
  ) return null;
  return {
    schema: "agentlas.agent_cloud.delete.v1",
    deleted: true,
    slug,
    scope,
    operation,
    deletionMode,
    deletedResource,
    packageBytesRetained: true,
    reconciled: root.reconciled,
    revision,
    deletedAt,
  };
}

function normalizeCombinationMember(raw: unknown): CloudAgentCombinationMemberRef | null {
  const row = asRecord(raw);
  if (!row) return null;
  const agentDefinitionId = cleanString(row.agentDefinitionId);
  const agentReleaseId = cleanString(row.agentReleaseId);
  if (!agentDefinitionId || !agentReleaseId) return null;
  return { agentDefinitionId, agentReleaseId };
}

function normalizeCombination(raw: unknown): CloudAgentCombination | null {
  const row = asRecord(raw);
  if (!row) return null;
  const combinationId = cleanString(row.combinationId);
  const name = cleanString(row.name);
  const description = typeof row.description === "string" ? row.description : null;
  const revision = row.revision;
  const updatedAt = cleanString(row.updatedAt);
  if (
    !combinationId ||
    !name ||
    description === null ||
    !Number.isSafeInteger(revision) ||
    Number(revision) < 1 ||
    !updatedAt ||
    !Number.isFinite(Date.parse(updatedAt)) ||
    !Array.isArray(row.members) ||
    row.members.length < 1 ||
    row.members.length > 32
  ) return null;
  const members = row.members.map(normalizeCombinationMember);
  if (members.some((member) => member === null)) return null;
  return {
    combinationId,
    name,
    description,
    members: members as CloudAgentCombinationMemberRef[],
    revision: Number(revision),
    updatedAt,
  };
}

function normalizeRestoreFile(raw: unknown): CloudAgentPackageDownloadFile | null {
  const row = asRecord(raw);
  if (!row) return null;
  if (
    typeof row.path !== "string" ||
    typeof row.bytes !== "number" ||
    typeof row.sha256 !== "string" ||
    typeof row.contentBase64 !== "string"
  ) {
    return null;
  }
  return {
    path: row.path,
    bytes: row.bytes,
    sha256: row.sha256,
    contentBase64: row.contentBase64,
    // Carried through so the restore validator can see it. Agent Cloud stores
    // packages decompressed today, so this is normally absent — dropping it
    // here would mean a future compressed payload silently failed its own
    // length and hash checks instead of being decoded.
    ...(row.encoding === "gzip" ? { encoding: "gzip" as const } : {}),
    ...(typeof row.encodedBytes === "number" ? { encodedBytes: row.encodedBytes } : {}),
    ...(typeof row.executable === "boolean" ? { executable: row.executable } : {}),
  };
}

function normalizeOwnerRestorePayload(raw: unknown, expectedSlug: string): OwnerPackageRestorePayload {
  const root = asRecord(raw);
  if (!root) throw new OwnerPackageRestoreError("invalid_restore_contract");
  if (typeof root.error === "string" && root.error.trim()) restoreError(root);
  if (
    root.schema !== "agentlas.agent_cloud.restore.v1" ||
    root.source !== "cloud" ||
    root.owner !== true
  ) {
    throw new OwnerPackageRestoreError("invalid_restore_contract");
  }

  const slug = cleanString(root.slug);
  if (!slug) throw new OwnerPackageRestoreError("invalid_restore_contract");
  if (slug !== expectedSlug) {
    throw new OwnerPackageRestoreError("restore_slug_mismatch", `Requested ${expectedSlug}; received ${slug}.`);
  }
  const rawPackage = asRecord(root.cloudPackage);
  if (!rawPackage || !Array.isArray(rawPackage.files)) {
    throw new OwnerPackageRestoreError("invalid_restore_contract");
  }
  const files = rawPackage.files.map(normalizeRestoreFile);
  if (files.some((file) => !file)) {
    throw new OwnerPackageRestoreError("invalid_restore_contract");
  }
  const packageHash = cleanString(rawPackage.packageHash);
  const packageHashVersionRaw = cleanString(rawPackage.packageHashVersion);
  const packageHashVersion = packageHashVersionRaw || undefined;
  const agentKind = rawPackage.agentKind;
  const fileCount = rawPackage.fileCount;
  const totalBytes = rawPackage.totalBytes;
  const runtimeLabels = Array.isArray(rawPackage.runtimeLabels)
    ? rawPackage.runtimeLabels.filter((label): label is string => typeof label === "string" && Boolean(label.trim()))
    : [];
  if (
    !packageHash ||
    (packageHashVersion !== undefined &&
      packageHashVersion !== "path-sha256-v1" &&
      packageHashVersion !== "path-sha256-executable-v2") ||
    (agentKind !== "agent" && agentKind !== "team" && agentKind !== "repo") ||
    typeof fileCount !== "number" ||
    typeof totalBytes !== "number"
  ) {
    throw new OwnerPackageRestoreError("invalid_restore_contract");
  }
  const cloudId = cleanString(root.cloudId);
  const scope = root.scope;
  const revision = cleanString(root.revision);
  const etag = cleanString(root.etag);
  const updatedAt = cleanString(root.updatedAt);
  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(cloudId) ||
    (scope !== "owner-private" && scope !== "hub-public") ||
    !/^rev_[a-f0-9]{32}$/.test(revision) ||
    etag !== `"${revision}"` ||
    !updatedAt || !Number.isFinite(Date.parse(updatedAt)) ||
    cleanString(rawPackage.cloudId) !== cloudId ||
    rawPackage.scope !== scope ||
    cleanString(rawPackage.revision) !== revision ||
    cleanString(rawPackage.updatedAt) !== updatedAt ||
    packageHashVersion === undefined
  ) {
    throw new OwnerPackageRestoreError("invalid_restore_contract", "Restore revision identity is missing or inconsistent.");
  }
  const registration: CloudAgentRevisionIdentity = {
    cloudId,
    slug,
    scope,
    packageHash,
    packageHashVersion,
    revision,
    updatedAt,
  };
  if (
    cleanString(root.packageHash) !== packageHash ||
    cleanString(root.packageHashVersion) !== packageHashVersion ||
    root.fileCount !== fileCount ||
    root.totalBytes !== totalBytes ||
    root.agentKind !== agentKind
  ) {
    throw new OwnerPackageRestoreError("invalid_restore_contract", "Restore envelope and cloudPackage disagree.");
  }

  return {
    schema: "agentlas.agent_cloud.restore.v1",
    source: "cloud",
    owner: true,
    slug,
    name: cleanString(root.name, slug),
    nameEn: cleanString(root.nameEn, cleanString(root.name, slug)),
    tagline: cleanString(root.tagline, "Owned Agent Cloud asset"),
    taglineEn: cleanString(root.taglineEn, cleanString(root.tagline, "Owned Agent Cloud asset")),
    registration,
    ...(typeof root.agentDefinitionId === "string" && typeof root.agentReleaseId === "string"
      ? {
          agentDefinitionId: root.agentDefinitionId,
          agentReleaseId: root.agentReleaseId,
        }
      : {}),
    cloudPackage: {
      packageHash,
      ...(packageHashVersion ? { packageHashVersion } : {}),
      fileCount,
      totalBytes,
      agentKind,
      runtimeLabels,
      files: files as CloudAgentPackageDownloadFile[],
      cloudId,
      scope,
      revision,
      updatedAt,
    },
  };
}

function restoredSystemPrompt(pkg: CloudAgentPackageDownload): string {
  return readCanonicalPromptFromPackageFiles(pkg.files)?.content ?? "";
}

function safeMetadataForRestore(
  metadata: (SeedListingFull & MarketplaceListing) | null,
  slug: string,
): (SeedListingFull & MarketplaceListing) | null {
  return metadata && cleanString(metadata.slug) === slug ? metadata : null;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

function normalizeEnvRequirements(value: unknown): AgentEnvRequirement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): AgentEnvRequirement[] => {
    const row = asRecord(item);
    const key = cleanString(row?.key);
    if (!key) return [];
    const label = cleanString(row?.label, key);
    return [{
      key,
      label,
      labelEn: cleanString(row?.labelEn, label),
      required: row?.required === true,
      ...(typeof row?.hint === "string" ? { hint: row.hint } : {}),
      ...(typeof row?.hintEn === "string" ? { hintEn: row.hintEn } : {}),
    }];
  });
}

function restorePayloadToListing(
  restored: OwnerPackageRestorePayload,
  metadata: (SeedListingFull & MarketplaceListing) | null,
  manifestUrl: string,
): SeedListingFull & MarketplaceListing {
  const safeMetadata = safeMetadataForRestore(metadata, restored.slug);
  const tone = safeMetadata?.tone;
  const safeTone = tone === "blue" || tone === "green" || tone === "purple" || tone === "amber" || tone === "peach"
    ? tone
    : "blue";
  return {
    slug: restored.slug,
    name: restored.name,
    nameEn: restored.nameEn,
    tagline: restored.tagline,
    taglineEn: restored.taglineEn,
    trustGrade: safeMetadata ? trustGrade(safeMetadata.trustGrade) : "unknown",
    installCount: safeMetadata ? cleanNumber(safeMetadata.installCount) : 0,
    manifestUrl: safeMetadata ? cleanString(safeMetadata.manifestUrl, manifestUrl) : manifestUrl,
    mcpServers: normalizeStringArray(safeMetadata?.mcpServers),
    tone: safeTone,
    // Package instructions are the immutable asset authority. Draft metadata is
    // a fallback only when the uploaded package has no root instruction file.
    systemPrompt: restoredSystemPrompt(restored.cloudPackage) || cleanString(safeMetadata?.systemPrompt),
    envRequirements: normalizeEnvRequirements(safeMetadata?.envRequirements),
    visibility: "visible",
    source: "agent-cloud-owner-restore",
    kind: "install-only",
    callable: false,
    entityKind: restored.cloudPackage.agentKind === "team" ? "team" : "agent",
    cloudPackage: restored.cloudPackage,
    cloudRegistration: restored.registration,
    ...(restored.agentDefinitionId && restored.agentReleaseId
      ? {
          agentDefinitionId: restored.agentDefinitionId,
          agentReleaseId: restored.agentReleaseId,
        }
      : {}),
  };
}

function normalizeListing(raw: MarketplaceListing): MarketplaceListing | null {
  const record = raw as MarketplaceListing & Record<string, unknown>;
  const slug = cleanString(record.slug);
  if (!slug) return null;

  const name = cleanString(record.name, slug);
  const nameEn = cleanString(record.nameEn, name);
  const isHubCallable = record.kind === "cloud-callable" || record.callable === true || record.source === "hub-index" || record.source === "hub-profile";
  const entityKind = cleanString(record.entityKind, "agent");
  const fallbackTagline = isHubCallable
    ? entityKind === "team"
      ? "Callable Hub team"
      : "Callable Hub agent"
    : "Installable Agentlas agent";
  const tagline = cleanString(record.tagline, fallbackTagline);
  const taglineEn = cleanString(record.taglineEn, tagline);
  const manifestUrl = cleanString(
    record.manifestUrl,
    `https://agentlas.cloud/api/mcp/v1/manifest/agent/${slug}`,
  );

  return {
    ...record,
    slug,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: trustGrade(record.trustGrade),
    installCount: cleanNumber(record.installCount, cleanNumber(record.verifiedInvocations)),
    manifestUrl,
  };
}

function normalizeListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  return listings
    .map(normalizeListing)
    .filter((listing): listing is MarketplaceListing => Boolean(listing));
}

function isLiveHubRecord(record: Record<string, unknown>): boolean {
  return (
    record.source === "hub-index" ||
    record.source === "hub-profile" ||
    record.kind === "cloud-callable" ||
    record.callable === true
  );
}

function liveHubListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  return normalizeListings(listings).filter((listing) => isLiveHubRecord(listing as unknown as Record<string, unknown>));
}

function liveHubTeams<T extends FirmListing | TeamBundle>(items: T[]): T[] {
  return items.filter((item) => isLiveHubRecord(item as unknown as Record<string, unknown>));
}

function publicAgentsUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/api/marketplace/agents`;
  } catch {
    return "https://agentlas.cloud/api/marketplace/agents";
  }
}

function publicPluginsUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/api/plugins`;
  } catch {
    return "https://agentlas.cloud/api/plugins";
  }
}

function marketplacePageUrlFor(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return `${url.origin}/marketplace`;
  } catch {
    return "https://agentlas.cloud/marketplace";
  }
}

function decodeNextFlightText(html: string): string {
  return html
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractSlugObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let idx = 0;
  while (idx < text.length) {
    const start = text.indexOf('{"slug":"', idx);
    if (start === -1) break;
    let depth = 0;
    let inString = false;
    let escape = false;
    let end = -1;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end === -1) break;
    try {
      const parsed = JSON.parse(text.slice(start, end));
      if (parsed && typeof parsed === "object") out.push(parsed as Record<string, unknown>);
    } catch {
      /* ignore malformed embedded fragments */
    }
    idx = end;
  }
  return out;
}

function dedupeListings(listings: MarketplaceListing[]): MarketplaceListing[] {
  const byIdentity = new Map<string, MarketplaceListing>();
  for (const listing of listings) {
    const entityKind = listing.entityKind === "plugin" || listing.source === "hub-plugin"
      ? "plugin"
      : listing.entityKind === "graph"
        ? "graph" // 같은 slug의 에이전트와 그래프는 별개 자산 — 접으면 한쪽이 사라진다
        : listing.entityKind === "team" || (typeof listing.agentCount === "number" && listing.agentCount > 1)
          ? "team"
          : "agent";
    const identity = `${entityKind}:${listing.slug.trim().toLowerCase()}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, listing);
  }
  return Array.from(byIdentity.values());
}

function enrichRankedListing(
  ranked: MarketplaceListing,
  catalog: MarketplaceListing | undefined,
): MarketplaceListing {
  if (!catalog) return ranked;
  return {
    ...catalog,
    ...ranked,
    // Semantic search is the ranking authority, while the public catalog is
    // the display-metadata authority when a compact/legacy Hub response omits
    // localized copy or entity shape.
    name: cleanString(ranked.name, catalog.name),
    nameEn: cleanString(ranked.nameEn, catalog.nameEn || catalog.name),
    tagline: cleanString(ranked.tagline, catalog.tagline),
    taglineEn: cleanString(ranked.taglineEn, catalog.taglineEn || catalog.tagline),
    source: cleanString(ranked.source, catalog.source || "hub-index"),
    entityKind: cleanString(ranked.entityKind, catalog.entityKind || "agent"),
    manifestUrl: cleanString(ranked.manifestUrl, catalog.manifestUrl),
  };
}

export function marketPublicAgentToListing(raw: Record<string, unknown>): MarketplaceListing | null {
  const slug = cleanString(raw.slug);
  if (!slug) return null;
  // 서버 kind는 자산의 모양(agent/team/graph)이다. "team 아니면 agent"로 접으면
  // 그래프가 에이전트 선반에 진열된다 — 서버가 이미 오늘 그 사고를 냈고(judged
  // 판별기 graph 분기 누락), 여기서 또 접으면 서버를 고쳐도 클라이언트가 되살린다.
  const rawEntityKind = cleanString(raw.kind, "agent");
  const entityKind = rawEntityKind === "team" ? "team" : rawEntityKind === "graph" ? "graph" : "agent";
  const titleEn = englishListingText(raw.titleEn, englishListingText(raw.title, slug));
  const titleKo = cleanString(raw.titleKo, titleEn);
  const name = titleKo || titleEn || slug;
  const taglineEn = englishListingText(
    raw.taglineEn,
    englishListingText(
      raw.tagline,
      entityKind === "team" ? "Callable Hub team" : entityKind === "graph" ? "Installable automation graph" : "Callable Hub agent",
    ),
  );
  const taglineKo = cleanString(raw.taglineKo, taglineEn);
  const totalBorrows = cleanNumber(raw.totalBorrows);
  // 그래프는 호출 가격이 없다(서버 pricing과 동일 규칙) — 기본값도 만들지 않는다.
  const perCallCredits = entityKind === "graph" ? 0 : cleanNumber(raw.perCallCredits, entityKind === "team" ? 10 : 3);
  // REST `kind` carries the entity shape (agent/team); delivery state lives in
  // deliveryKind. Anything other than an explicit cloud-callable is install-only.
  const deliveryKind = cleanString(raw.deliveryKind) === "cloud-callable" ? "cloud-callable" : "install-only";

  return {
    slug,
    name,
    nameEn: titleEn || name,
    tagline: taglineKo || taglineEn,
    taglineEn,
    // Delivery state, security grade, and invocation counts are the server's to
    // state. Hardcoding kind/callable/trustGrade here made every public-catalog
    // row render "Hub callable · Security scan A" even while the same slug was
    // uncallable (cloud_runtime_invalid) — the client badge became the reason a
    // 15-day Hub outage stayed invisible. Read the fields; fail closed when the
    // response omits them.
    trustGrade: trustGrade(raw.trustGrade),
    installCount: totalBorrows,
    manifestUrl: `https://agentlas.cloud/p/${slug}`,
    ownerName: cleanString(raw.ownerName),
    publishedAt: cleanIsoString(raw.publishedAt),
    kind: deliveryKind,
    callable: deliveryKind === "cloud-callable" && raw.callable === true,
    ...(typeof raw.routingReady === "boolean" ? { routingReady: raw.routingReady } : {}),
    ...(cleanString(raw.availabilityReason) ? { availabilityReason: cleanString(raw.availabilityReason) } : {}),
    routingStatus: "public-profile",
    source: "hub-profile",
    entityKind,
    perCallCredits,
    // verifiedInvocations is the invocation trust ledger, not borrow volume.
    ...(Number.isFinite(Number(raw.verifiedInvocations))
      ? { verifiedInvocations: cleanNumber(raw.verifiedInvocations) }
      : {}),
    totalBorrows,
    todayBorrows: cleanNumber(raw.todayBorrows),
    assetCount: cleanNumber(raw.assetCount),
    // Absent agentCount means UNKNOWN. Substituting 1 for a team under-quotes
    // credit estimates, so leave it unset instead.
    ...(Number.isFinite(Number(raw.agentCount)) ? { agentCount: cleanNumber(raw.agentCount) } : {}),
    lastRoutingSuccessAt: cleanIsoString(raw.lastBorrowedAt),
  };
}

/** 허브가 내려준 상대 자산 경로를 절대 URL로 올린다. 웹이 로고의 정본이다. */
function absoluteHubAssetUrl(value: unknown, origin: string): string | undefined {
  const raw = cleanString(value);
  if (!raw) return undefined;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!raw.startsWith("/")) return undefined;
  return `${origin}${raw}`;
}

/**
 * 허브가 알려준 플러그인 종류를 그대로 읽는다. 판정의 정본은 웹 카탈로그이고
 * (mcp 행 / connectSetup / skills 유무), 데스크탑은 그 답을 옮기기만 한다.
 *
 * 구버전 허브는 이 필드를 안 내려준다. 그때 화면을 비우거나 전부 한 통에 넣는
 * 대신, 같은 근거의 축소판(서버 수·스킬 수)이 있으면 그걸로 판정하고, 그것마저
 * 없으면 `undefined`를 돌려 "모른다"를 그대로 표현한다 — 추측을 사실처럼
 * 저장하지 않는다. 화면은 종류 미상 행을 연결 섹터에 두고 그 사실을 밝힌다.
 */
function readPluginKind(raw: Record<string, unknown>): {
  pluginKind?: PluginKind;
  skillCount?: number;
  mcpServerCount?: number;
  connectSetupRequired?: boolean;
} {
  const declared = cleanString(raw.pluginKind);
  const skillCount = Number.isFinite(Number(raw.skillCount)) ? Number(raw.skillCount) : undefined;
  const mcpServerCount = Number.isFinite(Number(raw.mcpServerCount)) ? Number(raw.mcpServerCount) : undefined;
  const connectSetupRequired = typeof raw.connectSetupRequired === "boolean" ? raw.connectSetupRequired : undefined;
  const counts = {
    ...(skillCount === undefined ? {} : { skillCount }),
    ...(mcpServerCount === undefined ? {} : { mcpServerCount }),
    ...(connectSetupRequired === undefined ? {} : { connectSetupRequired }),
  };
  if (declared === "mcp" || declared === "skill") return { pluginKind: declared, ...counts };
  if (mcpServerCount !== undefined || connectSetupRequired !== undefined) {
    const connectable = (mcpServerCount ?? 0) > 0 || connectSetupRequired === true;
    if (connectable) return { pluginKind: "mcp", ...counts };
    if ((skillCount ?? 0) > 0) return { pluginKind: "skill", ...counts };
    return { pluginKind: "mcp", ...counts };
  }
  return counts;
}

/**
 * 허브가 선언한 인증 종류. 값이 없거나 모르는 문자열이면 아무것도 돌려주지 않는다 —
 * 임의로 "none"으로 채우면 화면이 "설치만 하면 끝"이라 말하게 되고, 그건 사용자가
 * 아무리 눌러도 도구가 안 붙는 이유를 영영 못 찾게 만든다.
 */
function readAuthKind(raw: Record<string, unknown>): { authKind?: PluginAuthKind } {
  const value = cleanString(raw.auth);
  if (value === "none" || value === "oauth" || value === "api_key" || value === "token") {
    return { authKind: value };
  }
  return {};
}

function marketPublicPluginToListing(
  raw: Record<string, unknown>,
  origin = "https://agentlas.cloud",
): MarketplaceListing | null {
  const slug = cleanString(raw.slug);
  if (!slug) return null;
  const name = cleanString(raw.name, slug);
  const tagline = cleanString(raw.tagline, "Hub plugin");
  const developer = cleanString(raw.developer, "Agentlas Hub");
  const detailUrl = cleanString(raw.detailUrl, cleanString(raw.manifestHref, `/api/plugins/${slug}`));
  const install = raw.install && typeof raw.install === "object" ? raw.install as Record<string, unknown> : {};

  return {
    slug,
    name,
    nameEn: name,
    tagline,
    taglineEn: tagline,
    trustGrade: "A",
    installCount: 0,
    manifestUrl: detailUrl.startsWith("http") ? detailUrl : `https://agentlas.cloud${detailUrl}`,
    ownerName: developer,
    kind: "hub-plugin",
    callable: false,
    routingReady: true,
    routingStatus: "public-plugin",
    source: "hub-plugin",
    entityKind: "plugin",
    perCallCredits: 0,
    category: cleanString(raw.category),
    developer,
    detailUrl: detailUrl.startsWith("http") ? detailUrl : `https://agentlas.cloud${detailUrl}`,
    installCli: cleanString(install.cli, `npx agentlas@latest plugin add ${slug}`),
    ...(cleanString(raw.homepage) ? { homepage: cleanString(raw.homepage) } : {}),
    // 로고 3필드는 여기서 버려지고 있었다(2026-08-16) — 그래서 허브 화면이 흑백
    // 텍스트 카드였다. 웹이 로고를 바꾸면 데스크탑도 따라오도록 주소만 옮긴다.
    ...(absoluteHubAssetUrl(raw.icon, origin) ? { iconUrl: absoluteHubAssetUrl(raw.icon, origin) } : {}),
    ...(absoluteHubAssetUrl(raw.brandGlyph, origin) ? { brandGlyphUrl: absoluteHubAssetUrl(raw.brandGlyph, origin) } : {}),
    ...(cleanString(raw.brandColor) ? { brandColor: cleanString(raw.brandColor) } : {}),
    ...(typeof raw.featured === "boolean" ? { featured: raw.featured } : {}),
    ...readAuthKind(raw),
    ...readPluginKind(raw),
  };
}

function matchesQuery(listing: MarketplaceListing, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [
    listing.slug,
    listing.name,
    listing.nameEn,
    listing.tagline,
    listing.taglineEn,
    listing.ownerName,
    listing.entityKind,
    listing.category,
    listing.developer,
  ]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}

function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Hub catalog probe timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export class McpSource implements MarketplaceSource {
  private publicAgentCache: { fetchedAt: number; listings: MarketplaceListing[] } | null = null;
  private publicPluginCache: { fetchedAt: number; listings: MarketplaceListing[] } | null = null;
  private publicAgentInFlight: Promise<MarketplaceListing[]> | null = null;
  private publicPluginInFlight: Promise<MarketplaceListing[]> | null = null;

  constructor(private opts: McpSourceOptions) {}

  private async call<T>(method: string, params?: Record<string, unknown>, timeoutMs = this.opts.timeoutMs ?? 15_000, signal?: AbortSignal): Promise<T> {
    const url = `${this.opts.baseUrl}/tools/call`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      throwIfOwnerReadAborted(signal);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (this.opts.bearer) headers.authorization = `Bearer ${this.opts.bearer}`;
      // 로그인되어 있으면 세션 cookie를 첨부 — server-side에서 인증된 사용자로 인식
      const cookie = this.opts.cookieProvider?.();
      if (cookie) headers.cookie = cookie;
      const resp = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ method, params: { name: method, arguments: params ?? {} } }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new McpSourceHttpError(method, resp.status);
      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
      throwIfOwnerReadAborted(signal);
      return json.result as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  private listPublicHubAgents(force = false): Promise<MarketplaceListing[]> {
    const now = Date.now();
    if (!force && this.publicAgentCache && now - this.publicAgentCache.fetchedAt < PUBLIC_AGENT_CACHE_MS) {
      return Promise.resolve(this.publicAgentCache.listings);
    }
    if (this.publicAgentInFlight) return this.publicAgentInFlight;

    let request!: Promise<MarketplaceListing[]>;
    request = this.fetchPublicHubAgents(now).finally(() => {
      if (this.publicAgentInFlight === request) this.publicAgentInFlight = null;
    });
    this.publicAgentInFlight = request;
    return request;
  }

  private async fetchPublicHubAgents(fetchedAt: number): Promise<MarketplaceListing[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    const url = this.opts.publicAgentsUrl || publicAgentsUrlFor(this.opts.baseUrl);
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        if (resp.status === 404 && !this.opts.publicAgentsUrl) {
          const listings = await this.listMarketplacePageAgents(ctrl.signal);
          this.publicAgentCache = { fetchedAt, listings };
          return listings;
        }
        throw new Error(`public marketplace agents ${resp.status}`);
      }
      const json = (await resp.json()) as unknown;
      const rawAgents = asArray<Record<string, unknown>>(json, "agents", "listings");
      const listings = liveHubListings(rawAgents.map(marketPublicAgentToListing).filter((item): item is MarketplaceListing => Boolean(item)));
      this.publicAgentCache = { fetchedAt, listings };
      return listings;
    } finally {
      clearTimeout(timer);
    }
  }

  private async listMarketplacePageAgents(signal?: AbortSignal): Promise<MarketplaceListing[]> {
    const resp = await fetch(marketplacePageUrlFor(this.opts.baseUrl), {
      headers: { accept: "text/html" },
      signal,
    });
    if (!resp.ok) throw new Error(`public marketplace page ${resp.status}`);
    const html = await resp.text();
    const rawAgents = extractSlugObjects(decodeNextFlightText(html));
    const listings = liveHubListings(rawAgents.map(marketPublicAgentToListing).filter((item): item is MarketplaceListing => Boolean(item)));
    if (listings.length === 0) throw new Error("public marketplace page contained no Hub agents");
    return listings;
  }

  private listPublicHubPlugins(force = false): Promise<MarketplaceListing[]> {
    const now = Date.now();
    if (!force && this.publicPluginCache && now - this.publicPluginCache.fetchedAt < PUBLIC_AGENT_CACHE_MS) {
      return Promise.resolve(this.publicPluginCache.listings);
    }
    if (this.publicPluginInFlight) return this.publicPluginInFlight;

    let request!: Promise<MarketplaceListing[]>;
    request = this.fetchPublicHubPlugins(now).finally(() => {
      if (this.publicPluginInFlight === request) this.publicPluginInFlight = null;
    });
    this.publicPluginInFlight = request;
    return request;
  }

  private async fetchPublicHubPlugins(fetchedAt: number): Promise<MarketplaceListing[]> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    const url = this.opts.publicPluginsUrl || publicPluginsUrlFor(this.opts.baseUrl);
    try {
      const resp = await fetch(url, {
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`public marketplace plugins ${resp.status}`);
      const json = (await resp.json()) as unknown;
      const rawPlugins = asArray<Record<string, unknown>>(json, "plugins", "items", "listings");
      const assetOrigin = (() => {
        try { return new URL(url).origin; } catch { return "https://agentlas.cloud"; }
      })();
      const listings = normalizeListings(
        rawPlugins
          .map((rawPlugin) => marketPublicPluginToListing(rawPlugin, assetOrigin))
          .filter((item): item is MarketplaceListing => Boolean(item)),
      );
      this.publicPluginCache = { fetchedAt, listings };
      return listings;
    } finally {
      clearTimeout(timer);
    }
  }

  async listFirms(): Promise<FirmListing[]> {
    return liveHubTeams(asArray<FirmListing>(await this.call<unknown>("marketplace.list_firms", {}), "firms"));
  }

  async listBundles(): Promise<TeamBundle[]> {
    return liveHubTeams(asArray<TeamBundle>(await this.call<unknown>("marketplace.list_bundles", {}), "bundles"));
  }

  async searchAgents(q: string): Promise<MarketplaceListing[]> {
    // 에이전트: 작동하는 MCP marketplace.search_agents 사용.
    //   공개 REST /api/marketplace/agents 가 없는 배포에선 실제 웹 /marketplace 렌더 데이터를 같이 긁어온다.
    // 플러그인: 공개 /api/plugins (정상 동작).
    const sources: Array<Promise<MarketplaceListing[]>> = [
      this.listPublicHubAgents(),
      this.listPublicHubPlugins(),
    ];
    if (q.trim()) sources.push(this.searchHubAgents(q));
    const results = await Promise.allSettled(sources);
    const publicCatalog = results
      .slice(0, 2)
      .flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const catalogBySlug = new Map(
      publicCatalog.map((listing) => [listing.slug.trim().toLowerCase(), listing] as const),
    );
    const semanticAttempt = results[2];
    const semanticResults = q.trim() && semanticAttempt?.status === "fulfilled"
      ? semanticAttempt.value.map((listing) => enrichRankedListing(
          listing,
          catalogBySlug.get(listing.slug.trim().toLowerCase()),
        ))
      : [];
    // Preserve the Hub semantic rank. The server has already matched natural
    // language against routing descriptions, capabilities, trigger examples,
    // lexical evidence, and embeddings. Applying a final literal substring
    // filter here used to erase valid intent matches such as
    // "API 백엔드 만들어줘" -> backend-engineering-team.
    const directCatalogMatches = publicCatalog.filter((listing) => matchesQuery(listing, q));
    const filtered = q.trim()
      ? dedupeListings([...semanticResults, ...directCatalogMatches])
      : dedupeListings(publicCatalog);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    if (errors.length > 0) {
      if (results.some((result) => result.status === "fulfilled")) {
        throw new PartialHubResultError(`public marketplace partial failure: ${errors.join("; ")}`, filtered);
      }
      throw new Error(`public marketplace unavailable: ${errors.join("; ")}`);
    }
    return filtered;
  }

  /**
   * Force a real public-catalog read. Unlike `searchAgents`, callers use this
   * only as connectivity evidence; the returned state never comes from cache.
   * Endpoint-level single-flight still lets a simultaneous Dashboard search
   * share the same network requests.
   */
  async probePublicCatalog(timeoutMs = 5_000): Promise<HubCatalogProbeResult> {
    const results = await Promise.allSettled([
      settleWithin(this.listPublicHubAgents(true), timeoutMs),
      settleWithin(this.listPublicHubPlugins(true), timeoutMs),
    ]);
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    const online = results.some((result) => result.status === "fulfilled");
    return {
      online,
      error: errors.length > 0
        ? `public marketplace ${online ? "partial failure" : "unavailable"}: ${errors.join("; ")}`
        : null,
    };
  }

  /** 허브 에이전트 검색 — MCP marketplace.search_agents.
   *  서버의 의미 순위가 추천 권위다. install-only 에이전트도 정당한 허브 결과이므로
   *  liveHub 필터나 클라이언트 글자 일치 필터를 적용하지 않는다. */
  private async searchHubAgents(q: string): Promise<MarketplaceListing[]> {
    // verbose=true keeps the public localized description/tagline needed by
    // the Dashboard recommendation cards. Internal routing text, triggers,
    // embeddings, and package instructions remain stripped by Hub.
    const raw = await this.call<unknown>("marketplace.search_agents", {
      q,
      limit: 100,
      verbose: true,
    });
    // 서버 응답은 { count, total, results, ... } 형태 — asArray가 "results"를 추출한다.
    const rows = asArray<MarketplaceListing>(raw, "results", "agents", "listings");
    // search_agents 결과엔 source 마커가 없어(렌더러의 isLiveHubListing 필터가 source∈{hub-*}/cloud-callable/
    // callable 만 통과시킴) install-only 허브 에이전트가 마켓 화면에서 전부 걸러진다 → 허브 인덱스 출처로 명시.
    const stamped = rows.map((row) => {
      const rec = row as MarketplaceListing & Record<string, unknown>;
      return { ...rec, source: typeof rec.source === "string" && rec.source ? rec.source : "hub-index" } as MarketplaceListing;
    });
    return normalizeListings(stamped);
  }

  async getListingBySlug(
    slug: string,
  ): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>(
      "marketplace.get_manifest",
      { kind: "agent", slug },
    );
  }

  getFirmBySlug(slug: string): Promise<FirmListing | null> {
    return this.call<FirmListing | null>("marketplace.get_manifest", {
      kind: "firm",
      slug,
    });
  }

  // ── cargo.* — 로그인한 사용자가 만든 자기 에이전트 (인증 필요) ──────────
  /** 내 에이전트 목록 (cookieProvider가 세션 쿠키 첨부). */
  async listMyAgents(): Promise<MarketplaceListing[]> {
    return asArray<MarketplaceListing>(await this.call<unknown>("cargo.list_agents", {}), "agents", "listings");
  }

  /** 실제 복원 가능한 소유 Agent Cloud 패키지 목록. 결과 slug는 cargo:<draftId>가 아니라 Cloud slug다. */
  /**
   * 소유자의 Agent Cloud 선반 **전체**.
   *
   * 두 개의 천장이 겹쳐 있었다. 먼저 이쪽 limit 이 20 이라 21번째부터 존재 자체를
   * 몰랐고, 그걸 올리자 이번엔 **서버가 한 응답을 50건에서 자르는 것**이 드러났다
   * (실측 2026-08-12: `total` 284, `count` 50). limit 만 올린 수리는 아무것도
   * 바꾸지 못했고, "상한에 걸리면 경고한다"던 검사조차 `50 >= 200` 이 거짓이라
   * 한 번도 발화하지 않았다 — 조용한 절단을 막겠다는 줄이 절단을 덮고 있었다.
   *
   * 그래서 서버 응답의 `total`/`nextOffset` 을 따라 끝까지 이어 받는다. 오래된
   * 서버는 `offset` 을 무시하므로 **같은 페이지가 다시 오는 것**을 진행 없음으로
   * 보고 멈춘다. 어느 경우든 실제로 받은 수가 `total` 에 못 미치면 그 사실을 남긴다.
   */
  async listMyCloudPackages(
    known?: OwnerCloudShelfSnapshot,
    options: { signal?: AbortSignal; requireComplete?: boolean } = {},
  ): Promise<OwnerCloudShelfResult> {
    const rows: MarketplaceListing[] = [];
    const seen = new Set<string>();
    let offset = 0;
    let total: number | null = null;
    let complete = false;
    for (let page = 0; page < MY_CLOUD_PAGE_BUDGET; page += 1) {
      throwIfOwnerReadAborted(options.signal);
      let raw: unknown;
      try {
        const args = {
          q: "",
          limit: MY_CLOUD_PAGE_SIZE,
          // 첫 요청에는 offset 을 **붙이지 않는다**. `offset` 은 이 도구에 새로
          // 생긴 인자이고, 아직 그것을 모르는 서버가 미선언 인자를 거절하기라도
          // 하면 선반 전체가 0건이 된다 — 50건만 보이던 것보다 나쁘다. 첫 장은
          // 예전과 완전히 같은 요청으로 가져오고, offset 은 2장부터만 쓴다.
          ...(offset > 0 ? { offset } : {}),
          mine: true,
          scope: "cloud",
          verbose: true,
        };
        // Execution must not mistake a failed later page for an absent pin.
        // Retry only this read-only page, at most twice; never restart staffing.
        for (let attempt = 0; ; attempt += 1) {
          try {
            raw = await this.call<unknown>("cargo.search_agents", args, undefined, options.signal);
            break;
          } catch (error) {
            throwIfOwnerReadAborted(options.signal);
            if (!options.requireComplete || attempt >= 2 || !(error instanceof McpSourceHttpError)
              || ![502, 503, 504].includes(error.httpStatus)) throw error;
            await ownerReadRetryDelay(attempt === 0 ? 250 : 750, options.signal);
          }
        }
      } catch (error) {
        throwIfOwnerReadAborted(options.signal);
        if (options.requireComplete) {
          throw new OwnerCloudShelfIncompleteError(rows.length, total,
            error instanceof McpSourceHttpError ? "http_error" : "request_failed",
            error instanceof McpSourceHttpError ? error.httpStatus : undefined);
        }
        // 이어 받다 실패하면 **이미 배운 것은 지키고** 멈춘다. 여기서 그대로
        // 던지면 첫 장까지 함께 사라져, 페이지네이션을 붙인 탓에 목록이 통째로
        // 비는 회귀가 된다.
        if (page === 0) throw error;
        console.warn(
          `[marketplace] owner cloud shelf stopped after ${rows.length} rows: `
          + (error instanceof Error ? error.message : String(error)),
        );
        break;
      }
      const envelope = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      if (typeof envelope.total === "number" && Number.isFinite(envelope.total)) {
        total = envelope.total;
      }
      const batch = asArray<MarketplaceListing>(raw, "results", "agents", "listings")
        .map((row) => ({
          ...row,
          source: typeof row.source === "string" && row.source ? row.source : "cloud",
        }));
      if (batch.length === 0) {
        complete = total === null || rows.length >= total;
        break;
      }
      // 첫 페이지가 곧 변경 탐지기다.
      //
      // 선반이 284건이면 전체 순회는 6번의 왕복이고, 이 목록은 모바일 스냅샷을
      // 만들 때마다 필요하다. 그런데 서버에는 컬렉션 단위 ETag 가 없다 — 대신
      // `total` 과 첫 페이지의 (cloudId, revision) 지문이 있다. 둘 다 그대로면
      // 선반은 바뀌지 않았고, **나머지 5번은 부칠 이유가 없다**. 바뀐 경우에만
      // 끝까지 걷는다.
      if (page === 0 && known && total !== null && known.total === total
        && (!options.requireComplete || known.rows.length >= total)) {
        if (ownerCloudPageFingerprint(batch) === known.fingerprint) {
          return { rows: known.rows, snapshot: known, revalidatedOnly: true };
        }
      }
      let added = 0;
      for (const row of batch) {
        // 신원 없이 세면 오래된 서버가 같은 페이지를 계속 줘도 늘어나는 것처럼 보인다.
        const key = cleanString(row.cloudId) || cleanString(row.packageHash) || cleanString(row.slug);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        added += 1;
      }
      // 새로 배운 것이 없으면 서버가 offset 을 안 보는 것이다 — 무한 루프 대신 멈춘다.
      if (added === 0) break;
      const nextOffset = envelope.nextOffset;
      if (typeof nextOffset === "number" && Number.isFinite(nextOffset) && nextOffset > offset) {
        offset = nextOffset;
      } else if (typeof nextOffset === "number") {
        complete = total === null || rows.length >= total;
        break;
      } else if (total !== null && rows.length < total) {
        // nextOffset 을 모르는 서버라도 total 을 알면 창을 직접 민다.
        offset += batch.length;
      } else {
        complete = total !== null ? rows.length >= total : batch.length < MY_CLOUD_PAGE_SIZE;
        break;
      }
      if (total !== null && rows.length >= total) {
        complete = true;
        break;
      }
    }
    throwIfOwnerReadAborted(options.signal);
    if (options.requireComplete && !complete) {
      throw new OwnerCloudShelfIncompleteError(rows.length, total, "pagination_incomplete");
    }
    if (total !== null && rows.length < total) {
      console.warn(
        `[marketplace] owner cloud shelf listed ${rows.length} of ${total} rows; `
        + "the server did not page past this point.",
      );
    }
    const normalized = normalizeListings(rows);
    return {
      rows: normalized,
      snapshot: {
        total: total ?? rows.length,
        fingerprint: ownerCloudPageFingerprint(rows.slice(0, MY_CLOUD_PAGE_SIZE)),
        rows: normalized,
      },
      revalidatedOnly: false,
    };
  }

  /** 내 Web draft 메타데이터. 파일 복원 권위가 아니며 slug 또는 "cargo:<id>"를 받는다. */
  getMyAgentManifest(id: string): Promise<(SeedListingFull & MarketplaceListing) | null> {
    return this.call<(SeedListingFull & MarketplaceListing) | null>("cargo.get_manifest", { id });
  }

  /**
   * Owner-only Agent Cloud package restore. cargo.get_manifest is consulted only
   * for safe display/tool metadata and optional id→slug resolution; package bytes,
   * identity, version, and source always come from cargo.restore_package.
   */
  async restoreMyAgentPackage(idOrSlug: string): Promise<SeedListingFull & MarketplaceListing> {
    const slug = cleanString(idOrSlug);
    if (!slug) throw new OwnerPackageRestoreError("missing_slug");
    // Restore authority first. owner_only/no_cloud_package must never be hidden
    // by a best-effort draft metadata lookup.
    // Owner packages can be materially larger than catalog/search responses and
    // production integrity verification may cross the normal 15s catalog budget.
    // Keep the request bounded, but do not strand a valid restore mid-response.
    const raw = await this.call<unknown>("cargo.restore_package", { slug }, 45_000);
    const restored = normalizeOwnerRestorePayload(raw, slug);

    let metadata: (SeedListingFull & MarketplaceListing) | null = null;
    try {
      metadata = await this.getMyAgentManifest(slug);
    } catch {
      // Optional draft metadata must never prevent an already-authorized restore.
    }
    return restorePayloadToListing(restored, metadata, `${this.opts.baseUrl}/tools/call`);
  }

  /**
   * Owner-only Agent Cloud delete. The exact hard-delete or soft-unpublish
   * semantics are preserved; server refusals surface as OwnerCloudActionError.
   * This never touches a local installation.
   */
  async deleteMyAgent(idOrSlug: string): Promise<CloudAgentDeleteResult> {
    const slug = cleanString(idOrSlug);
    if (!slug) throw new OwnerCloudActionError("missing_slug");
    const raw = await this.call<unknown>("cargo.delete_agent", { slug });
    throwIfOwnerActionRefusal(raw);
    const deleted = normalizeDeleteResult(raw, slug);
    if (!deleted) {
      throw new OwnerCloudActionError(
        "invalid_delete_contract",
        "cargo.delete_agent did not return the exact hard-delete or soft-unpublish contract.",
        { actionState: "unknown" },
      );
    }
    return deleted;
  }

  /** Owner combinations — cargo.list_combinations {} → { combinations: [...] }. */
  async listMyCombinations(): Promise<CloudAgentCombination[]> {
    const raw = await this.call<unknown>("cargo.list_combinations", {});
    throwIfOwnerActionRefusal(raw);
    const root = asRecord(raw);
    if (!root || !Array.isArray(root.combinations)) {
      throw new OwnerCloudActionError(
        "invalid_combination_contract",
        "cargo.list_combinations did not return a combinations array.",
      );
    }
    const combinations = root.combinations.map(normalizeCombination);
    if (combinations.some((combination) => combination === null)) {
      throw new OwnerCloudActionError(
        "invalid_combination_contract",
        "cargo.list_combinations returned a malformed combination.",
      );
    }
    return combinations as CloudAgentCombination[];
  }

  /**
   * Save/update one owner combination — cargo.save_combination
   * { name, description, members, combinationId?, expectedRevision? } → saved
   * combination (server issues combinationId for new rows; updates require CAS).
   */
  async saveMyCombination(input: {
    name: string;
    description: string;
    members: CloudAgentCombinationMemberRef[];
    combinationId?: string;
    expectedRevision?: number;
  }): Promise<CloudAgentCombination> {
    if (input.combinationId && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)) {
      throw new OwnerCloudActionError(
        "invalid_combination_revision",
        "Updating a cloud combination requires its positive numeric revision.",
      );
    }
    if (!input.combinationId && input.expectedRevision !== undefined) {
      throw new OwnerCloudActionError(
        "invalid_combination_revision",
        "A revision is valid only when updating an existing cloud combination.",
      );
    }
    const raw = await this.call<unknown>("cargo.save_combination", {
      name: input.name,
      description: input.description,
      members: input.members.map((member) => ({
        agentDefinitionId: member.agentDefinitionId,
        agentReleaseId: member.agentReleaseId,
      })),
      ...(input.combinationId ? { combinationId: input.combinationId } : {}),
      ...(input.combinationId ? { expectedRevision: input.expectedRevision } : {}),
    });
    throwIfOwnerActionRefusal(raw);
    const root = asRecord(raw);
    const combination = normalizeCombination(root?.combination ?? root);
    if (!combination) {
      throw new OwnerCloudActionError(
        "invalid_combination_contract",
        "cargo.save_combination did not return the saved combination.",
      );
    }
    return combination;
  }

  /** cargo.delete_combination { combinationId } → { deleted: true, combinationId }. */
  async deleteMyCombination(combinationId: string): Promise<{ deleted: true; combinationId: string }> {
    const id = cleanString(combinationId);
    if (!id) throw new OwnerCloudActionError("missing_combination_id");
    const raw = await this.call<unknown>("cargo.delete_combination", { combinationId: id });
    throwIfOwnerActionRefusal(raw);
    const root = asRecord(raw);
    if (!root || root.deleted !== true || cleanString(root.combinationId) !== id) {
      throw new OwnerCloudActionError(
        "invalid_delete_contract",
        "cargo.delete_combination did not acknowledge the exact requested combination.",
      );
    }
    return { deleted: true, combinationId: id };
  }
}
