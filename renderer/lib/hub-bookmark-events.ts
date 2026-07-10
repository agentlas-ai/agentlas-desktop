import type { HubAgentBookmark, InstalledAgent } from "./types";

export const HUB_BOOKMARKS_CHANGED_EVENT = "agentlas:hub-bookmarks-changed";

export type HubBookmarkChangeDetail =
  | { action: "added"; bookmark: HubAgentBookmark }
  | { action: "removed"; slug: string };

function normalizedSlug(value: string | null | undefined): string {
  return String(value ?? "").trim().toLowerCase();
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
    if (!slug || localSlugs.has(slug) || seen.has(slug)) return false;
    seen.add(slug);
    return true;
  });
}

export function callableHubBookmarks(
  bookmarks: HubAgentBookmark[],
  localAgents: Array<Pick<InstalledAgent, "slug">> = [],
): HubAgentBookmark[] {
  return hubBookmarksWithoutLocalDuplicates(bookmarks, localAgents).filter(isVerifiedCallableHubBookmark);
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
