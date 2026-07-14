#!/usr/bin/env node
// Structural security regression for the browser-originated Agent App path.
// It intentionally performs no model, provider, network, secret, or browser call.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const client = read("electron/mcp/client.ts");
const firm = read("electron/mcp/firm-orchestrator.ts");
const taskForce = read("electron/mcp/borrowed-task-force.ts");
const service = read("electron/invocation/service.ts");
const envResolver = read("electron/runtime/env-resolver.ts");
const codex = read("electron/runtime/codex.ts");
const claude = read("electron/runtime/claude-code.ts");
const grok = read("electron/runtime/grok.ts");
const gemini = read("electron/runtime/gemini.ts");
const cursor = read("electron/runtime/cursor.ts");
const runner = read("electron/runtime/runner.ts");
const untrustedError = read("electron/runtime/untrusted-error.ts");
const groups = read("electron/store/agent-groups.ts");
const ipc = read("electron/ipc.ts");
const capabilities = read("electron/site/agent-app-capabilities.ts");
const siteRuntime = read("electron/site/agent-app-runtime.ts");
const selection = read("electron/runtime/selection.ts");

const matches = (source, pattern, label) =>
  assert.match(source, pattern, `${label} boundary is missing`);

const between = (source, start, end, label) => {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `${label}: missing start marker ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `${label}: missing end marker ${end}`);
  return source.slice(startAt, endAt);
};

const assertBefore = (source, first, second, label) => {
  const firstAt = source.indexOf(first);
  const secondAt = source.indexOf(second);
  assert.notEqual(firstAt, -1, `${label}: missing ${first}`);
  assert.notEqual(secondAt, -1, `${label}: missing ${second}`);
  assert.ok(firstAt < secondAt, `${label}: ${first} must execute before ${second}`);
};

const runnerBody = (source, exportName) => {
  const start = source.indexOf(`export const ${exportName}`);
  assert.notEqual(start, -1, `${exportName} export is missing`);
  return source.slice(start);
};

// Single-agent dispatcher: no router, auto-selected MCP, chat reuse, durable
// learning, or continuation loop; each call gets a fresh isolated identity.
matches(client, /runtimeCanUseMcp\s*&&\s*!req\.agentAppMode/, "Agent App MCP disable");
matches(client, /const agentAppToolGrant = req\.agentAppMode \? req\.agentAppRuntimeToolGrant : undefined/, "Agent App main grant selection");
matches(client, /\^mcp__brave-search__\(\?:brave_web_search\|brave_local_search\)\$/, "Agent App exact MCP tool validation");
matches(client, /agentAppToolGrant && !agentAppCapabilityRuntimeEligible[\s\S]{0,420}agentAppToolGrant\.runtimeStatus = "runtime-unavailable"/, "Agent App incompatible-runtime downgrade");
assertBefore(client, 'agentAppToolGrant.runtimeStatus = "runtime-unavailable"', "mcpConfigPath = agentAppToolGrant.mcpConfigPath", "Agent App grant runtime gate order");
matches(client, /selectAgentAppRuntimeForTargets\(runtimes, runtimeTargets\)/, "Agent App stateless-safe runtime selection");
matches(client, /let routerAgent = req\.agentAppMode \? undefined/, "Agent App router disable");
matches(client, /const history = req\.agentAppMode \? \[\] : listChatMessages/, "Agent App empty history");
matches(client, /chatId: req\.agentAppMode \? `site-agent-app:\$\{req\.runId \?\? randomUUID\(\)\}`/, "Agent App fresh runner session");
matches(client, /const maxPasses = req\.agentAppMode\s*\? 1/, "Agent App one-pass limit");
matches(client, /buildAgentAppRunnerEnv\(process\.env, mcpRuntimeEnv\)/, "Agent App minimal environment plus opaque aliases");
matches(client, /untrustedNoTools: req\.agentAppMode === true/, "Agent App zero-builtins runner contract");
matches(client, /if \(!req\.agentAppMode\) appendChatMessage\(chat\.id, "assistant"/, "Agent App final persistence block");
matches(client, /displayText = parseMemoryEvents\(displayText\)\.cleanedText/, "Agent App memory-control stripping");
matches(client, /localOnly: req\.agentAppMode \|\| req\.hubMode === "local-only"/, "Agent App local-only group resolution");
matches(client, /const continuousMode = !req\.agentAppMode/, "Agent App continuous-mode disable");
matches(client, /const stormbreakerContinueRequested = !req\.agentAppMode &&/, "Agent App continuation disable");
matches(client, /if \(!req\.agentAppMode && stormbreakerContinueRequested/, "Agent App durable continuation block");

// Firm and saved-group branches return before the single-agent block, so they
// must independently enforce the same boundaries.
matches(firm, /if \(!p\.req\.agentAppMode && workingFolder\)/, "Firm folder activation block");
matches(firm, /history: p\.req\.agentAppMode \? \[\] : turn\.history/, "Firm empty node history");
matches(firm, /site-agent-app:\$\{p\.req\.runId \?\? "run"\}:[\s\S]*randomUUID\(\)/, "Firm fresh node session");
matches(firm, /untrustedNoTools: p\.req\.agentAppMode === true/, "Firm zero-builtins runner contract");
matches(firm, /if \(!p\.req\.agentAppMode\) appendChatMessage\(divChatId, "assistant"/, "Firm division persistence block");
matches(firm, /p\.req\.agentAppMode \? cleanAgentAppControlBlocks/, "Firm control-block stripping");
matches(firm, /images: p\.req\.agentAppMode \? undefined/, "Firm image disable");
matches(firm, /permission: p\.req\.agentAppMode \? "read"/, "Firm read-only permission pin");
matches(firm, /cwd: p\.req\.agentAppMode \? undefined/, "Firm cwd disable");
matches(firm, /mcpConfigPath: p\.req\.agentAppMode \? \(agentAppAllowedTools \? p\.mcpConfigPath : undefined\)/, "Firm exact MCP config gate");
matches(firm, /mcpAllowedTools: p\.req\.agentAppMode \? agentAppAllowedTools/, "Firm exact MCP tool gate");
matches(firm, /mcpCodexConfigArgs: p\.req\.agentAppMode \? undefined/, "Firm Codex MCP disable");
matches(firm, /buildAgentAppRunnerEnv\(p\.runnerEnv \?\? process\.env, p\.agentAppMcpRuntimeEnv\)/, "Firm minimal environment plus opaque aliases");
matches(firm, /untrustedAllowedMcpTools: agentAppAllowedTools/, "Firm exact untrusted MCP grant");

matches(taskForce, /function taskForceSessionId[\s\S]*randomUUID\(\)/, "Group fresh runner sessions");
matches(taskForce, /const history = p\.req\.agentAppMode \? \[\] : listChatMessages/, "Group empty history");
matches(taskForce, /return p\.req\.agentAppMode \|\| p\.req\.appsGenerateMode \? "read"/, "Group read-only permission pin");
matches(taskForce, /const toolsAllowed = !p\.req\.agentAppMode &&/, "Group tools disable");
matches(taskForce, /buildAgentAppRunnerEnv\(p\.runnerEnv \?\? process\.env, p\.agentAppMcpRuntimeEnv\)/, "Group minimal environment plus opaque aliases");
matches(taskForce, /untrustedAllowedMcpTools: agentAppAllowedTools/, "Group exact untrusted MCP grant");
matches(taskForce, /untrustedNoTools: p\.req\.agentAppMode === true/, "Group zero-builtins runner contract");
matches(taskForce, /if \(!p\.req\.agentAppMode\) appendChatMessage\(p\.chat\.id, "assistant"/, "Group final persistence block");
matches(taskForce, /p\.req\.agentAppMode\s*\? cleanAgentAppControlBlocks/, "Group control-block stripping");
matches(taskForce, /if \(!p\.req\.agentAppMode && continuation\.shouldContinue\)/, "Group continuation disable");
assert.ok((taskForce.match(/images: p\.req\.agentAppMode \? undefined/g) || []).length >= 3, "Every group phase must disable images");
assert.ok((taskForce.match(/cwd: p\.req\.agentAppMode \? undefined/g) || []).length >= 3, "Every group phase must disable cwd");
matches(taskForce, /Agent App groups require pre-resolved installed-agent specifications/, "Group pre-resolved roster requirement");
matches(taskForce, /spec\.source !== "installed" && spec\.source !== "firm-node"/, "Group Hub roster rejection");
matches(taskForce, /!spec\.installedAgentId/, "Group installed identity requirement");

// Firm and group models are still untrusted output producers. Strip every
// executable/control envelope before projecting their text to the Site app.
for (const [label, source, endMarker] of [
  ["Firm", firm, "/** 동시성 캡"],
  ["Group", taskForce, "function redactEventValue"],
]) {
  const sanitizer = between(source, "function cleanAgentAppControlBlocks", endMarker, `${label} Agent App output sanitizer`);
  matches(sanitizer, /stripStormbreakerContinueMarker\(text\)\.text/, `${label} continuation-marker stripping`);
  matches(sanitizer, /split\(SURFACE_INTENT_MARKER\)\.join\(""\)/, `${label} surface-intent stripping`);
  matches(sanitizer, /parseSurfaces\(withoutIntent\)\.cleanedText/, `${label} surface-manifest stripping`);
  matches(sanitizer, /parseAutomations\(withoutSurface\)\.cleanedText/, `${label} automation stripping`);
  matches(sanitizer, /parseMemoryEvents\(withoutAutomation\)\.cleanedText\.trim\(\)/, `${label} memory stripping`);
}

// Local Agent Apps must reject a saved Hub member before marketplace lookup,
// and the store resolver must not search Hub while local-only is active.
const groupBuilder = between(
  client,
  "async function buildAgentGroupTaskForceSpecs",
  "function selectAppBuilderForExistingAppEdit",
  "Agent App group builder",
);
matches(groupBuilder, /input\.localOnly && savedGroup\?\.members\.some\(\(member\) => member\.source === "hub"\)/, "Agent App Hub-member rejection");
matches(groupBuilder, /resolveAgentGroupForRuntime\(input\.groupId, \{ allowHub: !input\.localOnly \}\)/, "Agent App local-only group store call");
assertBefore(groupBuilder, "if (input.localOnly", "resolveAgentGroupForRuntime", "Agent App Hub rejection order");
matches(groups, /if \(options\.allowHub !== false && group\.members\.some\(\(member\) => member\.source === "hub"\)\)/, "Group marketplace lookup guard");

// Cancellation and thrown-run recovery must not persist partial browser output.
assert.equal(
  (service.match(/!runReq\.agentAppMode &&/g) || []).length >= 2,
  true,
  "Agent App partial persistence must be blocked on every terminal error path",
);
matches(service, /!runReq\.agentAppMode &&[\s\S]{0,180}event\.kind === "error"[\s\S]{0,180}record\.partialText\.trim\(\)/, "Agent App terminal partial persistence guard");
matches(service, /!runReq\.agentAppMode && controller\.signal\.aborted && record\.partialText\.trim\(\)/, "Agent App thrown-run partial persistence guard");
matches(service, /runReq\.agentAppMode && boundedEvent\.kind === "error"[\s\S]{0,180}untrustedRuntimeFailurePayload\(\)/, "Agent App event error sanitization");
matches(service, /const safeFailure = runReq\.agentAppMode[\s\S]{0,120}untrustedRuntimeFailurePayload\(\)/, "Agent App thrown error sanitization");
matches(client, /if \(req\.agentAppMode\) return untrustedRuntimeFailurePayload\(\)/, "Single Agent App runner failure sanitization");
matches(firm, /if \(p\.req\.agentAppMode\)[\s\S]{0,180}UNTRUSTED_RUNTIME_FAILURE_MESSAGE/, "Firm runner failure sanitization");
matches(taskForce, /if \(p\.req\.agentAppMode\)[\s\S]{0,260}text: UNTRUSTED_RUNTIME_FAILURE_MESSAGE/, "Group worker failure sanitization");
matches(taskForce, /throw createUntrustedRuntimeFailure\(\)/, "Group planner and synthesis failure sanitization");
matches(siteRuntime, /fail\(response, 502, UNTRUSTED_RUNTIME_FAILURE_CODE, UNTRUSTED_RUNTIME_FAILURE_MESSAGE\)/, "Site browser failure sanitization");
matches(untrustedError, /agent-app-runtime-failed/, "Fixed Agent App runtime failure code");
matches(untrustedError, /Agent App runtime failed\./, "Fixed Agent App runtime failure message");

// The minimal environment contains only CLI/login coordinates. It must never
// grow provider keys, Agentlas credential files, dotenv values, or preload hooks.
matches(envResolver, /AGENT_APP_RUNNER_ENV_ALLOWLIST/, "Agent App environment allowlist");
const allowlist = between(
  envResolver,
  "const AGENT_APP_RUNNER_ENV_ALLOWLIST",
  "export function buildAgentAppRunnerEnv",
  "Agent App environment allowlist",
);
for (const forbidden of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "AGENTLAS_STORE_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
]) {
  assert.equal(allowlist.includes(`"${forbidden}"`), false, `${forbidden} must not enter the Agent App allowlist`);
}
matches(envResolver, /const env: NodeJS\.ProcessEnv = \{\};/, "Agent App empty environment base");
matches(envResolver, /env\.AGENTLAS_UNTRUSTED_NO_TOOLS = "1"/, "Agent App untrusted environment sentinel");
assert.doesNotMatch(
  between(envResolver, "export function buildAgentAppRunnerEnv", "export async function buildRunnerEnv", "Agent App environment builder"),
  /\.\.\.process\.env|readDotEnv|readEnvVar|credentials\.env|vault/i,
  "Agent App environment builder must not inherit arbitrary env, dotenv, or vault values",
);

// Renderer IPC cannot mint Site authority. Only the main-owned loopback
// runtime can pass the ephemeral grant into invocationService.
matches(ipc, /agentAppMode: _agentAppMode/, "Renderer Agent App mode stripping");
matches(ipc, /agentAppRuntimeToolGrant: _agentAppRuntimeToolGrant/, "Renderer capability grant stripping");
matches(ipc, /invocationService\.start\(rendererInvocationRequest\(req\)\)/, "Renderer run sanitization");

// A DB catalog row is insufficient: Agent Apps reject package-manager download
// commands before verification and expose only exact, currently verified tools.
matches(capabilities, /function hasPinnedLocalExecutable/, "Pinned local MCP executable gate");
matches(capabilities, /executableName === "npx"/, "npx rejection");
matches(capabilities, /testServerConnection\(server, \{ timeoutMs: 12_000 \}\)/, "JIT MCP status verification");
matches(capabilities, /new Set\(\["brave_web_search", "brave_local_search"\]\)/, "Brave tool name allowlist");
matches(capabilities, /mcp__\$\{server\.configKey\}__\$\{tool\}/, "Exact MCP tool grant construction");
matches(capabilities, /deps\.runtimeEligible === false/, "Capability runtime preflight gate");
matches(capabilities, /reason: "runtime-unavailable"/, "Capability runtime-unavailable disclosure");
matches(siteRuntime, /agentAppCapabilityRuntimeEligible\(chatId\)/, "Site runtime capability eligibility check");
matches(siteRuntime, /capabilities: prepared\.finalDisclosure\(\)/, "Site runtime final capability reconciliation");
matches(selection, /function agentAppStatelessSafe[\s\S]{0,220}claude-code[\s\S]{0,220}byok[\s\S]{0,220}ollama/, "Agent App safe runtime set");
matches(selection, /capabilityRuntimeEligible: false,[\s\S]{0,120}fallbackFromKind: preferred\.active\.kind/, "Unsafe CLI no-tool fallback contract");

// Codex, Grok, Gemini, and Cursor cannot prove a zero-tool/stateless CLI
// boundary. They must reject before CLI discovery, auth/key lookup, prompt-file
// staging, or process spawn. A prompt-only denial is not sufficient.
const failClosedRunners = [
  { label: "Codex", source: codex, exportName: "runCodex", firstSideEffect: "const bin = await getBin()" },
  { label: "Grok", source: grok, exportName: "runGrok", firstSideEffect: "const bin = await getBin()" },
  { label: "Gemini", source: gemini, exportName: "runGemini", firstSideEffect: "const bin = await getBin()" },
  { label: "Cursor", source: cursor, exportName: "runCursor", firstSideEffect: "const bin = await resolveCursorBinary()" },
];
for (const runtime of failClosedRunners) {
  const body = runnerBody(runtime.source, runtime.exportName);
  matches(body, /if \(req\.untrustedNoTools\) \{[\s\S]{0,500}?throw new Error\(/, `${runtime.label} fail-closed guard`);
  assertBefore(body, "if (req.untrustedNoTools)", runtime.firstSideEffect, `${runtime.label} fail-closed order`);
  assertBefore(body, "throw new Error(", runtime.firstSideEffect, `${runtime.label} fail-closed throw order`);
}
assertBefore(runnerBody(grok, "runGrok"), "if (req.untrustedNoTools)", "readEnvVar(", "Grok key lookup isolation");
assertBefore(runnerBody(grok, "runGrok"), "if (req.untrustedNoTools)", "fs.writeFile(", "Grok prompt-file isolation");
assertBefore(runnerBody(gemini, "runGemini"), "if (req.untrustedNoTools)", "stageCliImageAttachments(", "Gemini attachment isolation");
assertBefore(runnerBody(cursor, "runCursor"), "if (req.untrustedNoTools)", "spawnCli(", "Cursor process isolation");

// Claude Code is the one CLI with a verified zero-builtins + exact-MCP contract.
for (const flag of ["--safe-mode", "--disable-slash-commands", "--no-chrome", "--no-session-persistence", "--strict-mcp-config"]) {
  assert.ok(claude.includes(`"${flag}"`), `Claude must enforce ${flag}`);
}
matches(claude, /"--tools",\s*""/, "Claude empty tool set");
matches(claude, /wrapSystemPrompt\([\s\S]{0,320}?runReq\.untrustedNoTools,\s*runReq\.untrustedAllowedMcpTools,\s*\)/, "Claude isolated capability prompt wrapper");
matches(claude, /const fingerprint = !runReq\.untrustedNoTools &&/, "Claude fingerprint persistence block");
matches(claude, /const savedSession = !runReq\.untrustedNoTools &&/, "Claude saved-session read block");
matches(claude, /const resumeSessionId = runReq\.untrustedNoTools \? null/, "Claude resume disable");
matches(
  claude,
  /const systemPromptFileFlag = runReq\.untrustedNoTools\s*\? "--system-prompt-file"\s*:\s*"--append-system-prompt-file"/,
  "Claude untrusted dynamic prompt replacement",
);
assert.doesNotMatch(claude, /exclude-dynamic/i, "Claude must not move dynamic host context into the user message");
matches(claude, /const hasExactUntrustedMcpGrant = Boolean\(/, "Claude exact untrusted MCP gate");
matches(claude, /\^mcp__\[a-z0-9_-\]\+__\(\?:brave_web_search\|brave_local_search\)\$/, "Claude exact Brave tool validation");
matches(claude, /req\.mcpConfigPath && \(!runReq\.untrustedNoTools \|\| hasExactUntrustedMcpGrant\)/, "Claude MCP config fail-closed gate");

const untrustedWrapper = between(
  runner,
  "if (untrustedNoTools)",
  "// Every runtime calls this function internally.",
  "Agent App system wrapper",
);
for (const denied of ["file", "shell", "web", "browser", "app", "MCP", "memory", "automation", "delegation", "persistence"]) {
  assert.match(untrustedWrapper, new RegExp(`\\b${denied}\\b`, "i"), `Agent App wrapper must deny ${denied}`);
}
assert.doesNotMatch(untrustedWrapper, /GLOBAL_CONNECTION_SKILL|SURFACE_PROTOCOL|ASK_PROTOCOL/, "Agent App wrapper must not load host capability protocols");

console.log("site agent app exact-capability isolation contract ok");
