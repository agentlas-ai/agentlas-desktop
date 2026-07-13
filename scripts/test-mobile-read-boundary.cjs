#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-mobile-read-boundary-"));
const userData = path.join(temp, "user-data");
const projectPath = path.join(temp, "project");
const inferredProjectPath = path.join("/private/tmp", `agentlas-read-inferred-${process.pid}-${Date.now()}`);
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(projectPath, { recursive: true });
process.env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
process.env.AGENTLAS_RUNTIME_DETECT_CACHE_MS = "0";
app.setPath("userData", userData);
let testDb = null;
let exitCode = 0;

function automationReply(visibleText, entries) {
  return [
    visibleText,
    "",
    "## Automation",
    "```json",
    JSON.stringify(entries),
    "```",
  ].join("\n");
}

async function main() {
  await app.whenReady();

  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  testDb = db;
  db.prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    "mobile-read-boundary-agent",
    "mobile-read-boundary-agent",
    "Mobile Read Boundary Agent",
    "Mobile Read Boundary Agent",
    "Permission boundary fixture",
    "Permission boundary fixture",
    "Answer only from the supplied request and respect the host permission.",
    "2026-07-14T00:00:00.000Z",
  );

  const active = {
    kind: "codex",
    backend: "openai",
    source: "mobile-read-boundary-test",
    ready: true,
    active: true,
    model: "mock-mobile-read-boundary",
  };
  const runnerRequests = [];
  const runnerReplies = [];
  const mockRunner = async (request) => {
    runnerRequests.push(request);
    return { text: runnerReplies.shift() ?? "No mutation requested.", tokens: 1 };
  };
  const picked = { runner: mockRunner, label: "Mobile Read Boundary Capture Runner" };

  const detect = require("../dist/electron/runtime/detect.js");
  const selection = require("../dist/electron/runtime/selection.js");
  const envResolver = require("../dist/electron/runtime/env-resolver.js");
  const stormbreaker = require("../dist/electron/hephaestus/stormbreaker-supervisor.js");
  detect.detectRuntimes = async () => [active];
  selection.selectRuntimeForTargets = () => ({
    active,
    picked,
    override: null,
    unavailableOverride: null,
  });
  envResolver.buildRunnerEnv = async () => ({ env: { BASE_ENV: "present" }, injectedKeys: [] });
  stormbreaker.superviseStormbreaker = () => null;

  let mcpSelectionCalls = 0;
  let mcpConfigCalls = 0;
  const autoSelect = require("../dist/electron/mcp-tools/auto-select.js");
  autoSelect.autoSelectMcpTools = async () => {
    mcpSelectionCalls += 1;
    return {
      tools: [{
        id: "fixture-mcp",
        installed: true,
        state: "ready",
        reason: "boundary fixture",
        required: false,
      }],
      hubPlugins: [],
      hubPluginCount: 0,
      localPluginCount: 1,
      hubPluginError: null,
    };
  };
  autoSelect.buildMcpAutoSelectionPrompt = () => "MCP_AUTO_SELECTION_PROMPT_CANARY";
  const mcpConfig = require("../dist/electron/mcp-tools/mcp-config.js");
  mcpConfig.buildMcpConfigFile = async () => {
    mcpConfigCalls += 1;
    return {
      configPath: path.join(temp, "fixture-mcp.json"),
      allowedTools: ["mcp__fixture"],
      codexConfigArgs: ["-c", "mcp.fixture=true"],
      runtimeEnv: { MCP_RUNTIME_ENV_CANARY: "must-only-reach-write" },
      includedServerIds: ["fixture-mcp"],
      includedServers: [],
    };
  };

  let activationCalls = 0;
  const activation = require("../dist/electron/architecture/activation.js");
  const recordFolderVisit = activation.recordFolderVisit;
  activation.recordFolderVisit = (...args) => {
    activationCalls += 1;
    return recordFolderVisit(...args);
  };

  const chats = require("../dist/electron/store/chats.js");
  const automations = require("../dist/electron/store/automations.js");
  const existing = automations.createAutomation({
    name: "Existing boundary job",
    scheduleHuman: "daily-09:00",
    targetType: "agent",
    targetId: "mobile-read-boundary-agent",
    promptTemplate: "ORIGINAL_PROMPT",
    createdBy: "user",
  });
  const chat = chats.createChat({
    agentId: "mobile-read-boundary-agent",
    title: "Mobile read boundary",
  });
  chats.setChatWorkingFolder(chat.id, projectPath);

  const client = require("../dist/electron/mcp/client.js");
  async function invoke(permission, reply, prompt = "Inspect the current state") {
    runnerReplies.push(...(Array.isArray(reply) ? reply : [reply]));
    const events = [];
    const request = { chatId: chat.id, userPrompt: prompt, locale: "en" };
    if (permission !== undefined) request.permissions = permission;
    const response = await client.runMcpInvocation(request, (event) => events.push(event));
    assert.equal(events.some((event) => event.kind === "error"), false);
    return { response, events, runnerRequest: runnerRequests.at(-1) };
  }

  const unboundChat = chats.createChat({
    agentId: "mobile-read-boundary-agent",
    title: "Read must not infer a writable folder",
  });
  runnerReplies.push("Read-only unbound result.");
  await client.runMcpInvocation(
    {
      chatId: unboundChat.id,
      userPrompt: `Inspect project folder: ${inferredProjectPath}`,
      locale: "en",
    },
    () => {},
  );
  assert.equal(fs.existsSync(inferredProjectPath), false, "read must not create a folder inferred from prompt text");
  assert.equal(chats.getChatWorkingFolder(unboundChat.id), null, "read must not persist an inferred working folder");

  const omitted = await invoke(
    undefined,
    automationReply("I prepared the job.", [{
      name: "Omitted permission job",
      schedule: "daily-10:00",
      prompt: "MUST_NOT_BE_CREATED",
    }]),
  );
  assert.equal(omitted.runnerRequest.permission, "read", "omitted permission must normalize to read");
  assert.equal(automations.listAutomations().some((item) => item.name === "Omitted permission job"), false);
  assert.doesNotMatch(omitted.response.finalText ?? "", /## Automation/);
  assert.match(omitted.response.finalText ?? "", /Automation was not saved/);
  assert.equal(
    omitted.events.some((event) => event.kind === "tool-use" && event.tool?.name === "automation.permission-required"),
    true,
  );

  const explicitRead = await invoke(
    "read",
    automationReply("I changed both jobs.", [
      { name: "Read permission job", schedule: "daily-11:00", prompt: "MUST_NOT_BE_CREATED" },
      { name: "Existing boundary job", schedule: "daily-12:00", prompt: "MUST_NOT_UPDATE" },
    ]),
  );
  assert.equal(automations.listAutomations().some((item) => item.name === "Read permission job"), false);
  const unchanged = automations.getAutomation(existing.id);
  assert.equal(unchanged.promptTemplate, "ORIGINAL_PROMPT");
  assert.equal(unchanged.scheduleHuman, "daily-09:00");
  assert.doesNotMatch(explicitRead.response.finalText ?? "", /## Automation/);
  assert.match(explicitRead.response.finalText ?? "", /Automation was not saved/);

  await invoke("read", "Read-only follow-up one.");
  await invoke("read", "Read-only follow-up two.");
  const automationCountBeforeContinuation = automations.listAutomations().length;
  await invoke("read", [
    "Read continuation pass one.\n<<stormbreaker-continue>>",
    "Read continuation pass two.\n<<stormbreaker-continue>>",
    "Read continuation pass three.\n<<stormbreaker-continue>>",
  ]);
  assert.equal(
    automations.listAutomations().length,
    automationCountBeforeContinuation,
    "read must not create a hidden Stormbreaker continuation automation",
  );
  assert.equal(activationCalls, 0, "repeated read invocations must not record folder visits");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM folder_activity WHERE path = ?").get(projectPath).count,
    0,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), false);
  assert.equal(mcpSelectionCalls, 0, "read invocations must not select MCPs");
  assert.equal(mcpConfigCalls, 0, "read invocations must not build MCP config");
  for (const request of runnerRequests) {
    assert.equal(request.permission, "read");
    assert.equal(request.mcpConfigPath, undefined);
    assert.equal(request.mcpAllowedTools, undefined);
    assert.equal(request.mcpCodexConfigArgs, undefined);
    assert.equal(request.env.MCP_RUNTIME_ENV_CANARY, undefined);
    assert.doesNotMatch(request.systemPrompt, /MCP_AUTO_SELECTION_PROMPT_CANARY/);
    assert.doesNotMatch(request.systemPrompt, /## Setting up automations/);
  }

  const write = await invoke(
    "write",
    automationReply("I saved both jobs.", [
      { name: "Write permission job", schedule: "daily-13:00", prompt: "WRITE_CREATED" },
      { name: "Existing boundary job", schedule: "daily-14:00", prompt: "WRITE_UPDATED" },
    ]),
    "Create and update the scheduled jobs",
  );
  assert.equal(write.runnerRequest.permission, "write");
  assert.match(write.runnerRequest.systemPrompt, /## Setting up automations/);
  assert.match(write.runnerRequest.systemPrompt, /MCP_AUTO_SELECTION_PROMPT_CANARY/);
  assert.equal(write.runnerRequest.mcpConfigPath, path.join(temp, "fixture-mcp.json"));
  assert.deepEqual(write.runnerRequest.mcpAllowedTools, ["mcp__fixture"]);
  assert.equal(write.runnerRequest.env.MCP_RUNTIME_ENV_CANARY, "must-only-reach-write");
  assert.equal(mcpSelectionCalls, 1);
  assert.equal(mcpConfigCalls, 1);
  assert.equal(automations.listAutomations().some((item) => item.name === "Write permission job"), true);
  const updated = automations.getAutomation(existing.id);
  assert.equal(updated.promptTemplate, "WRITE_UPDATED");
  assert.equal(updated.scheduleHuman, "daily-14:00");
  assert.equal(activationCalls, 1, "write invocation keeps the existing activation behavior");
  assert.equal(
    db.prepare("SELECT visits FROM folder_activity WHERE path = ?").get(projectPath).visits,
    1,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), false);

  await invoke("read", "Read-only after one write.");
  await invoke("read", "Read-only after one write again.");
  assert.equal(activationCalls, 1, "read retries must not turn one write visit into activation");
  assert.equal(
    db.prepare("SELECT visits FROM folder_activity WHERE path = ?").get(projectPath).visits,
    1,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), false);
  assert.equal(mcpSelectionCalls, 1, "read retries after a write must still skip MCP selection");
  assert.equal(mcpConfigCalls, 1, "read retries after a write must still skip MCP config");
  for (const request of runnerRequests.slice(-2)) {
    assert.equal(request.permission, "read");
    assert.equal(request.mcpConfigPath, undefined);
    assert.equal(request.mcpAllowedTools, undefined);
    assert.equal(request.env.MCP_RUNTIME_ENV_CANARY, undefined);
    assert.doesNotMatch(request.systemPrompt, /MCP_AUTO_SELECTION_PROMPT_CANARY/);
    assert.doesNotMatch(request.systemPrompt, /## Setting up automations/);
  }

  console.log("Mobile read permission boundary: PASS");
}

main()
  .catch((error) => {
    console.error("Mobile read permission boundary: FAIL", error);
    exitCode = 1;
  })
  .finally(() => {
    // Windows keeps SQLite files locked until the native handle closes. Cleanup
    // must never throw before Electron receives an explicit exit, otherwise a
    // passing release gate can wait until the whole job timeout.
    try {
      testDb?.close();
    } catch (error) {
      console.error("Mobile read permission boundary DB cleanup failed", error);
      exitCode = 1;
    }
    for (const target of [temp, inferredProjectPath]) {
      try {
        fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
      } catch (error) {
        console.error(`Mobile read permission boundary temp cleanup failed: ${target}`, error);
        exitCode = 1;
      }
    }
    app.exit(exitCode);
  });
