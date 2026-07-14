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
  const projects = require("../dist/electron/store/projects.js");
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

  const projectContextSentinel = "SITE_STUDIO_PROJECT_CONTEXT_MUST_NOT_BE_INJECTED";
  const projectExperienceSentinel = "SITE_STUDIO_PROJECT_EXPERIENCE_MUST_NOT_BE_INJECTED";
  const attachedProject = projects.createProject({
    name: "Tampered Site hidden-chat project",
    contextNote: projectContextSentinel,
    folderPath: projectPath,
  });
  // Simulate an old or locally tampered Site hidden chat. Main must treat
  // source=site-studio as the authority boundary, not this mutable DB row.
  db.prepare("UPDATE chats SET project_id = ? WHERE id = ?").run(attachedProject.id, chat.id);

  const experienceContext = require("../dist/electron/experience/context.js");
  const originalBuildExperienceContext = experienceContext.buildExperienceContext;
  const experienceContextInputs = [];
  experienceContext.buildExperienceContext = (input) => {
    experienceContextInputs.push({ ...input });
    if (input.projectId || input.projectPath) {
      return {
        prompt: `## Experience\n- ${projectExperienceSentinel}`,
        selectedCandidateIds: ["project-scoped-sentinel"],
        approximateTokens: 12,
      };
    }
    return originalBuildExperienceContext(input);
  };

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

  const inactiveMemoryProject = path.join(temp, "inactive-memory-project");
  const inactiveMemoryDir = path.join(inactiveMemoryProject, ".agentlas");
  const inactiveMemoryFile = path.join(inactiveMemoryDir, "project-soul-memory.md");
  const inactiveSentinel = "INACTIVE_PROJECT_MEMORY_MUST_NOT_BE_INJECTED";
  fs.mkdirSync(inactiveMemoryDir, { recursive: true });
  fs.writeFileSync(inactiveMemoryFile, `# Inactive memory\n\n- ${inactiveSentinel}\n`, "utf8");
  const inactiveBefore = {
    content: fs.readFileSync(inactiveMemoryFile, "utf8"),
    mtimeMs: fs.statSync(inactiveMemoryFile).mtimeMs,
  };
  const inactiveChat = chats.createChat({
    agentId: "mobile-read-boundary-agent",
    title: "Inactive local memory must remain detached",
  });
  chats.setChatWorkingFolder(inactiveChat.id, inactiveMemoryProject);
  runnerReplies.push("Inactive project read result.");
  const inactiveEvents = [];
  await client.runMcpInvocation(
    { chatId: inactiveChat.id, userPrompt: "Inspect without activation", locale: "en", permissions: "read" },
    (event) => inactiveEvents.push(event),
  );
  assert.equal(inactiveEvents.some((event) => event.kind === "error"), false);
  assert.doesNotMatch(runnerRequests.at(-1).systemPrompt, new RegExp(inactiveSentinel));
  assert.equal(
    db.prepare("SELECT COUNT(*) AS count FROM folder_activity WHERE path = ?").get(inactiveMemoryProject).count,
    0,
    "a pre-existing .agentlas folder is not proof of activation",
  );
  assert.deepEqual({
    content: fs.readFileSync(inactiveMemoryFile, "utf8"),
    mtimeMs: fs.statSync(inactiveMemoryFile).mtimeMs,
  }, inactiveBefore);
  assert.equal(fs.existsSync(path.join(inactiveMemoryDir, "code-map")), false);

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
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), false, "read-only contact must not create local project state");
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
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), true, "first writable contact must seed local continuity");
  assert.match(
    fs.readFileSync(path.join(projectPath, ".gitignore"), "utf8"),
    /# >>> agentlas local project state >>>/,
    "release Core must install the canonical managed privacy block before seeding",
  );

  const activatedMemorySentinel = "ACTIVATED_READ_MEMORY_SENTINEL";
  fs.appendFileSync(
    path.join(projectPath, ".agentlas", "project-soul-memory.md"),
    `\n## Read boundary fixture\n- ${activatedMemorySentinel}\n`,
    "utf8",
  );
  const activatedMemoryFile = path.join(projectPath, ".agentlas", "project-soul-memory.md");
  const activatedBefore = {
    content: fs.readFileSync(activatedMemoryFile, "utf8"),
    mtimeMs: fs.statSync(activatedMemoryFile).mtimeMs,
    activity: db.prepare("SELECT visits, last_seen FROM folder_activity WHERE path = ?").get(projectPath),
  };

  await invoke("read", "Read-only after one write.");
  await invoke("read", "Read-only after one write again.");
  assert.equal(activationCalls, 1, "read retries must not turn one write visit into activation");
  assert.equal(
    db.prepare("SELECT visits FROM folder_activity WHERE path = ?").get(projectPath).visits,
    1,
  );
  assert.equal(fs.existsSync(path.join(projectPath, ".agentlas")), true, "read retries must not remove writable first-contact state");
  assert.equal(mcpSelectionCalls, 1, "read retries after a write must still skip MCP selection");
  assert.equal(mcpConfigCalls, 1, "read retries after a write must still skip MCP config");
  for (const request of runnerRequests.slice(-2)) {
    assert.equal(request.permission, "read");
    assert.equal(request.mcpConfigPath, undefined);
    assert.equal(request.mcpAllowedTools, undefined);
    assert.equal(request.env.MCP_RUNTIME_ENV_CANARY, undefined);
    assert.doesNotMatch(request.systemPrompt, /MCP_AUTO_SELECTION_PROMPT_CANARY/);
    assert.doesNotMatch(request.systemPrompt, /## Setting up automations/);
    assert.match(request.systemPrompt, new RegExp(activatedMemorySentinel),
      "an ordinary Desktop read must recall an already activated project's memory");
    assert.match(request.systemPrompt, new RegExp(projectContextSentinel),
      "an ordinary Desktop project chat must retain its explicit context note");
    assert.match(request.systemPrompt, new RegExp(projectExperienceSentinel),
      "an ordinary Desktop project chat must retain project-scoped Experience selection");
  }
  assert.deepEqual({
    content: fs.readFileSync(activatedMemoryFile, "utf8"),
    mtimeMs: fs.statSync(activatedMemoryFile).mtimeMs,
    activity: db.prepare("SELECT visits, last_seen FROM folder_activity WHERE path = ?").get(projectPath),
  }, activatedBefore, "activated read recall must not rewrite files or folder activity");

  runnerReplies.push("Site Studio isolated result.");
  const siteStudioEvents = [];
  await client.runMcpInvocation(
    { chatId: chat.id, userPrompt: "Render a Site preview", locale: "en", permissions: "read" },
    (event) => siteStudioEvents.push(event),
    undefined,
    undefined,
    { source: "site-studio" },
  );
  assert.equal(siteStudioEvents.some((event) => event.kind === "error"), false);
  const siteStudioRequest = runnerRequests.at(-1);
  assert.doesNotMatch(siteStudioRequest.systemPrompt, new RegExp(activatedMemorySentinel));
  assert.doesNotMatch(siteStudioRequest.systemPrompt, new RegExp(projectContextSentinel),
    "Site Studio must ignore a stale/tampered hidden-chat project context note");
  assert.doesNotMatch(siteStudioRequest.systemPrompt, new RegExp(projectExperienceSentinel),
    "Site Studio must ignore project-scoped Experience even when the hidden chat row is tampered");
  assert.deepEqual(
    {
      projectId: experienceContextInputs.at(-1)?.projectId ?? null,
      projectPath: experienceContextInputs.at(-1)?.projectPath ?? null,
    },
    { projectId: null, projectPath: null },
    "Site Studio must call Experience selection only with the explicit global scope",
  );
  assert.equal(siteStudioRequest.cwd, undefined,
    "Site Studio must ignore a stale hidden-chat working folder as well as its project memory");

  // The same chat/folder under an unattended restricted-read provenance must
  // not consume mutable project-local memory.
  active.kind = "byok";
  runnerReplies.push("Restricted read result.");
  const restrictedEvents = [];
  await client.runMcpInvocation(
    { chatId: chat.id, userPrompt: "Restricted inspection", locale: "en", permissions: "read" },
    (event) => restrictedEvents.push(event),
    undefined,
    undefined,
    { source: "automation" },
  );
  assert.equal(restrictedEvents.some((event) => event.kind === "error"), false);
  assert.doesNotMatch(runnerRequests.at(-1).systemPrompt, new RegExp(activatedMemorySentinel),
    "Mobile/automation restricted reads must not receive mutable local project memory");
  active.kind = "codex";

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
