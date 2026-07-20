#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, ".artifacts", "one-composer-growth");
const distDir = path.join(root, "dist", "renderer");

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
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
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
      res.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

async function metrics(page) {
  return page.evaluate(() => {
    const textarea = document.querySelector('textarea[aria-label="Request for One"], textarea[aria-label="One에게 요청"]');
    const composer = textarea?.closest("form");
    if (!(textarea instanceof HTMLTextAreaElement) || !(composer instanceof HTMLFormElement)) {
      throw new Error("One composer is unavailable");
    }
    const textStyle = getComputedStyle(textarea);
    return {
      composerHeight: composer.getBoundingClientRect().height,
      textareaHeight: textarea.getBoundingClientRect().height,
      overflowY: textStyle.overflowY,
      rows: textarea.rows,
    };
  });
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-composer-"));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let desktop;
  let server;
  try {
    let baseUrl = process.env.AGENTLAS_ONE_QA_URL;
    if (!baseUrl) {
      const started = await startServer();
      server = started.server;
      baseUrl = started.baseUrl;
    }
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        NODE_ENV: "development",
        ELECTRON_START_URL: "about:blank",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    await page.addInitScript(() => window.localStorage.setItem("agentlas.locale", "en"));
    await page.goto(`${baseUrl}/one`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).waitFor({ timeout: 30_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      throw new Error(`One shell did not become ready at ${page.url()}: ${body.slice(0, 1_000)}`, { cause: error });
    }

    for (const label of ["Skip for now", "Skip onboarding", "Later", "나중에", "건너뛰기"]) {
      const button = page.getByRole("button", { name: label, exact: false }).first();
      if (await button.count()) await button.click().catch(() => undefined);
    }

    const input = page.locator('textarea[aria-label="Request for One"], textarea[aria-label="One에게 요청"]');
    await input.waitFor({ state: "visible", timeout: 30_000 });

    const empty = await metrics(page);
    assert.equal(empty.rows, 1);
    assert.ok(empty.textareaHeight <= 34, `empty textarea must be one line: ${JSON.stringify(empty)}`);
    assert.ok(empty.composerHeight <= 122, `empty composer must stay compact: ${JSON.stringify(empty)}`);
    assert.equal(empty.overflowY, "hidden", `empty composer must not show an inner scrollbar: ${JSON.stringify(empty)}`);
    await page.screenshot({ path: path.join(outDir, "01-compact.png") });

    await input.fill("line 1");
    await input.press("Shift+Enter");
    await input.type("line 2");
    await page.waitForTimeout(50);
    const shiftEnter = await metrics(page);
    assert.ok(shiftEnter.textareaHeight > empty.textareaHeight, `Shift+Enter must grow the textarea: ${JSON.stringify({ empty, shiftEnter })}`);

    await input.fill(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
    await page.waitForTimeout(50);
    const tenLines = await metrics(page);
    assert.ok(tenLines.textareaHeight >= 190 && tenLines.textareaHeight <= 212, `ten lines must expand the textarea: ${JSON.stringify(tenLines)}`);
    assert.ok(tenLines.composerHeight > empty.composerHeight + 150, `composer must grow with line breaks: ${JSON.stringify({ empty, tenLines })}`);
    await page.screenshot({ path: path.join(outDir, "02-ten-lines.png") });

    await input.fill(Array.from({ length: 15 }, (_, index) => `line ${index + 1}`).join("\n"));
    await page.waitForTimeout(50);
    const capped = await metrics(page);
    assert.ok(capped.textareaHeight <= 212, `textarea must stop near ten lines: ${JSON.stringify(capped)}`);
    assert.equal(capped.overflowY, "auto");

    await input.fill("");
    await page.waitForTimeout(50);
    const reset = await metrics(page);
    assert.ok(reset.textareaHeight <= 34 && reset.composerHeight <= 122, `cleared composer must shrink again: ${JSON.stringify(reset)}`);
    console.log(JSON.stringify({ ok: true, empty, shiftEnter, tenLines, capped, reset, screenshots: outDir }, null, 2));
  } finally {
    if (desktop) await desktop.close().catch(() => undefined);
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
