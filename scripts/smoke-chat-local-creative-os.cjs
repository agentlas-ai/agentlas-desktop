#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-chat-creative-os-"));
process.env.AGENTLAS_STORE_PATH = path.join(baseDir, "agentlas.sqlite");
process.env.AGENTLAS_DISABLE_RUNTIME_PROBES = "1";

const productSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="700">
  <rect width="900" height="700" fill="#f8f1e8"/>
  <rect x="140" y="80" width="620" height="540" rx="28" fill="#fff" stroke="#ddcab8"/>
  <path d="M360 190h180l70 110-70 55v190H360V355l-70-55 70-110Z" fill="#d7bfa9" stroke="#5a4d43" stroke-width="10"/>
  <text x="450" y="610" text-anchor="middle" font-family="Arial" font-size="42" font-weight="800">Linen Jacket</text>
</svg>`);

const { initStore, getDb } = require("../dist/electron/store/db.js");
const { createChat, listChatMessages, setChatWorkingFolder } = require("../dist/electron/store/chats.js");
const { listAgentSurfaces } = require("../dist/electron/store/agent-surfaces.js");
const { listAgentApps } = require("../dist/electron/store/agent-apps.js");
const { listSurfaceAssetPacks } = require("../dist/electron/store/agent-surface-assets.js");
const { runMcpInvocation } = require("../dist/electron/mcp/client.js");

function seedAgent() {
  const now = "2026-05-31T00:00:00.000Z";
  getDb()
    .prepare(
      `INSERT INTO installed_agents (
        id, slug, name, tagline, system_prompt, mcp_servers_json,
        trust_grade, installed_at, tone, env_requirements_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "agent-local-creative-smoke",
      "local-creative-smoke",
      "Local Creative Smoke Agent",
      "Turns product input into operated creative Agentlas OS apps",
      "Create creative surfaces, asset packs, provider recipes, launch apps, and reusable tools.",
      "[]",
      "A",
      now,
      "green",
      "[]",
    );
}

function startProductServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/products/linen-jacket") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(`<!doctype html>
        <html>
          <head>
            <meta property="og:title" content="Linen Jacket | Agentlas Fixture" />
            <meta property="og:description" content="A lightweight linen jacket for city summer outfits." />
            <meta property="og:image" content="/media/linen-jacket.svg" />
            <meta property="og:site_name" content="Agentlas Fixture" />
          </head>
          <body>product fixture</body>
        </html>`);
      return;
    }
    if (req.url === "/media/linen-jacket.svg") {
      res.writeHead(200, { "content-type": "image/svg+xml", "content-length": productSvg.byteLength });
      res.end(productSvg);
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
  const productServer = await startProductServer();
  try {
    initStore();
    seedAgent();
    const address = productServer.address();
    const productUrl = `http://127.0.0.1:${address.port}/products/linen-jacket`;
    const chat = createChat({ agentId: "agent-local-creative-smoke", title: "Local creative Agent OS smoke" });
    setChatWorkingFolder(chat.id, baseDir);

    const events = [];
    await runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt: `${productUrl} 이 제품 URL로 릴스/틱톡/메타 광고팩 앱까지 알아서 만들어줘.`,
        images: [{ mediaType: "image/svg+xml", data: productSvg.toString("base64") }],
        locale: "ko",
        permissions: "full",
      },
      (event) => events.push(event),
    );

    assert.equal(events.some((event) => event.kind === "error" && event.error?.code === "no-runtime"), true);
    assert.equal(events.some((event) => event.kind === "surface" && event.surface?.domain === "creative"), false);
    assert.equal(events.some((event) => event.kind === "final" && /local meta-agent/i.test(event.text || "")), false);

    const surfaces = listAgentSurfaces(chat.id);
    assert.equal(surfaces.length, 0, "ordinary chat must not silently route product media into Creative Studio");

    const packs = listSurfaceAssetPacks(chat.id);
    assert.equal(packs.length, 0);

    const apps = listAgentApps(chat.id);
    assert.equal(apps.length, 0);

    const messages = listChatMessages(chat.id);
    assert.equal(messages.some((message) => message.role === "system" && /Asset pack:/.test(message.text)), false);

    console.log("chat creative prompt no-auto-routing smoke passed");
  } finally {
    await new Promise((resolve) => productServer.close(resolve));
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
