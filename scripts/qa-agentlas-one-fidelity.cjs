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
const outDir = path.join(root, "output", "playwright", "agentlas-one-fidelity");

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

function installOneFixture(mode) {
  const englishUi = mode === "briefing-language";
  window.localStorage.setItem("agentlas.locale", englishUi ? "en" : "ko");
  const api = window.agentlas;
  const now = "2026-07-19T03:30:00.000Z";
  const taskId = "task_launch_comparison_001";
  const chatId = "chat_launch_comparison_001";
  const runId = "run_launch_comparison_001";
  const resultMode = mode === "result" || mode === "memory" || mode === "followup" || mode === "briefing-language";
  let followUpChat = null;
  let followUpHistory = [];
  let followUpContinuation = null;
  if (mode === "followup") {
    try {
      const persisted = JSON.parse(window.localStorage.getItem("agentlas.qa.oneFollowUp") || "null");
      if (persisted && typeof persisted === "object") {
        followUpChat = persisted.chat || null;
        followUpHistory = Array.isArray(persisted.history) ? persisted.history : [];
        followUpContinuation = persisted.input || null;
      }
    } catch {}
  }
  const task = {
    id: taskId,
    version: 7,
    title: "50만원 이하 공기청정기 비교",
    projectId: null,
    firmId: null,
    status: mode === "team" || mode === "progress" ? "open" : mode === "briefing-language" ? "partial" : "completed",
    originChatId: chatId,
    createdAt: "2026-07-19T03:10:00.000Z",
    updatedAt: now,
    archivedAt: null,
    participants: [],
  };
  const conversation = {
    id: mode === "conversation" ? "chat_one_conversation_001" : chatId,
    taskId: mode === "conversation" ? null : taskId,
    projectId: null,
    firmId: null,
    agentId: "agent-one",
    kind: "user",
    title: mode === "conversation" ? "거실 공기청정기 알아보기" : task.title,
    archivedAt: null,
    createdAt: "2026-07-19T03:00:00.000Z",
    updatedAt: now,
    hiredAgents: resultMode || mode === "progress" ? [
      { slug: "product-researcher", name: "제품 리서처", source: "firm-node", hiredAt: now },
      { slug: "source-verifier", name: "출처 검증자", source: "installed", hiredAt: now },
    ] : [],
  };
  const receipt = {
    runId,
    chatId,
    status: "completed",
    startedAt: "2026-07-19T03:12:00.000Z",
    updatedAt: now,
    finishedAt: now,
    eventCount: 18,
    resultFolder: "/tmp/agentlas-one-fidelity",
    errorMessage: null,
  };
  const blocks = ["block_comparison", "block_table", "block_insights", "block_sources", "block_files"];
  const surface = {
    contractVersion: "1.0.0",
    manifestId: "manifest_launch_comparison_001",
    taskId,
    title: "가장 잘 맞는 선택: LG 퓨리케어 360°",
    summary: "거실 크기와 50만원 예산을 기준으로 세 제품을 비교했고, 정화 성능과 소음의 균형이 가장 좋은 제품을 골랐어요.",
    layoutProfile: "comparison",
    surfaceState: { value: "ready", summary: "검증된 비교 결과", readOnly: true, lastSyncedAt: now },
    blocks: [
      {
        blockId: blocks[0], type: "Comparison", title: "추천 제품",
        recommendedOptionRef: "option_lg",
        options: [
          { optionRef: "option_lg", title: "LG 퓨리케어 360°", subtitle: "489,000원 · 24~30평", strengths: ["360° 흡입으로 빠른 정화", "미세먼지 제거 성능 우수"], limitations: ["부피와 무게가 큰 편"] },
          { optionRef: "option_samsung", title: "삼성 블루스카이 3100", subtitle: "329,000원 · 15~20평", strengths: ["공간 효율이 좋음", "SmartThings 연동"], limitations: ["정화 속도는 중간 수준"] },
          { optionRef: "option_winix", title: "위닉스 타워 프라임", subtitle: "279,000원 · 10~15평", strengths: ["가성비가 좋음", "조작이 단순함"], limitations: ["대형 거실에는 부족"] },
        ],
      },
      {
        blockId: blocks[1], type: "Table", title: "전체 비교",
        columns: [
          { columnId: "product", label: "제품" }, { columnId: "price", label: "가격" },
          { columnId: "space", label: "추천 공간" }, { columnId: "best", label: "장점" }, { columnId: "limit", label: "아쉬운 점" },
        ],
        featuredColumnIds: ["product", "price", "space"],
        rows: [
          { rowId: "row_lg", cells: [{ columnId: "product", value: "**LG 퓨리케어 360°**" }, { columnId: "price", value: "489,000원" }, { columnId: "space", value: "24~30평" }, { columnId: "best", value: "✅ **정화 성능·소음 균형**" }, { columnId: "limit", value: "크고 무거움" }] },
          { rowId: "row_samsung", cells: [{ columnId: "product", value: "삼성 블루스카이 3100" }, { columnId: "price", value: "329,000원" }, { columnId: "space", value: "15~20평" }, { columnId: "best", value: "연동과 공간 효율" }, { columnId: "limit", value: "정화 속도 보통" }] },
          { rowId: "row_winix", cells: [{ columnId: "product", value: "위닉스 타워 프라임" }, { columnId: "price", value: "279,000원" }, { columnId: "space", value: "10~15평" }, { columnId: "best", value: "가격과 간단한 조작" }, { columnId: "limit", value: "대형 공간에 부족" }] },
        ],
      },
      { blockId: blocks[2], type: "Narrative", title: "선택 이유", paragraphs: ["25평 거실에서는 정화 속도와 필터 성능 차이가 체감에 가장 크게 영향을 줍니다.", "[공식 제품 정보]([link omitted])와 가격 기록을 대조했고, 예산 안에서 성능을 우선하면 LG가 가장 현실적입니다."] },
      { blockId: blocks[3], type: "SourceList", title: "확인한 출처", sources: [
        { sourceRef: "source_lg", title: "LG 공식 제품 사양", publisher: "LG전자", verificationStatus: "verified", claimRefs: ["claim_lg"] },
        { sourceRef: "source_samsung", title: "삼성 공식 제품 사양", publisher: "삼성전자", verificationStatus: "verified", claimRefs: ["claim_samsung"] },
        { sourceRef: "source_danawa", title: "가격 비교 기록", publisher: "다나와", verificationStatus: "partially_verified", claimRefs: ["claim_price"] },
      ] },
      { blockId: blocks[4], type: "ArtifactList", title: "저장할 결과", items: [
        { artifactRef: "artifact_comparison_csv", type: "spreadsheet", label: "공기청정기-비교표.csv", verificationStatus: "verified", sizeBytes: 18420 },
        { artifactRef: "artifact_sources_pdf", type: "document", label: "출처-검증-요약.pdf", verificationStatus: "verified", sizeBytes: 214000 },
      ] },
    ],
    primaryAction: { actionId: "action_open_work", intent: "open_work", label: "비교표 저장", targetRef: taskId, enabled: true },
    secondaryActions: [],
    evidence: [
      { evidenceRef: "evidence_specs", kind: "source", verificationStatus: "verified", label: "공식 사양" },
      { evidenceRef: "evidence_prices", kind: "source", verificationStatus: "partially_verified", label: "가격 기록" },
    ],
    fallback: { markdown: "비교 결과와 출처를 Work에서 확인할 수 있습니다.", artifacts: [] },
    recomposition: {
      desktop: { blockOrder: blocks, tableStrategy: "full_table", comparisonStrategy: "matrix", timelineStrategy: "adaptive" },
      mobile: { blockOrder: blocks, tableStrategy: "featured_cards_then_sheet", comparisonStrategy: "recommended_then_alternatives", timelineStrategy: "vertical" },
    },
  };
  const team = {
    contractVersion: "1.0.0", proposalId: "proposal_air_purifier_001", version: 1, status: "proposed",
    goalSummary: "50만원 이하 공기청정기 세 제품을 비교해 가장 맞는 제품 추천",
    binding: { chatId, taskId, taskVersion: 7, promptDigest: `sha256:${"a".repeat(64)}`, runtimeDigest: `sha256:${"b".repeat(64)}`, permission: "read" },
    complexityReasons: ["parallel_work_requested", "independent_verification_requested"],
    roles: [
      { roleId: "role_coordinator", label: "One", responsibility: "coordinate_and_synthesize", candidate: { candidateRef: "candidate_one", displayName: "One", slug: "one", source: "firm-node", entityKind: "agent", availability: "installed_present", releaseState: "exact_package_hash", releaseRef: `sha256:${"c".repeat(64)}` }, inputScopes: ["current_user_request", "approved_one_profile_memory"], permissionScopes: ["workspace.read", "external.recruitment.denied", "external.payment.denied"], expectedOutput: "요청 기준 정리, 역할 조율, 최종 추천", rationaleRef: "reason_coordination" },
      { roleId: "role_research", label: "제품 리서처", responsibility: "bounded_specialist_contribution", candidate: { candidateRef: "candidate_research", displayName: "제품 리서처", slug: "product-researcher", source: "installed", entityKind: "agent", availability: "installed_present", releaseState: "exact_package_hash", releaseRef: `sha256:${"d".repeat(64)}` }, inputScopes: ["current_user_request"], permissionScopes: ["workspace.read", "external.recruitment.denied", "external.payment.denied"], expectedOutput: "제품 사양·가격 비교표", rationaleRef: "reason_research" },
      { roleId: "role_verify", label: "출처 검증자", responsibility: "bounded_specialist_contribution", candidate: { candidateRef: "candidate_verify", displayName: "출처 검증자", slug: "source-verifier", source: "installed", entityKind: "agent", availability: "installed_present", releaseState: "exact_package_hash", releaseRef: `sha256:${"e".repeat(64)}` }, inputScopes: ["current_user_request"], permissionScopes: ["workspace.read", "external.recruitment.denied", "external.payment.denied"], expectedOutput: "추천 근거와 가격의 교차 검증", rationaleRef: "reason_verify" },
    ],
    cost: { hubBorrowing: "none", runtimeUsage: "unknown", currency: null, authoritativeQuoteRef: null },
    selectionBoundary: "existing_exact_installed_roster_only", limitation: "none", canConfirmTeam: true,
    reservedRun: null, startedRun: null, createdAt: now, updatedAt: now, expiresAt: "2026-07-19T04:30:00.000Z",
  };

  const profile = { contractVersion: "1.0.0", oneId: `one_${"1".repeat(32)}`, version: 1, displayName: "One", role: englishUi ? "Assistant" : "내 비서이자 팀장", profileContext: "", preferredLocale: englishUi ? "en" : "ko", timeZone: "Asia/Seoul", operatingPrinciples: [], createdAt: now, updatedAt: now };
  const completedEvidence = [1, 2].map((index) => ({
    taskId: `task_previous_${index.toString().padStart(3, "0")}`,
    taskVersion: index,
    patternKey: "product-comparison-home-appliance",
    status: "completed",
    hostId: "host_desktop_primary",
    runId: `run_previous_${index.toString().padStart(3, "0")}`,
    completionReceiptRef: `receipt_completion_${index.toString().padStart(3, "0")}`,
    verificationRef: `verification_${index.toString().padStart(3, "0")}`,
    evidenceRefs: [`evidence_team_${index.toString().padStart(3, "0")}`],
    completedAt: `2026-07-${16 + index}T03:30:00.000Z`,
    outcome: "accepted_internal_result",
    acceptanceReceiptVerified: true,
  }));
  const suggestions = {
    contractVersion: "1.0.0",
    version: 3,
    suggestions: mode === "result" ? [{
      id: "suggestion_retain_team_001",
      version: 1,
      type: "retain_team",
      originTaskId: taskId,
      patternKey: "product-comparison-home-appliance",
      evidence: completedEvidence,
      evidenceRefs: completedEvidence.flatMap((item) => item.evidenceRefs),
      proposal: {
        type: "retain_team",
        signalSource: "accepted_result_pattern",
        teamSignatureRef: "team_signature_product_research",
        participantRefs: ["participant_research", "participant_verify"],
        roleRefs: ["role_research", "role_verify"],
        toolRefs: ["tool_web_research"],
        contributionReceiptRefs: ["receipt_research", "receipt_verify"],
        acceptedResultRefs: ["accepted_result_001", "accepted_result_002"],
        acceptedResultCount: 2,
        reviewRequired: true,
      },
      status: "open",
      reviewRequestId: null,
      resumeAfter: null,
      cooldownUntil: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    }] : [],
    reviewRequests: [], suppressions: [], patternFeedback: [], taskArbitrations: [], createdAt: now, updatedAt: now,
  };
  const projection = {
    contractVersion: "1.0.0",
    taskId,
    canonicalVersion: task.version,
    oneId: profile.oneId,
    projectionSurface: "one",
    projectionMode: "summary",
    display: { title: task.title, summary: resultMode ? surface.summary : mode === "progress" ? "제품과 출처를 교차 확인하고 있어요." : "팀을 확인하고 시작할 수 있어요." },
    status: { value: mode === "briefing-language" ? "waiting" : resultMode ? "completed" : mode === "progress" ? "running" : "waiting", source: "authoritative_event", asOf: now },
    sync: {
      connection: "online",
      lastSyncedAt: now,
      authoritativeHostRef: "desktop:local",
      executionAuthorityAvailable: true,
      mutationMode: "direct",
      queuedOperationCount: 0,
    },
    truth: { mayStartExecution: !resultMode && mode !== "progress", mayClaimNewCompletion: resultMode },
    references: {
      ...(resultMode ? { teamRunId: runId, manifestId: surface.manifestId } : {}),
      decisionIds: [],
      artifactIds: resultMode ? ["artifact_comparison_csv", "artifact_sources_pdf"] : [],
      receiptIds: resultMode ? [runId] : [],
    },
    availableActions: [{ actionId: "action_open_work", intent: "open_work", label: "Work에서 열기", targetRef: taskId, enabled: true }],
    pendingOperations: [],
  };
  api.oneProfile.get = async () => profile;
  api.oneSuggestions.getState = async () => mode === "followup"
    ? { ...suggestions, suggestions: [] }
    : suggestions;
  api.oneMemory.getState = async () => ({
    contractVersion: "1.0.0",
    version: 4,
    candidates: mode === "memory" ? [{
      id: `memory_candidate_${"1".repeat(32)}`,
      version: 4,
      normalizedPreview: "제품을 비교할 때는 예산을 넘기지 않고 공식 출처를 우선한다",
      scope: "personal",
      scopeRef: null,
      source: {
        provenanceStatus: "verified",
        sourceTaskId: taskId,
        sourceTaskVersion: task.version,
        sourceRunId: runId,
        sourceValueClosureId: `value_closure_${"2".repeat(32)}`,
        sourceValueClosureVersion: 1,
        sourceRef: `user_instruction:${runId}`,
        evidenceRefs: [`run:${runId}`],
        basis: "explicit_user_statement",
      },
      suppressionKey: `memory-key:${"3".repeat(32)}`,
      status: "pending",
      resolution: null,
      memoryId: null,
      reviewAfter: "2026-08-18T03:30:00.000Z",
      cooldownUntil: null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    }] : [],
    memories: [],
    suppressions: [],
    createdAt: now,
    updatedAt: now,
  });
  api.oneFeatureIntro.getState = async () => null;
  api.oneActivation.getState = async () => null;
  api.oneBriefing.get = async () => null;
  api.oneTeamPreflight.getForChat = async (requestedChatId) => followUpChat && requestedChatId === followUpChat.id
    ? null
    : mode === "team"
    ? team
    : resultMode
      ? {
          ...team,
          version: 3,
          status: "solo_started",
          reservedRun: { mode: "solo", runId, reservedAt: "2026-07-19T03:11:30.000Z" },
          startedRun: { mode: "solo", runId, startedAt: "2026-07-19T03:12:00.000Z" },
        }
      : null;
  api.oneTeamPreflight.prepare = async () => ({ kind: "not_required" });
  api.oneTeamPreflight.autoResolve = async (input) => {
    const reservedRunId = input.requestedRunId;
    const proposal = {
      ...team,
      version: team.version + 1,
      status: "team_reserved",
      reservedRun: { mode: "team", runId: reservedRunId, reservedAt: now },
      startedRun: null,
      updatedAt: now,
    };
    return {
      kind: "reserved",
      proposal,
      ref: {
        contractVersion: "1.0.0",
        proposalId: team.proposalId,
        reservedRunId,
        expectedTaskId: taskId,
        expectedTaskVersion: task.version,
        mode: "team",
      },
    };
  };
  api.oneAttachments.forTeam = async () => null;
  api.tasks.listProjections = async () => mode === "conversation" ? [] : [projection];
  api.tasks.getProjection = async (id) => mode !== "conversation" && id === taskId ? projection : null;
  api.tasks.list = async () => mode === "conversation" ? [] : [task];
  api.tasks.get = async (id) => id === taskId ? task : null;
  api.tasks.findForChat = async (id) => mode === "conversation" || id !== chatId ? null : task;
  api.tasks.continueFromResult = async (input) => {
    window.__qa.calls.push({ name: "tasks.continueFromResult", payload: input });
    followUpChat = {
      id: "chat_follow_up_001",
      projectId: null,
      firmId: null,
      agentGroupId: null,
      agentId: "agent-one",
      kind: "user",
      title: input.userPrompt,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      continuousMode: false,
      swarmMode: false,
      hiredAgents: [],
    };
    followUpHistory = [{
      id: "message_follow_up_context",
      role: "system",
      text: `완료한 이전 일에서 이어갑니다 · ${task.title}\n\n${surface.summary}\n\n새 요청은 별도의 일로 처리합니다. 이전 팀·권한·임시 첨부는 자동으로 이어받지 않았어요.`,
      createdAt: now,
    }, {
      id: "message_follow_up_user_1",
      role: "user",
      text: input.userPrompt,
      createdAt: now,
    }, {
      id: "message_follow_up_assistant_1",
      role: "assistant",
      text: "30만원 이하 조건으로 다시 좁혔어요. 위닉스 타워 프라임이 예산 안에서 가장 균형이 좋고, 더 작은 방이면 블루스카이도 충분합니다.",
      createdAt: now,
    }];
    followUpContinuation = input;
    window.localStorage.setItem("agentlas.qa.oneFollowUp", JSON.stringify({
      chat: followUpChat,
      history: followUpHistory,
      input,
    }));
    return followUpChat;
  };
  api.chats.listRecent = async () => followUpChat ? [followUpChat, conversation] : [conversation];
  api.chats.get = async (id) => followUpChat && id === followUpChat.id ? followUpChat : conversation;
  api.invoke.activeChats = async () => mode === "progress" ? [chatId] : [];
  api.invoke.latestReceipt = async () => resultMode ? receipt : null;
  api.invoke.latestOneSurface = async () => resultMode ? { manifest: surface } : null;
  api.invoke.attach = async () => mode === "progress" ? {
    runId,
    events: [
      { kind: "thinking", status: "요청 조건을 정리했습니다.", agentId: "agent-one", agentName: "One", phase: "plan" },
      { kind: "tool-use", status: "제품 후보를 찾고 있습니다.", tool: { name: "web_search", args: "{}" }, agentId: "product-researcher", agentName: "제품 리서처", phase: "delegate" },
      { kind: "tool-use", status: "가격과 공식 사양을 교차 검증하고 있습니다.", tool: { name: "verify_sources", result: "3 sources checked" }, agentId: "source-verifier", agentName: "출처 검증자", phase: "delegate" },
    ],
  } : null;
  api.invoke.history = async (id) => followUpChat && id === followUpChat.id ? followUpHistory : mode === "conversation" ? [
    { id: "message_user_1", role: "user", text: "거실 공기청정기를 바꾸고 싶은데 뭐부터 봐야 할지 모르겠어.", createdAt: "2026-07-19T03:01:00.000Z" },
    { id: "message_assistant_1", role: "assistant", text: "먼저 거실 크기와 예산만 알면 후보를 크게 줄일 수 있어요. 지난번 가전 선택에서는 **소음과 관리 편의**를 중요하게 보셨는데, 이번에도 같은 기준을 적용할까요?", createdAt: "2026-07-19T03:02:00.000Z" },
    { id: "message_user_2", role: "user", text: "응. 25평 거실이고 50만원 아래였으면 좋겠어.", createdAt: "2026-07-19T03:03:00.000Z" },
    { id: "message_assistant_2", role: "assistant", text: "좋아요. 이번에는 **25평·50만원 이하·소음·필터 관리**를 기준으로 비교할게요. 제품 사양과 실제 가격은 리서처가 찾고, 다른 검증자가 추천 근거를 교차 확인하면 안전합니다. 비교를 시작할까요?", createdAt: "2026-07-19T03:04:00.000Z" },
  ] : mode === "team" ? [
    { id: "message_user_team", role: "user", text: "50만원 이하 공기청정기 중 우리 집에 맞는 걸 골라줘.", createdAt: "2026-07-19T03:11:00.000Z" },
    { id: "message_assistant_team", role: "assistant", text: "25평 거실과 지난번에 중요하게 본 소음·관리 편의를 기준으로 잡았어요. 제품 조사와 출처 검증을 나눠서 진행하겠습니다.", createdAt: "2026-07-19T03:12:00.000Z" },
  ] : [
    { id: "message_user_result", role: "user", text: "50만원 이하 공기청정기 중 우리 집에 맞는 걸 골라줘.", createdAt: "2026-07-19T03:11:00.000Z" },
    { id: "message_assistant_result", role: "assistant", text: "공식 사양과 현재 가격을 대조해 세 제품으로 추렸어요. 결론부터 보면 **LG 퓨리케어 360°**가 가장 잘 맞습니다.", createdAt: "2026-07-19T03:29:00.000Z" },
  ];
}

async function capture(browser, baseUrl, fixture) {
  const context = await browser.newContext({ viewport: fixture.viewport });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ preloadMethodPaths: preloadMethodPaths(path.join(root, "electron", "preload.ts")) }));
  await context.addInitScript(installOneFixture, fixture.mode);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}/one.html${fixture.query}`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  await page.waitForSelector("main", { timeout: 10_000 });
  await page.waitForTimeout(900);
  if (fixture.mode === "followup") {
    const composer = page.getByLabel("One에게 요청");
    await composer.fill("30만원 이하로 다시 골라줘");
    await page.getByRole("button", { name: "보내기" }).click();
    await page.getByText("30만원 이하 조건으로 다시 좁혔어요.", { exact: false }).waitFor({ timeout: 5_000 });
    const continuedComposer = page.getByLabel("One에게 요청");
    await continuedComposer.fill("그중 소음이 가장 낮은 건 뭐야?");
    await page.getByRole("button", { name: "보내기" }).click();
    await page.getByText("그중 소음이 가장 낮은 건 뭐야?", { exact: true }).waitFor({ timeout: 5_000 });
    await page.waitForTimeout(500);
  }
  const metrics = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      text,
      width: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      topLevelButtons: [...document.querySelectorAll("main > button, main > header button")].map((item) => item.textContent?.trim()).filter(Boolean),
    };
  });
  assert.deepEqual(errors, [], `${fixture.name}: page errors`);
  assert.ok(metrics.width <= metrics.clientWidth + 2, `${fixture.name}: horizontal overflow`);
  assert.doesNotMatch(metrics.text, /구조화된 실행 결과|Run closure|external recruitment denied|release hash unavailable|Task · [A-Za-z0-9]/, `${fixture.name}: internal language leaked`);
  if (fixture.mode === "result") {
    assert.match(metrics.text, /가장 잘 맞는 선택: LG 퓨리케어 360°/i);
    assert.match(metrics.text, /LG 퓨리케어 360°/);
    assert.match(metrics.text, /비교표 저장/);
    assert.match(metrics.text, /이 팀을 다음에도 바로 부를 수 있게 둘까요/);
    assert.doesNotMatch(metrics.text, /One이 준비한 팀|Team prepared by One/, "a consumed proposal must disappear before the result renders");
    assert.doesNotMatch(metrics.text, /\*\*|\[link omitted\]|✅/, "structured results must not leak model Markdown or status emoji into native cells");
  }
  if (fixture.mode === "memory") {
    assert.match(metrics.text, /가장 잘 맞는 선택: LG 퓨리케어 360°/i);
    assert.match(metrics.text, /이 기준을 기억해둘까요/);
    assert.match(metrics.text, /예산을 넘기지 않고 공식 출처를 우선/);
    assert.match(metrics.text, /확인 전에는 재사용하지 않아요/);
    assert.doesNotMatch(metrics.text, /이 팀을 다음에도 바로 부를 수 있게 둘까요/);
  }
  if (fixture.mode === "team") {
    assert.match(metrics.text, /QA final/);
    assert.doesNotMatch(metrics.text, /One이 준비한 팀|전문가를 사용할까요|Use an expert|직접 처리/, "One must staff ordinary work without asking the beginner to choose an execution path");
    const runs = await page.evaluate(() => window.__qa.calls.filter((item) => item.name === "invoke.run"));
    assert.equal(runs.length, 1, "One must start the automatically chosen team exactly once");
    assert.equal(runs[0].payload.oneTeamPreflightRef?.mode, "team", "the invisible staffing decision must retain its exact team reservation");
  }
  if (fixture.mode === "conversation") {
    assert.match(metrics.text, /지난번 가전 선택/);
    assert.match(metrics.text, /제품 사양과 실제 가격/);
  }
  if (fixture.mode === "progress") {
    assert.match(metrics.text, /가격·사실·출처를 확인하고 있어요/);
    assert.match(metrics.text, /제품 리서처 · 출처 검증자/);
    assert.doesNotMatch(metrics.text, /\d+%/);
  }
  if (fixture.mode === "briefing-language") {
    assert.match(metrics.text, /One result is ready for you\./);
    assert.match(metrics.text, /Open the result to review what One prepared\./);
    const briefingText = await page.getByRole("heading", { name: "One result is ready for you." })
      .locator("xpath=ancestor::section[1]")
      .innerText();
    assert.doesNotMatch(
      briefingText,
      /[\u3131-\u318e\uac00-\ud7a3]/u,
      `English system briefings must not contain Korean copy: ${briefingText}`,
    );
  }
  if (fixture.mode === "followup") {
    assert.match(metrics.text, /이전 결과를 참고해 이 대화에서 이어서 진행해요/);
    assert.match(metrics.text, /30만원 이하로 다시 골라줘/);
    assert.match(metrics.text, /그중 소음이 가장 낮은 건 뭐야/);
    assert.doesNotMatch(metrics.text, /이전 팀·권한·임시 첨부는 자동으로 이어받지 않았어요|완료한 이전 일에서 이어갑니다/, "the beginner surface must collapse internal continuation details");
    assert.doesNotMatch(metrics.text, /One이 준비한 팀|이 팀을 다음에도 바로 부를 수 있게 둘까요/);
    const persistedContinuation = await page.evaluate(() => JSON.parse(window.localStorage.getItem("agentlas.qa.oneFollowUp") || "null")?.input);
    assert.deepEqual(persistedContinuation, {
      taskId: "task_launch_comparison_001",
      expectedVersion: 7,
      userPrompt: "30만원 이하로 다시 골라줘",
    });
    const followUpRuns = await page.evaluate(() => window.__qa.calls.filter((item) => item.name === "invoke.run"));
    assert.equal(followUpRuns.length, 1, "the next turn inside the new conversation must not fork context again");
  }
  await page.screenshot({ path: path.join(outDir, `${fixture.name}.png`), fullPage: true });
  if (fixture.mode === "followup" && fixture.viewport.width > 700) {
    await page.getByRole("button", { name: "사이드바 열기" }).click();
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(outDir, `${fixture.name}-menu.png`) });
  }
  if (fixture.viewport.width <= 700) {
    const menuButton = page.getByRole("button", { name: "사이드바 열기" });
    await menuButton.click();
    await page.waitForTimeout(180);
    await page.screenshot({ path: path.join(outDir, `${fixture.name}-menu.png`) });
    const scrim = page.getByRole("button", { name: "최근 기록 닫기" });
    const scrimBox = await scrim.boundingBox();
    assert.ok(scrimBox, "mobile menu: scrim must be visible");
    await page.mouse.click(scrimBox.x + scrimBox.width - 12, scrimBox.y + Math.min(180, scrimBox.height / 2));
    if (fixture.mode === "result") {
      await page.evaluate(() => {
        const scroller = [...document.querySelectorAll("main, main *")].find((element) => {
          const style = getComputedStyle(element);
          return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20;
        });
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await page.waitForTimeout(220);
      const fullComparison = page.getByText("전체 비교 보기", { exact: true });
      await fullComparison.click();
      await page.waitForTimeout(120);
      await page.evaluate(() => {
        const scroller = [...document.querySelectorAll("main, main *")].find((element) => {
          const style = getComputedStyle(element);
          return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20;
        });
        if (scroller) scroller.scrollTop = scroller.scrollHeight;
      });
      await page.waitForTimeout(220);
      const primaryAction = page.getByRole("button", { name: "비교표 저장" });
      assert.ok(await primaryAction.count(), "mobile result: primary action must remain reachable");
      await primaryAction.scrollIntoViewIfNeeded();
      const primaryBox = await primaryAction.boundingBox();
      assert.ok(primaryBox && primaryBox.y >= 0 && primaryBox.y < fixture.viewport.height, "mobile result: primary action must be reachable after scrolling");
      const reuseSuggestion = page.getByText("이 팀을 다음에도 바로 부를 수 있게 둘까요?", { exact: true });
      assert.ok(await reuseSuggestion.count(), "mobile result: reusable team suggestion must remain reachable");
      await reuseSuggestion.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(outDir, `${fixture.name}-lower.png`) });
    }
  }
  if (fixture.mode === "result" && fixture.viewport.width > 700) {
    await page.evaluate(() => {
      const scroller = [...document.querySelectorAll("main, main *")].find((element) => {
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 20;
      });
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    });
    await page.waitForTimeout(220);
    const primaryAction = page.getByRole("button", { name: "비교표 저장" });
    await primaryAction.scrollIntoViewIfNeeded();
    const primaryBox = await primaryAction.boundingBox();
    assert.ok(primaryBox && primaryBox.y >= 0 && primaryBox.y < fixture.viewport.height, "desktop result: primary action must remain reachable");
    const reuseSuggestion = page.getByText("이 팀을 다음에도 바로 부를 수 있게 둘까요?", { exact: true });
    await reuseSuggestion.scrollIntoViewIfNeeded();
    const reuseBox = await reuseSuggestion.boundingBox();
    assert.ok(reuseBox && reuseBox.y >= 0 && reuseBox.y < fixture.viewport.height, "desktop result: reusable team suggestion must remain reachable");
    await page.screenshot({ path: path.join(outDir, `${fixture.name}-lower.png`) });
  }
  if (fixture.mode === "memory" && fixture.viewport.width > 700) {
    const memoryCandidate = page.getByText("이 기준을 기억해둘까요?", { exact: true });
    await memoryCandidate.scrollIntoViewIfNeeded();
    const candidateBox = await memoryCandidate.boundingBox();
    assert.ok(candidateBox && candidateBox.y >= 0 && candidateBox.y < fixture.viewport.height, "desktop memory: inline review card must be reachable");
    await page.screenshot({ path: path.join(outDir, `${fixture.name}-lower.png`) });
  }
  await context.close();
  return { name: fixture.name, width: metrics.clientWidth, textLength: metrics.text.length };
}

async function main() {
  if (!fs.existsSync(path.join(distDir, "one.html"))) throw new Error("dist/renderer/one.html is missing; run npm run build:renderer first");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  const fixtures = [
    { name: "briefing-language-desktop", mode: "briefing-language", query: "", viewport: { width: 1440, height: 920 } },
    { name: "conversation-desktop", mode: "conversation", query: "?chat=chat_one_conversation_001", viewport: { width: 1440, height: 920 } },
    { name: "team-desktop", mode: "team", query: "?task=task_launch_comparison_001", viewport: { width: 1440, height: 980 } },
    { name: "team-mobile", mode: "team", query: "?task=task_launch_comparison_001", viewport: { width: 390, height: 844 } },
    { name: "progress-desktop", mode: "progress", query: "?task=task_launch_comparison_001", viewport: { width: 1440, height: 980 } },
    { name: "progress-mobile", mode: "progress", query: "?task=task_launch_comparison_001", viewport: { width: 390, height: 844 } },
    { name: "result-reference-viewport", mode: "result", query: "?task=task_launch_comparison_001", viewport: { width: 1680, height: 948 } },
    { name: "result-desktop", mode: "result", query: "?task=task_launch_comparison_001", viewport: { width: 1440, height: 1100 } },
    { name: "result-mobile", mode: "result", query: "?task=task_launch_comparison_001", viewport: { width: 390, height: 844 } },
    { name: "memory-desktop", mode: "memory", query: "?task=task_launch_comparison_001", viewport: { width: 1440, height: 1100 } },
    { name: "followup-desktop", mode: "followup", query: "?task=task_launch_comparison_001", viewport: { width: 1440, height: 980 } },
    { name: "followup-mobile", mode: "followup", query: "?task=task_launch_comparison_001", viewport: { width: 390, height: 844 } },
  ];
  const results = [];
  try {
    for (const fixture of fixtures) results.push(await capture(browser, baseUrl, fixture));
  } finally {
    await browser.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
  fs.writeFileSync(path.join(outDir, "proof-summary.json"), `${JSON.stringify({ recordedAt: new Date().toISOString(), results }, null, 2)}\n`);
  console.log(`Agentlas One fidelity QA passed (${results.length} surfaces)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
