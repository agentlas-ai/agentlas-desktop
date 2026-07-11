#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const pathSource = fs.readFileSync(path.join(root, "shared/build-path.ts"), "utf8");
const compiled = ts.transpileModule(pathSource, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function("exports", "module", compiled)(mod.exports, mod);
const { packagePathFromText } = mod.exports;

assert.equal(packagePathFromText("/tmp/output", "BUILD_COMPLETE: my agent package"), "/tmp/output/my agent package");
assert.equal(packagePathFromText("/tmp/output", 'BUILD_COMPLETE: "my agent package" — done'), "/tmp/output/my agent package");
assert.equal(packagePathFromText("/tmp/output", "BUILD_COMPLETE: /tmp/output/nested package"), "/tmp/output/nested package");
assert.equal(packagePathFromText("/tmp/output", "BUILD_COMPLETE: /etc/private"), null);
assert.equal(packagePathFromText("/tmp/output", "BUILD_COMPLETE: ../escape"), null);
assert.equal(packagePathFromText("/tmp/output", "BUILD_COMPLETE: output"), null);
assert.equal(
  packagePathFromText(
    "/tmp/output",
    "Example only: BUILD_COMPLETE: stale-package\nBuild finished.\nBUILD_COMPLETE: actual-package",
  ),
  "/tmp/output/actual-package",
  "the final receipt line is the only package-path authority",
);
assert.equal(
  packagePathFromText("/tmp/output", "BUILD_COMPLETE: stale-package\nBuild finished without a final receipt"),
  null,
  "an earlier marker cannot select a delivery target when the final line is not a receipt",
);

const session = fs.readFileSync(path.join(root, "renderer/lib/build-session.ts"), "utf8");
assert.match(session, /let attachmentsSentForBuild = false;/);
assert.match(session, /attachments:\s*attachmentsSentForBuild\s*\? undefined/);
assert.match(session, /attachmentsSentForBuild = true;/);
assert.match(session, /workspaceGrant: state\.workspaceGrant/);
assert.match(session, /grant: a\.grant/);
assert.match(session, /export function prepareBuildHandoff/, "cross-surface Build input must use one guarded handoff boundary");
assert.match(session, /state\.phase === "running" \|\| state\.phase === "interview"/, "handoff must not overwrite an active background Build");
assert.match(session, /state\.attachments = \[\]/, "a new Site handoff must not inherit stale Build attachments");
assert.match(session, /announceAgentRosterChange\(\{ action: "upserted", agent: imported, source: "build" \}\)/, "a successful Build import must announce the durable roster change");
assert.match(session, /autoRegister\(workspace: string, readScope: FsReadScope, generation: number\)/, "registration must be bound to its Build generation");
assert.match(session, /isCurrentRegistration\(generation, workspace\)/, "a stale registration must not mutate the next Build card");
assert.match(session, /previousDisposition !== "passed"[\s\S]{0,240}autoRegister\(state\.result\.workspace/, "a successful re-scan must resume automatic registration");
assert.match(session, /split\(\/\[\\\\\/\]\//, "shared-folder detection must understand Windows path separators");
assert.equal(session.includes("canRewindInterview"), false, "one-batch UI must not expose unreachable rewind state");
const page = fs.readFileSync(path.join(root, "renderer/app/(shell)/build/page.tsx"), "utf8");
assert.equal(page.includes("rewindBuildInterview"), false);
const sitePage = fs.readFileSync(path.join(root, "renderer/app/(shell)/site/page.tsx"), "utf8");
assert.match(sitePage, /prepareBuildHandoff\(\{ workspace: workspaceGrant, request: res\.handoff\.buildPrompt \}\)/, "Site must not mutate the Build singleton piecemeal");

const rosterEvents = fs.readFileSync(path.join(root, "renderer/lib/agent-roster-events.ts"), "utf8");
assert.match(rosterEvents, /agentlas:agent-roster-changed/, "local roster changes need one renderer event contract");
assert.match(rosterEvents, /window\.dispatchEvent\(new CustomEvent/, "the durable import must wake already-mounted screens");
assert.match(rosterEvents, /sessionStorage\.setItem\(AGENT_ROSTER_REPLAY_KEY/, "a fast registration must survive navigation to its destination screen");
assert.match(rosterEvents, /queueMicrotask\(\(\) => deliver\(readReplay\(\)\)\)/, "newly mounted roster screens must replay the recent durable registration");
const orgTree = fs.readFileSync(path.join(root, "renderer/components/dashboard/OrgTree.tsx"), "utf8");
const agentLibrary = fs.readFileSync(path.join(root, "renderer/app/(shell)/library/agents/page.tsx"), "utf8");
const chatPage = fs.readFileSync(path.join(root, "renderer/app/(shell)/chat/page.tsx"), "utf8");
const rosterSource = fs.readFileSync(path.join(root, "renderer/lib/agent-roster.ts"), "utf8");
assert.match(orgTree, /onAgentRosterChange/, "the org chart must reconcile a Build registration without polling");
assert.match(agentLibrary, /onAgentRosterChange/, "My Agents must reconcile a Build registration without remounting");
assert.match(agentLibrary, /setRosterTab\(\(change\.agent\.kind/, "My Agents must reveal the single/team tab that owns the new asset");
assert.match(agentLibrary, /rosterRefreshGenerationRef/, "My Agents must reject a stale pre-import roster response");
assert.match(chatPage, /onAgentRosterChange/, "chat @ mentions must see a newly built local agent immediately");
assert.doesNotMatch(
  rosterSource.match(/export function isRosterVisibleAgent[\s\S]*?\n\}/)?.[0] ?? "",
  /isUserFacingAgentText/,
  "explicitly visible user assets must not disappear because of an internal-looking name",
);
const localImport = fs.readFileSync(path.join(root, "electron/agents/import-local.ts"), "utf8");
assert.doesNotMatch(localImport, /await\s+analyzeFolder\(/, "durable local registration must never wait on a second LLM run");
assert.match(localImport, /visibility = 'visible', entity_kind = \?/, "local re-import must persist the authoritative entity kind");
assert.match(localImport, /visibility, entity_kind\)/, "new local assets must persist the authoritative entity kind");
assert.match(localImport, /db\.transaction\(\(\) => \{[\s\S]+registerTeamAsFirm[\s\S]+saveResolvedOrg/, "team agent, firm, and org must share one SQLite transaction");
assert.match(localImport, /localImportInFlight/, "automatic and manual imports of the same folder must be single-flight");
assert.match(localImport, /replaceRoute\(existing, \[id\]\)/, "a failed re-import must restore its exact previous route snapshot");
assert.match(localImport, /DELETE FROM firms WHERE id = \?/, "team-to-single conversion must remove the stale organization projection");
assert.match(localImport, /clearResolvedOrg\(registeredFirm\.id\)/, "a team re-import without divisions must not keep a stale resolved-org cache");

console.log(JSON.stringify({ ok: true, checks: 39 }, null, 2));
