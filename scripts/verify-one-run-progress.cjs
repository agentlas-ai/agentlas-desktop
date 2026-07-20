#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("renderer/lib/one-run-progress.ts", "utf8");
assert.match(source, /ONE_RUN_STAGE_ORDER[\s\S]*understand[\s\S]*discover[\s\S]*verify[\s\S]*synthesize[\s\S]*prepare/);
assert.match(source, /event\.tool\?\.result/);
assert.match(source, /event\.agentName && event\.agentId/);
assert.match(source, /stageRank\(nextStage\) > stageRank\(state\.current\)/, "progress must never move backward");
assert.doesNotMatch(source, /setTimeout|Math\.random|percent|%/, "One progress must not be timer- or percentage-faked");
process.stdout.write(`${JSON.stringify({ ok: true, stages: 5, eventGrounded: true })}\n`);
