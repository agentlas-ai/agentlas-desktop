#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-creative-durable-"));
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");

const { initStore, getDb } = require("../dist/electron/store/db.js");
const {
  getAgentSurface,
  listAgentSurfaces,
  patchAgentSurfaceState,
  recordAgentSurface,
} = require("../dist/electron/store/agent-surfaces.js");
const {
  getSurfaceAssetPack,
  getSurfaceAssetPackBySurface,
  listSurfaceAssetPackOperations,
  recordMaterializedSurfaceAssetPack,
  recordSurfaceAssetPackOperation,
} = require("../dist/electron/store/agent-surface-assets.js");
const {
  approveAgentSurface,
  hasAgentSurfaceApproval,
  listAgentSurfaceApprovals,
  revokeAgentSurfaceApproval,
} = require("../dist/electron/store/agent-surface-approvals.js");
const { prepareCreativeAdPackManifest } = require("../dist/electron/creative-pack/surface.js");
const {
  archiveSurfaceAssetPack,
  materializeSurfaceAssetPack,
  restoreSurfaceAssetPack,
} = require("../dist/electron/surface-assets/materialize.js");

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const png = Buffer.from(pngBase64, "base64");

function startProductServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/products/orbit-lamp") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Orbit Lamp | Example Shop" />
            <meta property="og:description" content="A compact adjustable desk lamp for evening work." />
            <meta property="og:image" content="/media/orbit-lamp.png" />
            <meta property="og:site_name" content="Example Shop" />
          </head>
          <body>Orbit Lamp</body>
        </html>`);
      return;
    }
    if (req.url === "/media/orbit-lamp.png") {
      res.writeHead(200, { "content-type": "image/png", "content-length": png.byteLength });
      res.end(png);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function seedChat() {
  const now = "2026-05-31T00:00:00.000Z";
  const db = getDb();
  db.prepare(
    `INSERT INTO installed_agents (
      id, slug, name, tagline, system_prompt, mcp_servers_json,
      trust_grade, installed_at, tone, env_requirements_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "agent-creative-smoke",
    "creative-smoke",
    "Creative Smoke Agent",
    "Builds durable creative surfaces",
    "",
    "[]",
    "local",
    now,
    "warm",
    "[]",
  );
  db.prepare(
    `INSERT INTO chats (id, project_id, agent_id, title, created_at, updated_at, working_folder)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "chat-creative-durable",
    null,
    "agent-creative-smoke",
    "Creative durable smoke",
    now,
    now,
    baseDir,
  );
}

(async () => {
  const server = await startProductServer();
  const address = server.address();
  assert.equal(typeof address, "object");

  try {
    initStore();
    seedChat();

    const productUrl = `http://127.0.0.1:${address.port}/products/orbit-lamp`;
    const manifest = await prepareCreativeAdPackManifest({
      prompt: `제품 URL로 소셜 광고팩 surface 만들어줘: ${productUrl}`,
      images: [{ mediaType: "image/png", data: pngBase64 }],
      now: "2026-05-31T00:00:00.000Z",
    });
    assert.ok(manifest);

    const surfaceId = "surface-creative-durable";
    const first = recordAgentSurface({
      id: surfaceId,
      chatId: "chat-creative-durable",
      projectId: null,
      agentId: "agent-creative-smoke",
      manifest,
    });
    assert.equal(first.manifest.layout, "creative-studio");
    assert.ok((first.jobSummary?.jobCount ?? 0) >= 2);

    patchAgentSurfaceState({
      surfaceId,
      path: "/data/shots/rows/0/status",
      value: "approved",
      actor: "user",
      label: "approve hook shot",
    });

    const reEmitted = recordAgentSurface({
      id: surfaceId,
      chatId: "chat-creative-durable",
      projectId: null,
      agentId: "agent-creative-smoke",
      manifest,
    });
    assert.equal(reEmitted.state.data?.shots?.rows?.[0]?.status, "approved");

    const reopened = getAgentSurface(surfaceId);
    assert.equal(reopened?.state.data?.shots?.rows?.[0]?.status, "approved");
    assert.equal(listAgentSurfaces("chat-creative-durable").length, 1);

    const scopeKey = "surface-action:surface-creative-durable:asset-pack:materialize-asset-pack:asset_pack_filesystem:5:1:";
    const approval = approveAgentSurface({
      surfaceId,
      actionId: "asset-pack",
      actionType: "materialize-asset-pack",
      kind: "capability",
      scopeKey,
      title: "Materialize asset pack",
      summary: "Approve writing a reusable creative asset pack.",
      metadata: { capabilities: [{ id: "asset_pack_filesystem", type: "filesystem" }] },
    });
    assert.equal(hasAgentSurfaceApproval({ surfaceId, scopeKey }), true);
    assert.equal(listAgentSurfaceApprovals(surfaceId).length, 1);
    assert.throws(
      () =>
        approveAgentSurface({
          surfaceId,
          actionId: "unsafe-secret",
          actionType: "request-credential",
          kind: "credential",
          scopeKey: "surface-action:unsafe-secret",
          title: "Unsafe secret",
          summary: "This must not be stored in approval metadata.",
          metadata: { apiKey: "must-not-enter-ledger" },
        }),
      /must not contain secret/,
    );
    const revoked = revokeAgentSurfaceApproval(approval.id);
    assert.ok(revoked.revokedAt);
    assert.equal(hasAgentSurfaceApproval({ surfaceId, scopeKey }), false);

    const materialized = await materializeSurfaceAssetPack(
      {
        chatId: "chat-creative-durable",
        surfaceId,
        actionId: "asset-pack",
        manifest,
      },
      { baseDir, now: "2026-05-31T00:00:00.000Z", downloadRemoteAssets: true },
    );
    assert.ok(fs.existsSync(materialized.indexPath));
    assert.ok(fs.existsSync(path.join(materialized.rootPath, "assets", "01-product-image-1.png")));
    assert.equal(materialized.remoteAssets.find((asset) => asset.id === "product_hero_remote")?.status, "downloaded");

    const pack = recordMaterializedSurfaceAssetPack({
      chatId: "chat-creative-durable",
      projectId: null,
      agentId: "agent-creative-smoke",
      surfaceId,
      actionId: "asset-pack",
      manifest,
      snapshot: materialized,
    });
    assert.equal(pack.status, "materialized");
    assert.equal(getSurfaceAssetPackBySurface("chat-creative-durable", surfaceId)?.id, pack.id);
    assert.equal(listSurfaceAssetPackOperations(pack.id).at(-1)?.operation, "materialize");

    const archiveResult = await archiveSurfaceAssetPack({ rootPath: materialized.rootPath });
    const op = recordSurfaceAssetPackOperation(pack.id, "archive", true, archiveResult, "archived");
    assert.equal(op.operation, "archive");
    assert.equal(getSurfaceAssetPack(pack.id)?.status, "archived");
    assert.equal(archiveResult.reversible, true);
    assert.ok(fs.existsSync(archiveResult.archivePath));
    assert.equal(JSON.parse(fs.readFileSync(archiveResult.manifestPath, "utf8")).restore.operation, "surfaceAssets.restore");
    assert.equal(fs.existsSync(materialized.rootPath), false);

    const restoreResult = await restoreSurfaceAssetPack({ rootPath: materialized.rootPath });
    const restoreOp = recordSurfaceAssetPackOperation(pack.id, "restore", true, restoreResult, "restored");
    assert.equal(restoreOp.operation, "restore");
    assert.equal(getSurfaceAssetPack(pack.id)?.status, "restored");
    assert.equal(restoreResult.restored, true);
    assert.ok(fs.existsSync(materialized.rootPath));

    console.log("creative-durable smoke passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
})()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
  console.error(err);
  process.exit(1);
});
