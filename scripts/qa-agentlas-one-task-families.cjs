#!/usr/bin/env node

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright");
const {
  mockBridgeOptions,
  preloadMethodPaths,
  setupMockAgentlasBridge,
} = require("./lib/mock-agentlas-bridge.cjs");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "agentlas-one-task-families");
const now = "2026-07-20T05:00:00.000Z";

function blockIds(blocks) {
  return blocks.map((block) => block.blockId);
}

function surface({ family, title, summary, layoutProfile, blocks, artifacts = [], evidence = [] }) {
  const order = blockIds(blocks);
  return {
    contractVersion: "1.0.0",
    manifestId: `manifest_${family}_001`,
    taskId: `task_${family}_001`,
    title,
    summary,
    layoutProfile,
    surfaceState: { value: "ready", summary: "Ready", readOnly: true, lastSyncedAt: now },
    blocks,
    primaryAction: {
      actionId: `action_${family}_details`,
      intent: "open_work",
      label: artifacts.length > 0 ? "파일 확인" : "자세히 보기",
      targetRef: `task_${family}_001`,
      enabled: true,
    },
    secondaryActions: [],
    evidence: evidence.length > 0 ? evidence : [{
      evidenceRef: `evidence_${family}_result`,
      kind: "outcome",
      verificationStatus: "verified",
      label: "확인된 결과",
    }],
    fallback: {
      markdown: "완성된 결과는 연결된 컴퓨터에서 확인할 수 있어요.",
      artifacts,
    },
    recomposition: {
      desktop: {
        blockOrder: order,
        tableStrategy: "full_table",
        comparisonStrategy: "matrix",
        timelineStrategy: "adaptive",
      },
      mobile: {
        blockOrder: order,
        tableStrategy: "featured_cards_then_sheet",
        comparisonStrategy: "recommended_then_alternatives",
        timelineStrategy: "vertical",
      },
    },
  };
}

const families = {
  travel: surface({
    family: "travel",
    title: "제주 2박 3일 가족 여행",
    summary: "아이의 낮잠 시간과 120만원 예산을 지키면서 이동이 무리 없도록 짰어요.",
    layoutProfile: "itinerary",
    blocks: [
      {
        blockId: "block_travel_summary",
        type: "Narrative",
        title: "여행 한눈에 보기",
        paragraphs: ["첫날은 숙소 근처, 둘째 날은 동쪽, 마지막 날은 공항 방향으로 묶어 되돌아가는 시간을 줄였어요."],
      },
      {
        blockId: "block_travel_timeline",
        type: "Timeline",
        title: "날짜별 일정",
        items: [
          { itemId: "travel_day1_arrive", at: "2026-07-24T10:30:00+09:00", title: "제주공항 도착", detail: "렌터카를 받고 함덕으로 이동", status: "upcoming" },
          { itemId: "travel_day1_beach", at: "2026-07-24T12:00:00+09:00", title: "함덕 해변", detail: "점심과 짧은 산책", status: "upcoming" },
          { itemId: "travel_day2_aqua", at: "2026-07-25T10:00:00+09:00", title: "아쿠아플라넷", detail: "아이 체험 중심", status: "upcoming" },
          { itemId: "travel_day2_sunrise", at: "2026-07-25T16:00:00+09:00", title: "성산일출봉", detail: "가벼운 둘레길", status: "upcoming" },
          { itemId: "travel_day3_depart", at: "2026-07-26T13:00:00+09:00", title: "제주공항 출발", detail: "출발 2시간 전 도착", status: "upcoming" },
        ],
      },
      {
        blockId: "block_travel_map",
        type: "Map",
        title: "이동 순서",
        locations: [
          { locationRef: "travel_location_airport", label: "제주공항", latitude: 33.5104, longitude: 126.4914, sequence: 1 },
          { locationRef: "travel_location_hamdeok", label: "함덕 해변", latitude: 33.5434, longitude: 126.6698, sequence: 2 },
          { locationRef: "travel_location_aqua", label: "아쿠아플라넷", latitude: 33.4328, longitude: 126.9277, sequence: 3 },
          { locationRef: "travel_location_sunrise", label: "성산일출봉", latitude: 33.4581, longitude: 126.9425, sequence: 4 },
        ],
      },
      {
        blockId: "block_travel_budget",
        type: "Budget",
        title: "예상 비용",
        currency: "KRW",
        total: 1086000,
        limit: 1200000,
        lines: [
          { lineRef: "travel_budget_flight", label: "항공권", amount: 420000, verificationStatus: "estimated" },
          { lineRef: "travel_budget_stay", label: "숙소", amount: 300000, verificationStatus: "estimated" },
          { lineRef: "travel_budget_car", label: "렌터카", amount: 180000, verificationStatus: "estimated" },
          { lineRef: "travel_budget_food", label: "식비와 입장료", amount: 186000, verificationStatus: "estimated" },
        ],
      },
      {
        blockId: "block_travel_checks",
        type: "Checklist",
        title: "가기 전에 확인",
        items: [
          { itemRef: "travel_check_flight", label: "항공편 가격 다시 확인", status: "not_started" },
          { itemRef: "travel_check_stay", label: "숙소의 아기 침대 요청", status: "not_started" },
          { itemRef: "travel_check_weather", label: "출발 전날 날씨 확인", status: "not_started" },
        ],
      },
    ],
  }),
  study: surface({
    family: "study",
    title: "이차방정식 문제 풀이",
    summary: "정답만 주지 않고, 막힌 지점부터 다시 풀 수 있게 세 단계로 설명했어요.",
    layoutProfile: "report",
    blocks: [
      {
        blockId: "block_study_explanation",
        type: "Narrative",
        title: "왜 이렇게 푸는지",
        paragraphs: ["식을 0으로 만든 뒤 곱해서 0이 되는 두 수를 찾으면 해를 구할 수 있어요.", "x²-5x+6은 (x-2)(x-3)으로 나뉘므로 답은 x=2, x=3입니다."],
      },
      {
        blockId: "block_study_steps",
        type: "Table",
        title: "풀이 순서",
        columns: [
          { columnId: "study_step", label: "단계" },
          { columnId: "study_what", label: "무엇을 하나요" },
          { columnId: "study_reason", label: "왜 필요한가요" },
        ],
        featuredColumnIds: ["study_step", "study_what", "study_reason"],
        rows: [
          { rowId: "study_row_1", cells: [{ columnId: "study_step", value: "1. 식 정리" }, { columnId: "study_what", value: "모든 항을 왼쪽으로 모아요" }, { columnId: "study_reason", value: "곱이 0인 꼴로 만들기 위해서예요" }] },
          { rowId: "study_row_2", cells: [{ columnId: "study_step", value: "2. 인수분해" }, { columnId: "study_what", value: "곱해서 6, 더해서 -5인 수를 찾아요" }, { columnId: "study_reason", value: "두 괄호로 나누기 위해서예요" }] },
          { rowId: "study_row_3", cells: [{ columnId: "study_step", value: "3. 해 구하기" }, { columnId: "study_what", value: "각 괄호를 0으로 놓아요" }, { columnId: "study_reason", value: "곱이 0이면 둘 중 하나는 0이기 때문이에요" }] },
        ],
      },
      {
        blockId: "block_study_practice",
        type: "Checklist",
        title: "10분 복습",
        items: [
          { itemRef: "study_check_explain", label: "풀이를 내 말로 한 번 설명하기", status: "not_started" },
          { itemRef: "study_check_similar", label: "비슷한 문제 두 개 풀기", status: "not_started" },
          { itemRef: "study_check_wrong", label: "틀린 이유 한 줄 적기", status: "not_started" },
        ],
      },
    ],
  }),
  document: surface({
    family: "document",
    title: "고객 인터뷰 요약 문서",
    summary: "인터뷰 6건에서 반복된 요구를 한 페이지 문서로 정리했어요.",
    layoutProfile: "report",
    artifacts: [{ artifactRef: "artifact_interview_docx", type: "document", label: "고객-인터뷰-요약.docx", verificationStatus: "verified", sizeBytes: 48230 }],
    blocks: [
      {
        blockId: "block_document_summary",
        type: "Narrative",
        title: "핵심 내용",
        paragraphs: ["사용자는 기능 수보다 첫 설정이 쉬운지를 더 중요하게 봤어요. 가격 설명은 월 비용과 절약 시간을 함께 보여줄 때 이해가 빨랐습니다."],
      },
      {
        blockId: "block_document_preview",
        type: "Document",
        title: "만든 문서",
        artifactRef: "artifact_interview_docx",
        excerpt: "고객은 첫 사용 10분 안에 무엇을 할 수 있는지 알고 싶어 했고, 설정 단계가 세 번을 넘으면 포기하는 경우가 많았습니다.",
        pageCount: 1,
      },
      {
        blockId: "block_document_files",
        type: "ArtifactList",
        title: "결과 파일",
        items: [{ artifactRef: "artifact_interview_docx", type: "document", label: "고객-인터뷰-요약.docx", verificationStatus: "verified", sizeBytes: 48230 }],
      },
      {
        blockId: "block_document_checks",
        type: "Checklist",
        title: "확인한 것",
        items: [
          { itemRef: "document_check_names", label: "개인 이름 삭제", status: "completed" },
          { itemRef: "document_check_quotes", label: "인용 문장과 원문 대조", status: "completed" },
          { itemRef: "document_check_spelling", label: "맞춤법 확인", status: "completed" },
        ],
      },
    ],
  }),
  spreadsheet: surface({
    family: "spreadsheet",
    title: "7월 지출 정리",
    summary: "영수증 42건을 항목별로 묶고, 지난달보다 많이 늘어난 곳을 표시했어요.",
    layoutProfile: "report",
    artifacts: [{ artifactRef: "artifact_july_expenses", type: "spreadsheet", label: "7월-지출-정리.xlsx", verificationStatus: "verified", sizeBytes: 92840 }],
    blocks: [
      {
        blockId: "block_sheet_summary",
        type: "Narrative",
        title: "이번 달 변화",
        paragraphs: ["전체 지출은 지난달보다 8% 늘었어요. 가장 많이 늘어난 항목은 교통비이고, 식비는 예산 안에 들어왔습니다."],
      },
      {
        blockId: "block_sheet_metrics",
        type: "Metric",
        title: "숫자로 보기",
        items: [
          { metricId: "sheet_metric_total", label: "전체 지출", value: "1,284,000", unit: "원", verificationStatus: "verified" },
          { metricId: "sheet_metric_receipts", label: "정리한 영수증", value: 42, unit: "건", verificationStatus: "verified" },
          { metricId: "sheet_metric_change", label: "지난달 대비", value: 8, unit: "% 증가", verificationStatus: "verified" },
        ],
      },
      {
        blockId: "block_sheet_table",
        type: "Table",
        title: "항목별 지출",
        columns: [
          { columnId: "sheet_category", label: "항목" },
          { columnId: "sheet_amount", label: "금액" },
          { columnId: "sheet_change", label: "지난달 대비" },
          { columnId: "sheet_note", label: "메모" },
        ],
        featuredColumnIds: ["sheet_category", "sheet_amount", "sheet_change"],
        rows: [
          { rowId: "sheet_row_food", cells: [{ columnId: "sheet_category", value: "식비" }, { columnId: "sheet_amount", value: "486,000원" }, { columnId: "sheet_change", value: "-3%" }, { columnId: "sheet_note", value: "예산 안" }] },
          { rowId: "sheet_row_transport", cells: [{ columnId: "sheet_category", value: "교통" }, { columnId: "sheet_amount", value: "238,000원" }, { columnId: "sheet_change", value: "+31%" }, { columnId: "sheet_note", value: "택시비 증가" }] },
          { rowId: "sheet_row_living", cells: [{ columnId: "sheet_category", value: "생활" }, { columnId: "sheet_amount", value: "312,000원" }, { columnId: "sheet_change", value: "+5%" }, { columnId: "sheet_note", value: "정기 결제 포함" }] },
          { rowId: "sheet_row_other", cells: [{ columnId: "sheet_category", value: "기타" }, { columnId: "sheet_amount", value: "248,000원" }, { columnId: "sheet_change", value: "+2%" }, { columnId: "sheet_note", value: "큰 변화 없음" }] },
        ],
      },
      {
        blockId: "block_sheet_files",
        type: "ArtifactList",
        title: "결과 파일",
        items: [{ artifactRef: "artifact_july_expenses", type: "spreadsheet", label: "7월-지출-정리.xlsx", verificationStatus: "verified", sizeBytes: 92840 }],
      },
    ],
  }),
};

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
      const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
      res.writeHead(file.endsWith("404.html") ? 404 : 200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}

function installFamilyFixture(input) {
  window.localStorage.setItem("agentlas.locale", "ko");
  const api = window.agentlas;
  const taskId = input.surface.taskId;
  const chatId = `chat_${input.family}_001`;
  const runId = `run_${input.family}_001`;
  const task = {
    id: taskId,
    version: 2,
    title: input.surface.title,
    projectId: null,
    firmId: null,
    status: "completed",
    originChatId: chatId,
    createdAt: "2026-07-20T04:30:00.000Z",
    updatedAt: input.now,
    archivedAt: null,
    participants: [],
  };
  const chat = {
    id: chatId,
    taskId,
    projectId: null,
    firmId: null,
    agentId: "agent-one",
    kind: "user",
    title: input.surface.title,
    archivedAt: null,
    createdAt: "2026-07-20T04:30:00.000Z",
    updatedAt: input.now,
    hiredAgents: [],
  };
  const projection = {
    contractVersion: "1.0.0",
    taskId,
    canonicalVersion: 2,
    oneId: `one_${"1".repeat(32)}`,
    projectionSurface: "one",
    projectionMode: "summary",
    display: { title: input.surface.title, summary: input.surface.summary },
    status: { value: "completed", source: "authoritative_event", asOf: input.now },
    sync: { connection: "online", lastSyncedAt: input.now, authoritativeHostRef: "desktop:local", executionAuthorityAvailable: true, mutationMode: "direct", queuedOperationCount: 0 },
    truth: { mayStartExecution: false, mayClaimNewCompletion: true },
    references: {
      teamRunId: runId,
      manifestId: input.surface.manifestId,
      decisionIds: [],
      artifactIds: input.surface.fallback.artifacts.map((item) => item.artifactRef),
      receiptIds: [runId],
    },
    availableActions: [],
    pendingOperations: [],
  };
  const receipt = {
    runId,
    chatId,
    status: "completed",
    startedAt: "2026-07-20T04:31:00.000Z",
    updatedAt: input.now,
    finishedAt: input.now,
    eventCount: 12,
    resultFolder: `/tmp/one-${input.family}`,
    errorMessage: null,
  };
  api.oneProfile.get = async () => ({
    contractVersion: "1.0.0",
    oneId: projection.oneId,
    version: 1,
    displayName: "One",
    role: "Assistant",
    profileContext: "",
    preferredLocale: "ko",
    timeZone: "Asia/Seoul",
    operatingPrinciples: [],
    createdAt: input.now,
    updatedAt: input.now,
  });
  api.oneSuggestions.getState = async () => ({ contractVersion: "1.0.0", version: 1, suggestions: [], reviewRequests: [], suppressions: [], patternFeedback: [], taskArbitrations: [], createdAt: input.now, updatedAt: input.now });
  api.oneMemory.getState = async () => ({ contractVersion: "1.0.0", version: 1, candidates: [], memories: [], suppressions: [], createdAt: input.now, updatedAt: input.now });
  api.oneFeatureIntro.getState = async () => null;
  api.oneActivation.getState = async () => null;
  api.oneBriefing.get = async () => null;
  api.oneTeamPreflight.getForChat = async () => null;
  api.oneAttachments.forTeam = async () => null;
  api.tasks.listProjections = async () => [projection];
  api.tasks.getProjection = async (id) => id === taskId ? projection : null;
  api.tasks.list = async () => [task];
  api.tasks.get = async (id) => id === taskId ? task : null;
  api.tasks.findForChat = async (id) => id === chatId ? task : null;
  api.chats.listRecent = async () => [chat];
  api.chats.get = async () => chat;
  api.invoke.activeChats = async () => [];
  api.invoke.latestReceipt = async () => receipt;
  api.invoke.latestOneSurface = async () => ({ manifest: input.surface });
  api.invoke.attach = async () => null;
  api.invoke.history = async () => [
    { id: `message_${input.family}_user`, role: "user", text: input.request, createdAt: "2026-07-20T04:30:00.000Z" },
    { id: `message_${input.family}_assistant`, role: "assistant", text: input.surface.summary, createdAt: input.now },
  ];
}

async function capture(browser, baseUrl, family, surfaceValue, viewport) {
  const taskId = surfaceValue.taskId;
  const context = await browser.newContext({ viewport });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ preloadMethodPaths: preloadMethodPaths(path.join(root, "electron", "preload.ts")) }));
  await context.addInitScript(installFamilyFixture, {
    family,
    surface: surfaceValue,
    now,
    request: {
      travel: "아이와 제주 2박 3일 일정 짜줘. 예산은 120만원이야.",
      study: "이 이차방정식 문제를 중학생도 이해하게 설명해줘.",
      document: "고객 인터뷰를 한 페이지 Word 문서로 정리해줘.",
      spreadsheet: "영수증을 정리해서 Excel 파일과 요약을 만들어줘.",
    }[family],
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/one.html?task=${taskId}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector(`[data-surface-contract="1.0.0"]`, { timeout: 10_000 });
  await page.waitForTimeout(500);
  const expectedKinds = surfaceValue.blocks.map((block) => block.type);
  const metrics = await page.evaluate(() => ({
    text: document.body.innerText,
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    kinds: [...document.querySelectorAll("[data-block-kind]")].map((element) => element.getAttribute("data-block-kind")),
  }));
  assert.deepEqual(pageErrors, [], `${family}: page errors`);
  assert.ok(metrics.width <= metrics.clientWidth + 2, `${family}: horizontal overflow at ${viewport.width}px`);
  assert.deepEqual(metrics.kinds, expectedKinds, `${family}: semantic blocks changed or disappeared`);
  assert.doesNotMatch(metrics.text, /\b(?:Surface|Manifest|Receipt|artifactRef|Decision ID|ImprovementProof|upcoming|in_progress)\b|semantic result|structured result/i, `${family}: developer language leaked`);
  if (viewport.width <= 700 && family === "spreadsheet") {
    assert.match(metrics.text, /전체 비교 보기/, `${family}: mobile table must be collapsed behind a simple control`);
  }
  if (viewport.width <= 700 && family === "study") {
    assert.doesNotMatch(metrics.text, /전체 비교 보기/, "study: step-by-step help should not look like a comparison table");
    assert.match(metrics.text, /1\. 식 정리/);
    assert.match(metrics.text, /3\. 해 구하기/);
  }
  const suffix = viewport.width <= 700 ? "mobile" : "desktop";
  const screenshot = path.join(outDir, `${family}-${suffix}.png`);
  await page.screenshot({ path: screenshot, fullPage: true });
  await page.evaluate(() => {
    const scroller = [...document.querySelectorAll("main, main *")].find((element) => {
      const style = getComputedStyle(element);
      return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20;
    });
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      window.__qaTaskFamilyScroller = {
        tag: scroller.tagName,
        className: scroller.className,
        scrollTop: scroller.scrollTop,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
      };
    }
  });
  await page.waitForTimeout(180);
  const actionLabel = surfaceValue.fallback.artifacts.length > 0 ? "파일 확인" : "자세히 보기";
  const primaryAction = page.getByRole("button", { name: actionLabel, exact: true });
  await primaryAction.evaluate((button) => button.scrollIntoView({ block: "center", behavior: "instant" }));
  await page.waitForTimeout(80);
  const actionBox = await primaryAction.boundingBox();
  assert.ok(
    actionBox && actionBox.y >= 0 && actionBox.y < viewport.height,
    `${family}: primary action must remain reachable at ${viewport.width}px`,
  );
  const actionHit = await primaryAction.evaluate((button) => {
    const box = button.getBoundingClientRect();
    const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    return {
      clickable: top === button || button.contains(top),
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      top: top ? { tag: top.tagName, className: top.className, text: top.textContent?.trim().slice(0, 80) } : null,
      scroller: window.__qaTaskFamilyScroller ?? null,
    };
  });
  assert.equal(actionHit.clickable, true, `${family}: primary action must not sit behind the composer at ${viewport.width}px: ${JSON.stringify(actionHit)}`);
  const lowerScreenshot = path.join(outDir, `${family}-${suffix}-lower.png`);
  await page.screenshot({ path: lowerScreenshot });
  await context.close();
  return { family, viewport, expectedKinds, screenshot, lowerScreenshot };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error("dist/renderer/one.html is missing; run npm run build:renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const [family, manifest] of Object.entries(families)) {
      results.push(await capture(browser, baseUrl, family, manifest, { width: 1440, height: 1100 }));
      results.push(await capture(browser, baseUrl, family, manifest, { width: 390, height: 844 }));
    }
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  fs.writeFileSync(path.join(outDir, "proof-summary.json"), `${JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`Agentlas One task-family QA passed (${results.length} surfaces)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
