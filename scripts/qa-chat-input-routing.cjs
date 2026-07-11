#!/usr/bin/env node
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const STAMP = new Date().toISOString().replace(/[:.]/g, "-");
const PROOF_ROOT = path.join(os.tmpdir(), `agentlas-chat-input-routing-qa-${STAMP}`);
const USER_DATA_DIR = path.join(PROOF_ROOT, "user-data");
const DB_PATH = path.join(PROOF_ROOT, "agentlas-qa.sqlite");
const SHOTS = path.join(PROOF_ROOT, "shots");
const QA_AGENT_A = path.join(PROOF_ROOT, "agents", "copywriter");
const QA_AGENT_B = path.join(PROOF_ROOT, "agents", "publisher");

fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(USER_DATA_DIR, { recursive: true });
fs.mkdirSync(QA_AGENT_A, { recursive: true });
fs.mkdirSync(QA_AGENT_B, { recursive: true });
fs.writeFileSync(
  path.join(QA_AGENT_A, "AGENTS.md"),
  [
    "# AI 티 제거 카피라이터",
    "",
    "한국어와 영어 카피가 AI처럼 보이지 않게 다듬는 에이전트입니다.",
  ].join("\n"),
);
fs.writeFileSync(
  path.join(QA_AGENT_B, "AGENTS.md"),
  [
    "# Commercial Book Publisher",
    "",
    "책 원고와 출판 워크플로를 정리하는 에이전트입니다.",
  ].join("\n"),
);

// fs 그랜트 프리시드 — 앱의 durable 그랜트 저장 포맷(electron/fs/access.ts)을 launch 전에 써 두고
// AGENTLAS_FS_GRANT_STORE 로 읽힌다. 같은 토큰으로 렌더러에 넘길 FsPathGrant 를 조립한다.
const GRANT_STORE_PATH = path.join(PROOF_ROOT, "fs-read-grants.v1.json");
const seededGrants = new Map();
for (const raw of [PROOF_ROOT, QA_AGENT_A, QA_AGENT_B]) {
  const real = fs.realpathSync.native(raw);
  seededGrants.set(raw, {
    token: randomUUID(),
    path: real,
    mode: "tree",
    durable: true,
    createdAt: new Date().toISOString(),
  });
}
fs.writeFileSync(GRANT_STORE_PATH, `${JSON.stringify([...seededGrants.values()], null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

function grantFromSeed(rawPath) {
  const record = seededGrants.get(rawPath);
  if (!record) throw new Error(`No seeded grant for ${rawPath}`);
  return {
    path: record.path,
    kind: "directory",
    durable: true,
    scope: { kind: "capability", token: record.token },
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function main() {
  const consoleErrors = [];
  const app = await electron.launch({
    cwd: ROOT,
    args: ["."],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AGENTLAS_QA_USER_DATA_DIR: USER_DATA_DIR,
      AGENTLAS_STORE_PATH: DB_PATH,
      AGENTLAS_FS_GRANT_STORE: GRANT_STORE_PATH,
      AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
    },
  });
  let page = null;
  try {
    page = await app.firstWindow({ timeout: 60_000 });
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.setDefaultTimeout(30_000);
    await page.setViewportSize({ width: 1320, height: 920 }).catch(() => undefined);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.agentlas));
    // 전역 로그인 게이트(AuthGate) 우회 — QA user-data엔 세션이 없어 랜딩에 갇힌다.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("auth:getSession");
      ipcMain.handle("auth:getSession", () => ({
        signedIn: true,
        email: "qa@agentlas.local",
        name: "QA",
        plan: "pro",
      }));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => Boolean(window.agentlas));
    await page.evaluate(() => {
      try {
        window.localStorage.setItem("agentlas.onboarded", "1");
      } catch {
        // Some transient Electron documents deny storage; the visible onboarding
        // skip button below covers that first-run path.
      }
      window.location.href = "/chat";
    });
    await Promise.race([
      page.waitForFunction(() => location.pathname.includes("/chat")),
      page.waitForFunction(() => location.pathname.includes("/onboarding")),
    ]);
    if (new URL(page.url()).pathname.includes("/onboarding")) {
      await page.getByRole("button", { name: /건너뛰기|Skip/i }).click();
      await page.waitForFunction(() => !location.pathname.includes("/onboarding"));
      await page.evaluate(() => {
        try {
          window.localStorage.setItem("agentlas.onboarded", "1");
        } catch {
          // Continue; the skip action already persisted onboarding state.
        }
        window.location.href = "/chat";
      });
      await page.waitForFunction(() => location.pathname.includes("/chat"));
    }
    await app.evaluate(({ ipcMain }) => {
      globalThis.__qaRouting = { routeCalls: 0, runs: [], cancels: [] };
      ipcMain.removeHandler("hephaestus:routePreview");
      ipcMain.handle("hephaestus:routePreview", (_event, input) => {
        globalThis.__qaRouting.routeCalls += 1;
        return {
          mode: "single",
          agents: [
            {
              id: "shopify-local-proof",
              name: "쇼피파이",
              source: "local",
              estCredits: null,
              isFirm: false,
            },
          ],
          totalEstCredits: null,
          estimate: true,
          rawAction: "route",
          query: input.query,
          routerAgent: {
            agent: "router-agent-should-not-run-on-plain",
            reason: "qa",
            directive: "This must not be forwarded for plain execution.",
          },
        };
      });
      ipcMain.removeHandler("invoke:run");
      ipcMain.handle("invoke:run", (event, req) => {
        globalThis.__qaRouting.runs.push(req);
        setTimeout(() => {
          event.sender.send("invoke:event:qa-run-1", {
            kind: "thinking",
            status: "루프 Stormbreaker Loop · armed/scope-lock/route",
          });
        }, 80);
        return { runId: "qa-run-1" };
      });
      ipcMain.removeHandler("invoke:activeChats");
      ipcMain.handle("invoke:activeChats", () => {
        const run = globalThis.__qaRouting.runs[0];
        if (!run || globalThis.__qaRouting.cancels.includes("qa-run-1")) return [];
        return [run.chatId];
      });
      ipcMain.removeHandler("invoke:cancel");
      ipcMain.handle("invoke:cancel", (_event, runId) => {
        globalThis.__qaRouting.cancels.push(runId);
      });
    });

    // Playwright evaluate 컨텍스트에서 모듈 로딩이 전면 차단돼(Electron 33+: require/mainModule/dynamic
    // import 모두 없음) grantPath 를 앱 안에서 호출할 수 없다. 대신 launch 전에 프리시드한
    // AGENTLAS_FS_GRANT_STORE(durable 그랜트 저장 포맷)를 앱이 읽게 하고, 같은 토큰으로
    // FsPathGrant 모양(access.ts recordToGrant)을 스크립트에서 조립한다.
    const grants = {
      proofRoot: grantFromSeed(PROOF_ROOT),
      qaAgentA: grantFromSeed(QA_AGENT_A),
      qaAgentB: grantFromSeed(QA_AGENT_B),
    };

    const setup = await page.evaluate(async ({ grants }) => {
      window.localStorage.setItem("agentlas.onboarded", "1");
      await window.agentlas.menu.setLocale("ko").catch(() => undefined);
      await window.agentlas.team.importLocalFolder({ path: grants.qaAgentA.path, scope: grants.qaAgentA.scope }).catch(() => undefined);
      await window.agentlas.team.importLocalFolder({ path: grants.qaAgentB.path, scope: grants.qaAgentB.scope }).catch(() => undefined);
      const allAgents = await window.agentlas.team.list();
      const agents = allAgents.filter((agent) => agent.visibility !== "background" && agent.kind !== "team");
      if (agents.length < 2) throw new Error(`Need at least two visible agents, got ${agents.length}`);
      const chat = await window.agentlas.chats.create({ agentId: agents[0].id, title: "QA routing states" });
      await window.agentlas.workspace.set(chat.id, grants.proofRoot);
      return {
        chat,
        first: { id: agents[0].id, name: agents[0].name || agents[0].nameKo || agents[0].slug },
        second: { id: agents[1].id, name: agents[1].name || agents[1].nameKo || agents[1].slug },
      };
    }, { grants });

    await page.evaluate((chatId) => {
      window.location.href = `/chat?id=${chatId}`;
    }, setup.chat.id);
    await page.waitForFunction(() => location.pathname.includes("/chat"));
    await page.waitForSelector("textarea");

    const textarea = page.locator("textarea").first();

    await textarea.fill("@");
    await page.waitForTimeout(350);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(450);
    let activeRows = await autocompleteActiveRows(page);
    assert.equal(activeRows[1]?.active, true, `ArrowDown should keep second row active: ${JSON.stringify(activeRows)}`);

    const third = page.locator('[data-popover-kind="autocomplete"] [data-autocomplete-option="true"]').nth(2);
    await third.hover();
    await page.waitForTimeout(450);
    activeRows = await autocompleteActiveRows(page);
    assert.equal(activeRows[2]?.active, true, `Mouse hover should keep third row active: ${JSON.stringify(activeRows)}`);
    await page.screenshot({ path: path.join(SHOTS, "01-autocomplete-stable.png"), fullPage: true });

    const sidebar = page.locator("[data-tour-id='workspace.sidebar']").first();
    const sidebarBefore = await sidebar.boundingBox();
    const sidebarHandle = sidebar.locator('[role="separator"][aria-orientation="vertical"]').first();
    await dragHandle(page, sidebarHandle, 56);
    const sidebarAfter = await sidebar.boundingBox();
    assert.ok(sidebarBefore && sidebarAfter, "sidebar resize boxes should be measurable");
    assert.ok(sidebarAfter.width > sidebarBefore.width + 30, `left sidebar should resize wider: ${sidebarBefore.width} -> ${sidebarAfter.width}`);

    await page.keyboard.press("Escape");
    await textarea.fill("");
    // "알아서 에이전트 부르기" 토글은 + 메뉴 안에 있다 — 메뉴를 열고 토글 후 닫는다.
    await toggleAutoRoute(page);
    await textarea.fill("@");
    await page.waitForSelector('[data-popover-kind="autocomplete"] [data-autocomplete-option="true"]');
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);
    const autoChipAfterMention = await autoRouteChipActive(page);
    assert.equal(autoChipAfterMention, false, "@ explicit agent selection must turn off auto routing");

    await toggleAutoRoute(page);
    await textarea.fill("이거 AI 처럼 나오지 않게 해줘");
    await page.locator(".chat-input-send-button").click();
    await waitForMainQa(app, (qa) => qa.routeCalls >= 1);
    // 자동 라우팅 — 추천 시트를 띄우지 않고 즉시 실행된다(codex hep-network 동작).
    await waitForMainQa(app, (qa) => qa.runs.length === 1);
    assert.equal((await mainQa(app)).routeCalls, 1);
    assert.equal(await page.getByText("추천 없이 실행").count(), 0, "auto routing must not show the pick sheet");
    assert.equal(await page.getByText("다른 에이전트 찾기").count(), 0, "auto routing must not offer manual retry");
    await page.screenshot({ path: path.join(SHOTS, "02-auto-route.png"), fullPage: true });

    const run = (await mainQa(app)).runs[0];
    assert.equal(run.userPrompt, "이거 AI 처럼 나오지 않게 해줘");
    assert.ok(run.routerAgent, "auto-routed run must forward the routerAgent escalation");
    assert.equal(run.borrowAgents, undefined, "local single route must not borrow hub agents");

    const stopButton = page.locator('[data-chat-stop-button="true"]').first();
    await stopButton.waitFor();
    await page.waitForTimeout(250);
    assert.equal(await page.getByText("Stormbreaker Loop").count(), 0, "internal Stormbreaker loop status must stay hidden in plain chat");
    assert.equal(
      await page.locator("[data-tour-id='workspace.chat'] .agentlas-activity-card").count(),
      0,
      "plain single-agent run must not render activity cards in the chat stream",
    );
    const rightPanel = page.locator(".chat-right-panel").first();
    const rightPanelBefore = await rightPanel.boundingBox();
    const rightPanelHandle = rightPanel.locator('[role="separator"][aria-orientation="vertical"]').first();
    await dragHandle(page, rightPanelHandle, -64);
    const rightPanelAfter = await rightPanel.boundingBox();
    assert.ok(rightPanelBefore && rightPanelAfter, "right panel resize boxes should be measurable");
    assert.ok(rightPanelAfter.width > rightPanelBefore.width + 30, `right panel should resize wider: ${rightPanelBefore.width} -> ${rightPanelAfter.width}`);
    await page.screenshot({ path: path.join(SHOTS, "03-visible-stop.png"), fullPage: true });
    await stopButton.click();
    await waitForMainQa(app, (qa) => qa.cancels.includes("qa-run-1"));
    await page.getByRole("button", { name: "중지 요청됨" }).first().waitFor();
    await page.screenshot({ path: path.join(SHOTS, "04-stop-requested.png"), fullPage: true });

    await page.evaluate(() => {
      window.location.href = "/apps/generated?id=qa-orphan-app";
    });
    await page.waitForFunction(() => location.pathname === "/apps");
    assert.equal(await page.getByText("Local Web App").count(), 0, "generated local app page must not render");
    await page.screenshot({ path: path.join(SHOTS, "05-generated-app-redirect.png"), fullPage: true });

    assert.deepEqual(consoleErrors, []);
    const report = {
      ok: true,
      proofRoot: PROOF_ROOT,
      shots: fs.readdirSync(SHOTS).map((file) => path.join(SHOTS, file)),
      checks: [
        "@ autocomplete ArrowDown remains on the second row after render churn",
        "@ autocomplete mouse hover remains on the hovered row",
        "explicit @ agent selection disables auto routing",
        "Auto routing executes immediately without a pick sheet",
        "Auto-routed run forwards routerAgent and borrows nothing for a local single route",
        "Stop is visible and transitions to stop-requested state",
        "Internal Stormbreaker loop status is hidden for plain single-agent runs",
        "Plain single-agent run renders no activity cards",
        "Left and right sidebars resize by dragging",
        "/apps/generated redirects to Apps without rendering Local Web App",
      ],
      selectedAgent: setup.second,
      runPayload: run,
    };
    fs.writeFileSync(path.join(PROOF_ROOT, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  } catch (err) {
    if (page) {
      await page.screenshot({ path: path.join(SHOTS, "error.png"), fullPage: true }).catch(() => undefined);
      const debug = await page.evaluate(() => ({
        body: document.body.innerText.slice(0, 5000),
        autoChip: [...document.querySelectorAll("button")]
          .filter((node) => (node.textContent || "").includes("알아서 에이전트 부르기"))
          .map((node) => ({
            text: node.textContent,
            className: node.className,
            ariaPressed: node.getAttribute("aria-pressed"),
          })),
        stopButtons: [...document.querySelectorAll('[data-chat-stop-button="true"]')]
          .map((node) => {
            const rect = node.getBoundingClientRect();
            const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            return {
              text: (node.textContent || "").replace(/\s+/g, " ").trim(),
              disabled: node.disabled,
              rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              hitText: (hit?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
              hitTag: hit?.tagName,
              hitStop: hit?.closest?.('[data-chat-stop-button="true"]') != null,
            };
          }),
      })).catch((debugErr) => ({ debugError: String(debugErr) }));
      debug.mainQa = await mainQa(app).catch((debugErr) => ({ debugError: String(debugErr) }));
      fs.writeFileSync(path.join(PROOF_ROOT, "error-debug.json"), `${JSON.stringify(debug, null, 2)}\n`);
      console.error(`QA failed. Proof root: ${PROOF_ROOT}`);
      console.error(JSON.stringify(debug, null, 2));
    }
    throw err;
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function autocompleteActiveRows(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-popover-kind="autocomplete"]');
    if (!root) return [];
    return [...root.querySelectorAll('[data-autocomplete-option="true"]')].map((button) => ({
      text: (button.textContent || "").replace(/\s+/g, " ").trim(),
      active: button.getAttribute("aria-selected") === "true",
      background: button.style.background,
    }));
  });
}

// "알아서 에이전트 부르기" 토글 — 꺼져 있으면 + 메뉴의 토글 행을, 켜져 있으면 바의 활성 칩을 누른다.
async function toggleAutoRoute(page) {
  const chip = page.locator(".chat-input-hep-chip", { hasText: "알아서 에이전트 부르기" });
  if (await chip.count()) {
    await chip.first().click();
    return;
  }
  await page.getByRole("button", { name: /추가 —|Add —/ }).first().click();
  await page.getByText("알아서 에이전트 부르기").click();
  // 팝오버는 바깥 클릭으로 닫힌다 — 입력창을 눌러 닫고 포커스를 되돌린다.
  await page.locator("textarea").first().click();
}

async function autoRouteChipActive(page) {
  return page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) =>
      (node.textContent || "").includes("알아서 에이전트 부르기"),
    );
    return Boolean(button?.classList.contains("active") || button?.getAttribute("aria-pressed") === "true");
  });
}

async function dragHandle(page, locator, deltaX) {
  await locator.waitFor();
  const box = await locator.boundingBox();
  assert.ok(box, "resize handle should have a bounding box");
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(40, Math.max(2, box.height / 2)));
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + Math.min(40, Math.max(2, box.height / 2)), { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
}

async function mainQa(app) {
  return app.evaluate(() => globalThis.__qaRouting || { routeCalls: 0, runs: [], cancels: [] });
}

async function waitForMainQa(app, predicate, timeoutMs = 8_000) {
  const started = Date.now();
  let latest = null;
  while (Date.now() - started < timeoutMs) {
    latest = await mainQa(app);
    if (predicate(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for main QA state. Latest: ${JSON.stringify(latest)}`);
}
