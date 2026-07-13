#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-startup-idea-"));
const USER_DATA = path.join(TEMP, "user-data");
const FAKE_RUNNER = path.join(TEMP, "studio-runner.cjs");
const IDEA = `QA founder idea ${Date.now()}`;

fs.mkdirSync(USER_DATA, { recursive: true });
fs.writeFileSync(
  FAKE_RUNNER,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const state = path.join(process.cwd(), ".studio-runtime");
const live = path.join(state, "studio-data.json");
const next = path.join(state, "studio-data.next.json");
const doc = JSON.parse(fs.readFileSync(live, "utf8"));
const idea = process.env.QA_STUDIO_IDEA;
doc.name = "QA Startup";
for (const locale of ["en", "ko"]) {
  doc[locale].ideaSpine.oneLiner = idea;
  doc[locale].stages.idea.headline = idea;
  doc[locale].stages.idea.summary = idea;
}
doc._meta = { ...(doc._meta || {}), bump: Number(doc._meta?.bump || 0) + 1 };
fs.writeFileSync(next, JSON.stringify(doc, null, 2));
`,
  { mode: 0o755 },
);

(async () => {
  let app;
  try {
    app = await electron.launch({
      cwd: ROOT,
      args: ["."],
      env: {
        ...process.env,
        NODE_ENV: "production",
        AGENTLAS_QA_USER_DATA_DIR: USER_DATA,
        AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
        STUDIO_RUNNER_CLI: FAKE_RUNNER,
        STUDIO_OPERATOR_LOCAL_FALLBACK: "1",
        QA_STUDIO_IDEA: IDEA,
      },
    });
    const page = await app.firstWindow({ timeout: 60_000 });
    page.setDefaultTimeout(30_000);
    await page.waitForFunction(() => Boolean(window.agentlas));
    await app.evaluate(({ ipcMain }) => {
      process.env.STUDIO_OPERATOR_LOCAL_FALLBACK = "1";
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
    await page.evaluate(async () => {
      localStorage.setItem("agentlas.onboarded", "1");
      localStorage.setItem("agentlas.featureUpdate.ontology-chips-v1.2026-07-13.ack", "qa-suppressed");
      localStorage.setItem("agentlas.locale", "ko");
      await window.agentlas.menu.setLocale("ko");
      window.location.href = "/startup-founder-studio";
    });
    await page.waitForFunction(() => location.pathname === "/startup-founder-studio");
    // GitHub macOS runners boot in English, while local dogfood machines may
    // boot in Korean. The workflow is identical in both locales.
    await page.getByRole("button", { name: /^(새 아이디어|New Idea)$/ }).click();
    await page.getByPlaceholder(/^(창업 아이디어 한 줄|Describe your startup idea in one line)$/).fill(IDEA);
    await page.getByRole("button", { name: /^(시작|Start)$/ }).click();

    const requestPath = path.join(USER_DATA, "startup-studio", ".studio-runtime", "requests.jsonl");
    await poll(async () => {
      if (!fs.existsSync(requestPath)) return false;
      return fs.readFileSync(requestPath, "utf8").split(/\r?\n/).some((line) => {
        if (!line.trim()) return false;
        const row = JSON.parse(line);
        return row.kind === "init" && row.idea === IDEA;
      });
    }, 12_000, "new idea should reach requests.jsonl as kind:init");

    const frame = page.locator("iframe").first();
    await frame.waitFor({ state: "visible" });
    const frameUrl = await frame.getAttribute("src");
    assert.ok(frameUrl, "studio iframe URL should be present after the init request is queued");

    console.log("Startup Founder Studio new-idea UI contract passed");
  } finally {
    if (app) {
      const child = app.process();
      const close = app.close().catch(() => undefined);
      await Promise.race([close, new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    fs.rmSync(TEMP, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function poll(check, timeoutMs, message) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${message}${lastError ? `: ${lastError.message}` : ""}`);
}
