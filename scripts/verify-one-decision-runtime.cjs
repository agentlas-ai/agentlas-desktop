#!/usr/bin/env node

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

function decisionEntityId(sourceMessageId) {
  return `decision:${createHash("sha256").update(sourceMessageId).digest("hex").slice(0, 32)}`;
}

function pending(chatId, sourceMessageId, overrides = {}) {
  return {
    chatId,
    sourceMessageId,
    chatTitle: "Launch",
    question: "Which output should One prepare?",
    header: "Output",
    optionCount: 2,
    options: [
      { label: "Report", description: "Prepare a reviewable report" },
      { label: "Spreadsheet", description: "Prepare an editable comparison" },
    ],
    multiSelect: false,
    agentId: "one-agent",
    firmId: null,
    createdAt: "2026-07-18T08:00:00.000Z",
    ...overrides,
  };
}

function verifyProjectionContract() {
  const decision = require("../dist/shared/one-decision.js");
  const ordinary = decision.normalizeOneDecision(pending("chat_alpha", "message_alpha"), "task_alpha");
  assert.equal(decision.isOneDecisionViewV1(ordinary), true);
  assert.equal(ordinary.risk.level, "R1");
  assert.ok(ordinary.options.every((option) => option.enabled), "reversible preparation choices stay usable");
  assert.equal(ordinary.controls.reject.source, "product_safe_default", "a safe product-owned reject path always exists");

  const payment = decision.normalizeOneDecision(pending("chat_payment", "message_payment", {
    question: "Pay for the annual subscription and publish the result?",
    header: "Subscription",
    options: [
      { label: "Pay $99 and publish", description: "Charges the card and publishes externally" },
      { label: "Cancel", description: "Do not pay or publish" },
    ],
  }), "task_payment");
  assert.equal(payment.risk.level, "R3");
  assert.equal(payment.risk.certainty, "ambiguous");
  assert.equal(payment.cost.value, "$99");
  assert.equal(payment.options[0].grantsAuthority, true);
  assert.equal(payment.options[0].enabled, false, "unstructured R2+ authority must fail closed");
  assert.equal(payment.options[1].enabled, true, "the exact rejection remains available");
  assert.equal(payment.controls.reject.reply, "Cancel");
  assert.equal(decision.isOneDecisionViewV1(payment), true);

  const unknown = decision.normalizeOneDecision(pending("chat_unknown", "message_unknown", {
    question: "Should I proceed?",
    options: [{ label: "Proceed" }, { label: "Not now" }],
  }), "task_unknown");
  assert.equal(unknown.risk.level, "R2");
  assert.equal(unknown.options[0].enabled, false, "ambiguous mutation-shaped approval never appears enabled");

  const multi = decision.normalizeOneDecision(pending("chat_multi", "message_multi", { multiSelect: true }), "task_multi");
  assert.ok(multi.options.every((option) => !option.enabled), "multi-select must be resolved in Work as one exact answer");

  const secret = decision.normalizeOneDecision(pending("chat_secret", "message_secret", {
    question: `Review api_key=sk-proj-${"A".repeat(32)}?`,
  }), "task_secret");
  assert.equal(JSON.stringify(secret).includes("sk-proj-"), false);
  assert.equal(decision.isOneDecisionViewV1({ ...payment, unexpected: true }), false, "expanded contracts fail closed");
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

function questionFence(question, options) {
  return [
    "<<agentlas-ask>>",
    JSON.stringify({ question, header: "External action", multiSelect: false, options }),
    "<</agentlas-ask>>",
  ].join("\n");
}

async function worker() {
  verifyProjectionContract();
  const { app, db } = await openStore();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
      (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-agent", "one-owner", "One", "Chief of Staff", now);
  const chats = require("../dist/electron/store/chats.js");
  const confirm = require("../dist/electron/confirm/index.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");

  const snoozedChat = chats.createChat({ agentId: "one-agent", title: "Snooze decision" });
  const snoozedMessage = chats.appendChatMessage(snoozedChat.id, "assistant", questionFence(
    "Publish this report?",
    [{ label: "Publish", description: "Makes the report public" }, { label: "Cancel", description: "Keep it private" }],
  ));
  const resolveChat = chats.createChat({ agentId: "one-agent", title: "Reject decision" });
  const resolveMessage = chats.appendChatMessage(resolveChat.id, "assistant", questionFence(
    "Send this email externally?",
    [{ label: "Send email", description: "Sends it now" }, { label: "Do not send", description: "No external action" }],
  ));

  assert.equal(confirm.listPendingConfirmations().length, 2);
  const resumeAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
  const snooze = confirm.snoozePendingConfirmation(snoozedChat.id, snoozedMessage.id, resumeAt);
  assert.equal(snooze.snoozedUntil, resumeAt);
  assert.equal(confirm.listPendingConfirmations().find((item) => item.chatId === snoozedChat.id).snoozedUntil, resumeAt);
  assert.throws(
    () => confirm.snoozePendingConfirmation(snoozedChat.id, "stale-message", resumeAt),
    /stale or no longer pending/,
  );

  const committed = confirm.commitPendingConfirmationAnswer(resolveChat.id, "Do not send");
  assert.equal(committed.sourceMessageId, resolveMessage.id);
  assert.equal(confirm.listPendingConfirmations().some((item) => item.chatId === resolveChat.id), false);
  assert.throws(() => confirm.commitPendingConfirmationAnswer(resolveChat.id, "Send email"), /already accepted|stale or no longer pending/);
  const task = require("../dist/electron/store/tasks.js").getCanonicalTaskForChat(resolveChat.id);
  const events = domainEvents.listOneDomainEvents(decisionEntityId(resolveMessage.id), 10);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, "approval.resolved");
  assert.equal(events[0].taskId, task.id);
  assert.equal(
    events[0].payload.entries.find((entry) => entry.name === "selectedOption").value,
    `option:${createHash("sha256").update("Do not send").digest("hex").slice(0, 24)}`,
    "the domain event binds the exact choice without duplicating user-authored text",
  );
  assert.equal(events.some((event) => event.eventType === "outcome.verified"), false, "a Decision receipt is not an external outcome");

  assert.equal(db.pragma("foreign_key_check").length, 0);
  console.log(JSON.stringify({ ok: true, snoozedDecision: snoozedMessage.id, resolvedDecision: resolveMessage.id }));
  db.close();
  app.quit();
}

async function verifyReload() {
  const { app, db } = await openStore();
  const confirm = require("../dist/electron/confirm/index.js");
  const pendingItems = confirm.listPendingConfirmations();
  assert.equal(pendingItems.length, 1);
  assert.ok(pendingItems[0].snoozedUntil && Date.parse(pendingItems[0].snoozedUntil) > Date.now());
  assert.equal(confirm.listCommittedQuestionAnswers(pendingItems[0].chatId).length, 0, "snooze must not resolve or approve");
  console.log(JSON.stringify({ ok: true, restoredSnoozeAfterRestart: true }));
  db.close();
  app.quit();
}

function verifyWiring() {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const shell = read("renderer/components/one/OneShell.tsx");
  const css = read("renderer/components/one/OneShell.module.css");
  const ipc = read("electron/ipc.ts");
  const preload = read("electron/preload.ts");
  assert.match(shell, /normalizeOneDecision\(confirmation, taskId\)/, "One must render the closed normalized Decision view");
  assert.match(shell, /approvalBlocked/, "unstructured high-risk approvals need a visible fail-closed guard");
  assert.match(shell, /decision\.controls\.reject\.reply/, "every Decision must keep an explicit reject path");
  assert.match(shell, /onOpenWork/, "every Decision must keep a modification path into Work");
  assert.match(shell, /api\.confirm\.snooze/, "later must persist through Main instead of local component state");
  assert.match(shell, /api\.confirm\.committedAnswers/, "resolved Decisions must restore from the durable answer receipt");
  assert.match(shell, /거절과 나중에 결정은 승인이나 외부 실행을 시작하지 않습니다|Rejecting or deciding later does not approve or start an external action/, "a resolved Decision must not claim the external action succeeded");
  assert.doesNotMatch(shell, /confirmation\.options\.map\(\(option\) => <button/, "raw model options must not bypass normalization");
  assert.match(css, /min-height:\s*44px/, "Decision controls must preserve a 44px target");
  assert.match(ipc, /confirm:snooze/);
  assert.match(preload, /confirm:snooze/);
}

function orchestrate() {
  verifyWiring();
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-decision-runtime-"));
  const env = { ...process.env, AGENTLAS_STORE_PATH: path.join(temp, "one-decision.sqlite") };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const first = spawnSync(executable, [__filename, "--worker", `--user-data=${path.join(temp, "user-data")}`], { env, encoding: "utf8" });
    if (first.status !== 0) throw new Error(`One Decision worker failed (${first.status})\n${first.stdout}\n${first.stderr}`);
    process.stdout.write(first.stdout);
    const reload = spawnSync(executable, [__filename, "--verify-reload", `--user-data=${path.join(temp, "user-data-reload")}`], { env, encoding: "utf8" });
    if (reload.status !== 0) throw new Error(`One Decision reload failed (${reload.status})\n${reload.stdout}\n${reload.stderr}`);
    process.stdout.write(reload.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--verify-reload")) {
  verifyReload().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
