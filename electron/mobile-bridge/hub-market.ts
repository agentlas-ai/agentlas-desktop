import { isPublicSourceDescriptor } from "../marketplace/public-install";
import { assertHubReleasePin, type HubReleasePin } from "../../shared/hub-release-pin";
import type { MarketplaceListing, MarketplaceSourceStatus } from "../../shared/types";
import type {
  MobileBridgeHubLeasePreviewDto,
  MobileBridgeHubMarketDetailDto,
  MobileBridgeHubMarketListingDto,
  MobileBridgeHubMarketSearchDto,
  MobileBridgeHubPermissionPolicyDto,
  MobileBridgeHubReleaseIdentityDto,
} from "../../shared/mobile-bridge";
import { getSource, refreshSourceStatus } from "../marketplace";
import type { MarketplaceSource, SeedListingFull } from "../marketplace/source";
import { getAgentLeaseQuote, type AgentLeaseQuote } from "../cloud-agents/leases";

const SEARCH_LIMIT_MAX = 30;
const TEXT_MAX = 512;
const POLICY_VALUE_MAX = 160;
const POLICY_VALUES_MAX = 32;

type DetailedListing = SeedListingFull & MarketplaceListing;

export interface MobileHubMarketServiceDependencies {
  source: Pick<MarketplaceSource, "searchAgents" | "getListingBySlug">;
  sourceStatus: () => Promise<Pick<MarketplaceSourceStatus, "online" | "usingFallback">>;
  leaseQuote: (slug: string) => Promise<AgentLeaseQuote>;
  now?: () => Date;
}

function safeText(value: unknown, max = TEXT_MAX): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").trim().slice(0, max);
}

function safeNullableText(value: unknown, max = TEXT_MAX): string | null {
  return safeText(value, max) || null;
}

function safeFinite(value: unknown, minimum: number, maximum: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < minimum || value > maximum) return null;
  return value;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = safeText(item, POLICY_VALUE_MAX);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (seen.size >= POLICY_VALUES_MAX) break;
  }
  return [...seen];
}

function permissionPolicy(value: unknown): MobileBridgeHubPermissionPolicyDto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const policy = {
    allow: stringList(record.allow),
    ask: stringList(record.ask),
    deny: stringList(record.deny),
  };
  return policy.allow.length || policy.ask.length || policy.deny.length ? policy : null;
}

function releaseIdentity(listing: MarketplaceListing): MobileBridgeHubReleaseIdentityDto | null {
  const agentDefinitionId = safeText(listing.agentDefinitionId, 160);
  const agentReleaseId = safeText(listing.agentReleaseId, 160);
  const packageHash = safeText(listing.packageHash, 160).toLowerCase();
  if (!agentDefinitionId || !agentReleaseId || !/^[a-f0-9]{64}$/u.test(packageHash)) return null;
  return { agentDefinitionId, agentReleaseId, packageHash };
}

function sameRelease(
  left: MobileBridgeHubReleaseIdentityDto,
  right: MobileBridgeHubReleaseIdentityDto,
): boolean {
  return left.agentDefinitionId === right.agentDefinitionId
    && left.agentReleaseId === right.agentReleaseId
    && left.packageHash === right.packageHash;
}

function isOwnerAsset(listing: MarketplaceListing): boolean {
  if (isPublicSourceDescriptor(listing)) return false;
  return listing.source === "agent-cloud-owner-restore"
    || listing.cloudPackage !== undefined
    || listing.cloudRegistration !== undefined
    || listing.cloudId !== undefined;
}

function isPublicCallableAgent(listing: MarketplaceListing): boolean {
  if (isOwnerAsset(listing)) return false;
  const entityKind = listing.entityKind === "team" ? "team" : listing.entityKind === "agent" || !listing.entityKind ? "agent" : null;
  if (!entityKind) return false;
  const liveSource = listing.source === "hub-index" || listing.source === "hub-profile";
  return listing.callable === true && (liveSource || listing.kind === "cloud-callable");
}

function isPublicInstallCandidate(listing: MarketplaceListing): boolean {
  if (isOwnerAsset(listing)) return false;
  if (listing.entityKind && listing.entityKind !== "agent" && listing.entityKind !== "team") return false;
  return isPublicSourceDescriptor(listing)
    || (listing.source === "hub-index" && listing.kind === "install-only"
      && typeof listing.packageHash === "string" && /^[a-f0-9]{64}$/iu.test(listing.packageHash));
}

function projectListing(
  listing: MarketplaceListing,
  declaredPermissions: unknown = (listing as MarketplaceListing & Record<string, unknown>).permissions,
): MobileBridgeHubMarketListingDto {
  const entityKind = listing.entityKind === "team" ? "team" : "agent";
  return {
    slug: safeText(listing.slug, 160),
    name: safeText(listing.name) || safeText(listing.slug, 160),
    nameEn: safeText(listing.nameEn) || safeText(listing.name) || safeText(listing.slug, 160),
    tagline: safeText(listing.tagline, 1_000),
    taglineEn: safeText(listing.taglineEn, 1_000) || safeText(listing.tagline, 1_000),
    entityKind,
    trustGrade: listing.trustGrade === "A" || listing.trustGrade === "B" || listing.trustGrade === "C"
      ? listing.trustGrade
      : "unknown",
    ownerName: safeNullableText(listing.ownerName, 160),
    category: safeNullableText(listing.category, 120),
    callable: listing.callable === true,
    // Retired Hub prices remain a zero-valued compatibility field.
    perCallCredits: 0,
    verifiedInvocations: safeFinite(listing.verifiedInvocations, 0, Number.MAX_SAFE_INTEGER),
    rating: safeFinite(listing.rating, 0, 5),
    release: releaseIdentity(listing),
    permissions: permissionPolicy(declaredPermissions),
  };
}

export class MobileHubMarketService {
  private readonly now: () => Date;

  constructor(private readonly deps: MobileHubMarketServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  private checkedAt(): string {
    return this.now().toISOString();
  }

  async search(query: string, requestedLimit = 20): Promise<MobileBridgeHubMarketSearchDto> {
    const normalizedQuery = safeText(query, 200);
    const limit = Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(requestedLimit) || 20));
    const rows = await this.deps.source.searchAgents(normalizedQuery);
    const seen = new Set<string>();
    const items: MobileBridgeHubMarketListingDto[] = [];
    for (const row of rows) {
      if (!isPublicCallableAgent(row) && !isPublicInstallCandidate(row)) continue;
      const projected = projectListing(row);
      const key = `${projected.entityKind}:${projected.slug.toLowerCase()}`;
      if (!projected.slug || seen.has(key)) continue;
      seen.add(key);
      items.push(projected);
      if (items.length >= limit) break;
    }
    const sourceStatus = await this.deps.sourceStatus();
    const sourceOnline = sourceStatus.online === true;
    const freshness = sourceStatus.usingFallback === true || (!sourceOnline && items.length > 0)
      ? "stale" as const
      : null;
    return {
      schemaVersion: 1,
      status: items.length > 0 ? "ready" : sourceOnline ? "empty" : "unavailable",
      query: normalizedQuery,
      items,
      sourceOnline,
      freshness,
      checkedAt: this.checkedAt(),
    };
  }

  async detail(slugInput: string): Promise<MobileBridgeHubMarketDetailDto> {
    const slug = safeText(slugInput, 160).toLowerCase();
    const [manifest, searchRows] = await Promise.all([
      this.deps.source.getListingBySlug(slug),
      this.deps.source.searchAgents(slug),
    ]);
    const search = searchRows.find((row) => safeText(row.slug, 160).toLowerCase() === slug
      && (isPublicCallableAgent(row) || isPublicInstallCandidate(row))) ?? null;
    if (!manifest && !search) {
      const online = (await this.deps.sourceStatus()).online === true;
      return { schemaVersion: 1, status: online ? "not-found" : "unavailable", listing: null, checkedAt: this.checkedAt() };
    }
    if ((manifest && isOwnerAsset(manifest)) || (!search && manifest && !releaseIdentity(manifest))) {
      return { schemaVersion: 1, status: "unavailable", listing: null, checkedAt: this.checkedAt() };
    }
    const manifestIdentity = manifest ? releaseIdentity(manifest) : null;
    const searchIdentity = search ? releaseIdentity(search) : null;
    if (manifestIdentity && searchIdentity && !sameRelease(manifestIdentity, searchIdentity)) {
      return { schemaVersion: 1, status: "identity-conflict", listing: null, checkedAt: this.checkedAt() };
    }
    const merged = {
      ...(manifest ?? {}),
      ...(search ?? {}),
      slug,
      callable: search?.callable === true || manifest?.callable === true,
      kind: search?.kind ?? manifest?.kind,
      source: manifest && isPublicSourceDescriptor(manifest) ? manifest.source : search?.source ?? manifest?.source,
      agentDefinitionId: manifestIdentity?.agentDefinitionId ?? searchIdentity?.agentDefinitionId,
      agentReleaseId: manifestIdentity?.agentReleaseId ?? searchIdentity?.agentReleaseId,
      packageHash: manifestIdentity?.packageHash ?? searchIdentity?.packageHash,
    } as MarketplaceListing;
    const sourceInstallAvailable = Boolean(manifest && isPublicSourceDescriptor(manifest)
      && manifestIdentity && sameRelease(manifestIdentity, releaseIdentity(merged)!)
      && manifest.cloudPackage?.packageHash === manifestIdentity.packageHash);
    if (!isPublicCallableAgent(merged) && !sourceInstallAvailable) {
      return { schemaVersion: 1, status: "unavailable", listing: null, checkedAt: this.checkedAt() };
    }
    const rawManifest = manifest as (DetailedListing & Record<string, unknown>) | null;
    return {
      schemaVersion: 1,
      status: "ready",
      listing: projectListing(merged, rawManifest?.permissions),
      sourceInstallAvailable,
      checkedAt: this.checkedAt(),
    };
  }

  async requireCurrentRelease(
    slug: string,
    entityKind: "agent" | "team",
    release: HubReleasePin,
    action: "invoke" | "install" = "invoke",
  ): Promise<void> {
    const detail = await this.detail(slug);
    if (detail.status !== "ready" || !detail.listing || detail.listing.entityKind !== entityKind
      || detail.listing.slug !== slug
      || (action === "install" ? !detail.sourceInstallAvailable : !detail.listing.callable)) {
      throw new Error("hub_public_release_unavailable");
    }
    assertHubReleasePin(release, detail.listing.release);
    const status = await this.deps.sourceStatus();
    if (!status.online || status.usingFallback) throw new Error("hub_public_source_unavailable");
  }

  async leasePreview(slug: string): Promise<MobileBridgeHubLeasePreviewDto> {
    const detail = await this.detail(slug);
    const listing = detail.listing;
    if (!listing) {
      return {
        schemaVersion: 1,
        status: "unavailable",
        listing: null,
        lease: null,
        checkedAt: detail.checkedAt,
        explicitConfirmationRequired: true,
        purchaseAuthorized: false,
      };
    }
    if (!listing.release || listing.entityKind !== "agent") {
      return {
        schemaVersion: 1,
        status: "exact-release-required",
        listing,
        lease: null,
        checkedAt: this.checkedAt(),
        explicitConfirmationRequired: true,
        purchaseAuthorized: false,
      };
    }
    const quote = await this.deps.leaseQuote(listing.slug);
    return {
      schemaVersion: 1,
      status: quote.ok ? "ready" : "unavailable",
      listing,
      lease: {
        offered: quote.leaseOffered === true,
        active: quote.active === true,
        perDayCredits: safeFinite(quote.perDayCredits, 0, 1_000_000),
        leasedUntil: safeNullableText(quote.leasedUntil, 80),
        code: safeNullableText(quote.code, 80),
      },
      checkedAt: this.checkedAt(),
      explicitConfirmationRequired: true,
      // The existing quote endpoint has no immutable quote ID or quote expiry.
      // This read receipt must never be accepted as purchase authorization.
      purchaseAuthorized: false,
    };
  }
}

export function createDesktopMobileHubMarketService(): MobileHubMarketService {
  return new MobileHubMarketService({
    source: getSource(),
    sourceStatus: () => refreshSourceStatus(false),
    leaseQuote: getAgentLeaseQuote,
  });
}
