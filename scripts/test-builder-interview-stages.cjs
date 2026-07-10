#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { isCompletedBuildTurn } = require("../dist/electron/hephaestus/build-turn.js");

assert.equal(isCompletedBuildTurn('<<agentlas-ask>>\n{"question":"Who?"}\n<</agentlas-ask>>'), false);
assert.equal(isCompletedBuildTurn("I will build after your answer."), false);
assert.equal(isCompletedBuildTurn("Done\nBUILD_COMPLETE: my-agent"), true);
assert.equal(isCompletedBuildTurn("build_complete : package-name"), true);

const source = fs.readFileSync(path.join(__dirname, "../electron/hephaestus/builder.ts"), "utf8");
const guardAt = source.indexOf("if (!signal.aborted && isCompletedBuildTurn(result.text))");
const stageAt = source.indexOf('stage: "security"', guardAt);
assert.ok(guardAt >= 0 && stageAt > guardAt, "security stage must be inside the completed-turn guard");

console.log(JSON.stringify({ ok: true, checks: 5 }, null, 2));
