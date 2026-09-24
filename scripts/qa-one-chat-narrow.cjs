#!/usr/bin/env node
"use strict";
/*
 * One 대화 열이 좁을 때(오른쪽 결과 패널을 연 채 창 1240px → 대화 열 ~440px)
 * 겹침·잘림·기계 문자열을 잰다.
 *
 * 오너 스크린샷(프로덕션 1.2.41, Thread Marketing 태스크포스 대화):
 *   1. 접수 확인 카드의 "Check admission" / "Stop original run" 글자가 두 줄로 접혀 서로 겹쳐 그려짐
 *   2. 작성창 도구 줄의 권한 칩이 "Full acces" 로 말줄임 없이 잘림
 *   3. 머리글 제목 "Thread Mar…" 가 남는 자리가 있는데 일찍 말줄임
 *   4. 예약 보고 말풍선 첫머리에 "[controller_judged] NODE_CLAIMED_WITHOUT_TOOLS:", "[Hope] NEEDS-INPUT:" 가 그대로
 *   5. 목표 모델 변경 예약 알림이 빨간 오류 상자로 뜸
 *
 * 오너 DB 없이: 빌드된 renderer(UI_QA_DIST, 기본 dist/renderer) + mock 브리지 + 덧씌운 대화 상태.
 * 대화 열 폭은 결과 패널을 열고 그 경계 손잡이를 키보드로 움직여 맞춘다(실제 사용자가 하는 그대로).
 * 360 은 좁은 창(모바일 배치)으로 잰다.
 *
 * 겹침 판정은 세 가지 가드를 건다(쌓임 순서 대신 "같은 흐름의 조작 요소끼리만" 비교,
 * 점 대신 사각형 교차, 잘라내는 조상으로 보이는 사각형을 먼저 자른다). 글자 겹침은
 * 조작 요소 사각형이 아니라 Range 로 잰 **그려진 글자 줄** 사각형으로 잰다.
 *
 * 실행: UI_QA_DIST=renderer/.next-build node scripts/qa-one-chat-narrow.cjs [before|after]
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { setupMockAgentlasBridge, mockBridgeOptions } = require("./lib/mock-agentlas-bridge.cjs");
const { resolveDistDir, startStaticRenderer } = require("./lib/qa-static-renderer.cjs");

const root = path.resolve(__dirname, "..");
const distDir = resolveDistDir(root);
const tag = process.argv[2] || "after";
const outDir = process.env.ONECHAT_QA_OUT ? path.resolve(process.env.ONECHAT_QA_OUT, tag) : path.join(root, "output", "playwright", "one-chat-narrow", tag);
const at = (n) => new Date(Date.UTC(2026, 8, 24, 3, n)).toISOString();

const REPORTS = [
  "Threads 예약 게시\n\n[controller_judged] NODE_CLAIMED_WITHOUT_TOOLS: \"Post the reply\" is a step that changes the outside world, but it never called a tool — that answer did not actually happen.",
  "Threads 주간 분석\n\n**[Hope]** NEEDS-INPUT: Which account should the weekly analytics use — @agentlas_kr or @agentlas_global?",
  "Threads 예약 게시\n\n[controller_judged] The previous session could not be resumed because its runtime was replaced; the next run starts a fresh session.",
];
const TRANSCRIPT = [
  { id: "u1", role: "user", createdAt: at(0), text: "스레드 마케팅 계정 운영을 매일 해줘. 답글은 톤 가이드를 지켜서." },
  { id: "a1", role: "assistant", createdAt: at(1), text: "Strongest audience windows: Monday 00:00–03:00 and Thursday 21:00–23:00. I will schedule replies accordingly." },
  ...REPORTS.map((text, i) => ({
    id: `r${i}`, role: "system", createdAt: at(10 + i), text,
    hostNotice: { purpose: "automation-report", runId: `run-${i}`, automationId: i === 1 ? "auto-weekly" : "auto-threads" },
  })),
];
const ADMISSION_RUN_ID = "8790c064-6cfe-4c5c-b3ac-9bbd8c10a1a0";

// eslint-disable-next-line no-undef
function installState(state) {
  const api = window.agentlas;
  if (!api || !api.chats) throw new Error("mock bridge missing");
  const now = new Date().toISOString();
  const goal = {
    goalId: "goal-1", lifecycle: "ongoing", goalRevision: 2, version: 7, runId: "run-1",
    objective: state.locale === "ko" ? "Threads 마케팅 계정을 매일 운영하고 주간 반응을 분석한다" : "Run the Threads marketing account daily and analyse weekly engagement",
    status: "blocked", runStatus: "blocked", blockedReason: "verification_unavailable",
    acceptanceCriteria: ["Post daily", "No duplicate posts"],
  };
  let selection = null;
  const baseGet = api.chats.get;
  api.chats.get = async (id) => ({ ...(await baseGet(id)), ...(id === "one-chat-1" ? { originSurface: "one", goalId: "goal-1", title: "Thread Marketing", runtimeSelection: selection } : {}) });
  api.chats.getGoalContext = async () => goal;
  api.chats.getGoalRuntimeSelection = async () => null;
  api.chats.getGoalResumeReview = async () => null;
  api.chats.requestGoalRuntimeSelection = async (chatId, input) => {
    selection = input.selection;
    return { chat: { ...(await api.chats.get(chatId)), runtimeSelection: input.selection }, goalId: "goal-1", goalRevision: 2, state: "pending" };
  };
  api.chats.setRuntimeSelection = async (chatId, next) => { selection = next; return api.chats.get(chatId); };
  api.invoke.history = async () => state.transcript;
  api.invoke.preflightSteers = async () => [];
  api.invoke.steeringRecovery = async () => [];
  api.invoke.admission = async () => ({ status: "pending", chatId: "one-chat-1" });
  api.invoke.cancel = async () => ({ status: "not-found" });
  api.runLedger.chatTimeline = async () => [];
  api.confirm.committedAnswers = async () => [];
  api.workLiveView = Object.assign(api.workLiveView || {}, { onStatus: () => () => {} });
  api.oneTaskforces = Object.assign(api.oneTaskforces || {}, {
    list: async () => [{ id: "tf-1", chatId: "one-chat-1", title: "Thread Marketing", description: "", memberAgentIds: ["agent-2", "agent-3"], createdAt: now, updatedAt: now, revision: 1 }],
  });
  const runtime = {
    kind: "codex", backend: "openai", source: "/usr/local/bin/codex", version: "mock", active: true,
    model: "gpt-6-luna", effort: "xhigh", availableModels: ["gpt-6-luna", "gpt-6"],
    efforts: [{ id: "low", label: "Low" }, { id: "medium", label: "Medium" }, { id: "high", label: "High" }, { id: "xhigh", label: "XHigh" }],
    activeRoles: ["orchestrator"], roleSelections: {},
  };
  api.runtime.detect = async () => [runtime];
  api.runtime.listModels = async () => [{ id: "gpt-6-luna", label: "gpt-6-luna" }, { id: "gpt-6", label: "gpt-6" }];
  window.localStorage.setItem("agentlas.one.permission-mode.v1", "full");
  window.localStorage.setItem(`agentlas.one-uncertain-admission.v1:one-chat-1`, JSON.stringify({ chatId: "one-chat-1", runId: state.admissionRunId }));
}

/* 대화 열 안의 조작 요소·글자를 훑는다. 결과는 결함 목록. */
const MEASURE = String.raw`(() => {
  const composer = document.querySelector('[data-one-composer="true"]');
  const dock = composer?.parentElement;
  if (!dock) return { error: "no composer" };
  const colRect = dock.getBoundingClientRect();
  const col = { left: colRect.left, right: colRect.right };
  const side = document.querySelector('[data-one-rail-resize="true"]')?.closest("aside, section, div[class*=Panel]");
  const inColumn = (el) => {
    if (side && side.contains(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= col.left - 2 && r.left < col.right;
  };
  const drawn = (el) => {
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0.5 && r.height > 0.5;
  };
  // 가드 3: 잘라내는 조상 전부로 자른 "보이는" 사각형
  const clipRect = (el, r0, includeSelf = false) => {
    let r = { left: r0.left, top: r0.top, right: r0.right, bottom: r0.bottom };
    for (let cur = includeSelf ? el : el.parentElement; cur && cur !== document.documentElement; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.overflowX !== "visible" || cs.overflowY !== "visible") {
        const c = cur.getBoundingClientRect();
        if (cs.overflowX !== "visible") { r.left = Math.max(r.left, c.left); r.right = Math.min(r.right, c.right); }
        if (cs.overflowY !== "visible") { r.top = Math.max(r.top, c.top); r.bottom = Math.min(r.bottom, c.bottom); }
      }
    }
    r.left = Math.max(r.left, 0); r.right = Math.min(r.right, innerWidth);
    return r;
  };
  const area = (r) => Math.max(0, r.right - r.left) * Math.max(0, r.bottom - r.top);
  const inter = (a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) });
  const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.tagName).replace(/\s+/g, " ").trim().slice(0, 40);
  const floating = (el) => { for (let cur = el; cur; cur = cur.parentElement) { const p = getComputedStyle(cur).position; if (p === "fixed" || p === "absolute") return cur; } return null; };
  const controls = [...document.querySelectorAll("button, a[href], summary, [role=button], input:not([type=hidden]), select")]
    .filter((el) => drawn(el) && inColumn(el) && !el.closest('[role="dialog"], [role="menu"], [data-one-composer-popover]'));
  const findings = [];
  // 글자가 있는데 폭이 0 으로 눌린 조작 요소(글자는 그 밖으로 그려진다) — drawn() 이 걸러 내므로 따로 센다.
  for (const el of document.querySelectorAll("button, [role=button]")) {
    if (el.closest('[role="dialog"], [role="menu"], [data-one-composer-popover]') || !el.innerText.trim()) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") continue;
    if (r.height > 0 && r.width <= 2 && r.left >= col.left - 2 && r.left < col.right && !(side && side.contains(el))) findings.push({ kind: "control-collapsed", control: label(el), w: Math.round(r.width) });
  }
  // 가드 1: 같은 흐름(같은 floating 조상)의 조작 요소끼리만 겹침을 본다.
  const vis = controls.map((el) => ({ el, r: clipRect(el, el.getBoundingClientRect()), f: floating(el) }));
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) {
    const a = vis[i], b = vis[j];
    if (a.el.contains(b.el) || b.el.contains(a.el) || a.f !== b.f) continue;
    const x = inter(a.r, b.r);
    if (area(x) > 4 && (x.right - x.left) > 1.5 && (x.bottom - x.top) > 1.5) findings.push({ kind: "control-overlap", a: label(a.el), b: label(b.el), px: Math.round(area(x)) });
  }
  // 그려진 글자 줄(Range) 이 다른 조작 요소나 자기 상자 밖으로 나가는가
  for (const a of vis) {
    const walker = document.createTreeWalker(a.el, NodeFilter.SHOW_TEXT);
    const own = a.el.getBoundingClientRect();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !drawn(n.parentElement)) continue;
      const range = document.createRange(); range.selectNodeContents(n);
      for (const tr of range.getClientRects()) {
        // 글자 줄은 자기 부모(말줄임하는 span 등)의 잘라냄까지 적용해야 그려진 모양이다.
        const t = clipRect(n.parentElement, tr, true);
        if (area(t) < 1) continue;
        for (const b of vis) {
          if (b === a || b.el.contains(a.el) || a.el.contains(b.el) || a.f !== b.f) continue;
          const x = inter(t, b.r);
          if (area(x) > 4) findings.push({ kind: "text-over-control", text: n.textContent.trim().slice(0, 30), over: label(b.el), px: Math.round(area(x)) });
        }
        if (t.left < own.left - 1 || t.right > own.right + 1) findings.push({ kind: "text-spills-control", control: label(a.el), text: n.textContent.trim().slice(0, 30) });
      }
    }
  }
  // 조작 요소가 가로로 잘려 안 보이는가(스크롤 칸 밖으로 밀림 포함)
  for (const a of vis) {
    const r = a.el.getBoundingClientRect();
    if ((a.r.right - a.r.left) < r.width - 1.5) findings.push({ kind: "control-clipped", control: label(a.el), shown: Math.round(a.r.right - a.r.left), full: Math.round(r.width) });
  }
  // 말줄임 없이 잘린 글자 / 대화 열 밖으로 나간 글자
  for (const el of document.querySelectorAll("strong, span, small, p, button, h1, h2, h3, div, li, code")) {
    if (!drawn(el) || !inColumn(el) || el.closest('[role="dialog"], [role="menu"], [data-one-composer-popover]')) continue;
    const hasText = [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim());
    if (!hasText) continue;
    const cs = getComputedStyle(el);
    if (cs.overflowX !== "visible" && el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== "ellipsis" && cs.overflowX !== "auto" && cs.overflowX !== "scroll") {
      findings.push({ kind: "cut-without-ellipsis", text: el.innerText.trim().slice(0, 40) });
    }
    const r = clipRect(el, el.getBoundingClientRect());
    if (r.right > col.right + 1 && area(r) > 0) findings.push({ kind: "past-column", text: el.innerText.trim().slice(0, 40), over: Math.round(r.right - col.right) });
  }
  // 머리글 제목: 말줄임인데 옆에 빈 자리가 남는가
  const bar = document.querySelector('[data-one-task-menu="true"]')?.parentElement;
  const title = bar?.querySelector("strong");
  let header = null;
  if (title) {
    const idEl = title.parentElement.parentElement;
    const idR = idEl.getBoundingClientRect();
    const tR = title.parentElement.getBoundingClientRect();
    const truncated = title.scrollWidth > title.clientWidth + 1;
    // 머리줄의 남는 자리: 안쪽 폭 - 보이는 자식 폭 합 - 보이는 자식 사이 간격. grid 의 빈 칸 간격도 여기 잡힌다.
    const bcs = getComputedStyle(bar);
    const kids = [...bar.children].filter((k) => getComputedStyle(k).display !== "none");
    const gap = parseFloat(bcs.columnGap) || 0;
    const inner = bar.clientWidth - parseFloat(bcs.paddingLeft) - parseFloat(bcs.paddingRight);
    const used = kids.reduce((sum, k) => sum + k.getBoundingClientRect().width, 0) + gap * Math.max(0, kids.length - 1);
    const wideGrid = bcs.display === "grid" ? (bcs.gridTemplateColumns.split(" ").length - kids.length) * gap : 0;
    header = { title: title.textContent, truncated, shown: Math.round(title.clientWidth), full: title.scrollWidth,
      freeRight: Math.round(idR.right - tR.right), slack: Math.round(inner - used + wideGrid * 0), emptyTrackGap: Math.round(wideGrid) };
    const spare = Math.max(header.freeRight, header.emptyTrackGap);
    if (truncated && spare > 12) findings.push({ kind: "title-truncated-with-space", ...header });
  }
  // 기계 문자열이 첫머리로 보이는가(칩 [data-machine-code] 안은 제외)
  const machine = [];
  for (const art of document.querySelectorAll('[data-host-notice="automation-report"]')) {
    const clone = art.cloneNode(true);
    clone.querySelectorAll("[data-machine-code]").forEach((n) => n.remove());
    const txt = clone.innerText || clone.textContent || "";
    const m = txt.match(/\[[a-z_]+\]|\b[A-Z][A-Z0-9]+(?:[_-][A-Z0-9]+)+:|\[Hope\]/g);
    if (m) machine.push(...m);
  }
  if (machine.length) findings.push({ kind: "machine-text", codes: [...new Set(machine)] });
  const notice = document.querySelector('[data-one-action-notice="true"]');
  const noticeInfo = notice ? { text: notice.innerText.slice(0, 60), tone: notice.getAttribute("data-tone") || "alert", height: Math.round(notice.getBoundingClientRect().height),
    color: getComputedStyle(notice).color } : null;
  const admission = document.querySelector('[data-one-uncertain-admission="true"]');
  const admissionInfo = admission ? { height: Math.round(admission.getBoundingClientRect().height),
    buttons: [...admission.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return { t: b.innerText.replace(/\n/g, "⏎"), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }) } : null;
  const chips = [...document.querySelectorAll('[data-one-composer-trigger]')].map((b) => { const r = b.getBoundingClientRect(); const v = clipRect(b, r); const s = b.querySelector("span"); return { k: b.getAttribute("data-one-composer-trigger"), text: s ? s.textContent : "", shownW: Math.round(v.right - v.left), fullW: Math.round(r.width), ellipsized: s ? s.scrollWidth > s.clientWidth + 1 : false }; });
  return { columnWidth: Math.round(col.right - col.left), header, admission: admissionInfo, notice: noticeInfo, chips, findings };
})()`;

async function setColumnWidth(page, target) {
  // 결과 패널 경계 손잡이: ← 넓힘(대화 열 좁아짐), → 좁힘. 16px 단위.
  const handle = page.locator('[data-one-rail-resize="true"]');
  if (!(await handle.count())) return null;
  await handle.focus();
  for (let i = 0; i < 80; i++) {
    const w = await page.evaluate(() => Math.round(document.querySelector('[data-one-composer="true"]').parentElement.getBoundingClientRect().width));
    if (Math.abs(w - target) <= 8) return w;
    await page.keyboard.press(w > target ? "ArrowLeft" : "ArrowRight");
    await page.waitForTimeout(30);
  }
  return page.evaluate(() => Math.round(document.querySelector('[data-one-composer="true"]').parentElement.getBoundingClientRect().width));
}

async function openCase(browser, baseUrl, { width, locale }) {
  const viewport = width === 360 ? { width: 360, height: 820 } : { width: 1240, height: 820 };
  const context = await browser.newContext({ viewport, locale: locale === "ko" ? "ko-KR" : "en-US" });
  await context.addInitScript(setupMockAgentlasBridge, mockBridgeOptions({ oneConversation: true }));
  await context.addInitScript(installState, { transcript: TRANSCRIPT, admissionRunId: ADMISSION_RUN_ID, locale });
  await context.addInitScript((loc) => {
    window.localStorage.setItem("agentlas.locale", loc);
    window.localStorage.setItem("agentlas.onboarded", "1");
    window.localStorage.setItem("agentlas.work.firstRunOnboarding.v3", "1");
  }, locale);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(`${baseUrl}/one.html?chat=one-chat-1`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-one-composer="true"]', { timeout: 20000 });
  await page.waitForSelector('[data-one-uncertain-admission="true"]', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200);
  let columnWidth = null;
  if (width !== 360) {
    const toggle = page.locator('[data-one-output-toggle="true"]');
    if (await toggle.count() && (await toggle.getAttribute("data-active")) !== "true") await toggle.click();
    await page.waitForTimeout(400);
    columnWidth = await setColumnWidth(page, width);
    await page.waitForTimeout(300);
  }
  return { context, page, errors, columnWidth };
}

async function queueModelChange(page, locale) {
  const chip = page.locator('[data-one-composer-trigger="effort"]');
  if (!(await chip.count())) return false;
  await chip.click();
  await page.waitForTimeout(250);
  const option = page.locator("#one-composer-popover button", { hasText: /^\s*High\s*$|High/ }).first();
  if (!(await option.count())) { await page.keyboard.press("Escape"); return false; }
  await option.click();
  await page.waitForTimeout(600);
  return page.locator('[data-one-action-notice="true"]').count().then((n) => n > 0);
}

async function main() {
  assert.ok(fs.existsSync(path.join(distDir, "one.html")), `dist 가 없습니다: ${distDir}`);
  fs.mkdirSync(outDir, { recursive: true });
  const { server, baseUrl } = await startStaticRenderer(distDir);
  const browser = await chromium.launch();
  const results = [];
  const fail = [];
  try {
    for (const width of [360, 440, 560, 720]) {
      for (const locale of ["en", "ko"]) {
        const name = `${locale}-${width}`;
        const { context, page, errors, columnWidth } = await openCase(browser, baseUrl, { width, locale });
        await page.evaluate(() => { const s = document.querySelector('[data-host-notice="automation-report"]'); s?.scrollIntoView({ block: "center" }); });
        await page.waitForTimeout(200);
        const idle = await page.evaluate(MEASURE);
        await page.screenshot({ path: path.join(outDir, `${name}-idle.png`) });
        const queued = await queueModelChange(page, locale);
        await page.waitForTimeout(200);
        const notice = await page.evaluate(MEASURE);
        await page.screenshot({ path: path.join(outDir, `${name}-notice.png`) });
        const row = { name, columnWidth: columnWidth ?? idle.columnWidth, idle, queued, notice: notice.notice, noticeFindings: notice.findings, errors };
        results.push(row);
        const all = [...idle.findings, ...notice.findings];
        if (!idle.admission) fail.push(`${name}: 접수 확인 카드가 안 보임`);
        if (!queued) fail.push(`${name}: 모델 변경 예약 알림을 띄우지 못함`);
        if (tag === "after") {
          const uniq = [...new Set(all.map((f) => JSON.stringify(f)))];
          if (uniq.length) fail.push(`${name}: ${uniq.join(" ; ")}`);
          if (notice.notice && notice.notice.tone !== "info") fail.push(`${name}: 모델 변경 예약 알림이 오류 색(tone=${notice.notice.tone})`);
        }
        if (errors.length) fail.push(`${name}: 페이지 오류 ${errors.join(" | ")}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(results, null, 2));
  for (const r of results) {
    const kinds = {};
    for (const f of [...r.idle.findings, ...r.noticeFindings]) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    console.log(`${r.name} col=${r.columnWidth} header=${JSON.stringify(r.idle.header)} admission=${JSON.stringify(r.idle.admission?.buttons)} chips=${JSON.stringify(r.idle.chips)} notice=${JSON.stringify(r.notice)} findings=${JSON.stringify(kinds)}`);
  }
  if (fail.length) { console.error(`\nFAIL ${fail.length}\n- ${fail.join("\n- ")}`); process.exit(1); }
  console.log(`\n${tag}: PASS → ${outDir}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
