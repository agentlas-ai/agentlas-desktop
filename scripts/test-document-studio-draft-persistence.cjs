#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const DRAFT_KEY = "agentlas.docstudio.draft.v1";

function resolveAsset(urlPath) {
  let pathname = decodeURIComponent((urlPath || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname);
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname}.html`);
    if (fs.existsSync(html)) return html;
  }
  return path.join(distDir, "404.html");
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      const ext = path.extname(file);
      const mime = ext === ".html" ? "text/html; charset=utf-8"
        : ext === ".js" ? "text/javascript; charset=utf-8"
          : ext === ".css" ? "text/css; charset=utf-8"
            : ext === ".json" ? "application/json; charset=utf-8"
              : "application/octet-stream";
      res.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": mime });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

function installDocumentFixtures() {
  const figureSrc = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIyNCI+PHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjI0IiBmaWxsPSIjMTA4MzM0Ii8+PC9zdmc+";
  window.agentlas.document = {
    available: async () => ({ agy: true, codex: true }),
    generate: async () => ({ ok: false, reason: "fixture-not-used" }),
    revise: async () => ({ ok: false }),
  };
  window.agentlas.trex = {
    ...(window.agentlas.trex || {}),
    generateImage: async () => ({ ok: true, src: figureSrc, engine: "qa-image" }),
  };
}

async function main() {
  const entry = path.join(distDir, "apps", "document-studio.html");
  if (!fs.existsSync(entry)) throw new Error("dist/renderer missing; run npm run build:renderer first");

  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    const init = `(${setupMockAgentlasBridge.toString()})(${JSON.stringify(mockBridgeOptions({}))});(${installDocumentFixtures.toString()})();`;
    await context.addInitScript({ content: init });
    let page = await context.newPage();
    const errors = [];
    const watch = (target) => {
      target.on("pageerror", (error) => errors.push(error.message));
      target.on("console", (message) => {
        if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
      });
    };
    watch(page);

    const url = `${baseUrl}/apps/document-studio.html`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const title = page.getByLabel(/Document title|문서 제목/);
    const body = page.getByLabel(/Document editor|문서 편집기/);
    const caption = page.getByLabel(/Figure note|도표 메모/);
    await title.fill("영속되는 문서 제목");
    await body.fill("# 첫 섹션\n\n탐색 중인 본문은 화면을 옮겨도 유지되어야 한다.");
    await caption.fill("로컬과 클라우드 사이의 문서 흐름");
    await page.getByTitle(/Generate figure image from the note|메모로 도표 이미지 생성/).click();
    await page.locator('img[alt="로컬과 클라우드 사이의 문서 흐름"]').waitFor();
    await page.waitForFunction((key) => {
      const raw = localStorage.getItem(key);
      return Boolean(raw && JSON.parse(raw).body.includes("화면을 옮겨도"));
    }, DRAFT_KEY);

    // Route away and back in the same renderer storage scope.
    await page.goto(`${baseUrl}/apps.html`, { waitUntil: "domcontentloaded" });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    assert.equal(await title.inputValue(), "영속되는 문서 제목");
    assert.match(await body.inputValue(), /화면을 옮겨도 유지/);
    assert.equal(await caption.inputValue(), "로컬과 클라우드 사이의 문서 흐름");
    await page.locator('img[alt="로컬과 클라우드 사이의 문서 흐름"]').waitFor();

    // Close/recreate the page to model a renderer/app restart.
    await page.close();
    page = await context.newPage();
    watch(page);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    assert.equal(await page.getByLabel(/Document title|문서 제목/).inputValue(), "영속되는 문서 제목");
    assert.match(await page.getByLabel(/Document editor|문서 편집기/).inputValue(), /탐색 중인 본문/);
    assert.equal(await page.getByLabel(/Figure note|도표 메모/).inputValue(), "로컬과 클라우드 사이의 문서 흐름");
    await page.locator('img[alt="로컬과 클라우드 사이의 문서 흐름"]').waitFor();
    const stored = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)), DRAFT_KEY);
    assert.equal(stored.version, 1, "draft storage must be explicitly versioned");
    assert.match(stored.figureSrc, /^data:image\//, "generated chart must survive restart");

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("document-studio-new-document").click();
    await assert.doesNotReject(() => page.waitForFunction((key) => localStorage.getItem(key) === null, DRAFT_KEY));
    assert.equal(await page.getByLabel(/Document title|문서 제목/).inputValue(), "");
    assert.equal(await page.getByLabel(/Document editor|문서 편집기/).inputValue(), "");
    assert.equal(await page.getByLabel(/Figure note|도표 메모/).inputValue(), "");
    assert.equal(
      await page.locator('img[alt="로컬과 클라우드 사이의 문서 흐름"]').count(),
      0,
      "new document must clear the generated chart",
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    assert.equal(await page.getByLabel(/Document title|문서 제목/).inputValue(), "", "reset must survive restart");
    assert.deepEqual(errors, [], `renderer errors: ${errors.join("\n")}`);
    await context.close();
    console.log("test-document-studio-draft-persistence: PASS");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
