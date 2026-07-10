#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-tf-memory-"));
const sandboxHome = path.join(tmp, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.USERPROFILE = sandboxHome;
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");
app.setPath("userData", path.join(tmp, "user-data"));

function event(content, scope = "agent_repo") {
  return {
    memory_kind: "procedure",
    content,
    suggested_scope: scope,
    confidence: "high",
    sensitivity: "internal",
    evidence_refs: [],
  };
}

function nestText(slug) {
  const file = path.join(
    sandboxHome,
    ".agentlas",
    "networking",
    "hub-agents",
    slug,
    "memory",
    "project-soul-memory.md",
  );
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  await app.whenReady();
  const db = require("../dist/electron/store/db.js");
  const { curateEvents } = require("../dist/electron/memory/curator.js");
  db.initStore();

  const projectPath = path.join(tmp, "project-alpha");
  fs.mkdirSync(projectPath, { recursive: true });
  const synthesisContent = "Project Alpha deploys from its private release branch every Tuesday.";
  const baseContext = {
    projectPath,
    projectId: "project-alpha",
    agentId: "local-orchestrator",
    chatId: "chat-alpha",
    cwdAtRequest: projectPath,
    // Defense in depth: even if a caller accidentally supplies every participant,
    // synthesis provenance must prevent attribution to any borrowed agent.
    borrowedAgentSlugs: ["researcher", "builder"],
    sourceProvenance: "task-force-synthesis",
  };

  const report = curateEvents([event(synthesisContent)], baseContext);
  assert.equal(report.written, 1, "project-bound synthesis memory should remain durable in the project");
  const row = db.getDb()
    .prepare(
      `SELECT scope, project_id, project_path, agent_id, chat_id, evidence_json
         FROM memory_entries WHERE content = ?`,
    )
    .get(synthesisContent);
  assert.equal(row.scope, "project", "unattributed synthesis must not become global agent_repo memory");
  assert.equal(row.project_id, "project-alpha", "project identity must stay attached");
  assert.equal(row.project_path, projectPath, "project path boundary must stay attached");
  assert.equal(row.agent_id, "local-orchestrator", "the curation actor must remain the local orchestrator");
  assert.equal(row.chat_id, "chat-alpha", "the source chat must remain traceable");
  assert.ok(
    JSON.parse(row.evidence_json).includes("source:task-force-synthesis"),
    "runtime-controlled source provenance must be stored with the memory row",
  );
  const projectSoul = fs.readFileSync(
    path.join(projectPath, ".agentlas", "project-soul-memory.md"),
    "utf8",
  );
  assert.match(projectSoul, /private release branch/, "project synthesis belongs in the project soul");
  assert.doesNotMatch(nestText("researcher"), /private release branch/, "researcher nest must stay isolated");
  assert.doesNotMatch(nestText("builder"), /private release branch/, "builder nest must stay isolated");
  const globalCount = db.getDb()
    .prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content = ? AND project_path IS NULL")
    .get(synthesisContent).n;
  assert.equal(globalCount, 0, "project synthesis must not create any global DB memory");

  const folderlessContent = "A multi-agent synthesis has no attributable specialist owner.";
  const folderless = curateEvents([event(folderlessContent)], {
    ...baseContext,
    projectPath: null,
    projectId: null,
    cwdAtRequest: null,
  });
  assert.equal(folderless.written, 0, "folderless synthesis agent_repo proposals must not become durable");
  assert.equal(folderless.sessionOnly, 1, "folderless synthesis should degrade to session scope");
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content = ?").get(folderlessContent).n,
    0,
  );
  const folderlessProjectContent = "This folder-specific fact has no bound project folder.";
  const folderlessProject = curateEvents([event(folderlessProjectContent, "project")], {
    ...baseContext,
    projectPath: null,
    projectId: null,
    cwdAtRequest: null,
  });
  assert.equal(folderlessProject.written, 0, "folderless project synthesis must not become global team memory");
  assert.equal(folderlessProject.sessionOnly, 1);
  assert.equal(
    db.getDb().prepare("SELECT COUNT(*) AS n FROM memory_entries WHERE content = ?").get(folderlessProjectContent).n,
    0,
  );

  // Existing direct-borrow behavior remains valid when a single agent actually
  // owns the learning and no task-force synthesis provenance is present.
  const directContent = "The upload menu requires expanding Advanced first.";
  const direct = curateEvents([event(directContent)], {
    projectPath,
    projectId: "project-alpha",
    agentId: "local-orchestrator",
    chatId: "chat-direct",
    cwdAtRequest: projectPath,
    borrowedAgentSlugs: ["researcher"],
  });
  assert.equal(direct.written, 1);
  const directRow = db.getDb()
    .prepare("SELECT scope, project_path FROM memory_entries WHERE content = ?")
    .get(directContent);
  assert.deepEqual(directRow, { scope: "agent_repo", project_path: null });
  assert.match(nestText("researcher"), /expanding Advanced/, "direct owned learning should still reach its nest");
  assert.doesNotMatch(nestText("builder"), /expanding Advanced/, "direct learning must not reach another identity");

  const taskForceSource = fs.readFileSync(
    path.join(__dirname, "..", "electron", "mcp", "borrowed-task-force.ts"),
    "utf8",
  );
  const curationStart = taskForceSource.indexOf("const curated = curateReply");
  const curationEnd = taskForceSource.indexOf("displayText =", curationStart);
  const curationBlock = taskForceSource.slice(curationStart, curationEnd);
  assert.match(curationBlock, /sourceProvenance:\s*"task-force-synthesis"/);
  assert.doesNotMatch(curationBlock, /borrowedAgentSlugs/, "synthesis call must not claim participant ownership");

  console.log("task-force memory project/identity/provenance boundary ok");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    app.quit();
  });
