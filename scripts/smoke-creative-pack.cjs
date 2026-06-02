#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {
  prepareCreativeAdPackManifest,
  shouldSeedCreativeAdPack,
} = require("../dist/electron/creative-pack/surface.js");
const {
  archiveSurfaceAssetPack,
  materializeSurfaceAssetPack,
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

(async () => {
  const server = await startProductServer();
  const address = server.address();
  assert.equal(typeof address, "object");
  const productUrl = `http://127.0.0.1:${address.port}/products/orbit-lamp`;
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-creative-pack-"));

  try {
    const prompt = `이 상품 URL로 릴스 광고 영상/이미지 에셋팩 만들어줘: ${productUrl}`;
    const images = [{ mediaType: "image/png", data: pngBase64 }];
    assert.equal(shouldSeedCreativeAdPack(prompt, images), true);

    const manifest = await prepareCreativeAdPackManifest({
      prompt,
      images,
      now: "2026-05-31T00:00:00.000Z",
    });

    assert.ok(manifest);
    assert.equal(manifest.layout, "creative-studio");
    assert.match(manifest.title, /Orbit Lamp/);
    assert.ok(manifest.actions.some((action) => action.type === "materialize-asset-pack"));
    assert.ok(manifest.actions.some((action) => action.type === "connect-service"));
    assert.ok(manifest.capabilities.some((capability) => capability.type === "network"));
    assert.ok(manifest.capabilities.some((capability) => capability.type === "browser-session"));
    assert.ok(manifest.claims?.some((claim) => claim.id === "claim_product_identity"));

    const result = await materializeSurfaceAssetPack(
      {
        chatId: "chat-creative-smoke",
        surfaceId: "surface-creative-smoke",
        actionId: "asset-pack",
        manifest,
      },
      { baseDir, now: "2026-05-31T00:00:00.000Z", downloadRemoteAssets: true },
    );

    assert.ok(fs.existsSync(path.join(result.rootPath, "assets", "01-product-image-1.png")));
    const remote = result.remoteAssets.find((asset) => asset.id === "product_hero_remote");
    assert.equal(remote?.status, "downloaded");
    assert.ok(remote?.downloadedPath);
    assert.ok(fs.existsSync(path.join(result.rootPath, remote.downloadedPath)));
    assert.match(fs.readFileSync(result.manifestPath, "utf8"), /creative_browser_delegation/);
    assert.match(fs.readFileSync(result.indexPath, "utf8"), /Orbit Lamp/);

    const archived = await archiveSurfaceAssetPack({ rootPath: result.rootPath });
    assert.equal(archived.removed, true);
    console.log("creative-pack smoke passed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
