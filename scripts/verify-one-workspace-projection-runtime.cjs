#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function worker() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  const projectionRoot = argument("--projection-root");
  const projectFolder = argument("--project-folder");
  if (!userData || !projectionRoot || !projectFolder) throw new Error("worker paths are required");
  app.setPath("userData", userData);
  process.env.AGENTLAS_ONE_WORKSPACE_ROOT = projectionRoot;
  await app.whenReady();

  const dbStore = require("../dist/electron/store/db.js");
  dbStore.initStore();
  const db = dbStore.getDb();
  const chats = require("../dist/electron/store/chats.js");
  const projects = require("../dist/electron/store/projects.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const runEvents = require("../dist/electron/store/run-events.js");
  const domainEvents = require("../dist/electron/one/domain-events.js");
  const workspace = require("../dist/electron/one/workspace-projection.js");
  const surfaces = require("../dist/shared/one-surface.js");

  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-workspace-agent", "one-workspace-agent", "One", "Workspace projection verifier", now);

  const project = projects.createProject({
    name: "Launch project",
    folderPath: projectFolder,
  });
  const chat = chats.createChat({
    agentId: "one-workspace-agent",
    projectId: project.id,
    title: "Prepare the launch comparison",
    taskMode: "task",
  });
  let task = tasks.getCanonicalTaskForChat(chat.id);
  assert.ok(task);
  task = tasks.setCanonicalTaskStatus(task.id, "running");

  const runId = "run_one_workspace_projection";
  runEvents.recordRunEvent({
    runId,
    kind: "invoke_started",
    chatId: chat.id,
    agentId: "one-workspace-agent",
    payload: {
      oneMode: true,
      resultFolder: "/private/tmp/must-not-enter-projection",
      token: "api_key=sk-proj-1234567890abcdefgh",
    },
  });
  domainEvents.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: runId,
    projectId: project.id,
    taskId: task.id,
    version: 1,
    visibility: "project",
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });

  const surface = surfaces.adaptLegacySurfaceToOneV1({
    manifest: {
      version: "0.1",
      kind: "surface",
      title: "Launch comparison",
      domain: "one-workspace-test",
      layout: "table",
      data: {
        products: {
          type: "table",
          columns: ["product", "price"],
          rows: [{ product: "A", price: 42 }],
        },
      },
      widgets: [{ type: "table", data: "products", title: "Products" }],
    },
    surfaceId: "surface:one-workspace-projection",
    taskId: task.id,
    syncedAt: now,
  });

  workspace.projectOneWorkspace({
    task,
    runId,
    chatId: chat.id,
    phase: "surface_ready",
    surface,
  });

  runEvents.recordRunEvent({
    runId,
    kind: "invoke_completed",
    chatId: chat.id,
    agentId: "one-workspace-agent",
    payload: { resultFolder: "/private/tmp/must-not-enter-projection" },
  });
  task = tasks.setCanonicalTaskStatus(task.id, "partial");
  workspace.projectOneWorkspace({
    task,
    runId,
    chatId: chat.id,
    phase: "completed",
  });

  const projectRef = `project-${project.id}`;
  const globalTask = path.join(projectionRoot, "projects", projectRef, "tasks", task.id);
  const localRoot = path.join(projectFolder, ".agentlas", "one");
  const localTask = path.join(localRoot, "projects", "current", "tasks", task.id);
  for (const root of [projectionRoot, localRoot]) {
    assert.ok(fs.statSync(path.join(root, "README.md")).isFile());
    const manifest = readJson(path.join(root, "manifest.json"));
    assert.equal(manifest.authority, "agentlas-sqlite-local");
    assert.equal(manifest.projectionOnly, true);
  }
  for (const taskRoot of [globalTask, localTask]) {
    const summary = fs.readFileSync(path.join(taskRoot, "SUMMARY.md"), "utf8");
    assert.match(summary, /launch comparison/i);
    assert.match(summary, /Result and files/);
    assert.match(summary, /Activity history/);
    assert.equal(readJson(path.join(taskRoot, "task.json")).latestRunPhase, "completed");
    assert.equal(readJson(path.join(taskRoot, "team.json")).participants.length, 1);
    assert.equal(readJson(path.join(taskRoot, "runs", runId, "run.json")).receipt.status, "completed");
    assert.equal(readJson(path.join(taskRoot, "outputs", "index.json")).layout, "comparison");
    assert.ok(readJson(path.join(taskRoot, "logs", "timeline.json")).events.length >= 1);
  }

  const serialized = fs.readFileSync(path.join(globalTask, "runs", runId, "run.json"), "utf8");
  assert.doesNotMatch(serialized, /\/private\/tmp|sk-proj|api_key|resultFolder/);
  assert.ok(fs.statSync(path.join(globalTask, "runs", runId, "surface.json")).isFile());
  assert.ok(fs.statSync(path.join(projectionRoot, "memory", "approved.json")).isFile());
  assert.ok(fs.statSync(path.join(projectionRoot, "learning", "experience-reuse.json")).isFile());
  assert.ok(fs.statSync(path.join(projectionRoot, "learning", "improvements.json")).isFile());
  assert.ok(fs.statSync(path.join(projectionRoot, "projects", projectRef, "ontology", "status.json")).isFile());
  const rootReadme = fs.readFileSync(path.join(projectionRoot, "README.md"), "utf8");
  assert.match(rootReadme, /work grouped by project, then by task/);
  const projectSummary = fs.readFileSync(path.join(projectionRoot, "projects", projectRef, "SUMMARY.md"), "utf8");
  assert.match(projectSummary, /Latest task/);
  assert.match(projectSummary, /Project knowledge/);

  if (process.platform !== "win32") {
    const protectedFile = path.join(path.dirname(projectionRoot), "outside.json");
    fs.writeFileSync(protectedFile, "outside\n", { mode: 0o600 });
    const approved = path.join(projectionRoot, "memory", "approved.json");
    fs.rmSync(approved);
    fs.symlinkSync(protectedFile, approved);
    assert.equal(workspace.tryProjectOneWorkspace({
      task,
      runId,
      chatId: chat.id,
      phase: "completed",
    }), false, "a redirected projection file must fail closed");
    assert.equal(fs.readFileSync(protectedFile, "utf8"), "outside\n");
  }

  console.log(JSON.stringify({
    ok: true,
    projectionRoot,
    projectLocalRoot: localRoot,
    taskId: task.id,
    runId,
  }));
  db.close();
  app.exit(0);
}

function orchestrate() {
  const electronModule = require("electron");
  const executable = typeof electronModule === "string" ? electronModule : process.execPath;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-workspace-projection-"));
  const userData = path.join(temp, "user-data");
  const projectionRoot = path.join(temp, "global-one");
  const projectFolder = path.join(temp, "project");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(projectFolder, { recursive: true });
  const env = {
    ...process.env,
    AGENTLAS_STORE_PATH: path.join(temp, "agentlas.sqlite"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  try {
    const result = spawnSync(
      executable,
      [__filename, "--worker", `--user-data=${userData}`, `--projection-root=${projectionRoot}`, `--project-folder=${projectFolder}`],
      { env, encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(`One workspace projection worker failed (${result.status})\n${result.stdout}\n${result.stderr}`);
    }
    process.stdout.write(result.stdout);
    console.log("Agentlas One workspace projection runtime verification passed.");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--worker")) {
  worker().catch((error) => {
    console.error(error);
    try { require("electron").app.exit(1); } catch { process.exitCode = 1; }
  });
} else {
  orchestrate();
}
