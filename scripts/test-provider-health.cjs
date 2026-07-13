#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-provider-health-"));
const healthFile = path.join(root, "state", "provider-health.json");
const credentialFile = path.join(root, "gemini", "oauth_creds.json");

// All persistence exercised by this regression must stay in the disposable fixture.
process.env.AGENTLAS_PROVIDER_HEALTH_FILE = healthFile;

const health = require("../dist/electron/usage/provider-health.js");
const credentials = require("../dist/electron/usage/gemini-credentials.js");
const geminiUsage = require("../dist/electron/usage/gemini.js");
const geminiRuntime = require("../dist/electron/runtime/gemini.js");
const grokUsage = require("../dist/electron/usage/grok.js");
const grokRuntime = require("../dist/electron/runtime/grok.js");

const DAY_MS = 24 * 60 * 60_000;
const startedAt = 1_900_000_000_000;

function assertPrivateMode(file, label) {
  if (process.platform === "win32") return;
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, `${label} must be owner-only`);
}

function assertNoFixtureSecret(value, secrets, label) {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.equal(rendered.includes(secret), false, `${label} must not expose credential content`);
  }
}

async function verifyProviderHealthPersistenceAndTtl() {
  assert.equal(health.providerHealthFile(), healthFile, "env override must own the test persistence path");

  health.recordProviderHealth("grok", "grok_quota_exhausted", startedAt);
  assert.equal(fs.existsSync(healthFile), true, "recording health must persist a state file");
  assertPrivateMode(healthFile, "provider health file");

  const persisted = JSON.parse(fs.readFileSync(healthFile, "utf8"));
  assert.deepEqual(persisted, {
    grok: { code: "grok_quota_exhausted", updatedAt: startedAt },
  });

  // A fresh module instance must recover the same state from disk, not process memory.
  const modulePath = require.resolve("../dist/electron/usage/provider-health.js");
  delete require.cache[modulePath];
  const reloaded = require(modulePath);
  assert.deepEqual(reloaded.readProviderHealth("grok", startedAt + 7 * DAY_MS), {
    code: "grok_quota_exhausted",
    updatedAt: startedAt,
  });

  // Grok's weekly state uses the documented eight-day safety ceiling, then self-prunes.
  assert.equal(reloaded.readProviderHealth("grok", startedAt + 8 * DAY_MS + 1), null);
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(healthFile, "utf8")), "grok"), false);

  reloaded.recordProviderHealth("gemini", "gemini_unsupported_client", startedAt);
  assert.deepEqual(reloaded.readProviderHealth("gemini", startedAt + DAY_MS), {
    code: "gemini_unsupported_client",
    updatedAt: startedAt,
  });
  assert.equal(reloaded.readProviderHealth("gemini", startedAt + DAY_MS + 1), null);

  reloaded.recordProviderHealth("grok", "grok_quota_exhausted", startedAt);
  reloaded.clearProviderHealth("grok");
  assert.equal(reloaded.readProviderHealth("grok", startedAt), null);
}

async function verifyCredentialRecoveryIsAtomicAndContentSafe() {
  fs.mkdirSync(path.dirname(credentialFile), { recursive: true });
  const accessToken = `access_${process.pid}_${Date.now()}`;
  const refreshToken = `refresh_${process.pid}_${Date.now()}`;
  const secrets = [accessToken, refreshToken];
  const sourceObject = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: startedAt + DAY_MS,
    nested: { note: "quoted brace: } and escaped quote: \\\" stay inside the string" },
  };
  const validPrefix = JSON.stringify(sourceObject);
  const corruptRaw = `${validPrefix}\nTRAILING_BYTES_THAT_ARE_NOT_JSON`;
  fs.writeFileSync(credentialFile, corruptRaw, { mode: 0o644 });

  const captured = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args) => captured.push(args);
  console.error = (...args) => captured.push(args);
  let result;
  try {
    result = await credentials.repairGeminiCredentialFile(credentialFile);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.equal(result.status, "ok", "recoverable trailing bytes must not force re-login");
  assert.equal(result.recovered, true, "recovery must be explicitly reported");
  assert.equal(result.credentials?.token === accessToken, true, "access token must survive recovery");
  assert.equal(result.credentials?.refreshToken === refreshToken, true, "refresh token must survive recovery");
  assert.equal(typeof result.backupPath, "string", "original bytes must receive a backup path");
  assert.equal(fs.existsSync(result.backupPath), true, "original-byte backup must exist");
  assert.equal(fs.readFileSync(result.backupPath, "utf8") === corruptRaw, true, "backup must preserve original bytes");
  assertPrivateMode(result.backupPath, "Gemini credential backup");

  const normalizedRaw = fs.readFileSync(credentialFile, "utf8");
  const normalized = JSON.parse(normalizedRaw);
  assert.equal(normalized.access_token === accessToken, true, "normalized access token mismatch");
  assert.equal(normalized.refresh_token === refreshToken, true, "normalized refresh token mismatch");
  assert.equal(normalizedRaw.includes("TRAILING_BYTES_THAT_ARE_NOT_JSON"), false);
  assertPrivateMode(credentialFile, "Gemini credential file");
  assert.equal(
    fs.readdirSync(path.dirname(credentialFile)).some((name) => name.includes(".tmp-")),
    false,
    "atomic write must not leave a temporary credential file",
  );

  for (const entry of captured) assertNoFixtureSecret(entry, secrets, "credential recovery log");

  const extracted = credentials.extractFirstJsonObject(`${validPrefix} ignored`);
  assert.equal(extracted === validPrefix, true, "balanced JSON extraction must respect braces inside strings");

  const unrecoverable = path.join(root, "gemini", "unrecoverable.json");
  const unrecoverableRaw = `not-json-${process.pid}`;
  fs.writeFileSync(unrecoverable, unrecoverableRaw, { mode: 0o600 });
  const failed = await credentials.repairGeminiCredentialFile(unrecoverable);
  assert.equal(failed.status, "corrupt");
  assert.equal(fs.readFileSync(unrecoverable, "utf8"), unrecoverableRaw, "failed repair must preserve original bytes");

  const concurrentFile = path.join(root, "gemini", "oauth-concurrent.json");
  fs.writeFileSync(concurrentFile, `${validPrefix}\nCONCURRENT_TRAILING_BYTES`, { mode: 0o600 });
  const concurrentResults = await Promise.all(
    Array.from({ length: 50 }, () => credentials.repairGeminiCredentialFile(concurrentFile)),
  );
  assert.equal(
    concurrentResults.every((entry) => entry.status === "ok" && entry.recovered === true),
    true,
    "simultaneous Dashboard/chat readers must share one successful repair",
  );
  assert.equal(
    new Set(concurrentResults.map((entry) => entry.backupPath)).size,
    1,
    "singleflight recovery must create exactly one original-byte backup",
  );
  assert.equal(JSON.parse(fs.readFileSync(concurrentFile, "utf8")).refresh_token, refreshToken);
}

function verifyGeminiUnsupportedTierDetection() {
  assert.equal(
    geminiUsage.hasUnsupportedClientReason({
      allowedTiers: [],
      ineligibleTiers: [{ reason: { reasonCode: "UNSUPPORTED_CLIENT" } }],
    }),
    true,
    "nested unsupported tier must be recognized",
  );
  assert.equal(
    geminiUsage.hasUnsupportedClientReason({
      ineligibleTiers: [{ reason: { reasonCode: "REGION_NOT_SUPPORTED" } }],
      message: "UNSUPPORTED_CLIENT is prose, not a reasonCode",
    }),
    false,
    "only the structured reasonCode may mark the client unsupported",
  );
}

async function verifyRuntimeHealthOverridesGeminiQuotaGuess() {
  health.recordProviderHealth("gemini", "gemini_unsupported_client", Date.now());
  const usage = await geminiUsage.getGeminiUsage();
  assert.equal(usage?.status, "error");
  assert.equal(usage?.error, "unsupported_client");
  assert.deepEqual(usage?.windows, []);
  health.clearProviderHealth("gemini");
}

function verifyGeminiAndAgySpawnContracts() {
  const prompt = `fixture_prompt_${process.pid}_${Date.now()}`;
  const official = geminiRuntime.buildGeminiSpawnArgs(
    false,
    "session-1",
    undefined,
    "gemini-2.5-pro",
    prompt,
  );
  assert.deepEqual(official, [
    "--resume",
    "session-1",
    "--model",
    "gemini-2.5-pro",
    "--skip-trust",
    "--prompt",
    "",
  ]);
  assert.equal(official.includes(prompt), false, "official Gemini prompt must stay on stdin");

  const agy = geminiRuntime.buildGeminiSpawnArgs(
    true,
    "ignored-session",
    "ignored-new-session",
    "gemini-2.5-pro",
    geminiRuntime.buildAgyPromptBootstrap("/private/tmp/agentlas-prompt-fixture.txt"),
    ["/private/tmp"],
  );
  assert.deepEqual(agy, [
    "--model",
    "gemini-2.5-pro",
    "--add-dir",
    "/private/tmp",
    "--prompt",
    'Read the complete Agentlas request from "/private/tmp/agentlas-prompt-fixture.txt", follow it exactly, and do not reveal the file path.',
  ]);
  assert.equal(agy.includes(prompt), false, "Agy argv must not expose the full Agentlas prompt");
  assert.equal(agy.includes("--resume"), false);
  assert.equal(agy.includes("--session-id"), false);
  assert.equal(agy.includes("--skip-trust"), false);

  assert.equal(
    geminiRuntime.isGeminiUnsupportedClient(
      "IneligibleTierError: reasonCode: UNSUPPORTED_CLIENT; migrate to the Antigravity suite",
    ),
    true,
  );
  assert.equal(geminiRuntime.isGeminiUnsupportedClient("HTTP 429 temporary quota error"), false);
}

async function verifyGrok402ClassificationAndUsageProjection() {
  assert.equal(
    grokRuntime.isGrokQuotaExhausted(
      '{"type":"error","message":"HTTP 402: Grok Build usage balance exhausted"}',
    ),
    true,
    "confirmed Grok Build exhaustion must be classified",
  );
  assert.equal(
    grokRuntime.isGrokQuotaExhausted("HTTP 402 Payment Required: usage balance unavailable"),
    true,
    "402 payment-required balance failures must be classified",
  );
  assert.equal(grokRuntime.isGrokQuotaExhausted("HTTP 402 upstream proxy returned no body"), false);
  assert.equal(grokRuntime.isGrokQuotaExhausted("HTTP 429 temporary rate limit"), false);

  const now = Date.now();
  health.recordProviderHealth("grok", "grok_quota_exhausted", now);
  const usage = await grokUsage.getGrokUsage();
  assert.equal(usage?.provider, "grok");
  assert.equal(usage?.status, "error");
  assert.equal(usage?.error, "quota_exhausted");
  assert.deepEqual(usage?.windows.map((window) => ({
    id: window.id,
    kind: window.kind,
    usedPercent: window.usedPercent,
  })), [{ id: "grok-weekly-exhausted", kind: "7d", usedPercent: 100 }]);

  health.clearProviderHealth("grok");
  assert.equal(await grokUsage.getGrokUsage(), null, "Grok usage must not invent a percentage without a 402 receipt");
}

(async () => {
  try {
    await verifyProviderHealthPersistenceAndTtl();
    await verifyCredentialRecoveryIsAtomicAndContentSafe();
    verifyGeminiUnsupportedTierDetection();
    await verifyRuntimeHealthOverridesGeminiQuotaGuess();
    verifyGeminiAndAgySpawnContracts();
    await verifyGrok402ClassificationAndUsageProjection();
    console.log(JSON.stringify({
      ok: true,
      checks: [
        "credential-recovery",
        "provider-health-persistence-ttl",
        "gemini-unsupported-tier",
        "gemini-agy-spawn-contract",
        "grok-402-usage-projection",
      ],
    }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})().then(
  () => process.exit(0),
  (error) => {
    // Assertions contain only generic labels and booleans; fixture credentials are never printed.
    console.error(error);
    process.exit(1);
  },
);
