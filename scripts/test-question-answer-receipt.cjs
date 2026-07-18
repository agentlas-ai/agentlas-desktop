#!/usr/bin/env node
// Regression contract for the stale question-notification bug: an answered
// bottom-sheet question must stay resolved even when the follow-up run never
// persists the user reply (group/firm/borrowed/Stormbreaker early returns).
// The durable truth is the question_answer_committed receipt in run_events,
// not the volatile renderer state or a fallible chat append.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-question-receipt-"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

const ASK_FENCE = [
  "<<agentlas-ask>>",
  JSON.stringify({
    question: "어느 환경에 배포할까요?",
    header: "배포 환경",
    options: [{ label: "스테이징" }, { label: "프로덕션" }],
    multiSelect: false,
  }),
  "<</agentlas-ask>>",
].join("\n");

async function main() {
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  db.initStore();
  db.getDb()
    .prepare(
      `INSERT INTO installed_agents
        (id, slug, name, tagline, system_prompt, mcp_servers_json,
         preferred_backend, trust_grade, installed_at, tone)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "question-receipt-agent", "question-receipt-agent", "Question Receipt Agent",
      "Test fixture", "# Test", "[]", "codex", "A",
      new Date("2026-07-18T00:00:00.000Z").toISOString(), "blue",
    );
  const chats = require("../dist/electron/store/chats.js");
  const confirm = require("../dist/electron/confirm/index.js");

  const chat = chats.createChat({ agentId: "question-receipt-agent", title: "Receipt chat" });
  chats.appendChatMessage(chat.id, "user", "배포 준비해줘");
  chats.appendChatMessage(chat.id, "assistant", `준비했습니다.\n${ASK_FENCE}`);

  const pendingBefore = confirm.listPendingConfirmations();
  const mine = pendingBefore.find((item) => item.chatId === chat.id);
  assert.ok(mine, "an unanswered ask fence as the last message must be pending");
  assert.equal(mine.optionCount, 2);

  // The submit-time commit is the durable resolution. Note: NO user reply row
  // is appended here — this simulates exactly the broken orchestrator branches
  // that skip persistUserMessage.
  const committed = confirm.commitPendingConfirmationAnswer(chat.id, "선택: 스테이징");
  assert.equal(committed.sourceMessageId, mine.sourceMessageId);

  assert.ok(
    !confirm.listPendingConfirmations().some((item) => item.chatId === chat.id),
    "a committed answer must remove the question from the pending list without any chat append",
  );
  const receipts = confirm.listCommittedQuestionAnswers(chat.id);
  assert.equal(receipts.length, 1, "exactly one durable receipt per committed answer");
  assert.equal(receipts[0].sourceMessageId, mine.sourceMessageId);
  assert.equal(receipts[0].reply, "선택: 스테이징");

  // Double submits of a stale question must fail loudly instead of re-running
  // an irreversible choice.
  assert.throws(
    () => confirm.commitPendingConfirmationAnswer(chat.id, "선택: 프로덕션"),
    /already accepted|stale|no longer pending/i,
  );

  // A NEW ask after the answered one becomes pending independently.
  chats.appendChatMessage(chat.id, "assistant", `다음 단계입니다.\n${ASK_FENCE}`);
  const pendingAfter = confirm.listPendingConfirmations().find((item) => item.chatId === chat.id);
  assert.ok(pendingAfter, "a newer ask must be pending again");
  assert.notEqual(pendingAfter.sourceMessageId, mine.sourceMessageId);

  console.log("question answer receipt contract ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.exit(process.exitCode ?? 0);
  });
