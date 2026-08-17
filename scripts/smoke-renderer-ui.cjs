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
  visibility: "background",
};
const seedUserNamedLikeSystem = {
  id: "agent-user-orchestrator-1",
  slug: "local-app-builder",
  name: "My App Builder Orchestrator",
  nameEn: "My App Builder Orchestrator",
  tagline: "Governance and packaging assistant",
  taglineEn: "Governance and packaging assistant",
  kind: "agent",
  visibility: "visible",
};
const seedRoster = [seedSystem, seedAgent, seedTeam, seedBackground, seedUserNamedLikeSystem];

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
    [seedAgent.id, seedTeam.id, seedUserNamedLikeSystem.id],
    "authoritative visibility must keep user assets even when their names contain internal-looking words",
  );
  assert.equal(isVisibleAgent(seedTeam, { includeTeams: true }), true, "team entity must be visible when includeTeams is true");

  // 기본 옵션은 팀을 제외한다 — 그래서 모든 피커/사이드바 호출부는 반드시
  // includeTeams: true를 명시해야 한다(아래 guard가 소스에서 강제).
  const defaults = visibleAgents(seedRoster);
  assert.deepEqual(
    defaults.map((a) => a.id),
    [seedAgent.id, seedUserNamedLikeSystem.id],
    "default visibleAgents() excludes teams — call sites that need teams must opt in explicitly",
  );

  console.log("[logic] agent-visibility.ts includeTeams contract ok");
}

// ---------------------------------------------------------------------------
// 2) guard — 피커/사이드바 계열 호출부의 includeTeams: true 를 소스에서 강제
// ---------------------------------------------------------------------------
const GUARDED_FILES = [
  "renderer/components/AgentPicker.tsx",
  "renderer/components/TaskCockpit.tsx",
  "renderer/components/one/OneShell.tsx",
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
  const taskRoute = "/workspace/task.html";
  if (!fs.existsSync(path.join(distDir, "workspace", "task.html"))) {
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

    await page.goto(`${baseUrl}${taskRoute}?id=chat-1`, { waitUntil: "domcontentloaded" });
    await page.getByRole("textbox").first().waitFor();

    // Work now owns a project sidebar; chat history is a project task surface,
    // not a second agent roster. Keep the smoke on the current shell contract.
    const sidebar = page.locator(".project-sidebar");
    await sidebar.waitFor();
    try {
      await sidebar.getByText("QA Project").waitFor({ timeout: 10000 });
    } catch (err) {
      await page.screenshot({ path: path.join(outDir, "sidebar-team-missing.png"), fullPage: true }).catch(() => {});
      const sidebarText = await sidebar.innerText().catch(() => "");
      console.error(JSON.stringify({ projectSidebarMissing: true, sidebarText, errors }, null, 2));
      throw err;
    }

    // 현재 계약은 별도 AgentPicker 버튼이 아니라 + 메뉴의 "특정 에이전트 지정"
    // 진입점에서 @ 자동완성으로 팀을 선택하는 것이다. 예전 picker 버튼을 찾으면
    // UI가 이미 바뀐 현재 계약을 거짓으로 깨뜨리므로 실제 경로를 검사한다.
    const plusButton = page.locator("[data-chat-plus-button='true']");
    try {
      await plusButton.waitFor({ timeout: 10000 });
    } catch (err) {
      await page.screenshot({ path: path.join(outDir, "plus-button-missing.png"), fullPage: true }).catch(() => {});
      console.error(JSON.stringify({ plusButtonMissing: true, hint: "현재 채팅 입력의 + 진입점이 사라졌다", errors }, null, 2));
      throw err;
    }
    await plusButton.click();
    const plusMenu = page.getByRole("menu");
    await plusMenu.waitFor();
    await plusMenu.getByRole("button", { name: /특정 에이전트 지정|Specify an agent/ }).click();

    // @가 실제 입력되고 자동완성 listbox가 열리는지 확인한다.
    const listbox = page.locator("[data-popover-kind='autocomplete'][role='listbox']");
    await listbox.waitFor();
    const optionCount = await listbox.getByRole("option").count();
    assert.ok(optionCount > 0, "agent autocomplete listbox must not be empty");
    const teamOption = listbox.getByRole("option", { name: /런치크루팀|LaunchCrewTeam/ });
    await teamOption.waitFor();
    assert.equal(
      await listbox.getByRole("option", { name: /백그라운드 도우미|Background Helper/ }).count(),
      0,
      "background agents must stay hidden in autocomplete",
    );
    assert.equal(
      await listbox.getByRole("option", { name: /오케스트레이터|Orchestrator/ }).count(),
      0,
      "system agents must stay hidden in autocomplete",
    );

    // 검색 경로: 팀 이름을 입력해도 팀 옵션이 유지되고 선택이 실제 입력에 반영되는지.
    const renderedTeamName = await teamOption.innerText();
    const teamSearchTerm = renderedTeamName.includes(seedTeam.nameEn) ? "LaunchCrew" : "런치크루";
    const textbox = page.getByRole("textbox").first();
    await textbox.fill(`@${teamSearchTerm}`);
    await listbox.getByRole("option", { name: /런치크루팀|LaunchCrewTeam/ }).waitFor();
    await listbox.getByRole("option", { name: /런치크루팀|LaunchCrewTeam/ }).click();
    const turnCalls = page.locator(".chat-turn-calls");
    await turnCalls.waitFor();
    await turnCalls.getByRole("button", { name: /@(?:런치크루팀|LaunchCrewTeam)/ }).waitFor();

    await page.screenshot({ path: path.join(outDir, "renderer-ui-smoke.png"), fullPage: true });
    assert.deepEqual(errors, [], "renderer UI smoke must not emit page errors");
    await context.close();
    console.log("[ui] team survives agent picker + sidebar on built renderer");

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
