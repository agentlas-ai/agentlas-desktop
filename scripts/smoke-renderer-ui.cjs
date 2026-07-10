#!/usr/bin/env node
// 릴리스 전 렌더러 UI 스모크 — "팀/에이전트가 피커·사이드바에 안 뜨는" 계열 회귀 게이트.
//
// 배경(v0.7.20~21 실사고, v0.7.22 수정): AgentPicker 내부 visibleAgents() 재필터가
// 기본 옵션(팀 제외)으로 돌아 팀을 지웠고, Sidebar도 팀 제외 기본값으로 팀 채팅
// 라벨이 사라졌다. typecheck는 전부 통과했다 — 타입이 아니라 필터 조합의 문제라서.
//
// 3단 게이트:
//   1) logic  — renderer/lib/agent-visibility.ts(실물 트랜스파일)의 visibleAgents가
//               includeTeams 경로에서 팀을 반환하고 background/system을 숨기는지.
//   2) guard  — AgentPicker/Sidebar/chat 페이지의 모든 visibleAgents() 호출부가
//               includeTeams: true를 유지하는지(재필터 회귀의 소스 레벨 차단).
//   3) ui     — 빌드된 렌더러(dist/renderer)를 Playwright로 띄워 실제 피커 리스트와
//               사이드바 채팅 행에 팀이 뜨고 선택 가능한지.
//
// 사용:
//   node scripts/smoke-renderer-ui.cjs --logic-only   # 1+2만 (렌더러 빌드 불필요, 수 초)
//   node scripts/smoke-renderer-ui.cjs                # 1+2+3 (npm run build:renderer 선행 필요)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const logicOnly = process.argv.includes("--logic-only");

// ---------------------------------------------------------------------------
// 시드 로스터 — 팀 kind 포함. 이름/태그라인은 SYSTEM_AGENT_RE에 걸리지 않아야 한다.
// ---------------------------------------------------------------------------
const seedTeam = {
  id: "agent-team-1",
  slug: "launch-crew-team",
  name: "런치크루팀",
  nameEn: "LaunchCrewTeam",
  tagline: "멀티에이전트 팀",
  taglineEn: "Multi-agent team",
  kind: "team",
  visibility: "local",
};
const seedAgent = {
  id: "agent-normal-1",
  slug: "research-agent",
  name: "리서치 에이전트",
  nameEn: "Research Agent",
  tagline: "자료를 정리합니다.",
  taglineEn: "Organizes research.",
  kind: "agent",
  visibility: "local",
};
const seedBackground = {
  id: "agent-bg-1",
  slug: "background-helper",
  name: "백그라운드 도우미",
  nameEn: "Background Helper",
  tagline: "숨겨진 내부 에이전트",
  taglineEn: "Hidden internal agent",
  kind: "agent",
  visibility: "background",
};
const seedSystem = {
  id: "agent-sys-1",
  slug: "agentlas-orchestrator",
  name: "오케스트레이터",
  nameEn: "Orchestrator",
  tagline: "요청을 라우팅합니다.",
  taglineEn: "Routes requests.",
  kind: "agent",
  visibility: "local",
};
const seedRoster = [seedSystem, seedAgent, seedTeam, seedBackground];

// ---------------------------------------------------------------------------
// 1) logic — 실제 agent-visibility.ts를 트랜스파일해 실행 (사본 재구현 금지)
// ---------------------------------------------------------------------------
function loadAgentVisibility() {
  const ts = require("typescript");
  const srcPath = path.join(root, "renderer", "lib", "agent-visibility.ts");
  const source = fs.readFileSync(srcPath, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: "agent-visibility.ts",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", outputText)(mod, mod.exports, require);
  return mod.exports;
}

function runLogicChecks() {
  const { visibleAgents, isVisibleAgent } = loadAgentVisibility();
  assert.equal(typeof visibleAgents, "function", "visibleAgents must be exported from agent-visibility.ts");

  // includeTeams 경로: 팀이 살아남아야 한다 (피커/사이드바가 쓰는 경로).
  const withTeams = visibleAgents(seedRoster, { includeTeams: true });
  assert.deepEqual(
    withTeams.map((a) => a.id),
    [seedAgent.id, seedTeam.id],
    "visibleAgents({includeTeams:true}) must keep the team and the normal agent, and hide background/system agents",
  );
  assert.equal(isVisibleAgent(seedTeam, { includeTeams: true }), true, "team entity must be visible when includeTeams is true");

  // 기본 옵션은 팀을 제외한다 — 그래서 모든 피커/사이드바 호출부는 반드시
  // includeTeams: true를 명시해야 한다(아래 guard가 소스에서 강제).
  const defaults = visibleAgents(seedRoster);
  assert.deepEqual(
    defaults.map((a) => a.id),
    [seedAgent.id],
    "default visibleAgents() excludes teams — call sites that need teams must opt in explicitly",
  );

  console.log("[logic] agent-visibility.ts includeTeams contract ok");
}

// ---------------------------------------------------------------------------
// 2) guard — 피커/사이드바 계열 호출부의 includeTeams: true 를 소스에서 강제
// ---------------------------------------------------------------------------
const GUARDED_FILES = [
  "renderer/components/AgentPicker.tsx",
  "renderer/components/Sidebar.tsx",
  "renderer/app/(shell)/chat/page.tsx",
];

function extractCalls(source, fnName) {
  const calls = [];
  let from = 0;
  for (;;) {
    const idx = source.indexOf(`${fnName}(`, from);
    if (idx < 0) break;
    // import 문/정의부 제외: 앞 문자가 식별자 문자면 다른 이름의 일부
    const prev = source[idx - 1];
    if (prev && /[\w$.]/.test(prev) && prev !== ".") {
      from = idx + fnName.length;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let i = idx + fnName.length; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    if (end < 0) break;
    calls.push(source.slice(idx, end + 1));
    from = end + 1;
  }
  return calls;
}

function runCallSiteGuard() {
  for (const rel of GUARDED_FILES) {
    const filePath = path.join(root, rel);
    const source = fs.readFileSync(filePath, "utf8");
    const calls = extractCalls(source, "visibleAgents");
    assert.ok(
      calls.length > 0,
      `${rel}: visibleAgents() 호출을 찾지 못했다. 필터 구조를 바꿨다면 이 스모크(scripts/smoke-renderer-ui.cjs)의 GUARDED_FILES/가드도 함께 갱신해라.`,
    );
    for (const call of calls) {
      assert.ok(
        /includeTeams:\s*true/.test(call),
        `${rel}: visibleAgents() 호출이 includeTeams: true 없이 재필터한다 — 팀이 피커/사이드바에서 사라지는 v0.7.20~21 회귀 패턴.\n  호출부: ${call.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    }
  }
  console.log("[guard] picker/sidebar visibleAgents call sites keep includeTeams: true");
}

function runCloudCareerGraphGuard() {
  const rel = "renderer/app/(shell)/cloud/page.tsx";
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  assert.ok(
    source.includes("CareerGraphProofBox") && source.includes("extractCareerGraph"),
    `${rel}: cloud upload result must render the redacted Career Graph proof section.`,
  );
  assert.ok(
    /manifest\.careerGraph/.test(source) && /bundle\.careerGraph/.test(source),
    `${rel}: cloud upload result must read careerGraph from both manifest and bundle payloads.`,
  );
  console.log("[guard] cloud upload renders Career Graph proof when present");
}

// ---------------------------------------------------------------------------
// 3) ui — 빌드된 렌더러에서 피커 리스트/사이드바에 팀이 실제로 뜨는지
// ---------------------------------------------------------------------------
const distDir = path.join(root, "dist", "renderer");
const outDir = path.join(root, "output", "playwright", "renderer-ui-smoke");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function resolveAsset(urlPath) {
  let pathname = decodeURIComponent(urlPath.split("?")[0] || "/");
  const nestedNext = pathname.match(/^\/.+\/(_next\/.+)$/);
  if (nestedNext) pathname = `/${nestedNext[1]}`;
  const nestedIcon = pathname.match(/^\/.+\/(icon\.png)$/);
  if (nestedIcon) pathname = `/${nestedIcon[1]}`;
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
      const filePath = resolveAsset(req.url || "/");
      res.writeHead(filePath.endsWith("404.html") ? 404 : 200, {
        "content-type": mime[path.extname(filePath)] || "application/octet-stream",
      });
      fs.createReadStream(filePath).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

async function runUiChecks() {
  const { chromium } = require("playwright");
  const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
  if (!fs.existsSync(path.join(distDir, "chat.html"))) {
    console.error("dist/renderer is missing. Run npm run build:renderer first.");
    process.exit(2);
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ teamRoster: true }));
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) {
        errors.push(msg.text());
      }
    });

    await page.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox").first().waitFor();

    // 사이드바: 팀에 바인딩된 채팅 행에 팀 이름 라벨이 살아 있어야 한다.
    // (팀이 visibleAgents에서 빠지면 agentById 조회가 실패해 라벨이 사라진다 — 0.7.21 증상)
    const sidebar = page.locator("[data-tour-id='workspace.sidebar']");
    await sidebar.waitFor();
    try {
      await sidebar.getByText("팀 채팅 스모크").waitFor({ timeout: 10000 });
      await sidebar.getByText("런치크루팀").waitFor({ timeout: 10000 });
    } catch (err) {
      await page.screenshot({ path: path.join(outDir, "sidebar-team-missing.png"), fullPage: true }).catch(() => {});
      const sidebarText = await sidebar.innerText().catch(() => "");
      console.error(JSON.stringify({ sidebarTeamMissing: true, sidebarText, errors }, null, 2));
      throw err;
    }

    // 에이전트 피커: 버튼이 존재해야 하고(전멸 회귀), 열면 팀이 리스트에 떠야 한다.
    const pickerButton = page.getByRole("button", { name: /에이전트 바꾸기|Switch agent/ });
    try {
      await pickerButton.waitFor({ timeout: 10000 });
    } catch (err) {
      await page.screenshot({ path: path.join(outDir, "picker-button-missing.png"), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ pickerButtonMissing: true, hint: "displayAgents가 비면 AgentPicker 자체가 렌더되지 않는다 — 필터 전멸 계열 회귀", errors }, null, 2));
      throw err;
    }
    await pickerButton.click();
    const listbox = page.getByRole("listbox", { name: /에이전트 바꾸기|Switch agent/ });
    await listbox.waitFor();

    const optionCount = await listbox.getByRole("option").count();
    assert.ok(optionCount > 0, "agent picker listbox must not be empty");
    await listbox.getByRole("option", { name: /런치크루팀|LaunchCrewTeam/ }).waitFor();
    assert.equal(
      await listbox.getByRole("option", { name: /백그라운드 도우미|Background Helper/ }).count(),
      0,
      "background agents must stay hidden in the picker",
    );
    assert.equal(
      await listbox.getByRole("option", { name: /오케스트레이터|Orchestrator/ }).count(),
      0,
      "system agents must stay hidden in the picker",
    );

    // 검색 경로: 0.7.20 실사고가 "팀 검색 0건·선택 불가"였다.
    await page.getByPlaceholder(/에이전트 검색|Search agents/).fill("런치크루");
    await listbox.getByRole("option", { name: /런치크루팀/ }).waitFor();

    // 팀 선택이 실제로 switchAgent까지 이어지는지.
    await listbox.getByRole("option", { name: /런치크루팀/ }).click();
    await page.waitForFunction(() =>
      window.__qa.calls.some((call) => call.name === "chats.switchAgent" && call.payload.agentId === "agent-team-1"),
    );

    await page.screenshot({ path: path.join(outDir, "renderer-ui-smoke.png"), fullPage: true });
    assert.deepEqual(errors, [], "renderer UI smoke must not emit page errors");
    await context.close();
    console.log("[ui] team survives agent picker + sidebar on built renderer");

    // ── 고용(24h 리스) 시나리오: 동행 배지 + 자동 재주입 + 사이드바 로스터 + 해고 ──
    const hiredContext = await browser.newContext({ viewport: { width: 1440, height: 980 } });
    await hiredContext.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ teamRoster: true, hiredRoster: true }));
    const hiredPage = await hiredContext.newPage();
    const hiredErrors = [];
    hiredPage.on("pageerror", (err) => hiredErrors.push(err.message));
    hiredPage.on("console", (msg) => {
      if (msg.type() === "error" && !/favicon|Failed to load resource/i.test(msg.text())) {
        hiredErrors.push(msg.text());
      }
    });
    await hiredPage.goto(`${baseUrl}/chat.html?id=chat-1`, { waitUntil: "domcontentloaded" });
    await hiredPage.getByRole("textbox").first().waitFor();

    // 동행 배지: 고용된 에이전트가 상시로 보인다 (조용한 증발 버그의 가시성 수정).
    const badge = hiredPage.locator("[data-testid='hired-agents-badge']");
    try {
      await badge.waitFor({ timeout: 10000 });
    } catch (err) {
      await hiredPage.screenshot({ path: path.join(outDir, "hired-badge-missing.png"), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ hiredBadgeMissing: true, errors: hiredErrors }, null, 2));
      throw err;
    }
    await badge.getByText(/인스타 업로더/).waitFor();

    // 자동 재주입: 추천 없이 그냥 보내도 고용 카드가 borrowAgents로 붙는다.
    await hiredPage.locator("textarea").first().fill("고용 재주입 검증");
    await hiredPage.getByRole("button", { name: /보내기|Send/ }).click();
    await hiredPage.waitForFunction(() => window.__qa.calls.some((call) => call.name === "invoke.run"));
    const hiredInvoke = await hiredPage.evaluate(() => window.__qa.calls.find((call) => call.name === "invoke.run"));
    assert.deepEqual(
      hiredInvoke.payload.borrowAgents,
      ["instagram-uploader"],
      "hired agents must be auto-reinjected as borrowAgents on every send",
    );

    // 사이드바 "고용 중" 로스터: 활성 리스(무료 재호출) + 만료(기억 보관) 카드.
    const hiredSidebar = hiredPage.locator("[data-tour-id='workspace.sidebar']");
    await hiredSidebar.getByText(/고용 중|Hired agents/).waitFor();
    await hiredSidebar.getByText("인스타 업로더").waitFor();
    await hiredSidebar.getByText(/무료 재호출|free calls/).waitFor();
    await hiredSidebar.getByText("레딧 시더").waitFor();
    await hiredSidebar.getByText(/기억 그대로|resumes its memory/).waitFor();

    // 해고: × 클릭 → 빈 배열로 저장 → 배지 사라짐.
    await badge.getByRole("button", { name: /고용 해제|Dismiss hired agents/ }).click();
    await hiredPage.waitForFunction(() =>
      window.__qa.calls.some(
        (call) => call.name === "chats.setHiredAgents" && Array.isArray(call.payload.cards) && call.payload.cards.length === 0,
      ),
    );
    await badge.waitFor({ state: "detached" });

    await hiredPage.screenshot({ path: path.join(outDir, "renderer-ui-smoke-hired.png"), fullPage: true });
    assert.deepEqual(hiredErrors, [], "hired scenario must not emit page errors");
    await hiredContext.close();
    console.log("[ui] hired agents: badge + auto-reinject + sidebar roster + dismiss");
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

async function main() {
  runLogicChecks();
  runCallSiteGuard();
  runCloudCareerGraphGuard();
  if (logicOnly) {
    console.log("renderer UI smoke (logic-only) passed");
    return;
  }
  await runUiChecks();
  console.log("renderer UI smoke passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
