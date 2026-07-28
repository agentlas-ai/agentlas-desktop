#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-live-borrowed-tf-"));
const userDataDir = path.join(tempDir, "user-data");
process.env.AGENTLAS_STORE_PATH = path.join(tempDir, "agentlas.sqlite");
app.setPath("userData", userDataDir);

// 라이브 테스트는 실제 Hub를 상대한다 — 격리 프로필에 실 로그인 세션만 복사해
// 재사용한다(store/캐시는 계속 격리). 세션이 없으면 기존처럼 sign-in 오류로
// 정직하게 실패한다.
try {
  const realAuthDir = path.join(app.getPath("appData"), "Agentlas", "auth");
  if (fs.existsSync(realAuthDir)) {
    fs.cpSync(realAuthDir, path.join(userDataDir, "auth"), { recursive: true });
  }
} catch {
  /* 세션 복사 실패 = 로그인 필요 오류로 드러난다 */
}

const DEFAULT_SLUGS = [
  "researcher-046-agent-repo-security-reviewer",
  "researcher-017-agent-repo-security-regression-suite",
];

const slugs = (process.env.AGENTLAS_LIVE_TF_SLUGS || DEFAULT_SLUGS.join(","))
  .split(",")
  .map((slug) => slug.trim())
  .filter(Boolean);

const prompt = process.env.AGENTLAS_LIVE_TF_PROMPT || [
  "라이브 borrowed task-force 스모크 테스트다.",
  "Agentlas Desktop의 Hub borrowed TF 오케스트레이션 변경을 대상으로,",
  "보안 리뷰 담당은 위험/권한 경계만 3줄, 회귀 테스트 담당은 검증 포인트만 3줄로 답하고,",
  "오케스트레이터는 둘을 합쳐 5줄 이하 한국어 최종 요약을 작성하라.",
].join(" ");

async function main() {
  const { initStore } = require("../dist/electron/store/db.js");
  const { seedBuiltinAgents } = require("../dist/electron/architecture/seed.js");
  const { createChat, setChatWorkingFolder, listChatMessages } = require("../dist/electron/store/chats.js");
  const { runMcpInvocation } = require("../dist/electron/mcp/client.js");
  const { detectRuntimes } = require("../dist/electron/runtime/detect.js");
  const { pickActive } = require("../dist/electron/runtime/selection.js");
  const { hepCall } = require("../dist/electron/hephaestus/commands.js");

  initStore();
  seedBuiltinAgents();

  // Workforce 경로는 웹 세션 필수 — 앱 부트와 동일하게 Keychain/쿠키 파일에서
  // 실 로그인 세션을 복원한다(위에서 auth/를 격리 프로필로 복사해 둠).
  const auth = require("../dist/electron/auth.js");
  if (typeof auth.bootAuthFromKeychain === "function") {
    await auth.bootAuthFromKeychain();
  }

  const runtimes = await detectRuntimes();
  const active = pickActive(runtimes);
  assert.ok(active, "live borrowed TF test needs an active local runtime");

  const project = path.resolve(process.cwd());
  const directHub = await hepCall(slugs.join(","), [prompt], { project, timeoutMs: 180_000 });
  assert.equal(directHub.ok, true, `direct hepCall failed: ${directHub.stderr || directHub.stdout}`);
  assert.ok(directHub.json, "direct hepCall must return JSON grounding");

  const chat = createChat({
    title: "Live borrowed task-force smoke",
    kind: "user",
  });
  setChatWorkingFolder(chat.id, project);

  const events = [];
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.AGENTLAS_LIVE_TF_TIMEOUT_MS || 480_000));
  try {
    await runMcpInvocation(
      {
        chatId: chat.id,
        userPrompt: prompt,
        borrowAgents: slugs,
        locale: "ko",
        permissions: "read",
      },
      (event) => {
        events.push(event);
        const marker = [
          event.kind,
          event.phase || "",
          event.agentName || event.agentId || "",
          event.status || event.error?.message || "",
        ]
          .filter(Boolean)
          .join(" | ");
        if (marker) console.log(marker);
      },
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
  }

  const errors = events.filter((event) => event.kind === "error");
  assert.equal(errors.length, 0, `run emitted errors: ${JSON.stringify(errors, null, 2)}`);
  assert.ok(events.some((event) => event.phase === "plan" && String(event.agentId || "").includes("borrow-orchestrator")), "missing orchestrator plan event");
  assert.ok(events.some((event) => event.phase === "delegate" && Array.isArray(event.delegateTo) && event.delegateTo.length >= 2), "missing delegate handoff to borrowed agents");
  const completedBorrowed = new Set(
    events
      .filter((event) => event.done && String(event.agentId || "").startsWith("borrow:"))
      .map((event) => event.agentId),
  );
  assert.ok(completedBorrowed.size >= 2, `expected at least 2 completed borrowed agents, got ${[...completedBorrowed].join(", ")}`);
  assert.ok(events.some((event) => event.phase === "synthesize" && String(event.agentId || "").includes("borrow-orchestrator")), "missing synthesis event");
  const final = events.findLast((event) => event.kind === "final");
  assert.ok(final && String(final.text || "").trim().length > 0, "missing final answer");

  const messages = listChatMessages(chat.id);
  assert.ok(messages.some((message) => message.role === "assistant" && message.text.includes(String(final.text).slice(0, 20))), "final answer should persist to chat history");

  const proof = {
    ok: true,
    activeRuntime: {
      kind: active.kind,
      backend: active.backend,
      source: active.source,
      model: active.model || null,
    },
    slugs,
    eventCount: events.length,
    completedBorrowed: [...completedBorrowed],
    finalPreview: String(final.text).slice(0, 800),
  };
  console.log("LIVE_BORROWED_TF_PROOF " + JSON.stringify(proof, null, 2));
}

app.whenReady()
  .then(main)
  .then(() => {
    app.quit();
  })
  .catch((err) => {
    console.error(err);
    app.exit(1);
  })
  .finally(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
