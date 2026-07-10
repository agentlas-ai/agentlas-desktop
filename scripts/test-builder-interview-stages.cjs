#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isCompletedBuildTurn } = require("../dist/electron/hephaestus/build-turn.js");

assert.equal(isCompletedBuildTurn('<<agentlas-ask>>\n{"question":"Who?"}\n<</agentlas-ask>>'), false);
assert.equal(isCompletedBuildTurn("I will build after your answer."), false);
assert.equal(isCompletedBuildTurn("Done\nBUILD_COMPLETE: my-agent"), true);
assert.equal(isCompletedBuildTurn("build_complete : package-name"), true);
assert.equal(isCompletedBuildTurn("I will eventually output BUILD_COMPLETE: package-name"), false);
assert.equal(isCompletedBuildTurn("BUILD_COMPLETE: package-name\nBut first I need an answer."), false);

const source = fs.readFileSync(path.join(__dirname, "../electron/hephaestus/builder.ts"), "utf8");
const guardAt = source.indexOf("if (!signal.aborted && isCompletedBuildTurn(result.text))");
const stageAt = source.indexOf('stage: "security"', guardAt);
assert.ok(guardAt >= 0 && stageAt > guardAt, "security stage must be inside the completed-turn guard");
assert.match(source, /verifiedCompletedPackageRoot\(req\.workspace, result\.text\)/);
assert.match(source, /securityScan\(completedPackageRoot/);
assert.match(source, /result: \{ workspace: completedPackageRoot, securityScan: scan \}/);
assert.match(source, /status: "unverified", reason: completedPackage\.error/);

const resultPathSource = fs.readFileSync(path.join(__dirname, "../electron/hephaestus/build-result-path.ts"), "utf8");
assert.match(resultPathSource, /resolveMainOwnedReadPath\(signalled, canonicalWorkspace\)/);

const sessionSource = fs.readFileSync(path.join(__dirname, "../renderer/lib/build-session.ts"), "utf8");
assert.doesNotMatch(sessionSource, /packagePathFromText/, "renderer must trust only the main-verified package root");
assert.match(sessionSource, /const packageRoot = r\?\.workspace \?\? workspace/);
assert.match(sessionSource, /const complete = isCompletedBuildTurn\(assistantText\)/);

console.log(JSON.stringify({ ok: true, checks: 15 }, null, 2));
