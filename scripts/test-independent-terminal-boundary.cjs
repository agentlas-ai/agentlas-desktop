#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
assert.equal(fs.existsSync(path.join(root, "cli")), false, "Desktop must not restore the removed cli/ mirror");

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
assert.match(readme, /https:\/\/github\.com\/agentlas-ai\/agentlas-terminal/, "README must link to the independent Terminal product");

const playbook = fs.readFileSync(path.join(root, "docs", "ARCHITECTURE_PLAYBOOK.md"), "utf8");
assert.match(playbook, /independent npm product and repository/i);
assert.doesNotMatch(playbook, /cli\/architecture\.data\.json|cli\/agentlas\.cjs|scripts\/gen-cli-architecture/);

const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
assert.doesNotMatch(packageJson, /gen-cli-architecture|cli\/architecture\.data\.json/);

console.log("Independent Agentlas Terminal boundary contract passed");
