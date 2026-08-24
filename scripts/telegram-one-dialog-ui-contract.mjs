// 텔레그램 ↔ One 팝업 실렌더 계약.
//
// 순수 함수 게이트로는 못 잡는 것만 본다. 실제로 이 하네스가 잡은 결함 3건:
//   1) 주 CTA 에 focus() 를 주자 카드가 92px 스크롤돼 제목·닫기 버튼이 잘린 채 열렸다
//   2) 내용이 카드보다 길어지면 주 CTA 가 접힘 아래로 사라져 누를 수 없었다
//   3) Escape 로 닫은 뒤 포커스가 body 로 흩어져 키보드 사용자가 처음부터 Tab 해야 했다
//
// dist/renderer(프로덕션 빌드)를 이 프로세스가 띄운 정적 서버로 서빙한다.
// 다른 세션이 쓰는 dev 서버 포트와 .next 캐시를 건드리지 않기 위해서다.
// 인증 게이트는 desktop-ui-regression.mjs 의 mockAgentlasBridge 를 그대로 재사용한다.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rendererDir = path.join(repo, "dist/renderer");
const artifactDir = process.env.TELEGRAM_DIALOG_ARTIFACT_DIR
  ?? fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-tgone-ui-"));

if (!fs.existsSync(path.join(rendererDir, "dashboard.html"))) {
  console.error("dist/renderer is missing — run `npm run build:renderer` first.");
  process.exit(1);
}
fs.mkdirSync(artifactDir, { recursive: true });

const harness = fs.readFileSync(path.join(repo, "scripts/desktop-ui-regression.mjs"), "utf8");
const mockStart = harness.indexOf("function mockAgentlasBridge()");
assert.ok(mockStart > 0, "mockAgentlasBridge not found in desktop-ui-regression.mjs");
// ★파일 마지막 함수라 끝까지 잘라야 한다 — 중간에서 끊으면 목이 조용히 미적용되고
//   증상은 "랜딩만 뜬다"라서 인증 문제로 오진하기 쉽다.
const mockSource = harness.slice(mockStart);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, "http://127.0.0.1").pathname;
  let filePath = path.join(rendererDir, decodeURIComponent(pathname));
  if (!filePath.startsWith(rendererDir)) {
    res.writeHead(403).end();
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    const asHtml = `${filePath.replace(/\/$/, "")}.html`;
    filePath = fs.existsSync(asHtml) ? asHtml : path.join(rendererDir, "index.html");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] ?? "application/octet-stream" });
  res.end(fs.readFileSync(filePath));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

function binding(overrides) {
  return {
    id: "b", targetKind: "agent", targetId: "t", targetName: "T", targetMissing: false,
    status: "chat_paired", enabled: true, sessionRunning: false, automationReportEnabled: false,
    hasToken: true, tokenPreview: null, botUserId: 1, botUsername: "b_bot", botDisplayName: "B",
    telegramChatId: "1", telegramChatTitle: "chat", chatSessionId: null, lastUpdateId: 0,
    lastError: null, lastTestAt: null, designatedProjectId: null, designatedProjectName: null,
    designatedGraphId: null, designatedGraphName: null,
    createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const SCENARIOS = [
  {
    name: "legacy-not-connected",
    bindings: [
      binding({ id: "legacy-1", targetKind: "agent", targetName: "리서치 에이전트" }),
      binding({ id: "legacy-2", targetKind: "firm", targetName: "마케팅 팀", botUsername: "m_bot" }),
    ],
    expect: [/consolidated into|합쳐졌습니다/, /2 existing agent connections|기존 에이전트 연결 2개/],
  },
  {
    name: "connected",
    bindings: [
      binding({
        id: "one-1", targetKind: "one", targetId: "one", targetName: "Hope",
        status: "test_passed", botUsername: "agentlas_hope_bot", telegramChatTitle: "Hope 와의 대화",
      }),
    ],
    // 연결됨 상태에서 그룹 설정이 사라지면 그룹방에서 멘션 없는 메시지를 영영 못 받는다.
    expect: [/Group settings|그룹 설정/, /Disconnect|연결 끊기/, /type \/ to open|\/ 를 입력하면/],
  },
  {
    // v101: One 은 방마다 하나다. 연결이 둘이면 **둘 다** 보여야 한다 — 하나만 그리면
    // 사용자는 두 번째 봇이 안 붙었다고 읽는다. "봇 하나 더 붙이기"도 항상 있어야
    // 세션을 늘릴 길이 화면에 존재한다.
    name: "connected-two-bots",
    bindings: [
      binding({
        id: "one-1", targetKind: "one", targetId: "one", targetName: "Hope",
        status: "test_passed", botUsername: "agentlas_hope_bot", telegramChatTitle: "Hope 와의 대화",
      }),
      binding({
        id: "one-2", targetKind: "one", targetId: "one", targetName: "Hope",
        status: "chat_paired", botUsername: "agentlas_grok_bot", telegramChatTitle: "그록봇 방",
      }),
    ],
    expect: [/agentlas_hope_bot/, /agentlas_grok_bot/, /Add another bot|봇 하나 더 붙이기/],
  },
  { name: "empty", bindings: [], expect: [/Automatic connect|자동 연결/] },
  {
    // 구 preload·목 브리지는 모르는 메서드에 null 을 돌려준다. 그걸 그대로 담으면
    // 다음 렌더의 .find 에서 팝업 전체가 죽는다(실측).
    name: "null-bindings",
    bindings: null,
    expect: [/Automatic connect|자동 연결/],
  },
  {
    // 안내문이 "닫아도 계속됩니다"라고 말하는데 닫히지 않으면 거짓말이다.
    name: "in-flight-closable",
    bindings: [],
    slowConnectMs: 8000,
    expect: [/Automatic connect|자동 연결/],
  },
];

const browser = await chromium.launch();
const failures = [];

for (const scenario of SCENARIOS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.addInitScript(`(${mockSource})()`);
  await context.addInitScript(`
    (() => {
      const bindings = ${JSON.stringify(scenario.bindings ?? null)};
      const slowConnectMs = ${JSON.stringify(scenario.slowConnectMs ?? 0)};
      const telegram = {
        listBindings: async () => bindings,
        connectOne: async () => {
          if (slowConnectMs) await new Promise((r) => setTimeout(r, slowConnectMs));
          return { binding: (bindings ?? [])[0] ?? null, message: "mock" };
        },
        removeLegacy: async () => ({ removed: 2, botsDeleted: 0, botDeleteFailures: ["@m_bot"] }),
        start: async () => ({ binding: null, message: "mock" }),
        remove: async () => ({ botDeleted: false }),
        sendTest: async () => ({ binding: null, message: "mock" }),
        openBot: async () => ({ ok: true, message: "mock" }),
        configureBotSettings: async () => ({ ok: true, message: "mock" }),
      };
      const oneProfile = { get: async () => ({ displayName: "Hope", role: "", profileContext: "", preferredLocale: "system", timeZone: "Asia/Seoul", version: 1, principles: [] }) };
      // ipc() 는 window.agentlas 를 **동일성**으로 캐싱한다(renderer/lib/ipc.ts).
      // 접근마다 새 객체를 주는 getter 를 쓰면 매 호출 캐시가 갈려 목이 안 붙는다.
      const base = window.agentlas;
      window.agentlas = new Proxy(base, {
        get(target, ns) {
          if (ns === "telegram") return telegram;
          if (ns === "oneProfile") return oneProfile;
          return target[ns];
        },
      });
    })();
  `);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });

  const fail = (message) => failures.push(`${scenario.name}: ${message}`);

  try {
    await page.goto(`${base}/dashboard`, { waitUntil: "domcontentloaded", timeout: 40_000 });
    await page.waitForSelector(".sidenav", { timeout: 30_000 });

    // 텔레그램은 라우트가 아니라 팝업이다 — 사이드바 항목이 이동하면 이 클릭이 실패한다.
    await page.locator(".sidenav button").filter({ hasText: /커넥트|Connect/ }).first().click({ timeout: 20_000 });
    await page.locator(".sidenav-subitem").filter({ hasText: /텔레그램|Telegram/ }).first().click({ timeout: 20_000 });
    await page.waitForSelector('[role="dialog"][aria-modal="true"]', { timeout: 15_000 });
    // 초기 포커스는 마운트 직후 setTimeout(0) 으로 잡힌다. 바로 재면 경합으로
    // 하네스가 제품 결함을 오보한다 — 포커스가 앉을 때까지 기다린다.
    await page.waitForFunction(() => {
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
      return Boolean(dlg && document.activeElement && dlg.contains(document.activeElement));
    }, { timeout: 5_000 }).catch(() => {});

    const dialog = page.locator('[role="dialog"][aria-modal="true"]');
    const text = await dialog.innerText();
    for (const pattern of scenario.expect) {
      if (!pattern.test(text)) fail(`expected copy missing: ${pattern}`);
    }

    const layout = await page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
      const buttons = [...dlg.querySelectorAll("button")];
      const cta = buttons[buttons.length - 1];
      const close = buttons[0];
      const title = dlg.querySelector("#tgone-title");
      const card = dlg.getBoundingClientRect();
      // 스크롤을 감당하는 조상(카드 자신이거나 내부 래퍼) — 어느 구조든 "열자마자
      // 위로 잘려 있으면 안 된다"는 결과만 본다(구현을 베껴 적지 않는다).
      let scrolledAway = 0;
      for (let el = title; el && el !== dlg.parentElement; el = el.parentElement) {
        if (el.scrollTop > scrolledAway) scrolledAway = el.scrollTop;
      }
      const rect = (el) => el.getBoundingClientRect();
      return {
        scrolledAway,
        titleTopOffset: rect(title).top - card.top,
        titleVisible: rect(title).top >= card.top - 1 && rect(title).bottom <= card.bottom + 1,
        closeVisible: rect(close).top >= card.top - 1 && rect(close).bottom <= card.bottom + 1,
        ctaBottomOverflow: rect(cta).bottom - card.bottom,
        ctaInViewport: rect(cta).bottom <= window.innerHeight,
        cardInViewport: card.top >= 0 && card.bottom <= window.innerHeight,
        focusedIsCta: document.activeElement === cta,
      };
    });

    // 1) 열자마자 제목·닫기 버튼이 잘려 있으면 안 된다.
    if (layout.scrolledAway !== 0) fail(`dialog opened scrolled (${layout.scrolledAway}px) — the header is cut off`);
    if (!layout.titleVisible) fail(`title is not visible on open (top offset ${Math.round(layout.titleTopOffset)}px)`);
    if (!layout.closeVisible) fail("close button is not visible on open");
    if (!layout.cardInViewport) fail("card does not fit the viewport");
    // 2) 주 행동은 내용 길이와 무관하게 항상 눌러야 한다.
    if (layout.ctaBottomOverflow > 1) fail(`primary CTA is below the card fold (${Math.round(layout.ctaBottomOverflow)}px)`);
    if (!layout.ctaInViewport) fail("primary CTA is outside the viewport");
    // 3) 안전 기본값 — 실수 Enter가 파괴적 정리를 누르면 안 된다.
    if (!layout.focusedIsCta) fail("initial focus must land on the primary CTA");

    await page.screenshot({ path: path.join(artifactDir, `${scenario.name}.png`) });

    if (scenario.name === "in-flight-closable") {
      // 진행 중 안내문이 "닫아도 계속됩니다"라고 말하면 실제로 닫혀야 한다.
      await dialog.locator("button").last().click();
      await page.waitForTimeout(600);
      const busyText = await dialog.innerText();
      if (!/close this window|닫아도/.test(busyText)) fail("in-flight state must tell the user closing is safe");
      if (await dialog.locator("button").first().isDisabled()) fail("close button is disabled while the copy promises closing is safe");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      if ((await page.locator('[role="dialog"][aria-modal="true"]').count()) !== 0) {
        fail("Escape does not close during an in-flight connect, contradicting the copy");
      }
    }

    if (scenario.name === "empty") {
      // ★붙여넣은 BotFather 토큰은 비밀값이다. 컴포넌트가 닫혀도 언마운트되지 않으므로
      //   명시적으로 지우지 않으면 다시 열 때 그대로 보인다(실측).
      await dialog.locator('[role="radio"]').nth(1).click();
      await page.waitForTimeout(300);
      const tokenField = dialog.locator('input[type="password"]');
      if ((await tokenField.count()) === 0) fail("manual mode does not expose a token field");
      else {
        await tokenField.fill("123456:PROBE_SECRET_TOKEN");
        await page.keyboard.press("Escape");
        await page.waitForTimeout(400);
        await page.locator(".sidenav-subitem").filter({ hasText: /텔레그램|Telegram/ }).first().click();
        await page.waitForTimeout(600);
        const reopened = page.locator('[role="dialog"][aria-modal="true"]');
        const body = await reopened.innerText();
        const retained = (await reopened.locator('input[type="password"]').count())
          ? await reopened.locator('input[type="password"]').inputValue()
          : "";
        if (retained.includes("PROBE_SECRET") || body.includes("PROBE_SECRET")) {
          fail("the pasted bot token survives close/reopen — a secret must not be retained");
        }
      }
    }

    if (scenario.name === "legacy-not-connected") {
      let confirmMessage = "";
      page.once("dialog", (d) => { confirmMessage = d.message(); d.accept(); });
      await dialog.locator("button").filter({ hasText: /Clean up|한 번에 정리/ }).first().click();
      await page.waitForTimeout(900);
      if (!/2/.test(confirmMessage)) fail(`cleanup confirm must state the count, got: ${confirmMessage}`);
      const after = await dialog.innerText();
      // 영수증은 토스트가 아니라 팝업에 남아야 한다(배치 파괴 작업의 결과).
      if (!/Removed 2|연결 2개를 정리/.test(after)) fail("cleanup receipt is not shown in the dialog");
      // ★봇 삭제 실패를 성공으로 뭉개면 안 된다.
      if (!/@m_bot/.test(after)) fail("a failed BotFather deletion must be reported verbatim");
      await page.screenshot({ path: path.join(artifactDir, `${scenario.name}-after-cleanup.png`) });

      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
      if ((await page.locator('[role="dialog"][aria-modal="true"]').count()) !== 0) fail("Escape did not close the dialog");
      const focusText = await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 40) ?? "");
      if (!/텔레그램|Telegram/.test(focusText)) fail(`focus must return to the trigger, got: ${focusText || "(none)"}`);

      // ★영수증은 그 열림 세션의 사실이다. 다음에 열 때까지 남으면 과거 정리를
      //   방금 한 일처럼 보고하게 된다(실측).
      await page.locator(".sidenav-subitem").filter({ hasText: /텔레그램|Telegram/ }).first().click();
      await page.waitForTimeout(600);
      const reopenedText = await page.locator('[role="dialog"][aria-modal="true"]').innerText();
      if (/Removed 2|연결 2개를 정리/.test(reopenedText)) {
        fail("the cleanup receipt persists into a fresh open — it reports a past action as if it just happened");
      }
    }

    const actionable = errors.filter((line) => !/favicon|hydration|Download the React/i.test(line));
    if (actionable.length > 0) fail(`console errors: ${actionable.slice(0, 2).join(" | ")}`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    await page.screenshot({ path: path.join(artifactDir, `${scenario.name}-failed.png`) }).catch(() => {});
  } finally {
    await context.close();
  }
  console.log(`  ${failures.some((f) => f.startsWith(scenario.name)) ? "FAIL" : "ok  "} ${scenario.name}`);
}

await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\ntelegram One dialog UI: ${failures.length} failure(s)`);
  for (const line of failures) console.error(`  - ${line}`);
  console.error(`artifacts: ${artifactDir}`);
  process.exit(1);
}
console.log(`\ntelegram One dialog UI: ${SCENARIOS.length} scenarios passed (artifacts: ${artifactDir})`);
