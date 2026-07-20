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
  process.env.AGENTLAS_ONE_BRIEFING_STATE_PATH = path.join(path.dirname(process.env.AGENTLAS_STORE_PATH), "briefing-state.v1.json");
  await app.whenReady();
  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  return { app, db: dbStore.getDb() };
}

function baseInput(storeVersion, projectId, overrides = {}) {
  return {
    expectedStoreVersion: storeVersion,
    projectId,
    deadlineAt: "2026-03-08T03:30:00-04:00",
    timezone: "America/New_York",
    leadTimeMinutes: 60,
    relativeDeliverablePath: "deliverables/final.pdf",
    confirmedReadOnly: true,
    ...overrides,
  };
}

async function runtimeWorker() {
  const { app, db } = await openStore();
  const projects = require("../dist/electron/store/projects.js");
  const deadlineStore = require("../dist/electron/store/one-project-deadlines.js");
  const briefing = require("../dist/electron/one/briefing.js");
  const actions = require("../dist/electron/one/briefing-actions.js");
  const projector = require("../dist/electron/mobile-bridge/projector.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const sharedDeadline = require("../dist/shared/one-project-deadline.js");
  const sharedBriefing = require("../dist/shared/one-briefing.js");
  const fixtureRoot = path.dirname(process.env.AGENTLAS_STORE_PATH);
  const projectRoot = path.join(fixtureRoot, "Private Launch Workspace");
  fs.mkdirSync(path.join(projectRoot, "deliverables"), { recursive: true });
  const project = projects.createProject({ name: "Launch package", folderPath: projectRoot });

  const empty = deadlineStore.getOneProjectDeadlineState(project.id);
  assert.equal(empty.storeVersion, 1);
  assert.deepEqual(empty.checks, []);
  assert.ok(sharedDeadline.isOneProjectDeadlineState(empty));

  const connected = deadlineStore.connectOneProjectDeadline(
    baseInput(empty.storeVersion, project.id),
    new Date("2026-03-08T05:45:00.000Z"),
  );
  assert.equal(connected.storeVersion, 2);
  assert.equal(connected.checks.length, 1);
  assert.equal(connected.checks[0].deadlineAt, "2026-03-08T07:30:00.000Z");
  assert.equal(connected.checks[0].timezone, "America/New_York");
  assert.equal(connected.checks[0].conditionKind, "relative_path_exists");
  assert.equal(Object.hasOwn(connected.checks[0], "relativeDeliverablePath"), false);
  assert.equal(JSON.stringify(connected).includes("Private Launch Workspace"), false);
  assert.equal(JSON.stringify(connected).includes("deliverables/final.pdf"), false);
  assert.ok(sharedDeadline.isOneProjectDeadlineState(connected));

  const internal = deadlineStore.listOneProjectDeadlineChecksMain();
  assert.equal(internal.length, 1);
  assert.equal(internal[0].relativeDeliverablePath, "deliverables/final.pdf");

  const invalidInputs = [
    [baseInput(connected.storeVersion, project.id, { relativeDeliverablePath: "../secret.pdf" }), /stay inside/],
    [baseInput(connected.storeVersion, project.id, { relativeDeliverablePath: "/Users/mason/private.pdf" }), /stay inside/],
    [baseInput(connected.storeVersion, project.id, { relativeDeliverablePath: "C:\\private\\secret.pdf" }), /stay inside/],
    [baseInput(connected.storeVersion, project.id, { relativeDeliverablePath: "deliverables//secret.pdf" }), /stay inside/],
    [baseInput(connected.storeVersion, project.id, { deadlineAt: "2026-03-08T03:30:00" }), /explicit offset/],
    [baseInput(connected.storeVersion, project.id, { timezone: "Not/A_Timezone" }), /IANA timezone/],
    [baseInput(connected.storeVersion, project.id, { confirmedReadOnly: false }), /explicit confirmation/],
    [{ ...baseInput(connected.storeVersion, project.id), rawEventBody: "attendee@example.test secret meeting notes" }, /Invalid project deadline/],
  ];
  for (const [input, error] of invalidInputs) {
    assert.throws(() => deadlineStore.connectOneProjectDeadline(input), error);
  }
  assert.equal(deadlineStore.getOneProjectDeadlineState(project.id).storeVersion, connected.storeVersion, "hostile requests must not mutate state");

  const deps = {
    projects: [project],
    automations: [],
    tasks: [],
    projectDeadlines: internal,
  };
  assert.equal(briefing.detectOneProactiveBriefings({
    ...deps,
    now: new Date("2026-03-08T06:29:59.999Z"),
  }).length, 0, "the DST spring-forward warning must use elapsed absolute time, not wall-clock subtraction");
  const springNow = new Date("2026-03-08T06:31:00.000Z");
  const spring = briefing.detectOneProactiveBriefings({ ...deps, now: springNow });
  assert.equal(spring.length, 1);
  assert.equal(spring[0].reasonCode, "project_deadline_conflict");
  assert.equal(spring[0].kind, "risk");
  assert.equal(spring[0].severity, 3);
  assert.equal(spring[0].confidence.level, "high");
  assert.equal(spring[0].preparedAction.executionStarted, false);
  assert.ok(sharedBriefing.isOneProactiveBriefing(spring[0]));
  const serializedCandidate = JSON.stringify(spring[0]);
  for (const forbidden of [projectRoot, "deliverables/final.pdf", "attendee@example.test", "secret meeting notes"]) {
    assert.equal(serializedCandidate.includes(forbidden), false, `candidate leaked ${forbidden}`);
  }
  assert.match(spring[0].confidence.basis, /no model inference/);

  briefing.setOneBriefingPreferences({ cadence: "weekly" }, springNow);
  assert.equal(briefing.getOneBriefingSnapshot({ ...deps, now: springNow }).candidate, null, "the new detector must use the existing cadence gate");
  briefing.setOneBriefingPreferences({ cadence: "daily" }, springNow);

  const higherPriorityAutomation = {
    id: "automation_priority",
    name: "Receipt-backed automation",
    scheduleHuman: "daily-09:00",
    targetType: "agent",
    targetId: "agent_priority",
    promptTemplate: "private prompt must stay in Main",
    executionPermission: "read",
    enabled: true,
    createdBy: "user",
    createdAt: "2026-03-01T00:00:00.000Z",
    lastRunAt: "2026-03-08T06:30:00.000Z",
    nextRunAt: null,
  };
  const prioritized = briefing.getOneBriefingSnapshot({
    ...deps,
    now: springNow,
    automations: [higherPriorityAutomation],
    runHistory: () => [{
      id: "automation_run_priority",
      automationId: higherPriorityAutomation.id,
      scheduledFor: "2026-03-08T06:30:00.000Z",
      ranAt: "2026-03-08T06:30:00.000Z",
      status: "error",
      skippedCount: 0,
      error: "private error must stay in Main",
    }],
  });
  assert.equal(prioritized.candidate.reasonCode, "automation_error", "only the highest-priority eligible candidate may be published");

  const snapshot = briefing.getOneBriefingSnapshot({ ...deps, now: springNow });
  assert.equal(snapshot.candidate.candidateId, spring[0].candidateId);
  assert.equal(snapshot.candidate.reasonCode, "project_deadline_conflict");
  const mobile = projector.projectMobileBridgeOneBriefing(snapshot);
  assert.equal(mobile.candidate.reasonCode, "project_deadline_conflict");
  assert.equal(JSON.stringify(mobile).includes("deliverables/final.pdf"), false);
  assert.equal(JSON.stringify(mobile).includes(snapshot.candidate.evidence[0].value), false, "Mobile must not receive deadline evidence payloads");

  const packet = actions.prepareOneBriefingActionPacket({
    candidateId: snapshot.candidate.candidateId,
    expectedDetectedAt: snapshot.candidate.detectedAt,
  }, { ...deps, now: springNow });
  assert.equal(packet.permission, "read");
  assert.equal(packet.executionStarted, false);
  assert.equal(JSON.stringify(packet).includes("deliverables/final.pdf"), false);
  const actionRaw = db.prepare("SELECT value FROM meta WHERE key = ?").get("one.briefing-actions.v1").value;
  assert.equal(actionRaw.includes("deliverables/final.pdf"), false, "action receipts must contain only opaque evidence refs and digests");
  assert.equal(JSON.stringify(domainEvents.listOneDomainEvents(snapshot.candidate.candidateId, 20)).includes("deliverables/final.pdf"), false);

  fs.writeFileSync(path.join(projectRoot, "deliverables", "final.pdf"), "fixture");
  assert.equal(briefing.findCurrentOneBriefingCandidate({
    candidateId: snapshot.candidate.candidateId,
    expectedDetectedAt: snapshot.candidate.detectedAt,
  }, { ...deps, now: springNow }), null, "a newly present file must resolve the exact candidate before action");
  fs.rmSync(path.join(projectRoot, "deliverables", "final.pdf"));

  const outside = path.join(fixtureRoot, "outside.pdf");
  fs.writeFileSync(outside, "private");
  fs.symlinkSync(outside, path.join(projectRoot, "deliverables", "final.pdf"), "file");
  assert.equal(briefing.detectOneProactiveBriefings({ ...deps, now: springNow }).length, 0, "symlinked deliverables must fail closed, not become a high-confidence conflict");
  fs.rmSync(path.join(projectRoot, "deliverables", "final.pdf"));
  assert.equal(briefing.detectOneProactiveBriefings({
    ...deps,
    now: new Date("2026-03-15T07:30:00.000Z"),
  }).length, 0, "expired deadline findings must not be republished as fresh");

  const fall = deadlineStore.connectOneProjectDeadline(baseInput(connected.storeVersion, project.id, {
    deadlineAt: "2026-11-01T01:30:00-05:00",
    relativeDeliverablePath: "deliverables/fall.pdf",
  }), new Date("2026-10-01T00:00:00.000Z"));
  assert.equal(fall.storeVersion, 3);
  assert.throws(() => deadlineStore.connectOneProjectDeadline(baseInput(connected.storeVersion, project.id, {
    relativeDeliverablePath: "deliverables/stale.pdf",
  })), /state changed/, "stale CAS writes must be rejected");
  const fallInternal = deadlineStore.listOneProjectDeadlineChecksMain().find((check) => check.relativeDeliverablePath === "deliverables/fall.pdf");
  assert.ok(fallInternal);
  assert.equal(briefing.detectOneProactiveBriefings({
    ...deps,
    projectDeadlines: [fallInternal],
    deliverableStatus: () => "missing",
    now: new Date("2026-11-01T05:29:59.999Z"),
  }).length, 0, "the repeated fall-back hour must preserve the explicit offset");
  assert.equal(briefing.detectOneProactiveBriefings({
    ...deps,
    projectDeadlines: [fallInternal],
    deliverableStatus: () => "missing",
    now: new Date("2026-11-01T05:31:00.000Z"),
  })[0].reasonCode, "project_deadline_conflict");

  const storedRow = db.prepare("SELECT value FROM meta WHERE key = ?").get(deadlineStore.ONE_PROJECT_DEADLINES_META_KEY);
  const stored = JSON.parse(storedRow.value);
  const expandedRaw = JSON.stringify({ ...stored, unexpectedPrivateExpansion: true });
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(expandedRaw, deadlineStore.ONE_PROJECT_DEADLINES_META_KEY);
  assert.throws(() => deadlineStore.getOneProjectDeadlineState(project.id), /corrupt/);
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(deadlineStore.ONE_PROJECT_DEADLINES_META_KEY).value, expandedRaw, "corrupt state must not be overwritten");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(storedRow.value, deadlineStore.ONE_PROJECT_DEADLINES_META_KEY);

  const removed = deadlineStore.removeOneProjectDeadline({
    expectedStoreVersion: fall.storeVersion,
    checkId: fallInternal.checkId,
    expectedCheckVersion: fallInternal.version,
    confirmedByUser: true,
  });
  assert.equal(removed.storeVersion, 4);
  assert.equal(removed.checks.length, 1);
  assert.throws(() => deadlineStore.removeOneProjectDeadline({
    expectedStoreVersion: fall.storeVersion,
    checkId: fallInternal.checkId,
    expectedCheckVersion: fallInternal.version,
    confirmedByUser: true,
  }), /state changed/, "stale removal CAS must fail without deleting another check");

  console.log(JSON.stringify({
    projectId: project.id,
    springCandidateId: spring[0].candidateId,
    storeVersion: removed.storeVersion,
    checkCount: removed.checks.length,
  }));
  app.quit();
}

async function restartWorker() {
  const { app } = await openStore();
  const deadlineStore = require("../dist/electron/store/one-project-deadlines.js");
  const briefing = require("../dist/electron/one/briefing.js");
  const projects = require("../dist/electron/store/projects.js");
  const projectId = argument("--project-id");
  const expectedCandidateId = argument("--candidate-id");
  const state = deadlineStore.getOneProjectDeadlineState(projectId);
  assert.equal(state.storeVersion, 4);
  assert.equal(state.checks.length, 1);
  assert.equal(JSON.stringify(state).includes("deliverables/"), false, "restart projection must not reveal Main-only paths");
  const project = projects.getProject(projectId);
  const snapshot = briefing.getOneBriefingSnapshot({
    now: new Date("2026-03-08T06:31:00.000Z"),
    projects: [project],
    automations: [],
    tasks: [],
  });
  assert.equal(snapshot.candidate.candidateId, expectedCandidateId, "restart must re-derive the same exact conflict from durable explicit input");
  console.log("restart persistence: passed");
  app.quit();
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function runWorker(args, env) {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  return spawnSync(executable, [__filename, ...args], { env, encoding: "utf8" });
}

function staticBoundaryChecks() {
  const root = path.resolve(__dirname, "..");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.ts"), "utf8");
  const ipc = fs.readFileSync(path.join(root, "electron", "ipc.ts"), "utf8");
  const projectUi = fs.readFileSync(path.join(root, "renderer", "app", "(shell)", "project", "detail", "page.tsx"), "utf8");
  assert.match(preload, /oneProjectDeadlines:getState/);
  assert.match(preload, /oneProjectDeadlines:connect/);
  assert.match(ipc, /connectOneProjectDeadline\(input\)/);
  assert.match(projectUi, /confirmedReadOnly: true/);
  assert.match(projectUi, /does not read file contents, connect a calendar, or change anything/);
  assert.doesNotMatch(projectUi, /Google Calendar|Outlook Calendar|live calendar/i, "the manual input UI must not claim a calendar connector");
}

function orchestrate() {
  staticBoundaryChecks();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-project-deadline-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "runtime.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const runtime = runWorker(["--runtime", `--user-data=${path.join(temp, "runtime-user")}`], env);
    if (runtime.status !== 0) throw new Error(`runtime worker failed\n${runtime.stdout}\n${runtime.stderr}`);
    const info = parseLastJson(runtime.stdout);
    const restart = runWorker([
      "--restart",
      `--project-id=${info.projectId}`,
      `--candidate-id=${info.springCandidateId}`,
      `--user-data=${path.join(temp, "restart-user")}`,
    ], env);
    if (restart.status !== 0) throw new Error(`restart worker failed\n${restart.stdout}\n${restart.stderr}`);
    process.stdout.write(runtime.stdout);
    process.stdout.write(restart.stdout);
    console.log("Agentlas One project deadline conflict: 40 cases passed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const mode = process.argv.find((item) => item === "--runtime" || item === "--restart");
if (mode === "--runtime") {
  runtimeWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (mode === "--restart") {
  restartWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    // The top-level verifier itself is launched with Electron. Its child
    // workers quit their app instances, but the orchestrator has no window or
    // lifecycle work of its own and otherwise leaves Electron's event loop
    // alive after all assertions have passed.
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
