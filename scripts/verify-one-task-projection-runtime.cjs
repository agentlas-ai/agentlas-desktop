#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HOST_REF = "host:projection-primary";
const SYNCED_AT = "2026-07-18T12:00:00.000Z";

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

function questionFence(question) {
  return [
    "<<agentlas-ask>>",
    JSON.stringify({
      question,
      header: "Release decision",
      multiSelect: false,
      options: [
        { label: "Approve", description: "Continue with the reviewed scope" },
        { label: "Reject", description: "Keep the current state unchanged" },
      ],
    }),
    "<</agentlas-ask>>",
  ].join("\n");
}

function manifest(taskId, suffix) {
  const artifactRef = `artifact:${suffix}-report`;
  const receiptRef = `receipt:${suffix}-step`;
  const blockOrder = [`block:${suffix}-document`, `block:${suffix}-status`];
  return {
    contractVersion: "1.0.0",
    manifestId: `manifest:${suffix}`,
    taskId,
    title: `${suffix} result`,
    summary: `The ${suffix} result is ready for review.`,
    layoutProfile: "report",
    surfaceState: {
      value: "ready",
      summary: "Safe native projection ready.",
      readOnly: true,
      lastSyncedAt: SYNCED_AT,
    },
    blocks: [
      {
        blockId: blockOrder[0],
        type: "Document",
        title: "Report",
        artifactRef,
        excerpt: "A reviewable report is available.",
        pageCount: 3,
      },
      {
        blockId: blockOrder[1],
        type: "Status",
        title: "Execution status",
        taskState: "completed",
        steps: [{
          stepRef: `step:${suffix}-research`,
          label: "Research",
          status: "completed",
          receiptRef,
        }],
      },
    ],
    primaryAction: null,
    secondaryActions: [],
    evidence: [{
      evidenceRef: `receipt:${suffix}-evidence`,
      kind: "receipt",
      verificationStatus: "verified",
      label: "Execution receipt",
    }],
    fallback: {
      markdown: "Open Work to inspect the exact result and receipts.",
      artifacts: [{
        artifactRef,
        type: "document",
        label: `${suffix} report`,
        verificationStatus: "verified",
      }],
    },
    recomposition: {
      desktop: {
        blockOrder,
        tableStrategy: "full_table",
        comparisonStrategy: "matrix",
        timelineStrategy: "adaptive",
      },
      mobile: {
        blockOrder,
        tableStrategy: "featured_cards_then_sheet",
        comparisonStrategy: "recommended_then_alternatives",
        timelineStrategy: "vertical",
      },
    },
  };
}

function onlineAuthority(task) {
  return {
    connection: "online",
    lastSyncedAt: task.updatedAt,
    authoritativeHostRef: HOST_REF,
    executionAuthorityAvailable: true,
    mutationMode: "direct",
  };
}

function makeRuntime(runtimeModule, tasks, overrides = {}) {
  return runtimeModule.createOneTaskProjectionRuntime({
    getAuthoritySnapshot({ taskId, surface }) {
      const task = tasks.getCanonicalTask(taskId);
      return overrides.getAuthoritySnapshot
        ? overrides.getAuthoritySnapshot({ taskId, surface, task })
        : task && onlineAuthority(task);
    },
    ...(overrides.sources ? { sources: overrides.sources } : {}),
  });
}

function canonicalParity(projection) {
  return {
    taskId: projection.taskId,
    canonicalVersion: projection.canonicalVersion,
    oneId: projection.oneId,
    status: projection.status,
    references: projection.references,
  };
}

function verifyClosedContract(contract, projection) {
  assert.equal(contract.isAgentlasOneTaskProjectionV1(projection), true);
  assert.equal(
    contract.parseAgentlasOneTaskProjectionV1(JSON.stringify(projection)).taskId,
    projection.taskId,
  );
  assert.equal(contract.isAgentlasOneTaskProjectionV1({ ...projection, unexpected: true }), false);
  assert.equal(contract.isAgentlasOneTaskProjectionV1({
    ...projection,
    display: { ...projection.display, title: "/Users/operator/private/result.txt" },
  }), false, "local paths must fail the closed transport contract");
  assert.equal(contract.isAgentlasOneTaskProjectionV1({
    ...projection,
    display: { ...projection.display, summary: `token=sk-${"A".repeat(32)}` },
  }), false, "secrets must fail the closed transport contract");
  assert.equal(contract.isAgentlasOneTaskProjectionV1({
    ...projection,
    truth: { ...projection.truth, mayClaimNewCompletion: true },
    status: { ...projection.status, source: "cached_projection" },
    sync: {
      ...projection.sync,
      connection: "offline",
      executionAuthorityAvailable: false,
      mutationMode: "read_only",
    },
  }), false, "offline projections cannot claim a new completion");
}

async function seedWorker() {
  const expectedPath = argument("--expected");
  if (!expectedPath) throw new Error("worker requires --expected");
  const { app, db } = await openStore();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("projection-agent", "projection-owner", "One", "Projection owner", now);

  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const surfaces = require("../dist/electron/store/one-surface-results.js");
  const profileStore = require("../dist/electron/store/one-profile.js");
  const runtimeModule = require("../dist/electron/one/task-projection.js");
  const contract = require("../dist/shared/one-task-projection.js");

  // One 표면 멤버십 계약 — One 홈에 투영되려면 대화가 One에서 시작됐어야 한다.
  const alphaChat = chats.createChat({ agentId: "projection-agent", title: "Alpha launch review", originSurface: "one" });
  const betaChat = chats.createChat({ agentId: "projection-agent", title: "Beta pricing review", originSurface: "one" });
  const alphaTask = tasks.getCanonicalTaskForChat(alphaChat.id);
  const betaTask = tasks.getCanonicalTaskForChat(betaChat.id);
  assert.ok(alphaTask && betaTask);
  assert.notEqual(alphaTask.id, betaTask.id);

  for (const item of [
    { chat: alphaChat, task: alphaTask, suffix: "alpha", runId: "run:alpha-team" },
    { chat: betaChat, task: betaTask, suffix: "beta", runId: "run:beta-team" },
  ]) {
    runEvents.recordRunEvent({
      runId: item.runId,
      kind: "invoke_started",
      chatId: item.chat.id,
      payload: { chatId: item.chat.id },
    });
    domainEvents.recordOneDomainEvent({
      eventType: "run.started",
      occurredAt: new Date().toISOString(),
      actor: "system",
      entityId: item.runId,
      taskId: item.task.id,
      version: 1,
      visibility: "personal",
      entries: [
        { name: "runId", value: item.runId },
        { name: "policyVersion", value: "agentlas-one-runtime-v1" },
      ],
    });
    runEvents.recordRunEvent({
      runId: item.runId,
      kind: "invoke_completed",
      chatId: item.chat.id,
      payload: { status: "completed" },
    });
    surfaces.recordDurableOneSurfaceResult({
      runId: item.runId,
      chatId: item.chat.id,
      manifest: manifest(item.task.id, item.suffix),
    });
  }

  const alphaDecision = chats.appendChatMessage(
    alphaChat.id,
    "assistant",
    questionFence("Should One continue with the reviewed Alpha scope?"),
  );
  tasks.setCanonicalTaskStatus(alphaTask.id, "waiting-decision");
  tasks.setCanonicalTaskStatus(betaTask.id, "partial");

  const runtime = makeRuntime(runtimeModule, tasks);
  const alphaOne = runtime.getProjection(alphaTask.id, { surface: "one", mode: "summary" });
  const alphaWork = runtime.getProjection(alphaTask.id, { surface: "work", mode: "summary" });
  const alphaMobile = runtime.getProjection(alphaTask.id, { surface: "mobile", mode: "approval_focused" });
  const betaOne = runtime.getProjection(betaTask.id, { surface: "one" });
  assert.ok(alphaOne && alphaWork && alphaMobile && betaOne);

  // 전역 Work 대화의 Task는 One에 절대 투영되지 않는다(표면 분리 계약).
  const workOnlyChat = chats.createChat({ agentId: "projection-agent", title: "Global Work task" });
  const workOnlyTask = tasks.getCanonicalTaskForChat(workOnlyChat.id);
  assert.ok(workOnlyTask);
  assert.equal(
    runtime.getProjection(workOnlyTask.id, { surface: "one", mode: "summary" }),
    null,
    "a global Work task must never project into One",
  );
  assert.ok(
    runtime.getProjection(workOnlyTask.id, { surface: "work", mode: "summary" }),
    "the same task stays visible on the Work surface",
  );

  assert.deepEqual(canonicalParity(alphaWork), canonicalParity(alphaOne));
  assert.deepEqual(canonicalParity(alphaMobile), canonicalParity(alphaOne));
  assert.equal(alphaWork.projectionMode, "detailed", "Work must force the detailed projection");
  assert.equal(alphaOne.references.teamRunId, "run:alpha-team");
  assert.equal(alphaOne.references.manifestId, "manifest:alpha");
  assert.deepEqual(alphaOne.references.decisionIds, [alphaDecision.id]);
  assert.deepEqual(
    new Set(alphaOne.references.artifactIds),
    new Set(["artifact:alpha-report"]),
  );
  assert.deepEqual(
    new Set(alphaOne.references.receiptIds),
    new Set(["run:alpha-team", "receipt:alpha-evidence", "receipt:alpha-step"]),
  );
  assert.equal(JSON.stringify(alphaOne).includes("beta"), false, "Alpha must not contain Beta refs");
  assert.equal(JSON.stringify(betaOne).includes("alpha"), false, "Beta must not contain Alpha refs");
  assert.equal(betaOne.references.teamRunId, "run:beta-team");
  assert.equal(betaOne.references.manifestId, "manifest:beta");
  assert.deepEqual(betaOne.references.decisionIds, []);

  const listed = runtime.listProjections({ surface: "one", limit: 20, includeArchived: true });
  assert.deepEqual(
    new Set(listed.map((item) => item.taskId)),
    new Set([alphaTask.id, betaTask.id]),
    "two canonical Tasks must remain isolated and independently listable",
  );
  assert.equal(alphaOne.oneId, profileStore.getOneProfile().oneId);
  verifyClosedContract(contract, alphaOne);

  const currentAlpha = tasks.getCanonicalTask(alphaTask.id);
  const unsafeTitle = `Review /Users/operator/private token=sk-${"A".repeat(32)}`;
  const sanitizedRuntime = makeRuntime(runtimeModule, tasks, {
    sources: {
      getCanonicalTask: (taskId) => taskId === currentAlpha.id
        ? { ...currentAlpha, title: unsafeTitle }
        : tasks.getCanonicalTask(taskId),
    },
  });
  const sanitized = sanitizedRuntime.getProjection(alphaTask.id, { surface: "one" });
  assert.ok(sanitized);
  assert.equal(JSON.stringify(sanitized).includes("/Users/operator"), false);
  assert.equal(JSON.stringify(sanitized).includes("sk-"), false);
  assert.equal(contract.isAgentlasOneTaskProjectionV1(sanitized), true);

  const corruptTaskRuntime = makeRuntime(runtimeModule, tasks, {
    sources: { getCanonicalTask: () => ({ ...currentAlpha, unexpected: true }) },
  });
  assert.equal(corruptTaskRuntime.getProjection(alphaTask.id, { surface: "one" }), null);
  const corruptProfileRuntime = makeRuntime(runtimeModule, tasks, {
    sources: { getOneProfile: () => ({ ...profileStore.getOneProfile(), unexpected: true }) },
  });
  assert.equal(corruptProfileRuntime.getProjection(alphaTask.id, { surface: "one" }), null);

  const mismatchedReceiptRuntime = makeRuntime(runtimeModule, tasks, {
    sources: {
      getLatestInvocationRunReceipt: () => ({
        ...runEvents.getLatestInvocationRunReceipt(alphaChat.id),
        chatId: betaChat.id,
      }),
    },
  });
  const noMismatchedReceipt = mismatchedReceiptRuntime.getProjection(alphaTask.id, { surface: "one" });
  assert.ok(noMismatchedReceipt);
  assert.equal(noMismatchedReceipt.references.teamRunId, undefined);
  assert.equal(noMismatchedReceipt.references.manifestId, undefined);
  assert.deepEqual(noMismatchedReceipt.references.receiptIds, []);

  const unboundConversationReceiptRuntime = makeRuntime(runtimeModule, tasks, {
    sources: {
      getLatestInvocationRunReceipt: () => ({
        ...runEvents.getLatestInvocationRunReceipt(alphaChat.id),
        runId: "run:general-conversation",
      }),
      listOneDomainEvents: () => [],
    },
  });
  const noPromotedConversationReceipt = unboundConversationReceiptRuntime.getProjection(alphaTask.id, { surface: "one" });
  assert.ok(noPromotedConversationReceipt);
  assert.equal(noPromotedConversationReceipt.references.teamRunId, undefined);
  assert.deepEqual(noPromotedConversationReceipt.references.receiptIds, []);

  const mismatchedSurfaceRuntime = makeRuntime(runtimeModule, tasks, {
    sources: {
      getDurableOneSurfaceResult: () => ({
        runId: "run:alpha-team",
        chatId: alphaChat.id,
        taskId: betaTask.id,
        recordedAt: currentAlpha.updatedAt,
        manifest: manifest(betaTask.id, "beta"),
      }),
    },
  });
  const noMismatchedSurface = mismatchedSurfaceRuntime.getProjection(alphaTask.id, { surface: "one" });
  assert.ok(noMismatchedSurface);
  assert.equal(noMismatchedSurface.references.teamRunId, "run:alpha-team");
  assert.equal(noMismatchedSurface.references.manifestId, undefined);
  assert.deepEqual(noMismatchedSurface.references.artifactIds, []);

  const offlineRuntime = makeRuntime(runtimeModule, tasks, {
    getAuthoritySnapshot: ({ task }) => ({
      connection: "offline",
      lastSyncedAt: task.updatedAt,
      authoritativeHostRef: HOST_REF,
      executionAuthorityAvailable: false,
      mutationMode: "queue_only",
    }),
    sources: {
      listPendingOperations: () => [{
        operationId: "operation:alpha-approval",
        intent: "approve_decision",
        targetRef: alphaDecision.id,
        state: "queued",
        baseVersion: currentAlpha.version,
        createdAt: currentAlpha.updatedAt,
      }],
    },
  });
  const offline = offlineRuntime.getProjection(alphaTask.id, { surface: "mobile" });
  assert.ok(offline);
  assert.equal(offline.status.source, "cached_projection");
  assert.equal(offline.sync.queuedOperationCount, 1);
  assert.deepEqual(offline.truth, { mayStartExecution: false, mayClaimNewCompletion: false });
  assert.equal(contract.isAgentlasOneTaskProjectionV1(offline), true);

  const dishonestOffline = makeRuntime(runtimeModule, tasks, {
    getAuthoritySnapshot: ({ task }) => ({
      connection: "offline",
      lastSyncedAt: task.updatedAt,
      authoritativeHostRef: HOST_REF,
      executionAuthorityAvailable: true,
      mutationMode: "direct",
    }),
  });
  assert.equal(dishonestOffline.getProjection(alphaTask.id, { surface: "mobile" }), null);
  const staleOffline = makeRuntime(runtimeModule, tasks, {
    getAuthoritySnapshot: () => ({
      connection: "offline",
      lastSyncedAt: "2020-01-01T00:00:00.000Z",
      authoritativeHostRef: HOST_REF,
      executionAuthorityAvailable: false,
      mutationMode: "read_only",
    }),
  });
  assert.equal(staleOffline.getProjection(alphaTask.id, { surface: "mobile" }), null);
  const corruptQueue = makeRuntime(runtimeModule, tasks, {
    sources: {
      listPendingOperations: () => [{
        operationId: "operation:bad",
        intent: "approve_decision",
        targetRef: alphaDecision.id,
        state: "queued",
        baseVersion: currentAlpha.version,
        createdAt: currentAlpha.updatedAt,
        secret: "unsupported",
      }],
    },
  });
  assert.equal(corruptQueue.getProjection(alphaTask.id, { surface: "mobile" }), null);
  assert.equal(runtime.getProjection("task:missing", { surface: "one" }), null, "no canonical Task must fail closed");

  const expected = {
    taskId: alphaOne.taskId,
    canonicalVersion: alphaOne.canonicalVersion,
    oneId: alphaOne.oneId,
    references: alphaOne.references,
    decisionId: alphaDecision.id,
  };
  fs.writeFileSync(expectedPath, JSON.stringify(expected), "utf8");
  console.log(JSON.stringify({
    ok: true,
    twoTaskIsolation: true,
    threeSurfaceParity: true,
    offlineTruth: true,
    taskId: alphaOne.taskId,
  }));
  db.close();
  app.quit();
}

async function verifyReload() {
  const expectedPath = argument("--expected");
  if (!expectedPath) throw new Error("reload requires --expected");
  const expected = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  const { app, db } = await openStore();
  const tasks = require("../dist/electron/store/tasks.js");
  const runtimeModule = require("../dist/electron/one/task-projection.js");
  const contract = require("../dist/shared/one-task-projection.js");
  const runtime = makeRuntime(runtimeModule, tasks);
  const restored = runtime.getProjection(expected.taskId, { surface: "one" });
  assert.ok(restored);
  assert.equal(restored.canonicalVersion, expected.canonicalVersion);
  assert.equal(restored.oneId, expected.oneId);
  assert.deepEqual(restored.references, expected.references);
  assert.deepEqual(restored.references.decisionIds, [expected.decisionId]);
  assert.equal(contract.isAgentlasOneTaskProjectionV1(restored), true);
  console.log(JSON.stringify({ ok: true, durableRefsAfterRestart: true, taskId: restored.taskId }));
  db.close();
  app.quit();
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const root = path.resolve(__dirname, "..");
  const required = [
    "dist/shared/one-task-projection.js",
    "dist/electron/one/task-projection.js",
  ];
  for (const file of required) {
    if (!fs.existsSync(path.join(root, file))) {
      throw new Error(`Missing ${file}; run npm run build:electron first`);
    }
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-task-projection-"));
  const expectedPath = path.join(temp, "expected.json");
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "projection.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const seed = spawnSync(executable, [
      __filename,
      "--worker",
      `--user-data=${path.join(temp, "user-data")}`,
      `--expected=${expectedPath}`,
    ], { env, encoding: "utf8" });
    if (seed.status !== 0) {
      throw new Error(`Task projection worker failed (${seed.status})\n${seed.stdout}\n${seed.stderr}`);
    }
    process.stdout.write(seed.stdout);
    const reload = spawnSync(executable, [
      __filename,
      "--verify-reload",
      `--user-data=${path.join(temp, "user-data-reload")}`,
      `--expected=${expectedPath}`,
    ], { env, encoding: "utf8" });
    if (reload.status !== 0) {
      throw new Error(`Task projection reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    }
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  seedWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv.includes("--verify-reload")) {
  verifyReload().then(() => process.exit(0)).catch((error) => {
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
