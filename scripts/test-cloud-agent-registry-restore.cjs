#!/usr/bin/env node
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, shell } = require("electron");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function makePackage(entries) {
  const files = Object.entries(entries).map(([filePath, text]) => {
    const content = Buffer.from(text, "utf8");
    return {
      path: filePath,
      bytes: content.length,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
    };
  });
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
  }
  return {
    packageHash: hash.digest("hex"),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["codex"],
    files,
  };
}

function makeExecutablePackage(entries) {
  const files = Object.entries(entries).map(([filePath, value]) => {
    const content = Buffer.from(value.text, "utf8");
    return {
      path: filePath,
      bytes: content.length,
      sha256: sha256(content),
      contentBase64: content.toString("base64"),
      executable: value.executable === true,
    };
  });
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    hash.update(file.executable ? "x" : "-");
    hash.update("\0");
  }
  return {
    packageHash: hash.digest("hex"),
    packageHashVersion: "path-sha256-executable-v2",
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["codex"],
    files,
  };
}

function ownerMetadata(version) {
  const isV1 = version === "v1";
  return {
    // Mirrors current Web cargo.get_manifest: mutable display/tool metadata,
    // while the restore envelope remains package identity authority.
    slug: "owned-registry-agent",
    name: `Stale Draft Name ${version}`,
    nameEn: `Stale Draft Name ${version}`,
    tagline: `Stale draft metadata ${version}`,
    taglineEn: `Stale draft metadata ${version}`,
    trustGrade: isV1 ? "A" : "B",
    installCount: 0,
    manifestUrl: "mock-draft-only",
    mcpServers: [isV1 ? "owner-tool-v1" : "owner-tool-v2"],
    tone: isV1 ? "green" : "purple",
    systemPrompt: `stale draft prompt ${version}`,
    envRequirements: [],
    source: "agentlas-web-user-cargo",
    // Deliberately no cloudPackage: cargo.get_manifest is metadata, not restore authority.
  };
}

function ownerRestorePayload(version, pkg, scope = ownerScope) {
  const revision = `rev_${sha256(`restore-revision:${version}`).slice(0, 32)}`;
  const cloudId = "cloud_owned_registry_agent";
  const packageHashVersion = pkg.packageHashVersion || "path-sha256-v1";
  const updatedAt = "2026-07-11T00:00:00.000Z";
  return {
    schema: "agentlas.agent_cloud.restore.v1",
    source: "cloud",
    owner: true,
    slug: "owned-registry-agent",
    cloudId,
    scope,
    revision,
    etag: `"${revision}"`,
    updatedAt,
    name: `Owned Registry Agent ${version}`,
    nameEn: `Owned Registry Agent ${version}`,
    tagline: `Owned Agent Cloud asset ${version}`,
    taglineEn: `Owned Agent Cloud asset ${version}`,
    packageHash: pkg.packageHash,
    packageHashVersion,
    agentKind: pkg.agentKind,
    fileCount: pkg.fileCount,
    totalBytes: pkg.totalBytes,
    files: pkg.files,
    cloudPackage: {
      ...pkg,
      packageHashVersion,
      cloudId,
      scope,
      revision,
      updatedAt,
    },
    restoreHint: "restore locally",
  };
}

function hubListing(pkg) {
  return {
    slug: "public-hub-agent",
    name: "Public Hub Agent",
    nameEn: "Public Hub Agent",
    tagline: "Public Hub install",
    taglineEn: "Public Hub install",
    trustGrade: "A",
    installCount: 1,
    manifestUrl: "mock-hub",
    mcpServers: [],
    tone: "blue",
    systemPrompt: "hub metadata prompt",
    envRequirements: [],
    entityKind: "agent",
    cloudPackage: pkg,
  };
}

function callOnlyHubListing() {
  return {
    slug: "public-call-only-agent",
    name: "Public Call-only Agent",
    nameEn: "Public Call-only Agent",
    tagline: "Borrow from Hub without source download",
    taglineEn: "Borrow from Hub without source download",
    trustGrade: "A",
    installCount: 1,
    manifestUrl: "mock-call-only",
    mcpServers: [],
    tone: "blue",
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    entityKind: "agent",
    // Source instructions and cloudPackage are intentionally withheld.
  };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function dbPrompt(db, id) {
  return db.prepare("SELECT system_prompt FROM installed_agents WHERE id = ?").get(id).system_prompt;
}

function dbDependencyMetadata(db, id) {
  const row = db.prepare(
    "SELECT mcp_servers_json, trust_grade, tone FROM installed_agents WHERE id = ?",
  ).get(id);
  return {
    mcpServers: JSON.parse(row.mcp_servers_json),
    trustGrade: row.trust_grade,
    tone: row.tone,
  };
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-registry-restore-"));
process.env.AGENTLAS_STORE_PATH = path.join(tempRoot, "agentlas.sqlite");
process.env.AGENTLAS_E2E = "1"; // auth session stays in memory; no Keychain/safeStorage writes
app.setPath("userData", path.join(tempRoot, "user-data"));

const ownerV1 = makePackage({
  "AGENTS.md": "# Owned Registry Agent v1\n\nPackage authority v1.\n",
  "skills/legacy.md": "legacy\n",
});
const ownerV2 = makePackage({
  "AGENTS.md": "# Owned Registry Agent v2\n\nPackage authority v2.\n",
  "skills/current.md": "current\n",
});
const ownerV3 = makePackage({
  "AGENTS.md": "# Owned Registry Agent v3\n\nPackage authority v3.\n",
  "skills/current.md": "current v3\n",
});
const NESTED_ENTRY_PROMPT = "# Nested CEO\n\nNESTED_AGENTLAS_ENTRY_PROMPT_4C91\n";
const ROOT_FALLBACK_PROMPT = "# Root fallback\n\nROOT_FALLBACK_MUST_NOT_RUN_82D0\n";
const ownerNestedEntry = makePackage({
  "agentlas.json": `${JSON.stringify({ entry: "agents/ceo/AGENT.md" }, null, 2)}\n`,
  "agents/ceo/AGENT.md": NESTED_ENTRY_PROMPT,
  "AGENTS.md": ROOT_FALLBACK_PROMPT,
});
const publicHubPackage = makeExecutablePackage({
  "AGENTS.md": { text: "# Public Hub Agent\n", executable: false },
  "scripts/run.sh": { text: "#!/bin/sh\necho hub\n", executable: true },
});
let ownerVersion = "v1";
let ownerPackage = ownerV1;
let ownerScope = "owner-private";
let ownerRestoreError = null;
let delayNextOwnerRestore = false;
const cargoCookies = [];
const methodHits = new Map();

const sessionToken = `${Buffer.from(JSON.stringify({
  userId: "owner-user",
  workspaceId: "owner-workspace",
  exp: Math.floor(Date.now() / 1000) + 3600,
})).toString("base64url")}.test-signature`;
const expectedCookie = `agentlas_session=${sessionToken}`;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/auth/session") {
    if (req.headers.cookie !== expectedCookie) {
      sendJson(res, { authenticated: false });
      return;
    }
    sendJson(res, {
      authenticated: true,
      user: { email: "owner@agentlas.test" },
      workspace: { name: "Owner Workspace" },
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/api/mcp/v1/tools/call") {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
  });
  req.on("end", () => {
    const request = JSON.parse(body);
    const method = request.method;
    methodHits.set(method, (methodHits.get(method) || 0) + 1);
    if (method.startsWith("cargo.")) cargoCookies.push(req.headers.cookie || "");

    if (method === "marketplace.get_manifest") {
      const slug = request.params?.arguments?.slug;
      sendJson(res, { result: slug === "public-call-only-agent" ? callOnlyHubListing() : hubListing(publicHubPackage) });
      return;
    }
    if (method === "cargo.get_manifest") {
      sendJson(res, { result: ownerMetadata(ownerVersion) });
      return;
    }
    if (method === "cargo.search_agents") {
      sendJson(res, {
        result: {
          schema: "agentlas.agent_cloud.search.v1",
          source: "cloud",
          status: "ok",
          results: [
            {
              slug: "owned-registry-agent",
              name: `Owned Registry Agent ${ownerVersion}`,
              nameEn: `Owned Registry Agent ${ownerVersion}`,
              tagline: `Owned Agent Cloud asset ${ownerVersion}`,
              taglineEn: `Owned Agent Cloud asset ${ownerVersion}`,
              trustGrade: "A",
              installCount: 0,
              kind: "cloud-callable",
              callable: true,
              source: "cloud",
              entityKind: "agent",
            },
          ],
        },
      });
      return;
    }
    if (method === "cargo.restore_package") {
      if (ownerRestoreError) {
        sendJson(res, {
          result: {
            error: ownerRestoreError,
            message: ownerRestoreError === "owner_only"
              ? "Source download/restore is owner-only."
              : "This agent has no uploaded cloud package to restore.",
          },
        });
        return;
      }
      if (delayNextOwnerRestore) {
        delayNextOwnerRestore = false;
        setTimeout(() => sendJson(res, { result: ownerRestorePayload(ownerVersion, ownerPackage) }), 75);
        return;
      }
      sendJson(res, { result: ownerRestorePayload(ownerVersion, ownerPackage) });
      return;
    }
    sendJson(res, { result: null });
  });
});

server.listen(0, "127.0.0.1", async () => {
  let exitCode = 0;
  const mainModulePath = require.resolve("../dist/electron/main.js");
  const previousMainModule = require.cache[mainModulePath];
  const originalOpenExternal = shell.openExternal;
  let auth;
  try {
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    process.env.AGENTLAS_MCP_BASE_URL = `${baseUrl}/api/mcp/v1`;
    process.env.AGENTLAS_WEB_BASE_URL = baseUrl;

    // Owner restore has a larger bounded timeout than ordinary catalog calls.
    // Prove a response that exceeds a deliberately tiny base timeout still
    // completes through the dedicated restore budget.
    delayNextOwnerRestore = true;
    const { McpSource } = require("../dist/electron/marketplace/mcp-source.js");
    const slowRestoreSource = new McpSource({
      baseUrl: `${baseUrl}/api/mcp/v1`,
      timeoutMs: 25,
      cookieProvider: () => expectedCookie,
    });
    const slowRestored = await slowRestoreSource.restoreMyAgentPackage("owned-registry-agent");
    assert.equal(slowRestored.slug, "owned-registry-agent");

    // registry re-exports the chat store, whose locale helper normally imports
    // the full app entrypoint. Stub only that helper so this remains headless.
    require.cache[mainModulePath] = {
      id: mainModulePath,
      filename: mainModulePath,
      loaded: true,
      exports: { currentUiLocale: () => "en" },
      children: [],
      paths: [],
    };

    auth = require("../dist/electron/auth.js");
    shell.openExternal = async (loginUrl) => {
      const callback = new URL(loginUrl).searchParams.get("callback");
      assert.ok(callback, "browser auth must request a loopback callback");
      const callbackUrl = new URL(callback);
      callbackUrl.searchParams.set("session", sessionToken);
      setImmediate(() => {
        http.get(callbackUrl, (response) => response.resume()).on("error", () => {});
      });
    };
    const session = await auth.signInWithBrowser();
    assert.equal(session.signedIn, true);
    assert.equal(session.workspaceId, "owner-workspace");
    assert.equal(auth.getSessionCookieHeader(), expectedCookie);
    shell.openExternal = originalOpenExternal;

    const { listMyAgentsCached } = require("../dist/electron/marketplace/index.js");
    const cloudList = await listMyAgentsCached();
    assert.deepEqual(cloudList.map((item) => item.slug), ["owned-registry-agent"]);
    assert.equal(methodHits.get("cargo.search_agents"), 1);

    const { initStore, getDb } = require("../dist/electron/store/db.js");
    const { installAgent, installMyAgent } = require("../dist/electron/mcp/registry.js");
    const { getRoute, setRoute } = require("../dist/electron/agents/routes.js");
    const { recoverCloudRegistryTransactions } = require("../dist/electron/cloud-agents/registry-transaction.js");
    initStore();

    const hubInstalled = await installAgent("public-hub-agent");
    assert.equal(hubInstalled.assetSource, "hub");
    assert.equal(hubInstalled.packageHash, publicHubPackage.packageHash);
    assert.equal(methodHits.get("marketplace.get_manifest"), 1);
    if (process.platform !== "win32") {
      assert.equal(
        fs.statSync(path.join(hubInstalled.localPath, "scripts/run.sh")).mode & 0o777,
        0o700,
        "registry transaction must preserve the portable v2 executable contract",
      );
    }

    await assert.rejects(
      installAgent("public-call-only-agent"),
      /call-only and cannot be installed locally/,
      "a source-protected callable Hub card must fail with a human product boundary instead of a SQLite error",
    );
    assert.equal(
      getDb().prepare("SELECT COUNT(*) AS count FROM installed_agents WHERE slug = ?").get("public-call-only-agent").count,
      0,
      "a rejected call-only card must not leave a partial local registry row",
    );

    const installedV1 = await installMyAgent(cloudList[0].slug);
    const ownerDir = path.join(app.getPath("userData"), "agents", "owned-registry-agent");
    assert.equal(installedV1.assetSource, "agent-cloud");
    assert.equal(installedV1.packageHash, ownerV1.packageHash);
    assert.equal(installedV1.name, "Owned Registry Agent v1", "restore identity must beat stale draft metadata");
    assert.equal(fs.readFileSync(path.join(ownerDir, "AGENTS.md"), "utf8"), "# Owned Registry Agent v1\n\nPackage authority v1.\n");
    assert.equal(dbPrompt(getDb(), installedV1.id), "# Owned Registry Agent v1\n\nPackage authority v1.\n");
    assert.equal(
      require("../dist/electron/cloud-agents/restore.js")
        .readCloudAgentRestoreMarker(ownerDir).registrations["owner-private"].revision,
      `rev_${sha256("restore-revision:v1").slice(0, 32)}`,
      "owner restore must persist the exact revision baseline for the next If-Match update",
    );
    assert.deepEqual(dbDependencyMetadata(getDb(), installedV1.id), {
      mcpServers: ["owner-tool-v1"],
      trustGrade: "A",
      tone: "green",
    });
    assert.equal(getRoute(installedV1.id).source, "agent-cloud");
    assert.equal(getRoute(installedV1.id).packageHash, ownerV1.packageHash);

    const beforeRoute = structuredClone(getRoute(installedV1.id));
    const beforeMarker = fs.readFileSync(path.join(ownerDir, ".agentlas-cloud-package.json"), "utf8");
    const beforePrompt = dbPrompt(getDb(), installedV1.id);

    ownerRestoreError = "owner_only";
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      (error) => error && error.code === "owner_only" && error.message === "owner_only",
    );
    ownerRestoreError = "no_cloud_package";
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      (error) => error && error.code === "no_cloud_package" && error.message === "no_cloud_package",
    );
    assert.equal(dbPrompt(getDb(), installedV1.id), beforePrompt);
    assert.equal(fs.readFileSync(path.join(ownerDir, ".agentlas-cloud-package.json"), "utf8"), beforeMarker);
    assert.deepEqual(getRoute(installedV1.id), beforeRoute);

    ownerRestoreError = null;
    ownerVersion = "v2-corrupt";
    ownerPackage = structuredClone(ownerV2);
    ownerPackage.packageHash = "0".repeat(64);
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      /package hash (?:does not match|mismatch)/,
    );
    assert.equal(dbPrompt(getDb(), installedV1.id), beforePrompt, "DB metadata must not advance when owner restore fails");
    assert.equal(fs.readFileSync(path.join(ownerDir, "AGENTS.md"), "utf8"), "# Owned Registry Agent v1\n\nPackage authority v1.\n");
    assert.equal(fs.readFileSync(path.join(ownerDir, ".agentlas-cloud-package.json"), "utf8"), beforeMarker);
    assert.deepEqual(getRoute(installedV1.id), beforeRoute);

    const assertV1Coherent = (phase) => {
      assert.equal(dbPrompt(getDb(), installedV1.id), beforePrompt, `${phase}: DB must remain v1`);
      assert.deepEqual(
        dbDependencyMetadata(getDb(), installedV1.id),
        { mcpServers: ["owner-tool-v1"], trustGrade: "A", tone: "green" },
        `${phase}: dependency/trust metadata must remain v1`,
      );
      assert.equal(
        fs.readFileSync(path.join(ownerDir, "AGENTS.md"), "utf8"),
        "# Owned Registry Agent v1\n\nPackage authority v1.\n",
        `${phase}: managed files must remain v1`,
      );
      assert.equal(
        fs.readFileSync(path.join(ownerDir, ".agentlas-cloud-package.json"), "utf8"),
        beforeMarker,
        `${phase}: package marker must remain v1`,
      );
      assert.deepEqual(getRoute(installedV1.id), beforeRoute, `${phase}: route must remain v1`);
    };

    // Every fallible phase before SQLite commit compensates all three durable
    // surfaces: package directory, installed_agents row, and route JSON.
    ownerPackage = ownerV2;
    for (const phase of ["after-swap", "after-db", "after-route", "after-commit"]) {
      ownerVersion = `v2-${phase}`;
      process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE = phase;
      await assert.rejects(
        installMyAgent("owned-registry-agent"),
        new RegExp(`Injected Agent Cloud registry failure: ${phase}`),
      );
      delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
      assertV1Coherent(phase);
    }

    // Simulate a process disappearing at each phase: the E2E crash hook leaves
    // the journal intact and the next startup-style recovery must converge.
    for (const phase of ["after-swap", "after-db", "after-route"]) {
      ownerVersion = `v2-crash-${phase}`;
      process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE = `crash-${phase}`;
      await assert.rejects(
        installMyAgent("owned-registry-agent"),
        new RegExp(`Simulated abrupt Agent Cloud registry exit: ${phase}`),
      );
      delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
      recoverCloudRegistryTransactions();
      assertV1Coherent(`restart-${phase}`);
    }

    // A committed journal is still revalidated before its old backup is
    // deleted. If the live package kept the same marker but its bytes changed,
    // recovery rolls back and preserves the modified copy as an orphan.
    ownerVersion = "v2-crash-commit-tampered";
    process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE = "crash-after-journal-commit";
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      /Simulated abrupt Agent Cloud registry exit: after-journal-commit/,
    );
    delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
    fs.appendFileSync(path.join(ownerDir, "AGENTS.md"), "user edit after crash\n", "utf8");
    recoverCloudRegistryTransactions();
    assertV1Coherent("restart-committed-tampered");
    const agentsRoot = path.dirname(ownerDir);
    const preservedOrphan = fs.readdirSync(agentsRoot)
      .find((name) => name.startsWith(".owned-registry-agent.registry-orphan-"));
    assert.ok(preservedOrphan, "modified post-crash package must be preserved instead of deleted by marker hash");
    assert.match(
      fs.readFileSync(path.join(agentsRoot, preservedOrphan, "AGENTS.md"), "utf8"),
      /user edit after crash/,
    );
    fs.rmSync(path.join(agentsRoot, preservedOrphan), { recursive: true, force: true });

    // A process can also die after the durable committed journal but before its
    // obsolete backup is removed. Exact v2 files + DB + route let recovery
    // finalize without reverting the completed install.
    ownerVersion = "v2-crash-after-journal-commit";
    process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE = "crash-after-journal-commit";
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      /Simulated abrupt Agent Cloud registry exit: after-journal-commit/,
    );
    delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
    recoverCloudRegistryTransactions();
    assert.equal(dbPrompt(getDb(), installedV1.id), "# Owned Registry Agent v2\n\nPackage authority v2.\n");
    assert.equal(fs.readFileSync(path.join(ownerDir, "AGENTS.md"), "utf8"), "# Owned Registry Agent v2\n\nPackage authority v2.\n");
    assert.equal(getRoute(installedV1.id).packageHash, ownerV2.packageHash);

    ownerVersion = "v2";
    ownerPackage = ownerV2;
    const installedV2 = await installMyAgent("owned-registry-agent");
    assert.equal(installedV2.id, installedV1.id);
    assert.equal(installedV2.assetSource, "agent-cloud");
    assert.equal(installedV2.packageHash, ownerV2.packageHash);
    assert.equal(installedV2.name, "Owned Registry Agent v2");
    assert.deepEqual(installedV2.mcpServers, ["owner-tool-v2"]);
    assert.equal(installedV2.trustGrade, "B");
    assert.equal(installedV2.tone, "purple");
    assert.equal(dbPrompt(getDb(), installedV1.id), "# Owned Registry Agent v2\n\nPackage authority v2.\n");
    assert.deepEqual(dbDependencyMetadata(getDb(), installedV1.id), {
      mcpServers: ["owner-tool-v2"],
      trustGrade: "B",
      tone: "purple",
    });
    assert.equal(fs.existsSync(path.join(ownerDir, "skills/legacy.md")), false);
    assert.equal(fs.readFileSync(path.join(ownerDir, "skills/current.md"), "utf8"), "current\n");
    assert.equal(getRoute(installedV1.id).source, "agent-cloud");
    assert.equal(getRoute(installedV1.id).packageHash, ownerV2.packageHash);

    // A public-only owned package is also restorable. Restoring that scope must
    // retain the private revision baseline rather than making the next private
    // save look like an unsafe create from a new machine.
    ownerScope = "hub-public";
    ownerVersion = "v2-public-owner";
    ownerPackage = ownerV2;
    await installMyAgent("owned-registry-agent");
    const dualScopeMarker = require("../dist/electron/cloud-agents/restore.js")
      .readCloudAgentRestoreMarker(ownerDir);
    assert.match(dualScopeMarker.registrations["owner-private"].revision, /^rev_[a-f0-9]{32}$/);
    assert.equal(
      dualScopeMarker.registrations["hub-public"].revision,
      `rev_${sha256("restore-revision:v2-public-owner").slice(0, 32)}`,
    );
    ownerScope = "owner-private";

    // The exact restore marker is disk authority. A stale route cache must not
    // make UI/runtime diagnostics report the old package hash.
    const correctV2Route = structuredClone(getRoute(installedV1.id));
    setRoute({ ...correctV2Route, packageHash: ownerV1.packageHash });
    const markerAuthoritative = require("../dist/electron/mcp/registry.js").getAgentById(installedV1.id);
    assert.equal(markerAuthoritative.packageHash, ownerV2.packageHash);
    setRoute(correctV2Route);

    // A restored Agentlas runtime manifest can name a nested canonical entry.
    // The immutable package entry must populate the registry row and must also
    // be the exact prompt used by the normal owned-agent invocation composer;
    // a root fallback with different bytes must never win.
    ownerVersion = "nested-entry";
    ownerPackage = ownerNestedEntry;
    const installedNested = await installMyAgent("owned-registry-agent");
    assert.equal(installedNested.id, installedV1.id);
    assert.equal(dbPrompt(getDb(), installedNested.id), NESTED_ENTRY_PROMPT);
    assert.equal(
      fs.readFileSync(path.join(ownerDir, "agents/ceo/AGENT.md"), "utf8"),
      NESTED_ENTRY_PROMPT,
    );
    const { buildEffectiveAgentSystemPrompt } = require("../dist/electron/agents/files.js");
    const nestedEffectivePrompt = buildEffectiveAgentSystemPrompt(installedNested.id, dbPrompt(getDb(), installedNested.id));
    assert.equal(nestedEffectivePrompt, NESTED_ENTRY_PROMPT);
    assert.equal(nestedEffectivePrompt.includes(ROOT_FALLBACK_PROMPT), false);
    assert.equal(getRoute(installedNested.id).packageHash, ownerNestedEntry.packageHash);
    assert.equal(
      require("../dist/electron/cloud-agents/restore.js")
        .readCloudAgentRestoreMarker(ownerDir).registrations["owner-private"].revision,
      `rev_${sha256("restore-revision:nested-entry").slice(0, 32)}`,
    );

    // If both the old backup and exact new live copy are unavailable, recovery
    // must block without touching DB or route. Rolling metadata back alone would
    // recreate the original split-brain bug.
    ownerVersion = "v3-missing-backup";
    ownerPackage = ownerV3;
    process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE = "crash-after-journal-commit";
    await assert.rejects(
      installMyAgent("owned-registry-agent"),
      /Simulated abrupt Agent Cloud registry exit: after-journal-commit/,
    );
    delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
    const journalRoot = path.join(app.getPath("userData"), "agent-cloud-registry-journal");
    const pendingJournalFile = path.join(
      journalRoot,
      fs.readdirSync(journalRoot).find((name) => name.endsWith(".json")),
    );
    const pendingJournal = JSON.parse(fs.readFileSync(pendingJournalFile, "utf8"));
    fs.rmSync(pendingJournal.backupDir, { recursive: true, force: true });
    fs.appendFileSync(path.join(ownerDir, "AGENTS.md"), "tampered without backup\n", "utf8");
    const dbBeforeBlockedRecovery = dbPrompt(getDb(), installedV1.id);
    const routeBeforeBlockedRecovery = structuredClone(getRoute(installedV1.id));
    await assert.rejects(
      Promise.resolve().then(() => recoverCloudRegistryTransactions()),
      /backup is missing and the live copy is not the exact committed package/,
    );
    assert.equal(dbPrompt(getDb(), installedV1.id), dbBeforeBlockedRecovery, "blocked recovery must not mutate DB");
    assert.deepEqual(getRoute(installedV1.id), routeBeforeBlockedRecovery, "blocked recovery must not mutate route");
    assert.match(fs.readFileSync(path.join(ownerDir, "AGENTS.md"), "utf8"), /tampered without backup/);
    assert.equal(fs.existsSync(pendingJournalFile), true, "blocked recovery must retain its durable journal");

    assert.ok((methodHits.get("cargo.restore_package") || 0) >= 5, "owner install must use cargo.restore_package every time");
    assert.ok(cargoCookies.length > 0);
    assert.ok(cargoCookies.every((cookie) => cookie === expectedCookie), "every cargo call must carry the signed-in session cookie");

    console.log("cloud owner restore contract and registry ordering passed");
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    delete process.env.AGENTLAS_TEST_CLOUD_REGISTRY_FAILURE;
    shell.openExternal = originalOpenExternal;
    if (auth) await auth.signOut().catch(() => {});
    if (previousMainModule) require.cache[mainModulePath] = previousMainModule;
    else delete require.cache[mainModulePath];
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    if (app && typeof app.quit === "function") app.quit();
    process.exit(exitCode);
  }
});
