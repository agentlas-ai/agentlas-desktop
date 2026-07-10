#!/usr/bin/env node
// 사이트 스튜디오 M3/M4 게이트 — 주입 오버레이의 실브라우저 E2E (playwright chromium).
// 프로덕션과 동일한 구조로 검증한다: 호스트 페이지 + sandbox="allow-scripts"(opaque origin)
// iframe(srcdoc=prepareSiteRenderHtml 산출물) + nonce 봉투 postMessage 왕복.
// ready → (오답 nonce 무시) → setMode(select) → hover/click → select 페이로드 → 오버레이 숨김.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

const { prepareSiteRenderHtml, tagSiteHtml } = require("../dist/electron/site/html-tagger.js");
const { SITE_MESSAGE_KEY } = require("../dist/shared/site-studio.js");

const SOURCE = [
  "<!doctype html>",
  '<html lang="ko"><head><title>overlay e2e</title>',
  "<style>body{margin:0;font:14px sans-serif}.cta{padding:12px 24px;background:#0a7;color:#fff;border:none;border-radius:8px}</style>",
  "</head><body>",
  '<main style="padding:40px">',
  "<h1>오버레이 테스트</h1>",
  '<button class="cta" aria-label="시작">시작하기</button>',
  "</main>",
  "<script>console.error(\"디자인 스크립트 오류 신호\");<\/script>",
  "</body></html>",
].join("\n");

const NONCE = "e2e-nonce-42";

const HOST_HTML = [
  "<!doctype html><html><head><title>host</title></head><body>",
  "<script>",
  "window.__msgs = [];",
  "window.addEventListener('message', function (e) { window.__msgs.push(e.data); });",
  "window.sendToGuest = function (env) { document.getElementById('f').contentWindow.postMessage(env, '*'); };",
  "</script>",
  '<iframe id="f" sandbox="allow-scripts" style="width:900px;height:640px;border:0"></iframe>',
  "</body></html>",
].join("\n");

(async () => {
  const { renderHtml } = prepareSiteRenderHtml(SOURCE, NONCE);
  const buttonEl = tagSiteHtml(SOURCE).elements.find((e) => e.tagName === "button");
  assert.ok(buttonEl, "tagger must find the button");

  const browser = await chromium.launch();
  let exitCode = 0;
  try {
    const page = await browser.newPage();
    await page.setContent(HOST_HTML, { waitUntil: "domcontentloaded" });
    await page.evaluate((html) => {
      document.getElementById("f").srcdoc = html;
    }, renderHtml);

    const hasMsg = (type) =>
      `(window.__msgs || []).some((m) => m && m["${SITE_MESSAGE_KEY}"] === "${NONCE}" && m.message && m.message.type === "${type}")`;

    // 1) opaque-origin 게스트에서 ready + console 후킹 봉투가 부모에 도착.
    await page.waitForFunction(hasMsg("ready"), null, { timeout: 15_000 });
    await page.waitForFunction(hasMsg("console"), null, { timeout: 15_000 });

    const frameHandle = await page.$("#f");
    const frame = await frameHandle.contentFrame();
    assert.ok(frame, "sandboxed frame must be reachable");
    assert.equal(await frame.evaluate(() => !!window.__agentlasSiteOverlay), true, "overlay must boot inside the sandbox");

    // 2) 잘못된 nonce 명령은 무시된다 — select 모드 전환 실패 → 클릭해도 select 없음.
    await page.evaluate(
      ({ key }) => window.sendToGuest({ [key]: "wrong-nonce", message: { type: "setMode", mode: "select" } }),
      { key: SITE_MESSAGE_KEY },
    );
    const box0 = await frame.locator("button.cta").boundingBox();
    await page.mouse.click(box0.x + box0.width / 2, box0.y + box0.height / 2);
    await page.waitForTimeout(250);
    const selectCount = await page.evaluate(
      ({ key, nonce }) => (window.__msgs || []).filter((m) => m && m[key] === nonce && m.message && m.message.type === "select").length,
      { key: SITE_MESSAGE_KEY, nonce: NONCE },
    );
    assert.equal(selectCount, 0, "wrong-nonce setMode must be ignored");

    // 3) 올바른 nonce로 select 모드 → hover/click → select 페이로드.
    await page.evaluate(
      ({ key, nonce }) => window.sendToGuest({ [key]: nonce, message: { type: "setMode", mode: "select" } }),
      { key: SITE_MESSAGE_KEY, nonce: NONCE },
    );
    const box = await frame.locator("button.cta").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForFunction(hasMsg("select"), null, { timeout: 15_000 });

    const payload = await page.evaluate(
      ({ key, nonce }) => (window.__msgs || []).find((m) => m && m[key] === nonce && m.message && m.message.type === "select").message.payload,
      { key: SITE_MESSAGE_KEY, nonce: NONCE },
    );
    assert.equal(payload.id, buttonEl.id, "selection id must be the tagger-assigned source-offset id");
    assert.equal(payload.tagName, "button");
    assert.ok(payload.rect.width > 0 && payload.rect.height > 0, "rect must be a real box");
    assert.ok(payload.styles && typeof payload.styles.backgroundColor === "string", "curated computed styles must be captured");
    assert.ok(payload.htmlSnippet.includes("시작하기"), "html snippet must carry the element");
    assert.ok(payload.page.viewportWidth > 0, "page context must be captured");
    assert.equal(payload.selector.includes("button"), true, "short selector must name the element");

    // 4) 선택 하이라이트가 보이고, setOverlayVisible(false)로 전부 숨는다(스크린샷 크롭용).
    assert.equal(
      await frame.evaluate(() =>
        Array.from(document.querySelectorAll("[data-agentlas-overlay-ui]")).some((b) => b.style.display !== "none"),
      ),
      true,
      "selection highlight must be visible after select",
    );
    await page.evaluate(
      ({ key, nonce }) => window.sendToGuest({ [key]: nonce, message: { type: "setOverlayVisible", visible: false } }),
      { key: SITE_MESSAGE_KEY, nonce: NONCE },
    );
    await page.waitForFunction(
      () => {
        const f = document.getElementById("f");
        return !!f; // 프레임 존재 확인용 — 실제 검증은 아래 frame.evaluate
      },
      null,
      { timeout: 1_000 },
    );
    const allHidden = await frame.evaluate(() =>
      Array.from(document.querySelectorAll("[data-agentlas-overlay-ui]")).every((b) => b.style.display === "none"),
    );
    assert.equal(allHidden, true, "setOverlayVisible(false) must hide every overlay box");

    console.log("site studio overlay E2E ok (sandbox iframe · ready/console/nonce-gate/select/overlay-hide)");
  } catch (err) {
    console.error(err);
    exitCode = 1;
  } finally {
    await browser.close();
    process.exit(exitCode);
  }
})();
