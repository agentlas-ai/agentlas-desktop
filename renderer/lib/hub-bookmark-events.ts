import type { HubAgentBookmark, InstalledAgent, MarketplaceListing } from "./types";

export const HUB_BOOKMARKS_CHANGED_EVENT = "agentlas:hub-bookmarks-changed";

export type HubBookmarkChangeDetail =
  | { action: "added"; bookmark: HubAgentBookmark }
  | { action: "removed"; slug: string; entityKind?: string }
  | { action: "synced"; bookmarks: HubAgentBookmark[]; syncedAt?: string };

function normalizedSlug(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
}

function normalizedEntityKind(value: string | null | undefined): string {
  return String(value || "agent").trim().toLowerCase() || "agent";
}

export function hubBookmarkIdentityKeyFromParts(slug: string, entityKind?: string | null): string {
  return `${normalizedEntityKind(entityKind)}:${normalizedSlug(slug)}`;
}

export function hubListingIdentityKey(
  listing: Pick<MarketplaceListing, "slug" | "entityKind" | "agentCount" | "source">,
): string {
  const entityKind = listing.source === "hub-plugin" || listing.entityKind === "plugin"
    ? "plugin"
    : listing.entityKind === "team" || (typeof listing.agentCount === "number" && listing.agentCount > 1)
      ? "team"
      : "agent";
  return hubBookmarkIdentityKeyFromParts(listing.slug, entityKind);
}

export function hubBookmarkIdentityKey(bookmark: HubAgentBookmark): string {
  return hubListingIdentityKey({
    ...bookmark.listing,
    slug: bookmark.slug || bookmark.listing.slug,
  });
}

/**
 * A bookmark is a saved reference, not proof that the Hub can invoke it.
 * Keep call surfaces fail-closed: only an explicit callable=true record may be
 * bound to borrowAgents. install-only and routing-disabled records stay
 * visible in context, but never masquerade as callable agents.
 */
export function isVerifiedCallableHubBookmark(bookmark: HubAgentBookmark): boolean {
  const listing = bookmark.listing;
  return (
    listing.callable === true &&
    listing.kind !== "install-only" &&
    listing.entityKind !== "plugin" &&
    listing.source !== "hub-plugin" &&
    listing.routingReady !== false &&
    normalizedSlug(bookmark.slug || listing.slug).length > 0
  );
}

/** Local ownership wins over a same-slug Hub reference on every action surface. */
export function hubBookmarksWithoutLocalDuplicates(
  bookmarks: HubAgentBookmark[],
  localAgents: Array<Pick<InstalledAgent, "slug">> = [],
): HubAgentBookmark[] {
  const localSlugs = new Set(localAgents.map((agent) => normalizedSlug(agent.slug)).filter(Boolean));
  const seen = new Set<string>();
  return bookmarks.filter((bookmark) => {
    const slug = normalizedSlug(bookmark.slug || bookmark.listing.slug);
    const identity = hubBookmarkIdentityKey(bookmark);
    if (!slug || localSlugs.has(slug) || seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function callableHubBookmarks(
  bookmarks: HubAgentBookmark[],
  localAgents: Array<Pick<InstalledAgent, "slug">> = [],
): HubAgentBookmark[] {
  // Runtime invocation identity is globally slug-only today. The durable cache
  // keeps (entityKind, slug) distinct so neither asset is lost, but an agent and
  // team sharing one slug cannot be routed unambiguously. Exclude both from all
  // call surfaces until the runtime protocol gains an entity-kind identity.
  const entityKindsBySlug = new Map<string, Set<string>>();
  for (const bookmark of bookmarks) {
    const slug = normalizedSlug(bookmark.slug || bookmark.listing.slug);
    if (!slug) continue;
    const kinds = entityKindsBySlug.get(slug) ?? new Set<string>();
    kinds.add(String(bookmark.listing.entityKind || "agent").toLowerCase());
    entityKindsBySlug.set(slug, kinds);
  }
  const ambiguousSlugs = new Set(
    [...entityKindsBySlug.entries()]
      .filter(([, kinds]) => kinds.size > 1)
      .map(([slug]) => slug),
  );
  return hubBookmarksWithoutLocalDuplicates(bookmarks, localAgents)
    .filter((bookmark) => !ambiguousSlugs.has(normalizedSlug(bookmark.slug || bookmark.listing.slug)))
    .filter(isVerifiedCallableHubBookmark);
}

/**
 * Renderer-local bookmark synchronization.
 *
 * The durable source remains Electron's hub_agent_bookmarks table. This event
 * only lets mounted surfaces update immediately, then reconcile from IPC.
 */
export function announceHubBookmarkChange(detail: HubBookmarkChangeDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<HubBookmarkChangeDetail>(HUB_BOOKMARKS_CHANGED_EVENT, { detail }));
}

export function onHubBookmarkChange(listener: (detail: HubBookmarkChangeDetail) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<HubBookmarkChangeDetail>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(HUB_BOOKMARKS_CHANGED_EVENT, handle);
  return () => window.removeEventListener(HUB_BOOKMARKS_CHANGED_EVENT, handle);
}
