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
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  return { app, db: store.getDb() };
}

function iso(value) { return new Date(value).toISOString(); }
function idHex(index) { return index.toString(16).padStart(32, "0"); }

function makeVerifiedBundle(index, generatedAt, options = {}) {
  const taskId = `task:weekly:${index}`;
  const taskVersion = Date.parse(generatedAt) + index + 1;
  const suffix = `weekly:${index}`;
  const outcomeRef = `outcome:${suffix}`;
  const artifactRef = `artifact:${suffix}:original`;
  const factEvidenceRef = `evidence:${suffix}:outcome`;
  const factReceiptRef = `receipt:${suffix}:outcome`;
  const estimateEvidenceRef = `evidence:${suffix}:baseline`;
  const estimateArtifactRef = `artifact:${suffix}:baseline`;
  const preservationEvidenceRef = `evidence:${suffix}:preserved`;
  const preservationReceiptRef = `receipt:${suffix}:preserved`;
  const observedAt = options.evidenceObservedAt ?? generatedAt;
  const evidence = [
    {
      evidenceRef: factEvidenceRef,
      receiptRef: factReceiptRef,
      taskId,
      taskVersion,
      kind: "outcome_verification",
      source: "host_connector",
      verificationStatus: "verified",
      observedAt,
      sourceRef: `source:${suffix}:outcome`,
      outcomeRef,
    },
    {
      evidenceRef: estimateEvidenceRef,
      receiptRef: `receipt:${suffix}:baseline`,
      taskId,
      taskVersion,
      kind: "estimate_baseline",
      source: "host_connector",
      verificationStatus: "verified",
      observedAt,
      sourceRef: `source:${suffix}:baseline`,
      artifactRef: estimateArtifactRef,
    },
    {
      evidenceRef: preservationEvidenceRef,
      receiptRef: preservationReceiptRef,
      taskId,
      taskVersion,
      kind: "original_preservation",
      source: "filesystem_guard",
      verificationStatus: "verified",
      observedAt,
      sourceRef: `source:${suffix}:preserved`,
      artifactRef,
    },
  ];
  const closure = {
    contractVersion: "1.0.0",
    valueClosureId: `value_closure_${idHex(index)}`,
    taskId,
    status: "ready",
    outcomeStatus: options.outcomeStatus ?? "verified",
    generatedAt,
    outcomeRefs: [outcomeRef],
    lifecycleClaims: [
      { phase: "discovery", status: "not_started", summary: "Discovery was outside this verified check.", evidenceRefs: [] },
      { phase: "preparation", status: "not_started", summary: "Preparation was outside this verified check.", evidenceRefs: [] },
      { phase: "execution", status: "not_applicable", summary: "No external execution was required for this check.", evidenceRefs: [] },
      {
        phase: "verification",
        status: options.outcomeStatus === "partially_verified" ? "in_progress" : "completed",
        summary: options.outcomeStatus === "partially_verified" ? "Host verification remains incomplete." : "The outcome was verified by the host boundary.",
        evidenceRefs: [factEvidenceRef],
      },
    ],
    valueItems: [
      {
        valueItemId: `value:${suffix}:fact`,
        kind: "fact",
        statement: `Verified change ${index} is ready for review.`,
        // Exercise the same alias resolver as Value Closure: a fact may cite a receipt.
        evidenceRefs: [factReceiptRef],
      },
      {
        valueItemId: `value:${suffix}:estimate`,
        kind: "estimate",
        statement: `Estimated review effort for change ${index}.`,
        estimate: {
          value: 12 + index,
          unit: "minutes",
          basis: "A verified baseline receipt recorded the prior review duration.",
          method: "The current duration was subtracted from the verified prior duration.",
          // Exercise artifact-ref resolution without relabeling the projected ref.
          evidenceRefs: [estimateArtifactRef],
        },
      },
    ],
    originalPreservation: {
      status: "preserved",
      artifactRefs: [artifactRef],
      receiptRefs: [preservationReceiptRef],
    },
    remainingWork: [{
      itemRef: `remaining:${suffix}:check`,
      action: `Confirm the next check for change ${index}.`,
      owner: "user",
      status: "pending",
    }],
    receiptRefs: evidence.map((item) => item.receiptRef),
    reflection: {
      eligible: options.eligible ?? true,
      userOptedIn: options.optedIn ?? true,
      included: options.included ?? true,
    },
  };
  if (options.outcomeStatus === "partially_verified") {
    evidence[0].source = "explicit_user_observation";
    evidence[0].verificationStatus = "partially_verified";
    closure.valueItems = [closure.valueItems[1]];
    closure.reflection = { eligible: false, userOptedIn: false, included: false };
  }
  return {
    evidence,
    record: {
      closure,
      version: 2,
      taskVersion,
      trustedEvidenceRefs: evidence.map((item) => item.evidenceRef),
      artifactRefs: [artifactRef, estimateArtifactRef],
      estimateRefs: [estimateArtifactRef],
      createdAt: generatedAt,
      updatedAt: generatedAt,
    },
  };
}

function makeState(bundles, timestamp) {
  return {
    contractVersion: "1.0.0",
    version: Math.max(1, Date.parse(timestamp)),
    evidence: bundles.flatMap((item) => item.evidence),
    closures: bundles.map((item) => item.record),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function correctionEvent(category, occurredAt, index = 1) {
  return {
    contractVersion: "1.0.0",
    eventId: `event:weekly:correction:${index}`,
    eventType: "briefing.dismissed",
    occurredAt,
    actor: "user",
    entityId: `briefing:weekly:${index}`,
    version: 1,
    visibility: "personal",
    payload: { entries: [
      { name: "reasonCategory", value: category },
      { name: "suppressionScope", value: "source" },
    ] },
  };
}

function pureContractChecks(runtime, contract) {
  const spring = runtime.getOneIsoWeekWindow({
    now: new Date("2026-03-08T17:00:00.000Z"),
    profile: { timeZone: "America/New_York" },
  });
  assert.equal(spring.weekKey, "2026-W10");
  assert.equal(spring.periodStart, "2026-03-02T05:00:00.000Z");
  assert.equal(spring.periodEnd, "2026-03-09T04:00:00.000Z");
  assert.equal((Date.parse(spring.periodEnd) - Date.parse(spring.periodStart)) / 3_600_000, 167, "spring DST week is 167 hours");
  const fall = runtime.getOneIsoWeekWindow({
    now: new Date("2026-11-01T17:00:00.000Z"),
    profile: { timeZone: "America/New_York" },
  });
  assert.equal(fall.periodStart, "2026-10-26T04:00:00.000Z");
  assert.equal(fall.periodEnd, "2026-11-02T05:00:00.000Z");
  assert.equal((Date.parse(fall.periodEnd) - Date.parse(fall.periodStart)) / 3_600_000, 169, "fall DST week is 169 hours");
  const tokyo = runtime.getOneIsoWeekWindow({
    now: new Date("2026-07-19T15:30:00.000Z"),
    profile: { timeZone: "Asia/Tokyo" },
  });
  assert.equal(tokyo.weekKey, "2026-W30", "local Monday must not use the still-Sunday UTC week");
  const systemFallback = runtime.getOneIsoWeekWindow({
    now: new Date("2026-07-15T12:00:00.000Z"),
    profile: { timeZone: "Mars/Olympus" },
    systemTimeZone: "Asia/Seoul",
  });
  assert.equal(systemFallback.timeZone, "Asia/Seoul");
  assert.equal(systemFallback.timeZoneSource, "system");
  const utcFallback = runtime.getOneIsoWeekWindow({
    now: new Date("2026-07-15T12:00:00.000Z"),
    profile: { timeZone: "Mars/Olympus" },
    systemTimeZone: "not/a-zone",
  });
  assert.equal(utcFallback.timeZone, "UTC");
  assert.equal(utcFallback.timeZoneSource, "utc");

  const now = new Date("2026-07-15T12:00:00.000Z");
  const current = Array.from({ length: 6 }, (_, index) => makeVerifiedBundle(
    index + 1,
    iso(now.getTime() - (index + 1) * 60_000),
  ));
  const partial = makeVerifiedBundle(20, iso(now.getTime() - 20 * 60_000), { outcomeStatus: "partially_verified" });
  const noOptIn = makeVerifiedBundle(21, iso(now.getTime() - 21 * 60_000), { optedIn: false, included: false });
  const futureClosure = makeVerifiedBundle(22, iso(now.getTime() + 10 * 60_000));
  const futureEvidence = makeVerifiedBundle(23, iso(now.getTime() - 30 * 60_000), {
    evidenceObservedAt: iso(now.getTime() + 10 * 60_000),
  });
  const state = makeState([...current, partial, noOptIn, futureClosure, futureEvidence], iso(now.getTime() - 40 * 60_000));
  assert.equal(contract.isOneValueClosureState(state), true, "hostile projection state remains structurally valid");
  const reflection = runtime.buildOneWeeklyReflection({
    now,
    profile: { timeZone: "UTC" },
    valueClosureState: state,
    correctionEvents: [
      correctionEvent("wrong", iso(now.getTime() - 1_000), 1),
      correctionEvent("not_important", iso(now.getTime() - 2_000), 2),
      correctionEvent("later", iso(now.getTime() - 3_000), 3),
      correctionEvent("wrong", iso(now.getTime() + 10 * 60_000), 4),
      { ...correctionEvent("wrong", iso(now.getTime() - 4_000), 5), rawSource: "private source must never project" },
    ],
  });
  assert.ok(reflection);
  assert.equal(reflection.outcomes.length, 5, "only the latest five eligible verified Outcomes project");
  assert.deepEqual(reflection.corrections, { wrong: 2, notImportant: 1 });
  assert.equal(reflection.outcomes.some((item) => item.valueClosureRef === futureClosure.record.closure.valueClosureId), false, "future closure is omitted");
  assert.equal(reflection.outcomes.some((item) => item.valueClosureRef === futureEvidence.record.closure.valueClosureId), false, "future underlying evidence is omitted");
  assert.equal(reflection.outcomes[0].facts[0].evidenceRefs[0].startsWith("receipt:"), true, "receipt aliases stay unchanged");
  assert.equal(reflection.outcomes[0].estimates[0].evidenceRefs[0].startsWith("artifact:"), true, "artifact aliases stay unchanged");
  assert.equal(reflection.selectionBasis, "latest_included_verified_outcome");
  assert.equal(JSON.stringify(reflection).includes("rawSource"), false);
  assert.equal(contract.isOneWeeklyReflectionV1(reflection), true);
  const unsupportedCompletion = structuredClone(state);
  const unsupportedRecord = unsupportedCompletion.closures.find((item) => item.closure.valueClosureId === current[0].record.closure.valueClosureId);
  unsupportedRecord.closure.valueItems[0].statement = "The result was sent successfully.";
  unsupportedRecord.closure.valueItems[0].evidenceRefs = [current[0].record.closure.valueItems[1].estimate.evidenceRefs[0]];
  assert.equal(contract.isOneValueClosureState(unsupportedCompletion), true, "hostile completion claim remains structurally valid");
  const guarded = runtime.buildOneWeeklyReflection({ now, profile: { timeZone: "UTC" }, valueClosureState: unsupportedCompletion, correctionEvents: [] });
  assert.equal(guarded.outcomes.some((item) => item.valueClosureRef === unsupportedRecord.closure.valueClosureId), false, "completion claim without outcome/execution evidence is omitted");
  assert.equal(runtime.buildOneWeeklyReflection({ now, profile: { timeZone: "UTC" }, valueClosureState: makeState([], now.toISOString()), correctionEvents: [] }), null);
  assert.equal(runtime.buildOneWeeklyReflection({ now, profile: { timeZone: "UTC" }, valueClosureState: makeState([partial, noOptIn], now.toISOString()), correctionEvents: [] }), null);

  const receipt = {
    weekKey: reflection.weekKey,
    reflectionId: reflection.reflectionId,
    contentDigest: reflection.contentDigest,
    status: "acknowledged",
    updatedAt: now.toISOString(),
  };
  const acknowledged = runtime.buildOneWeeklyReflection({ now, profile: { timeZone: "UTC" }, valueClosureState: state, correctionEvents: [], receipt });
  assert.equal(acknowledged.status, "open", "content-bound receipts cannot hide changed correction content");

  const newerOutcome = makeVerifiedBundle(24, iso(now.getTime() - 30_000));
  const expandedState = makeState(
    [...current, partial, noOptIn, futureClosure, futureEvidence, newerOutcome],
    iso(now.getTime() - 40 * 60_000),
  );
  const acknowledgedAfterNewOutcome = runtime.buildOneWeeklyReflection({
    now,
    profile: { timeZone: "UTC" },
    valueClosureState: expandedState,
    correctionEvents: [],
    receipt,
  });
  assert.ok(acknowledgedAfterNewOutcome);
  assert.notEqual(acknowledgedAfterNewOutcome.contentDigest, receipt.contentDigest, "a newly verified Outcome changes weekly content");
  assert.equal(acknowledgedAfterNewOutcome.status, "open", "acknowledgement reopens when verified weekly content changes");
  const hiddenAfterNewOutcome = runtime.buildOneWeeklyReflection({
    now,
    profile: { timeZone: "UTC" },
    valueClosureState: expandedState,
    correctionEvents: [],
    receipt: { ...receipt, status: "hidden" },
  });
  assert.ok(hiddenAfterNewOutcome);
  assert.notEqual(hiddenAfterNewOutcome.reflectionId, receipt.reflectionId, "the hostile fixture exercises a new reflection identity");
  assert.equal(hiddenAfterNewOutcome.status, "hidden", "hide-for-this-week survives new verified content in the same local week");

  for (const unsafe of ["Use password=private-value", "Read /Users/example/private.txt"]) {
    const tampered = structuredClone(state);
    tampered.closures[0].closure.valueItems[0].statement = unsafe;
    assert.throws(
      () => runtime.buildOneWeeklyReflection({ now, profile: { timeZone: "UTC" }, valueClosureState: tampered, correctionEvents: [] }),
      /closed renderer contract/,
      "unsafe stored text must fail closed before renderer projection",
    );
  }
}

async function seedWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/weekly-reflection.js");
  const valueContract = require("../dist/shared/one-value-closure.js");
  const weeklyContract = require("../dist/shared/one-weekly-reflection.js");
  const profileStore = require("../dist/electron/store/one-profile.js");
  const domain = require("../dist/electron/one/domain-events.js");
  const closureRuntime = require("../dist/electron/one/value-closure.js");
  pureContractChecks(runtime, { ...valueContract, ...weeklyContract });

  const profile = profileStore.getOneProfile();
  if (profile.timeZone !== "UTC") profileStore.updateOneProfile({ expectedVersion: profile.version, patch: { timeZone: "UTC" } });
  const now = new Date();
  const window = runtime.getOneIsoWeekWindow({ now, profile: { timeZone: "UTC" } });
  const start = Date.parse(window.periodStart);
  const available = Math.max(8_000, now.getTime() - start);
  const bundles = Array.from({ length: 6 }, (_, index) => makeVerifiedBundle(
    100 + index,
    iso(now.getTime() - Math.min((index + 1) * 1_000, available - 1_000)),
  ));
  const state = makeState(bundles, iso(Math.max(start, now.getTime() - 10_000)));
  assert.equal(valueContract.isOneValueClosureState(state), true);
  closureRuntime.getOneValueClosureState();
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(JSON.stringify(state), closureRuntime.ONE_VALUE_CLOSURE_META_KEY);
  domain.recordOneDomainEvent({
    eventId: "event:weekly-live-wrong",
    eventType: "briefing.dismissed",
    occurredAt: iso(now.getTime() - 500),
    actor: "user",
    entityId: "briefing:weekly-live-wrong",
    version: 1,
    visibility: "personal",
    entries: [
      { name: "reasonCategory", value: "wrong" },
      { name: "suppressionScope", value: "source" },
    ],
  });
  const offsetInstant = new Date(now.getTime() - 400);
  const offsetLocal = new Date(offsetInstant.getTime() + 9 * 60 * 60 * 1_000).toISOString().replace("Z", "+09:00");
  domain.recordOneDomainEvent({
    eventId: "event:weekly-live-not-important-offset",
    eventType: "briefing.dismissed",
    occurredAt: offsetLocal,
    actor: "user",
    entityId: "briefing:weekly-live-not-important-offset",
    version: 1,
    visibility: "personal",
    entries: [
      { name: "reasonCategory", value: "not_important" },
      { name: "suppressionScope", value: "source" },
    ],
  });
  const snapshot = runtime.getOneWeeklyReflectionSnapshot();
  assert.ok(snapshot.reflection);
  assert.equal(snapshot.reflection.status, "open");
  assert.equal(snapshot.reflection.outcomes.length, 5);
  assert.equal(snapshot.reflection.corrections.wrong, 1);
  assert.equal(snapshot.reflection.corrections.notImportant, 1, "offset timestamps use instant semantics at the week boundary");
  assert.equal(weeklyContract.isOneWeeklyReflectionSnapshotV1(snapshot), true);
  assert.throws(() => runtime.resolveOneWeeklyReflection({
    expectedStateVersion: snapshot.stateVersion,
    reflectionId: snapshot.reflection.reflectionId,
    weekKey: snapshot.reflection.weekKey,
    expectedContentDigest: "f".repeat(64),
    action: "acknowledge",
    confirmedByUser: true,
  }), /changed/);
  assert.throws(() => runtime.resolveOneWeeklyReflection({
    expectedStateVersion: snapshot.stateVersion,
    reflectionId: snapshot.reflection.reflectionId,
    weekKey: snapshot.reflection.weekKey,
    expectedContentDigest: snapshot.reflection.contentDigest,
    action: "acknowledge",
    confirmedByUser: true,
    unsupported: "private",
  }), /closed contract/);
  assert.equal(runtime.getOneWeeklyReflectionSnapshot().stateVersion, snapshot.stateVersion, "stale and expanded actions do not mutate state");
  console.log(JSON.stringify({
    ok: true,
    stateVersion: snapshot.stateVersion,
    reflectionId: snapshot.reflection.reflectionId,
    weekKey: snapshot.reflection.weekKey,
    contentDigest: snapshot.reflection.contentDigest,
    outcomes: snapshot.reflection.outcomes.length,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/weekly-reflection.js");
  const action = argument("--action");
  try {
    const snapshot = runtime.resolveOneWeeklyReflection({
      expectedStateVersion: Number(argument("--state-version")),
      reflectionId: argument("--reflection-id"),
      weekKey: argument("--week-key"),
      expectedContentDigest: argument("--content-digest"),
      action,
      confirmedByUser: true,
    });
    console.log(JSON.stringify({ success: true, action, status: snapshot.reflection?.status, stateVersion: snapshot.stateVersion }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, action, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/weekly-reflection.js");
  const expectedStatus = argument("--expected-status");
  const snapshot = runtime.getOneWeeklyReflectionSnapshot();
  assert.equal(snapshot.reflection?.status, expectedStatus, "winning weekly action survives restart");
  assert.equal(JSON.stringify(snapshot).includes("password="), false);
  assert.equal(JSON.stringify(snapshot).includes("/Users/"), false);
  const before = db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_WEEKLY_REFLECTION_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", runtime.ONE_WEEKLY_REFLECTION_META_KEY);
  assert.throws(() => runtime.getOneWeeklyReflectionSnapshot(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_WEEKLY_REFLECTION_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(before, runtime.ONE_WEEKLY_REFLECTION_META_KEY);
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, status: expectedStatus }));
  db.close();
  app.quit();
}

function lastJson(output) {
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-weekly-reflection-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "weekly-reflection.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`], { env, encoding: "utf8" });
    if (seed.status !== 0) throw new Error(`Weekly reflection seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = lastJson(seed.stdout);
    const common = [
      __filename,
      "--race",
      `--state-version=${seeded.stateVersion}`,
      `--reflection-id=${seeded.reflectionId}`,
      `--week-key=${seeded.weekKey}`,
      `--content-digest=${seeded.contentDigest}`,
    ];
    const [ack, hide] = await Promise.all([
      runAsync(executable, [...common, "--action=acknowledge", `--user-data=${path.join(temp, "race-ack")}`], env),
      runAsync(executable, [...common, "--action=hide_week", `--user-data=${path.join(temp, "race-hide")}`], env),
    ]);
    if (ack.status !== 0) throw new Error(`Weekly reflection acknowledge race crashed\n${ack.stdout}\n${ack.stderr}`);
    if (hide.status !== 0) throw new Error(`Weekly reflection hide race crashed\n${hide.stdout}\n${hide.stderr}`);
    const races = [lastJson(ack.stdout), lastJson(hide.stdout)];
    assert.equal(races.filter((item) => item.success).length, 1, "conflicting actions have one CAS winner");
    assert.match(races.find((item) => !item.success).error, /state changed/);
    const winner = races.find((item) => item.success);
    const expectedStatus = winner.action === "acknowledge" ? "acknowledged" : "hidden";
    const repeated = spawnSync(executable, [...common, `--action=${winner.action}`, `--user-data=${path.join(temp, "idempotent")}`], { env, encoding: "utf8" });
    if (repeated.status !== 0) throw new Error(`Weekly reflection idempotent replay crashed\n${repeated.stdout}\n${repeated.stderr}`);
    assert.equal(lastJson(repeated.stdout).success, true, "exact stale replay is idempotent");
    const reload = spawnSync(executable, [__filename, "--reload", `--expected-status=${expectedStatus}`, `--user-data=${path.join(temp, "reload-user-data")}`], { env, encoding: "utf8" });
    if (reload.status !== 0) throw new Error(`Weekly reflection reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
    console.log(JSON.stringify({ ok: true, casWinner: winner.action, exactReplay: true, dstWeeks: [167, 169] }));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) seedWorker().catch((error) => { console.error(error); process.exitCode = 1; });
else if (process.argv.includes("--race")) raceWorker().catch((error) => { console.error(error); process.exitCode = 1; });
else if (process.argv.includes("--reload")) reloadWorker().catch((error) => { console.error(error); process.exitCode = 1; });
else orchestrate().catch((error) => { console.error(error); process.exitCode = 1; });
