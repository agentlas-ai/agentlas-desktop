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

function eventEntries(event) {
  return Object.fromEntries(event.payload.entries.map((item) => [item.name, item.value]));
}

async function seedWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/feature-intro.js");
  const contract = require("../dist/shared/one-feature-intro.js");
  const profileStore = require("../dist/electron/store/one-profile.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const storePath = process.env.AGENTLAS_STORE_PATH;

  assert.ok(storePath && fs.existsSync(storePath));
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(storePath).mode & 0o077, 0, "the SQLite store must remain mode 0600");
  }
  const schemaVersionBefore = db.pragma("user_version", { simple: true });
  const profile = profileStore.getOneProfile();
  const initial = runtime.getOneFeatureIntroState();
  assert.equal(db.pragma("user_version", { simple: true }), schemaVersionBefore, "Feature Intro must not add a migration");
  assert.equal(initial.oneId, profile.oneId, "Feature Intro must bind the persistent One identity");
  assert.equal(initial.currentIntroVersion, 1);
  assert.equal(initial.acknowledgedIntroVersion, 0);
  assert.deepEqual(initial.acknowledgements, []);
  assert.deepEqual(initial.deferrals, []);
  assert.equal(contract.isOneFeatureIntroState(initial), true);
  assert.equal(contract.isOneFeatureIntroState({ ...initial, rendererPrivatePayload: "forbidden" }), false);

  assert.throws(
    () => runtime.deferOneFeatureIntro({
      expectedStoreVersion: initial.version,
      introVersion: 1,
      blockingStateCategory: "pending_approval",
      rendererPrivatePayload: "forbidden",
    }),
    /unsupported fields/,
  );
  assert.throws(
    () => runtime.deferOneFeatureIntro({
      expectedStoreVersion: initial.version,
      introVersion: 1,
      blockingStateCategory: "anything_the_renderer_says",
    }),
    /blockingStateCategory/,
  );
  assert.throws(
    () => runtime.acknowledgeOneFeatureIntro({
      expectedStoreVersion: initial.version,
      introVersion: 2,
      resolution: "opened_one",
      confirmedByUser: true,
    }),
    /newer than this Desktop runtime/,
  );
  assert.equal(runtime.getOneFeatureIntroState().version, initial.version, "rejected input must not mutate state");

  const deferred = runtime.deferOneFeatureIntro({
    expectedStoreVersion: initial.version,
    introVersion: 1,
    blockingStateCategory: "pending_approval",
  });
  assert.ok(deferred.version > initial.version);
  assert.equal(deferred.acknowledgedIntroVersion, 0, "deferral must never acknowledge the introduction");
  assert.equal(deferred.deferrals.length, 1);

  const duplicate = runtime.deferOneFeatureIntro({
    expectedStoreVersion: initial.version,
    introVersion: 1,
    blockingStateCategory: "pending_approval",
  });
  assert.equal(duplicate.version, deferred.version, "same-category retries must not advance state");
  assert.equal(duplicate.deferrals.length, 1);
  const deferredEvents = domainEvents.listOneDomainEvents(profile.oneId, 100)
    .filter((event) => event.eventType === "feature_intro.deferred");
  assert.equal(deferredEvents.length, 1, "same-category retries must not emit event spam");
  assert.deepEqual(Object.keys(eventEntries(deferredEvents[0])).sort(), ["blockingStateCategory", "introVersion"]);
  assert.equal(eventEntries(deferredEvents[0]).blockingStateCategory, "pending_approval");
  assert.equal(eventEntries(deferredEvents[0]).introVersion, 1);

  console.log(JSON.stringify({
    ok: true,
    oneId: profile.oneId,
    storeVersion: deferred.version,
    deferrals: deferred.deferrals.length,
  }));
  db.close();
  app.quit();
}

async function raceWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/feature-intro.js");
  const category = argument("--category");
  try {
    const state = runtime.deferOneFeatureIntro({
      expectedStoreVersion: Number(argument("--store-version")),
      introVersion: 1,
      blockingStateCategory: category,
    });
    console.log(JSON.stringify({ success: true, category, storeVersion: state.version }));
  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      category,
      error: error instanceof Error ? error.message : String(error),
    }));
  }
  db.close();
  app.quit();
}

async function finalizeWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/feature-intro.js");
  const contract = require("../dist/shared/one-feature-intro.js");
  const profileStore = require("../dist/electron/store/one-profile.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const expectedOneId = argument("--one-id");

  const restored = runtime.getOneFeatureIntroState();
  assert.equal(restored.oneId, expectedOneId, "fresh process must keep the exact One binding");
  assert.equal(restored.deferrals.length, 2, "seed deferral plus exactly one CAS winner must persist");
  assert.equal(restored.acknowledgedIntroVersion, 0);

  assert.throws(
    () => runtime.deferOneFeatureIntro({
      expectedStoreVersion: Number(argument("--seed-version")),
      introVersion: 1,
      blockingStateCategory: "app_update",
    }),
    /changed|concurrently/,
    "a new mutation with a stale store version must fail closed",
  );
  assert.throws(
    () => runtime.acknowledgeOneFeatureIntro({
      expectedStoreVersion: restored.version,
      introVersion: 1,
      resolution: "kept_work",
      confirmedByUser: false,
    }),
    /explicit user confirmation/,
  );

  const acknowledged = runtime.acknowledgeOneFeatureIntro({
    expectedStoreVersion: restored.version,
    introVersion: 1,
    resolution: "kept_work",
    confirmedByUser: true,
  });
  assert.ok(acknowledged.version > restored.version);
  assert.equal(acknowledged.acknowledgedIntroVersion, 1);
  assert.equal(acknowledged.acknowledgements.length, 1);
  assert.equal(acknowledged.acknowledgements[0].resolution, "kept_work");
  assert.equal(contract.isOneFeatureIntroState(acknowledged), true);

  const retried = runtime.acknowledgeOneFeatureIntro({
    expectedStoreVersion: restored.version,
    introVersion: 1,
    resolution: "kept_work",
    confirmedByUser: true,
  });
  assert.equal(retried.version, acknowledged.version, "an acknowledgement retry must be idempotent");
  assert.equal(retried.acknowledgements.length, 1);
  assert.throws(
    () => runtime.acknowledgeOneFeatureIntro({
      expectedStoreVersion: acknowledged.version,
      introVersion: 1,
      resolution: "opened_one",
      confirmedByUser: true,
    }),
    /different resolution/,
    "an acknowledged version cannot rewrite its audit resolution",
  );
  assert.throws(
    () => runtime.acknowledgeOneFeatureIntro({
      expectedStoreVersion: acknowledged.version,
      introVersion: 0,
      resolution: "legacy_migrated",
      confirmedByUser: true,
    }),
    /positive safe integer/,
    "an older invalid version cannot lower the acknowledged watermark",
  );
  assert.equal(runtime.getOneFeatureIntroState().acknowledgedIntroVersion, 1);

  const postAckDeferred = runtime.deferOneFeatureIntro({
    expectedStoreVersion: restored.version,
    introVersion: 1,
    blockingStateCategory: "app_update",
  });
  assert.equal(postAckDeferred.version, acknowledged.version, "post-ack deferral must be a truthful no-op");
  assert.equal(postAckDeferred.deferrals.length, 2);

  const events = domainEvents.listOneDomainEvents(expectedOneId, 100);
  const acknowledgementEvents = events.filter((event) => event.eventType === "feature_intro.acknowledged");
  const deferralEvents = events.filter((event) => event.eventType === "feature_intro.deferred");
  assert.equal(acknowledgementEvents.length, 1, "idempotent acknowledgement must emit exactly one event");
  assert.equal(deferralEvents.length, 2, "only distinct persisted deferrals may emit events");
  assert.deepEqual(Object.keys(eventEntries(acknowledgementEvents[0])).sort(), [
    "acknowledgementRef",
    "introVersion",
    "resolution",
  ]);
  assert.equal(eventEntries(acknowledgementEvents[0]).resolution, "kept_work");
  assert.equal(eventEntries(acknowledgementEvents[0]).introVersion, 1);

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_FEATURE_INTRO_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", runtime.ONE_FEATURE_INTRO_META_KEY);
  assert.throws(() => runtime.getOneFeatureIntroState(), /corrupt; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_FEATURE_INTRO_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, runtime.ONE_FEATURE_INTRO_META_KEY);

  const wrongIdentity = JSON.parse(raw);
  wrongIdentity.oneId = "one_ffffffffffffffffffffffffffffffff";
  const wrongRaw = JSON.stringify(wrongIdentity);
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(wrongRaw, runtime.ONE_FEATURE_INTRO_META_KEY);
  assert.throws(() => runtime.getOneFeatureIntroState(), /different One identity; it was not overwritten/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(runtime.ONE_FEATURE_INTRO_META_KEY).value, wrongRaw);
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, runtime.ONE_FEATURE_INTRO_META_KEY);
  assert.equal(profileStore.getOneProfile().oneId, expectedOneId);

  console.log(JSON.stringify({
    ok: true,
    oneId: expectedOneId,
    storeVersion: acknowledged.version,
    acknowledgedIntroVersion: acknowledged.acknowledgedIntroVersion,
    exactEvents: { acknowledged: acknowledgementEvents.length, deferred: deferralEvents.length },
  }));
  db.close();
  app.quit();
}

async function reloadWorker() {
  const { app, db } = await openStore();
  const runtime = require("../dist/electron/one/feature-intro.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const expectedOneId = argument("--one-id");
  const state = runtime.getOneFeatureIntroState();
  assert.equal(state.oneId, expectedOneId);
  assert.equal(state.currentIntroVersion, 1);
  assert.equal(state.acknowledgedIntroVersion, 1);
  assert.equal(state.acknowledgements.length, 1);
  assert.equal(state.deferrals.length, 2);
  assert.ok(domainEvents.listOneDomainEvents(expectedOneId, 100)
    .some((event) => event.eventType === "feature_intro.acknowledged"));
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, oneId: state.oneId, version: state.version }));
  db.close();
  app.quit();
}

function verifyWiring() {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const ipc = read("electron/ipc.ts");
  const preload = read("electron/preload.ts");
  const types = read("shared/types.ts");
  const contract = read("shared/one-feature-intro.ts");
  assert.match(ipc, /oneFeatureIntro:getState/);
  assert.match(ipc, /oneFeatureIntro:acknowledge/);
  assert.match(ipc, /oneFeatureIntro:defer/);
  assert.match(preload, /oneFeatureIntro:\s*\{/);
  assert.match(preload, /oneFeatureIntro:acknowledge/);
  assert.match(types, /oneFeatureIntro:\s*\{/);
  assert.match(contract, /confirmedByUser:\s*true/);
  assert.doesNotMatch(ipc, /oneFeatureIntro:create|oneFeatureIntro:reset/, "renderer IPC must remain minimal");
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
  verifyWiring();
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-feature-intro-"));
  const storePath = path.join(temp, "feature-intro.sqlite");
  const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(
      executable,
      [__filename, "--seed", `--user-data=${path.join(temp, "seed-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (seed.status !== 0) throw new Error(`Feature Intro seed failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    process.stdout.write(seed.stdout);
    const seeded = parseLastJson(seed.stdout);

    const common = [__filename, "--race", `--store-version=${seeded.storeVersion}`];
    const [raceA, raceB] = await Promise.all([
      runAsync(executable, [...common, "--category=active_task", `--user-data=${path.join(temp, "race-a")}`], env),
      runAsync(executable, [...common, "--category=active_background_work", `--user-data=${path.join(temp, "race-b")}`], env),
    ]);
    if (raceA.status !== 0 || raceB.status !== 0) {
      throw new Error(`Feature Intro race process failed\nA:${raceA.stdout}\n${raceA.stderr}\nB:${raceB.stdout}\n${raceB.stderr}`);
    }
    const outcomes = [parseLastJson(raceA.stdout), parseLastJson(raceB.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS writer must succeed");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);

    const finalize = spawnSync(
      executable,
      [
        __filename,
        "--finalize",
        `--one-id=${seeded.oneId}`,
        `--seed-version=${seeded.storeVersion}`,
        `--user-data=${path.join(temp, "finalize-user-data")}`,
      ],
      { env, encoding: "utf8" },
    );
    if (finalize.status !== 0) throw new Error(`Feature Intro finalize failed (${finalize.status})\n${finalize.stdout}\n${finalize.stderr}`);
    process.stdout.write(finalize.stdout);

    const reload = spawnSync(
      executable,
      [__filename, "--reload", `--one-id=${seeded.oneId}`, `--user-data=${path.join(temp, "reload-user-data")}`],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`Feature Intro reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--seed")) {
  seedWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--race")) {
  raceWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--finalize")) {
  finalizeWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--reload")) {
  reloadWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
