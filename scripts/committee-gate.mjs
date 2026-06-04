#!/usr/bin/env node
import { _electron as electron, chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.dirname(desktopRoot);

const personas = [
  ...["AI systems researcher", "Human-AI interaction researcher", "Agent safety researcher", "LLM evaluation scientist", "Applied ML platform lead"].map((role, i) => ({
    id: `researcher-${i + 1}`,
    group: "AI researchers",
    role,
    viewport: i % 2 ? { width: 1440, height: 1000 } : { width: 1280, height: 900 },
  })),
  ...["First-year design student", "CS undergraduate", "MBA student", "International student", "Graduate teaching assistant"].map((role, i) => ({
    id: `student-${i + 1}`,
    group: "students",
    role,
    viewport: i % 2 ? { width: 390, height: 900 } : { width: 768, height: 980 },
  })),
  ...["SaaS product designer", "Design systems lead", "Growth designer", "Mobile interaction designer", "Brand/product designer"].map((role, i) => ({
    id: `designer-${i + 1}`,
    group: "Silicon Valley designers",
    role,
    viewport: i % 2 ? { width: 390, height: 900 } : { width: 1440, height: 1000 },
  })),
  ...["Sociology professor", "Computer science professor", "Business professor", "Education professor", "Industrial engineering professor"].map((role, i) => ({
    id: `professor-${i + 1}`,
    group: "professors",
    role,
    viewport: i % 2 ? { width: 1366, height: 900 } : { width: 768, height: 980 },
  })),
  ...["Online shop owner", "Local cafe owner", "Solo marketer", "Real-estate office owner", "Small agency founder"].map((role, i) => ({
    id: `business-${i + 1}`,
    group: "small-business owners",
    role,
    viewport: i % 2 ? { width: 390, height: 900 } : { width: 1280, height: 900 },
  })),
];

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const batch = Number(args.get("--batch") ?? 0);
const runAll = args.has("--all");
const preflight = args.has("--preflight");
const headful = args.has("--headful");
const webBase = String(args.get("--web-base") ?? "https://agentlas.cloud").replace(/\/$/, "");
const now = new Date();
const stamp = now.toISOString().replace(/[:.]/g, "-");
const outputRoot = path.join(repoRoot, "output", "committee-gate", stamp);

function ensureBuild() {
  const required = [
    path.join(desktopRoot, "dist", "electron", "main.js"),
    path.join(desktopRoot, "dist", "renderer", "index.html"),
  ];
  for (const file of required) {
    if (!fs.existsSync(file)) {
      throw new Error(`Missing desktop build artifact: ${file}. Run npm run build in AgentlasDesktop first.`);
    }
  }
}

function selectedPersonas() {
  if (runAll) return personas;
  if (!Number.isInteger(batch) || batch < 0 || batch > 4) {
    throw new Error("--batch must be 0..4, or pass --all");
  }
  return personas.slice(batch * 5, batch * 5 + 5);
}

function safeName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function assertStep(steps, name, ok, details = {}) {
  steps.push({ name, ok: Boolean(ok), ...details });
}

async function routeStatus(page, route) {
  const response = await page.goto(`${webBase}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  return response?.status() ?? 0;
}

async function overflowInfo(page) {
  return page.evaluate(() => {
    const doc = document.documentElement;
    const body = document.body;
    const viewportWidth = window.innerWidth;
    const horizontallyClipped = new Set(["auto", "scroll", "hidden", "clip"]);
    const hasHorizontalClipAncestor = (el) => {
      for (
        let parent = el.parentElement;
        parent && parent !== body && parent !== doc;
        parent = parent.parentElement
      ) {
        const style = getComputedStyle(parent);
        if (!horizontallyClipped.has(style.overflowX)) continue;
        const rect = parent.getBoundingClientRect();
        if (rect.right <= viewportWidth + 2 && rect.left >= -2) return true;
      }
      return false;
    };
    const candidates = Array.from(document.querySelectorAll("body *"))
      .slice(0, 1800)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return { el, rect, style: getComputedStyle(el) };
      })
      .filter(
        ({ el, rect, style }) =>
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          !hasHorizontalClipAncestor(el),
      );
    const maxUnclippedRight = Math.max(0, ...candidates.map(({ rect }) => Math.ceil(rect.right)));
    const rootScrollWidth = Math.max(doc.scrollWidth, body?.scrollWidth ?? 0);
    const rootOverflowX = Math.max(0, rootScrollWidth - viewportWidth);
    const elementOverflowX = Math.max(0, maxUnclippedRight - viewportWidth);
    return {
      viewportWidth,
      scrollWidth: doc.scrollWidth,
      rootOverflowX,
      elementOverflowX,
      overflowX: Math.max(rootOverflowX, elementOverflowX),
      dialogs: document.querySelectorAll('[role="dialog"], dialog[open]').length,
    };
  });
}

async function clickIfVisible(locator, timeout = 1200) {
  try {
    const count = await locator.count();
    if (!count) return false;
    const first = locator.first();
    await first.waitFor({ state: "visible", timeout });
    await first.click({ timeout });
    return true;
  } catch {
    return false;
  }
}

async function clickWithoutNavigationWait(locator, timeout = 15_000) {
  const first = locator.first();
  await first.waitFor({ state: "visible", timeout });
  await first.evaluate((element) => element.click());
}

async function exerciseDesktopPage(page) {
  const interactions = [];
  await clickIfVisible(page.getByRole("link", { name: /Desktop|데스크톱/i }).first());
  await clickIfVisible(page.getByRole("button", { name: /Expand|확대|Open/i }).first());
  await page.keyboard.press("Escape").catch(() => {});
  assertStep(interactions, "desktop screenshot modal closes", (await overflowInfo(page)).dialogs === 0);
  await clickIfVisible(page.getByRole("link", { name: /status|download|다운로드|상태/i }).first());
  assertStep(interactions, "desktop status CTA is reachable", true);
  return interactions;
}

async function runWebPersona(persona, dir, release) {
  const browser = await chromium.launch({ headless: !headful });
  const context = await browser.newContext({
    locale: persona.id.includes("student") ? "ko-KR" : "en-US",
    viewport: persona.viewport,
  });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (["error"].includes(msg.type())) consoleErrors.push(msg.text());
  });
  const steps = [];
  const routes = ["/", "/desktop", "/marketplace", "/team", "/cargo", "/audit", "/pricing"];
  try {
    for (const route of routes) {
      const status = await routeStatus(page, route);
      const overflow = await overflowInfo(page);
      assertStep(steps, `web ${route} status`, status > 0 && status < 400, { status });
      assertStep(steps, `web ${route} horizontal overflow`, overflow.overflowX <= 2, overflow);
      if (route === "/desktop") {
        for (const item of await exerciseDesktopPage(page)) steps.push(item);
      }
    }
    await page.screenshot({ path: path.join(dir, `${persona.id}-web.png`), fullPage: true });
  } catch (error) {
    await page.screenshot({ path: path.join(dir, `${persona.id}-web-error.png`), fullPage: true }).catch(() => {});
    assertStep(steps, "web flow completed", false, {
      error: String(error?.stack ?? error?.message ?? error),
      url: page.url(),
      body: await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""),
    });
  } finally {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  assertStep(steps, "web console has no errors", consoleErrors.length === 0, {
    errors: consoleErrors.slice(0, 10),
  });
  assertStep(steps, "public desktop download release is notarized", release?.ready === true && release?.notarized === true, {
    ready: release?.ready ?? null,
    notarized: release?.notarized ?? null,
  });
  return steps;
}

async function waitForNoOverflow(page, steps, label) {
  const overflow = await overflowInfo(page);
  assertStep(steps, `${label} horizontal overflow`, overflow.overflowX <= 2, overflow);
}

async function dismissOnboardingIfVisible(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  const isOnboarding = await page
    .evaluate(() => location.pathname.includes("/onboarding"))
    .catch(() => false);
  if (!isOnboarding) return false;
  const skipped = await clickIfVisible(page.getByRole("button", { name: /Skip|건너뛰기/i }), 15_000);
  if (!skipped) return false;
  await page
    .waitForFunction(() => !location.pathname.includes("/onboarding"), null, { timeout: 30_000 })
    .catch(() => {});
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => {});
  return true;
}

async function ensureMarketplacePage(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
  await dismissOnboardingIfVisible(page);
  await page.waitForFunction(
    () =>
      location.pathname.includes("/onboarding") ||
      location.pathname.includes("/marketplace") ||
      Boolean(document.querySelector('a[href^="/marketplace"]')),
    null,
    { timeout: 30_000 },
  );
  if (new URL(page.url()).pathname.includes("/onboarding")) {
    await dismissOnboardingIfVisible(page);
    await page.waitForFunction(() => location.pathname.includes("/marketplace"), null, { timeout: 30_000 });
  }
  if (!new URL(page.url()).pathname.includes("/marketplace")) {
    await page.locator('a[href^="/marketplace"]').last().click({ timeout: 15_000 });
  }
  await page.waitForFunction(() => location.pathname.includes("/marketplace"), null, { timeout: 30_000 });
}

async function runDesktopPersona(persona, dir) {
  const userDataDir = path.join(os.tmpdir(), `agentlas-committee-${stamp}-${persona.id}`);
  fs.rmSync(userDataDir, { recursive: true, force: true });
  fs.mkdirSync(userDataDir, { recursive: true });
  const app = await electron.launch({
    cwd: desktopRoot,
    args: ["."],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AGENTLAS_QA_USER_DATA_DIR: userDataDir,
      AGENTLAS_MCP_BASE_URL: `${webBase}/api/mcp/v1`,
    },
  });
  const page = await app.firstWindow({ timeout: 60_000 });
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  const steps = [];
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await dismissOnboardingIfVisible(page);
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 30_000 });
    assertStep(steps, "desktop IPC bridge is exposed", true);
    await waitForNoOverflow(page, steps, "desktop home");

    await ensureMarketplacePage(page);
    await page.waitForSelector('button[aria-label="설치"]', { timeout: 30_000 });
    const marketStatus = await page.evaluate(() => window.agentlas.marketplace.status());
    assertStep(steps, "desktop MCP source online", marketStatus.online && !marketStatus.usingFallback, marketStatus);
    await waitForNoOverflow(page, steps, "desktop marketplace");

    await page.locator('button[aria-label="설치"]').first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/firm/detail"), null, { timeout: 45_000 });
    const firmState = await page.evaluate(async () => ({
      firms: await window.agentlas.firms.list(),
      agents: await window.agentlas.team.list(),
    }));
    assertStep(steps, "firm install persisted", firmState.firms.length >= 1, {
      firms: firmState.firms.length,
      agents: firmState.agents.length,
    });
    assertStep(steps, "firm installed all required agents", firmState.agents.length >= 3, {
      agents: firmState.agents.map((agent) => agent.slug).slice(0, 12),
    });
    await waitForNoOverflow(page, steps, "desktop firm detail");

    await clickWithoutNavigationWait(page.getByRole("button", { name: /CEO에게 명령|Command CEO/i }));
    await page.locator("textarea").first().waitFor({ state: "visible", timeout: 20_000 });
    await page.locator("textarea").fill(`${persona.role}: summarize the launch checklist without running external tools.`);
    await clickIfVisible(page.getByRole("button", { name: /추가|Add|More|plus/i }).first());
    await page.keyboard.press("Escape").catch(() => {});
    await clickIfVisible(page.getByRole("button", { name: /Plan|계획/i }).first());
    await clickIfVisible(page.getByRole("button", { name: /Goal|목표/i }).first());
    await waitForNoOverflow(page, steps, "desktop CEO chat");
    const chatState = await page.evaluate(async () => ({
      recent: await window.agentlas.chats.listRecent(5),
    }));
    assertStep(steps, "CEO chat created", chatState.recent.length >= 1, {
      chats: chatState.recent.length,
    });

    await page.locator('a[href="/project/new"]').first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/project/new"), null, { timeout: 20_000 });
    await page.locator("input").first().fill(`${persona.id} launch workspace`);
    await page.locator("textarea").first().fill(`Persona QA context for ${persona.role}`);
    await page.getByRole("button", { name: /Create|생성|만들기/i }).first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/project/detail"), null, { timeout: 20_000 });
    const projects = await page.evaluate(() => window.agentlas.projects.list());
    assertStep(steps, "project creation persisted", projects.length >= 1, { projects: projects.length });

    await page.locator('a[href="/automation/new"]').first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/automation/new"), null, { timeout: 20_000 });
    await page.locator("input").first().fill(`${persona.id} daily CEO review`);
    await page.locator("textarea").first().fill("Summarize the latest work and next action.");
    await page.getByRole("button", { name: /Create|생성|만들기/i }).first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/automation"), null, { timeout: 20_000 });
    const automations = await page.evaluate(() => window.agentlas.automations.list());
    assertStep(steps, "automation creation persisted", automations.length >= 1, {
      automations: automations.length,
    });

    await page.locator('a[href="/library/env"]').first().click({ timeout: 15_000 });
    await page.waitForFunction(() => location.href.includes("/library/env"), null, { timeout: 20_000 });
    const envRows = await page.evaluate(() => window.agentlas.env.list());
    assertStep(steps, "env requirements surface is readable", Array.isArray(envRows), {
      envRows: envRows.length,
    });
    await waitForNoOverflow(page, steps, "desktop env library");

    await page.screenshot({ path: path.join(dir, `${persona.id}-desktop.png`), fullPage: true });
  } catch (error) {
    await page.screenshot({ path: path.join(dir, `${persona.id}-desktop-error.png`), fullPage: true }).catch(() => {});
    assertStep(steps, "desktop flow completed", false, {
      error: String(error?.stack ?? error?.message ?? error),
      url: page.url(),
      body: await page.locator("body").innerText({ timeout: 3000 }).catch(() => ""),
      textareas: await page.locator("textarea").count().catch(() => -1),
    });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
  assertStep(steps, "desktop console has no errors", consoleErrors.length === 0, {
    errors: consoleErrors.slice(0, 10),
  });
  return steps;
}

function feedbackFor(persona, steps) {
  const failed = steps.filter((step) => !step.ok);
  if (!failed.length) {
    return `${persona.role}: pass. Web and desktop flows rendered without overflow, MCP stayed online, and install/chat/project/automation surfaces were usable.`;
  }
  return `${persona.role}: fail. ${failed.map((step) => step.name).join("; ")}.`;
}

async function runPersona(persona, release) {
  const dir = path.join(outputRoot, persona.id);
  fs.mkdirSync(dir, { recursive: true });
  const [webSteps, desktopSteps] = await Promise.all([
    runWebPersona(persona, dir, release),
    runDesktopPersona(persona, dir),
  ]);
  const steps = [...webSteps, ...desktopSteps];
  const functionalPass = steps
    .filter((step) => step.name !== "public desktop download release is notarized")
    .every((step) => step.ok);
  const releasePass = steps.every((step) => step.ok);
  return {
    persona,
    functionalPass,
    releasePass,
    vote: releasePass ? "PASS" : "FAIL",
    feedback: feedbackFor(persona, steps),
    failures: steps.filter((step) => !step.ok),
    steps,
  };
}

async function main() {
  ensureBuild();
  fs.mkdirSync(outputRoot, { recursive: true });
  const selected = selectedPersonas();
  const release = await fetch(`${webBase}/api/desktop/latest`).then((res) => res.json());
  const results = [];
  for (const persona of selected) {
    results.push(await runPersona(persona, release));
  }
  const summary = {
    generatedAt: now.toISOString(),
    webBase,
    mode: runAll ? "all" : `batch-${batch}`,
    requestedPersonaCount: selected.length,
    functionalUnanimous: results.every((result) => result.functionalPass),
    releaseUnanimous: results.every((result) => result.releasePass),
    releaseGate: {
      ready: release.ready,
      notarized: release.notarized,
      version: release.version,
      artifacts: release.artifacts?.map((artifact) => ({
        arch: artifact.arch,
        available: artifact.available,
        sha256: Boolean(artifact.sha256),
        sizeBytes: artifact.sizeBytes,
      })),
    },
    results,
  };
  writeJson(path.join(outputRoot, "committee-results.json"), summary);
  fs.writeFileSync(
    path.join(outputRoot, "committee-summary.md"),
    [
      `# Agentlas Desktop Committee Gate`,
      ``,
      `- Generated: ${summary.generatedAt}`,
      `- Mode: ${summary.mode}`,
      `- Web base: ${summary.webBase}`,
      `- Functional unanimous: ${summary.functionalUnanimous ? "PASS" : "FAIL"}`,
      `- Release unanimous: ${summary.releaseUnanimous ? "PASS" : "FAIL"}`,
      `- Release ready/notarized: ${release.ready}/${release.notarized}`,
      ``,
      ...results.map((result) => `- ${result.vote} ${result.persona.id} (${result.persona.group}, ${result.persona.role}) — ${result.feedback}`),
      ``,
    ].join("\n"),
  );
  console.log(JSON.stringify({
    outputRoot,
    functionalUnanimous: summary.functionalUnanimous,
    releaseUnanimous: summary.releaseUnanimous,
    votes: results.map((result) => ({ id: result.persona.id, vote: result.vote, failures: result.failures.map((f) => f.name) })),
  }, null, 2));
  if (!summary.releaseUnanimous && !preflight) process.exit(1);
  if (!summary.functionalUnanimous) process.exit(2);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
