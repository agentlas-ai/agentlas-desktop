#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { _electron: electron } = require("playwright");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const profile = process.env.AGENTLAS_ONE_QA_PROFILE
  || "/private/tmp/agentlas-one-beta-postfix.wju3t9";
const artifactRoot = process.env.AGENTLAS_ONE_QA_OUTPUT
  || path.resolve(root, "../docs/artifacts/one-team-demo-2026-08-22/captures/luna-prd-full");
const holdOpen = process.env.AGENTLAS_ONE_QA_HOLD !== "0";
const runFullScenario = process.env.AGENTLAS_ONE_QA_SIDEBAR_ONLY !== "1";
const maxPlanningMs = Number(process.env.AGENTLAS_ONE_QA_PLANNING_TIMEOUT_MS || 1_800_000);
const maxBuildMs = Number(process.env.AGENTLAS_ONE_QA_BUILD_TIMEOUT_MS || 2_400_000);
let scenarioTaskforceId = null;
let initialBrowserUrl = null;

const prompt = [
  "I'd like a map-first app that helps people discover scuba and freediving spots, inspect depth and conditions, and find nearby dive centres, hotels, and restaurants.",
  "Please start with the PRD and plan, let the team review it together, and do not build anything until I approve the revised PRD.",
  "After approval, generate exactly one hero illustration with image generation for the app's landing header — ask me separately for image-generation permission before generating. Then build the app in a fresh blue-depth-atlas-team folder, and verify it inside Agentlas One's built-in Browser result dock rather than an external browser window.",
  "Use an oceanographic atlas visual direction.",
].join(" ");

function progress(stage, detail = {}) {
  process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), stage, ...detail })}\n`);
}

function ensureOutputDirectory() {
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
}

async function capture(page, name) {
  const target = path.join(artifactRoot, name);
  await page.screenshot({ path: target, animations: "disabled" });
  progress("capture", { name, target });
  return target;
}

async function dockPageFor(desktop, timeoutMs = 30_000) {
  return waitUntil("Output Dock window", async () => (
    desktop.windows().find((candidate) => /(?:\/result-dock|agentlas:\/\/app\/result-dock)/.test(candidate.url())) ?? null
  ), timeoutMs, 150);
}

async function outputDockRuntime(desktop) {
  return desktop.evaluate(({ BrowserWindow }) => {
    const dock = BrowserWindow.getAllWindows().find((candidate) => /(?:\/result-dock|agentlas:\/\/app\/result-dock)/.test(candidate.webContents.getURL()));
    if (!dock) return null;
    return {
      url: dock.webContents.getURL(),
      title: dock.getTitle(),
      bounds: dock.getBounds(),
      children: dock.contentView.children.map((view) => ({
        url: view.webContents?.getURL() || "",
        title: view.webContents?.getTitle() || "",
        loading: view.webContents?.isLoading() || false,
        bounds: view.getBounds(),
      })),
    };
  });
}

async function waitForNativeBrowser(desktop, predicate, timeoutMs = 90_000) {
  return waitUntil("native Output Dock browser", async () => {
    const runtime = await outputDockRuntime(desktop);
    const child = runtime?.children.find(predicate) ?? null;
    return child ? { runtime, child } : null;
  }, timeoutMs, 250);
}

async function captureSplit(page, desktop, name) {
  const target = path.join(artifactRoot, name);
  const dockPage = await dockPageFor(desktop);
  const ownerPng = await page.screenshot({ animations: "disabled" });
  let dockPng = await dockPage.screenshot({ animations: "disabled" });
  const native = await desktop.evaluate(async ({ BrowserWindow }) => {
    const dock = BrowserWindow.getAllWindows().find((candidate) => /(?:\/result-dock|agentlas:\/\/app\/result-dock)/.test(candidate.webContents.getURL()));
    const view = dock?.contentView.children[0];
    if (!view || view.webContents.isDestroyed()) return null;
    const image = await view.webContents.capturePage();
    return { bounds: view.getBounds(), png: image.toPNG().toString("base64") };
  });
  if (native) {
    const metadata = await sharp(dockPng).metadata();
    const overlay = await sharp(Buffer.from(native.png, "base64"))
      .resize({ width: native.bounds.width, height: native.bounds.height, fit: "fill" })
      .png().toBuffer();
    dockPng = await sharp(dockPng).composite([{
      input: overlay,
      left: Math.max(0, Math.min((metadata.width || 1) - 1, native.bounds.x)),
      top: Math.max(0, Math.min((metadata.height || 1) - 1, native.bounds.y)),
    }]).png().toBuffer();
  }
  const ownerMeta = await sharp(ownerPng).metadata();
  const dockMeta = await sharp(dockPng).metadata();
  const width = (ownerMeta.width || 1) + (dockMeta.width || 1) + 1;
  const height = Math.max(ownerMeta.height || 1, dockMeta.height || 1);
  await sharp({ create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([
      { input: ownerPng, left: 0, top: 0 },
      { input: dockPng, left: (ownerMeta.width || 1) + 1, top: 0 },
    ])
    .png().toFile(target);
  progress("capture", { name, target, split: true });
  return target;
}

async function naturalClick(page, locator, options = {}) {
  await locator.waitFor({ state: "visible", timeout: options.timeout ?? 30_000 });
  const box = await locator.boundingBox();
  if (box) {
    const x = box.x + box.width * (options.xRatio ?? 0.5);
    const y = box.y + box.height * (options.yRatio ?? 0.5);
    await page.mouse.move(x, y, { steps: options.steps ?? 14 });
    await page.waitForTimeout(options.hoverMs ?? 180);
  }
  await locator.click({ timeout: options.timeout ?? 30_000 });
  await page.waitForTimeout(options.afterMs ?? 280);
}

async function naturalType(locator, value, delay = 20) {
  await locator.waitFor({ state: "visible", timeout: 30_000 });
  await locator.click();
  await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await locator.press("Backspace");
  await locator.pressSequentially(value, { delay });
}

async function waitUntil(label, predicate, timeoutMs, intervalMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await predicate();
      if (last) return last;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} timed out after ${timeoutMs}ms; last=${JSON.stringify(last)}`);
}

async function ensureEnglish(page) {
  await page.waitForFunction(() => location.protocol === "agentlas:" && Boolean(window.agentlas), null, { timeout: 120_000 });
  if (!/agentlas:\/\/app\/one(?:\?|$)/.test(page.url())) {
    await page.evaluate(() => { location.href = "agentlas://app/one"; });
    await page.waitForURL(/agentlas:\/\/app\/one(?:\?|$)/, { timeout: 60_000 });
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 60_000 });
  }
  const changed = await page.evaluate(() => {
    const prior = window.localStorage.getItem("agentlas.locale");
    window.localStorage.setItem("agentlas.locale", "en");
    return prior !== "en";
  });
  if (changed) await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.getByText("Taskforces", { exact: true }).waitFor({ timeout: 60_000 });
  } catch (error) {
    progress("one-shell-timeout", {
      url: page.url(),
      body: (await page.locator("body").innerText().catch(() => "")).slice(0, 2_000),
    });
    await capture(page, "00-one-shell-timeout.png").catch(() => undefined);
    throw error;
  }
}

async function openSidebar(page) {
  const body = page.locator("[data-rail-collapsed]").first();
  const collapsed = await body.getAttribute("data-rail-collapsed");
  if (collapsed === "true") {
    const reveal = page.getByRole("button", { name: "Open sidebar" }).first();
    await naturalClick(page, reveal);
  }
  await page.locator('aside[aria-label="One navigation"]').waitFor({ state: "visible", timeout: 30_000 }).catch(() => undefined);
}

async function chooseLuna(page) {
  const modelButton = page.getByRole("button", { name: /^Model:/ }).first();
  await naturalClick(page, modelButton, { timeout: 60_000 });
  const modelDialog = page.getByRole("dialog", { name: "One composer settings" });
  const search = modelDialog.getByPlaceholder("Search...");
  await naturalType(search, "gpt-5.6-luna", 30);
  const luna = modelDialog.getByRole("button", { name: /gpt-5\.6-luna/i }).first();
  await naturalClick(page, luna, { timeout: 60_000 });
  await waitUntil("Luna model selection", async () => {
    const label = await modelButton.getAttribute("aria-label");
    return label?.includes("gpt-5.6-luna") ? label : null;
  }, 30_000, 250);

  const effortButton = page.getByRole("button", { name: /^Reasoning effort:/ }).first();
  if (await effortButton.count()) {
    await naturalClick(page, effortButton);
    const effortDialog = page.getByRole("dialog", { name: "One composer settings" });
    const medium = effortDialog.getByRole("button", { name: /^Medium$/ }).first();
    if (await medium.count()) await naturalClick(page, medium);
  }
  progress("luna-selected", { label: await modelButton.getAttribute("aria-label") });
}

async function ensureFullAccess(page) {
  const permissionButton = page.getByRole("button", { name: /^Permission:/ }).first();
  const label = await permissionButton.getAttribute("aria-label");
  if (label?.includes("Full access")) return;
  await naturalClick(page, permissionButton);
  await naturalClick(page, page.getByRole("dialog", { name: "One composer settings" }).getByRole("button", { name: /Full access/ }).first());
}

async function openTaskforceByName(page, title) {
  await openSidebar(page);
  const taskforceProbe = await page.evaluate(async () => {
    try {
      return { rows: await window.agentlas.oneTaskforces.list(), error: null };
    } catch (error) {
      return { rows: [], error: error instanceof Error ? error.message : String(error) };
    }
  });
  progress("taskforce-probe", {
    titles: taskforceProbe.rows.map((row) => row.title),
    error: taskforceProbe.error,
  });
  const rows = page.locator('section[aria-label="Taskforces"] button').filter({ hasText: title });
  assert.ok(await rows.count(), `Taskforce not found: ${title}`);
  await naturalClick(page, rows.last());
  await page.getByRole("heading", { name: title }).waitFor({ timeout: 30_000 }).catch(async () => {
    await page.getByText(title, { exact: true }).last().waitFor({ timeout: 30_000 });
  });
}

async function proveSidebarBrowser(page, desktop) {
  void desktop;
  await openTaskforceByName(page, "Dive Atlas App Team");
  const root = page.getByRole("complementary", { name: "Work outputs" });
  await root.waitFor({ state: "visible", timeout: 90_000 });
  const browserView = root.getByRole("tab", { name: "Browser", exact: true });
  await waitUntil("automatic inline Browser presentation", async () => (
    await browserView.getAttribute("aria-selected") === "true" ? true : null
  ), 90_000, 250);
  const address = root.getByRole("textbox", { name: "Address" });
  const addressValue = await waitUntil("Browser address", async () => {
    const value = await address.inputValue().catch(() => "");
    return /^https?:\/\//.test(value) ? value : null;
  }, 90_000, 250);
  assert.match(page.url(), /\/one(?:\?|$)/, "Browser output must not navigate One away from chat");
  const outputBox = await root.boundingBox();
  assert.ok(outputBox && outputBox.width >= 600, `Inline Browser rail did not open at a readable width: ${JSON.stringify(outputBox)}`);
  initialBrowserUrl = addressValue;
  progress("browser-shell-ready", { width: Math.round(outputBox.width), url: addressValue });
  const browserTabs = root.getByRole("tablist", { name: "Browser tabs" });
  const tabCountBefore = await browserTabs.getByRole("tab").count();
  await naturalClick(page, root.getByRole("button", { name: "New tab" }));
  await browserTabs.getByRole("tab", { name: "New tab" }).waitFor({ state: "visible", timeout: 30_000 });
  assert.equal(await browserTabs.getByRole("tab").count(), tabCountBefore + 1, "New browser tab was not created inside One");
  progress("browser-new-tab-created");
  await naturalClick(page, root.getByRole("button", { name: "Close New tab tab" }));
  await page.waitForFunction((count) => document.querySelector('[aria-label="Browser tabs"]')?.querySelectorAll('[role="tab"]').length === count, tabCountBefore, { timeout: 30_000 });
  await address.waitFor({ state: "visible", timeout: 30_000 });
  progress("browser-after-tab-close", {
    tabs: await browserTabs.getByRole("tab").allTextContents(),
    address: await address.inputValue().catch(() => ""),
    copy: (await root.innerText()).slice(0, 500),
  });
  await capture(page, "00-after-browser-tab-close.png");
  progress("browser-original-tab-restored");
  await naturalClick(page, root.getByRole("button", { name: "Browser menu" }));
  await root.getByRole("menuitem", { name: "Copy address" }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "00a-sidebar-browser-menu.png");
  await naturalClick(page, root.getByRole("button", { name: "Browser menu" }));
  await capture(page, "00-sidebar-browser-current.png");
  progress("sidebar-browser-proved", {
    url: await address.inputValue(),
    width: Math.round(outputBox.width),
  });
}

async function createTaskforce(page) {
  await openSidebar(page);
  const beforeIds = await page.evaluate(async () => (
    (await window.agentlas.oneTaskforces.list()).map((row) => row.id)
  ));
  await naturalClick(page, page.getByRole("button", { name: "Create Taskforce" }).first());
  const dialog = page.getByRole("dialog", { name: "Create Taskforce" });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "01-create-taskforce-empty.png");
  await naturalType(dialog.getByLabel("Name"), "App Development Department", 45);
  await naturalType(
    dialog.getByLabel("Description"),
    "Plans and builds map-first consumer apps. One coordinates product planning, technical review, visual design, and implementation.",
    18,
  );
  await capture(page, "02-create-taskforce-description.png");
  await naturalClick(page, dialog.getByRole("button", { name: "Create", exact: true }));
  await dialog.waitFor({ state: "hidden", timeout: 60_000 });
  await page.getByText("App Development Department", { exact: true }).last().waitFor({ timeout: 60_000 });
  const created = await waitUntil("new Taskforce identity", async () => page.evaluate(async (existingIds) => {
    const rows = await window.agentlas.oneTaskforces.list();
    return rows.find((row) => row.title === "App Development Department" && !existingIds.includes(row.id)) ?? null;
  }, beforeIds), 60_000, 250);
  scenarioTaskforceId = created.id;
  progress("taskforce-created", { taskforceId: created.id, chatId: created.chatId });
}

async function addTaskforceMembers(page) {
  await naturalClick(page, page.getByRole("button", { name: "Manage Taskforce members" }));
  const dialog = page.getByRole("dialog", { name: "Taskforce members" });
  await dialog.waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "03-add-members-before.png");

  const memberNames = await page.evaluate(async () => {
    const state = await window.agentlas.oneOrg.get();
    return state.members.map((member) => member.displayName);
  });
  const wantedPatterns = [
    /product[ -]?planner/i,
    /app builder/i,
    /frontend designer/i,
  ];
  const selected = [];
  for (const pattern of wantedPatterns) {
    const matchingName = memberNames.find((name) => pattern.test(name));
    assert.ok(matchingName, `Required Taskforce member missing for ${pattern}: ${memberNames.join(", ")}`);
    const row = dialog.getByRole("button", { name: new RegExp(matchingName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first();
    if ((await row.getAttribute("aria-pressed")) !== "true") await naturalClick(page, row);
    selected.push(matchingName);
  }
  await capture(page, "04-add-members-selected.png");
  await naturalClick(page, dialog.getByRole("button", { name: "Save", exact: true }));
  await dialog.waitFor({ state: "hidden", timeout: 60_000 });
  await waitUntil("four-member Taskforce", async () => {
    const label = await page.getByRole("button", { name: "Manage Taskforce members" }).innerText();
    return label.trim() === "4" ? label : null;
  }, 30_000, 250);
  progress("members-added", { members: selected });
  return selected;
}

async function sendPrompt(page) {
  await chooseLuna(page);
  await ensureFullAccess(page);
  const composer = page.getByRole("textbox", { name: "Request for App Development Department" });
  await naturalType(composer, prompt, 12);
  await capture(page, "05-natural-prompt-typed.png");
  await composer.press("Enter");
  await page.waitForTimeout(800);
  await capture(page, "06-prompt-sent.png");
  progress("prompt-sent", { prompt });
}

async function taskforceSnapshot(page) {
  assert.ok(scenarioTaskforceId, "Scenario Taskforce identity was not captured after creation");
  return page.evaluate(async (targetTaskforceId) => {
    const active = await window.agentlas.invoke.activeChats();
    const rows = await window.agentlas.oneTaskforces.list();
    const taskforce = rows.find((row) => row.id === targetTaskforceId) ?? null;
    const history = taskforce ? await window.agentlas.invoke.history(taskforce.chatId) : [];
    const receipt = taskforce ? await window.agentlas.invoke.latestReceipt(taskforce.chatId) : null;
    const timeline = taskforce
      ? await window.agentlas.runLedger.chatTimeline(taskforce.chatId, { maxRuns: 12, eventsPerRun: 500 })
      : [];
    return {
      taskforce,
      active,
      receipt,
      timeline,
      history: history.map((message) => ({ role: message.role, text: message.text.slice(0, 1_000) })),
      url: location.href,
    };
  }, scenarioTaskforceId);
}

async function waitForPlanningGate(page) {
  let capturedDelegation = false;
  let capturedThread = false;
  let capturedPrd = false;
  let lastReportAt = 0;
  const gate = await waitUntil("reviewed PRD approval gate", async () => {
    const conversation = page.locator('[role="list"][aria-label="Taskforce conversation"]');
    const messageCount = await conversation.locator('[data-one-taskforce-message="true"]').count().catch(() => 0);
    const threadedCount = await conversation.locator('[data-threaded="true"]').count().catch(() => 0);
    const conversationText = await conversation.innerText().catch(() => "");
    // The output rail is persistent across Taskforces, so an older PRD there
    // must not satisfy this run's gate. Only the current room conversation is
    // valid evidence that this Taskforce rendered its reviewed plan.
    const prdVisible = /(?:\.md\b|\bPRD\b|product requirements)/i.test(conversationText);
    if (!capturedDelegation && messageCount >= 2) {
      capturedDelegation = true;
      await capture(page, "07-one-delegates-planning.png");
    }
    if (!capturedThread && threadedCount >= 1) {
      capturedThread = true;
      await capture(page, "08-buzz-threaded-review.png");
    }
    if (!capturedPrd && prdVisible) {
      capturedPrd = true;
      await capture(page, "09-prd-rendered-and-bound.png");
    }
    const decision = page.getByTestId("one-decision-inline").first();
    if (await decision.isVisible().catch(() => false)) {
      const text = await decision.innerText();
      if (/PRD|plan|requirements|specification|review/i.test(text)) {
        const snapshot = await taskforceSnapshot(page);
        return {
          decisionText: text,
          messageCount,
          threadedCount,
          prdVisible,
          runId: snapshot.receipt?.runId ?? null,
          runStartedAt: snapshot.receipt?.startedAt ?? null,
        };
      }
    }
    if (Date.now() - lastReportAt > 20_000) {
      lastReportAt = Date.now();
      const snapshot = await taskforceSnapshot(page).catch(() => null);
      progress("planning-wait", {
        messageCount,
        threadedCount,
        prdVisible,
        receiptStatus: snapshot?.receipt?.status ?? null,
        active: snapshot?.active?.length ?? null,
      });
    }
    return null;
  }, maxPlanningMs, 1_500);
  await capture(page, "10-prd-approval-strip.png");
  progress("prd-approval-ready", gate);
  return gate;
}

async function answerVisibleDecision(page, purpose) {
  const decision = page.getByTestId("one-decision-inline").first();
  await decision.waitFor({ state: "visible", timeout: 120_000 });
  const text = await decision.innerText();
  const choiceButtons = decision.locator('button[aria-pressed]');
  if (await choiceButtons.count()) {
    const preferred = choiceButtons.filter({ hasText: /approve|continue|proceed|yes|oceanographic|build|use image/i }).first();
    await naturalClick(page, await preferred.count() ? preferred : choiceButtons.first());
  }
  const direct = decision.getByRole("button", { name: /approve|continue|proceed|yes|oceanographic|build|use image/i }).filter({ hasNotText: /always/i }).last();
  if (await direct.count()) {
    await naturalClick(page, direct);
  } else {
    const candidates = decision.getByRole("button").filter({ hasNotText: /reject|deny|remind|close|always/i });
    assert.ok(await candidates.count(), `No positive decision action for ${purpose}: ${text}`);
    await naturalClick(page, candidates.last());
  }
  await decision.waitFor({ state: "hidden", timeout: 120_000 }).catch(() => undefined);
  progress("decision-answered", { purpose, text: text.slice(0, 600) });
}

async function waitForImagePermission(page) {
  let lastReportAt = 0;
  return waitUntil("image-generation permission", async () => {
    const tool = page.getByTestId("tool-approval-inline").first();
    if (await tool.isVisible().catch(() => false)) {
      const text = await tool.innerText();
      if (/image|imagen|dall|flux/i.test(text)) return { kind: "tool", text };
    }
    const decision = page.getByTestId("one-decision-inline").first();
    if (await decision.isVisible().catch(() => false)) {
      const text = await decision.innerText();
      if (/image|visual|illustration|generate/i.test(text)) return { kind: "decision", text };
      // Some runtimes ask a harmless visual direction gate first. The prompt
      // already states Oceanographic Atlas, so preserve the human flow by
      // answering that explicit choice and continue waiting for image consent.
      if (/oceanographic|direction|style/i.test(text)) {
        await capture(page, "11a-visual-direction-strip.png");
        await answerVisibleDecision(page, "visual direction");
      }
    }
    if (Date.now() - lastReportAt > 20_000) {
      lastReportAt = Date.now();
      const snapshot = await taskforceSnapshot(page).catch(() => null);
      progress("image-permission-wait", {
        receiptStatus: snapshot?.receipt?.status ?? null,
        active: snapshot?.active?.length ?? null,
      });
      // 모델이 이미지 생성을 쓰지 않기로 하고 빌드까지 끝냈다면 그것도 유효한 완주다.
      // 없는 스트립을 30분 기다리지 말고, 스킵을 명시적으로 기록하고 다음 단계로 간다.
      if (snapshot?.receipt?.status === "completed" && (snapshot?.active?.length ?? 0) === 0) {
        const builtDir = path.join(profile, "agent-cwd", "blue-depth-atlas-team");
        const transcript = await page.evaluate(() => document.body.innerText).catch(() => "");
        if (fs.existsSync(builtDir) && /image generation was not used/i.test(transcript)) {
          return { kind: "skipped", reason: "model built without image generation and said so" };
        }
      }
    }
    return null;
  }, maxPlanningMs, 1_500);
}

async function answerImagePermission(page, permission) {
  if (permission.kind === "skipped") {
    progress("imagegen-not-requested", permission);
    return;
  }
  await capture(page, "11-imagegen-permission-strip.png");
  if (permission.kind === "tool") {
    const tool = page.getByTestId("tool-approval-inline").first();
    await naturalClick(page, tool.getByRole("button", { name: /Allow once|For this task/ }).last());
  } else {
    await answerVisibleDecision(page, "image generation");
  }
  progress("image-permission-answered", permission);
}

function buildEvidenceAfterPlanning(snapshot, planningRunId) {
  const laterRuns = snapshot.timeline.filter((entry) => entry.receipt.runId !== planningRunId);
  const events = laterRuns.flatMap((entry) => entry.events);
  const payloadText = (event) => JSON.stringify(event.payload ?? {});
  const hasWorkspaceMutation = events.some((event) => {
    const toolName = String(event.payload?.toolName ?? "").toLowerCase();
    const payload = payloadText(event).toLowerCase();
    return toolName === "apply_patch"
      || /(?:^|\b)(?:write|edit|write_file|replace)(?:\b|$)/.test(toolName)
      || (toolName === "bash" && /npm run build|pnpm build|yarn build|vite build/.test(payload));
  });
  const hasBuiltInBrowserCall = events.some((event) => {
    const toolName = String(event.payload?.toolName ?? "").toLowerCase();
    const payload = payloadText(event).toLowerCase();
    return toolName.includes("browser")
      || /browser:(?:navigate|snapshot|take_screenshot|resize)/.test(payload);
  });
  return { laterRuns, hasWorkspaceMutation, hasBuiltInBrowserCall };
}

async function waitForBuiltBrowser(page, desktop, planningGate) {
  void desktop;
  let capturedBuild = false;
  let lastReportAt = 0;
  const result = await waitUntil("built app in One inline Browser", async () => {
    const root = page.getByRole("complementary", { name: "Work outputs" });
    const browserSelected = Boolean(
      await root.isVisible().catch(() => false)
      && await root.getByRole("tab", { name: "Browser", exact: true }).getAttribute("aria-selected").catch(() => null) === "true"
    );
    const currentAddress = browserSelected
      ? await root.getByRole("textbox", { name: "Address" }).inputValue().catch(() => "")
      : "";
    const liveVisible = browserSelected
      && await root.getByRole("application", { name: "Live browser. Click, scroll, and type here" }).isVisible().catch(() => false);
    const messageCount = await page.locator('[data-one-taskforce-message="true"]').count();
    if (!capturedBuild && messageCount >= 6) {
      capturedBuild = true;
      await capture(page, "12-team-building-in-chat.png");
    }
    const snapshot = await taskforceSnapshot(page);
    const evidence = buildEvidenceAfterPlanning(snapshot, planningGate.runId);
    const browserChanged = Boolean(currentAddress && (!initialBrowserUrl || currentAddress !== initialBrowserUrl));
    if (
      browserSelected
      && liveVisible
      && browserChanged
      && evidence.hasWorkspaceMutation
      && evidence.hasBuiltInBrowserCall
    ) {
      return { snapshot, browserSelected, liveVisible, currentAddress, ...evidence };
    }
    if (Date.now() - lastReportAt > 20_000) {
      lastReportAt = Date.now();
      progress("build-wait", {
        browserSelected,
        liveVisible,
        browserChanged,
        currentAddress,
        hasWorkspaceMutation: evidence.hasWorkspaceMutation,
        hasBuiltInBrowserCall: evidence.hasBuiltInBrowserCall,
        messageCount,
        receiptStatus: snapshot?.receipt?.status ?? null,
        active: snapshot?.active?.length ?? null,
      });
    }
    return null;
  }, maxBuildMs, 1_500);
  await capture(page, "13-built-app-browser-web.png");
  const root = page.getByRole("complementary", { name: "Work outputs" });
  await naturalClick(page, root.getByRole("button", { name: "Browser menu" }));
  await root.getByRole("menuitem", { name: "Copy address" }).waitFor({ state: "visible", timeout: 30_000 });
  await capture(page, "14-built-app-browser-menu.png");
  await naturalClick(page, root.getByRole("button", { name: "Browser menu" }));
  progress("built-browser-proved", {
    receipt: result.snapshot.receipt,
    address: result.currentAddress,
    runCountAfterPlanning: result.laterRuns.length,
  });
  return result;
}

async function refineThroughChat(page, desktop) {
  void desktop;
  const composer = page.getByRole("textbox", { name: "Request for App Development Department" });
  const refinement = "This is close. Please make the map controls easier to scan, tighten the place cards, and keep the oceanographic atlas feel. Then verify the desktop and phone views again.";
  await naturalType(composer, refinement, 12);
  await capture(page, "15-refinement-typed.png");
  await composer.press("Enter");
  const initial = await taskforceSnapshot(page);
  const initialRunId = initial.receipt?.runId ?? null;
  const finished = await waitUntil("chat refinement completion", async () => {
    const snapshot = await taskforceSnapshot(page);
    if (
      snapshot.receipt?.runId
      && snapshot.receipt.runId !== initialRunId
      && ["completed", "failed", "cancelled", "interrupted"].includes(snapshot.receipt.status)
    ) return snapshot;
    return null;
  }, maxBuildMs, 2_000);
  assert.equal(finished.receipt.status, "completed", `Refinement failed: ${JSON.stringify(finished.receipt)}`);
  const root = page.getByRole("complementary", { name: "Work outputs" });
  await root.getByRole("tab", { name: "Browser", exact: true }).waitFor({ state: "visible", timeout: 120_000 });
  await root.getByRole("textbox", { name: "Address" }).waitFor({ state: "visible", timeout: 120_000 });
  await capture(page, "16-refined-app-browser-web.png");
  progress("refinement-complete", { receipt: finished.receipt });
}

async function main() {
  ensureOutputDirectory();
  let desktop = null;
  let recorder = null;
  let completed = false;
  try {
    desktop = await electron.launch({
      args: [root, `--user-data-dir=${profile}`],
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "production",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        AGENTLAS_CDP_HEADLESS: "1",
        // Source QA must use the install-identity override validated before
        // protected storage opens. Chromium's --user-data-dir switch is not
        // the Agentlas store contract.
        AGENTLAS_QA_USER_DATA_DIR: profile,
        // Unpackaged Electron intentionally defaults to a per-process empty
        // store. This scenario runs only against the dedicated QA replica.
        AGENTLAS_STORE_PATH: path.join(profile, "agentlas.sqlite"),
      },
      timeout: 60_000,
    });
    const page = await desktop.firstWindow({ timeout: 60_000 });
    const actualUserData = await desktop.evaluate(({ app }) => app.getPath("userData"));
    progress("browser-window-ready", {
      url: page.url(),
      profileMatched: path.resolve(actualUserData) === path.resolve(profile),
    });
    page.on("console", (message) => {
      if (message.type() === "error") process.stderr.write(`[renderer] ${message.text()}\n`);
    });
    page.on("pageerror", (error) => process.stderr.write(`[pageerror] ${error.message}\n`));
    await desktop.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      window?.maximize();
      window?.show();
      window?.focus();
    });
    await ensureEnglish(page);
    await openSidebar(page);
    progress("electron-ready", { url: page.url(), profile });

    if (!runFullScenario) {
      await proveSidebarBrowser(page, desktop);
      completed = true;
      progress("qa-complete", { mode: "sidebar-only" });
      return;
    }

    await page.evaluate(() => window.agentlas.outputDock?.close()).catch(() => undefined);
    await page.waitForTimeout(900);
    initialBrowserUrl = null;
    const moviePath = path.join(artifactRoot, "one-team-luna-prd-raw.mov");
    recorder = spawn("/usr/sbin/screencapture", ["-v", "-C", "-k", "-D1", "-V5400", moviePath], {
      stdio: "ignore",
    });
    progress("recording-started", { moviePath, pid: recorder.pid });

    await createTaskforce(page);
    await addTaskforceMembers(page);
    await sendPrompt(page);
    const planningGate = await waitForPlanningGate(page);
    await answerVisibleDecision(page, "reviewed PRD");
    const imagePermission = await waitForImagePermission(page);
    await answerImagePermission(page, imagePermission);
    await waitForBuiltBrowser(page, desktop, planningGate);
    await refineThroughChat(page, desktop);

    const finalState = await taskforceSnapshot(page);
    assert.equal(finalState.taskforce?.id, scenarioTaskforceId, "QA receipts must belong to the Taskforce created in this run");
    fs.writeFileSync(path.join(artifactRoot, "final-runtime-state.json"), `${JSON.stringify(finalState, null, 2)}\n`, { mode: 0o600 });
    assert.match(finalState.url, /\/one(?:\?|$)/, "The complete flow must stay inside One");
    completed = true;
    progress("qa-complete", {
      mode: "full",
      taskforceId: finalState.taskforce?.id,
      chatId: finalState.taskforce?.chatId,
      runId: finalState.receipt?.runId,
    });
  } finally {
    if (recorder && recorder.exitCode == null) {
      recorder.kill("SIGINT");
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 8_000);
        recorder.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      progress("recording-stopped");
    }
    if (!completed || !holdOpen) {
      await desktop?.close().catch(() => undefined);
    } else {
      progress("holding-electron-open", { pid: desktop?.process()?.pid ?? null });
      await new Promise(() => undefined);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
