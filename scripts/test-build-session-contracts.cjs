#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const root = path.resolve(__dirname, "..");
const pathSource = fs.readFileSync(path.join(root, "renderer/lib/build-path.ts"), "utf8");
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

const session = fs.readFileSync(path.join(root, "renderer/lib/build-session.ts"), "utf8");
assert.match(session, /let attachmentsSentForBuild = false;/);
assert.match(session, /attachments:\s*attachmentsSentForBuild\s*\? undefined/);
assert.match(session, /attachmentsSentForBuild = true;/);
assert.equal(session.includes("canRewindInterview"), false, "one-batch UI must not expose unreachable rewind state");
const page = fs.readFileSync(path.join(root, "renderer/app/(shell)/build/page.tsx"), "utf8");
assert.equal(page.includes("rewindBuildInterview"), false);

console.log(JSON.stringify({ ok: true, checks: 11 }, null, 2));
