import type { HubAgentBookmark, MarketplaceListing } from "../../shared/types";
import { getDb } from "./db";

interface HubBookmarkRow {
  slug: string;
  listing_json: string;
  bookmarked_at: string;
}

const WEB_MASTER_SLUG = "web-master";
const WEB_MASTER_LEGACY_SLUG = "web-app-design-master";
const WEB_MASTER_NAME_KO = "웹앱 디자인 마스터";
const WEB_MASTER_NAME_EN = "Web App Design Master";
const WEB_MASTER_TAGLINE_KO =
  "기존 Web_master를 덮어쓰는 디자인·프런트엔드 전문 팀. 리서치, 디자인 시스템, React/HTML/CSS 구현, 모바일 UI, 카피, 브라우저 검증을 한 번에 묶는다.";
const WEB_MASTER_TAGLINE_EN =
  "A design and frontend specialist team replacing the old Web_master package: research, design systems, React/HTML/CSS implementation, mobile UI, copy, and browser proof in one workflow.";

function normalizeWebMasterListing(input: MarketplaceListing): MarketplaceListing {
  const slug = String(input.slug || "").trim();
  if (slug !== WEB_MASTER_SLUG && slug !== WEB_MASTER_LEGACY_SLUG) return input;
  return {
    ...input,
    slug: WEB_MASTER_SLUG,
    name: WEB_MASTER_NAME_KO,
    nameEn: WEB_MASTER_NAME_EN,
    tagline: WEB_MASTER_TAGLINE_KO,
    taglineEn: WEB_MASTER_TAGLINE_EN,
    kind: input.kind || "cloud-callable",
    callable: input.callable ?? true,
    routingReady: input.routingReady ?? true,
    routingStatus: input.routingStatus || "public-profile",
    source: input.source || "hub-profile",
    entityKind: "team",
    perCallCredits: typeof input.perCallCredits === "number" ? input.perCallCredits : 10,
    manifestUrl: input.manifestUrl || `https://agentlas.cloud/p/${WEB_MASTER_SLUG}`,
  };
}

function normalizeListing(input: MarketplaceListing): MarketplaceListing {
  const normalized = normalizeWebMasterListing(input);
  const entityKind =
    normalized.source === "hub-plugin" || normalized.entityKind === "plugin"
      ? "plugin"
      : normalized.entityKind === "team" || (typeof normalized.agentCount === "number" && normalized.agentCount > 1)
        ? "team"
        : "agent";
  return {
    ...normalized,
    entityKind,
  };
}

function rowToBookmark(row: HubBookmarkRow): HubAgentBookmark | null {
  try {
    const listing = normalizeListing(JSON.parse(row.listing_json) as MarketplaceListing);
    if (!listing?.slug) return null;
    return {
      slug: listing.slug,
      listing,
      bookmarkedAt: row.bookmarked_at,
    };
  } catch {
    return null;
  }
}

export function listHubAgentBookmarks(): HubAgentBookmark[] {
  const rows = getDb()
    .prepare("SELECT slug, listing_json, bookmarked_at FROM hub_agent_bookmarks ORDER BY bookmarked_at DESC")
    .all() as HubBookmarkRow[];
  const bookmarks = rows.map(rowToBookmark).filter((item): item is HubAgentBookmark => Boolean(item));
  const bySlug = new Map<string, HubAgentBookmark>();
  for (const bookmark of bookmarks) {
    if (!bySlug.has(bookmark.slug)) bySlug.set(bookmark.slug, bookmark);
  }
  return Array.from(bySlug.values());
}

export function addHubAgentBookmark(input: MarketplaceListing): HubAgentBookmark {
  const listing = normalizeListing(input);
  const slug = listing.slug.trim();
  if (!slug) throw new Error("Hub bookmark slug is required.");
  const bookmarkedAt = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO hub_agent_bookmarks (slug, entity_kind, listing_json, bookmarked_at)
       VALUES (@slug, @entityKind, @listingJson, @bookmarkedAt)
       ON CONFLICT(slug) DO UPDATE SET
         entity_kind = excluded.entity_kind,
         listing_json = excluded.listing_json,
         bookmarked_at = excluded.bookmarked_at`,
    )
    .run({
      slug,
      entityKind: listing.entityKind ?? "agent",
      listingJson: JSON.stringify(listing),
      bookmarkedAt,
    });
  return { slug, listing, bookmarkedAt };
}

export function removeHubAgentBookmark(slug: string): void {
  const normalized = slug.trim();
  if (!normalized) return;
  getDb().prepare("DELETE FROM hub_agent_bookmarks WHERE slug = ?").run(normalized);
}
