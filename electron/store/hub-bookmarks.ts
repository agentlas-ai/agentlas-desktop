import type { HubAgentBookmark, MarketplaceListing } from "../../shared/types";
import { getAuthSession, getSessionCookieHeader } from "../auth";
import { getDb } from "./db";

export const DEVICE_BOOKMARK_WORKSPACE_ID = "__device__";

export type HubBookmarkSyncState = "clean" | "pending_upsert" | "pending_delete";

export interface HubBookmarkServerRecord {
  slug: string;
  entityKind: "agent" | "team";
  title?: string;
  titleKo?: string;
  tagline?: string;
  taglineKo?: string;
  ownerName?: string;
  perCallCredits?: number;
  agentDefinitionId?: string;
  agentReleaseId?: string;
  bookmarkedAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  bookmarked?: boolean;
}

export interface HubBookmarkStoreRow {
  workspace_id: string;
  slug: string;
  entity_kind: string;
  listing_json: string;
  bookmarked_at: string;
  server_updated_at: string | null;
  sync_state: HubBookmarkSyncState;
  last_sync_error: string | null;
  claim_workspace_id: string | null;
}

const WEB_MASTER_SLUG = "web-master";
const WEB_MASTER_LEGACY_SLUG = "web-app-design-master";
const WEB_MASTER_NAME_KO = "웹앱 디자인 마스터";
const WEB_MASTER_NAME_EN = "Web App Design Master";
const WEB_MASTER_TAGLINE_KO =
  "기존 Web_master를 덮어쓰는 디자인·프런트엔드 전문 팀. 리서치, 디자인 시스템, React/HTML/CSS 구현, 모바일 UI, 카피, 브라우저 검증을 한 번에 묶는다.";
const WEB_MASTER_TAGLINE_EN =
  "A design and frontend specialist team replacing the old Web_master package: research, design systems, React/HTML/CSS implementation, mobile UI, copy, and browser proof in one workflow.";

function normalizeEntityKind(value: unknown): string {
  const kind = String(value ?? "").trim().toLowerCase();
  if (kind === "team" || kind === "plugin") return kind;
  return "agent";
}

function isServerSyncableEntityKind(value: string): value is "agent" | "team" {
  return value === "agent" || value === "team";
}

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
    entityKind: "team",
    perCallCredits: typeof input.perCallCredits === "number" ? input.perCallCredits : 10,
    manifestUrl: input.manifestUrl || `https://agentlas.cloud/p/${WEB_MASTER_SLUG}`,
  };
}

export function normalizeHubBookmarkListing(input: MarketplaceListing): MarketplaceListing {
  const normalized = normalizeWebMasterListing(input);
  const entityKind =
    normalized.source === "hub-plugin" || normalized.entityKind === "plugin"
      ? "plugin"
      : normalized.entityKind === "team" || (typeof normalized.agentCount === "number" && normalized.agentCount > 1)
        ? "team"
        : "agent";
  return {
    ...normalized,
    slug: String(normalized.slug ?? "").trim(),
    entityKind,
  };
}

export function failClosedHubBookmarkListing(input: MarketplaceListing): MarketplaceListing {
  const listing = normalizeHubBookmarkListing(input);
  if (listing.entityKind === "plugin") {
    return {
      ...listing,
      callable: false,
      routingReady: false,
    };
  }
  return {
    ...listing,
    kind: "install-only",
    callable: false,
    routingReady: false,
    routingStatus: "bookmark_snapshot_unverified",
    source: "bookmark",
  };
}

function serverRecordToListing(record: HubBookmarkServerRecord): MarketplaceListing {
  const nameEn = record.title || record.slug;
  const name = record.titleKo || record.title || record.slug;
  const taglineEn = record.tagline || "Saved Hub reference";
  const tagline = record.taglineKo || record.tagline || taglineEn;
  return failClosedHubBookmarkListing({
    slug: record.slug,
    name,
    nameEn,
    tagline,
    taglineEn,
    trustGrade: "unknown",
    installCount: 0,
    manifestUrl: `https://agentlas.cloud/p/${record.slug}`,
    ownerName: record.ownerName,
    kind: "install-only",
    callable: false,
    routingReady: false,
    routingStatus: "bookmark_snapshot_unverified",
    source: "bookmark",
    entityKind: record.entityKind,
    perCallCredits: record.perCallCredits,
    agentDefinitionId: record.agentDefinitionId,
    agentReleaseId: record.agentReleaseId,
    bookmarkState: record.bookmarked === false ? "used" : "bookmarked",
  });
}

function listingFromRow(row: HubBookmarkStoreRow): MarketplaceListing {
  try {
    const parsed = normalizeHubBookmarkListing(JSON.parse(row.listing_json) as MarketplaceListing);
    return {
      ...parsed,
      slug: row.slug,
      entityKind: normalizeEntityKind(row.entity_kind),
    };
  } catch {
    return failClosedHubBookmarkListing({
      slug: row.slug,
      name: row.slug,
      nameEn: row.slug,
      tagline: "Saved Hub reference",
      taglineEn: "Saved Hub reference",
      trustGrade: "unknown",
      installCount: 0,
      manifestUrl: `https://agentlas.cloud/p/${row.slug}`,
      entityKind: normalizeEntityKind(row.entity_kind),
    });
  }
}

function rowToBookmark(row: HubBookmarkStoreRow): HubAgentBookmark {
  const listing = listingFromRow(row);
  return {
    slug: row.slug,
    listing,
    bookmarkedAt: row.bookmarked_at,
    bookmarked: listing.bookmarkState !== "used",
  };
}

function normalizedWorkspaceId(value: string): string {
  const workspaceId = String(value ?? "").trim();
  return workspaceId || DEVICE_BOOKMARK_WORKSPACE_ID;
}

export function activeHubBookmarkWorkspaceId(): string {
  const session = getAuthSession();
  const workspaceId = String(session.workspaceId ?? "").trim();
  // The cookie is the actual Web authorization. E2E/session-shaped renderer
  // fixtures without a cookie must never accidentally address a real account.
  if (session.signedIn && workspaceId && getSessionCookieHeader()) return workspaceId;
  return DEVICE_BOOKMARK_WORKSPACE_ID;
}

function identityKey(slug: string, entityKind: string): string {
  return `${normalizeEntityKind(entityKind)}\u0000${String(slug ?? "").trim().toLowerCase()}`;
}

export function listHubBookmarkStoreRows(
  workspaceId: string,
  options: { includeDeleted?: boolean } = {},
): HubBookmarkStoreRow[] {
  const rows = getDb()
    .prepare(
      `SELECT workspace_id, slug, entity_kind, listing_json, bookmarked_at,
              server_updated_at, sync_state, last_sync_error, claim_workspace_id
       FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId
         ${options.includeDeleted ? "" : "AND sync_state <> 'pending_delete'"}
       ORDER BY bookmarked_at DESC, entity_kind ASC, slug ASC`,
    )
    .all({ workspaceId: normalizedWorkspaceId(workspaceId) }) as HubBookmarkStoreRow[];
  return rows;
}

export function listHubAgentBookmarksForWorkspace(workspaceId: string): HubAgentBookmark[] {
  return listHubBookmarkStoreRows(workspaceId).map(rowToBookmark);
}

export function listHubAgentBookmarks(): HubAgentBookmark[] {
  return listHubAgentBookmarksForWorkspace(activeHubBookmarkWorkspaceId());
}

export function addHubAgentBookmarkForWorkspace(
  input: MarketplaceListing,
  workspaceId: string,
): HubAgentBookmark {
  const normalized = normalizeHubBookmarkListing(input);
  const slug = normalized.slug.trim();
  if (!slug) throw new Error("Hub bookmark slug is required.");
  const scope = normalizedWorkspaceId(workspaceId);
  const entityKind = normalizeEntityKind(normalized.entityKind);
  // Renderer marketplace data is display input, never invocation authority.
  // Every new reference is visible immediately but starts fail-closed; only a
  // fresh main-owned Hub validation cycle may promote it to callable.
  const listing = failClosedHubBookmarkListing({
    ...normalized,
    slug,
    entityKind,
  });
  const serverSyncable = scope !== DEVICE_BOOKMARK_WORKSPACE_ID && isServerSyncableEntityKind(entityKind);
  const bookmarkedAt = new Date().toISOString();
  const syncState: HubBookmarkSyncState = serverSyncable ? "pending_upsert" : "clean";
  getDb()
    .prepare(
      `INSERT INTO hub_agent_bookmarks (
         workspace_id, slug, entity_kind, listing_json, bookmarked_at,
         server_updated_at, sync_state, last_sync_error, claim_workspace_id
       ) VALUES (
         @workspaceId, @slug, @entityKind, @listingJson, @bookmarkedAt,
         NULL, @syncState, NULL, NULL
       )
       ON CONFLICT(workspace_id, entity_kind, slug) DO UPDATE SET
         listing_json = excluded.listing_json,
         bookmarked_at = excluded.bookmarked_at,
         sync_state = excluded.sync_state,
         last_sync_error = NULL`,
    )
    .run({
      workspaceId: scope,
      slug,
      entityKind,
      listingJson: JSON.stringify(listing),
      bookmarkedAt,
      syncState,
    });
  return { slug, listing, bookmarkedAt };
}

export function addHubAgentBookmark(input: MarketplaceListing): HubAgentBookmark {
  return addHubAgentBookmarkForWorkspace(input, activeHubBookmarkWorkspaceId());
}

export function removeHubAgentBookmarkForWorkspace(
  slug: string,
  entityKind: string | undefined,
  workspaceId: string,
): void {
  const normalizedSlug = String(slug ?? "").trim();
  if (!normalizedSlug) return;
  const scope = normalizedWorkspaceId(workspaceId);
  const normalizedKind = entityKind ? normalizeEntityKind(entityKind) : null;
  const params = { workspaceId: scope, slug: normalizedSlug, entityKind: normalizedKind };
  const kindClause = normalizedKind ? "AND entity_kind = @entityKind" : "";
  if (scope === DEVICE_BOOKMARK_WORKSPACE_ID) {
    getDb()
      .prepare(
        `DELETE FROM hub_agent_bookmarks
         WHERE workspace_id = @workspaceId AND slug = @slug ${kindClause}`,
      )
      .run(params);
    return;
  }

  // Plugins are local installation references; the Web bookmark API supports
  // only agents/teams, so they remain account-isolated local rows.
  getDb()
    .prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId AND slug = @slug ${kindClause}
         AND entity_kind NOT IN ('agent', 'team')`,
    )
    .run(params);
  getDb()
    .prepare(
      `UPDATE hub_agent_bookmarks
       SET sync_state = 'pending_delete', last_sync_error = NULL
       WHERE workspace_id = @workspaceId AND slug = @slug ${kindClause}
         AND entity_kind IN ('agent', 'team')`,
    )
    .run(params);
}

export function removeHubAgentBookmark(slug: string, entityKind?: string): void {
  removeHubAgentBookmarkForWorkspace(slug, entityKind, activeHubBookmarkWorkspaceId());
}

/**
 * Locks legacy device bookmarks to the first signed-in workspace, while
 * retaining the device copy until the corresponding Web POST succeeds.
 */
export function claimDeviceHubBookmarks(workspaceId: string): number {
  const scope = normalizedWorkspaceId(workspaceId);
  if (scope === DEVICE_BOOKMARK_WORKSPACE_ID) return 0;
  const db = getDb();
  return db.transaction(() => {
    db.prepare(
      `UPDATE hub_agent_bookmarks
       SET claim_workspace_id = @workspaceId
       WHERE workspace_id = @deviceWorkspaceId
         AND entity_kind IN ('agent', 'team', 'plugin')
         AND claim_workspace_id IS NULL`,
    ).run({ workspaceId: scope, deviceWorkspaceId: DEVICE_BOOKMARK_WORKSPACE_ID });

    const deviceRows = db
      .prepare(
        `SELECT workspace_id, slug, entity_kind, listing_json, bookmarked_at,
                server_updated_at, sync_state, last_sync_error, claim_workspace_id
         FROM hub_agent_bookmarks
         WHERE workspace_id = @deviceWorkspaceId
           AND entity_kind IN ('agent', 'team', 'plugin')
           AND claim_workspace_id = @workspaceId`,
      )
      .all({ workspaceId: scope, deviceWorkspaceId: DEVICE_BOOKMARK_WORKSPACE_ID }) as HubBookmarkStoreRow[];

    const getExisting = db.prepare(
      `SELECT sync_state
       FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug`,
    );
    const insertClaim = db.prepare(
      `INSERT INTO hub_agent_bookmarks (
         workspace_id, slug, entity_kind, listing_json, bookmarked_at,
         server_updated_at, sync_state, last_sync_error, claim_workspace_id
       ) VALUES (
         @workspaceId, @slug, @entityKind, @listingJson, @bookmarkedAt,
         NULL, 'pending_upsert', NULL, NULL
       )`,
    );
    const retryClaim = db.prepare(
      `UPDATE hub_agent_bookmarks
       SET sync_state = 'pending_upsert', last_sync_error = NULL
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug`,
    );
    const deleteDevice = db.prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @deviceWorkspaceId AND entity_kind = @entityKind AND slug = @slug`,
    );

    let claimed = 0;
    for (const row of deviceRows) {
      const params = {
        workspaceId: scope,
        deviceWorkspaceId: DEVICE_BOOKMARK_WORKSPACE_ID,
        slug: row.slug,
        entityKind: row.entity_kind,
        listingJson: row.listing_json,
        bookmarkedAt: row.bookmarked_at,
      };
      const existing = getExisting.get(params) as { sync_state: HubBookmarkSyncState } | undefined;
      if (row.entity_kind === "plugin") {
        if (!existing) {
          db.prepare(
            `INSERT INTO hub_agent_bookmarks (
               workspace_id, slug, entity_kind, listing_json, bookmarked_at,
               server_updated_at, sync_state, last_sync_error, claim_workspace_id
             ) VALUES (
               @workspaceId, @slug, @entityKind, @listingJson, @bookmarkedAt,
               NULL, 'clean', NULL, NULL
             )`,
          ).run(params);
        }
        // The Web API intentionally has no plugin bookmark contract. Once a
        // valid authenticated snapshot proves the workspace, preserve the
        // legacy plugin as an account-isolated clean local row and finish the
        // device move without a server POST.
        deleteDevice.run(params);
        claimed += 1;
        continue;
      }
      if (existing?.sync_state === "pending_delete") {
        deleteDevice.run(params);
        continue;
      }
      if (existing) retryClaim.run(params);
      else insertClaim.run(params);
      claimed += 1;
    }
    return claimed;
  })();
}

export function reconcileHubBookmarkServerSnapshot(
  workspaceId: string,
  records: HubBookmarkServerRecord[],
): void {
  const scope = normalizedWorkspaceId(workspaceId);
  if (scope === DEVICE_BOOKMARK_WORKSPACE_ID) return;
  const byIdentity = new Map<string, HubBookmarkServerRecord>();
  for (const record of records) {
    const slug = String(record.slug ?? "").trim();
    if (!slug) continue;
    byIdentity.set(identityKey(slug, record.entityKind), { ...record, slug });
  }

  const db = getDb();
  db.transaction(() => {
    const existingRows = listHubBookmarkStoreRows(scope, { includeDeleted: true });
    const removeClean = db.prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug
         AND sync_state = 'clean'`,
    );
    for (const row of existingRows) {
      if (!isServerSyncableEntityKind(row.entity_kind)) continue;
      if (row.sync_state !== "clean") continue;
      if (!byIdentity.has(identityKey(row.slug, row.entity_kind))) {
        removeClean.run({ workspaceId: scope, entityKind: row.entity_kind, slug: row.slug });
      }
    }

    const findState = db.prepare(
      `SELECT sync_state
       FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug`,
    );
    const upsertClean = db.prepare(
      `INSERT INTO hub_agent_bookmarks (
         workspace_id, slug, entity_kind, listing_json, bookmarked_at,
         server_updated_at, sync_state, last_sync_error, claim_workspace_id
       ) VALUES (
         @workspaceId, @slug, @entityKind, @listingJson, @bookmarkedAt,
         @serverUpdatedAt, 'clean', NULL, NULL
       )
       ON CONFLICT(workspace_id, entity_kind, slug) DO UPDATE SET
         listing_json = excluded.listing_json,
         bookmarked_at = excluded.bookmarked_at,
         server_updated_at = excluded.server_updated_at,
         sync_state = 'clean',
         last_sync_error = NULL`,
    );
    for (const record of byIdentity.values()) {
      const params = {
        workspaceId: scope,
        slug: record.slug,
        entityKind: record.entityKind,
        listingJson: JSON.stringify(serverRecordToListing(record)),
        bookmarkedAt: record.bookmarkedAt,
        serverUpdatedAt: record.updatedAt,
      };
      const existing = findState.get(params) as { sync_state: HubBookmarkSyncState } | undefined;
      if (existing && existing.sync_state !== "clean") continue;
      upsertClean.run(params);
    }
  })();
}

export function markHubBookmarkUpsertSynced(
  workspaceId: string,
  row: HubBookmarkStoreRow,
  record: HubBookmarkServerRecord,
): void {
  const scope = normalizedWorkspaceId(workspaceId);
  const db = getDb();
  db.transaction(() => {
    const result = db.prepare(
      `UPDATE hub_agent_bookmarks
       SET listing_json = @listingJson,
           bookmarked_at = @bookmarkedAt,
           server_updated_at = @serverUpdatedAt,
           sync_state = 'clean',
           last_sync_error = NULL
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug
         AND sync_state = 'pending_upsert'
         AND bookmarked_at = @expectedBookmarkedAt
         AND listing_json = @expectedListingJson`,
    ).run({
      workspaceId: scope,
      slug: row.slug,
      entityKind: row.entity_kind,
      listingJson: JSON.stringify(serverRecordToListing(record)),
      bookmarkedAt: record.bookmarkedAt,
      serverUpdatedAt: record.updatedAt,
      expectedBookmarkedAt: row.bookmarked_at,
      expectedListingJson: row.listing_json,
    });
    // A second add/update may have landed while POST was in flight. Only the
    // exact mutation revision that received this ACK may become clean or claim
    // the device row; otherwise the newer pending row must retry unchanged.
    if (result.changes !== 1) return;
    db.prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @deviceWorkspaceId AND entity_kind = @entityKind AND slug = @slug
         AND claim_workspace_id = @workspaceId`,
    ).run({
      deviceWorkspaceId: DEVICE_BOOKMARK_WORKSPACE_ID,
      workspaceId: scope,
      entityKind: row.entity_kind,
      slug: row.slug,
    });
  })();
}

export function markHubBookmarkDeleteSynced(workspaceId: string, row: HubBookmarkStoreRow): void {
  const scope = normalizedWorkspaceId(workspaceId);
  const db = getDb();
  db.transaction(() => {
    db.prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug
         AND sync_state = 'pending_delete'`,
    ).run({ workspaceId: scope, entityKind: row.entity_kind, slug: row.slug });
    db.prepare(
      `DELETE FROM hub_agent_bookmarks
       WHERE workspace_id = @deviceWorkspaceId AND entity_kind = @entityKind AND slug = @slug
         AND claim_workspace_id = @workspaceId`,
    ).run({
      deviceWorkspaceId: DEVICE_BOOKMARK_WORKSPACE_ID,
      workspaceId: scope,
      entityKind: row.entity_kind,
      slug: row.slug,
    });
  })();
}

export function markHubBookmarkSyncError(
  workspaceId: string,
  row: Pick<HubBookmarkStoreRow, "slug" | "entity_kind" | "sync_state">,
  error: unknown,
): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  getDb()
    .prepare(
      `UPDATE hub_agent_bookmarks
       SET last_sync_error = @message
       WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug
         AND sync_state = @syncState`,
    )
    .run({
      workspaceId: normalizedWorkspaceId(workspaceId),
      slug: row.slug,
      entityKind: row.entity_kind,
      syncState: row.sync_state,
      message,
    });
}

export function applyLiveHubBookmarkValidation(
  workspaceId: string,
  liveListings: MarketplaceListing[] | null,
): void {
  const scope = normalizedWorkspaceId(workspaceId);
  const liveByIdentity = new Map<string, MarketplaceListing>();
  for (const raw of liveListings ?? []) {
    const live = normalizeHubBookmarkListing(raw);
    if (!live.slug) continue;
    // 북마크는 (종류, 이름) 합성 신원으로 보관한다 — 같은 이름의 에이전트와 팀이
    // 서로를 덮지 않는다.
    liveByIdentity.set(identityKey(live.slug, String(live.entityKind ?? "agent")), live);
  }
  const rows = listHubBookmarkStoreRows(scope);
  const update = getDb().prepare(
    `UPDATE hub_agent_bookmarks
     SET listing_json = @listingJson
     WHERE workspace_id = @workspaceId AND entity_kind = @entityKind AND slug = @slug
       AND sync_state <> 'pending_delete'`,
  );
  const tx = getDb().transaction(() => {
    for (const row of rows) {
      const current = listingFromRow(row);
      const live = liveByIdentity.get(identityKey(row.slug, row.entity_kind));
      // 같은 이름의 에이전트/팀이 있어도 더 이상 양쪽을 죽이지 않는다. 실행 타깃이
      // entityKind 를 싣고(`shared/types.ts:5461`) 런타임이 그것으로 갈리므로
      // (`mcp/borrowed-task-force.ts:2780`), 이름만으로 구분 못 하던 전제가 사라졌다.
      // 북마크는 (종류, 이름) 합성 신원으로 이미 따로 보관된다.
      const explicitlyCallable =
        live?.callable === true &&
        live.kind !== "install-only" &&
        live.routingReady !== false;
      const next = live
        ? normalizeHubBookmarkListing({
            ...current,
            ...live,
            slug: row.slug,
            entityKind: row.entity_kind,
            kind: explicitlyCallable ? "cloud-callable" : "install-only",
            callable: explicitlyCallable,
            routingReady: explicitlyCallable,
            routingStatus: explicitlyCallable
              ? live.routingStatus || "public-profile"
              : live.routingStatus || "hub_profile_not_callable",
          })
        : failClosedHubBookmarkListing(current);
      update.run({
        workspaceId: scope,
        entityKind: row.entity_kind,
        slug: row.slug,
        listingJson: JSON.stringify(next),
      });
    }
  });
  tx();
}

export function listingForHubBookmarkMutation(row: HubBookmarkStoreRow): MarketplaceListing {
  return listingFromRow(row);
}
