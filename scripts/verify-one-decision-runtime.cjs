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

  // (a) A stub judged verdict decides. The wordlists survive only as the prior.
  const judgedR1 = decision.normalizeOneDecision(pending("chat_alpha", "message_alpha"), "task_alpha", {
    risk: () => "R1",
    disposition: () => "choice",
  });
  assert.equal(decision.isOneDecisionViewV1(judgedR1), true);
  assert.equal(judgedR1.risk.level, "R1");
  assert.ok(judgedR1.options.every((option) => option.enabled), "a judged reversible R1 keeps choices usable");
  assert.equal(judgedR1.controls.reject.source, "product_safe_default", "a safe product-owned reject path always exists");

  // (c-approval) NO connected-model verdict (no reader) FAILS CLOSED to the
  // highest risk — never the R0/R1 keyword verdict the prompt text would yield.
  const noModel = decision.normalizeOneDecision(pending("chat_alpha", "message_alpha"), "task_alpha");
  assert.equal(decision.isOneDecisionViewV1(noModel), true);
  assert.equal(noModel.risk.level, "R4", "no connected-model verdict fails closed to the highest risk");
  assert.equal(noModel.risk.certainty, "ambiguous");
  assert.ok(noModel.options.every((option) => !option.enabled), "fail-closed options require explicit review");
  assert.equal(noModel.controls.reject.enabled, true, "the safe reject control always works, even failing closed");
  assert.equal(noModel.controls.modify.enabled, true, "the modify-into-Work path stays available when failing closed");

  const paymentPending = pending("chat_payment", "message_payment", {
    question: "Pay for the annual subscription and publish the result?",
    header: "Subscription",
    options: [
      { label: "Pay $99 and publish", description: "Charges the card and publishes externally" },
      { label: "Cancel", description: "Do not pay or publish" },
    ],
  });
  // A judged R3 external effect with judged dispositions produces the intended
  // structured decision.
  const payment = decision.normalizeOneDecision(paymentPending, "task_payment", {
    risk: () => "R3",
    disposition: (text) => (text.includes("Cancel") ? "reject" : "approve"),
  });
  assert.equal(payment.risk.level, "R3");
  assert.equal(payment.risk.certainty, "ambiguous");
  assert.equal(payment.cost.value, "$99", "cost detection is closed-form and unaffected");
  assert.equal(payment.options[0].grantsAuthority, true);
  assert.equal(payment.options[0].enabled, false, "unstructured R2+ authority must fail closed");
  assert.equal(payment.options[1].enabled, true, "the exact judged rejection remains available");
  assert.equal(payment.controls.reject.reply, "Cancel");
  assert.equal(decision.isOneDecisionViewV1(payment), true);
  // With NO model verdict the same payment card fails closed to R4.
  const paymentNoModel = decision.normalizeOneDecision(paymentPending, "task_payment");
  assert.equal(paymentNoModel.risk.level, "R4", "an un-judged payment card fails closed, never keyword R3");
  assert.ok(paymentNoModel.options.every((option) => !option.enabled), "no option is one-click when the risk can't be verified");

  const multi = decision.normalizeOneDecision(pending("chat_multi", "message_multi", { multiSelect: true }), "task_multi", {
    risk: () => "R1",
    disposition: () => "choice",
  });
  assert.ok(multi.options.every((option) => !option.enabled), "multi-select must be resolved in Work as one exact answer");

  const secret = decision.normalizeOneDecision(pending("chat_secret", "message_secret", {
    question: `Review api_key=sk-proj-${"A".repeat(32)}?`,
  }), "task_secret", { risk: () => "R0", disposition: () => "choice" });
  assert.equal(JSON.stringify(secret).includes("sk-proj-"), false, "the secret-value floor is closed-form and unaffected");
  assert.equal(decision.isOneDecisionViewV1({ ...payment, unexpected: true }), false, "expanded contracts fail closed");

  // ── Judged readers decide; NO verdict fails CLOSED (never the keyword verdict) ──
  const arabicCard = {
    question: "هل أقوم بتحويل المبلغ كاملاً إلى الحساب الخارجي الآن؟",
    header: "تحويل الأموال",
    options: [
      { label: "حوّل الآن", description: "ينفّذ التحويل المصرفي فوراً" },
      { label: "لا تنفّذ أي تحويل", description: "يرفض العملية بالكامل" },
    ],
  };
  // (a) Judged verdicts FIRE on a wire-transfer card phrased in a language no wordlist covers.
  const judgedWire = decision.normalizeOneDecision(pending("chat_ar", "message_ar", arabicCard), "task_ar", {
    risk: () => "R4",
    disposition: (text) => (text.includes("حوّل الآن") ? "approve" : "reject"),
  });
  assert.equal(judgedWire.risk.level, "R4", "a judged critical risk must win over a wordlist miss");
  assert.ok(judgedWire.risk.reasons.includes("critical_effect"));
  assert.equal(judgedWire.options[0].disposition, "approve");
  assert.equal(judgedWire.options[0].enabled, false, "judged high-risk unstructured authority fails closed");
  assert.equal(judgedWire.options[1].disposition, "reject");
  assert.equal(decision.isOneDecisionViewV1(judgedWire), true);
  // (b) NO judged verdict FAILS CLOSED — the arabic card's regex would say R0
  // (no wordlist match), but the un-judged decision must NOT return that keyword
  // verdict; it fails closed to R4.
  const fallbackWire = decision.normalizeOneDecision(pending("chat_ar2", "message_ar2", arabicCard), "task_ar2");
  assert.equal(fallbackWire.risk.level, "R4", "no model verdict fails closed, never the R0 wordlist verdict");
  assert.notEqual(fallbackWire.risk.level, "R0", "the fail-closed outcome must not equal the keyword verdict");
  // (c) A judged reader that abstains (returns null) also fails closed.
  const abstained = decision.normalizeOneDecision(pending("chat_ar3", "message_ar3", arabicCard), "task_ar3", {
    risk: () => null,
    disposition: () => null,
  });
  assert.equal(abstained.risk.level, "R4", "a reader that abstains fails closed to the highest risk");
  // (d) Exact judgment kinds are the shared contract the electron warm pass uses.
  assert.equal(decision.ONE_DECISION_RISK_JUDGMENT_KIND, "one-decision-risk");
  assert.equal(decision.ONE_DECISION_DISPOSITION_JUDGMENT_KIND, "one-decision-disposition");
  const judgmentTexts = decision.oneDecisionJudgmentTexts(arabicCard);
  assert.equal(judgmentTexts.options.length, 2);
  assert.ok(judgmentTexts.combined.includes(arabicCard.header));
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
  const i18n = read("renderer/lib/i18n.tsx");
  assert.match(shell, /normalizeOneDecision\(confirmation, taskId, judgedReaders\)/, "One must render the closed normalized Decision view with judged (bridge-warmed) readers");
  assert.match(shell, /useJudgedOneDecision\(confirmation\)/, "the DecisionCard must warm risk/disposition through the judgment bridge");
  assert.match(shell, /modelUnavailable/, "the DecisionCard must surface a connect-a-model state when no model answers");
  assert.match(shell, /approvalBlocked/, "unstructured high-risk approvals need a visible fail-closed guard");
  assert.match(shell, /decision\.controls\.reject\.reply/, "every Decision must keep an explicit reject path");
  assert.match(shell, /onOpenWork/, "every Decision must keep a modification path into Work");
  assert.match(shell, /api\.confirm\.snooze/, "later must persist through Main instead of local component state");
  assert.match(shell, /api\.confirm\.committedAnswers/, "resolved Decisions must restore from the durable answer receipt");
  assert.match(shell, /decisionRejectCopy\(locale\)/, "resolved Decision copy must pass through the localized catalog fallback");
  assert.match(i18n, /거절과 나중에 결정은 승인이나 외부 실행을 시작하지 않습니다|Rejecting or deciding later does not approve or start an external action/, "a resolved Decision must not claim the external action succeeded");
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
