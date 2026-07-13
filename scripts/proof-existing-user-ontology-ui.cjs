#!/usr/bin/env node
"use strict";

// Read-only proof against a consistent copy of the user's existing Desktop DB.
// It emits only count/status UI screenshots; Memory and candidate text are not
// captured, printed or copied into the repository.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const sourceDb = process.env.AGENTLAS_EXISTING_USER_DB?.trim()
  || path.join(os.homedir(), "Library", "Application Support", "Agentlas", "agentlas.sqlite");
const sourceRoutes = path.join(path.dirname(sourceDb), "agent-routes.json");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-existing-ontology-ui-"));
const userData = path.join(tempRoot, "user-data");
const copiedDb = path.join(userData, "agentlas.sqlite");
const output = path.join(root, "output", "playwright", "existing-user-ontology");
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.mkdirSync(output, { recursive: true });

function sqlite(db, sql) {
  return execFileSync("/usr/bin/sqlite3", [db, sql], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
}

async function main() {
  assert.ok(fs.existsSync(sourceDb), "live Desktop DB is missing");
  sqlite(sourceDb, `.backup '${copiedDb.replaceAll("'", "''")}'`);
  fs.chmodSync(copiedDb, 0o600);
  if (fs.existsSync(sourceRoutes)) {
    fs.copyFileSync(sourceRoutes, path.join(userData, "agent-routes.json"));
    fs.chmodSync(path.join(userData, "agent-routes.json"), 0o600);
  }
  const candidateAgentIds = sqlite(copiedDb, `
    SELECT memory.agent_id
      FROM memory_entries AS memory
      JOIN installed_agents AS agent ON agent.id = memory.agent_id
     WHERE memory.agent_id IS NOT NULL
       AND memory.superseded_at IS NULL
       AND COALESCE(agent.visibility, 'visible') <> 'background'
     GROUP BY memory.agent_id
     ORDER BY COUNT(*) DESC, memory.agent_id ASC
     LIMIT 20;
  `).split("\n").filter(Boolean);
  assert.ok(candidateAgentIds.length > 0, "no visible agent-scoped Memory exists in the copied DB");

  const consoleErrors = [];
  const launched = await electron.launch({
    cwd: root,
    args: ["."],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AGENTLAS_E2E: "1",
      AGENTLAS_E2E_AUTH: "1",
      AGENTLAS_QA_USER_DATA_DIR: userData,
      AGENTLAS_STORE_PATH: copiedDb,
      AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
      AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
      AGENTLAS_QA_SKIP_AGENT_MATERIALIZATION: "1",
    },
  });
  try {
    const page = await launched.firstWindow({ timeout: 60_000 });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 30_000 });
    await page.evaluate(() => {
      window.localStorage.setItem("agentlas.onboarded", "1");
      window.localStorage.setItem("agentlas.featureUpdate.ontology-chips-v1.2026-07-13.ack", "existing-user-proof");
    });
    const installedIds = await page.evaluate(async () => (await window.agentlas.team.list()).map((agent) => agent.id));
    const agentId = candidateAgentIds.find((id) => installedIds.includes(id));
    assert.ok(agentId, "no existing-Memory agent is available in the rendered installed-agent roster");
    await page.evaluate((id) => {
      window.location.href = `/library/agents?agentId=${encodeURIComponent(id)}&tab=ontology`;
    }, agentId);
    await page.waitForFunction(() => location.pathname.includes("/library/agents"), null, { timeout: 30_000 });
    const summary = page.getByTestId("experience-ontology-summary");
    try {
      await summary.waitFor({ timeout: 30_000 });
    } catch (error) {
      await page.screenshot({ path: path.join(output, "00-existing-ontology-proof-error.png"), fullPage: false }).catch(() => {});
      throw new Error(`Ontology summary did not render at ${new URL(page.url()).pathname}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const apiSummary = await page.evaluate((id) => window.agentlas.experience.ontologySummary(id), agentId);
    assert.ok(apiSummary.localReceiptCount > 0, "existing Memory did not reach the ontology intake ledger");
    assert.ok(apiSummary.autoIntake.candidateCreated > 0, "no privacy-safe legacy candidate reached the selected agent");
    await page.waitForTimeout(1_200);
    for (let attempt = 0; attempt < 6 && await page.locator('[role="dialog"]').count(); attempt += 1) {
      const dialog = page.locator('[role="dialog"]').first();
      const dismiss = dialog.getByRole("button", {
        name: /튜토리얼 닫기|건너뛰기|업데이트 안내 닫기|닫기|Close tutorial|Skip|Close feature update|Close/i,
      }).first();
      if (await dismiss.count()) {
        // Electron can restore a compact window whose tutorial close control is
        // logically visible but outside the current viewport. Trigger the same
        // DOM click handler so this read-only proof is independent of window size.
        await dismiss.evaluate((button) => button.click());
      }
      else await page.keyboard.press("Escape");
      await page.waitForTimeout(150);
    }
    assert.equal(await page.locator('[role="dialog"]').count(), 0, "an unrelated product dialog obscured the proof surface");
    assert.equal(await page.getByText("시스템 프롬프트 (System Prompt)", { exact: true }).count(), 0);
    assert.ok(await page.getByLabel(/로컬 표시 이름 편집/).count(), "local alias pencil is missing");
    await summary.screenshot({ path: path.join(output, "01-existing-memory-ontology-summary.png") });

    await page.getByRole("button", { name: "활동 및 자체 진화", exact: true }).click();
    const activity = page.getByTestId("agent-learning-activity");
    await activity.waitFor({ timeout: 15_000 });
    await activity.screenshot({ path: path.join(output, "02-existing-learning-activity.png") });

    await page.getByRole("button", { name: "플레이북 & 워크플로우", exact: true }).click();
    const playbook = page.getByTestId("agent-learning-playbook");
    await playbook.waitFor({ timeout: 15_000 });
    await playbook.screenshot({ path: path.join(output, "03-existing-playbook-ledger.png") });

    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(" | ")}`);
    fs.writeFileSync(path.join(output, "proof-report.json"), JSON.stringify({
      ok: true,
      sourceOpenedViaConsistentCopy: true,
      selectedAgentHasExistingMemory: true,
      ontologyCounts: {
        packs: apiSummary.packCount,
        candidates: apiSummary.candidateCount,
        localReceipts: apiSummary.localReceiptCount,
        privacyBlocked: apiSummary.autoIntake.blocked,
        skipped: apiSummary.autoIntake.skipped,
      },
      systemPromptSectionRemoved: true,
      aliasPencilPresent: true,
      privateMemoryOrCandidateTextCaptured: false,
      liveSourceMutated: false,
    }, null, 2) + "\n", "utf8");
    console.log(JSON.stringify({
      ok: true,
      output,
      ontologyCounts: {
        packs: apiSummary.packCount,
        candidates: apiSummary.candidateCount,
        localReceipts: apiSummary.localReceiptCount,
        privacyBlocked: apiSummary.autoIntake.blocked,
        skipped: apiSummary.autoIntake.skipped,
      },
      privateContentEmitted: false,
      liveSourceMutated: false,
    }, null, 2));
  } finally {
    await launched.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
