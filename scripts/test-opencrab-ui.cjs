#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "opencrab-ui");

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
  const mime = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
  };
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = resolveAsset(req.url);
      res.writeHead(file.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function assertNoPageErrors(page, errors, surface) {
  await page.waitForTimeout(150);
  assert.equal(await page.getByText(/문제가 생겼어요|Something went wrong/).count(), 0);
  assert.deepEqual(errors, [], `${surface} emitted errors: ${errors.join("\n")}`);
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "trex.html")) || !fs.existsSync(path.join(distDir, "oberon.html"))) {
    throw new Error("dist/renderer is missing; run npm run build:renderer first");
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
    await context.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify({ ...mockBridgeOptions(), openCrabReady: true, buildScenario: "opencrab-interview" })});
        window.localStorage.setItem("agentlas.locale", "ko");
        window.__openCrabTrexPayloads = [];
        window.__openCrabOberonPayloads = [];
        window.__openCrabPlanDelayMs = 0;
        window.agentlas.trex.contentAvailable = async () => ({ agy: true, codex: false });
        window.agentlas.trex.imageProviders = async () => ({ codex: false, gemini: false });
        window.agentlas.trex.generateContent = async (payload) => {
          window.__openCrabTrexPayloads.push(payload);
          return {
            ok: false,
            reason: "no-llm-runtime",
            openCrab: payload.useOpenCrab
              ? { requested: true, used: false, reason: "query_failed" }
              : undefined,
          };
        };
        window.agentlas.oberon.planWithCli = async (payload) => {
          window.__openCrabOberonPayloads.push(payload);
          const delayMs = Number(window.__openCrabPlanDelayMs || 0);
          if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
          return {
            ok: false,
            runtime: payload.runtime || "codex",
            runtimeLabel: payload.runtimeLabel || "Mock CLI",
            error: "mock planner unavailable",
            warnings: ["mock planner unavailable"],
            createdAtMs: Date.now(),
            openCrab: payload.useOpenCrab
              ? { requested: true, used: false, reason: "query_failed" }
              : undefined,
          };
        };
      `,
    });

    const trex = await context.newPage();
    const trexErrors = [];
    trex.on("pageerror", (error) => trexErrors.push(error.message));
    trex.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) trexErrors.push(message.text());
    });
    await trex.goto(`${baseUrl}/trex.html`, { waitUntil: "domcontentloaded" });
    const trexToggle = trex.getByRole("button", { name: "OpenCrab ○" });
    await trexToggle.waitFor({ timeout: 10_000 });
    await trexToggle.click();
    await trex.getByRole("button", { name: "OpenCrab ✓" }).waitFor();
    await trex.getByRole("textbox", { name: "발표 주제" }).fill("Agent OS 로컬 런타임 전략");
    await trex.getByRole("button", { name: "생성" }).click();
    await trex.waitForFunction(() => window.__openCrabTrexPayloads?.length === 1);
    const trexOptInPayload = await trex.evaluate(() => window.__openCrabTrexPayloads[0]);
    assert.equal(trexOptInPayload.useOpenCrab, true, "T-rex opt-in must cross IPC payload");
    assert.equal(trexOptInPayload.sources, undefined, "T-rex must not invent or send attachment bodies");
    await trex.waitForTimeout(2_800);
    assert.equal(await trex.getByText(/AI가 기획안을 반영하지 못했어요/).count(), 0, "optional OpenCrab failure must not become a content error");
    await assertNoPageErrors(trex, trexErrors, "T-rex");
    await trex.screenshot({ path: path.join(outDir, "trex-opencrab-opt-in.png"), fullPage: true });

    const oberon = await context.newPage();
    const oberonErrors = [];
    oberon.on("pageerror", (error) => oberonErrors.push(error.message));
    oberon.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) oberonErrors.push(message.text());
    });
    await oberon.goto(`${baseUrl}/oberon.html`, { waitUntil: "domcontentloaded" });
    await oberon.getByRole("button", { name: "새 제작 시작" }).click();
    await oberon.getByRole("button", { name: "Agentlas 모션광고" }).click();
    const oberonToggle = oberon.getByRole("button", { name: "OpenCrab 근거 ○" });
    await oberonToggle.waitFor({ timeout: 10_000 });
    await oberonToggle.click();
    await oberon.getByRole("button", { name: "OpenCrab 근거 ✓" }).waitFor();
    await oberon.getByRole("button", { name: "기획안 만들기" }).click();
    await oberon.waitForFunction(() => window.__openCrabOberonPayloads?.length === 1);
    const oberonOptInPayload = await oberon.evaluate(() => window.__openCrabOberonPayloads[0]);
    assert.equal(oberonOptInPayload.useOpenCrab, true, "Oberon opt-in must cross IPC payload");
    assert.equal(oberonOptInPayload.brief.logoSource, undefined, "Oberon planner brief should not invent a logo path");
    await oberon.getByText("기획안 확인하기").waitFor({ timeout: 10_000 });
    await oberon.getByText(/OpenCrab 보강은 건너뛰고 기존 기획 흐름으로 계속했습니다/).waitFor();
    const staleProduction = await oberon.evaluate(() => {
      const index = JSON.parse(window.localStorage.getItem("oberon.productions.index") || "[]");
      return index[0] ? { id: index[0].id, title: index[0].title } : null;
    });
    assert.ok(staleProduction?.id, "the first plan must be persisted for the stale-job regression fixture");

    // Starting a different project consumes/reset the previous run's consent.
    await oberon.getByRole("button", { name: "새 프로젝트" }).click();
    await oberon.getByRole("button", { name: "새 제작 시작" }).click();
    await oberon.getByRole("button", { name: "Agentlas 모션광고" }).click();
    await oberon.getByRole("button", { name: "OpenCrab 근거 ○" }).waitFor();
    const freshTitle = "Fresh OpenCrab race plan";
    const freshTitleInput = oberon.getByPlaceholder("e.g. MIDNIGHT BLOOM");
    await freshTitleInput.fill(freshTitle);
    await oberon.evaluate(({ staleId, staleTitle }) => {
      window.__openCrabPlanDelayMs = 700;
      const now = Date.now();
      window.localStorage.setItem("oberon.background.jobs.v1", JSON.stringify([{
        id: "stale-completed-plan",
        kind: "plan",
        productionId: staleId,
        title: staleTitle,
        label: "기획 생성",
        status: "succeeded",
        percent: 100,
        message: "기획안 생성 완료",
        phase: "complete",
        createdAtMs: now - 1_000,
        updatedAtMs: now,
      }]));
    }, { staleId: staleProduction.id, staleTitle: staleProduction.title });
    await oberon.getByRole("button", { name: "기획안 만들기" }).click();
    await oberon.waitForFunction(() => window.__openCrabOberonPayloads?.length === 2);
    await oberon.waitForTimeout(100);
    await oberon.getByText("Oberon 만들기가 계속 진행 중입니다").waitFor();
    await oberon.getByText(`기획 생성 · ${freshTitle}`, { exact: true }).waitFor();
    assert.equal(await oberon.getByRole("button", { name: "새 프로젝트" }).count(), 0,
      "a stale completed localStorage job must not be loaded as the active production while a fresh plan is starting");
    const oberonOptOutPayload = await oberon.evaluate(() => window.__openCrabOberonPayloads[1]);
    assert.equal(oberonOptOutPayload.useOpenCrab, false, "a new project must not inherit earlier OpenCrab consent");
    await oberon.getByText("기획안 확인하기").waitFor({ timeout: 10_000 });
    const latestSavedTitle = await oberon.evaluate(() => {
      const index = JSON.parse(window.localStorage.getItem("oberon.productions.index") || "[]");
      return index[0]?.title;
    });
    assert.equal(latestSavedTitle, freshTitle, "the fresh plan, not the stale production, must own the completed UI state");
    await assertNoPageErrors(oberon, oberonErrors, "Oberon");
    await oberon.screenshot({ path: path.join(outDir, "oberon-opencrab-opt-in.png"), fullPage: true });

    const build = await context.newPage();
    const buildErrors = [];
    build.on("pageerror", (error) => buildErrors.push(error.message));
    build.on("console", (message) => {
      if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) buildErrors.push(message.text());
    });
    await build.goto(`${baseUrl}/build.html`, { waitUntil: "domcontentloaded" });
    await build.getByRole("button", { name: /생성 폴더 선택|Choose output folder/ }).click();
    await build.locator("textarea").first().fill("OpenCrab 근거 확인형 리서치 에이전트");
    await build.getByRole("button", { name: /딥인터뷰로 빌드 시작|Start build/ }).click();
    await build.getByText("연결된 OpenCrab에서 이 빌드 요청과 관련된 지식이 있는지 확인할까요?").waitFor();
    await build.locator(".build-interview-card .build-interview-opt", { hasText: "리포트" }).click();
    await build.locator(".build-interview-card .build-interview-opt", { hasText: "비공개" }).click();
    await build.locator(".build-interview-card .build-interview-opt", { hasText: "관련성 확인하기" }).click();
    assert.equal(
      await build.evaluate(() => window.__qa.calls.filter((call) => call.name === "hephaestus.build").length),
      1,
      "Builder OpenCrab consent must not advance before the user confirms the interview batch",
    );
    await build.getByRole("button", { name: /선택 3개 확인|Confirm 3/ }).click();
    await build.getByText(/패키지 준비됨|Package ready/).waitFor({ timeout: 10_000 });
    const buildCalls = await build.evaluate(() => window.__qa.calls.filter((call) => call.name === "hephaestus.build"));
    assert.equal(buildCalls.length, 2);
    assert.equal(buildCalls[0].payload.openCrabOntology, undefined, "Builder must not query before explicit consent");
    assert.equal(buildCalls[1].payload.openCrabOntology, "use", "main-owned positive consent must cross the next-turn IPC payload");
    assert.ok(
      buildCalls[1].payload.history.some(
        (item) => item.role === "assistant" && item.text.includes("[Agentlas supplemental question]"),
      ),
      "the main-owned question must be preserved in the resumed conversation history",
    );
    await assertNoPageErrors(build, buildErrors, "Build");
    await build.screenshot({ path: path.join(outDir, "build-opencrab-consent.png"), fullPage: true });

    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }

  console.log(JSON.stringify({ ok: true, surfaces: ["trex", "oberon", "build"], payloadChecks: 10, stalePlanRace: true }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
