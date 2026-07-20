#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function openStore() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires --user-data");
  app.setPath("userData", userData);
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  return { app, db: store.getDb() };
}

function write(root, relative, text) {
  const target = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, text, { mode: 0o600 });
}

function regularFileSnapshot(root) {
  const result = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) {
        result.push({ path: relative, kind: "symlink", target: fs.readlinkSync(absolute) });
      } else if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const bytes = fs.readFileSync(absolute);
        result.push({ path: relative, kind: "file", bytes: bytes.length, sha256: hash(bytes), mode: fs.statSync(absolute).mode & 0o777 });
      }
    }
  };
  walk(root);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

function emptySignals() {
  return { agentBuild: null, retainTeam: null, automation: null, hubDerivative: null };
}

function hubSignal(privateSourceId) {
  return {
    privateSourceId,
    ownerVerified: true,
    publicReleaseIntentConfirmed: true,
    privateInputExcluded: true,
    publicSuitability: "passed",
    publicSuitabilityRef: "review_public_suitability_passed",
    sanitizedManifestRef: "manifest_public_allowlist_review",
    rightsReviewRef: "rights_review_candidate_only",
    economy: {
      available: true,
      policyRef: "hub_economy_signal_untrusted",
      feeScheduleRef: "hub_fee_signal_untrusted",
      settlementRuleRef: "hub_settlement_signal_untrusted",
    },
    excludedPrivateCategories: [
      "memory",
      "credentials",
      "local_paths",
      "customer_data",
      "private_examples",
      "raw_task_context",
    ],
  };
}

function createTaskEvidence(db, runEvents, index) {
  const taskId = `task_hub_derivative_${String(index).padStart(2, "0")}`;
  const chatId = `chat_hub_derivative_${String(index).padStart(2, "0")}`;
  const runId = `run_hub_derivative_${String(index).padStart(2, "0")}`;
  const completedAt = new Date(Date.now() - 180_000 + index * 2_000).toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
     VALUES (?, ?, NULL, NULL, 'completed', ?, ?, NULL, ?)`,
  ).run(taskId, `Hub derivative evidence ${index}`, completedAt, completedAt, chatId);
  runEvents.recordRunEvent({ runId, kind: "invoke_started", chatId, payload: { chatId } });
  runEvents.recordRunEvent({ runId, kind: "invoke_completed", chatId, payload: { localOnly: true } });
  return {
    taskId,
    taskVersion: Date.parse(completedAt),
    patternKey: "placeholder",
    status: "completed",
    outcome: "success",
    hostVerified: true,
    hostId: "host_hub_derivative_local",
    runId,
    completionReceiptRef: runId,
    verificationRef: `verification_hub_derivative_${index}`,
    evidenceRefs: [`evidence_hub_derivative_${index}`],
    completedAt,
  };
}

function createSuggestion(suggestions, stateVersion, patternKey, evidence, privateSourceId) {
  const normalized = evidence.map((item) => ({ ...item, patternKey }));
  return suggestions.arbitrateOneSuggestion({
    expectedStoreVersion: stateVersion,
    originTaskId: normalized[normalized.length - 1].taskId,
    patternKey,
    importantBriefingActive: false,
    evidence: normalized,
    signals: { ...emptySignals(), hubDerivative: hubSignal(privateSourceId) },
  });
}

function handoffInput(suggestion, review) {
  return {
    suggestionId: suggestion.id,
    expectedSuggestionVersion: suggestion.version,
    reviewRequestId: review.id,
    draftId: review.draftId,
    originTaskId: suggestion.originTaskId,
  };
}

function installOwnedPrivateRelease(userData, db, packageRuntime, restoreRuntime, routesRuntime) {
  const staging = path.join(userData, "private-package-source");
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  write(staging, "AGENT.md", "# Research Monitor\n\nSummarize public product changes with cited sources.\n");
  write(staging, "README.md", "Review note token='sk-proj-abcdefghijklmnopqrstuvwxyz123456'.\n");
  write(staging, "SKILL.md", "Never read /Users/private-owner/Documents/raw-notes.\n");
  write(staging, "public-tests/contract.md", "# Public contract\n\nReturn a concise sourced comparison.\n");
  write(staging, "memory/state.json", "{\"preference\":\"private memory\"}\n");
  write(staging, "experience/private.md", "private learned correction\n");
  write(staging, "customer/records.txt", "customer email mason.customer@example.net\n");
  write(staging, "internal/strategy.md", "internal-only launch strategy\n");
  write(staging, "tasks/transcript.txt", "user: raw task context\nassistant: private answer\n");
  write(staging, "examples/private.md", "private example from a real engagement\n");
  write(staging, "notes.md", "Safe but not allowlisted.\n");
  write(staging, "public-tests/image.png", Buffer.from([0, 1, 2, 3, 4]));

  const scan = packageRuntime.scanCloudAgentFolderForLocalReview(staging);
  assert.ok(scan.included.length >= 10, "fixture package must contain both public and private source classes");
  const destination = path.join(userData, "owned-private-agent");
  const packageDownload = {
    packageHash: scan.packageHash,
    packageHashVersion: "path-sha256-executable-v2",
    fileCount: scan.included.length,
    totalBytes: scan.included.reduce((sum, file) => sum + file.bytes, 0),
    agentKind: "agent",
    runtimeLabels: ["generic"],
    files: scan.included.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      sha256: file.sha256,
      contentBase64: file.contentBase64,
      executable: file.executable,
    })),
  };
  const restored = restoreRuntime.restoreCloudAgentPackage({
    destinationDir: destination,
    slug: "owned-private-research-monitor",
    package: packageDownload,
    registration: {
      cloudId: "cloud-owned-private-review",
      slug: "owned-private-research-monitor",
      scope: "owner-private",
      packageHash: scan.packageHash,
      packageHashVersion: "path-sha256-executable-v2",
      revision: `rev_${"1".repeat(32)}`,
      updatedAt: new Date().toISOString(),
    },
  });
  assert.equal(restored.packageHash, scan.packageHash);

  const outsideSecret = path.join(userData, "outside-secret.txt");
  fs.writeFileSync(outsideSecret, "SYMLINK_TARGET_MUST_NOT_APPEAR", { mode: 0o600 });
  fs.symlinkSync(outsideSecret, path.join(destination, "linked.md"));
  fs.writeFileSync(path.join(destination, ".env"), "PRIVATE_ENV_SHOULD_NOT_APPEAR=1\n", { mode: 0o600 });
  const restoredScan = packageRuntime.scanCloudAgentFolderForLocalReview(destination);
  assert.equal(restoredScan.packageHash, restored.packageHash, "blocked additions must not change the verified package hash");

  const privateSourceId = "owned_private_agent_review";
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
      (id, slug, name, name_en, tagline, tagline_en, system_prompt, mcp_servers_json,
       env_requirements_json, preferred_backend, trust_grade, installed_at, tone, builtin, role,
       visibility, entity_kind, local_display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'professional', 0, NULL, 'visible', 'agent', NULL)`,
  ).run(
    privateSourceId,
    "owned-private-research-monitor",
    "비공개 리서치 모니터",
    "Owned Private Research Monitor",
    "비공개 자료를 포함한 개인 에이전트",
    "A private research assistant release.",
    "Private runtime prompt that must never be copied automatically.",
    now,
  );
  routesRuntime.setRoute({
    agentId: privateSourceId,
    path: destination,
    runtime: "generic",
    labels: ["generic"],
    kind: "agent",
    importedAt: now,
    source: "agent-cloud",
    packageHash: restored.packageHash,
  });
  return { privateSourceId, destination, outsideSecret, packageHash: restored.packageHash };
}

async function seedWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  const hub = require("../dist/electron/one/hub-derivative.js");
  const reviewSeedRuntime = require("../dist/electron/one/review-seed.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const packageRuntime = require("../dist/electron/cloud-agents/package.js");
  const restoreRuntime = require("../dist/electron/cloud-agents/restore.js");
  const routesRuntime = require("../dist/electron/agents/routes.js");
  const userData = argument("--user-data");
  let networkCalls = 0;
  global.fetch = async () => {
    networkCalls += 1;
    throw new Error("network forbidden in local derivative review");
  };

  const source = installOwnedPrivateRelease(userData, db, packageRuntime, restoreRuntime, routesRuntime);
  const sourceBefore = regularFileSnapshot(source.destination);
  const evidence = Array.from({ length: 6 }, (_, index) => createTaskEvidence(db, runEvents, index + 1));
  let state = suggestions.getOneSuggestionState();

  const created = createSuggestion(suggestions, state.version, "pattern_hub_derivative_success", evidence.slice(0, 2), source.privateSourceId);
  assert.equal(created.reason, "created");
  assert.equal(created.suggestion.type, "hub_derivative");
  assert.throws(
    () => suggestions.acceptOneSuggestionForReviewFromUser({
      expectedStoreVersion: created.storeVersion,
      suggestionId: created.suggestion.id,
      expectedSuggestionVersion: created.suggestion.version,
      confirmedByUser: true,
      reviewOnly: true,
    }),
    /explicit publicDerivativeReview selection/,
  );
  assert.equal(suggestions.getOneSuggestionState().version, created.storeVersion, "missing explicit selection must not mutate state");

  const accepted = suggestions.acceptOneSuggestionForReviewFromUser({
    expectedStoreVersion: created.storeVersion,
    suggestionId: created.suggestion.id,
    expectedSuggestionVersion: created.suggestion.version,
    confirmedByUser: true,
    reviewOnly: true,
    publicDerivativeReview: true,
  });
  state = suggestions.getOneSuggestionState();
  const acceptedSuggestion = state.suggestions.find((item) => item.id === created.suggestion.id);
  assert.ok(acceptedSuggestion);
  const input = handoffInput(acceptedSuggestion, accepted.value);
  const handoff = suggestions.getOneSuggestionReviewHandoff(input);
  assert.equal(handoff.targetSurface, "work");
  assert.equal(handoff.fallbackToOriginTaskWork, false);
  assert.equal(handoff.fallbackReason, null);
  const reviewSeed = reviewSeedRuntime.getOneSuggestionReviewSeed(input);
  assert.equal(reviewSeed.kind, "hub_derivative");
  assert.equal(reviewSeed.publishingStarted, false);
  const draft = hub.getOneHubDerivativeDraft(input);
  assert.equal(draft.draftId, accepted.value.draftId);
  assert.notEqual(draft.draftId, source.privateSourceId);
  assert.equal(draft.draftPathRef, `one/hub-derivative-drafts/${draft.draftId}`);
  assert.equal(path.isAbsolute(draft.draftPathRef), false);
  assert.equal(draft.sourceAssetSource, "agent-cloud");
  assert.equal(draft.sourcePackageHash, source.packageHash);
  assert.deepEqual(draft.gates, {
    entitlement: { status: "unknown", ref: null },
    rights: { status: "unknown", ref: null },
    economy: { status: "unknown", ref: null },
    fee: { status: "unknown", ref: null },
    explicitPublishApproval: false,
    publishAllowed: false,
    publishingStarted: false,
    revenueGuaranteed: false,
  });
  assert.deepEqual(draft.original, { sourceUnchanged: true, privateSourceIncluded: false });
  const included = draft.includedFiles.map((file) => file.path);
  assert.ok(included.includes("package/PUBLIC_DERIVATIVE.md"));
  assert.ok(included.includes("package/.agentlas/routing-card.json"));
  assert.deepEqual(included.sort(), [
    "package/.agentlas/routing-card.json",
    "package/PUBLIC_DERIVATIVE.md",
  ], "v1 must be a generated-only scaffold with zero private source bytes");
  const excluded = new Map(draft.excluded.map((item) => [item.category, item.count]));
  for (const category of [
    "memory", "credentials", "customer_data", "internal_docs", "raw_task_context", "local_paths",
    "secrets", "private_examples", "private_experience", "symlink", "non_allowlisted",
  ]) assert.ok((excluded.get(category) || 0) >= 1, `expected an excluded ${category} fixture`);
  assert.deepEqual(draft.alwaysExcludedCategories, [
    "memory", "credentials", "customer_data", "internal_docs", "raw_task_context",
    "local_paths", "secrets", "private_examples", "private_experience",
  ]);

  const draftRoot = hub.oneHubDerivativeDraftPath(draft.draftId);
  const packageBytes = regularFileSnapshot(path.join(draftRoot, "package"));
  const serializedFiles = packageBytes.map((item) => item.kind === "file"
    ? fs.readFileSync(path.join(draftRoot, "package", ...item.path.split("/")), "utf8")
    : "").join("\n");
  for (const forbidden of [
    "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    "/Users/private-owner/Documents/raw-notes",
    "mason.customer@example.net",
    "internal-only launch strategy",
    "user: raw task context",
    "private example from a real engagement",
    "private learned correction",
    "PRIVATE_ENV_SHOULD_NOT_APPEAR",
    "SYMLINK_TARGET_MUST_NOT_APPEAR",
  ]) assert.equal(serializedFiles.includes(forbidden), false, `draft package leaked ${forbidden}`);
  assert.deepEqual(regularFileSnapshot(source.destination), sourceBefore, "creating a derivative must not mutate the private release");
  assert.equal(networkCalls, 0, "local review must not call Hub or any network service");

  assert.throws(() => hub.getOneHubDerivativeDraft({ ...input, rawTask: "private" }), /closed object|unsupported/i);
  assert.throws(() => hub.getOneHubDerivativeDraft({ ...input, expectedSuggestionVersion: input.expectedSuggestionVersion - 1 }), /canonical review handoff/);

  const manifestPath = path.join(draftRoot, "review.manifest.json");
  const originalManifest = fs.readFileSync(manifestPath);
  const unknownManifest = JSON.parse(originalManifest.toString("utf8"));
  unknownManifest.futurePublishState = "ready";
  fs.writeFileSync(manifestPath, JSON.stringify(unknownManifest));
  assert.throws(() => hub.getOneHubDerivativeDraft(input), /manifest no longer matches|closed contract/);
  fs.writeFileSync(manifestPath, originalManifest);

  const extraPath = path.join(draftRoot, "package", "source", "unexpected.md");
  fs.mkdirSync(path.dirname(extraPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(extraPath, "unexpected", { mode: 0o600 });
  assert.throws(() => hub.getOneHubDerivativeDraft(input), /outside its strict allowlist|too many files/);
  fs.unlinkSync(extraPath);
  fs.rmdirSync(path.dirname(extraPath));

  const generatedReadme = path.join(draftRoot, "package", "PUBLIC_DERIVATIVE.md");
  const generatedReadmeBytes = fs.readFileSync(generatedReadme);
  fs.unlinkSync(generatedReadme);
  fs.symlinkSync(source.outsideSecret, generatedReadme);
  assert.throws(() => hub.getOneHubDerivativeDraft(input), /symbolic links|unsafe/);
  fs.unlinkSync(generatedReadme);
  fs.writeFileSync(generatedReadme, generatedReadmeBytes, { mode: 0o600 });
  assert.equal(hub.getOneHubDerivativeDraft(input).draftId, draft.draftId);

  const rawHubState = db.prepare("SELECT value FROM meta WHERE key = ?").get(hub.ONE_HUB_DERIVATIVE_META_KEY).value;
  const futureState = JSON.parse(rawHubState);
  futureState.futureEconomy = { available: true };
  const futureRaw = JSON.stringify(futureState);
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(futureRaw, hub.ONE_HUB_DERIVATIVE_META_KEY);
  assert.throws(() => hub.getOneHubDerivativeState(), /closed contract|violates/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(hub.ONE_HUB_DERIVATIVE_META_KEY).value, futureRaw, "invalid future state must not be overwritten");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(rawHubState, hub.ONE_HUB_DERIVATIVE_META_KEY);

  const tampered = createSuggestion(suggestions, state.version, "pattern_hub_derivative_tamper", evidence.slice(2, 4), source.privateSourceId);
  assert.equal(tampered.reason, "created");
  const sourceAgentPath = path.join(source.destination, "AGENT.md");
  const originalSourceAgent = fs.readFileSync(sourceAgentPath);
  fs.writeFileSync(sourceAgentPath, Buffer.concat([originalSourceAgent, Buffer.from("changed after restore\n")]), { mode: 0o600 });
  const draftCountBeforeTamper = hub.getOneHubDerivativeState().drafts.length;
  assert.throws(
    () => suggestions.acceptOneSuggestionForReviewFromUser({
      expectedStoreVersion: tampered.storeVersion,
      suggestionId: tampered.suggestion.id,
      expectedSuggestionVersion: tampered.suggestion.version,
      confirmedByUser: true,
      reviewOnly: true,
      publicDerivativeReview: true,
    }),
    /release changed|exact verified package/,
  );
  assert.equal(suggestions.getOneSuggestionState().version, tampered.storeVersion, "changed source rejection must not mutate suggestion state");
  assert.equal(hub.getOneHubDerivativeState().drafts.length, draftCountBeforeTamper, "changed source rejection must not create a draft");
  fs.writeFileSync(sourceAgentPath, originalSourceAgent, { mode: 0o600 });
  assert.equal(packageRuntime.scanCloudAgentFolderForLocalReview(source.destination).packageHash, source.packageHash);

  const race = createSuggestion(suggestions, tampered.storeVersion, "pattern_hub_derivative_race", evidence.slice(4, 6), source.privateSourceId);
  assert.equal(race.reason, "created");
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({
    ok: true,
    localDraftId: draft.draftId,
    localSuggestionId: acceptedSuggestion.id,
    localSuggestionVersion: acceptedSuggestion.version,
    localReviewId: accepted.value.id,
    localOriginTaskId: acceptedSuggestion.originTaskId,
    raceStoreVersion: race.storeVersion,
    raceSuggestionId: race.suggestion.id,
    raceSuggestionVersion: race.suggestion.version,
    privateSourceId: source.privateSourceId,
    included: draft.includedFiles.length,
    excludedCategories: draft.excluded.length,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  global.fetch = async () => { throw new Error("network forbidden"); };
  try {
    const result = suggestions.acceptOneSuggestionForReviewFromUser({
      expectedStoreVersion: Number(argument("--store-version")),
      suggestionId: argument("--suggestion-id"),
      expectedSuggestionVersion: Number(argument("--suggestion-version")),
      confirmedByUser: true,
      reviewOnly: true,
      publicDerivativeReview: true,
    });
    console.log(JSON.stringify({ success: true, reviewId: result.value.id, draftId: result.value.draftId }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const suggestions = require("../dist/electron/one/suggestions.js");
  const hub = require("../dist/electron/one/hub-derivative.js");
  const reconciled = hub.reconcileOneHubDerivativeDraftStorage();
  assert.deepEqual(reconciled, { removedOrphans: 1, removedTemps: 1 }, "restart reconciliation must remove only unbound internal paths");
  const suggestionState = suggestions.getOneSuggestionState();
  const hubState = hub.getOneHubDerivativeState();
  const accepted = suggestionState.suggestions.filter((item) => item.type === "hub_derivative" && item.status === "accepted_for_review");
  assert.equal(accepted.length, 2, "successful seed and one concurrent winner must survive restart");
  assert.equal(hubState.drafts.length, 2, "exactly two durable local drafts must survive restart");
  for (const suggestion of accepted) {
    const review = suggestionState.reviewRequests.find((item) => item.suggestionId === suggestion.id);
    assert.ok(review);
    const input = handoffInput(suggestion, review);
    const handoff = suggestions.getOneSuggestionReviewHandoff(input);
    assert.equal(handoff.fallbackToOriginTaskWork, false);
    assert.equal(hub.getOneHubDerivativeDraft(input).draftId, review.draftId);
  }
  const parent = path.dirname(hub.oneHubDerivativeDraftPath(hubState.drafts[0].draftId));
  const entries = fs.readdirSync(parent).filter((entry) => !entry.startsWith("."));
  assert.deepEqual(entries.sort(), hubState.drafts.map((item) => item.draftId).sort(), "CAS loser must leave no orphan draft directory");
  const raw = JSON.stringify(hubState);
  assert.equal(raw.includes(app.getPath("userData")), false, "durable state must never expose an absolute local path");
  assert.equal(/(?:published|publishingStarted":true|publishAllowed":true|revenueGuaranteed":true)/.test(raw), false);
  console.log(JSON.stringify({ ok: true, restarted: true, drafts: hubState.drafts.length, noOrphans: true }));
  db.close();
  app.quit();
}

function runAsync(executable, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

async function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-hub-derivative-"));
  const userData = path.join(temp, "user-data");
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "agentlas.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [__filename, "--seed", `--user-data=${userData}`], { env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`Hub derivative seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);
    const common = [
      __filename,
      "--race",
      `--user-data=${userData}`,
      `--store-version=${seeded.raceStoreVersion}`,
      `--suggestion-id=${seeded.raceSuggestionId}`,
      `--suggestion-version=${seeded.raceSuggestionVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, common, env),
      runAsync(executable, common, env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`Hub derivative race worker failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent public-review acceptance must win");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const draftParent = path.join(userData, "one", "hub-derivative-drafts");
    const orphan = path.join(draftParent, `one_hub_draft_${"f".repeat(32)}`);
    const crashTemp = path.join(draftParent, `.one_hub_draft_${"e".repeat(32)}.999.999.tmp`);
    fs.mkdirSync(orphan, { mode: 0o700 });
    fs.writeFileSync(path.join(orphan, "orphan.txt"), "crash-window fixture", { mode: 0o600 });
    fs.mkdirSync(crashTemp, { mode: 0o700 });

    const reload = spawnSync(executable, [__filename, "--reload", `--user-data=${userData}`], { env, encoding: "utf8" });
    if (reload.status !== 0) throw new Error(`Hub derivative reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--race")) {
  raceWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--reload")) {
  reloadWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
