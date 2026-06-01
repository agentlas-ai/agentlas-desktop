#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  archiveSurfaceAssetPack,
  materializeSurfaceAssetPack,
  restoreSurfaceAssetPack,
} = require("../dist/electron/surface-assets/materialize.js");

(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-surface-assets-"));
  const png1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const result = await materializeSurfaceAssetPack(
    {
      chatId: "chat-smoke",
      surfaceId: "surface-creative-smoke",
      actionId: "asset-pack",
      manifest: {
        version: "0.1",
        kind: "surface",
        title: "Launch Creative Studio",
        domain: "creative",
        layout: "creative-studio",
        data: {
          brief: {
            type: "json",
            value: { product: "Desk lamp", channel: "Instagram Reels" },
          },
          shots: {
            type: "table",
            rows: [
              {
                scene: "Hook",
                duration: "2s",
                prompt: "Close-up product reveal on a clean desk.",
                model: "image-model",
                status: "approved",
              },
            ],
          },
          assets: {
            type: "media",
            rows: [
              {
                id: "asset_1",
                title: "Hero render",
                dataUrl: png1x1,
                status: "generated",
                evidenceIds: ["claim_1"],
              },
              {
                id: "asset_2",
                title: "Remote reference",
                url: "https://example.com/reference.png",
                status: "referenced",
              },
            ],
          },
          exports: {
            type: "table",
            rows: [{ channel: "Instagram", format: "1080x1920", caption: "Launch caption", status: "draft" }],
          },
        },
        widgets: [
          { type: "brief-panel", data: "brief" },
          { type: "storyboard", data: "shots" },
          { type: "asset-board", data: "assets" },
          { type: "export-pack", data: "exports" },
        ],
        actions: [{ id: "asset-pack", label: "Materialize asset pack", type: "materialize-asset-pack" }],
        evidence: [{ id: "claim_1", kind: "unverified", source: "Generated" }],
        capabilities: [
          { id: "image_generation", type: "model-generation", purpose: "Generate image variants", approval: "once" },
        ],
        budget: { currency: "USD", limit: 5, spent: 0, approvalThreshold: 1 },
      },
    },
    { baseDir, now: "2026-05-31T00:00:00.000Z" },
  );

  assert.ok(result.rootPath.startsWith(baseDir));
  assert.ok(fs.existsSync(result.indexPath));
  assert.ok(fs.existsSync(result.manifestPath));
  assert.ok(fs.existsSync(path.join(result.rootPath, "assets", "01-hero-render.png")));
  assert.ok(fs.existsSync(path.join(result.rootPath, "prompts", "01-hook.md")));
  assert.equal(result.remoteAssets.length, 1);
  assert.ok(result.fileUrl.startsWith("file://"));
  assert.match(fs.readFileSync(result.manifestPath, "utf8"), /Remote reference/);
  assert.match(fs.readFileSync(result.indexPath, "utf8"), /Agentlas Asset Pack/);

  const archived = await archiveSurfaceAssetPack({ rootPath: result.rootPath });
  assert.equal(archived.removed, true);
  assert.equal(archived.reversible, true);
  assert.ok(fs.existsSync(archived.archivePath));
  assert.ok(fs.existsSync(archived.manifestPath));
  assert.equal(fs.existsSync(result.rootPath), false);
  const archiveManifest = JSON.parse(fs.readFileSync(archived.manifestPath, "utf8"));
  assert.equal(archiveManifest.restore.operation, "surfaceAssets.restore");
  assert.equal(archiveManifest.gc.policy, "manual-confirmation-required");

  const restored = await restoreSurfaceAssetPack({ rootPath: result.rootPath });
  assert.equal(restored.restored, true);
  assert.ok(fs.existsSync(result.rootPath));
  assert.ok(fs.existsSync(result.indexPath));

  console.log("surface-assets smoke passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
