#!/usr/bin/env node
"use strict";

const assert = require("node:assert");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-ontology-repl-"));
const projectRaw = path.join(root, "project");
const docsRaw = path.join(root, "company docs");
const userData = path.join(root, "user-data");
fs.mkdirSync(projectRaw, { recursive: true });
fs.mkdirSync(docsRaw, { recursive: true });
fs.mkdirSync(userData, { recursive: true });
const project = fs.realpathSync(projectRaw);
const docs = fs.realpathSync(docsRaw);
fs.writeFileSync(path.join(docs, "notes.md"), "Company Atlas belongs in a private ontology source.\n", "utf8");
fs.writeFileSync(
  path.join(userData, "cli-prefs.json"),
  JSON.stringify({ onboarded: true, lang: "en", runtime: "codex", permission: "write" }, null, 2),
  "utf8",
);

const dbPath = path.join(userData, "agentlas.sqlite");
const schema = `
CREATE TABLE installed_agents (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  name_en TEXT NOT NULL DEFAULT '',
  tagline TEXT NOT NULL DEFAULT '',
  tagline_en TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  mcp_servers_json TEXT NOT NULL DEFAULT '[]',
  env_requirements_json TEXT NOT NULL DEFAULT '[]',
  preferred_backend TEXT,
  trust_grade TEXT NOT NULL DEFAULT 'A',
  installed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  tone TEXT,
  builtin INTEGER NOT NULL DEFAULT 0,
  role TEXT,
  visibility TEXT NOT NULL DEFAULT 'visible'
);
CREATE TABLE active_runtime (
  id INTEGER PRIMARY KEY,
  kind TEXT,
  backend TEXT,
  source TEXT,
  model TEXT,
  long_context INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO installed_agents (
  id, slug, name, name_en, tagline, tagline_en, system_prompt,
  mcp_servers_json, env_requirements_json, trust_grade, installed_at, tone, builtin, role, visibility
) VALUES (
  'agent-test', 'test-agent', 'Test Agent', 'Test Agent', '', '', 'You are Test Agent.',
  '[]', '[]', 'A', CURRENT_TIMESTAMP, 'plain', 0, 'worker', 'visible'
);
`;
const python = spawnSync("python3", ["-c", `
import sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.executescript(sys.stdin.read())
db.close()
`, dbPath], { input: schema, encoding: "utf8" });
if (python.status !== 0) {
  throw new Error(`failed to create sqlite fixture:\\n${python.stderr || python.stdout}`);
}

const cliPath = path.join(__dirname, "..", "cli", "agentlas.cjs");
const child = spawn(process.execPath, [cliPath, "--runtime", "codex"], {
  cwd: project,
  env: { ...process.env, AGENTLAS_USER_DATA_DIR: userData, AGENTLAS_TERMINAL_LANG: "en", AGENTLAS_NO_COLOR: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});

let output = "";
let closed = false;
const waiters = [];

function settleWaiters() {
  for (let i = waiters.length - 1; i >= 0; i--) {
    const waiter = waiters[i];
    if (waiter.pattern.test(output)) {
      waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }
}

child.stdout.on("data", (chunk) => {
  output += String(chunk);
  settleWaiters();
});
child.stderr.on("data", (chunk) => {
  output += String(chunk);
  settleWaiters();
});
child.on("close", (code) => {
  closed = true;
  for (const waiter of waiters.splice(0)) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`agentlas exited before ${waiter.pattern}: ${code}\n${output}`));
  }
});

function waitFor(pattern) {
  if (pattern.test(output)) return Promise.resolve();
  if (closed) return Promise.reject(new Error(`agentlas already exited before ${pattern}\n${output}`));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const idx = waiters.findIndex((item) => item.resolve === resolve);
      if (idx >= 0) waiters.splice(idx, 1);
      reject(new Error(`timed out waiting for ${pattern}\n${output}`));
    }, 5000);
    waiters.push({ pattern, resolve, reject, timer });
  });
}

async function main() {
  await waitFor(/Tip: Type \/help/);
  child.stdin.write(`/ontology use "${docs}" as company knowledge\n`);
  await waitFor(/Registered ontology source:/);
  child.stdin.write("/ontology list\n");
  await waitFor(/Sources \(1\):/);
  child.stdin.write("/exit\n");
  child.stdin.end();

  await new Promise((resolve, reject) => {
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`agentlas exited ${code}\n${output}`))));
  });

  const manifestPath = path.join(project, ".agentlas", "ontology-sources.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.projectRoot, project);
  assert.equal(manifest.sources.length, 1);
  assert.equal(manifest.sources[0].path, docs);
  assert.equal(manifest.sources[0].kind, "company");
  assert.equal(manifest.sources[0].scope, "private");
  assert.match(output, /policy: inbox_and_registered_sources_only/);
  assert.match(output, /no home folder, no sibling projects/);
  assert.match(output, /Natural examples:/);
  console.log("ontology repl: ok");
}

main().catch((error) => {
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
