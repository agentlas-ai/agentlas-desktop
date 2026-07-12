#!/usr/bin/env node
// 영상 재현 UX 시각 QA — 빌드된 렌더러를 mock 브리지로 띄우고, Claude Code 데스크탑
// 녹화 영상의 실행 시나리오(생각→스트리밍→도구→질문→완료)를 이벤트로 재생하며
// 단계별 스크린샷 + 핵심 문구 존재를 검증한다.
//
// 사용: npm run build:renderer 선행 후  node scripts/qa-video-ux-visual.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = process.env.QA_VIDEO_UX_OUT || path.join(root, "output", "playwright", "video-ux-visual");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
      let filePath = path.join(distDir, urlPath === "/" ? "index.html" : urlPath.replace(/^\//, ""));
      if (!fs.existsSync(filePath) && !path.extname(filePath)) filePath = `${filePath}.html`;
      if (!fs.existsSync(filePath)) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream" });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  if (!fs.existsSync(path.join(distDir, "chat.html"))) {
    console.error("dist/renderer missing — run `npm run build:renderer` first");
    process.exit(2);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const problems = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1240, height: 940 } });
    // slowInvoke: mock이 자동 이벤트를 쏘지 않는다 — 아래에서 영상 시나리오를 수동 재생.
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ slowInvoke: true }));
    // 이벤트 핸들러 캡처 — 시나리오 드라이버가 채널로 직접 emit할 수 있게.
    await context.addInitScript(() => {
      const captured = {};
      const origOn = window.agentlasEvents.on;
      window.agentlasEvents.on = (channel, handler) => {
        (captured[channel] = captured[channel] || []).push(handler);
        const off = origOn(channel, handler);
        return () => {
          captured[channel] = (captured[channel] || []).filter((h) => h !== handler);
          if (typeof off === "function") off();
        };
      };
      window.__videoQA = {
        emit: (channel, payload) => {
          for (const h of captured[channel] || []) h(payload);
        },
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) {
        errors.push(msg.text());
      }
    });

    await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    const box = page.getByRole("textbox").first();
    await box.waitFor();

    // ── 실행 시작 ──
    await box.fill("이 기획안 구체화해봐");
    await box.press("Enter");
    await page.waitForFunction(() => window.__qa.calls.some((c) => c.name === "invoke.run"));
    const runId = await page.evaluate(
      () => window.__qa.calls.filter((c) => c.name === "invoke.run").pop().payload.runId,
    );
    const ch = `invoke:${runId}`;
    let sent = "";
    const emit = (payload) => page.evaluate(([c, p]) => window.__videoQA.emit(c, p), [ch, payload]);
    const delta = async (chunk) => {
      sent += chunk;
      await emit({ kind: "partial", delta: chunk, textLen: sent.length });
    };
    const shot = async (name) => {
      await page.screenshot({ path: path.join(outDir, name) });
    };
    const expectText = async (label, re) => {
      const body = await page.locator(".agentlas-chat-stream").innerText().catch(() => "");
      if (!re.test(body)) problems.push(`${label}: /${re.source}/ 미검출`);
    };

    // 1) thinking 구간 — ✳ + "생각 중..."
    await emit({ kind: "reasoning", reasoning: { phase: "start" } });
    await sleep(1300);
    await shot("01-thinking.png");
    await expectText("01 생각 중 문구", /생각 중\.\.\./);
    await emit({ kind: "reasoning", reasoning: { phase: "end", durationMs: 1400 } });

    // 2) 본문 글자 스트리밍 + 라이브 토큰
    const p1 = "기획안 파일을 먼저 확인해볼게요. 작업 디렉토리를 살펴보겠습니다.\n";
    for (let i = 0; i < p1.length; i += 5) {
      await delta(p1.slice(i, i + 5));
      if (i === 15) await emit({ kind: "usage", tokens: 34 });
      await sleep(45);
    }
    await shot("02-streaming.png");
    await expectText("02 라이브 토큰", /34 tokens/);

    // 3) 도구 실행 — 라이브 라벨 "실행 중 ›" → "읽는 중 ›"
    await emit({ kind: "tool-use", tool: { name: "Bash", args: JSON.stringify({ command: "ls -la 관광공모" }), id: "t1" } });
    await sleep(700);
    await shot("03-tool-live.png");
    await expectText("03 실행 중 라벨", /실행 중/);
    await emit({ kind: "tool-use", tool: { name: "Bash", result: "PRD_festival-risk-report.md", id: "t1" } });
    await emit({ kind: "tool-use", tool: { name: "Read", args: JSON.stringify({ file_path: "/tmp/PRD_festival-risk-report.md" }), id: "t2" } });
    await emit({ kind: "usage", tokens: 54 });
    await sleep(700);
    await shot("04-read-live.png");
    await expectText("04 읽는 중 라벨", /읽는 중/);
    await emit({ kind: "tool-use", tool: { name: "Read", result: "# PRD — 축제 예산 사전 리스크 리포트", id: "t2" } });

    // 4) 두 번째 thinking — 에스컬레이션 문구 + 종료 후 "N초 동안 생각함"
    await emit({ kind: "reasoning", reasoning: { phase: "start" } });
    await sleep(3400);
    await shot("05-still-thinking.png");
    await expectText("05 아직 생각 중", /(아직|더) 생각 중\.\.\./);
    await emit({ kind: "reasoning", reasoning: { phase: "end", durationMs: 3400 } });
    await sleep(250);
    await shot("06-thought-for.png");
    await expectText("06 동안 생각함", /초 동안 생각함/);

    // 5) 두 번째 단락 스트리밍(도구 그룹 아래로 인터리브) + 질문 fence
    const p2 = "좋은 기획안입니다. 이미 논리 구조가 탄탄해서, **구체화**의 방향에 따라 결과물이 크게 갈립니다.\n";
    for (let i = 0; i < p2.length; i += 6) {
      await delta(p2.slice(i, i + 6));
      await sleep(40);
    }
    await emit({ kind: "usage", tokens: 175 });
    const ask = {
      question: "이 기획안을 어느 방향으로 구체화할까요? (가장 필요한 하나를 고르면 그것부터 끝까지 파고듭니다)",
      header: "방향",
      multiSelect: false,
      options: [
        { label: "방법론·산출로직 명세", description: "CAV baseline 회귀식, 대조군 선정 규칙을 코드로 옮길 수준으로 확정." },
        { label: "Phase 0 실측 코드", description: "TourAPI 호출부터 실제 파이썬 파이프라인 작성." },
        { label: "예선 제출 기획서", description: "심사위원이 읽을 제출용 문서로 재작성." },
        { label: "리포트 화면 설계", description: "1페이지 리포트의 실제 UI와 컴포넌트 구조." },
      ],
    };
    await delta(`\n<<agentlas-ask>>\n${JSON.stringify(ask)}\n<</agentlas-ask>>\n`);
    await sleep(600);
    await shot("07-question-sheet.png");
    {
      const sheetText = await page.locator(".chat-qsheet").innerText().catch(() => "");
      if (!/제출/.test(sheetText)) problems.push("07 질문 시트: 제출 버튼 미검출");
      if (!/기타/.test(sheetText)) problems.push("07 질문 시트: 기타 행 미검출");
    }

    // 6) 실행 완료(final) — 접힘 요약 + 완료 상태줄
    await emit({ kind: "final", text: sent, tokens: 309 });
    await sleep(400);

    // 7) 질문 답변 — 기타에 "전부다" 입력 → 제출 → 인용 카드
    await page.getByPlaceholder(/여기에 답변을 입력하세요|Type your answer here/).fill("전부다");
    await page.locator(".chat-qsheet-next").click();
    await page.waitForFunction(() => window.__qa.calls.filter((c) => c.name === "invoke.run").length >= 2);
    const runId2 = await page.evaluate(
      () => window.__qa.calls.filter((c) => c.name === "invoke.run").pop().payload.runId,
    );
    const ch2 = `invoke:${runId2}`;
    await page.evaluate(([c, p]) => window.__videoQA.emit(c, p), [ch2, { kind: "reasoning", reasoning: { phase: "start" } }]);
    await page.evaluate(([c, p]) => window.__videoQA.emit(c, p), [ch2, { kind: "usage", tokens: 322 }]);
    await sleep(900);
    await shot("08-answered-quote.png");
    await expectText("08 인용 카드(질문)", /어느 방향으로 구체화할까요/);
    await expectText("08 인용 카드(답)", /전부다/);
    {
      // 영상 충실도 — 스캐폴드 원문("질문: …")은 사용자 버블로 다시 보이지 않아야 한다.
      const body = await page.locator(".agentlas-chat-stream").innerText().catch(() => "");
      if (/질문: 이 기획안을/.test(body)) problems.push("08 스캐폴드 사용자 버블이 노출됨(인용 카드와 중복)");
    }
    await page.evaluate(([c, p]) => window.__videoQA.emit(c, p), [ch2, { kind: "reasoning", reasoning: { phase: "end", durationMs: 900 } }]);
    await page.evaluate(([c, p]) => window.__videoQA.emit(c, p), [ch2, { kind: "final", text: "알겠습니다 — 전부 진행합니다.", tokens: 340 }]);
    await sleep(400);

    // 8) 완료 화면 — 접힘 요약 "실행됨 명령 1개, 읽기 파일 1개 ›" + 완료 상태줄 + 펼침
    await shot("09-done.png");
    await expectText("09 접힘 요약", /실행됨 명령 1개, 읽기 파일 1개/);
    await expectText("09 완료 상태줄 토큰", /309 tokens/);
    const summaryBtn = page.getByRole("button", { name: /실행됨 명령 1개, 읽기 파일 1개/ }).first();
    await summaryBtn.click();
    await sleep(250);
    await shot("10-expanded-rows.png");
    await expectText("10 펼침 행(읽기 파일명)", /PRD_festival-risk-report\.md/);

    // 9) 호버 액션(복사/읽어주기)
    await page.locator(".agentlas-chat-turn").last().hover();
    await sleep(200);
    await shot("11-hover-actions.png");
    const copyCount = await page.locator(".agentlas-chat-copy-button").count();
    if (copyCount < 2) problems.push(`11 호버 액션: 복사/읽어주기 버튼 부족 (${copyCount})`);

    const fatalErrors = errors.filter(Boolean);
    if (fatalErrors.length > 0) problems.push(`pageerror/console: ${JSON.stringify(fatalErrors)}`);

    console.log(JSON.stringify({ outDir, problems }, null, 2));
    assert.equal(problems.length, 0, "video UX visual checks must pass");
    console.log("video UX visual QA passed");
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
