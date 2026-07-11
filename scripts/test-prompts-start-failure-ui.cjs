#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");

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

function installPromptFixtures(withInputs) {
  const prompt = {
    slug: withInputs ? "qa-input-prompt" : "qa-simple-prompt",
    titleKo: withInputs ? "입력물 프롬프트" : "일반 프롬프트",
    titleEn: withInputs ? "Input Prompt" : "Simple Prompt",
    summaryKo: "채팅 생성 실패 복구 테스트",
    summaryEn: "Chat creation failure recovery fixture",
    inputsKo: withInputs ? "분석할 PDF와 원하는 출력 형식" : "",
    inputsEn: withInputs ? "A PDF to analyze and the desired output format" : "",
    category: "QA",
    authorName: "Agentlas QA",
    models: ["any"],
    unlocked: true,
    tasted: false,
    bookmarked: true,
  };
  const body = withInputs
    ? "INPUT_PROMPT_BODY_MUST_SURVIVE_CHAT_CREATE_FAILURE"
    : "SIMPLE_PROMPT_BODY_MUST_SURVIVE_CHAT_CREATE_FAILURE";
  const viewer = { signedIn: true, paidAccess: true };
  window.agentlas.promptHub = {
    list: async () => ({ ok: true, prompts: [prompt], viewer }),
    get: async () => ({ ok: true, prompt: { ...prompt, body } }),
    unlock: async () => ({ ok: true, body }),
    taste: async () => ({ ok: true, body }),
    tastes: async () => ({ ok: true, count: 0 }),
    bookmarks: async () => ({ ok: true, slugs: [prompt.slug] }),
    bookmarkAdd: async () => ({ ok: true, bookmarked: true }),
    bookmarkRemove: async () => ({ ok: true, bookmarked: false }),
  };
  const createChat = window.agentlas.chats.create;
  let failuresRemaining = 1;
  const priorAttempts = Number(localStorage.getItem("agentlas.qa.promptStartAttempts") || "0");
  window.__promptStartQa = { attempts: priorAttempts, body };
  window.agentlas.chats.create = async (input) => {
    window.__promptStartQa.attempts += 1;
    localStorage.setItem("agentlas.qa.promptStartAttempts", String(window.__promptStartQa.attempts));
    if (failuresRemaining > 0) {
      failuresRemaining -= 1;
      throw new Error("mock chat creation failure");
    }
    return createChat(input);
  };
}

async function runScenario(browser, baseUrl, withInputs) {
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const init = `(${setupMockAgentlasBridge.toString()})(${JSON.stringify(mockBridgeOptions({}))});(${installPromptFixtures.toString()})(${JSON.stringify(withInputs)});`;
  await context.addInitScript({ content: init });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/favicon|Failed to load resource/i.test(message.text())) errors.push(message.text());
  });

  await page.goto(`${baseUrl}/prompts.html`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /자세히|Details/ }).click();
  const bodyText = withInputs
    ? "INPUT_PROMPT_BODY_MUST_SURVIVE_CHAT_CREATE_FAILURE"
    : "SIMPLE_PROMPT_BODY_MUST_SURVIVE_CHAT_CREATE_FAILURE";
  await page.getByText(bodyText, { exact: true }).waitFor();
  await page.getByRole("button", { name: /이 프롬프트로 새 채팅 시작|Start a new chat with this prompt/ }).click();

  if (withInputs) {
    const inputDialog = page.getByRole("dialog", { name: /필요 입력물 안내|Required inputs notice/ });
    await inputDialog.getByText(/분석할 PDF|A PDF to analyze/).waitFor();
    await inputDialog.getByRole("button", { name: /그래도 시작|Start anyway/ }).click();
    await inputDialog.getByTestId("prompt-start-error").waitFor();
    await inputDialog.getByText(/분석할 PDF|A PDF to analyze/).waitFor();
    assert.equal(await page.getByText(bodyText, { exact: true }).count(), 1, "prompt body must remain mounted behind the input notice");
    assert.equal(await page.evaluate(() => window.__promptStartQa.attempts), 1);
    await inputDialog.getByRole("button", { name: /다시 시도|Retry/ }).click();
  } else {
    const detail = page.getByRole("dialog", { name: /일반 프롬프트|Simple Prompt/ });
    await detail.getByTestId("prompt-start-error").waitFor();
    await detail.getByText(bodyText, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__promptStartQa.attempts), 1);
    await detail.getByRole("button", { name: /다시 시도|Retry/ }).click();
  }

  await page.waitForURL(/\/chat(?:\.html)?\?id=chat-created-1/, { timeout: 10000 });
  assert.equal(await page.evaluate(() => window.__promptStartQa.attempts), 2, "retry must reuse the retained prompt and create exactly one new chat");
  assert.deepEqual(errors, [], `renderer errors: ${errors.join("\n")}`);
  await context.close();
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "prompts.html"))) {
    throw new Error("dist/renderer missing; run npm run build:renderer first");
  }
  const pickerSource = fs.readFileSync(path.join(root, "renderer", "components", "PromptPickerDialog.tsx"), "utf8");
  assert.match(pickerSource, /setStartFailure\(\{ body, seedOnly, slug \}\)/, "sidebar picker must retain one-time prompt bodies on create failure");
  assert.doesNotMatch(pickerSource, /async function startNow[\s\S]{0,160}setPendingStart\(null\)/, "picker must not discard required inputs before create succeeds");

  const { chromium } = require("playwright");
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    await runScenario(browser, baseUrl, false);
    await runScenario(browser, baseUrl, true);
    console.log("test-prompts-start-failure-ui: PASS");
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
