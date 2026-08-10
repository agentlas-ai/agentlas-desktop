#!/usr/bin/env node

// Deterministic renderer QA for Codex-style steering while a chat run is busy.
//
// Prerequisite:
//   npm run build:renderer
// Run:
//   node scripts/qa-chat-steering-ui.cjs

// The test uses the shared renderer mock bridge, records the visible transition
// to WebM, and keeps all proof artifacts under ignored output/playwright/.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  setupMockAgentlasBridge,
  mockBridgeOptions,
} = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = process.env.AGENTLAS_STEERING_QA_OUT
  ? path.resolve(process.env.AGENTLAS_STEERING_QA_OUT)
  : path.join(root, "output", "playwright", "chat-steering-ui");
const rawVideoDir = path.join(outDir, ".recordings");
const videoPath = path.join(outDir, "chat-steering-ui.webm");
const reportPath = path.join(outDir, "report.json");
const viewport = {
  width: Number(process.env.AGENTLAS_STEERING_QA_WIDTH || 1280),
  height: Number(process.env.AGENTLAS_STEERING_QA_HEIGHT || 840),
};

const initialPrompt = "현재 채팅 UI를 점검하고 핵심 개선안을 정리해줘.";
const steeringPrompt = "기능 구현보다 먼저 UI 깨짐과 회귀 테스트를 확인해줘.";
const initialDraft =
  "현재 화면 구조와 실행 상태를 먼저 확인했습니다. 긴 식별자도 레이아웃을 밀지 않는지 함께 점검합니다: " +
  "agentlas-chat-steering-layout-regression-proof-".repeat(4);
const finalText =
  "방향을 전환했습니다. UI 오버플로, 실행 중 스티어링 전환, 콘솔 오류를 먼저 검증했고 레이아웃 깨짐 없이 완료했습니다.";

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function resolveAsset(rawUrl) {
  let pathname = decodeURIComponent((rawUrl || "/").split("?")[0]);
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  if (pathname === "/") pathname = "/index.html";
  const direct = path.join(distDir, pathname.replace(/^\//, ""));
  if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  if (!path.extname(pathname)) {
    const html = path.join(distDir, `${pathname.replace(/^\//, "")}.html`);
    if (fs.existsSync(html)) return html;
  }
  return null;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const pathname = decodeURIComponent((req.url || "/").split("?")[0]);
      if (pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      const file = resolveAsset(req.url);
      if (!file) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": mime[path.extname(file)] || "application/octet-stream",
        "cache-control": "no-store",
      });
      fs.createReadStream(file).pipe(res);
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function emit(page, channel, payload) {
  await page.evaluate(
    ([eventChannel, eventPayload]) => window.__steeringQA.emit(eventChannel, eventPayload),
    [channel, payload],
  );
}

async function invokeCalls(page, name = "invoke.run") {
  return page.evaluate(
    (callName) => window.__qa.calls.filter((call) => call.name === callName),
    name,
  );
}

async function assertLayout(page, stage, requireLiveStatus = true) {
  const result = await page.evaluate(() => {
    const doc = document.documentElement;
    const stream = document.querySelector(".agentlas-chat-stream");
    const streamScroll = document.querySelector(".agentlas-chat-stream-scroll");
    const composer = document.querySelector('[data-tour-id="workspace.input"]');
    const turns = [...document.querySelectorAll(".agentlas-chat-turn")];
    const liveStatus = turns.at(-1)?.querySelector('[role="status"]') ?? null;
    const rect = (node) => {
      if (!(node instanceof HTMLElement)) return null;
      const value = node.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height,
      };
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      documentOverflowX: Math.max(0, doc.scrollWidth - window.innerWidth),
      bodyOverflowX: Math.max(0, document.body.scrollWidth - window.innerWidth),
      streamOverflowX: streamScroll ? getComputedStyle(streamScroll).overflowX : null,
      stream: rect(stream),
      composer: rect(composer),
      liveStatus: rect(liveStatus),
    };
  });

  assert.ok(result.stream, `${stage}: chat stream must be measurable`);
  assert.ok(result.composer, `${stage}: composer must be measurable`);
  if (requireLiveStatus) assert.ok(result.liveStatus, `${stage}: live thinking/status stream must be measurable`);
  assert.ok(result.documentOverflowX <= 1, `${stage}: document overflowed horizontally by ${result.documentOverflowX}px`);
  assert.ok(result.bodyOverflowX <= 1, `${stage}: body overflowed horizontally by ${result.bodyOverflowX}px`);
  assert.equal(result.streamOverflowX, "hidden", `${stage}: chat stream must contain horizontal overflow`);
  assert.ok(result.stream.left >= -1 && result.stream.right <= result.viewport.width + 1, `${stage}: chat stream left viewport`);
  assert.ok(result.composer.left >= -1 && result.composer.right <= result.viewport.width + 1, `${stage}: composer left viewport`);
  if (result.liveStatus) {
    assert.ok(
      result.liveStatus.left >= result.stream.left - 1 && result.liveStatus.right <= result.stream.right + 1,
      `${stage}: thinking/status stream escaped the chat column`,
    );
  }
  return { stage, ...result };
}

async function readThinkingLegibility(page) {
  // Ordinary single-agent chat intentionally uses a flat inline output plus a
  // compact live status line; the larger WorkingPanel is reserved for actual
  // parallel/multi-agent runs.
  const thinking = page.locator(".agentlas-chat-turn").last().locator('[role="status"]').last();
  await thinking.waitFor({ state: "visible" });
  const result = await thinking.evaluate((node) => {
    const rootStyle = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const visibleTextNodes = [...node.querySelectorAll("span, button, div")]
      .filter((item) => {
        if (!(item instanceof HTMLElement)) return false;
        const style = getComputedStyle(item);
        const box = item.getBoundingClientRect();
        return Boolean(item.textContent?.trim()) && style.visibility !== "hidden" && Number(style.opacity || 1) > 0 && box.width > 0 && box.height > 0;
      })
      .map((item) => ({
        text: item.textContent.trim(),
        fontSize: Number.parseFloat(getComputedStyle(item).fontSize),
        lineHeight: getComputedStyle(item).lineHeight,
      }));
    return {
      text: node.innerText,
      color: rootStyle.color,
      opacity: Number(rootStyle.opacity || 1),
      visibility: rootStyle.visibility,
      width: rect.width,
      height: rect.height,
      readableRows: visibleTextNodes.filter((item) => item.fontSize >= 11).length,
      minimumVisibleFontSize: Math.min(...visibleTextNodes.map((item) => item.fontSize).filter(Number.isFinite)),
    };
  });

  assert.match(result.text, /실행 중|생각 중|작업 중/);
  assert.match(result.text, /128\s*tokens/);
  assert.ok(result.height >= 16, `thinking/status stream is clipped (${result.height}px)`);
  assert.ok(result.width >= 160, `thinking/status stream is too narrow (${result.width}px)`);
  assert.ok(result.opacity >= 0.72, `thinking stream opacity is too low (${result.opacity})`);
  assert.notEqual(result.visibility, "hidden");
  assert.ok(!/rgba\(0, 0, 0, 0\)|transparent/.test(result.color), `thinking stream has transparent text: ${result.color}`);
  assert.ok(result.readableRows >= 1, `thinking/status stream needs a legible text row (${result.readableRows})`);
  assert.ok(result.minimumVisibleFontSize >= 11, `thinking text is too small (${result.minimumVisibleFontSize}px)`);
  return result;
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "workspace", "task.html"))) {
    throw new Error("dist/renderer/workspace/task.html is missing; run `npm run build:renderer` first");
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(rawVideoDir, { recursive: true });

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  let context;
  let page;
  let savedVideo = false;
  try {
    context = await browser.newContext({
      viewport,
      recordVideo: { dir: rawVideoDir, size: viewport },
      colorScheme: "light",
    });
    const bridgeOptions = mockBridgeOptions({ slowInvoke: true });
    await context.addInitScript({
      content: `
        (${setupMockAgentlasBridge.toString()})(${JSON.stringify(bridgeOptions)});
        window.localStorage.setItem("agentlas.locale", "ko");
        window.localStorage.setItem("agentlas.onboarded", "1");

        (() => {
          const captured = Object.create(null);
          const activeChatHandlers = [];
          let currentRun = null;
          const originalOn = window.agentlasEvents.on.bind(window.agentlasEvents);
          const originalRun = window.agentlas.invoke.run.bind(window.agentlas.invoke);
          window.agentlasEvents.on = (channel, handler) => {
            (captured[channel] = captured[channel] || []).push(handler);
            const off = originalOn(channel, handler);
            return () => {
              captured[channel] = (captured[channel] || []).filter((item) => item !== handler);
              if (typeof off === "function") off();
            };
          };
          window.agentlasEvents.onActiveChats = (handler) => {
            activeChatHandlers.push(handler);
            return () => {
              const index = activeChatHandlers.indexOf(handler);
              if (index >= 0) activeChatHandlers.splice(index, 1);
            };
          };
          const publishActiveChats = (ids) => {
            for (const handler of [...activeChatHandlers]) handler(ids);
          };
          const publish = (channel, payload) => {
            if (currentRun && channel === 'invoke:' + currentRun.runId) currentRun.events.push(payload);
            for (const handler of [...(captured[channel] || [])]) handler(payload);
          };
          window.agentlas.invoke.run = async (payload) => {
            const result = await originalRun(payload);
            currentRun = {
              runId: result.runId,
              chatId: payload.chatId,
              startedAt: new Date().toISOString(),
              events: [],
            };
            return result;
          };
          window.agentlas.invoke.attach = async (chatId) => {
            if (!currentRun || currentRun.chatId !== chatId) return null;
            return { ...currentRun, events: [...currentRun.events] };
          };
          window.agentlas.invoke.activeChats = async () => currentRun ? [currentRun.chatId] : [];
          window.agentlas.invoke.steer = async (payload) => {
            window.__qa.calls.push({ name: 'invoke.steer', payload });
            const prior = currentRun;
            window.__steeringQA.steerRequests.push({ payload, requestedAt: Date.now() });
            window.setTimeout(() => {
              if (prior) publish('invoke:' + prior.runId, { kind: 'error', error: { code: 'cancelled', message: 'Cancelled' } });
              currentRun = null;
              publishActiveChats([]);
              window.setTimeout(() => {
                currentRun = {
                  runId: 'main-steer-run-2',
                  chatId: payload.chatId,
                  startedAt: new Date().toISOString(),
                  events: [],
                };
                publishActiveChats([payload.chatId]);
              }, 120);
            }, 850);
            return { accepted: true, queued: true, activeRunId: prior?.runId, position: 1 };
          };

          window.__steeringQA = {
            steerRequests: [],
            emit: publish,
          };
        })();
      `,
    });

    page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const requestFailures = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("requestfailed", (request) => {
      requestFailures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText || "failed"}`);
    });

    // Chat keeps lightweight polling alive, so networkidle is not a valid
    // readiness signal. The mounted, enabled composer below is authoritative.
    await page.goto(`${baseUrl}/workspace/task.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    const composer = page.locator('[data-chat-input="true"]');
    await composer.waitFor({ state: "visible" });
    await page.waitForFunction(() => {
      const input = document.querySelector('[data-chat-input="true"]');
      return input instanceof HTMLTextAreaElement && !input.disabled;
    });

    await composer.fill(initialPrompt);
    await page.locator(".chat-input-send-button").click();
    await page.waitForFunction(() => window.__qa.calls.filter((call) => call.name === "invoke.run").length === 1);
    const firstRun = (await invokeCalls(page))[0].payload;
    assert.equal(firstRun.userPrompt, initialPrompt);
    const firstChannel = `invoke:${firstRun.runId}`;

    await emit(page, firstChannel, { kind: "reasoning", reasoning: { phase: "start" } });
    await emit(page, firstChannel, {
      kind: "thinking",
      status: "요청을 분석하고 핵심 구조를 정리하는 중입니다.",
    });
    await emit(page, firstChannel, { kind: "usage", tokens: 128 });
    await emit(page, firstChannel, { kind: "partial", text: initialDraft });
    await page.locator(".agentlas-chat-turn").last().locator('[role="status"]').last().waitFor({ state: "visible" });
    const thinkingLegibility = await readThinkingLegibility(page);
    const layouts = [await assertLayout(page, "active-thinking")];
    await page.screenshot({ path: path.join(outDir, "01-active-thinking.png") });
    await sleep(700);

    // The same composer remains writable while busy. The instruction must be
    // visible immediately, then Main owns cancellation and the replacement run.
    await composer.fill(steeringPrompt);
    const steeringSend = page.locator('[data-chat-steering-send="true"]');
    await steeringSend.waitFor({ state: "visible" });
    assert.equal(await steeringSend.isEnabled(), true, "busy composer must allow a steering send");
    await steeringSend.click();
    await page.getByText(/새 방향 반영 중|Applying direction/).waitFor();
    await page.getByText(steeringPrompt, { exact: true }).waitFor();
    await page.waitForFunction(() => window.__steeringQA.steerRequests.length === 1);
    layouts.push(await assertLayout(page, "steering-queued"));
    await page.screenshot({ path: path.join(outDir, "02-steering-queued.png") });
    await sleep(950);

    await page.waitForFunction(() => window.__qa.calls.filter((call) => call.name === "invoke.steer").length === 1);
    await page.waitForFunction(() => !document.body.innerText.includes("새 방향 반영 중") && !document.body.innerText.includes("Applying direction"));
    const runs = await invokeCalls(page);
    assert.equal(runs.length, 1, "renderer must not start a duplicate run while Main owns steering");
    const steerCalls = await invokeCalls(page, "invoke.steer");
    assert.equal(steerCalls[0].payload.userPrompt, steeringPrompt, "steering instruction must use the Main-owned steer contract");
    const secondRun = { runId: "main-steer-run-2", userPrompt: steeringPrompt };
    assert.equal(await page.getByText(/새 방향 반영 중|Applying direction/).count(), 0, "steering badge must clear after attach");
    assert.equal(await page.getByText(/^⚠️.*Cancelled$/).count(), 0, "steering cancellation must not render an error bubble");

    const secondChannel = `invoke:${secondRun.runId}`;
    await emit(page, secondChannel, { kind: "reasoning", reasoning: { phase: "start" } });
    await emit(page, secondChannel, {
      kind: "thinking",
      status: "새 지시를 반영해 검증 순서를 바꾸는 중입니다.",
    });
    await emit(page, secondChannel, { kind: "usage", tokens: 192 });
    await emit(page, secondChannel, {
      kind: "partial",
      text: "UI 회귀 검증을 먼저 실행했습니다. 이제 결과를 정리합니다.",
    });
    await page.locator(".agentlas-chat-turn").last().locator('[role="status"]').last().waitFor({ state: "visible" });
    layouts.push(await assertLayout(page, "steering-restarted"));
    await page.screenshot({ path: path.join(outDir, "03-steering-restarted.png") });
    await sleep(700);

    await emit(page, secondChannel, { kind: "reasoning", reasoning: { phase: "end", durationMs: 700 } });
    await emit(page, secondChannel, { kind: "final", text: finalText, tokens: 236 });
    await page.getByText(finalText, { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-chat-steering-send="true"]').length === 0);
    layouts.push(await assertLayout(page, "final", false));
    await page.screenshot({ path: path.join(outDir, "04-final.png") });
    await sleep(850);

    const streamText = await page.locator(".agentlas-chat-stream").innerText();
    assert.match(streamText, new RegExp(initialPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(streamText, new RegExp(steeringPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(streamText, /현재 화면 구조와 실행 상태를 먼저 확인했습니다/);
    assert.match(streamText, /방향을 전환했습니다/);
    assert.doesNotMatch(streamText, /⚠️\s*Cancelled|실행이 취소되었습니다/);

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join("\n")}`);
    assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join("\n")}`);
    assert.deepEqual(requestFailures, [], `request failures: ${requestFailures.join("\n")}`);

    const steerRequests = await page.evaluate(() => window.__steeringQA.steerRequests);
    const invokeCancels = await invokeCalls(page, "invoke.cancel");
    const video = page.video();
    assert.ok(video, "Playwright video recorder must be active");
    await page.close();
    page = null;
    await video.saveAs(videoPath);
    savedVideo = true;
    await context.close();
    context = null;
    fs.rmSync(rawVideoDir, { recursive: true, force: true });

    const report = {
      schema: "agentlas.chat-steering-ui-qa.v1",
      createdAt: new Date().toISOString(),
      videoPath,
      screenshots: [
        path.join(outDir, "01-active-thinking.png"),
        path.join(outDir, "02-steering-queued.png"),
        path.join(outDir, "03-steering-restarted.png"),
        path.join(outDir, "04-final.png"),
      ],
      assertions: {
        activeThinkingStream: true,
        busyComposerAcceptedSteering: true,
        steeringVisibleBeforeTransition: true,
        mainOwnedSteerContract: true,
        replacementRunAttachedWithoutNavigation: true,
        cancellationErrorHidden: true,
        initialPartialPreserved: true,
        finalResponseRendered: true,
        viewportOverflowFree: true,
        consoleErrors: 0,
        pageErrors: 0,
        requestFailures: 0,
      },
      thinkingLegibility,
      layouts,
      rendererRuns: runs.map((call) => ({
        runId: call.payload.runId,
        userPrompt: call.payload.userPrompt,
      })),
      steerRequests,
      invokeCancels: invokeCancels.map((call) => call.payload),
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify(report, null, 2));
    console.log(`Chat steering UI QA passed. Video: ${videoPath}`);
  } finally {
    if (page) await page.close().catch(() => undefined);
    if (context) await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
    await closeServer(server).catch(() => undefined);
    if (!savedVideo && fs.existsSync(rawVideoDir)) {
      // Keep the raw failure recording for diagnosis if the scenario failed.
      console.error(`Steering QA failed; raw recording kept at ${rawVideoDir}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
