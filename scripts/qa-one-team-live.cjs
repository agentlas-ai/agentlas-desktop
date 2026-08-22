#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "output", "playwright", "one-team-live");
const baseUrl = process.env.AGENTLAS_ONE_QA_URL || "http://127.0.0.1:3100";

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-team-live-"));
  const historyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-history-live-"));
  fs.mkdirSync(path.join(historyRoot, "6h"), { recursive: true, mode: 0o700 });
  const historyFixture = (stamp) => [
    "---",
    "title: Repeated Agent Build Flow",
    `occurredAt: ${stamp}`,
    "apps: com.openai.codex, com.github.Electron",
    "---",
    "",
    "Repeated work observed in /home/operator/private/project. token=sk-test-should-redact",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(historyRoot, "6h", "2026-08-20T08-00-00-a-6h-first.md"), historyFixture("2026-08-20T08:00:00.000Z"), { mode: 0o600 });
  fs.writeFileSync(path.join(historyRoot, "6h", "2026-08-20T14-00-00-b-6h-second.md"), historyFixture("2026-08-20T14:00:00.000Z"), { mode: 0o600 });
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  let desktop;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${userData}`],
      cwd: root,
      env: {
        ...process.env,
        AGENTLAS_E2E: "1",
        AGENTLAS_E2E_AUTH: "1",
        NODE_ENV: "development",
        // The main process first paints a startup placeholder and only then
        // loads ELECTRON_START_URL.  Point it at the dev server so the QA
        // navigation cannot race that second load and detach the frame.
        ELECTRON_START_URL: baseUrl,
        AGENTLAS_COMPUTER_HISTORY_ROOT: historyRoot,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
      },
      timeout: 30_000,
    });
    const page = await desktop.firstWindow({ timeout: 30_000 });
    page.on("console", (message) => console.error(`[one-team-qa console:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[one-team-qa pageerror] ${error.message}`));
    page.on("requestfailed", (request) => console.error(`[one-team-qa requestfailed] ${request.url()} ${request.failure()?.errorText || ""}`));
    await page.addInitScript(() => window.localStorage.setItem("agentlas.locale", "ko"));
    await page.waitForURL((url) => url.origin === new URL(baseUrl).origin, { timeout: 60_000 }).catch(() => undefined);
    if (!page.url().startsWith(`${baseUrl}/one`)) {
      await page.goto(`${baseUrl}/one`, { waitUntil: "domcontentloaded" });
    }
    await page.getByRole("button", { name: /Open sidebar|사이드바 열기/ }).click().catch(() => undefined);
    for (const label of ["소개 건너뛰기", "Skip introduction", "나중에", "건너뛰기"]) {
      const button = page.getByRole("button", { name: label, exact: false }).first();
      if (await button.count()) {
        await button.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
        await button.click({ force: true }).catch(() => undefined);
      }
    }
    await page.waitForTimeout(250);
    // First-use activation is an unrelated onboarding gate. Resolve it via
    // its Main-owned contract so the assertion below exercises the Team home,
    // not the activation copy or a brittle click timing.
    await page.evaluate(async () => {
      const api = window.agentlas;
      const state = await api.oneActivation.getState({ platform: "desktop", locale: "ko" }).catch(() => null);
      if (state?.status === "active") await api.oneActivation.skip({ expectedStoreVersion: state.version, confirmedByUser: true });
    });
    await page.waitForTimeout(400);
    try {
      await page.getByText("조직도", { exact: true }).waitFor({ timeout: 30_000 });
    } catch (error) {
      const body = await page.locator("body").innerText().catch(() => "");
      await page.screenshot({ path: path.join(outDir, "one-team-shell-failure.png"), fullPage: true }).catch(() => undefined);
      throw new Error(`One Team org chart did not render at ${page.url()}: ${body.slice(0, 2_000)}`, { cause: error });
    }
    const bridge = await page.evaluate(async () => {
      const [org, history] = await Promise.all([
        window.agentlas.oneOrg.get(),
        window.agentlas.computerHistory.get(),
      ]);
      return { org, history };
    });
    assert.equal(bridge.org.schemaVersion, 1);
    assert.equal(bridge.history.schemaVersion, 1);
    assert.equal(bridge.history.consent, "off");
    const before = await page.locator("body").innerText();
    assert.match(before, /Computer History가 꺼져 있어요/);
    assert.match(before, /ONE TEAM/);
    await page.screenshot({ path: path.join(outDir, "one-team-shell.png"), fullPage: true });

    // The addendum's second proof is the live Work shell: the org rail must
    // stay present while the conversation and evidence rail occupy their own
    // columns. Create an empty conversation through the same API used by One
    // (no fake DOM state), then assert the actual grid geometry.
    const activeChat = await page.evaluate(async () => window.agentlas.chats.create({
      title: "One Team active shell proof",
      taskMode: "conversation",
      originSurface: "one",
    }));
    await page.goto(`${baseUrl}/one?chat=${encodeURIComponent(activeChat.id)}`, { waitUntil: "domcontentloaded" });
    await page.getByText("조직도", { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-task-active]')?.getAttribute("data-task-active") === "true", null, { timeout: 30_000 });
    const panelToggle = page.getByRole("button", { name: /출력 패널 열기|Open output panel/ }).first();
    if (await panelToggle.count()) await panelToggle.click();
    await page.waitForFunction(() => document.querySelector('[data-task-active="true"]')?.getAttribute("data-context-rail") === "true", null, { timeout: 30_000 }).catch(async (error) => {
      const diagnostic = await page.locator('[data-task-active]').first().evaluate((element) => ({
        url: location.href,
        active: element.getAttribute("data-task-active"),
        contextRail: element.getAttribute("data-context-rail"),
        text: document.body.innerText.slice(0, 600),
      })).catch(() => ({ url: page.url() }));
      throw new Error(`active One evidence rail did not open: ${JSON.stringify(diagnostic)}`, { cause: error });
    });
    const activeGrid = await page.locator('[data-task-active="true"]').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        columns: style.gridTemplateColumns,
        childColumns: Array.from(element.children).map((child) => getComputedStyle(child).gridColumn),
      };
    });
    const columns = activeGrid.columns.split(/\s+/).filter(Boolean);
    assert.ok(columns.length >= 3, `active One shell must have 3 grid tracks: ${activeGrid.columns}`);
    await page.screenshot({ path: path.join(outDir, "one-team-active-shell.png"), fullPage: true });
    const historyAfter = await page.evaluate(async () => window.agentlas.computerHistory.setConsent(true));
    assert.equal(historyAfter.consent, "on");
    assert.ok(historyAfter.entries.some((entry) => entry.title === "Repeated Agent Build Flow"));
    assert.ok(historyAfter.entries.some((entry) => entry.recommendation?.status === "draft"));
    assert.doesNotMatch(JSON.stringify(historyAfter), /sk-test-should-redact|\/Users\/mason\/private/);
    await page.evaluate(async () => { await window.agentlas.computerHistory.clear(); });
    assert.equal(fs.readdirSync(path.join(historyRoot, "6h")).length, 0, "clear must remove local summary files");
    console.log(JSON.stringify({ ok: true, orgMembers: bridge.org.members.length, consentBefore: bridge.history.consent, historyRedacted: true, recommendation: true, activeGrid: activeGrid.columns, screenshots: [path.join(outDir, "one-team-shell.png"), path.join(outDir, "one-team-active-shell.png")] }));
  } finally {
    await desktop?.close().catch(() => undefined);
    fs.rmSync(userData, { recursive: true, force: true });
    fs.rmSync(historyRoot, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
