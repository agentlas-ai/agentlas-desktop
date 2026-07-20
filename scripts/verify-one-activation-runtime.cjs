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

function insertAgent(db) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-activation-agent", "one-activation", "One", "Chief of Staff", new Date().toISOString());
}

function runtime() {
  return {
    activation: require("../dist/electron/one/activation.js"),
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runEvents: require("../dist/electron/store/run-events.js"),
    domainEvents: require("../dist/electron/one/domain-events.js"),
    acceptedClosures: require("../dist/electron/one/accepted-result-value-closure.js"),
  };
}

function entries(event) {
  return Object.fromEntries(event.payload.entries.map((item) => [item.name, item.value]));
}

function activationEvents(rt, oneId) {
  return rt.domainEvents.listOneDomainEvents(`activation:${oneId}`, 100);
}

function prepareAcceptedResult(rt, chatId, title, runId) {
  const task = rt.tasks.getCanonicalTaskForChat(chatId);
  assert.ok(task, "an explicit work signal must promote the same conversation");
  const partial = rt.tasks.setCanonicalTaskStatus(task.id, "partial");
  rt.domainEvents.recordOneDomainEvent({
    eventType: "task.state_changed",
    occurredAt: partial.updatedAt,
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: task.status },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  rt.runEvents.recordRunEvent({
    runId,
    kind: "invoke_started",
    chatId,
    agentId: "one-activation-agent",
    payload: { chatId },
  });
  rt.domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: runId,
    taskId: partial.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  rt.runEvents.recordRunEvent({
    runId,
    kind: "invoke_completed",
    chatId,
    agentId: "one-activation-agent",
    payload: { title },
  });
  const receipt = rt.runEvents.getInvocationRunReceipt(runId);
  assert.ok(receipt && receipt.status === "completed");
  const accepted = rt.tasks.acceptCanonicalTaskResult({
    taskId: partial.id,
    expectedVersion: partial.version,
    expectedRunId: runId,
  }, receipt);
  const closure = rt.acceptedClosures.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: runId,
    receipt,
    confirmedByUser: true,
  });
  return { partial, accepted, closure };
}

async function freshSimpleWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const rt = runtime();
  const secretConcern = `Private concern ${`sk-${"Z".repeat(32)}`} /Users/mason/private-plan`;

  // A UI-created empty draft (with or without a still-open Task) is not proof
  // that the user has already received value from One.
  rt.chats.createChat({ agentId: "one-activation-agent", title: "Empty conversation draft", taskMode: "conversation" });
  rt.chats.createChat({ agentId: "one-activation-agent", title: "Empty task draft" });
  const profile = require("../dist/electron/store/one-profile.js").getOneProfile();
  rt.domainEvents.recordOneDomainEvent({
    eventType: "feature_intro.deferred",
    actor: "system",
    entityId: profile.oneId,
    version: Math.max(1, Date.now()),
    visibility: "personal",
    entries: [
      { name: "introVersion", value: 1 },
      { name: "blockingStateCategory", value: "route_ineligible" },
    ],
  });
  const initial = rt.activation.getOneActivationState({ platform: "desktop", locale: "ko" });
  assert.equal(initial.eligibility, "eligible_first_use", "fresh empty drafts must keep the Desktop-first route eligible");
  assert.equal(initial.status, "active");
  assert.equal(initial.route.route, "desktop_first");
  assert.equal(initial.route.platform, "desktop");
  assert.equal(initial.route.locale, "ko");

  const routeEvents = activationEvents(rt, initial.oneId).filter((event) => event.eventType === "onboarding.route_selected");
  assert.equal(routeEvents.length, 1);
  assert.deepEqual(entries(routeEvents[0]), { route: "desktop_first", platform: "desktop", locale: "ko" });

  const work = rt.activation.resolveOneActivationWork({
    expectedStoreVersion: initial.version,
    confirmedByUser: true,
  });
  assert.equal(work.status, "active", "opening Work must not complete activation");
  assert.equal(work.workNavigation.status, "resolved");
  assert.throws(() => rt.activation.skipOneActivation({
    expectedStoreVersion: initial.version,
    confirmedByUser: true,
  }), /changed/, "a stale renderer version must fail closed");

  const chat = rt.chats.createChat({
    agentId: "one-activation-agent",
    title: "First concern",
    taskMode: "conversation",
  });
  rt.chats.appendChatMessage(chat.id, "user", secretConcern);
  rt.chats.appendChatMessage(chat.id, "assistant", "A simple answer without tools.");
  const concerned = rt.activation.resolveOneActivationConcern({
    expectedStoreVersion: work.version,
    originChatId: chat.id,
    confirmedByUser: true,
  });
  assert.equal(concerned.concern.status, "resolved");
  assert.equal(concerned.concern.originChatId, chat.id);
  assert.equal(rt.tasks.findCanonicalTaskForChat(chat.id), null, "a simple conversation must remain Task-free");
  const simple = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  assert.equal(simple.status, "active", "a simple answer must never complete first-value activation");
  assert.equal(simple.firstValue.status, "pending");
  assert.equal(simple.route.locale, "ko", "route selection must be durable rather than rewritten by renderer locale changes");

  const events = activationEvents(rt, simple.oneId);
  const stepEvents = events.filter((event) => event.eventType === "onboarding.step_resolved");
  assert.deepEqual(stepEvents.map(entries).sort((a, b) => a.stepId.localeCompare(b.stepId)), [
    { stepId: "concern", resolution: "submitted" },
    { stepId: "work_navigation", resolution: "opened_work" },
  ]);
  const activationJson = JSON.stringify({ state: simple, events });
  assert.equal(activationJson.includes(secretConcern), false, "activation state/events must never contain raw concern text");
  assert.equal(activationJson.includes("/Users/mason"), false);
  assert.equal(activationJson.includes("sk-"), false);

  const raw = db.prepare("SELECT value FROM meta WHERE key = ?").get(rt.activation.ONE_ACTIVATION_META_KEY).value;
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run("{corrupt-json", rt.activation.ONE_ACTIVATION_META_KEY);
  assert.throws(
    () => rt.activation.getOneActivationState({ platform: "desktop", locale: "ko" }),
    /corrupt; it was not overwritten/,
  );
  assert.equal(db.prepare("SELECT value FROM meta WHERE key = ?").get(rt.activation.ONE_ACTIVATION_META_KEY).value, "{corrupt-json");
  db.prepare("UPDATE meta SET value = ? WHERE key = ?").run(raw, rt.activation.ONE_ACTIVATION_META_KEY);

  console.log(JSON.stringify({ ok: true, oneId: simple.oneId, version: simple.version, chatId: chat.id }));
  db.close();
  app.quit();
}

async function freshReloadAndSkipWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const restored = rt.activation.getOneActivationState({ platform: "desktop", locale: "ko" });
  assert.equal(restored.oneId, argument("--one-id"));
  assert.equal(restored.status, "active");
  assert.equal(restored.firstValue.status, "pending");
  const skipped = rt.activation.skipOneActivation({
    expectedStoreVersion: restored.version,
    confirmedByUser: true,
  });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.completionReason, "explicit_skip");
  const duplicate = rt.activation.skipOneActivation({
    expectedStoreVersion: restored.version,
    confirmedByUser: true,
  });
  assert.equal(duplicate.version, skipped.version, "duplicate skip callback must be idempotent");
  const skipEvents = activationEvents(rt, skipped.oneId).filter((event) =>
    event.eventType === "onboarding.step_resolved" && entries(event).stepId === "activation",
  );
  assert.equal(skipEvents.length, 1);
  assert.deepEqual(entries(skipEvents[0]), { stepId: "activation", resolution: "explicit_skip" });
  console.log(JSON.stringify({ ok: true, skipped: true, version: skipped.version }));
  db.close();
  app.quit();
}

async function preexistingWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const rt = runtime();
  const chat = rt.chats.createChat({
    agentId: "one-activation-agent",
    title: "Existing work",
  });
  rt.chats.appendChatMessage(chat.id, "user", "Existing user activity");
  const state = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  assert.equal(state.eligibility, "ineligible_preexisting_activity");
  assert.equal(state.status, "ineligible");
  assert.equal(state.route, null, "Main must not present an existing account as a new Desktop-first route");
  assert.equal(activationEvents(rt, state.oneId).length, 0, "an ineligible account must not emit a false route selection");
  console.log(JSON.stringify({ ok: true, preexistingIneligible: true, oneId: state.oneId }));
  db.close();
  app.quit();
}

async function closureWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const rt = runtime();
  const initial = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  assert.equal(initial.status, "active");
  const chat = rt.chats.createChat({
    agentId: "one-activation-agent",
    title: "Verified first value",
    taskMode: "conversation",
  });
  rt.chats.appendChatMessage(chat.id, "user", "Create a receipt-backed result");
  const concerned = rt.activation.resolveOneActivationConcern({
    expectedStoreVersion: initial.version,
    originChatId: chat.id,
    confirmedByUser: true,
  });
  const accepted = prepareAcceptedResult(rt, chat.id, "Verified first value", "run_activation_first_value");
  const beforeHook = JSON.parse(db.prepare("SELECT value FROM meta WHERE key = ?")
    .get(rt.activation.ONE_ACTIVATION_META_KEY).value);
  assert.equal(beforeHook.status, "active", "Value Closure creation alone must not mutate activation outside its optional Main hook");
  const exactInput = {
    taskId: accepted.accepted.id,
    expectedTaskVersion: accepted.accepted.version,
    valueClosureId: accepted.closure.value.closure.valueClosureId,
    expectedValueClosureVersion: accepted.closure.value.version,
  };
  const completed = rt.activation.tryCompleteOneActivationFirstValue(exactInput);
  assert.ok(completed);
  assert.equal(completed.status, "completed");
  assert.equal(completed.completionReason, "verified_first_value");
  assert.equal(completed.firstValue.taskId, accepted.accepted.id);
  assert.equal(completed.firstValue.taskVersion, accepted.accepted.version);
  assert.equal(completed.mobileConnection.status, "offered");
  const duplicate = rt.activation.tryCompleteOneActivationFirstValue(exactInput);
  assert.equal(duplicate.version, completed.version, "duplicate closure callback must be idempotent");
  assert.equal(rt.activation.tryCompleteOneActivationFirstValue({ ...exactInput, expectedTaskVersion: concerned.version }), null);

  const mobile = rt.activation.resolveOneActivationMobile({
    expectedStoreVersion: completed.version,
    resolution: "continued_without_pairing",
    confirmedByUser: true,
  });
  assert.equal(mobile.status, "completed");
  assert.equal(mobile.mobileConnection.status, "resolved");
  assert.equal(mobile.mobileConnection.resolution, "continued_without_pairing");
  const eventPayloads = activationEvents(rt, mobile.oneId)
    .filter((event) => event.eventType === "onboarding.step_resolved")
    .map(entries);
  assert.ok(eventPayloads.some((entry) => entry.stepId === "first_value" && entry.resolution === "verified_value_closure"));
  assert.ok(eventPayloads.some((entry) => entry.stepId === "mobile_connection" && entry.resolution === "continued_without_pairing"));
  console.log(JSON.stringify({ ok: true, completed: true, oneId: mobile.oneId, version: mobile.version }));
  db.close();
  app.quit();
}

async function closureReloadWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const state = rt.activation.getOneActivationState({ platform: "desktop", locale: "ko" });
  assert.equal(state.oneId, argument("--one-id"));
  assert.equal(state.status, "completed");
  assert.equal(state.mobileConnection.status, "resolved");
  assert.equal(state.firstValue.status, "resolved");
  console.log(JSON.stringify({ ok: true, closureRestored: true, version: state.version }));
  db.close();
  app.quit();
}

async function valueClosureOnlyPreexistingWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const closureStore = require("../dist/electron/one/value-closure.js").getOneValueClosureState();
  assert.ok(closureStore.closures.length > 0);
  const task = rt.tasks.getCanonicalTask(closureStore.closures[0].closure.taskId);
  if (task?.originChatId) rt.chats.removeChat(task.originChatId);
  db.prepare("DELETE FROM run_events").run();
  db.prepare("DELETE FROM meta WHERE key = ?").run(rt.activation.ONE_ACTIVATION_META_KEY);
  const state = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  assert.equal(state.status, "ineligible", "an existing Value Closure alone must suppress first-use activation");
  assert.equal(state.route, null);
  console.log(JSON.stringify({ ok: true, valueClosureOnlyIneligible: true }));
  db.close();
  app.quit();
}

async function casSeedWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const rt = runtime();
  const state = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  const chat = rt.chats.createChat({
    agentId: "one-activation-agent",
    title: "CAS concern",
    taskMode: "conversation",
  });
  console.log(JSON.stringify({ ok: true, oneId: state.oneId, version: state.version, chatId: chat.id }));
  db.close();
  app.quit();
}

async function casRaceWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const operation = argument("--operation");
  try {
    const state = operation === "concern"
      ? rt.activation.resolveOneActivationConcern({
          expectedStoreVersion: Number(argument("--version")),
          originChatId: argument("--chat-id"),
          confirmedByUser: true,
        })
      : rt.activation.resolveOneActivationWork({
          expectedStoreVersion: Number(argument("--version")),
          confirmedByUser: true,
        });
    console.log(JSON.stringify({ success: true, operation, version: state.version }));
  } catch (error) {
    console.log(JSON.stringify({ success: false, operation, error: error instanceof Error ? error.message : String(error) }));
  }
  db.close();
  app.quit();
}

async function casFinalizeWorker() {
  const { app, db } = await openStore();
  const rt = runtime();
  const state = rt.activation.getOneActivationState({ platform: "desktop", locale: "en" });
  assert.equal(state.oneId, argument("--one-id"));
  assert.equal(state.status, "active");
  assert.equal([state.concern.status, state.workNavigation.status].filter((value) => value === "resolved").length, 1);
  console.log(JSON.stringify({ ok: true, casRestored: true, version: state.version }));
  db.close();
  app.quit();
}

function verifyWiring() {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const ipc = read("electron/ipc.ts");
  const preload = read("electron/preload.ts");
  const shell = read("renderer/components/one/OneShell.tsx");
  const component = read("renderer/components/one/OneActivation.tsx");
  const css = read("renderer/components/one/OneActivation.module.css");
  const mobile = read("electron/mobile-bridge/authority.ts");
  assert.match(ipc, /oneActivation:getState/);
  assert.match(ipc, /oneActivation:resolveConcern/);
  assert.match(ipc, /oneActivation:resolveWork/);
  assert.match(ipc, /oneActivation:skip/);
  assert.match(ipc, /oneActivation:resolveMobile/);
  assert.match(preload, /oneActivation:\s*\{[\s\S]*resolveConcern:[\s\S]*resolveWork:[\s\S]*skip:[\s\S]*resolveMobile:/);
  const assertFirstValueWiring = (source, startMarker, endMarker, label) => {
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(start >= 0 && end > start, `${label} result-acceptance handler must be present`);
    const handler = source.slice(start, end);
    const closureIndex = handler.indexOf("ensureAcceptedResultValueClosure(");
    const activationIndex = handler.indexOf("tryCompleteOneActivationFirstValue(");
    assert.ok(closureIndex >= 0, `${label} acceptance must create the accepted-result Value Closure`);
    assert.ok(
      activationIndex > closureIndex,
      `${label} acceptance must advance first value only after the accepted-result Value Closure exists`,
    );
  };
  assertFirstValueWiring(ipc, 'ipcMain.handle("tasks:acceptResult"', 'ipcMain.handle("oneSearch:search"', "Desktop");
  assertFirstValueWiring(mobile, 'case "tasks.acceptResult"', 'case "tasks.latestResult"', "Mobile");
  assert.match(shell, /taskMode:\s*"conversation"/);
  assert.match(shell, /resolveActivationConcern\(chat\.id\)/);
  assert.doesNotMatch(shell, /oneActivation[\s\S]{0,160}(?:prompt|userPrompt|rawText|localPath)\s*:/i);
  assert.match(component, /파일 변경이나 외부 전송은 시작 전에 꼭 물어봅니다|always asks before changing files or sending anything outside/);
  assert.match(component, /Work로 직접 가기|Go directly to Work/);
  assert.match(component, /소개 건너뛰기|Skip introduction/);
  assert.match(component, /모바일 연결 설정 열기|Open mobile connection settings/);
  assert.match(css, /min-height:\s*44px/);
}

function parseLastJson(output) {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}

function run(executable, args, env) {
  const result = spawnSync(executable, args, { env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Activation worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  process.stdout.write(result.stdout);
  return parseLastJson(result.stdout);
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
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-activation-"));
  const envFor = (storePath) => {
    const env = { ...process.env, AGENTLAS_STORE_PATH: storePath };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  };
  try {
    const simpleStore = path.join(temp, "simple.sqlite");
    const simpleEnv = envFor(simpleStore);
    const simple = run(executable, [__filename, "--fresh-simple", `--user-data=${path.join(temp, "simple-a")}`], simpleEnv);
    run(executable, [__filename, "--fresh-reload-skip", `--one-id=${simple.oneId}`, `--user-data=${path.join(temp, "simple-b")}`], simpleEnv);

    const preexistingStore = path.join(temp, "preexisting.sqlite");
    run(executable, [__filename, "--preexisting", `--user-data=${path.join(temp, "preexisting")}`], envFor(preexistingStore));

    const closureStore = path.join(temp, "closure.sqlite");
    const closureEnv = envFor(closureStore);
    const closure = run(executable, [__filename, "--closure", `--user-data=${path.join(temp, "closure-a")}`], closureEnv);
    run(executable, [__filename, "--closure-reload", `--one-id=${closure.oneId}`, `--user-data=${path.join(temp, "closure-b")}`], closureEnv);
    run(executable, [__filename, "--value-closure-only", `--user-data=${path.join(temp, "closure-c")}`], closureEnv);

    const casStore = path.join(temp, "cas.sqlite");
    const casEnv = envFor(casStore);
    const seeded = run(executable, [__filename, "--cas-seed", `--user-data=${path.join(temp, "cas-seed")}`], casEnv);
    const common = [__filename, "--cas-race", `--version=${seeded.version}`, `--chat-id=${seeded.chatId}`];
    const [left, right] = await Promise.all([
      runAsync(executable, [...common, "--operation=concern", `--user-data=${path.join(temp, "cas-a")}`], casEnv),
      runAsync(executable, [...common, "--operation=work", `--user-data=${path.join(temp, "cas-b")}`], casEnv),
    ]);
    if (left.status !== 0 || right.status !== 0) throw new Error(`CAS worker process failed\n${left.stderr}\n${right.stderr}`);
    const outcomes = [parseLastJson(left.stdout), parseLastJson(right.stdout)];
    assert.equal(outcomes.filter((item) => item.success).length, 1, "exactly one concurrent CAS mutation must commit");
    assert.equal(outcomes.filter((item) => !item.success).length, 1);
    assert.match(outcomes.find((item) => !item.success).error, /changed|concurrently|locked|busy/i);
    process.stdout.write(`${JSON.stringify({ ok: true, concurrentCas: outcomes })}\n`);
    run(executable, [__filename, "--cas-finalize", `--one-id=${seeded.oneId}`, `--user-data=${path.join(temp, "cas-final")}`], casEnv);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const worker = process.argv.find((item) => item.startsWith("--") && [
  "--fresh-simple", "--fresh-reload-skip", "--preexisting", "--closure", "--closure-reload", "--value-closure-only",
  "--cas-seed", "--cas-race", "--cas-finalize",
].includes(item));

const workers = {
  "--fresh-simple": freshSimpleWorker,
  "--fresh-reload-skip": freshReloadAndSkipWorker,
  "--preexisting": preexistingWorker,
  "--closure": closureWorker,
  "--closure-reload": closureReloadWorker,
  "--value-closure-only": valueClosureOnlyPreexistingWorker,
  "--cas-seed": casSeedWorker,
  "--cas-race": casRaceWorker,
  "--cas-finalize": casFinalizeWorker,
};

if (worker) {
  workers[worker]().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  orchestrate().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
}
