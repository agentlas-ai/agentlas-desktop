#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
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

async function worker() {
  const { app, db } = await openStore();
  const store = require("../dist/electron/store/one-profile.js");
  const shared = require("../dist/shared/one-profile.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");

  const initial = store.getOneProfile();
  assert.match(initial.oneId, /^one_[a-f0-9]{32}$/);
  assert.equal(initial.displayName, "One");
  assert.equal(initial.operatingPrinciples.length, 0);
  assert.equal(store.getOneProfile().oneId, initial.oneId, "re-reads must keep one stable identity");

  const personalized = store.updateOneProfile({
    expectedVersion: initial.version,
    patch: {
      displayName: "Atlas",
      role: "My chief of staff",
      profileContext: "I prefer decisions with evidence and a clear next action.",
    },
  });
  assert.ok(personalized.version > initial.version);
  assert.equal(personalized.displayName, "Atlas");
  assert.throws(
    () => store.updateOneProfile({ expectedVersion: initial.version, patch: { displayName: "Stale" } }),
    /One profile changed/,
    "stale UI writes must fail closed",
  );
  assert.throws(
    () => store.updateOneProfile({
      expectedVersion: personalized.version,
      patch: { profileContext: "api_key=sk-proj-1234567890abcdefgh" },
    }),
    /credentials or secrets/,
    "profile memory must reject live credential shapes",
  );
  assert.throws(
    () => store.addOneOperatingPrinciple({
      expectedVersion: personalized.version,
      content: "Always show evidence.",
      scope: "personal",
      approvedByUser: false,
    }),
    /explicit user approval/,
    "an inferred or non-explicit path can never create an approved principle",
  );

  const withPersonal = store.addOneOperatingPrinciple({
    expectedVersion: personalized.version,
    content: "Show the conclusion and its evidence before supporting detail.",
    scope: "personal",
    approvedByUser: true,
  });
  const personalPrinciple = withPersonal.operatingPrinciples[0];
  assert.equal(personalPrinciple.approvalSource, "explicit_user");
  assert.equal(personalPrinciple.scopeRef, null);
  assert.equal(personalPrinciple.enabled, true);

  assert.throws(
    () => store.addOneOperatingPrinciple({
      expectedVersion: withPersonal.version,
      content: "Keep launch decisions conservative.",
      scope: "project",
      approvedByUser: true,
    }),
    /require a safe scopeRef/,
  );
  const withProject = store.addOneOperatingPrinciple({
    expectedVersion: withPersonal.version,
    content: "Keep launch decisions conservative.",
    scope: "project",
    scopeRef: "project_launch",
    approvedByUser: true,
  });
  const projectPrinciple = withProject.operatingPrinciples[1];
  const edited = store.updateOneOperatingPrinciple({
    expectedVersion: withProject.version,
    principleId: projectPrinciple.id,
    content: "Require a rollback path before launch.",
    scope: "team",
    scopeRef: "team_release",
    approvedByUser: true,
  });
  const editedPrinciple = edited.operatingPrinciples.find((item) => item.id === projectPrinciple.id);
  assert.equal(editedPrinciple.scope, "team");
  assert.equal(editedPrinciple.scopeRef, "team_release");
  assert.ok(editedPrinciple.approvedAt > projectPrinciple.approvedAt, "an edit requires and records renewed approval");

  const disabled = store.setOneOperatingPrincipleEnabled({
    expectedVersion: edited.version,
    principleId: personalPrinciple.id,
    enabled: false,
  });
  assert.ok(disabled.operatingPrinciples.find((item) => item.id === personalPrinciple.id).disabledAt);
  const disabledProjection = store.getOneProfileDeviceProjection();
  assert.equal(disabledProjection.operatingPrinciples.some((item) => item.id === personalPrinciple.id), false);
  assert.equal("profileContext" in disabledProjection, false, "raw profile context must not enter device projection");
  assert.equal(disabledProjection.operatingPrinciples.some((item) => "scopeRef" in item), false);

  const enabled = store.setOneOperatingPrincipleEnabled({
    expectedVersion: disabled.version,
    principleId: personalPrinciple.id,
    enabled: true,
  });
  const withLocalPath = store.addOneOperatingPrinciple({
    expectedVersion: enabled.version,
    content: "Read the checklist under /Users/example/private before launch.",
    scope: "personal",
    approvedByUser: true,
  });
  const deviceProjection = store.getOneProfileDeviceProjection();
  assert.equal(deviceProjection.oneId, initial.oneId);
  assert.equal(deviceProjection.displayName, "Atlas");
  assert.equal(deviceProjection.omittedOperatingPrincipleCount, 1, "path-bearing principles must be omitted, not rewritten as approved");
  assert.equal(JSON.stringify(deviceProjection).includes("/Users/"), false);
  assert.equal(JSON.stringify(deviceProjection).includes("I prefer decisions"), false);
  assert.ok(deviceProjection.operatingPrinciples.every((item) => item.approvalSource === "explicit_user"));

  const localContext = shared.buildApprovedOneProfileContext(withLocalPath);
  assert.match(localContext, /Do not present inferred preferences as approved/);
  assert.doesNotMatch(localContext, /Require a rollback path before launch/, "scoped principles must not leak without an exact binding");
  const teamContext = shared.buildApprovedOneProfileContext(withLocalPath, { teamId: "team_release" });
  assert.match(teamContext, /Require a rollback path before launch/);
  const unrelatedTeamContext = shared.buildApprovedOneProfileContext(withLocalPath, { teamId: "team_other" });
  assert.doesNotMatch(unrelatedTeamContext, /Require a rollback path before launch/);

  const deleted = store.deleteOneOperatingPrinciple({
    expectedVersion: withLocalPath.version,
    principleId: projectPrinciple.id,
  });
  assert.equal(deleted.operatingPrinciples.some((item) => item.id === projectPrinciple.id), false);
  const profileEvents = domainEvents.listOneDomainEvents(deleted.oneId, 100);
  assert.ok(profileEvents.length >= 7, "each persisted user mutation must leave a one.profile.updated event");
  assert.ok(profileEvents.every((event) => event.eventType === "one.profile.updated"));
  assert.ok(profileEvents.every((event) => event.payload.entries.some((entry) => entry.name === "changedFields")));
  assert.equal(db.pragma("foreign_key_check").length, 0);

  console.log(JSON.stringify({
    ok: true,
    oneId: deleted.oneId,
    version: deleted.version,
    persistedPrinciples: deleted.operatingPrinciples.length,
  }));
  db.close();
  app.quit();
}

async function verifyReload() {
  const { app, db } = await openStore();
  const store = require("../dist/electron/store/one-profile.js");
  const profile = store.getOneProfile();
  assert.match(profile.oneId, /^one_[a-f0-9]{32}$/);
  assert.equal(profile.displayName, "Atlas");
  assert.equal(profile.role, "My chief of staff");
  assert.equal(profile.profileContext, "I prefer decisions with evidence and a clear next action.");
  assert.equal(profile.operatingPrinciples.length, 2);
  assert.ok(profile.operatingPrinciples.every((item) => item.approvalSource === "explicit_user"));
  console.log(JSON.stringify({ ok: true, restoredAfterRestart: true, oneId: profile.oneId, version: profile.version }));
  db.close();
  app.quit();
}

function verifyWiring() {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const ipc = read("electron/ipc.ts");
  const preload = read("electron/preload.ts");
  const adapter = read("renderer/lib/one-task-adapter.ts");
  const shell = read("renderer/components/one/OneShell.tsx");
  const profileSheet = read("renderer/components/one/OneProfileSheet.tsx");
  const i18n = read("renderer/lib/i18n.tsx");
  assert.match(ipc, /oneProfile:get/);
  assert.match(ipc, /oneProfile:addPrinciple/);
  assert.match(preload, /oneProfile:setPrincipleEnabled/);
  assert.match(adapter, /api\.oneProfile\.get\(\)/, "Task projection must resolve Main's durable One identity");
  assert.doesNotMatch(adapter, /one:local/, "the transient fixed identity must be removed");
  assert.match(shell, /<OneProfileSheet/);
  assert.match(profileSheet, /approvedByUser:\s*true/);
  assert.match(
    `${profileSheet}\n${i18n}`,
    /Only what you write and save here is used in future conversations/,
    "The profile boundary must be explained in plain user language",
  );
  assert.match(
    `${profileSheet}\n${i18n}`,
    /여기에 적고 저장한 내용만 다음 대화에도 사용합니다/,
    "The same plain-language profile boundary must be available in Korean",
  );
}

function orchestrate() {
  verifyWiring();
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-profile-runtime-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "one-profile.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const first = spawnSync(
      executable,
      [__filename, "--worker", `--user-data=${path.join(temp, "user-data")}`],
      { env, encoding: "utf8" },
    );
    if (first.status !== 0) throw new Error(`One profile worker failed (${first.status})\n${first.stdout}\n${first.stderr}`);
    process.stdout.write(first.stdout);
    const reload = spawnSync(
      executable,
      [__filename, "--verify-reload", `--user-data=${path.join(temp, "user-data-reload")}`],
      { env, encoding: "utf8" },
    );
    if (reload.status !== 0) throw new Error(`One profile reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--verify-reload")) {
  verifyReload().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv.includes("--worker")) {
  worker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
