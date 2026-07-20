#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? null;
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

function loadRuntime() {
  return {
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runEvents: require("../dist/electron/store/run-events.js"),
    domainEvents: require("../dist/electron/one/domain-events.js"),
    memory: require("../dist/electron/one/memory-candidates.js"),
    closures: require("../dist/electron/one/value-closure.js"),
    acceptedClosures: require("../dist/electron/one/accepted-result-value-closure.js"),
    reuse: require("../dist/electron/one/experience-reuse.js"),
    contract: require("../dist/shared/one-experience-reuse.js"),
    projector: require("../dist/electron/mobile-bridge/projector.js"),
    mobileContract: require("../dist/shared/mobile-bridge.js"),
  };
}

function insertAgent(db) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-reuse-agent", "one-reuse-agent", "One", "Experience reuse verifier", new Date().toISOString());
}

function createTask(runtime, title) {
  const chat = runtime.chats.createChat({ agentId: "one-reuse-agent", title });
  const task = runtime.tasks.getCanonicalTaskForChat(chat.id);
  assert.ok(task);
  return { chat, task };
}

function createMemory(runtime, source, key) {
  const state = runtime.memory.getOneMemoryState();
  const proposed = runtime.memory.proposeOneMemoryCandidate({
    expectedStoreVersion: state.version,
    normalizedPreview: `Approved experience ${key}; no raw path or secret.`,
    scope: "personal",
    source: {
      provenanceStatus: "verified",
      sourceTaskId: source.accepted.id,
      sourceTaskVersion: source.accepted.version,
      sourceRunId: source.receipt.runId,
      sourceValueClosureId: source.closure.value.closure.valueClosureId,
      sourceValueClosureVersion: source.closure.value.version,
      sourceRef: `source:${key}`,
      evidenceRefs: [`evidence:${key}`],
      basis: "explicit_user_statement",
    },
    suppressionKey: `reuse:${key}`,
  });
  return runtime.memory.saveOneMemoryCandidate({
    expectedStoreVersion: proposed.storeVersion,
    candidateId: proposed.value.id,
    expectedCandidateVersion: proposed.value.version,
    approvedByUser: true,
  });
}

function acceptedRun(runtime, input) {
  const { chat, task: initial } = input.target ?? createTask(runtime, input.title);
  const partial = runtime.tasks.setCanonicalTaskStatus(initial.id, "partial");
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: initial.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  runtime.runEvents.recordRunEvent({
    runId: input.runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: "one-reuse-agent",
    payload: { chatId: chat.id },
  });
  runtime.domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: input.runId,
    taskId: partial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: input.runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  if (input.memoryPayload) {
    runtime.runEvents.recordRunEvent({
      runId: input.runId,
      kind: "one_memory_context_applied",
      chatId: chat.id,
      agentId: "one-reuse-agent",
      payload: input.memoryPayload,
    });
  }
  runtime.runEvents.recordRunEvent({
    runId: input.runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: "one-reuse-agent",
    payload: { completed: true },
  });
  const receipt = runtime.runEvents.getInvocationRunReceipt(input.runId);
  assert.ok(receipt);
  const accepted = runtime.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: input.runId,
  }, receipt);
  const closure = runtime.acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: input.runId,
    receipt,
    confirmedByUser: true,
  });
  return { chat, partial, accepted, receipt, closure };
}

function reuseInput(prepared) {
  return {
    taskId: prepared.accepted.id,
    expectedTaskVersion: prepared.accepted.version,
    expectedTaskUpdatedAt: prepared.accepted.updatedAt,
    expectedRunId: prepared.receipt.runId,
    valueClosureId: prepared.closure.value.closure.valueClosureId,
    expectedValueClosureVersion: prepared.closure.value.version,
    confirmedByUser: true,
  };
}

function memoryPayload(saved, extra = {}) {
  const memory = saved.value.memory;
  return {
    storeVersion: saved.storeVersion,
    memoryIds: [memory.id],
    scopeKinds: [memory.scope],
    assets: [{
      assetId: memory.id,
      assetVersion: memory.version,
      provenanceStatus: memory.provenanceStatus,
      sourceTaskId: memory.sourceTaskId,
      sourceTaskVersion: memory.sourceTaskVersion,
      sourceRunId: memory.sourceRunId,
      sourceValueClosureId: memory.sourceValueClosureId,
      sourceValueClosureVersion: memory.sourceValueClosureVersion,
      scope: memory.scope,
    }],
    ...extra,
  };
}

async function seedWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const runtime = loadRuntime();
  const source = acceptedRun(runtime, {
    title: "Earlier approved Task",
    runId: "run_reuse_source",
  });
  const saved = createMemory(runtime, source, "primary");

  const primary = acceptedRun(runtime, {
    title: "Reuse approved experience",
    runId: "run_reuse_primary",
    memoryPayload: memoryPayload(saved),
  });
  const created = runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(primary));
  assert.ok(created);
  assert.equal(created.receipt.reuseStatus, "approved_experience_reused");
  assert.equal(created.receipt.comparisonStatus, "not_yet_measured");
  assert.equal(created.receipt.improvementClaimed, false);
  assert.deepEqual(created.receipt.assetBindings, memoryPayload(saved).assets);
  assert.equal(runtime.contract.isOneExperienceReuseReceiptV1(created.receipt), true);
  assert.equal(runtime.contract.isOneExperienceReuseReceiptV1({ ...created.receipt, rawMemory: "forbidden" }), false);
  const serialized = JSON.stringify(runtime.reuse.getOneExperienceReuseState());
  assert.equal(serialized.includes("Approved experience primary"), false);
  assert.equal(serialized.includes("/private/"), false);
  const projected = runtime.projector.projectMobileBridgeOneExperienceReuseFromState({
    version: 1,
    hostId: "host_11111111111111111111111111111111",
    createdAt: "2026-07-18T00:00:00.000Z",
  }, runtime.reuse.getOneExperienceReuseState());
  assert.equal(projected.length, 1);
  assert.equal(runtime.mobileContract.isMobileBridgeOneExperienceReuseDto(projected[0]), true);
  assert.equal(projected[0].reusedAssetCount, 1);
  assert.equal(projected[0].sourceTaskCount, 1);
  assert.equal(JSON.stringify(projected).includes(saved.value.memory.id), false);
  assert.equal(JSON.stringify(projected).includes("Approved experience primary"), false);
  assert.equal(runtime.mobileContract.isMobileBridgeOneExperienceReuseDto({
    ...projected[0], rawMemoryContent: "forbidden",
  }), false);
  assert.deepEqual(runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(primary)), created);
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt({ ...reuseInput(primary), hiddenClaim: true }),
    /closed object/,
  );

  const legacy = acceptedRun(runtime, {
    title: "Pre-v1 run",
    runId: "run_reuse_legacy",
    memoryPayload: {
      storeVersion: saved.storeVersion,
      memoryIds: [saved.value.memory.id],
      scopeKinds: [saved.value.memory.scope],
    },
  });
  assert.equal(runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(legacy)), null);

  const legacyAssetBinding = acceptedRun(runtime, {
    title: "Pre-provenance asset binding",
    runId: "run_reuse_legacy_asset",
    memoryPayload: {
      storeVersion: saved.storeVersion,
      memoryIds: [saved.value.memory.id],
      scopeKinds: [saved.value.memory.scope],
      assets: [{
        assetId: saved.value.memory.id,
        assetVersion: saved.value.memory.version,
        sourceTaskId: saved.value.memory.sourceTaskId,
        scope: saved.value.memory.scope,
      }],
    },
  });
  assert.equal(runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(legacyAssetBinding)), null);

  const legacyUnversioned = acceptedRun(runtime, {
    title: "Explicit legacy-unversioned asset binding",
    runId: "run_reuse_legacy_unversioned",
    memoryPayload: {
      ...memoryPayload(saved),
      assets: [{
        ...memoryPayload(saved).assets[0],
        provenanceStatus: "legacy_unversioned",
        sourceTaskVersion: null,
        sourceRunId: null,
        sourceValueClosureId: null,
        sourceValueClosureVersion: null,
      }],
    },
  });
  assert.equal(runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(legacyUnversioned)), null);

  const tamperedSourceVersion = acceptedRun(runtime, {
    title: "Tampered source provenance",
    runId: "run_reuse_tampered_source",
    memoryPayload: {
      ...memoryPayload(saved),
      assets: [{
        ...memoryPayload(saved).assets[0],
        sourceTaskVersion: saved.value.memory.sourceTaskVersion + 1,
      }],
    },
  });
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(tamperedSourceVersion)),
    /Applied Memory asset changed/,
  );

  const sameSource = acceptedRun(runtime, {
    title: "Same Task memory only",
    runId: "run_reuse_same_source",
  });
  const sameSaved = createMemory(runtime, sameSource, "same-task");
  const same = acceptedRun(runtime, {
    target: { chat: sameSource.chat, task: sameSource.accepted },
    title: "Same Task memory only",
    runId: "run_reuse_same_task",
    memoryPayload: memoryPayload(sameSaved),
  });
  assert.equal(runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(same)), null);

  const editedSaved = createMemory(runtime, source, "edited");
  const edited = acceptedRun(runtime, {
    title: "Edited asset",
    runId: "run_reuse_edited",
    memoryPayload: memoryPayload(editedSaved),
  });
  runtime.memory.updateOneMemoryAsset({
    expectedStoreVersion: runtime.memory.getOneMemoryState().version,
    memoryId: editedSaved.value.memory.id,
    expectedMemoryVersion: editedSaved.value.memory.version,
    content: "User-approved edit after the run.",
    approvedByUser: true,
  });
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(edited)),
    /Applied Memory asset changed/,
  );

  const disabledSaved = createMemory(runtime, source, "disabled");
  const disabled = acceptedRun(runtime, {
    title: "Disabled asset",
    runId: "run_reuse_disabled",
    memoryPayload: memoryPayload(disabledSaved),
  });
  runtime.memory.setOneMemoryAssetEnabled({
    expectedStoreVersion: runtime.memory.getOneMemoryState().version,
    memoryId: disabledSaved.value.memory.id,
    expectedMemoryVersion: disabledSaved.value.memory.version,
    enabled: false,
    confirmedByUser: true,
  });
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(disabled)),
    /Applied Memory asset changed/,
  );

  const extraSaved = createMemory(runtime, source, "unknown-field");
  const expanded = acceptedRun(runtime, {
    title: "Expanded event",
    runId: "run_reuse_expanded",
    memoryPayload: memoryPayload(extraSaved, { rawSourcePath: "/private/forbidden" }),
  });
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt(reuseInput(expanded)),
    /unsupported fields/,
  );

  const staleSaved = createMemory(runtime, source, "stale-bindings");
  const staleRun = acceptedRun(runtime, {
    title: "Stale bindings",
    runId: "run_reuse_stale",
    memoryPayload: memoryPayload(staleSaved),
  });
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt({
      ...reuseInput(staleRun),
      expectedRunId: "run_reuse_wrong",
    }),
    /durable completed run/,
  );
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt({
      ...reuseInput(staleRun),
      expectedValueClosureVersion: staleRun.closure.value.version + 1,
    }),
    /Value Closure is unavailable/,
  );
  const staleTaskInput = reuseInput(staleRun);
  runtime.tasks.setCanonicalTaskStatus(staleRun.accepted.id, "failed");
  assert.throws(
    () => runtime.reuse.ensureOneExperienceReuseReceipt(staleTaskInput),
    /Canonical Task changed/,
  );

  const raceSaved = createMemory(runtime, source, "race");
  const race = acceptedRun(runtime, {
    title: "CAS convergence",
    runId: "run_reuse_race",
    memoryPayload: memoryPayload(raceSaved),
  });
  console.log(JSON.stringify({ ok: true, raceInput: reuseInput(race), primaryId: created.receipt.reuseReceiptId }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = loadRuntime();
  const input = JSON.parse(Buffer.from(argument("--input"), "base64url").toString("utf8"));
  const result = runtime.reuse.ensureOneExperienceReuseReceipt(input);
  assert.ok(result);
  console.log(JSON.stringify({ ok: true, receiptId: result.receipt.reuseReceiptId, version: result.version }));
  db.close();
  app.quit();
}

async function corruptWorker() {
  const { app, db } = await openStore();
  const runtime = loadRuntime();
  const before = db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.reuse.ONE_EXPERIENCE_REUSE_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run('{"corrupt":true}', runtime.reuse.ONE_EXPERIENCE_REUSE_META_KEY);
  assert.throws(() => runtime.reuse.getOneExperienceReuseState(), /closed contract/);
  const after = db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.reuse.ONE_EXPERIENCE_REUSE_META_KEY).value;
  assert.equal(after, '{"corrupt":true}', "corrupt state must never be overwritten");
  assert.notEqual(before, after);
  console.log(JSON.stringify({ ok: true, corruptStateRejectedWithoutOverwrite: true }));
  db.close();
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines.at(-1));
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-experience-reuse-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "reuse.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [
      __filename,
      "--seed",
      `--user-data=${path.join(temp, "seed")}`,
    ], { env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`Experience-reuse seed failed\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);
    const encoded = Buffer.from(JSON.stringify(seeded.raceInput), "utf8").toString("base64url");
    const args = [__filename, "--race", `--input=${encoded}`];
    const [left, right] = await Promise.all([
      runAsync(executable, [...args, `--user-data=${path.join(temp, "race-left")}`], env),
      runAsync(executable, [...args, `--user-data=${path.join(temp, "race-right")}`], env),
    ]);
    if (left.status !== 0 || right.status !== 0) {
      throw new Error(`Experience-reuse race failed\nLEFT ${left.stdout}\n${left.stderr}\nRIGHT ${right.stdout}\n${right.stderr}`);
    }
    const outcomes = [parseLastJson(left.stdout), parseLastJson(right.stdout)];
    assert.equal(new Set(outcomes.map((item) => item.receiptId)).size, 1);
    assert.equal(new Set(outcomes.map((item) => item.version)).size, 1);
    process.stdout.write(`${JSON.stringify({ ok: true, casIdempotency: outcomes })}\n`);

    const ipc = fs.readFileSync(path.join(__dirname, "../electron/ipc.ts"), "utf8");
    const mobile = fs.readFileSync(path.join(__dirname, "../electron/mobile-bridge/authority.ts"), "utf8");
    const preload = fs.readFileSync(path.join(__dirname, "../electron/preload.ts"), "utf8");
    const shell = fs.readFileSync(path.join(__dirname, "../renderer/components/one/OneShell.tsx"), "utf8");
    const adaptive = fs.readFileSync(path.join(__dirname, "../renderer/components/one/OneAdaptiveResult.tsx"), "utf8");
    const memorySheet = fs.readFileSync(path.join(__dirname, "../renderer/components/one/OneMemorySheet.tsx"), "utf8");
    const card = fs.readFileSync(path.join(__dirname, "../renderer/components/one/OneExperienceReuseCard.tsx"), "utf8");
    const assertAcceptanceReuseWiring = (source, startMarker, endMarker, label) => {
      const start = source.indexOf(startMarker);
      const end = source.indexOf(endMarker, start + startMarker.length);
      assert.ok(start >= 0 && end > start, `${label} result-acceptance handler must be present`);
      const handler = source.slice(start, end);
      const closureIndex = handler.indexOf("ensureAcceptedResultValueClosure(");
      const reuseIndex = handler.indexOf("ensureOneExperienceReuseReceipt(");
      assert.ok(closureIndex >= 0, `${label} acceptance must create its exact Value Closure`);
      assert.ok(
        reuseIndex > closureIndex,
        `${label} acceptance must record Experience Reuse only after its Value Closure exists`,
      );
    };
    assertAcceptanceReuseWiring(
      ipc,
      'ipcMain.handle("tasks:acceptResult"',
      'ipcMain.handle("oneSearch:search"',
      "Desktop",
    );
    assertAcceptanceReuseWiring(
      mobile,
      'case "tasks.acceptResult"',
      'case "tasks.latestResult"',
      "Mobile",
    );
    assert.match(preload, /oneExperienceReuse:[\s\S]{0,300}getState:[\s\S]{0,200}latestForTask:/);
    assert.doesNotMatch(preload, /oneExperienceReuse:[\s\S]{0,500}ensure/);
    assert.match(shell, /api\.oneExperienceReuse\.getState\(\)/);
    assert.match(shell, /valueClosureId === selectedValueClosure\.closure\.valueClosureId/);
    // REQ-019 / REQ-023: compounding records must stay out of the beginner-facing
    // One result (enforced by verify-agentlas-one-ui) while remaining openable and
    // manageable. The management home is the Memory sheet, which is already where
    // `onManageExperience` points. Asserting presence here instead of in the result
    // keeps this verifier from contradicting verify-agentlas-one-ui.
    assert.doesNotMatch(
      adaptive,
      /<OneValueClosureCard|<OneExperienceReuseCard|<OneImprovementProofCard/,
      "internal compounding records must stay out of the beginner-facing One result",
    );
    assert.match(memorySheet, /<OneValueClosureCard[\s\S]*<OneExperienceReuseCard[\s\S]*<OneImprovementProofCard/);
    assert.match(card, /One applied what worked well last time/);
    assert.match(card, /Whether this result improved is verified separately/);
    assert.match(card, /See what was applied/);
    assert.doesNotMatch(card, /assetId|rawMemory|source path/i);

    const corrupt = spawnSync(executable, [
      __filename,
      "--corrupt",
      `--user-data=${path.join(temp, "corrupt")}`,
    ], { env, encoding: "utf8" });
    if (corrupt.status !== 0) throw new Error(`Experience-reuse corrupt check failed\n${corrupt.stdout}\n${corrupt.stderr}`);
    process.stdout.write(corrupt.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--race")) {
  raceWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--corrupt")) {
  corruptWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
