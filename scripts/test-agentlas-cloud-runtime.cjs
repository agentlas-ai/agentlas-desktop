#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runtime = require("../cli/agentlas-cloud-runtime.cjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cloud-runtime-"));
const fakeSecret = "sk-" + "thisIsASecretLikeValueThatMustNotPrint123";

function makeAgent(name = "instagram-operator") {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, "skills", "social-media-strategist"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agentlas"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Instagram Operator\n\nBuild weekly Instagram posts.\n", "utf8");
  fs.writeFileSync(path.join(root, "skills", "social-media-strategist", "SKILL.md"), "---\nname: social-media-strategist\ndescription: Use for social content.\n---\n\nCreate social plans.\n", "utf8");
  fs.writeFileSync(path.join(root, ".agentlas", "memory-map.json"), "{\"project\":\"instagram-operator\"}\n", "utf8");
  return root;
}

try {
  const agent = makeAgent();
  const wizard = runtime.runWizard(agent, { name: "instagram-operator" });
  assert.equal(wizard.status, "Ready for MCP call");
  assert.equal(wizard.manifest.entry, "AGENTS.md");
  assert.ok(fs.existsSync(path.join(agent, "agentlas.json")));

  fs.writeFileSync(path.join(agent, "notes-token.md"), `token=${fakeSecret}\n`, "utf8");
  const bundle = runtime.compileBundle(agent);
  const allowed = runtime.readAgentFile(agent, "AGENTS.md");
  const denied = runtime.readAgentFile(agent, "notes-token.md");
  assert.equal(bundle.entry.path, "AGENTS.md");
  assert.equal(allowed.status, "allowed");
  assert.equal(denied.status, "denied");
  assert.ok(!JSON.stringify(bundle).includes(fakeSecret));

  const blocked = makeAgent("blocked-agent");
  fs.writeFileSync(path.join(blocked, ".env"), `OPENAI_API_KEY=${fakeSecret}\n`, "utf8");
  const report = runtime.scanFolder(blocked);
  assert.equal(report.verdict, "BLOCK");
  assert.ok(!JSON.stringify(report).includes(fakeSecret));

  const field = runtime.runFieldTest();
  assert.equal(field.status, "PASS");
  console.log("agentlas cloud runtime smoke passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
