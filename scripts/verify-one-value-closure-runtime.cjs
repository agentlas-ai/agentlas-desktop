#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function openStore() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires --user-data");
  app.setPath("userData", userData);
  await app.whenReady();
  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  return { app, db: dbStore.getDb() };
}

function insertTask(db, id, status = "completed", offsetMs = 0) {
  const now = new Date(Date.now() + offsetMs).toISOString();
  db.prepare(
    `INSERT INTO tasks
       (id, title, project_id, firm_id, status, created_at, updated_at, archived_at, origin_chat_id)
     VALUES (?, ?, NULL, NULL, ?, ?, ?, NULL, NULL)`,
  ).run(id, `Value Closure ${id}`, status, now, now);
  return Date.parse(now);
}

function evidence(taskId, taskVersion, suffix, kind, extra = {}) {
  return {
    evidenceRef: `evidence:${suffix}`,
    receiptRef: `receipt:${suffix}`,
    taskId,
    taskVersion,
    kind,
    source: extra.source ?? "host_connector",
    verificationStatus: extra.verificationStatus ?? "verified",
    observedAt: new Date().toISOString(),
    sourceRef: `source:${suffix}`,
    ...(extra.outcomeRef ? { outcomeRef: extra.outcomeRef } : {}),
    ...(extra.artifactRef ? { artifactRef: extra.artifactRef } : {}),
    ...(extra.sourceRunRef ? { sourceRunRef: extra.sourceRunRef } : {}),
  };
}

function verifiedInput(storeVersion, taskId, taskVersion, suffix = "verified") {
  const outcomeRef = `outcome:${suffix}`;
  const originalA = `artifact:${suffix}:original:a`;
  const originalB = `artifact:${suffix}:original:b`;
  const trustedHostEvidence = [
    evidence(taskId, taskVersion, `${suffix}:discovery`, "discovery_receipt"),
    evidence(taskId, taskVersion, `${suffix}:preparation`, "preparation_receipt"),
    evidence(taskId, taskVersion, `${suffix}:outcome`, "outcome_verification", {
      outcomeRef,
      source: "artifact_verifier",
    }),
    evidence(taskId, taskVersion, `${suffix}:baseline`, "estimate_baseline"),
    evidence(taskId, taskVersion, `${suffix}:original:a`, "original_preservation", {
      artifactRef: originalA,
      source: "filesystem_guard",
    }),
    evidence(taskId, taskVersion, `${suffix}:original:b`, "original_preservation", {
      artifactRef: originalB,
      source: "filesystem_guard",
    }),
  ];
  return {
    expectedStoreVersion: storeVersion,
    trustedHostAttested: true,
    taskId,
    expectedTaskVersion: taskVersion,
    outcomeStatus: "verified",
    outcomeRefs: [outcomeRef],
    lifecycleClaims: [
      {
        phase: "discovery",
        status: "completed",
        summary: "The comparison candidates and authoritative specifications were found.",
        evidenceRefs: [`evidence:${suffix}:discovery`],
      },
      {
        phase: "preparation",
        status: "completed",
        summary: "Prices and room sizes were normalized to one comparison basis.",
        evidenceRefs: [`evidence:${suffix}:preparation`],
      },
      {
        phase: "execution",
        status: "not_applicable",
        summary: "No purchase, publication, or external transmission was performed.",
        evidenceRefs: [],
      },
      {
        phase: "verification",
        status: "completed",
        summary: "The comparison result and its evidence links were verified.",
        evidenceRefs: [`evidence:${suffix}:outcome`],
      },
    ],
    valueItems: [
      {
        valueItemId: `value:${suffix}:comparison`,
        kind: "fact",
        statement: "The three candidates can now be reviewed on the same verified basis.",
        evidenceRefs: [`evidence:${suffix}:outcome`],
      },
      {
        valueItemId: `value:${suffix}:estimate`,
        kind: "estimate",
        statement: "Review time is estimated to be 35 minutes lower.",
        estimate: {
          value: 35,
          unit: "minutes",
          basis: "A prior user-recorded review took 52 minutes and this review took 17 minutes.",
          method: "The current 17 minutes were subtracted from the prior 52 minutes.",
          evidenceRefs: [`evidence:${suffix}:baseline`],
        },
      },
    ],
    originalPreservation: {
      status: "preserved",
      artifactRefs: [originalA, originalB],
      receiptRefs: [`receipt:${suffix}:original:a`, `receipt:${suffix}:original:b`],
    },
    remainingWork: [
      {
        itemRef: `remaining:${suffix}:decision`,
        action: "The user still needs to decide whether to purchase a candidate.",
        owner: "user",
        status: "pending",
      },
    ],
    receiptRefs: trustedHostEvidence.map((item) => item.receiptRef),
    reflectionEligible: true,
    trustedHostEvidence,
  };
}

function partialInput(storeVersion, taskId, taskVersion, suffix = "partial") {
  const outcomeRef = `outcome:${suffix}`;
  const trustedHostEvidence = [
    evidence(taskId, taskVersion, `${suffix}:observation`, "outcome_verification", {
      outcomeRef,
      source: "explicit_user_observation",
      verificationStatus: "partially_verified",
    }),
    evidence(taskId, taskVersion, `${suffix}:baseline`, "estimate_baseline", {
      source: "explicit_user_observation",
      verificationStatus: "partially_verified",
    }),
  ];
  return {
    expectedStoreVersion: storeVersion,
    trustedHostAttested: true,
    taskId,
    expectedTaskVersion: taskVersion,
    outcomeStatus: "partially_verified",
    outcomeRefs: [outcomeRef],
    lifecycleClaims: [
      { phase: "discovery", status: "not_started", summary: "Discovery was outside this check.", evidenceRefs: [] },
      { phase: "preparation", status: "not_started", summary: "Preparation was outside this check.", evidenceRefs: [] },
      { phase: "execution", status: "not_applicable", summary: "No external action was performed by One.", evidenceRefs: [] },
      {
        phase: "verification",
        status: "in_progress",
        summary: "The user observed the change, but the host has not independently verified it.",
        evidenceRefs: [`evidence:${suffix}:observation`],
      },
    ],
    valueItems: [
      {
        valueItemId: `value:${suffix}:estimate`,
        kind: "estimate",
        statement: "The possible time reduction remains an estimate.",
        estimate: {
          lowerBound: 10,
          upperBound: 20,
          unit: "minutes",
          basis: "The user supplied a rough prior range.",
          method: "The current rough range was compared with that prior range.",
          evidenceRefs: [`evidence:${suffix}:baseline`],
        },
      },
    ],
    originalPreservation: { status: "not_applicable", artifactRefs: [], receiptRefs: [] },
    remainingWork: [
      {
        itemRef: `remaining:${suffix}:host-check`,
        action: "A host connector still needs to verify the external state.",
        owner: "one",
        status: "pending",
      },
    ],
    receiptRefs: trustedHostEvidence.map((item) => item.receiptRef),
    reflectionEligible: false,
    trustedHostEvidence,
  };
}

function raceInput(storeVersion, taskId, taskVersion, suffix) {
  const base = verifiedInput(storeVersion, taskId, taskVersion, `race:${suffix}`);
  base.valueItems = [base.valueItems[0]];
  base.trustedHostEvidence = base.trustedHostEvidence.filter((item) => item.kind !== "estimate_baseline");
  base.receiptRefs = base.trustedHostEvidence.map((item) => item.receiptRef);
  return base;
}

function entries(event) {
  return Object.fromEntries(event.payload.entries.map((item) => [item.name, item.value]));
}

async function seedWorker() {
  const { app, db } = await openStore();
  const storePath = process.env.AGENTLAS_STORE_PATH;
  assert.ok(storePath && fs.existsSync(storePath));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(storePath).mode & 0o077, 0, "the SQLite store must remain mode 0600");
  }

  const closureRuntime = require("../dist/electron/one/value-closure.js");
  const contract = require("../dist/shared/one-value-closure.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const beforeUserVersion = db.pragma("user_version", { simple: true });
  const initial = closureRuntime.getOneValueClosureState();
  assert.equal(db.pragma("user_version", { simple: true }), beforeUserVersion, "Value Closure must not add a migration");
  assert.deepEqual(initial.closures, []);

  const validFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../Agentlas_One/contracts/fixtures/valid/value-closure-verified.json"), "utf8"));
  const invalidFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../../Agentlas_One/contracts/fixtures/invalid/value-closure-unverified-execution-claim.json"), "utf8"));
  // The schema fixture uses a human-readable closure id. The runtime uses a
  // generated opaque id, while every other field follows the published contract.
  validFixture.valueClosureId = "value_closure_11111111111111111111111111111111";
  invalidFixture.valueClosureId = "value_closure_22222222222222222222222222222222";
  assert.equal(contract.isOneValueClosureV1(validFixture), true);
  assert.equal(contract.isOneValueClosureV1({ ...validFixture, extraPrivatePayload: "forbidden" }), false);
  assert.equal(contract.isOneValueClosureV1(invalidFixture), false, "completed execution/verification without evidence must fail closed");

  const verifiedTaskVersion = insertTask(db, "task_value_verified", "completed");
  assert.equal(closureRuntime.listOneValueClosures("task_value_verified").length, 0, "Task completion alone must not create a Value Closure");
  assert.equal(domainEvents.listOneDomainEvents("task_value_verified", 100).some((event) => event.eventType === "outcome.verified"), false);

  const base = verifiedInput(initial.version, "task_value_verified", verifiedTaskVersion);
  assert.throws(
    () => closureRuntime.createOneValueClosure({ ...base, rendererPrivatePayload: "forbidden" }),
    /unsupported fields/,
  );
  assert.throws(
    () => closureRuntime.createOneValueClosure({ ...base, trustedHostAttested: false }),
    /trusted host attestation/,
  );
  assert.throws(
    () => closureRuntime.createOneValueClosure({ ...base, trustedHostEvidence: [] }),
    /1-128 attestations/,
  );
  assert.throws(
    () => closureRuntime.createOneValueClosure({ ...base, expectedTaskVersion: verifiedTaskVersion - 1 }),
    /Canonical Task changed/,
  );
  for (const [text, reason] of [
    ["Use password=private-value to verify this result.", "secret"],
    ["Read /Users/example/private/customer.csv to verify this result.", "local_path"],
    ["Open https://private.example.test/results before continuing.", "transport_or_markup"],
    ["user: private transcript\nassistant: copied result", "raw_transcript"],
    ["Send the result to private.person@example.test.", "private_data"],
  ]) {
    const unsafe = structuredClone(base);
    unsafe.valueItems[0].statement = text;
    assert.throws(() => closureRuntime.createOneValueClosure(unsafe), new RegExp(reason));
  }
  assert.equal(closureRuntime.getOneValueClosureState().version, initial.version, "rejected inputs must not mutate state");

  const unsupportedClaim = structuredClone(base);
  unsupportedClaim.outcomeRefs = ["outcome:false-send"];
  unsupportedClaim.trustedHostEvidence = [
    evidence("task_value_verified", verifiedTaskVersion, "false-send:preparation", "preparation_receipt"),
    evidence("task_value_verified", verifiedTaskVersion, "false-send:outcome", "outcome_verification", {
      outcomeRef: "outcome:false-send",
      source: "artifact_verifier",
    }),
  ];
  unsupportedClaim.receiptRefs = unsupportedClaim.trustedHostEvidence.map((item) => item.receiptRef);
  unsupportedClaim.lifecycleClaims = [
    { phase: "discovery", status: "not_started", summary: "Discovery was outside this test.", evidenceRefs: [] },
    { phase: "preparation", status: "completed", summary: "The document was prepared.", evidenceRefs: ["evidence:false-send:preparation"] },
    { phase: "execution", status: "not_applicable", summary: "No transmission was executed.", evidenceRefs: [] },
    { phase: "verification", status: "completed", summary: "The prepared artifact was verified.", evidenceRefs: ["evidence:false-send:outcome"] },
  ];
  unsupportedClaim.valueItems = [{
    valueItemId: "value:false-send",
    kind: "fact",
    statement: "The document was sent successfully.",
    evidenceRefs: ["evidence:false-send:preparation"],
  }];
  unsupportedClaim.originalPreservation = { status: "not_applicable", artifactRefs: [], receiptRefs: [] };
  assert.throws(
    () => closureRuntime.createOneValueClosure(unsupportedClaim),
    /execution\/outcome claim without matching evidence/,
    "a prepared artifact must never prove an external send",
  );

  const created = closureRuntime.createOneValueClosure(base);
  assert.equal(created.value.closure.outcomeStatus, "verified");
  assert.equal(created.value.closure.reflection.userOptedIn, false);
  assert.equal(created.value.closure.reflection.included, false, "reflection must be opt-in even when eligible");
  assert.equal(created.value.taskVersion, verifiedTaskVersion);
  assert.deepEqual(created.value.closure.receiptRefs, base.receiptRefs);

  const outcomeEvent = domainEvents.listOneDomainEvents("outcome:verified", 20).find((event) => event.eventType === "outcome.verified");
  assert.ok(outcomeEvent, "outcome.verified must be durable");
  assert.deepEqual(Object.keys(entries(outcomeEvent)).sort(), ["evidenceRefs", "outcomeId", "remainingWork", "status"]);
  assert.equal(entries(outcomeEvent).status, "verified");
  assert.equal(outcomeEvent.taskId, "task_value_verified");
  const closureEvent = domainEvents.listOneDomainEvents(created.value.closure.valueClosureId, 20)
    .find((event) => event.eventType === "value_closure.ready");
  assert.ok(closureEvent, "value_closure.ready must be durable");
  assert.deepEqual(Object.keys(entries(closureEvent)).sort(), ["artifactRefs", "estimateRefs", "outcomeRefs", "valueClosureRef"]);
  assert.equal(closureEvent.taskId, "task_value_verified");
  for (const item of base.trustedHostEvidence) {
    assert.ok(domainEvents.listOneDomainEvents(item.evidenceRef, 10).some((event) => event.eventType === "receipt.recorded"));
  }

  assert.throws(
    () => closureRuntime.setOneValueClosureReflection({
      expectedStoreVersion: created.storeVersion,
      valueClosureId: created.value.closure.valueClosureId,
      expectedClosureVersion: created.value.version,
      userOptedIn: false,
      included: true,
      confirmedByUser: true,
    }),
    /eligibility and explicit opt-in/,
  );
  const reflected = closureRuntime.setOneValueClosureReflection({
    expectedStoreVersion: created.storeVersion,
    valueClosureId: created.value.closure.valueClosureId,
    expectedClosureVersion: created.value.version,
    userOptedIn: true,
    included: true,
    confirmedByUser: true,
  });
  assert.equal(reflected.value.closure.reflection.included, true);

  const partialTaskVersion = insertTask(db, "task_value_partial", "running", 1);
  const partial = closureRuntime.createOneValueClosure(partialInput(
    reflected.storeVersion,
    "task_value_partial",
    partialTaskVersion,
  ));
  assert.equal(partial.value.closure.outcomeStatus, "partially_verified");
  assert.equal(partial.value.closure.lifecycleClaims[2].status, "not_applicable");
  assert.equal(partial.value.closure.lifecycleClaims[3].status, "in_progress");
  assert.equal(partial.value.closure.valueItems[0].kind, "estimate");
  assert.equal(partial.value.closure.originalPreservation.status, "not_applicable");
  assert.equal(partial.value.closure.reflection.eligible, false);

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(closureRuntime.ONE_VALUE_CLOSURE_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", closureRuntime.ONE_VALUE_CLOSURE_META_KEY);
  assert.throws(() => closureRuntime.getOneValueClosureState(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(closureRuntime.ONE_VALUE_CLOSURE_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, closureRuntime.ONE_VALUE_CLOSURE_META_KEY);

  const raceTaskVersion = insertTask(db, "task_value_race", "completed", 2);
  const finalState = closureRuntime.getOneValueClosureState();
  console.log(JSON.stringify({
    ok: true,
    storeVersion: finalState.version,
    raceTaskVersion,
    verifiedClosureId: created.value.closure.valueClosureId,
    closures: finalState.closures.length,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/value-closure.js");
  const suffix = argument("--suffix");
  try {
    const result = runtime.createOneValueClosure(raceInput(
      Number(argument("--store-version")),
      "task_value_race",
      Number(argument("--task-version")),
      suffix,
    ));
    console.log(JSON.stringify({ success: true, suffix, storeVersion: result.storeVersion, closureId: result.value.closure.valueClosureId }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, suffix, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/value-closure.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const winnerId = argument("--winner-id");
  const state = runtime.getOneValueClosureState();
  assert.equal(state.closures.length, 3, "two seeded closures plus exactly one CAS winner must persist");
  const winner = state.closures.find((item) => item.closure.valueClosureId === winnerId);
  assert.ok(winner, "the CAS winner must survive a fresh Electron process");
  assert.equal(winner.closure.taskId, "task_value_race");
  assert.ok(domainEvents.listOneDomainEvents(winnerId, 20).some((event) => event.eventType === "value_closure.ready"));
  assert.ok(winner.closure.valueItems.every((item) => item.kind === "fact"));
  assert.equal(JSON.stringify(state).includes("password="), false);
  assert.equal(JSON.stringify(state).includes("/Users/"), false);
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, closures: state.closures.length, winnerId }));
  db.close();
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-value-closure-"));
  const storePath = path.join(temp, "value-closure.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`Value Closure seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);

    const common = [
      __filename,
      "--race",
      `--store-version=${seeded.storeVersion}`,
      `--task-version=${seeded.raceTaskVersion}`,
    ];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, "--suffix=a", `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, "--suffix=b", `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`Value Closure race process failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS writer must succeed");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    const winner = outcomes.find((item) => item.success);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const reload = spawnSync(
      executable,
      [
        __filename,
        "--reload",
        `--winner-id=${winner.closureId}`,
        `--user-data=${path.join(temp, "reload-user-data")}`,
      ],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`Value Closure reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
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
