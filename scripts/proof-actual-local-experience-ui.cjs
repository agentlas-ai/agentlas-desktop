#!/usr/bin/env node
"use strict";

// Opens a consistent copy of the user's Desktop DB in a separate Electron
// profile. The live DB is never mutated. Screenshots are limited to the
// user-approved buyer copy and upload status; private Memory text is excluded.

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
const packId = process.env.AGENTLAS_EXPERIENCE_PACK_ID?.trim() || "44e985cb-a259-457e-a0c5-a767449f2b20";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-actual-experience-ui-"));
const userData = path.join(tempRoot, "user-data");
const copiedDb = path.join(userData, "agentlas.sqlite");
const output = path.join(root, "output", "playwright", "actual-local-experience");
fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
fs.mkdirSync(output, { recursive: true });

function sqlite(db, sql) {
  return execFileSync("/usr/bin/sqlite3", ["-json", db, sql], { encoding: "utf8", maxBuffer: 1024 * 1024 }).trim();
}

function rows(db, sql) {
  const text = sqlite(db, sql);
  return text ? JSON.parse(text) : [];
}

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
  assert.ok(fs.existsSync(sourceDb), "live Desktop DB is missing");
  execFileSync("/usr/bin/sqlite3", [sourceDb, `.backup '${copiedDb.replaceAll("'", "''")}'`]);
  fs.chmodSync(copiedDb, 0o600);
  if (fs.existsSync(sourceRoutes)) {
    fs.copyFileSync(sourceRoutes, path.join(userData, "agent-routes.json"));
    fs.chmodSync(path.join(userData, "agent-routes.json"), 0o600);
  }

  const packRows = rows(copiedDb, `
    SELECT p.agent_id AS agentId,
           p.name AS packName,
           projection.title AS publicTitle,
           json_array_length(projection.instructions_json) AS benefitCount,
           json_array_length(projection.privacy_issue_codes_json) AS privacyIssueCount,
           projection.status AS projectionStatus
      FROM experience_packs p
      JOIN experience_public_projections projection ON projection.pack_id = p.id
     WHERE p.id = '${packId.replaceAll("'", "''")}'
     LIMIT 1;
  `);
  assert.equal(packRows.length, 1, "target Experience Pack or approved public copy is missing");
  const pack = packRows[0];
  assert.equal(pack.projectionStatus, "confirmed", "buyer copy is not confirmed");
  assert.equal(Number(pack.privacyIssueCount), 0, "buyer copy still has privacy issues");
  assert(Number(pack.benefitCount) > 0, "buyer copy has no benefits");

  const uploadRows = rows(copiedDb, `
    SELECT requested_visibility AS visibility, remote_status AS status,
           COALESCE(remote_error_code, '') AS errorCode,
           remote_receipt_json IS NOT NULL AS hasReceipt
      FROM experience_cloud_uploads
     WHERE pack_id = '${packId.replaceAll("'", "''")}'
     ORDER BY updated_at;
  `);
  assert(uploadRows.some((row) => row.visibility === "private" && row.status === "private-saved" && Number(row.hasReceipt) === 1), "private Hub receipt is missing");
  assert(uploadRows.some((row) => row.visibility === "public" && row.status === "conflict" && row.errorCode === "private_base_visibility_mismatch"), "expected private-base public-listing guard is missing");

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
      AGENTLAS_STORE_PATH: copiedDb,
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
      window.localStorage.setItem("agentlas.featureUpdate.desktop-v0.8.13-ontology-chips.ack", "actual-experience-proof");
    });
    await page.evaluate((agentId) => {
      window.location.href = `/library/agents?agentId=${encodeURIComponent(agentId)}&tab=ontology`;
    }, pack.agentId);
    await page.waitForFunction(() => location.pathname.includes("/library/agents"), null, { timeout: 30_000 });
    await dismissDialogs(page);
    assert.equal(await page.locator('[role="dialog"]').count(), 0, "an unrelated dialog obscured the proof surface");

    const management = page.getByTestId("ontology-chip-management");
    await management.waitFor({ timeout: 30_000 });
    const publicCopy = page.getByTestId("operational-public-projection");
    await publicCopy.waitFor({ timeout: 30_000 });
    await publicCopy.getByText("판매 페이지에 보일 소개", { exact: true }).waitFor();
    assert.equal(await publicCopy.getByLabel("구매자에게 보일 칩 이름").inputValue(), pack.publicTitle);
    const benefits = (await publicCopy.getByLabel("이 칩을 쓰면 좋아지는 점").inputValue()).split("\n").filter(Boolean);
    assert.equal(benefits.length, Number(pack.benefitCount), "rendered benefit count differs from the confirmed projection");
    assert.equal(await publicCopy.locator('[role="alert"]').count(), 0, "confirmed privacy-safe buyer copy rendered a false privacy warning");
    assert.doesNotMatch(await publicCopy.innerText(), /agent-definition-|agent-release-|\/Users\/|ghp_|sk-(?:proj-)?/i, "public-copy UI exposed an internal identifier, path, or credential");

    const cloudStatus = page.getByTestId("experience-cloud-status");
    await cloudStatus.waitFor({ timeout: 15_000 });
    assert.equal(await cloudStatus.getAttribute("data-cloud-state"), "conflict");
    await cloudStatus.getByText("이 경험을 판매하려면 먼저 원본 에이전트를 Hub에 공개 등록해야 합니다.", { exact: false }).waitFor();

    await publicCopy.screenshot({ path: path.join(output, "01-approved-buyer-copy.png") });
    await cloudStatus.screenshot({ path: path.join(output, "02-private-base-listing-guard.png") });
    assert.deepEqual(consoleErrors, [], `renderer console errors: ${consoleErrors.join(" | ")}`);

    const report = {
      ok: true,
      liveSourceMutated: false,
      sourceOpenedViaConsistentCopy: true,
      packId,
      publicTitle: pack.publicTitle,
      buyerBenefitCount: Number(pack.benefitCount),
      privacyIssueCount: Number(pack.privacyIssueCount),
      privateUploadReceipt: true,
      publicListingBlockedByPrivateBase: true,
      privateMemoryCaptured: false,
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
