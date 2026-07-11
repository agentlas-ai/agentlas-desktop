// MCP source — agentlas.cloud/api/mcp/v1 HTTPS 호출.
// Node 20+ 글로벌 fetch. 인증 토큰은 옵션 (anonymous read-only).
//
// Desktop Hub는 공개 Hub 프로필 전체 목록을 우선 읽고, 실패 시에만 live MCP 검색을 보조로 사용한다.
// 응답 실패/타임아웃 시 하드코딩 카탈로그로 대체하지 않는다.
import type {
  AgentEnvRequirement,
  CloudAgentPackageDownload,
  CloudAgentPackageDownloadFile,
  CloudAgentRevisionIdentity,
  FirmListing,
  MarketplaceListing,
  TeamBundle,
} from "../../shared/types";
import type { MarketplaceSource, SeedListingFull } from "./source";
import { readCanonicalPromptFromPackageFiles } from "../agents/prompt-authority";

const PUBLIC_AGENT_CACHE_MS = 60_000;

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
      : listing.entityKind === "team" || (typeof listing.agentCount === "number" && listing.agentCount > 1)
        ? "team"
        : "agent";
    const identity = `${entityKind}:${listing.slug.trim().toLowerCase()}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, listing);
  }
  return Array.from(byIdentity.values());
}

function marketPublicAgentToListing(raw: Record<string, unknown>): MarketplaceListing | null {
  const slug = cleanString(raw.slug);
  if (!slug) return null;
  const entityKind = cleanString(raw.kind, "agent") === "team" ? "team" : "agent";
  const titleEn = cleanString(raw.titleEn, cleanString(raw.title, slug));
  const titleKo = cleanString(raw.titleKo, titleEn);
  const name = titleKo || titleEn || slug;
  const taglineEn = cleanString(raw.taglineEn, cleanString(raw.tagline, entityKind === "team" ? "Callable Hub team" : "Callable Hub agent"));
  const taglineKo = cleanString(raw.taglineKo, taglineEn);
  const totalBorrows = cleanNumber(raw.totalBorrows);
  const perCallCredits = cleanNumber(raw.perCallCredits, entityKind === "team" ? 10 : 3);

  return {
    slug,
    name,
    nameEn: titleEn || name,
    tagline: taglineKo || taglineEn,
    taglineEn,
    trustGrade: "A",
    installCount: totalBorrows,
    manifestUrl: `https://agentlas.cloud/p/${slug}`,
    ownerName: cleanString(raw.ownerName),
    publishedAt: cleanIsoString(raw.publishedAt),
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    routingStatus: "public-profile",
    source: "hub-profile",
    entityKind,
    perCallCredits,
    verifiedInvocations: totalBorrows,
    totalBorrows,
    todayBorrows: cleanNumber(raw.todayBorrows),
    assetCount: cleanNumber(raw.assetCount),
    agentCount: cleanNumber(raw.agentCount, entityKind === "team" ? 1 : 0),
    lastRoutingSuccessAt: cleanIsoString(raw.lastBorrowedAt),
  };
}

function marketPublicPluginToListing(raw: Record<string, unknown>): MarketplaceListing | null {
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

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const url = `${this.opts.baseUrl}/tools/call`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? 15000);
    try {
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
      if (!resp.ok) throw new Error(`MCP ${method} ${resp.status}`);
      const json = (await resp.json()) as { result?: T; error?: { message: string } };
      if (json.error) throw new Error(`MCP ${method}: ${json.error.message}`);
      return json.result as T;
    } finally {
      clearTimeout(timer);
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
      const listings = normalizeListings(rawPlugins.map(marketPublicPluginToListing).filter((item): item is MarketplaceListing => Boolean(item)));
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
    const listings = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => (result.reason instanceof Error ? result.reason.message : String(result.reason)));
    const filtered = dedupeListings(listings).filter((listing) => matchesQuery(listing, q));
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
   *  서버는 query를 느슨히 적용하고 limit 상한이 작으므로 넉넉히 받아 client matchesQuery로 최종 필터한다.
   *  install-only 에이전트도 정당한 허브 결과이므로 liveHub 필터를 적용하지 않는다. */
  private async searchHubAgents(q: string): Promise<MarketplaceListing[]> {
    // 게이트웨이 스키마는 `q`(limit≤20)지만 `query`도 받는다 — 양쪽 모두 보내 안전하게.
    const raw = await this.call<unknown>("marketplace.search_agents", { query: q, q, limit: 60 });
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
  async listMyCloudPackages(): Promise<MarketplaceListing[]> {
    const raw = await this.call<unknown>("cargo.search_agents", {
      q: "",
      limit: 20,
      mine: true,
      scope: "cloud",
      verbose: true,
    });
    const rows = asArray<MarketplaceListing>(raw, "results", "agents", "listings")
      .map((row) => ({
        ...row,
        source: typeof row.source === "string" && row.source ? row.source : "cloud",
      }));
    return normalizeListings(rows);
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
    const raw = await this.call<unknown>("cargo.restore_package", { slug });
    const restored = normalizeOwnerRestorePayload(raw, slug);

    let metadata: (SeedListingFull & MarketplaceListing) | null = null;
    try {
      metadata = await this.getMyAgentManifest(slug);
    } catch {
      // Optional draft metadata must never prevent an already-authorized restore.
    }
    return restorePayloadToListing(restored, metadata, `${this.opts.baseUrl}/tools/call`);
  }
}
