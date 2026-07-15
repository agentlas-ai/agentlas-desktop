#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const Database = require("better-sqlite3");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-v53-hub-bookmarks-"));
const storePath = path.join(tempDir, "legacy-v52.sqlite");
process.env.AGENTLAS_STORE_PATH = storePath;
app.setPath("userData", path.join(tempDir, "user-data"));

const legacyListing = {
  slug: "legacy-device-agent",
  name: "레거시 디바이스 에이전트",
  nameEn: "Legacy Device Agent",
  tagline: "이전 로컬 북마크",
  taglineEn: "Legacy local bookmark",
  trustGrade: "A",
  installCount: 7,
  manifestUrl: "https://agentlas.cloud/p/legacy-device-agent",
  kind: "cloud-callable",
  callable: true,
  routingReady: true,
  source: "hub-profile",
  entityKind: "agent",
};
const legacyPluginListing = {
  slug: "legacy-device-plugin",
  name: "레거시 디바이스 플러그인",
  nameEn: "Legacy Device Plugin",
  tagline: "이전 로컬 플러그인 북마크",
  taglineEn: "Legacy local plugin bookmark",
  trustGrade: "unknown",
  installCount: 0,
  manifestUrl: "https://agentlas.cloud/api/plugins/legacy-device-plugin",
  kind: "hub-plugin",
  callable: false,
  routingReady: false,
  source: "hub-plugin",
  entityKind: "plugin",
};

const seed = new Database(storePath);
seed.exec(`
  -- A real v52 store contains the base agent table and the v38 execution
  -- ledgers. Keep the fixture minimal while preserving those migration
  -- prerequisites for later schema versions.
  CREATE TABLE installed_agents (
    id TEXT PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    installed_at TEXT NOT NULL
  );
  CREATE TABLE run_events (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    ts TEXT NOT NULL,
    kind TEXT NOT NULL,
    agent_id TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}',
    UNIQUE(run_id, seq)
  );
  CREATE TABLE failure_events (
    id TEXT PRIMARY KEY,
    ts TEXT NOT NULL,
    source TEXT NOT NULL,
    agent_id TEXT,
    error_message TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE hub_agent_bookmarks (
    slug TEXT PRIMARY KEY,
    entity_kind TEXT NOT NULL DEFAULT 'agent',
    listing_json TEXT NOT NULL,
    bookmarked_at TEXT NOT NULL
  );
  INSERT INTO hub_agent_bookmarks (slug, entity_kind, listing_json, bookmarked_at)
  VALUES (
    'legacy-device-agent', 'agent',
    '${JSON.stringify(legacyListing).replace(/'/g, "''")}',
    '2026-01-01T00:00:00.000Z'
  );
  INSERT INTO hub_agent_bookmarks (slug, entity_kind, listing_json, bookmarked_at)
  VALUES (
    'legacy-device-plugin', 'plugin',
    '${JSON.stringify(legacyPluginListing).replace(/'/g, "''")}',
    '2026-01-02T00:00:00.000Z'
  );
`);
seed.pragma("user_version = 52");
seed.close();

const now = () => new Date().toISOString();
const keyOf = (slug, entityKind = "agent") => `${entityKind}\u0000${slug}`;
const workspaceState = new Map();
const requests = [];
const failPostSlugs = new Set(["claim-locked"]);
let malformedSnapshot = false;
let bookmarkGetStatus = 200;
let publicAgentsStatus = 200;
let premiumTeamsStatus = 200;
let bookmarkMutationStatus = 200;
let slowSnapshotRelease = null;
let slowSnapshotStartedResolve;
const slowSnapshotStarted = new Promise((resolve) => { slowSnapshotStartedResolve = resolve; });
let onPost = null;

function stateFor(account) {
  if (!workspaceState.has(account)) workspaceState.set(account, new Map());
  return workspaceState.get(account);
}

function serverRecord(slug, entityKind = "agent", patch = {}) {
  return {
    slug,
    entityKind,
    title: patch.title || slug,
    titleKo: patch.titleKo || patch.title || slug,
    tagline: patch.tagline || `${slug} tagline`,
    taglineKo: patch.taglineKo || patch.tagline || `${slug} tagline`,
    ownerName: patch.ownerName || "Mock Publisher",
    perCallCredits: entityKind === "team" ? 10 : 3,
    bookmarkedAt: patch.bookmarkedAt || now(),
    updatedAt: patch.updatedAt || now(),
  };
}

function accountFrom(req) {
  const match = String(req.headers.cookie || "").match(/agentlas_session=([^;]+)/);
  return match?.[1] || "anonymous";
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (error) { reject(error); }
    });
    req.on("error", reject);
  });
}

const liveAgents = [
  {
    slug: "legacy-device-agent",
    kind: "agent",
    title: "Legacy Device Agent",
    titleKo: "레거시 디바이스 에이전트",
    tagline: "Fresh live profile",
    callable: true,
    deliveryKind: "cloud-callable",
    callTool: "agentlas.get_runtime_bundle",
  },
  {
    slug: "server-only",
    kind: "agent",
    title: "Server Only",
    callable: true,
    routingReady: false,
    deliveryKind: "cloud-callable",
    callTool: "agentlas.get_runtime_bundle",
    availabilityReason: "routing_disabled",
  },
  {
    slug: "team-live",
    kind: "cloud-callable",
    entityKind: "team",
    title: "Team Live",
    callable: true,
    deliveryKind: "cloud-callable",
    callTool: "agentlas.get_runtime_bundle",
  },
  {
    slug: "corrupt-public",
    kind: "agent",
    title: "Corrupt Public Callable Claim",
    callable: true,
    deliveryKind: "install-only",
    callTool: "marketplace.get_manifest",
  },
  {
    slug: "single-bookmark-collision",
    kind: "agent",
    entityKind: "agent",
    title: "Collision Agent",
    callable: true,
    deliveryKind: "cloud-callable",
    callTool: "agentlas.get_runtime_bundle",
  },
  {
    slug: "single-bookmark-collision",
    kind: "cloud-callable",
    entityKind: "team",
    title: "Collision Team",
    callable: true,
    deliveryKind: "cloud-callable",
    callTool: "agentlas.get_runtime_bundle",
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const account = accountFrom(req);
  const requestLog = {
    method: req.method,
    path: url.pathname,
    search: url.search,
    account,
    origin: req.headers.origin || null,
    cookie: req.headers.cookie || null,
  };
  requests.push(requestLog);
  res.setHeader("content-type", "application/json");

  if (req.method === "GET" && url.pathname === "/api/marketplace/agents") {
    if (publicAgentsStatus !== 200) {
      res.statusCode = publicAgentsStatus;
      res.end(JSON.stringify({ error: "public_agents_unavailable" }));
      return;
    }
    res.end(JSON.stringify({ agents: liveAgents, count: liveAgents.length, generatedAt: now() }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/mcp/v1/tools/call") {
    const body = await readJson(req);
    requestLog.bodyName = body.name;
    if (premiumTeamsStatus !== 200) {
      res.statusCode = premiumTeamsStatus;
      res.end(JSON.stringify({ error: { code: "unavailable" } }));
      return;
    }
    res.end(JSON.stringify({
      result: {
        teams: [
          {
            slug: "registry-team",
            name: "Registry Team",
            tagline: "Phased team from the canonical live registry",
            roles: 4,
            status: "live",
            invokable: true,
            callTool: "agentlas.teams.invoke",
            perCallCredits: 10,
          },
          {
            slug: "registry-disabled-team",
            name: "Registry Disabled Team",
            tagline: "Not invokable",
            roles: 3,
            status: "soon",
            invokable: false,
            callTool: "agentlas.teams.invoke",
            perCallCredits: 10,
          },
        ],
      },
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/agent-cloud/bookmarks") {
    if (account === "INVALID") {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: "auth_required" }));
      return;
    }
    if (account === "SLOW_A") {
      slowSnapshotStartedResolve();
      await new Promise((resolve) => { slowSnapshotRelease = resolve; });
    }
    if (bookmarkGetStatus !== 200) {
      res.statusCode = bookmarkGetStatus;
      res.end(JSON.stringify({ error: "offline" }));
      return;
    }
    const bookmarks = [...stateFor(account).values()];
    if (malformedSnapshot) bookmarks.push({ slug: "malformed-without-timestamps", entityKind: "agent" });
    res.end(JSON.stringify({ bookmarks }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/agent-cloud/bookmarks") {
    const body = await readJson(req);
    requestLog.bodySlug = body.slug;
    if (bookmarkMutationStatus !== 200) {
      res.statusCode = bookmarkMutationStatus;
      res.end(JSON.stringify({ error: "mutation_cycle_unavailable" }));
      return;
    }
    if (failPostSlugs.has(body.slug)) {
      // Deterministic row-level rejection: the cycle must preserve this row but
      // may continue with unrelated pending mutations.
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "temporary_failure" }));
      return;
    }
    const record = serverRecord(body.slug, body.entityKind, body);
    stateFor(account).set(keyOf(record.slug, record.entityKind), record);
    if (onPost) await onPost({ account, body, record });
    res.end(JSON.stringify({ bookmark: record, bookmarked: true }));
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/agent-cloud/bookmarks/")) {
    const slug = decodeURIComponent(url.pathname.slice("/api/agent-cloud/bookmarks/".length));
    const entityKind = url.searchParams.get("entityKind") === "team" ? "team" : "agent";
    const deleted = stateFor(account).delete(keyOf(slug, entityKind));
    res.end(JSON.stringify({ bookmarked: false, deleted }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not_found" }));
});

function listing(slug, entityKind = "agent", name = slug) {
  return {
    slug,
    name,
    nameEn: name,
    tagline: `${name} local tagline`,
    taglineEn: `${name} local tagline`,
    trustGrade: "unknown",
    installCount: 0,
    manifestUrl: `https://agentlas.cloud/p/${slug}`,
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    source: "hub-profile",
    entityKind,
  };
}

async function listen() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

async function main() {
  try {
    await app.whenReady();
    const baseUrl = await listen();
    process.env.AGENTLAS_WEB_BASE_URL = baseUrl;
    let storeModule = require("../dist/electron/store/db.js");
    storeModule.initStore();
    let db = storeModule.getDb();

    assert.equal(db.pragma("user_version", { simple: true }), require("../package.json").agentlasUpdateCompatibility.targetSchemaVersion);
    const columns = db.prepare("PRAGMA table_info(hub_agent_bookmarks)").all();
    assert.deepEqual(
      columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
      ["workspace_id", "entity_kind", "slug"],
      "v53 must use the account/entity/slug composite key",
    );
    const firstPassRows = db.prepare("SELECT * FROM hub_agent_bookmarks ORDER BY workspace_id, entity_kind, slug").all();
    db.close();
    const rewind = new Database(storePath);
    rewind.pragma("user_version = 52");
    rewind.close();
    const dbModulePath = require.resolve("../dist/electron/store/db.js");
    delete require.cache[dbModulePath];
    storeModule = require(dbModulePath);
    storeModule.initStore();
    db = storeModule.getDb();
    assert.equal(db.pragma("user_version", { simple: true }), require("../package.json").agentlasUpdateCompatibility.targetSchemaVersion, "idempotent reopen must restore the current canonical marker");
    assert.deepEqual(
      db.prepare("SELECT * FROM hub_agent_bookmarks ORDER BY workspace_id, entity_kind, slug").all(),
      firstPassRows,
      "rewound marker must not rebuild or mutate an already-v53 bookmark table",
    );

    // A partially shipped shape with all v53 columns but the old slug-only PK
    // must be rebuilt, not mistaken for a completed migration.
    db.close();
    const partialPath = path.join(tempDir, "partial-v53-wrong-pk.sqlite");
    const partial = new Database(partialPath);
    partial.exec(`
      CREATE TABLE installed_agents (
        id TEXT PRIMARY KEY,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        installed_at TEXT NOT NULL
      );
      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        ts TEXT NOT NULL,
        kind TEXT NOT NULL,
        agent_id TEXT,
        payload_json TEXT NOT NULL DEFAULT '{}',
        UNIQUE(run_id, seq)
      );
      CREATE TABLE failure_events (
        id TEXT PRIMARY KEY,
        ts TEXT NOT NULL,
        source TEXT NOT NULL,
        agent_id TEXT,
        error_message TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE hub_agent_bookmarks (
        workspace_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        entity_kind TEXT NOT NULL,
        listing_json TEXT NOT NULL,
        bookmarked_at TEXT NOT NULL,
        server_updated_at TEXT,
        sync_state TEXT NOT NULL,
        last_sync_error TEXT,
        claim_workspace_id TEXT,
        PRIMARY KEY(workspace_id, entity_kind, slug, bookmarked_at)
      );
      INSERT INTO hub_agent_bookmarks VALUES (
        'partial-workspace', 'partial-pending', 'team',
        '{"slug":"partial-pending","entityKind":"team","revision":"old"}',
        '2026-02-01T00:00:00.000Z', NULL, 'clean', NULL, NULL
      );
      INSERT INTO hub_agent_bookmarks VALUES (
        'partial-workspace', 'partial-pending', 'team',
        '{"slug":"partial-pending","entityKind":"team"}',
        '2026-03-01T00:00:00.000Z', NULL, 'pending_upsert', 'retry-me', NULL
      );
      PRAGMA user_version = 52;
    `);
    partial.close();
    process.env.AGENTLAS_STORE_PATH = partialPath;
    delete require.cache[dbModulePath];
    storeModule = require(dbModulePath);
    storeModule.initStore();
    const repairedPartialDb = storeModule.getDb();
    assert.deepEqual(
      repairedPartialDb.prepare("PRAGMA table_info(hub_agent_bookmarks)").all()
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name),
      ["workspace_id", "entity_kind", "slug"],
      "all columns with a wrong PK must still rebuild to the v53 composite identity",
    );
    assert.deepEqual(
      repairedPartialDb.prepare(
        "SELECT workspace_id, slug, entity_kind, listing_json, bookmarked_at, server_updated_at, sync_state, last_sync_error, claim_workspace_id FROM hub_agent_bookmarks",
      ).get(),
      {
        workspace_id: "partial-workspace",
        slug: "partial-pending",
        entity_kind: "team",
        listing_json: '{"slug":"partial-pending","entityKind":"team"}',
        bookmarked_at: "2026-03-01T00:00:00.000Z",
        server_updated_at: null,
        sync_state: "pending_upsert",
        last_sync_error: "retry-me",
        claim_workspace_id: null,
      },
      "partial-schema rebuild must preserve account and pending outbox state",
    );
    repairedPartialDb.close();
    process.env.AGENTLAS_STORE_PATH = storePath;
    delete require.cache[dbModulePath];
    storeModule = require(dbModulePath);
    storeModule.initStore();
    db = storeModule.getDb();

    let bookmarks = require("../dist/electron/store/hub-bookmarks.js");
    let sync = require("../dist/electron/hub-bookmark-sync.js");
    const migrated = bookmarks.listHubBookmarkStoreRows(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID, { includeDeleted: true });
    assert.equal(migrated.length, 2);
    const migratedAgent = migrated.find((row) => row.slug === "legacy-device-agent");
    const migratedPlugin = migrated.find((row) => row.slug === "legacy-device-plugin");
    assert.equal(migratedAgent.listing_json, JSON.stringify(legacyListing), "legacy listing bytes must be preserved");
    assert.equal(migratedAgent.bookmarked_at, "2026-01-01T00:00:00.000Z");
    assert.equal(migratedPlugin.listing_json, JSON.stringify(legacyPluginListing), "legacy plugin bytes must be preserved");

    bookmarks.addHubAgentBookmarkForWorkspace(listing("same-slug", "agent", "Same Agent"), "composite");
    bookmarks.addHubAgentBookmarkForWorkspace(listing("same-slug", "team", "Same Team"), "composite");
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace("composite").length, 2, "entity kind must be part of identity");
    const forged = bookmarks.addHubAgentBookmarkForWorkspace(
      { ...listing("forged-callable", "agent", "Forged Callable"), callable: true, routingReady: true },
      "forged-offline",
    );
    assert.equal(forged.listing.callable, false, "renderer-provided callable=true must be stored and broadcast fail-closed");
    assert.equal(forged.listing.kind, "install-only");
    bookmarks.addHubAgentBookmarkForWorkspace(listing("account-b-local"), "workspace-b");
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace("workspace-a").some((item) => item.slug === "account-b-local"), false);

    bookmarks.addHubAgentBookmarkForWorkspace(
      listing("claim-locked", "agent", "Claim Locked"),
      bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID,
    );
    bookmarks.addHubAgentBookmarkForWorkspace(
      listing("switch-race", "agent", "Switch Race"),
      bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID,
    );

    const aState = stateFor("A");
    aState.set(keyOf("local-win"), serverRecord("local-win", "agent", { title: "Old Server Name" }));
    aState.set(keyOf("delete-me"), serverRecord("delete-me"));
    aState.set(keyOf("server-only"), serverRecord("server-only"));
    aState.set(keyOf("snapshot-only"), serverRecord("snapshot-only"));
    aState.set(keyOf("team-live", "team"), serverRecord("team-live", "team"));
    aState.set(keyOf("registry-team", "team"), serverRecord("registry-team", "team"));
    aState.set(keyOf("registry-disabled-team", "team"), serverRecord("registry-disabled-team", "team"));
    aState.set(keyOf("corrupt-public"), serverRecord("corrupt-public"));
    // Only the agent identity is bookmarked. The live catalog still contains a
    // same-slug team, so slug-only invocation must fail both identities closed.
    aState.set(keyOf("single-bookmark-collision"), serverRecord("single-bookmark-collision", "agent"));

    bookmarks.reconcileHubBookmarkServerSnapshot("A", [
      serverRecord("delete-me"),
      serverRecord("gone-clean"),
    ]);
    bookmarks.removeHubAgentBookmarkForWorkspace("delete-me", "agent", "A");
    bookmarks.addHubAgentBookmarkForWorkspace(listing("local-win", "agent", "New Local Name"), "A");

    const contextA = { workspaceId: "A", cookie: "agentlas_session=A" };
    const contextB = { workspaceId: "B", cookie: "agentlas_session=B" };
    const deps = { baseUrl, timeoutMs: 2_000 };
    const slowContext = { workspaceId: "slow-workspace-a", cookie: "agentlas_session=SLOW_A" };
    let activeCookie = slowContext.cookie;
    const delayedA = sync.syncHubBookmarksForContext(slowContext, {
      ...deps,
      isContextCurrent: (candidate) => candidate.cookie === activeCookie,
    });
    await slowSnapshotStarted;
    activeCookie = contextB.cookie;
    slowSnapshotRelease();
    await delayedA;
    assert.ok(
      bookmarks.listHubBookmarkStoreRows(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID, { includeDeleted: true })
        .every((row) => row.claim_workspace_id === null),
      "late account-A GET after switching to B must not claim or delete device rows",
    );
    assert.equal(
      requests.some((request) => request.account === "SLOW_A" && request.method === "POST" && request.path === "/api/agent-cloud/bookmarks"),
      false,
      "stale account cycle must not flush an outbox after the generation guard fails",
    );
    let authenticatedSessionRejections = 0;
    await sync.syncHubBookmarksForContext(
      { workspaceId: "current-rejected-workspace", cookie: "agentlas_session=INVALID" },
      {
        ...deps,
        isContextCurrent: () => true,
        onAuthenticatedSessionRejected: () => { authenticatedSessionRejections += 1; },
      },
    );
    assert.equal(authenticatedSessionRejections, 1, "exact-current bookmark GET 401 must invalidate auth immediately");
    await sync.syncHubBookmarksForContext(
      { workspaceId: "discarded-workspace", cookie: "agentlas_session=INVALID" },
      {
        ...deps,
        isContextCurrent: () => false,
        onAuthenticatedSessionRejected: () => { authenticatedSessionRejections += 1; },
      },
    );
    assert.equal(authenticatedSessionRejections, 1, "late prior-account 401 must not invalidate the current account");
    assert.ok(
      bookmarks.listHubBookmarkStoreRows(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID, { includeDeleted: true })
        .every((row) => row.claim_workspace_id === null),
      "401 from a discarded cookie must not lock any device bookmark",
    );
    malformedSnapshot = true;
    await sync.syncHubBookmarksForContext(
      { workspaceId: "malformed-workspace", cookie: "agentlas_session=MALFORMED" },
      deps,
    );
    malformedSnapshot = false;
    assert.ok(
      bookmarks.listHubBookmarkStoreRows(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID, { includeDeleted: true })
        .every((row) => row.claim_workspace_id === null),
      "malformed full snapshot must not lock any device bookmark",
    );
    await sync.syncHubBookmarksForContext(contextA, deps);

    const aBookmarks = bookmarks.listHubAgentBookmarksForWorkspace("A");
    assert.equal(aBookmarks.some((item) => item.slug === "gone-clean"), false, "clean row absent from canonical snapshot must be removed");
    assert.equal(aBookmarks.some((item) => item.slug === "delete-me"), false, "pending delete must win snapshot then flush");
    assert.equal(aState.has(keyOf("delete-me")), false, "pending delete must reach Web DELETE");
    assert.equal(aState.get(keyOf("local-win")).title, "New Local Name", "pending upsert must win stale server snapshot");
    assert.equal(aBookmarks.find((item) => item.slug === "legacy-device-agent")?.listing.callable, true, "fresh explicit callable profile may authorize invocation");
    assert.equal(aBookmarks.find((item) => item.slug === "server-only")?.listing.callable, false, "explicit routingReady=false must fail closed");
    assert.equal(aBookmarks.find((item) => item.slug === "snapshot-only")?.listing.callable, false, "bookmark snapshot without live profile must fail closed");
    const teamLive = aBookmarks.find((item) => item.slug === "team-live");
    assert.equal(teamLive?.listing.entityKind, "team", "entityKind must win over listing kind metadata");
    assert.equal(teamLive?.listing.callable, true);
    const registryTeam = aBookmarks.find((item) => item.slug === "registry-team");
    assert.equal(registryTeam?.listing.entityKind, "team");
    assert.equal(registryTeam?.listing.callable, true, "live phased registry team must remain callable on Desktop");
    assert.equal(registryTeam?.listing.routingStatus, "agentlas.teams.invoke");
    assert.equal(
      aBookmarks.find((item) => item.slug === "registry-disabled-team")?.listing.callable,
      false,
      "non-invokable registry rows must fail closed",
    );
    assert.equal(
      aBookmarks.find((item) => item.slug === "corrupt-public")?.listing.callable,
      false,
      "callable=true cannot override an install-only delivery contract",
    );
    const singleCollision = aBookmarks.filter((item) => item.slug === "single-bookmark-collision");
    assert.equal(singleCollision.length, 1, "the server snapshot intentionally bookmarks only one collision identity");
    assert.equal(singleCollision[0].listing.callable, false, "one bookmark cannot hide a live agent/team slug collision");
    assert.equal(singleCollision[0].listing.routingStatus, "hub_slug_identity_ambiguous");

    publicAgentsStatus = 503;
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.equal(
      bookmarks.listHubAgentBookmarksForWorkspace("A").find((item) => item.slug === "registry-team")?.listing.callable,
      false,
      "partial live authority cannot prove that a premium team slug is globally unambiguous",
    );
    publicAgentsStatus = 200;
    premiumTeamsStatus = 503;
    await sync.syncHubBookmarksForContext(contextA, deps);
    const sourceIsolated = bookmarks.listHubAgentBookmarksForWorkspace("A");
    assert.equal(
      sourceIsolated.find((item) => item.slug === "legacy-device-agent")?.listing.callable,
      false,
      "partial public-agent authority cannot prove that the premium catalog has no same-slug team",
    );
    assert.equal(sourceIsolated.find((item) => item.slug === "registry-team")?.listing.callable, false, "missing premium authority must fail the team closed");
    premiumTeamsStatus = 200;
    await sync.syncHubBookmarksForContext(contextA, deps);

    assert.equal(
      bookmarks.listHubAgentBookmarksForWorkspace(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID).some((item) => item.slug === "legacy-device-agent"),
      false,
      "device legacy row must be removed only after successful first-workspace POST",
    );
    const claimedPlugin = aBookmarks.find((item) => item.slug === "legacy-device-plugin");
    assert.equal(claimedPlugin?.listing.entityKind, "plugin", "legacy plugin must move into the first valid workspace");
    assert.equal(
      bookmarks.listHubAgentBookmarksForWorkspace(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID).some((item) => item.slug === "legacy-device-plugin"),
      false,
      "claimed plugin must not disappear behind signed-in account isolation",
    );
    assert.equal(
      requests.some((request) => request.method === "POST" && request.bodySlug === "legacy-device-plugin"),
      false,
      "plugin claim must remain local and never hit the agent/team Web API",
    );
    const lockedDevice = bookmarks.listHubBookmarkStoreRows(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID, { includeDeleted: true })
      .find((row) => row.slug === "claim-locked");
    assert.equal(lockedDevice?.claim_workspace_id, "A", "first workspace must lock a failed claim");
    assert.equal(bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "claim-locked")?.sync_state, "pending_upsert");

    await sync.syncHubBookmarksForContext(contextB, deps);
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace("B").some((item) => item.slug === "claim-locked"), false, "second account must not steal first-login claim");
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace("B").some((item) => item.slug === "server-only"), false, "account snapshots must not leak");

    failPostSlugs.delete("claim-locked");
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace(bookmarks.DEVICE_BOOKMARK_WORKSPACE_ID).some((item) => item.slug === "claim-locked"), false);

    bookmarks.addHubAgentBookmarkForWorkspace(listing("mutation-unauthorized"), "A");
    bookmarkMutationStatus = 401;
    let mutationSessionRejections = 0;
    await sync.syncHubBookmarksForContext(contextA, {
      ...deps,
      isContextCurrent: () => true,
      onAuthenticatedSessionRejected: (rejectedContext) => {
        assert.equal(rejectedContext.cookie, contextA.cookie);
        mutationSessionRejections += 1;
      },
    });
    assert.equal(mutationSessionRejections, 1, "exact-current bookmark mutation 401 must invalidate auth immediately");
    assert.equal(
      bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true })
        .find((row) => row.slug === "mutation-unauthorized")?.sync_state,
      "pending_upsert",
      "401 must preserve the rejected local intent for a future authenticated retry",
    );
    bookmarkMutationStatus = 200;
    await sync.syncHubBookmarksForContext(contextA, deps);

    bookmarks.addHubAgentBookmarkForWorkspace(listing("outage-one"), "A");
    bookmarks.addHubAgentBookmarkForWorkspace(listing("outage-two"), "A");
    bookmarks.addHubAgentBookmarkForWorkspace(listing("outage-three"), "A");
    bookmarkMutationStatus = 503;
    const outagePostCountBefore = requests.filter((request) =>
      request.method === "POST" && request.path === "/api/agent-cloud/bookmarks"
    ).length;
    await sync.syncHubBookmarksForContext(contextA, deps);
    const outagePostCountAfter = requests.filter((request) =>
      request.method === "POST" && request.path === "/api/agent-cloud/bookmarks"
    ).length;
    assert.equal(
      outagePostCountAfter - outagePostCountBefore,
      1,
      "one shared 5xx must stop the outbox cycle instead of multiplying into N requests/timeouts",
    );
    assert.equal(
      bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).filter((row) =>
        row.slug.startsWith("outage-") && row.sync_state === "pending_upsert"
      ).length,
      3,
      "cycle-wide outage must retain every pending mutation",
    );
    bookmarkMutationStatus = 200;
    await sync.syncHubBookmarksForContext(contextA, deps);

    const mutationRequests = requests.filter((request) =>
      request.path.startsWith("/api/agent-cloud/bookmarks") &&
      (request.method === "POST" || request.method === "DELETE")
    );
    assert.ok(mutationRequests.length >= 3);
    assert.ok(mutationRequests.every((request) => request.origin === baseUrl), "all mutations need CSRF Origin");
    assert.ok(mutationRequests.some((request) => request.cookie === "agentlas_session=A"), "account cookie must be forwarded");

    // A late POST response must not clean/overwrite a newer local add.
    bookmarks.addHubAgentBookmarkForWorkspace(listing("cas-agent", "agent", "CAS Old"), "A");
    let casHookCount = 0;
    onPost = ({ body }) => {
      if (body.slug !== "cas-agent" || casHookCount > 0) return;
      casHookCount += 1;
      bookmarks.addHubAgentBookmarkForWorkspace(listing("cas-agent", "agent", "CAS New"), "A");
    };
    await sync.syncHubBookmarksForContext(contextA, deps);
    onPost = null;
    const casPending = bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "cas-agent");
    assert.equal(casPending?.sync_state, "pending_upsert", "stale ACK must leave newer mutation pending");
    assert.equal(JSON.parse(casPending.listing_json).name, "CAS New", "stale ACK must not overwrite new metadata");
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.equal(bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "cas-agent")?.sync_state, "clean");

    // Malformed and failed full snapshots preserve clean cache. A valid empty
    // snapshot remains canonical and may clear it.
    assert.ok(bookmarks.listHubAgentBookmarksForWorkspace("A").some((item) => item.slug === "server-only"));
    aState.delete(keyOf("server-only"));
    malformedSnapshot = true;
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.ok(bookmarks.listHubAgentBookmarksForWorkspace("A").some((item) => item.slug === "server-only"), "malformed member must reject whole snapshot");
    malformedSnapshot = false;
    bookmarkGetStatus = 503;
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.ok(bookmarks.listHubAgentBookmarksForWorkspace("A").some((item) => item.slug === "server-only"), "offline GET must not empty cache");
    bookmarkGetStatus = 200;

    bookmarks.reconcileHubBookmarkServerSnapshot("C", [serverRecord("valid-empty-removal")]);
    await sync.syncHubBookmarksForContext({ workspaceId: "C", cookie: "agentlas_session=C" }, deps);
    assert.equal(bookmarks.listHubAgentBookmarksForWorkspace("C").length, 0, "explicit valid empty snapshot is canonical");

    // Pending intent is durable across a full DB/module restart and flushes on
    // the next lifecycle sync rather than being mistaken for clean cache.
    bookmarks.addHubAgentBookmarkForWorkspace(listing("restart-pending", "agent", "Restart Pending"), "A");
    assert.equal(bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "restart-pending")?.sync_state, "pending_upsert");
    db.close();
    for (const modulePath of [
      require.resolve("../dist/electron/hub-bookmark-sync.js"),
      require.resolve("../dist/electron/store/hub-bookmarks.js"),
      require.resolve("../dist/electron/store/db.js"),
    ]) delete require.cache[modulePath];
    storeModule = require("../dist/electron/store/db.js");
    storeModule.initStore();
    bookmarks = require("../dist/electron/store/hub-bookmarks.js");
    sync = require("../dist/electron/hub-bookmark-sync.js");
    db = storeModule.getDb();
    assert.equal(bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "restart-pending")?.sync_state, "pending_upsert");
    bookmarks.applyLiveHubBookmarkValidation("A", null);
    assert.equal(
      bookmarks.listHubAgentBookmarksForWorkspace("A").find((item) => item.slug === "legacy-device-agent")?.listing.callable,
      false,
      "persisted display cache must start a new process/session fail-closed",
    );
    await sync.syncHubBookmarksForContext(contextA, deps);
    assert.equal(bookmarks.listHubBookmarkStoreRows("A", { includeDeleted: true }).find((row) => row.slug === "restart-pending")?.sync_state, "clean");
    assert.equal(
      bookmarks.listHubAgentBookmarksForWorkspace("A").find((item) => item.slug === "legacy-device-agent")?.listing.callable,
      true,
      "fresh live validation may re-promote the persisted reference",
    );

    assert.equal(db.pragma("quick_check", { simple: true }), "ok");
    assert.deepEqual(db.pragma("foreign_key_check"), []);
    db.close();
    await assert.doesNotReject(() => sync.syncHubBookmarks(), "fire-and-forget lifecycle sync must absorb closed-DB shutdown races");
    console.log("test-v53-hub-bookmark-sync: PASS");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    try { require("../dist/electron/store/db.js").getDb().close(); } catch {}
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().then(
  () => app.exit(0),
  (error) => {
    console.error(error);
    app.exit(1);
  },
);
