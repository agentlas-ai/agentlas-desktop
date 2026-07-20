#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "output", "playwright", "agentlas-one-live-travel");
const oneBaseUrl = process.env.AGENTLAS_ONE_QA_URL || "http://127.0.0.1:3100";
const prompt = "아이와 제주 2박 3일 여행 계획을 짜줘. 7월 24~26일, 총예산 120만원, 아이 낮잠은 오후 1~3시고 동선이 무리 없었으면 해. 실제 구매나 예약은 하지 말고, 날짜별 일정, 이동 순서, 예상 비용, 출발 전 체크리스트까지 만들어줘. 위치 좌표와 가격을 확인할 수 없으면 추측하지 말고 그대로 표시해.";

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

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-live-travel-"));
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let desktop;
  try {
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
    const rendererLog = [];
    page.on("console", (message) => rendererLog.push({ type: message.type(), text: message.text() }));
    page.on("pageerror", (error) => rendererLog.push({ type: "pageerror", text: error.stack || error.message }));
    page.on("requestfailed", (request) => rendererLog.push({
      type: "requestfailed",
      text: `${request.url()} :: ${request.failure()?.errorText ?? "unknown"}`,
    }));
    await page.addInitScript(() => window.localStorage.setItem("agentlas.locale", "ko"));
    await page.goto(`${oneBaseUrl}/one`, { waitUntil: "domcontentloaded" });
    try {
      await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).waitFor({ timeout: 30_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      const html = await page.content().catch(() => "");
      fs.writeFileSync(path.join(outDir, "travel-load-failure.txt"), `${page.url()}\n\n${body}\n\n${html.slice(0, 20_000)}\n\n${JSON.stringify(rendererLog, null, 2)}\n`);
      await page.screenshot({ path: path.join(outDir, "travel-load-failure.png") }).catch(() => undefined);
      throw new Error(`One shell did not become ready at ${page.url()}: ${body.slice(0, 1_000)}`, { cause: error });
    }
    await dismissOptionalIntro(page);

    const runtime = await page.evaluate(async () => ({
      profile: await window.agentlas.oneProfile.get(),
      runtimes: await window.agentlas.runtime.detect(true),
    }));
    assert.ok(runtime.profile?.oneId, "One profile must exist");
    assert.ok(runtime.runtimes.some((item) => item.active), "an active local provider runtime is required");

    const textarea = page.locator("textarea").last();
    await textarea.fill(prompt);
    await page.getByRole("button", { name: /Send|보내기/ }).click();
    const chatId = await waitForChat(page);
    assert.ok(chatId, "the exact travel request must reach the live Main history");
    await page.screenshot({ path: path.join(outDir, "travel-started.png") });

    let proof = null;
    const deadline = Date.now() + 600_000;
    while (Date.now() < deadline) {
      proof = await page.evaluate(async (chatId) => {
        const [history, receipt, task, activeChats] = await Promise.all([
          window.agentlas.invoke.history(chatId),
          window.agentlas.invoke.latestReceipt(chatId),
          window.agentlas.tasks.findForChat(chatId),
          window.agentlas.invoke.activeChats(),
        ]);
        return {
          history: history.map((entry) => ({ role: entry.role, text: entry.text })),
          receipt,
          task,
          activeChats,
        };
      }, chatId);
      if (proof.receipt && ["completed", "failed", "cancelled", "interrupted"].includes(proof.receipt.status)) break;
      await page.waitForTimeout(700);
    }
    fs.writeFileSync(path.join(outDir, "travel-terminal-proof.json"), `${JSON.stringify(proof, null, 2)}\n`);
    await page.screenshot({ path: path.join(outDir, "travel-terminal.png"), fullPage: true });
    assert.ok(proof?.receipt, "the travel request must produce an invocation receipt");
    assert.equal(proof.receipt.status, "completed", `travel work must complete: ${JSON.stringify(proof.receipt)}`);
    assert.ok(proof.task?.id, "the travel request must become a canonical Task");

    await page.waitForTimeout(1_000);
    const durable = await page.evaluate(async ({ runId, chatId, taskId }) => (
      window.agentlas.invoke.latestOneSurface({ runId, chatId, taskId })
    ), { runId: proof.receipt.runId, chatId, taskId: proof.task.id });
    fs.writeFileSync(path.join(outDir, "travel-proof.json"), `${JSON.stringify({ ...proof, durable }, null, 2)}\n`);
    assert.ok(durable?.manifest, "the real travel run must persist one validated result surface");
    const kinds = durable.manifest.blocks.map((block) => block.type);
    assert.ok(kinds.includes("Timeline"), `travel must preserve a real Timeline block: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("Budget"), `travel must preserve a real Budget block: ${JSON.stringify(kinds)}`);
    assert.ok(kinds.includes("Checklist"), `travel must preserve a real Checklist block: ${JSON.stringify(kinds)}`);
    if (kinds.includes("Map")) {
      const map = durable.manifest.blocks.find((block) => block.type === "Map");
      assert.ok(map.locations.every((item) => Number.isFinite(item.latitude) && Number.isFinite(item.longitude)), "a live map may contain only real coordinates");
    }

    const result = page.locator('section[aria-label="일의 결과"], section[aria-label="Work result"]').first();
    await result.waitFor({ timeout: 15_000 });
    await result.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(outDir, "travel-result.png"), fullPage: true });
    console.log(`Agentlas One live travel QA passed (${kinds.join(", ")})`);
  } finally {
    await desktop?.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
