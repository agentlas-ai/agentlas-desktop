#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-runtime-resume-"));
  const userData = path.join(temp, "user-data");
  const binDir = path.join(temp, "bin");
  const codexHome = path.join(temp, "codex-home");
  const workspace = path.join(temp, "workspace");
  const logPath = path.join(temp, "codex-invocations.jsonl");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  app.setPath("userData", userData);
  process.env.AGENTLAS_STORE_PATH = path.join(userData, "test.sqlite");
  process.env.AGENTLAS_QA_CODEX_LOG = logPath;
  process.env.AGENTLAS_RUNTIME_PROBE_CACHE_MS = "0";
  process.env.CODEX_HOME = codexHome;
  process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH || ""}`;
  fs.writeFileSync(path.join(codexHome, "models_cache.json"), JSON.stringify({
    models: [
      {
        slug: "gpt-contract-max",
        visibility: "list",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh", "max"].map((effort) => ({ effort })),
      },
      {
        slug: "gpt-contract-xhigh",
        visibility: "list",
        supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map((effort) => ({ effort })),
      },
      {
        slug: "gpt-contract-max-only",
        visibility: "list",
        supported_reasoning_levels: [{ effort: "max" }],
      },
    ],
  }));

  const fakeCodex = path.join(binDir, "codex");
  const fakeSource = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) { console.log("codex-cli 9.9.9"); process.exit(0); }
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const log = process.env.AGENTLAS_QA_CODEX_LOG;
  const prior = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\\n").filter(Boolean).length : 0;
  fs.appendFileSync(log, JSON.stringify({ args: process.argv.slice(2), stdin: input }) + "\\n");
  console.log(JSON.stringify({ type: "thread.started", thread_id: "thread-qa" }));
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "qa-result-" + (prior + 1) } }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { output_tokens: 7 } }));
});
`;
  fs.writeFileSync(fakeCodex, fakeSource, { mode: 0o755 });

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const now = new Date().toISOString();
  store.getDb().prepare(
    `INSERT INTO installed_agents
      (id, slug, name, tagline, system_prompt, mcp_servers_json, preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', NULL, 'local', ?, 'neutral')`,
  ).run("agent-runtime-contract", "agent-runtime-contract", "Runtime Contract", "test", now);
  store.getDb().prepare(
    `INSERT INTO chats (id, agent_id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("chat-runtime-contract", "agent-runtime-contract", "Runtime resume contract", now, now);
  const { runCodex } = require("../dist/electron/runtime/codex.js");
  const events = { onStatus() {}, onPartial() {}, onTool() {} };
  const base = {
    systemPrompt: "Agent trust runtime contract",
    history: [],
    backendLabel: "Codex QA",
    model: "gpt-contract-one",
    effort: "high",
    permission: "write",
    cwd: workspace,
    locale: "en",
    chatId: "chat-runtime-contract",
    env: { ...process.env },
  };

  const first = await runCodex({
    ...base,
    userPrompt: "Use borrowed-agent-alpha for this attached image",
    images: [{ mediaType: "image/png", data: TINY_PNG.toString("base64"), name: "resume-proof.png" }],
  }, events);
  assert.equal(first.sessionId, "thread-qa");
  assert.equal(first.tokens, 7);

  const second = await runCodex({
    ...base,
    history: [{ id: "h1", role: "user", text: "prior", createdAt: new Date().toISOString() }],
    userPrompt: "Continue with borrowed-agent-beta",
  }, events);
  assert.equal(second.sessionId, "thread-qa");

  const third = await runCodex({
    ...base,
    model: "gpt-contract-two",
    userPrompt: "Model changed; start a clean provider session",
  }, events);
  assert.equal(third.sessionId, "thread-qa");

  await runCodex({
    ...base,
    chatId: undefined,
    permission: "read",
    userPrompt: "Read-only boundary",
  }, events);
  await runCodex({
    ...base,
    chatId: undefined,
    permission: "full",
    userPrompt: "Explicit full boundary",
  }, events);
  const maxEffortRun = await runCodex({
    ...base,
    chatId: undefined,
    model: "gpt-contract-max",
    effort: "max",
    userPrompt: "Host-verified max effort",
  }, events);
  const clampedEffortRun = await runCodex({
    ...base,
    chatId: undefined,
    model: "gpt-contract-xhigh",
    effort: "max",
    userPrompt: "Model profile clamps max effort",
  }, events);
  const noEscalationRun = await runCodex({
    ...base,
    chatId: undefined,
    model: "gpt-contract-max-only",
    effort: "high",
    userPrompt: "Do not exceed the requested effort",
  }, events);
  await assert.rejects(
    runCodex({
      ...base,
      permission: "full",
      chatId: "must-not-persist-untrusted-codex",
      runtimeSessionId: "must-not-resume-untrusted-codex",
      untrustedNoTools: true,
      userPrompt: "Return a result without external authority",
    }, events),
    /still exposes collaboration\/delegation authority/,
    "Codex 0.144.4 untrusted execution must fail before process spawn",
  );
  await assert.rejects(
    runCodex({
      ...base,
      chatId: undefined,
      permission: "read",
      untrustedNoTools: true,
      mcpConfigPath: "/tmp/untrusted-codex-mcp.json",
      mcpAllowedTools: ["mcp__untrusted__read"],
      userPrompt: "Never admit an unverified mixed MCP boundary",
    }, events),
    /MCP grant cannot be admitted/,
  );

  await assert.rejects(
    runCodex({
      ...base,
      cwd: workspace,
      permission: "read",
      restrictedReadBoundary: true,
      userPrompt: "Restricted remote read must fail closed",
    }, events),
    /not enabled for remote or unattended read-only execution/,
  );
  for (const [name, runner] of [
    ["Claude Code", require("../dist/electron/runtime/claude-code.js").runClaudeCode],
    ["Gemini", require("../dist/electron/runtime/gemini.js").runGemini],
    ["Grok", require("../dist/electron/runtime/grok.js").runGrok],
  ]) {
    await assert.rejects(
      runner({
        ...base,
        chatId: undefined,
        permission: "read",
        restrictedReadBoundary: true,
        userPrompt: `Restricted ${name} read must fail closed`,
      }, events),
      /not enabled for restricted read-only execution/,
    );
  }

  const invocations = fs.readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(invocations.length, 8, "restricted, untrusted, and mixed-MCP calls must not spawn a provider process");
  assert.ok(invocations[0].args.includes("gpt-contract-one"), "create must keep the selected model");
  assert.deepEqual(
    invocations[0].args.slice(invocations[0].args.indexOf("--sandbox"), invocations[0].args.indexOf("--sandbox") + 2),
    ["--sandbox", "workspace-write"],
    "write must stay inside the Codex workspace sandbox",
  );
  assert.equal(invocations[0].args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.match(invocations[0].stdin, /borrowed-agent-alpha/);
  assert.match(invocations[0].stdin, /resume-proof\.png/);
  assert.match(invocations[0].stdin, /\.agentlas\/chat-attachments/);

  assert.ok(invocations[1].args.includes("resume"), "same fingerprint must resume the provider session");
  assert.ok(invocations[1].args.includes("thread-qa"));
  assert.ok(invocations[1].args.includes("gpt-contract-one"), "resume must preserve the selected model");
  assert.ok(invocations[1].args.includes('sandbox_mode="workspace-write"'));
  assert.equal(invocations[1].args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.match(invocations[1].stdin, /borrowed-agent-beta/);
  assert.doesNotMatch(invocations[1].stdin, /\[SYSTEM\]/, "resume sends only the new turn payload");

  assert.equal(invocations[2].args.includes("resume"), false, "model change must invalidate the old provider session");
  assert.ok(invocations[2].args.includes("gpt-contract-two"));
  assert.deepEqual(
    invocations[3].args.slice(invocations[3].args.indexOf("--sandbox"), invocations[3].args.indexOf("--sandbox") + 2),
    ["--sandbox", "read-only"],
  );
  assert.equal(invocations[3].args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.equal(invocations[4].args.includes("--dangerously-bypass-approvals-and-sandbox"), true);
  assert.ok(
    invocations[5].args.includes("model_reasoning_effort=max"),
    "runner must preserve max when the exact host model profile supports it",
  );
  assert.ok(
    invocations[6].args.includes("model_reasoning_effort=xhigh"),
    "runner must clamp max when the exact host model profile stops at xhigh",
  );
  assert.equal(maxEffortRun.appliedEffort, "max");
  assert.equal(clampedEffortRun.appliedEffort, "xhigh");
  assert.equal(
    invocations[7].args.some((arg) => arg.startsWith("model_reasoning_effort=")),
    false,
    "runner must omit effort instead of escalating above the requested/host-bounded level",
  );
  assert.equal(noEscalationRun.appliedEffort, null);
  const routing = require("../dist/electron/runtime/workload-routing.js");
  const provisional = {
    allocation: routing.normalizeWorkloadAllocation({
      runtimeId: "runtime-1",
      modelId: "gpt-contract-xhigh",
      tier: "balanced",
      effort: "max",
      phase: "delegate",
      requirements: { inputTokens: 0, expectedOutputTokens: 0, toolRequired: false, multimodalRequired: false },
      reasonCodes: ["runtime-contract"],
      rationale: "must not persist",
    }, "delegate"),
    runtime: {
      kind: "codex",
      backend: "openai",
      source: fakeCodex,
      version: "9.9.9",
      active: true,
      model: "gpt-contract-xhigh",
      effort: "max",
    },
    resolvedRuntimeId: "runtime-1",
    resolvedTier: null,
    source: "ai-assigned",
    resolutionCodes: ["parent-selected-live-runtime-model"],
  };
  const executed = routing.reconcileWorkloadRunnerResult(provisional, clampedEffortRun);
  const executedReceipt = routing.workloadAllocationReceipt(executed);
  assert.equal(executedReceipt.requested.effort, "max");
  assert.equal(executedReceipt.resolved.effort, "xhigh", "receipt must record the actual spawned CLI effort");
  assert.ok(executedReceipt.reasonCodes.includes("runner-effort-revalidated"));

  console.log(JSON.stringify({
    ok: true,
    checks: 49,
    modelPreservedOnResume: true,
    modelChangeInvalidatesSession: true,
    attachmentReachedHostAsFile: true,
    borrowedTurnContextPreserved: true,
  }, null, 2));

  store.getDb().close();
  fs.rmSync(temp, { recursive: true, force: true });
}

app.whenReady().then(() => main().then(() => app.quit())).catch((error) => {
  console.error(error);
  app.exit(1);
});
