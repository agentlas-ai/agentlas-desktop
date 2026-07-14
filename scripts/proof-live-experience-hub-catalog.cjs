#!/usr/bin/env node
"use strict";

// Read-only proof that the packaged Desktop renderer reaches the live public
// Experience Chip catalog through the Electron main process. A temporary
// profile keeps this check separate from the user's installed app and data.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { _electron: electron } = require("playwright");

const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-live-experience-catalog-"));
const userData = path.join(tempRoot, "user-data");
const output = path.join(root, "output", "playwright", "live-experience-hub-catalog");
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.mkdirSync(output, { recursive: true });

async function dismissDialogs(page) {
  for (let attempt = 0; attempt < 8 && await page.locator('[role="dialog"]').count(); attempt += 1) {
    const dialog = page.locator('[role="dialog"]').first();
    const dismiss = dialog.getByRole("button", {
      name: /튜토리얼 닫기|건너뛰기|업데이트 안내 닫기|닫기|Close tutorial|Skip|Close feature update|Close/i,
    }).first();
    if (await dismiss.count()) await dismiss.evaluate((button) => button.click());
    else await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
}

async function main() {
  const consoleErrors = [];
  const app = await electron.launch({
    cwd: root,
    args: ["."],
    env: {
      ...process.env,
      NODE_ENV: "production",
      AGENTLAS_E2E: "1",
      AGENTLAS_E2E_AUTH: "1",
      AGENTLAS_QA_USER_DATA_DIR: userData,
      AGENTLAS_ALLOW_MULTI_INSTANCE: "1",
      AGENTLAS_DISABLE_RUNTIME_PROBES: "1",
      AGENTLAS_QA_SKIP_AGENT_MATERIALIZATION: "1",
    },
  });

  try {
    const page = await app.firstWindow({ timeout: 60_000 });
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    await page.waitForFunction(() => Boolean(window.agentlas), null, { timeout: 30_000 });
    await page.evaluate(() => {
      window.localStorage.setItem("agentlas.onboarded", "1");
      window.localStorage.setItem("agentlas.locale", "ko");
      window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "live-catalog-proof");
      window.location.href = "/marketplace?view=experience";
    });
    await page.waitForFunction(() => location.pathname.includes("/marketplace"), null, { timeout: 30_000 });
    await dismissDialogs(page);

    const catalog = page.getByTestId("experience-hub-catalog");
    await catalog.waitFor({ timeout: 30_000 });
    await catalog.getByText(/현재 공개 판매 중인 경험칩이 없습니다|좋아지는 점과 가격 보기|No Experience Chips are publicly on sale|See benefits and price/).first().waitFor({ timeout: 30_000 });
    await dismissDialogs(page);
    assert.equal(await page.locator('[role="dialog"]').count(), 0, "an unrelated dialog obscured the live catalog proof");

    const body = await catalog.innerText();
    assert.doesNotMatch(body, /목록을 불러오지 못했습니다|temporarily unavailable|다시 확인|Retry/i, "Desktop could not read the live public catalog");
    assert.doesNotMatch(body, /agent-definition-|agent-release-|\/Users\/|ghp_|sk-(?:proj-)?/i, "catalog UI exposed an internal identifier, path, or credential");
    const cardCount = await catalog.getByRole("button", { name: /좋아지는 점과 가격 보기|See benefits and price/ }).count();
    const status = cardCount > 0 ? "ready" : "empty";

    await page.screenshot({
      path: path.join(output, "01-live-public-catalog.png"),
      fullPage: false,
    });
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(" | ")}`);

    const report = {
      ok: true,
      status,
      publicCardCount: cardCount,
      publicCatalogReachedFromDesktopMainProcess: true,
      internalIdentifiersExposed: false,
      temporaryProfileUsed: true,
      userDataMutated: false,
    };
    fs.writeFileSync(path.join(output, "proof-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ...report, output }, null, 2));
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
