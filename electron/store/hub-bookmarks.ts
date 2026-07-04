import type { HubAgentBookmark, MarketplaceListing } from "../../shared/types";
import { getDb } from "./db";

interface HubBookmarkRow {
  slug: string;
  listing_json: string;
  bookmarked_at: string;
}

function normalizeListing(input: MarketplaceListing): MarketplaceListing {
  const entityKind =
    input.source === "hub-plugin" || input.entityKind === "plugin"
      ? "plugin"
      : input.entityKind === "team" || (typeof input.agentCount === "number" && input.agentCount > 1)
        ? "team"
        : "agent";
  return {
    ...input,
    entityKind,
  };
}

function rowToBookmark(row: HubBookmarkRow): HubAgentBookmark | null {
  try {
    const listing = JSON.parse(row.listing_json) as MarketplaceListing;
    if (!listing?.slug) return null;
    return {
      slug: row.slug,
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
  return rows.map(rowToBookmark).filter((item): item is HubAgentBookmark => Boolean(item));
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
