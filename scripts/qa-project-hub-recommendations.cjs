#!/usr/bin/env node
"use strict";

/*
 * Focused renderer QA for project Hub staffing.
 *
 * Mocked browser evidence only: this verifies click, visible draft, durable
 * project update across reload, bookmark-backed Hub identity, duplicate lock,
 * and honest empty/offline copy. It does not prove live Hub availability,
 * account entitlement, credits, or worker execution.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);
const projectUrl = "/project/detail.html?id=project-1";
const { createJiti } = require(path.join(root, "node_modules/jiti"));
const jiti = createJiti(__filename, {
  alias: { "@": path.join(root, "renderer"), "@shared": path.join(root, "shared") },
  interopDefault: true,
  jsx: true,
});
const {
  appendProjectPoolMember,
  buildProjectHubRecommendationQuery,
  buildProjectHubRecommendationJudgmentSpec,
  buildProjectHubRecommendations,
  hubProjectCandidate,
} = jiti(path.join(root, "renderer/lib/project-agent-roster.ts"));

function recommendationFixture(slug, name, definitionId) {
  return {
    slug,
    name,
    nameEn: name,
    tagline: `${name} 공개 능력 설명`,
    taglineEn: `${name} published capability`,
    trustGrade: "A",
    installCount: 1,
    manifestUrl: "mock",
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    source: "hub-index",
    entityKind: "agent",
    agentDefinitionId: definitionId,
    agentReleaseId: `rel-${definitionId}`,
  };
}

function installProjectFixture({ searchMode = "results", projectWriteFailure = false, judgmentMode = "llm" } = {}) {
  const now = new Date().toISOString();
  const fixtureListing = (slug, name, definitionId) => ({
    slug,
    name,
    nameEn: name,
    tagline: `${name} 공개 능력 설명`,
    taglineEn: `${name} published capability`,
    trustGrade: "A",
    installCount: 1,
    manifestUrl: "mock",
    kind: "cloud-callable",
    callable: true,
    routingReady: true,
    source: "hub-index",
    entityKind: "agent",
    agentDefinitionId: definitionId,
    agentReleaseId: `rel-${definitionId}`,
  });
  const first = {
    slug: "first-hub-agent",
    listing: fixtureListing("first-hub-agent", "첫 Hub 에이전트", "def-first"),
    bookmarkedAt: now,
    bookmarked: true,
  };
  const saved = {
    slug: "saved-fit",
    listing: fixtureListing("saved-fit", "북마크된 추천", "def-saved"),
    bookmarkedAt: now,
    bookmarked: true,
  };
  let storedBookmarks = [];
  try { storedBookmarks = JSON.parse(window.localStorage.getItem("agentlas.qa.hubBookmarks") || "[]"); } catch {}
  if (!Array.isArray(storedBookmarks) || storedBookmarks.length === 0) {
    window.__qa.emitHubBookmarkSnapshot([first, saved]);
  }

  const storageKey = "agentlas.qa.project-hub-recommendation";
  const blank = {
    id: "project-1",
    name: "개인정보 문서 프로젝트",
    description: "고객 문서의 개인정보 공개 범위를 검토합니다.",
    systemPrompt: "민감정보를 제거하고 공개 가능한 산출물만 만드세요.",
    agentPool: [],
    sourceType: "local",
    sourceRef: null,
    folderPath: "/tmp/agentlas-qa-project",
    createdAt: now,
    updatedAt: now,
  };
  const read = () => {
    try { return JSON.parse(window.localStorage.getItem(storageKey) || "null") || blank; }
    catch { return blank; }
  };
  const write = (project) => window.localStorage.setItem(storageKey, JSON.stringify(project));
  window.agentlas.projects.get = async (id) => id === "project-1" ? read() : null;
  window.agentlas.projects.list = async () => [read()];
  window.agentlas.projects.update = async (id, patch) => {
    if (id !== "project-1") throw new Error("Project not found");
    if (projectWriteFailure) {
      window.__qa.calls.push({ name: "projects.update.failed", payload: { id, patch } });
      throw new Error("mock project write failed");
    }
    const updated = { ...read(), ...patch, updatedAt: new Date().toISOString() };
    write(updated);
    window.__qa.calls.push({ name: "projects.update", payload: { id, patch } });
    return updated;
  };
  const unbookmarked = fixtureListing("unbookmarked-fit", "새 개인정보 검토자", "def-new");
  window.agentlas.marketplace.search = async (query) => {
    window.__qa.calls.push({ name: "marketplace.search.project", payload: { query } });
    return searchMode === "results" ? [saved.listing, unbookmarked] : [];
  };
  window.agentlas.marketplace.status = async () => ({
    mode: "mcp",
    baseUrl: "mock://hub",
    online: searchMode !== "offline",
    usingFallback: false,
    lastError: searchMode === "offline" ? "fetch failed" : null,
    lastCheckedAt: now,
  });
  window.agentlas.judgment.judgeSubset = async (spec) => {
    window.__qa.calls.push({ name: "judgment.judgeSubset.project", payload: spec });
    if (judgmentMode !== "llm") {
      return { selected: [], source: "fallback", confidence: 0, reason: "mock bridge has no connected model" };
    }
    return {
      selected: spec.labels.slice(0, 2),
      source: "llm",
      confidence: 0.93,
      reason: "published privacy-review capability directly matches the project context",
    };
  };
  window.agentlas.billing.getCredits = async () => {
    window.__qa.calls.push({ name: "billing.getCredits.free", payload: {} });
    return { authenticated: true, plan: "free", remainingCredits: 0, earningsCredits: 0 };
  };
  window.agentlas.projects.listRentAllowed = async () => [];
  window.agentlas.agentLeases = {
    list: async () => [],
    quote: async (slug) => {
      window.__qa.calls.push({ name: "agentLeases.quote", payload: { slug } });
      throw new Error("paid lease must not be requested while attaching");
    },
    purchase: async (input) => {
      window.__qa.calls.push({ name: "agentLeases.purchase", payload: input });
      throw new Error("paid lease must not be purchased while attaching");
    },
  };
}

function runSourceContracts() {
  const listing = recommendationFixture("privacy-reviewer", "개인정보 검토자", "def-privacy");
  const query = buildProjectHubRecommendationQuery({
    name: "Private review",
    description: "owner@example.com https://private.example/path?token=abc /Users/person/secret/file.txt",
    systemPrompt: "API_KEY=sk-secretsecretsecret 0123456789abcdef0123456789abcdef",
  });
  assert.doesNotMatch(query, /owner@example\.com|private\.example|\/Users\/person|sk-secret|0123456789abcdef/);
  assert.doesNotMatch(query, /Project context|Project name|Project description|Project instructions/,
    "fixed English scaffolding must not pollute Hub ranking");
  assert.match(query, /^Private review\n/);
  assert.match(query, /\[redacted-(?:email|url|path|secret|identifier)\]/);

  const saved = recommendationFixture("saved", "저장됨", "def-saved");
  const fresh = recommendationFixture("fresh", "새 후보", "def-fresh");
  const rows = buildProjectHubRecommendations(
    [saved, fresh],
    [{ slug: "saved", listing: saved, bookmarkedAt: "2026-01-01T00:00:00.000Z", bookmarked: true }],
    [],
    "ko",
  );
  assert.deepEqual(rows.map((row) => [row.listing.slug, row.bookmarked]), [["saved", true], ["fresh", false]]);
  assert.equal(rows[1].reason, fresh.tagline);
  const judgmentSpec = buildProjectHubRecommendationJudgmentSpec(
    { name: "개인정보 검토", description: "고객 문서의 개인정보를 찾습니다.", systemPrompt: "민감정보를 제거합니다." },
    rows,
  );
  assert.equal(judgmentSpec.kind, "project-hub-recommendations");
  assert.deepEqual(judgmentSpec.labels, ["candidate-1", "candidate-2"]);
  assert.match(judgmentSpec.input, /개인정보 검토[\s\S]*saved[\s\S]*fresh/);
  assert.equal(judgmentSpec.timeoutMs, 45_000);
  assert.equal(judgmentSpec.minConfidence, 0.6);
  const longMenu = buildProjectHubRecommendations(
    Array.from({ length: 50 }, (_, index) => recommendationFixture(
      `${"long-segment-".repeat(7)}${index}`,
      `후보 ${index} ${"긴 이름 ".repeat(20)}`,
      `def-long-${index}`,
    )).map((row) => ({ ...row, tagline: `공개 능력 ${"설명 ".repeat(200)} ${row.slug}` })),
    [],
    [],
    "ko",
    50,
  );
  const boundedSpec = buildProjectHubRecommendationJudgmentSpec(
    { name: "N".repeat(1_200), description: "D".repeat(1_200), systemPrompt: "S".repeat(1_200) },
    longMenu,
  );
  assert.equal(boundedSpec.labels.length, 50, "long public slugs must not be silently excluded");
  assert.match(boundedSpec.input, /candidate-50\t/);
  assert.ok(boundedSpec.input.length <= 23_900, `judgment input exceeded bound: ${boundedSpec.input.length}`);

  const candidate = hubProjectCandidate(listing, "ko");
  const first = appendProjectPoolMember([], candidate);
  assert.equal(first.status, "added", "empty free-account roster must accept its first Hub candidate");
  assert.equal(appendProjectPoolMember(first.members, candidate).status, "duplicate");
  const legacySlugMember = { ...candidate.member, targetId: listing.slug };
  assert.equal(appendProjectPoolMember([legacySlugMember], candidate).status, "duplicate", "slug and definition id are aliases");
  assert.deepEqual(buildProjectHubRecommendations([listing], [], [legacySlugMember], "ko"), [], "slug alias must suppress an attached recommendation");

  const unavailable = recommendationFixture("offline", "오프라인", "def-offline");
  unavailable.routingReady = false;
  assert.deepEqual(buildProjectHubRecommendations([unavailable], [], [], "ko"), []);
  const full = Array.from({ length: 32 }, (_, index) => ({ ...candidate.member, targetId: `other-${index}` }));
  assert.equal(appendProjectPoolMember(full, candidate).status, "full");
}

async function openScenario(browser, baseUrl, options) {
  const context = await browser.newContext({ viewport: { width: 1180, height: 860 }, locale: "ko-KR" });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions());
  await context.addInitScript(installProjectFixture, options);
  await context.addInitScript(() => {
    window.localStorage.setItem("agentlas.locale", "ko");
    window.localStorage.setItem("agentlas.onboarded", "1");
  });
  const page = await context.newPage();
  await page.goto(`${baseUrl}${projectUrl}`, { waitUntil: "domcontentloaded" });
  await page.getByText("프로젝트 에이전트", { exact: true }).waitFor({ timeout: 15_000 });
  return { context, page };
}

async function main() {
  runSourceContracts();
  if (process.env.AGENTLAS_QA_SOURCE_ONLY === "1") {
    console.log(JSON.stringify({ status: "PASS", scope: "source contracts only" }, null, 2));
    return;
  }
  const built = path.join(distDir, "project", "detail.html");
  if (!fs.existsSync(built)) throw new Error(`Fresh renderer build required: ${built}`);
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();
  const screenshotDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-project-hub-qa-"));
  try {
    const { context, page } = await openScenario(browser, baseUrl, { searchMode: "results" });

    // Empty pool: the first bookmarked Hub row must enter the left draft.
    await page.getByText("편집", { exact: true }).click();
    await page.getByRole("button", { name: /^Hub\s+2$/ }).click();
    await page.getByRole("button", { name: /첫 Hub 에이전트/ }).click();
    assert.match(await page.getByText("프로젝트 에이전트", { exact: true }).locator("..").innerText(), /1/);
    await page.getByRole("button", { name: "도구 저장" }).click();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("프로젝트 에이전트", { exact: true }).waitFor();
    assert.match(await page.getByText("프로젝트 에이전트", { exact: true }).locator("..").innerText(), /1/);

    // Full-catalog recommendation includes a bookmarked fit and an unbookmarked fit.
    await page.getByTestId("project-hub-recommend-button").click();
    await page.getByTestId("project-hub-recommendations").waitFor();
    assert.match(await page.getByTestId("project-hub-recommendation-saved-fit").innerText(), /북마크됨/);
    const newRow = page.getByTestId("project-hub-recommendation-unbookmarked-fit");
    const callsBeforeAttach = await page.evaluate(() => window.__qa.calls.length);
    await newRow.getByRole("button", { name: "프로젝트에 붙이기" }).click();
    await newRow.getByRole("button", { name: "붙임 완료" }).waitFor();
    assert.equal(await newRow.getByRole("button", { name: "붙임 완료" }).isDisabled(), true, "duplicate click must be locked");
    const calls = await page.evaluate(() => window.__qa.calls);
    // The bridge call ledger is recreated by the reload above; this is the
    // recommendation attachment write in the current document.
    assert.equal(calls.filter((call) => call.name === "projects.update").length, 1);
    assert.equal(calls.filter((call) => call.name === "marketplace.bookmarkAdd").length, 1);
    const judgmentCall = calls.find((call) => call.name === "judgment.judgeSubset.project");
    assert.equal(judgmentCall.payload.kind, "project-hub-recommendations");
    assert.match(judgmentCall.payload.input, /개인정보 문서 프로젝트[\s\S]*saved-fit[\s\S]*unbookmarked-fit/);
    const paidCalls = calls.slice(callsBeforeAttach).filter((call) => /agentLeases\.(?:quote|purchase)|prepare|invoke/i.test(call.name));
    assert.deepEqual(paidCalls, [], "free-account attachment must not lease, prepare, or invoke an agent");
    await page.screenshot({ path: path.join(screenshotDir, "recommendation-attached.png"), fullPage: true });
    await page.keyboard.press("Escape");
    assert.match(await page.getByText("프로젝트 에이전트", { exact: true }).locator("..").innerText(), /2/);

    // Reopen proves project persistence and bookmark-backed slug resolution.
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByText("프로젝트 에이전트", { exact: true }).waitFor();
    await page.getByText("프로젝트 에이전트", { exact: true }).click();
    assert.equal(await page.getByRole("switch", { name: /렌트허용/ }).count(), 2);
    await context.close();

    const empty = await openScenario(browser, baseUrl, { searchMode: "empty" });
    await empty.page.getByTestId("project-hub-recommend-button").click();
    await empty.page.getByRole("alert").filter({ hasText: "찾지 못했습니다" }).waitFor();
    await empty.context.close();

    const offline = await openScenario(browser, baseUrl, { searchMode: "offline" });
    await offline.page.getByTestId("project-hub-recommend-button").click();
    await offline.page.getByRole("alert").filter({ hasText: "연결하지 못했습니다" }).waitFor();
    await offline.context.close();

    const noModel = await openScenario(browser, baseUrl, { searchMode: "results", judgmentMode: "unavailable" });
    await noModel.page.getByTestId("project-hub-recommend-button").click();
    await noModel.page.getByRole("alert").filter({ hasText: "연결 모델이 응답하지 않았습니다" }).waitFor();
    await noModel.page.getByRole("button", { name: "Hub에서 직접 검색" }).waitFor();
    assert.equal(await noModel.page.getByTestId("project-hub-recommendation-unbookmarked-fit").count(), 0,
      "unjudged recall rows must never be displayed as recommendations");
    await noModel.page.waitForTimeout(400);
    await noModel.page.screenshot({ path: path.join(screenshotDir, "recommendation-model-unavailable.png"), fullPage: true });
    await noModel.context.close();

    const failed = await openScenario(browser, baseUrl, { searchMode: "results", projectWriteFailure: true });
    await failed.page.getByTestId("project-hub-recommend-button").click();
    const failedRow = failed.page.getByTestId("project-hub-recommendation-unbookmarked-fit");
    await failedRow.getByRole("button", { name: "프로젝트에 붙이기" }).click();
    await failed.page.getByRole("alert").filter({ hasText: "북마크는 저장됐지만" }).waitFor();
    const failedCalls = await failed.page.evaluate(() => window.__qa.calls);
    assert.equal(failedCalls.filter((call) => call.name === "marketplace.bookmarkAdd").length, 1);
    assert.equal(failedCalls.filter((call) => call.name === "marketplace.bookmarkRemove").length, 0,
      "a failed project write must not remove a bookmark that another view may own");
    await failed.context.close();

    console.log(JSON.stringify({ status: "PASS", evidence: screenshotDir, scope: "mocked renderer only" }, null, 2));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
