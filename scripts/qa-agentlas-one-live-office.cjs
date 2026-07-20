#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "output", "playwright", "agentlas-one-live-office");
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
const prompt = [
  "아래 7월 영수증을 정리해줘.",
  "7/2 교통 카카오T 18,400원 출장, 7/3 식비 행복식당 32,000원 팀 점심,",
  "7/5 소프트웨어 Figma 24,000원 구독, 7/8 교통 KTX 59,800원 출장,",
  "7/12 비품 오피스몰 87,500원 프린터 토너.",
  "날짜·분류·사용처·금액·메모 열과 합계·분류별 요약이 있는 실제 Excel 파일(.xlsx),",
  "그리고 핵심 지출과 확인할 점을 담은 실제 1페이지 Word 보고서(.docx)를 현재 작업 폴더에 만들어줘.",
  "파일 이름은 7월-영수증-정리.xlsx와 7월-지출-보고서.docx로 해줘.",
  "단순히 확장자만 바꾸지 말고 실제로 열리는 파일이어야 해. 결과 화면에는 요약, 표, 만든 파일을 보여줘.",
].join(" ");

async function dismissOptionalIntro(page) {
  for (const label of ["나중에", "건너뛰기", "Skip for now", "Skip onboarding"]) {
    const button = page.getByRole("button", { name: label, exact: false }).first();
    if (await button.count()) await button.click().catch(() => undefined);
  }
}

async function waitForChat(page) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const chatId = await page.evaluate(async (expectedPrompt) => {
      const chats = await window.agentlas.chats.listRecent(30);
      for (const chat of chats) {
        const history = await window.agentlas.invoke.history(chat.id);
        if (history.some((entry) => entry.role === "user" && entry.text === expectedPrompt)) return chat.id;
      }
      return null;
    }, prompt);
    if (chatId) return chatId;
    await page.waitForTimeout(120);
  }
  return null;
}

function verifyOfficeFiles(bindings) {
  const document = bindings.find((item) => item.kind === "document" && item.source_path.endsWith(".docx"));
  const spreadsheet = bindings.find((item) => item.kind === "spreadsheet" && item.source_path.endsWith(".xlsx"));
  assert.ok(document, `a bound .docx is required: ${JSON.stringify(bindings)}`);
  assert.ok(spreadsheet, `a bound .xlsx is required: ${JSON.stringify(bindings)}`);
  for (const item of [document, spreadsheet]) {
    assert.ok(fs.statSync(item.source_path).isFile(), `${item.source_path} must be a real file`);
    assert.ok(fs.statSync(item.source_path).size > 0, `${item.source_path} must not be empty`);
  }
  const check = spawnSync("python3", ["-c", [
    "import sys",
    "from docx import Document",
    "from openpyxl import load_workbook",
    "doc=Document(sys.argv[1])",
    "book=load_workbook(sys.argv[2], data_only=False)",
    "assert len(doc.paragraphs) >= 3",
    "sheet=book.active",
    "assert sheet.max_row >= 6 and sheet.max_column >= 5",
    "print(f'doc_paragraphs={len(doc.paragraphs)} rows={sheet.max_row} columns={sheet.max_column}')",
  ].join(";"), document.source_path, spreadsheet.source_path], { encoding: "utf8" });
  assert.equal(check.status, 0, `generated Office files must parse: ${check.stderr || check.stdout}`);
  fs.copyFileSync(document.source_path, path.join(outDir, path.basename(document.source_path)));
  fs.copyFileSync(spreadsheet.source_path, path.join(outDir, path.basename(spreadsheet.source_path)));
  return { document, spreadsheet, parseProof: check.stdout.trim() };
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-live-office-"));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let desktop;
  let server;
  let proof = null;
  let chatId = null;
  try {
    let oneBaseUrl = process.env.AGENTLAS_ONE_QA_URL;
    if (!oneBaseUrl) {
      const started = await startServer();
      server = started.server;
      oneBaseUrl = started.baseUrl;
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
    await page.addInitScript(() => window.localStorage.setItem("agentlas.locale", "ko"));
    await page.goto(`${oneBaseUrl}/one`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).waitFor({ timeout: 30_000 });
    await dismissOptionalIntro(page);

    const textarea = page.locator("textarea").last();
    await textarea.fill(prompt);
    await page.getByRole("button", { name: /Send|보내기/ }).click();
    chatId = await waitForChat(page);
    assert.ok(chatId, "the exact office request must reach live Main history");
    await page.screenshot({ path: path.join(outDir, "office-started.png") });

    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      proof = await page.evaluate(async (id) => {
        const [history, receipt, task, activeChats] = await Promise.all([
          window.agentlas.invoke.history(id),
          window.agentlas.invoke.latestReceipt(id),
          window.agentlas.tasks.findForChat(id),
          window.agentlas.invoke.activeChats(),
        ]);
        return { history: history.map((entry) => ({ role: entry.role, text: entry.text })), receipt, task, activeChats };
      }, chatId);
      if (proof.receipt && ["completed", "failed", "cancelled", "interrupted"].includes(proof.receipt.status)) break;
      await page.waitForTimeout(700);
    }
    assert.ok(proof?.receipt, "the office request must produce an invocation receipt");
    assert.equal(proof.receipt.status, "completed", `office work must complete: ${JSON.stringify(proof.receipt)}`);
    assert.ok(proof.task?.id, "the office request must become a canonical Task");

    await page.waitForTimeout(1_000);
    const durable = await page.evaluate(async ({ runId, currentChatId, taskId }) => (
      window.agentlas.invoke.latestOneSurface({ runId, chatId: currentChatId, taskId })
    ), { runId: proof.receipt.runId, currentChatId: chatId, taskId: proof.task.id });
    assert.ok(durable?.manifest, "the real office run must persist one validated result surface");
    const kinds = durable.manifest.blocks.map((block) => block.type);
    assert.ok(kinds.includes("Table"), `office work must preserve a real table: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("ArtifactList"), `office work must preserve actual files: ${JSON.stringify(kinds)}`);
    const artifacts = durable.manifest.fallback.artifacts;
    assert.ok(artifacts.some((item) => item.label.endsWith(".docx")), `surface must name the Word file: ${JSON.stringify(artifacts)}`);
    assert.ok(artifacts.some((item) => item.label.endsWith(".xlsx")), `surface must name the Excel file: ${JSON.stringify(artifacts)}`);
    assert.ok(artifacts.every((item) => item.verificationStatus === "verified"), `Main-bound files must be shown as checked: ${JSON.stringify(artifacts)}`);

    // Abort any in-flight App Router query transition and prove that the exact
    // durable Task can restore from a fresh document load, as the packaged app
    // must do after a restart.
    await page.goto(`${oneBaseUrl}/one?task=${encodeURIComponent(proof.task.id)}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).waitFor({ timeout: 30_000 });
    const result = page.locator('section[aria-label="일의 결과"], section[aria-label="Work result"]').first();
    await result.waitFor({ timeout: 15_000 });
    await result.scrollIntoViewIfNeeded();
    const resultText = await result.innerText();
    assert.doesNotMatch(resultText, /Python|openpyxl|python-docx|라이브러리|스크립트|오타|줄바꿈된 콜론/i, "beginner result must hide implementation narration");
    await page.screenshot({ path: path.join(outDir, "office-result.png"), fullPage: true });
    fs.writeFileSync(path.join(outDir, "office-surface-proof.json"), `${JSON.stringify({ ...proof, durable }, null, 2)}\n`);
  } finally {
    await desktop?.close().catch(() => {});
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  try {
    assert.ok(proof?.receipt?.runId && chatId, "terminal run identity is required for binding verification");
    const dbPath = path.join(userData, "agentlas.sqlite");
    const runId = String(proof.receipt.runId).replaceAll("'", "''");
    const query = spawnSync("sqlite3", [
      "-json",
      dbPath,
      `SELECT artifact_ref, source_path, kind, mime_type, size_bytes, sha256 FROM one_artifact_bindings WHERE run_id = '${runId}' ORDER BY artifact_ref`,
    ], { encoding: "utf8" });
    assert.equal(query.status, 0, `artifact binding query must succeed: ${query.stderr}`);
    const bindings = JSON.parse(query.stdout || "[]");
    const files = verifyOfficeFiles(bindings);
    fs.writeFileSync(path.join(outDir, "office-file-proof.json"), `${JSON.stringify({ runId: proof.receipt.runId, bindings, parseProof: files.parseProof }, null, 2)}\n`);
    console.log(`Agentlas One live Office QA passed (${files.parseProof})`);
  } finally {
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
