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
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  return { app, db: store.getDb() };
}

function manifest(taskId) {
  const blockOrder = ["block:launch-document", "block:launch-status"];
  return {
    contractVersion: "1.0.0",
    manifestId: "manifest:launch-search",
    taskId,
    title: "Competitive launch result",
    summary: "The verified competitive pricing insight is ready.",
    layoutProfile: "report",
    surfaceState: {
      value: "ready",
      summary: "Verified result projection.",
      readOnly: true,
      lastSyncedAt: "2026-07-18T12:00:00.000Z",
    },
    blocks: [
      {
        blockId: blockOrder[0],
        type: "Document",
        title: "Competitive report",
        artifactRef: "artifact:launch-brief",
        excerpt: "Pricing position and launch risks are compared.",
        pageCount: 5,
      },
      {
        blockId: blockOrder[1],
        type: "Status",
        title: "Execution status",
        taskState: "completed",
        steps: [{
          stepRef: "step:launch-research",
          label: "Research",
          status: "completed",
          receiptRef: "receipt:launch-research",
        }],
      },
    ],
    primaryAction: null,
    secondaryActions: [],
    evidence: [{
      evidenceRef: "receipt:launch-evidence",
      kind: "receipt",
      verificationStatus: "verified",
      label: "Execution receipt",
    }],
    fallback: {
      markdown: "Verified competitive pricing insight.",
      artifacts: [{
        artifactRef: "artifact:launch-brief",
        type: "document",
        label: "launch-brief.pdf",
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

async function seedWorker() {
  const { app, db } = await openStore();
  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const surfaces = require("../dist/electron/store/one-surface-results.js");
  const search = require("../dist/electron/one/search.js");
  const now = "2026-07-18T00:00:00.000Z";
  db.prepare(
    `INSERT INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-search-agent", "one-search-owner", "One", "Chief of Staff", now);

  const seeded = [];
  for (let index = 0; index < 75; index += 1) {
    const chat = chats.createChat({
      agentId: "one-search-agent",
      title: `Needle history ${String(index).padStart(3, "0")}`,
    });
    const task = tasks.getCanonicalTaskForChat(chat.id);
    const stamp = new Date(Date.parse("2026-07-17T12:00:00.000Z") - index * 1_000).toISOString();
    db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?").run(stamp, chat.id);
    db.prepare("UPDATE tasks SET updated_at = ? WHERE id = ?").run(stamp, task.id);
    seeded.push({ chatId: chat.id, taskId: task.id, stamp });
  }

  const contractVersion = "1.0.0";
  let cursor = null;
  const allHits = [];
  do {
    const page = search.searchOneHistory({
      contractVersion,
      query: "needle history",
      limit: 17,
      cursor,
      includeArchived: true,
    });
    assert.ok(page.hits.length <= 17);
    allHits.push(...page.hits);
    cursor = page.nextCursor;
  } while (cursor);
  assert.equal(allHits.length, 75, "cursor traversal must find history beyond the recent-50 UI window");
  assert.equal(new Set(allHits.map((hit) => hit.taskId)).size, 75, "pages must not repeat a Task");
  assert.deepEqual([...allHits].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), allHits);

  const firstPage = search.searchOneHistory({
    contractVersion,
    query: "needle history",
    limit: 5,
    includeArchived: true,
  });
  assert.ok(firstPage.nextCursor);
  assert.throws(() => search.searchOneHistory({
    contractVersion,
    query: "different query",
    limit: 5,
    cursor: firstPage.nextCursor,
    includeArchived: true,
  }), /does not belong/);
  assert.throws(() => search.searchOneHistory({
    contractVersion,
    query: "needle history",
    limit: 5,
    cursor: firstPage.nextCursor,
    includeArchived: false,
  }), /does not belong/);
  assert.throws(() => search.searchOneHistory({
    contractVersion,
    query: "needle",
    cursor: "not-a-valid-cursor",
  }), /Invalid One search cursor/);
  assert.throws(() => search.searchOneHistory({
    contractVersion,
    query: "needle",
    injectedProjectId: "project_private",
  }), /unsupported fields/);
  assert.throws(() => search.searchOneHistory({ contractVersion, query: "", limit: 20 }), /must contain/);
  assert.throws(() => search.searchOneHistory({ contractVersion, query: "needle", limit: 51 }), /between 1 and 50/);
  const literalChat = chats.createChat({ agentId: "one-search-agent", title: "Literal 100%_match token" });
  const literalTask = tasks.getCanonicalTaskForChat(literalChat.id);
  const literalPage = search.searchOneHistory({ contractVersion, query: "100%_match", limit: 10 });
  assert.equal(literalPage.hits.length, 1, "LIKE wildcard characters must be treated as literal query text");
  assert.equal(literalPage.hits[0].taskId, literalTask.id);

  const conversation = chats.createChat({
    agentId: "one-search-agent",
    title: "General planning",
    taskMode: "conversation",
  });
  chats.appendChatMessage(conversation.id, "user", "Remember the amber lighthouse discussion");
  const conversationPage = search.searchOneHistory({ contractVersion, query: "amber lighthouse", limit: 10 });
  assert.equal(conversationPage.hits.length, 1);
  assert.equal(conversationPage.hits[0].kind, "conversation");
  assert.equal(conversationPage.hits[0].taskId, null);

  const resultChat = chats.createChat({ agentId: "one-search-agent", title: "Launch package" });
  const resultTask = tasks.getCanonicalTaskForChat(resultChat.id);
  surfaces.recordDurableOneSurfaceResult({
    runId: "run:search-launch",
    chatId: resultChat.id,
    manifest: manifest(resultTask.id),
  });
  const artifactPage = search.searchOneHistory({ contractVersion, query: "launch-brief.pdf", limit: 10 });
  assert.equal(artifactPage.hits[0].kind, "artifact");
  assert.equal(artifactPage.hits[0].taskId, resultTask.id);
  assert.deepEqual(artifactPage.hits[0].matchedBy.includes("artifact_label"), true);
  const resultPage = search.searchOneHistory({ contractVersion, query: "competitive pricing insight", limit: 10 });
  assert.equal(resultPage.hits[0].kind, "result");
  assert.equal(resultPage.hits[0].taskId, resultTask.id);

  const teamChat = chats.createChat({ agentId: "one-search-agent", title: "Team review" });
  const teamTask = tasks.getCanonicalTaskForChat(teamChat.id);
  db.prepare(
    `INSERT INTO task_agent_participants
       (task_id, agent_id, agent_slug, role, first_seen_at, last_seen_at)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  ).run(teamTask.id, "legal-review-specialist", "legal reviewer", now, now);
  const teamPage = search.searchOneHistory({ contractVersion, query: "legal reviewer", limit: 10 });
  assert.equal(teamPage.hits[0].kind, "team");
  assert.equal(teamPage.hits[0].taskId, teamTask.id);

  const secret = `sk-${"A".repeat(32)}`;
  const secretChat = chats.createChat({ agentId: "one-search-agent", title: "Credential diagnosis" });
  const secretTask = tasks.getCanonicalTaskForChat(secretChat.id);
  chats.appendChatMessage(
    secretChat.id,
    "user",
    `credential evidence ${secret} at /Users/mason/private/customer.txt`,
  );
  const secretPage = search.searchOneHistory({ contractVersion, query: "credential evidence", limit: 10 });
  const secretHit = secretPage.hits.find((hit) => hit.taskId === secretTask.id);
  assert.ok(secretHit);
  assert.equal(JSON.stringify(secretHit).includes(secret), false);
  assert.equal(JSON.stringify(secretHit).includes("/Users/mason"), false);
  assert.match(secretHit.detail, /\[redacted-secret\]/);
  assert.match(secretHit.detail, /\[local-path\]/);
  assert.ok(secretHit.detail.length <= 182, "bounded snippets must stay bounded including ellipses");
  assert.deepEqual(
    Object.keys(secretHit).sort(),
    ["archived", "chatId", "contractVersion", "detail", "hitId", "kind", "matchedBy", "status", "taskId", "title", "updatedAt"].sort(),
    "raw messages and result JSON must not cross the closed hit contract",
  );

  const archiveTarget = seeded[10];
  const archiveTask = tasks.setCanonicalTaskStatus(archiveTarget.taskId, "completed");
  const archiveChat = chats.getChat(archiveTarget.chatId);
  assert.throws(() => search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: archiveTask.version,
    expectedOriginChatUpdatedAt: chats.getChat(seeded[11].chatId).updatedAt,
    operation: "archive",
    confirmedByUser: true,
  }), /Conversation changed/);
  assert.equal(tasks.getCanonicalTask(archiveTask.id).status, "completed", "failed cross-binding must roll back both rows");
  assert.equal(chats.getChat(archiveChat.id).archivedAt, null);
  assert.throws(() => search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: archiveTask.version,
    expectedOriginChatUpdatedAt: archiveChat.updatedAt,
    operation: "archive",
    confirmedByUser: true,
    injectedChatId: seeded[11].chatId,
  }), /unsupported fields/);
  const archived = search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: archiveTask.version,
    expectedOriginChatUpdatedAt: archiveChat.updatedAt,
    operation: "archive",
    confirmedByUser: true,
  });
  assert.equal(archived.archived, true);
  assert.equal(tasks.getCanonicalTask(archiveTask.id).status, "archived");
  assert.ok(chats.getChat(archiveChat.id).archivedAt);
  assert.equal(
    search.searchOneHistory({ contractVersion, query: "needle history 010", includeArchived: false }).hits.length,
    0,
  );
  assert.equal(
    search.searchOneHistory({ contractVersion, query: "needle history 010", includeArchived: true }).hits[0].archived,
    true,
  );
  assert.throws(() => search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: archiveTask.version,
    expectedOriginChatUpdatedAt: archiveChat.updatedAt,
    operation: "archive",
    confirmedByUser: true,
  }), /changed|already archived/, "a double click must not replay a stale mutation");
  assert.equal(tasks.getCanonicalTask(archiveTask.id).version, archived.taskVersion);
  assert.equal(chats.getChat(archiveChat.id).updatedAt, archived.originChatUpdatedAt);
  const restored = search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: archived.taskVersion,
    expectedOriginChatUpdatedAt: archived.originChatUpdatedAt,
    operation: "restore",
    confirmedByUser: true,
  });
  assert.equal(restored.archived, false);
  assert.equal(tasks.getCanonicalTask(archiveTask.id).status, "completed", "restore must preserve the exact pre-archive canonical status");
  assert.equal(chats.getChat(archiveChat.id).archivedAt, null);
  assert.throws(() => search.mutateOneTaskArchive({
    contractVersion,
    taskId: archiveTask.id,
    expectedTaskVersion: restored.taskVersion,
    expectedOriginChatUpdatedAt: restored.originChatUpdatedAt,
    operation: "archive",
    confirmedByUser: false,
  }), /explicit user confirmation/);

  const runningTarget = seeded[12];
  const runningTask = tasks.setCanonicalTaskStatus(runningTarget.taskId, "running");
  const runningChat = chats.getChat(runningTarget.chatId);
  assert.throws(() => search.mutateOneTaskArchive({
    contractVersion,
    taskId: runningTask.id,
    expectedTaskVersion: runningTask.version,
    expectedOriginChatUpdatedAt: runningChat.updatedAt,
    operation: "archive",
    confirmedByUser: true,
  }), /running Task/);

  const restartTarget = seeded[20];
  const restartTask = tasks.getCanonicalTask(restartTarget.taskId);
  const restartChat = chats.getChat(restartTarget.chatId);
  search.mutateOneTaskArchive({
    contractVersion,
    taskId: restartTask.id,
    expectedTaskVersion: restartTask.version,
    expectedOriginChatUpdatedAt: restartChat.updatedAt,
    operation: "archive",
    confirmedByUser: true,
  });
  fs.writeFileSync(argument("--expected"), JSON.stringify({
    taskId: restartTask.id,
    chatId: restartChat.id,
  }));
  app.quit();
}

async function restartWorker() {
  const { app } = await openStore();
  const expected = JSON.parse(fs.readFileSync(argument("--expected"), "utf8"));
  const tasks = require("../dist/electron/store/tasks.js");
  const chats = require("../dist/electron/store/chats.js");
  const search = require("../dist/electron/one/search.js");
  const task = tasks.getCanonicalTask(expected.taskId);
  const chat = chats.getChat(expected.chatId);
  assert.equal(task.status, "archived", "atomic archive must survive a Main restart");
  assert.ok(chat.archivedAt);
  const page = search.searchOneHistory({
    contractVersion: "1.0.0",
    query: "needle history 020",
    includeArchived: true,
  });
  assert.equal(page.hits[0].taskId, expected.taskId);
  assert.equal(page.hits[0].archived, true);
  app.quit();
}

if (process.argv.includes("--seed-worker")) {
  seedWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else if (process.argv.includes("--restart-worker")) {
  restartWorker().then(() => process.exit(0)).catch((error) => {
    console.error(error);
    process.exit(1);
  });
} else {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-search-"));
  const store = path.join(temp, "one-search.sqlite");
  const expected = path.join(temp, "expected.json");
  const env = { ...process.env, AGENTLAS_STORE_PATH: store };
  const seed = spawnSync(
    executable,
    [__filename, "--seed-worker", `--user-data=${path.join(temp, "user-data")}`, `--expected=${expected}`],
    { env, encoding: "utf8", timeout: 120_000 },
  );
  if (seed.status !== 0) {
    process.stderr.write(seed.stdout || "");
    process.stderr.write(seed.stderr || "");
    process.exit(seed.status ?? 1);
  }
  const restart = spawnSync(
    executable,
    [__filename, "--restart-worker", `--user-data=${path.join(temp, "user-data-restart")}`, `--expected=${expected}`],
    { env, encoding: "utf8", timeout: 120_000 },
  );
  fs.rmSync(temp, { recursive: true, force: true });
  if (restart.status !== 0) {
    process.stderr.write(restart.stdout || "");
    process.stderr.write(restart.stderr || "");
    process.exit(restart.status ?? 1);
  }
  console.log("One search/re-entry runtime verification passed (75-item cursor history, safe result pointers, archived find/restore, hostile contracts, atomic CAS, double-click, restart). ");
  process.exit(0);
}
