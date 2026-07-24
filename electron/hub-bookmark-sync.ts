import { BrowserWindow } from "electron";
import type { HubAgentBookmark, HubBookmarkSnapshotEvent, MarketplaceListing } from "../shared/types";
import {
  getAuthSession,
  getSessionCookieHeader,
  invalidateAuthSessionFromServer,
  webBaseUrl,
} from "./auth";
import {
  DEVICE_BOOKMARK_WORKSPACE_ID,
  activeHubBookmarkWorkspaceId,
  applyLiveHubBookmarkValidation,
  claimDeviceHubBookmarks,
  listHubAgentBookmarks,
  listHubAgentBookmarksForWorkspace,
  listHubBookmarkStoreRows,
  listingForHubBookmarkMutation,
  markHubBookmarkDeleteSynced,
  markHubBookmarkSyncError,
  markHubBookmarkUpsertSynced,
  reconcileHubBookmarkServerSnapshot,
  type HubBookmarkServerRecord,
  type HubBookmarkStoreRow,
} from "./store/hub-bookmarks";

export const HUB_BOOKMARKS_SNAPSHOT_CHANNEL = "marketplace:bookmarksSnapshot";
const DEFAULT_SYNC_TIMEOUT_MS = 10_000;

export interface HubBookmarkSyncContext {
  workspaceId: string;
  cookie: string;
}

export interface HubBookmarkSyncDependencies {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  broadcast?: (event: HubBookmarkSnapshotEvent) => void;
  /** Testable account-generation guard; production compares workspace + exact cookie. */
  isContextCurrent?: (context: HubBookmarkSyncContext) => boolean;
  /** Test seam for the exact-current authenticated GET 401 boundary. */
  onAuthenticatedSessionRejected?: (context: HubBookmarkSyncContext) => void;
}

type JsonRecord = Record<string, unknown>;

class HubBookmarkHttpError extends Error {
  constructor(readonly status: number) {
    super(`Hub bookmark request failed (${status})`);
    this.name = "HubBookmarkHttpError";
  }
}

function isCycleWideRequestFailure(error: unknown): boolean {
  return error instanceof HubBookmarkHttpError
    ? error.status === 401 || error.status === 403 || error.status === 408 || error.status === 429 || error.status >= 500
    : true;
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function entityKind(value: unknown): "agent" | "team" {
  return cleanString(value).toLowerCase() === "team" ? "team" : "agent";
}

function englishHubText(value: unknown, fallback: string): string {
  const clean = cleanString(value);
  return clean && !/[\uac00-\ud7af]/.test(clean) ? clean : fallback;
}

function serverBookmarkRecord(value: unknown): HubBookmarkServerRecord | null {
  const row = asRecord(value);
  if (!row) return null;
  const slug = cleanString(row.slug);
  const bookmarkedAt = cleanString(row.bookmarkedAt);
  const updatedAt = cleanString(row.updatedAt);
  if (!slug || !bookmarkedAt || !updatedAt) return null;
  return {
    slug,
    entityKind: entityKind(row.entityKind),
    ...(cleanString(row.title) ? { title: cleanString(row.title) } : {}),
    ...(cleanString(row.titleKo) ? { titleKo: cleanString(row.titleKo) } : {}),
    ...(cleanString(row.tagline) ? { tagline: cleanString(row.tagline) } : {}),
    ...(cleanString(row.taglineKo) ? { taglineKo: cleanString(row.taglineKo) } : {}),
    ...(cleanString(row.ownerName) ? { ownerName: cleanString(row.ownerName) } : {}),
    ...(cleanNumber(row.perCallCredits) !== undefined
      ? { perCallCredits: cleanNumber(row.perCallCredits) }
      : {}),
    bookmarkedAt,
    updatedAt,
  };
}

function publicHubRecordToListing(value: unknown): MarketplaceListing | null {
  const row = asRecord(value);
  if (!row) return null;
  const slug = cleanString(row.slug);
  if (!slug) return null;
  const kind = entityKind(row.entityKind ?? row.kind);
  const nameEn = englishHubText(row.titleEn, englishHubText(row.title, slug));
  const name = cleanString(row.titleKo) || cleanString(row.title) || nameEn;
  const taglineEn = englishHubText(row.taglineEn, englishHubText(row.tagline, "Hub profile"));
  const tagline = cleanString(row.taglineKo) || cleanString(row.tagline) || taglineEn;
  // The public profile's explicit callable bit is the only authority used here.
  // Presence in an index, a bookmark, or a previous local listing is not proof.
  const callable =
    row.callable === true &&
    row.routingReady !== false &&
    cleanString(row.deliveryKind) === "cloud-callable" &&
    cleanString(row.callTool) === "agentlas.get_runtime_bundle";
  const totalBorrows = cleanNumber(row.totalBorrows) ?? 0;
  return {
    slug,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: "unknown",
    installCount: totalBorrows,
    manifestUrl: cleanString(row.installHref) || `${webBaseUrl()}/p/${slug}`,
    ownerName: cleanString(row.ownerName) || undefined,
    publishedAt: cleanString(row.publishedAt) || undefined,
    kind: callable ? "cloud-callable" : "install-only",
    callable,
    routingReady: callable,
    routingStatus: callable
      ? "public-profile"
      : cleanString(row.availabilityReason) || "hub_profile_not_callable",
    source: "hub-profile",
    entityKind: kind,
    perCallCredits: cleanNumber(row.perCallCredits),
    verifiedInvocations: totalBorrows,
    totalBorrows,
    todayBorrows: cleanNumber(row.todayBorrows),
    assetCount: cleanNumber(row.assetCount),
    agentCount: cleanNumber(row.agentCount) ?? (kind === "team" ? 1 : 0),
    lastRoutingSuccessAt: cleanString(row.lastBorrowedAt) || undefined,
  };
}

function premiumTeamRecordToListing(value: unknown): MarketplaceListing | null {
  const row = asRecord(value);
  if (!row) return null;
  const slug = cleanString(row.slug);
  if (!slug) return null;
  const callTool = cleanString(row.callTool);
  const callable =
    row.invokable === true &&
    (callTool === "agentlas.teams.invoke" || callTool === "agentlas.get_runtime_bundle");
  const name = cleanString(row.name) || slug;
  const nameEn = englishHubText(row.nameEn, englishHubText(row.name, slug));
  const tagline = cleanString(row.tagline) || "Callable Hub team";
  const taglineEn = englishHubText(row.taglineEn, englishHubText(row.tagline, "Callable Hub team"));
  return {
    slug,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: "unknown",
    installCount: 0,
    manifestUrl: `${webBaseUrl()}/mcp/${slug}`,
    kind: callable ? "cloud-callable" : "install-only",
    callable,
    routingReady: callable,
    routingStatus: callable ? callTool : "premium_team_not_invokable",
    source: "hub-team-registry",
    entityKind: "team",
    perCallCredits: cleanNumber(row.perCallCredits),
    agentCount: cleanNumber(row.roles) ?? 1,
  };
}

function currentContext(): HubBookmarkSyncContext | null {
  const session = getAuthSession();
  const workspaceId = cleanString(session.workspaceId);
  const cookie = getSessionCookieHeader();
  return session.signedIn && workspaceId && cookie ? { workspaceId, cookie } : null;
}

function normalizedBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

async function fetchJson(
  url: string,
  init: RequestInit,
  deps: HubBookmarkSyncDependencies,
): Promise<unknown> {
  const controller = new AbortController();
  const timeoutMs = Math.max(250, deps.timeoutMs ?? DEFAULT_SYNC_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (deps.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new HubBookmarkHttpError(response.status);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function authenticatedHeaders(context: HubBookmarkSyncContext, baseUrl: string): Record<string, string> {
  return {
    accept: "application/json",
    cookie: context.cookie,
    origin: baseUrl,
  };
}

async function fetchServerSnapshot(
  context: HubBookmarkSyncContext,
  deps: HubBookmarkSyncDependencies,
): Promise<HubBookmarkServerRecord[]> {
  const baseUrl = normalizedBaseUrl(deps.baseUrl ?? webBaseUrl());
  const raw = await fetchJson(
    `${baseUrl}/api/agent-cloud/bookmarks`,
    {
      method: "GET",
      headers: authenticatedHeaders(context, baseUrl),
      cache: "no-store",
    },
    deps,
  );
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.bookmarks)) throw new Error("Invalid Hub bookmark snapshot");
  const records = root.bookmarks.map(serverBookmarkRecord);
  // A malformed member is not evidence that its cached counterpart was
  // deleted. Reject the whole canonical snapshot; only an explicitly valid
  // empty array may clear clean rows.
  if (records.some((record) => !record)) throw new Error("Invalid Hub bookmark snapshot member");
  return records as HubBookmarkServerRecord[];
}

async function postServerBookmark(
  context: HubBookmarkSyncContext,
  row: HubBookmarkStoreRow,
  deps: HubBookmarkSyncDependencies,
): Promise<HubBookmarkServerRecord> {
  const baseUrl = normalizedBaseUrl(deps.baseUrl ?? webBaseUrl());
  const listing = listingForHubBookmarkMutation(row);
  const raw = await fetchJson(
    `${baseUrl}/api/agent-cloud/bookmarks`,
    {
      method: "POST",
      headers: {
        ...authenticatedHeaders(context, baseUrl),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: row.slug,
        entityKind: row.entity_kind,
        title: listing.nameEn || listing.name || row.slug,
        titleKo: listing.name || listing.nameEn || row.slug,
        tagline: listing.taglineEn || listing.tagline,
        taglineKo: listing.tagline || listing.taglineEn,
        ownerName: listing.ownerName,
      }),
    },
    deps,
  );
  const record = serverBookmarkRecord(asRecord(raw)?.bookmark);
  if (!record || record.slug !== row.slug || record.entityKind !== row.entity_kind) {
    throw new Error("Invalid Hub bookmark upsert response");
  }
  return record;
}

async function deleteServerBookmark(
  context: HubBookmarkSyncContext,
  row: HubBookmarkStoreRow,
  deps: HubBookmarkSyncDependencies,
): Promise<void> {
  const baseUrl = normalizedBaseUrl(deps.baseUrl ?? webBaseUrl());
  await fetchJson(
    `${baseUrl}/api/agent-cloud/bookmarks/${encodeURIComponent(row.slug)}?entityKind=${encodeURIComponent(row.entity_kind)}`,
    {
      method: "DELETE",
      headers: authenticatedHeaders(context, baseUrl),
    },
    deps,
  );
}

async function flushOutbox(
  context: HubBookmarkSyncContext,
  deps: HubBookmarkSyncDependencies,
): Promise<"ok" | "auth-rejected"> {
  const pending = listHubBookmarkStoreRows(context.workspaceId, { includeDeleted: true })
    .filter((row) => row.sync_state !== "clean");
  for (const row of pending) {
    if (deps.isContextCurrent && !deps.isContextCurrent(context)) break;
    try {
      if (row.sync_state === "pending_upsert") {
        const record = await postServerBookmark(context, row, deps);
        markHubBookmarkUpsertSynced(context.workspaceId, row, record);
      } else if (row.sync_state === "pending_delete") {
        await deleteServerBookmark(context, row, deps);
        markHubBookmarkDeleteSynced(context.workspaceId, row);
      }
    } catch (error) {
      markHubBookmarkSyncError(context.workspaceId, row, error);
      if (
        error instanceof HubBookmarkHttpError &&
        error.status === 401 &&
        (!deps.isContextCurrent || deps.isContextCurrent(context))
      ) {
        if (deps.onAuthenticatedSessionRejected) deps.onAuthenticatedSessionRejected(context);
        else invalidateAuthSessionFromServer(context.cookie);
        return "auth-rejected";
      }
      // Auth/server/network failures apply to the whole cycle. Stop after the
      // first row instead of multiplying an outage into N sequential timeouts;
      // deterministic 4xx row errors remain isolated and the next row can sync.
      if (isCycleWideRequestFailure(error)) break;
    }
  }
  return "ok";
}

async function fetchFreshLiveHubListings(
  deps: HubBookmarkSyncDependencies,
): Promise<MarketplaceListing[]> {
  const baseUrl = normalizedBaseUrl(deps.baseUrl ?? webBaseUrl());
  const raw = await fetchJson(
    `${baseUrl}/api/marketplace/agents`,
    {
      method: "GET",
      headers: { accept: "application/json" },
      cache: "no-store",
    },
    deps,
  );
  const root = asRecord(raw);
  if (!root || !Array.isArray(root.agents)) throw new Error("Invalid live Hub listing snapshot");
  return root.agents
    .map(publicHubRecordToListing)
    .filter((listing): listing is MarketplaceListing => Boolean(listing));
}

async function fetchFreshPremiumTeamListings(
  deps: HubBookmarkSyncDependencies,
): Promise<MarketplaceListing[]> {
  const baseUrl = normalizedBaseUrl(deps.baseUrl ?? webBaseUrl());
  const raw = await fetchJson(
    `${baseUrl}/api/mcp/v1/tools/call`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "agentlas.teams.list_premium",
        arguments: {},
      }),
      cache: "no-store",
    },
    deps,
  );
  const result = asRecord(asRecord(raw)?.result);
  if (!result || !Array.isArray(result.teams)) throw new Error("Invalid premium Hub team snapshot");
  return result.teams
    .map(premiumTeamRecordToListing)
    .filter((listing): listing is MarketplaceListing => Boolean(listing));
}

async function fetchFreshLiveValidationListings(
  deps: HubBookmarkSyncDependencies,
): Promise<MarketplaceListing[] | null> {
  const results = await Promise.allSettled([
    fetchFreshLiveHubListings(deps),
    fetchFreshPremiumTeamListings(deps),
  ]);
  const fulfilled = results
    .filter((result): result is PromiseFulfilledResult<MarketplaceListing[]> => result.status === "fulfilled")
    .flatMap((result) => result.value);
  // Invocation is slug-only across both catalogs. If either authority is
  // unavailable we cannot prove the visible identity has no same-slug peer in
  // the missing source, so a partial snapshot must fail every bookmark closed.
  return results.every((result) => result.status === "fulfilled") ? fulfilled : null;
}

function operationalErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code ?? "unknown").slice(0, 80);
  }
  return error instanceof Error ? error.name.slice(0, 80) : "unknown";
}

export function broadcastHubBookmarkSnapshot(bookmarks?: HubAgentBookmark[]): void {
  let safeBookmarks: HubAgentBookmark[];
  try {
    safeBookmarks = bookmarks ?? listHubAgentBookmarks();
  } catch (error) {
    console.warn(`[hub-bookmarks] snapshot broadcast skipped (${operationalErrorCode(error)})`);
    return;
  }
  const event: HubBookmarkSnapshotEvent = {
    bookmarks: safeBookmarks,
    syncedAt: new Date().toISOString(),
  };
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      try {
        window.webContents.send(HUB_BOOKMARKS_SNAPSHOT_CHANNEL, event);
      } catch (error) {
        console.warn(`[hub-bookmarks] renderer snapshot skipped (${operationalErrorCode(error)})`);
      }
    }
  }
}

/**
 * Process/session activation boundary: persisted display cache is not current
 * invocation authority. Revoke callable bits synchronously before the first UI
 * snapshot; the next successful live validation promotes exact records again.
 */
export function failCloseActiveHubBookmarks(): void {
  try {
    const scope = activeHubBookmarkWorkspaceId();
    applyLiveHubBookmarkValidation(scope, null);
  } catch (error) {
    console.warn(`[hub-bookmarks] activation fail-close deferred (${operationalErrorCode(error)})`);
  }
}

/** One deterministic cycle, exported for temp-DB/mock-HTTP regression tests. */
export async function syncHubBookmarksForContext(
  context: HubBookmarkSyncContext | null,
  deps: HubBookmarkSyncDependencies = {},
): Promise<HubAgentBookmark[]> {
  const scope = context?.workspaceId || DEVICE_BOOKMARK_WORKSPACE_ID;

  // Start current Hub verification in parallel with the account snapshot. It
  // never authorizes a call unless this exact request succeeds and says true.
  const livePromise = fetchFreshLiveValidationListings(deps);

  if (context) {
    let allowOutboxFlush = true;
    try {
      const snapshot = await fetchServerSnapshot(context, deps);
      if (deps.isContextCurrent && !deps.isContextCurrent(context)) {
        return listHubAgentBookmarksForWorkspace(scope);
      }
      // A successfully parsed authenticated snapshot is the proof that this is
      // a real current workspace. Never lock device rows on 401/5xx/timeout or
      // a malformed response from a stale/discarded cookie.
      claimDeviceHubBookmarks(context.workspaceId);
      reconcileHubBookmarkServerSnapshot(context.workspaceId, snapshot);
    } catch (error) {
      const contextStillCurrent = !deps.isContextCurrent || deps.isContextCurrent(context);
      if (error instanceof HubBookmarkHttpError && error.status === 401 && contextStillCurrent) {
        if (deps.onAuthenticatedSessionRejected) deps.onAuthenticatedSessionRejected(context);
        else invalidateAuthSessionFromServer(context.cookie);
        return listHubAgentBookmarks();
      }
      if (!contextStillCurrent) return listHubAgentBookmarks();
      // Offline/timeout must preserve the last cache and every pending intent.
      allowOutboxFlush = !isCycleWideRequestFailure(error);
    }
    // Snapshot reconciliation runs before the outbox flush so a response
    // captured before a local mutation can never erase that pending mutation.
    if (allowOutboxFlush && await flushOutbox(context, deps) === "auth-rejected") {
      return listHubAgentBookmarks();
    }
  }

  const liveListings = await livePromise;
  applyLiveHubBookmarkValidation(scope, liveListings);
  const bookmarks = listHubAgentBookmarksForWorkspace(scope);
  deps.broadcast?.({ bookmarks, syncedAt: new Date().toISOString() });
  return bookmarks;
}

type SyncSlot = {
  rerun: boolean;
  promise: Promise<HubAgentBookmark[]>;
};

const syncSlots = new Map<string, SyncSlot>();
let installQuiescing = false;

/**
 * Main-owned production sync. Calls for the same account coalesce, but a local
 * mutation arriving during an in-flight pass requests one more pass so no
 * outbox row is stranded behind that pass.
 */
export function syncHubBookmarks(options: { rerunIfBusy?: boolean } = {}): Promise<HubAgentBookmark[]> {
  if (installQuiescing) {
    try {
      return Promise.resolve(listHubAgentBookmarks());
    } catch {
      return Promise.resolve([]);
    }
  }
  const context = currentContext();
  const key = context?.workspaceId || DEVICE_BOOKMARK_WORKSPACE_ID;
  const existing = syncSlots.get(key);
  if (existing) {
    if (options.rerunIfBusy) existing.rerun = true;
    return existing.promise;
  }

  const slot = {} as SyncSlot;
  slot.rerun = false;
  slot.promise = (async () => {
    try {
      let result: HubAgentBookmark[] = [];
      do {
        slot.rerun = false;
        const latestContext = currentContext();
        const latestKey = latestContext?.workspaceId || DEVICE_BOOKMARK_WORKSPACE_ID;
        if (latestKey !== key) break;
        result = await syncHubBookmarksForContext(latestContext, {
          isContextCurrent: (candidate) => {
            const active = currentContext();
            return active?.workspaceId === candidate.workspaceId && active.cookie === candidate.cookie;
          },
        });
      } while (slot.rerun);

      // Do not leak a completed account-A snapshot after the user switched to B.
      if (activeHubBookmarkWorkspaceId() === key) {
        broadcastHubBookmarkSnapshot(result);
        return result;
      }
      return listHubAgentBookmarks();
    } catch (error) {
      // Lifecycle callers intentionally fire-and-forget. A closing/locked DB or
      // transient reconcile error must never become an unhandled main-process
      // rejection (and the warning must not print cookies, payloads, or paths).
      console.warn(`[hub-bookmarks] sync deferred (${operationalErrorCode(error)})`);
      try {
        return listHubAgentBookmarks();
      } catch {
        return [];
      }
    }
  })().finally(() => {
    if (syncSlots.get(key) === slot) syncSlots.delete(key);
  });
  syncSlots.set(key, slot);
  return slot.promise;
}

/** Prevent new sync passes and resolve only after every in-flight DB mutation settles. */
export async function quiesceHubBookmarkSyncForUpdate(): Promise<() => void> {
  installQuiescing = true;
  const slots = [...syncSlots.values()];
  for (const slot of slots) slot.rerun = false;
  await Promise.all(slots.map((slot) => slot.promise));
  let resumed = false;
  return () => {
    if (resumed) return;
    resumed = true;
    installQuiescing = false;
  };
}
