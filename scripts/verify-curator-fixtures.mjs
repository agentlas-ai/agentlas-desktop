#!/usr/bin/env node
// Desktop curator conformance gate — runs the shared curator fixtures against
// this app's executor half. Requires a compiled dist (npm run build:electron):
// it loads dist/electron/memory/curator-rules.js, which is dependency-free by
// design so this gate runs under plain node (importing curator.js would pull
// better-sqlite3's Electron ABI and make the gate unrunnable here).
//
// A check that cannot run must fail, not skip.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const fixturesPath = path.join(root, ".internal", "curator-fixtures", "cases.json");
let cases;
try {
  cases = JSON.parse(readFileSync(fixturesPath, "utf8"));
} catch (error) {
  fail(`fixtures unreadable: ${fixturesPath} (${error.message})`);
}

let rules;
let secretPatterns;
try {
  rules = require(path.join(root, "dist", "electron", "memory", "curator-rules.js"));
  secretPatterns = require(path.join(root, "dist", "shared", "secret-patterns.js"));
} catch (error) {
  fail(`compiled executor missing — run \`npm run build:electron\` first (${error.message})`);
}

const { ruleset, sha } = rules.loadCuratorRuleset();
if (sha === "embedded") {
  fail("shipped curator-ruleset.json did not load — executor is on embedded fallback");
}

let passed = 0;

// secret shapes — the shared chokepoint must catch every fixture shape.
for (const c of cases.secretShapes ?? []) {
  const hit = secretPatterns.looksSecret(c.content);
  if (hit !== Boolean(c.expectSecret)) {
    fail(`secretShapes/${c.id}: looksSecret=${hit} want ${c.expectSecret}`);
  }
  passed += 1;
}

// team layer routing — values come from the ruleset.
for (const c of cases.teamLayer ?? []) {
  const got = rules.classifyTeamLearningRoute(c.kind);
  if (got !== c.expect) fail(`teamLayer/${c.id}: ${got} want ${c.expect}`);
  passed += 1;
}

// project-specifics guard — a mislabelled agent_repo event must be caught.
for (const c of cases.projectSpecifics ?? []) {
  const got = rules.mentionsProjectSpecifics(c.content, c.projectPath ?? null);
  if (got !== Boolean(c.expect)) fail(`projectSpecifics/${c.id}: ${got} want ${c.expect}`);
  passed += 1;
}

console.log(
  `PASS: ${passed} desktop curator fixture cases (ruleset ${ruleset.rulesetVersion} sha ${sha})`,
);
