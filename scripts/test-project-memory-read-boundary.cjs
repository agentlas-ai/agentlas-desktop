#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

process.env.AGENTLAS_E2E = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-project-memory-read-"));
app.setPath("userData", path.join(tmp, "user-data"));
app.setPath("home", path.join(tmp, "home"));
process.env.AGENTLAS_STORE_PATH = path.join(tmp, "agentlas.sqlite");

function snapshotTree(root) {
  const rows = [];
  const visit = (current) => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      rows.push({
        relative,
        kind: stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        content: stat.isFile() ? fs.readFileSync(absolute).toString("base64") : null,
      });
      if (stat.isDirectory()) visit(absolute);
    }
  };
  visit(root);
  return rows;
}

async function main() {
  await app.whenReady();
  const { initStore, getDb } = require("../dist/electron/store/db.js");
  const bootstrap = require("../dist/electron/architecture/project-bootstrap.js");
  const originalEnsureDesktopProjectBootstrap = bootstrap.ensureDesktopProjectBootstrap;
  bootstrap.ensureDesktopProjectBootstrap = async () => ({ mode: "core" });
  const {
    activateFolder,
    canReadActivatedFolderMemory,
  } = require("../dist/electron/architecture/activation.js");
  const { buildMemoryContext } = require("../dist/electron/memory/context.js");
  const {
    PROJECT_MEMORY_TEXT_MAX_BYTES,
    setProjectMemoryReadTestHook,
  } = require("../dist/electron/memory/safe-project-read.js");
  initStore();

  const project = path.join(tmp, "project");
  const memoryDir = path.join(project, ".agentlas");
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "project-soul-memory.md"),
    "# Project Soul Memory\n\n## Decisions\n- Preserve the activated read-only memory boundary.\n",
    "utf8",
  );
  await activateFolder(project, "Memory Boundary Fixture", { permission: "write" });
  bootstrap.ensureDesktopProjectBootstrap = originalEnsureDesktopProjectBootstrap;
  const now = new Date().toISOString();

  const { insertMemoryEntry } = require("../dist/electron/memory/store.js");
  insertMemoryEntry({
    scope: "agent_repo",
    kind: "decision",
    content: "GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE",
    agentId: "fixture-agent",
    projectPath: null,
  });
  insertMemoryEntry({
    scope: "agent_repo",
    kind: "decision",
    content: "OTHER AGENT MEMORY MUST REMAIN ISOLATED",
    agentId: "other-agent",
    projectPath: null,
  });

  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), true);
  assert.equal(canReadActivatedFolderMemory(project, {
    permission: "read",
    restrictedReadBoundary: true,
  }), false, "Mobile/restricted reads must not consume mutable local project memory");
  assert.equal(canReadActivatedFolderMemory(project, {
    permission: "read",
    agentAppMode: true,
  }), false, "browser Agent Apps must remain stateless and project-memory free");
  assert.equal(canReadActivatedFolderMemory(project, { permission: undefined }), false);

  const inactive = path.join(tmp, "inactive");
  fs.mkdirSync(inactive, { recursive: true });
  assert.equal(canReadActivatedFolderMemory(inactive, { permission: "read" }), false,
    "a read turn must never activate a new folder");

  const before = snapshotTree(project);
  const activityBeforeRead = getDb()
    .prepare("SELECT visits, activated_at, first_seen, last_seen FROM folder_activity WHERE path = ?")
    .get(project);
  const context = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.match(context, /Preserve the activated read-only memory boundary/);
  assert.match(context, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  assert.doesNotMatch(context, /OTHER AGENT MEMORY MUST REMAIN ISOLATED/);
  assert.equal(fs.existsSync(path.join(memoryDir, "code-map")), false,
    "read-only recall must not start code-map materialization");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(snapshotTree(project), before,
    "read-only memory recall must not change project files, mtimes, or contents");
  assert.deepEqual(
    getDb().prepare("SELECT visits, activated_at, first_seen, last_seen FROM folder_activity WHERE path = ?").get(project),
    activityBeforeRead,
    "read-only recall must not increment visits or rewrite folder activity timestamps",
  );

  const storedIdentity = getDb()
    .prepare("SELECT identity_json, captured_at FROM activated_folder_identity WHERE path = ?")
    .get(project);
  assert.ok(storedIdentity, "explicit activation must persist a canonical folder identity");
  getDb().prepare("DELETE FROM activated_folder_identity WHERE path = ?").run(project);
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), false,
    "legacy/missing identity must fail closed until an authorized writable bind");
  const missingIdentityContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.doesNotMatch(missingIdentityContext, /Preserve the activated read-only memory boundary/);
  assert.match(missingIdentityContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  getDb().prepare(
    "INSERT INTO activated_folder_identity (path, identity_json, captured_at) VALUES (?, ?, ?)",
  ).run(project, storedIdentity.identity_json, storedIdentity.captured_at);
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), true);

  getDb().prepare(
    `INSERT INTO installed_agents (
       id, slug, name, name_en, tagline, tagline_en, system_prompt,
       mcp_servers_json, env_requirements_json, preferred_backend,
       trust_grade, installed_at, tone, builtin, role, visibility, entity_kind
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', NULL, 'A', ?, 'neutral', 0, NULL, 'visible', 'agent')`,
  ).run(
    "memory-read-firm-agent",
    "memory-read-firm-agent",
    "Memory Read Firm Agent",
    "Memory Read Firm Agent",
    "Read boundary fixture",
    "Read boundary fixture",
    "Return a short result.",
    now,
  );
  const chats = require("../dist/electron/store/chats.js");
  const chat = chats.createChat({ agentId: "memory-read-firm-agent", title: "Memory read firm" });
  chats.setChatWorkingFolder(chat.id, project);
  const active = {
    kind: "claude-code",
    backend: null,
    source: "memory-read-firm-test",
    ready: true,
    active: true,
    model: "fixture-model",
  };
  const runnerRequests = [];
  const picked = {
    label: "Memory read capture runner",
    runner: async (request) => {
      runnerRequests.push(request);
      return { text: "Firm read completed.", tokens: 1 };
    },
  };
  const selection = require("../dist/electron/runtime/selection.js");
  selection.selectRuntimeForTargets = () => ({
    active,
    picked,
    override: null,
    unavailableOverride: null,
  });
  const { runFirmInvocation } = require("../dist/electron/mcp/firm-orchestrator.js");
  const ceoAgent = require("../dist/electron/mcp/registry.js").getAgentById("memory-read-firm-agent");
  assert.ok(ceoAgent);
  const beforeFirm = snapshotTree(project);
  const firmEvents = [];
  await runFirmInvocation({
    req: {
      runId: "memory-read-firm-run",
      chatId: chat.id,
      userPrompt: "Inspect the activated project memory.",
      locale: "en",
      permissions: "read",
    },
    chat: { id: chat.id, projectId: null, firmId: "memory-read-firm" },
    org: {
      source: "orgchart",
      ceo: { id: "memory-read-firm-ceo", name: "Memory Read CEO", role: "CEO" },
      divisions: [],
    },
    ceoAgent,
    active,
    runtimes: [active],
    picked,
    workingFolder: project,
    runnerEnv: {},
    locale: "en",
    sink: (event) => firmEvents.push(event),
  });
  assert.equal(firmEvents.some((event) => event.kind === "error"), false);
  assert.equal(runnerRequests.length, 1);
  assert.match(runnerRequests[0].systemPrompt, /Preserve the activated read-only memory boundary/,
    "a read-only firm node must receive the activated project memory");
  assert.deepEqual(snapshotTree(project), beforeFirm,
    "firm read-only recall must not materialize or rewrite project-local state");
  assert.deepEqual(
    getDb().prepare("SELECT visits, activated_at, first_seen, last_seen FROM folder_activity WHERE path = ?").get(project),
    activityBeforeRead,
    "firm read-only recall must not update the visit ledger",
  );

  const soulPath = path.join(memoryDir, "project-soul-memory.md");
  const originalSoul = fs.readFileSync(soulPath, "utf8");

  // A same-path file swap after open must be rejected deterministically. The
  // replacement is installed by the E2E-only hook between descriptor read and
  // post-read path validation.
  const swappedSoul = path.join(memoryDir, "project-soul-memory.swap.md");
  fs.writeFileSync(swappedSoul, "FILE SWAP SECRET MUST NOT ENTER CONTEXT\n", "utf8");
  let fileSwapInjected = false;
  setProjectMemoryReadTestHook((stage, absolutePath) => {
    if (stage !== "after-read" || absolutePath !== soulPath || fileSwapInjected) return;
    fileSwapInjected = true;
    if (process.platform === "win32") {
      // Windows can deny renaming over an open descriptor; an in-place rewrite
      // still exercises the descriptor's mtime/ctime/size race validation.
      fs.writeFileSync(soulPath, "FILE SWAP SECRET MUST NOT ENTER CONTEXT\n", "utf8");
    } else {
      fs.renameSync(swappedSoul, soulPath);
    }
  });
  const racedContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  setProjectMemoryReadTestHook(null);
  assert.equal(fileSwapInjected, true);
  assert.doesNotMatch(racedContext, /Preserve the activated read-only memory boundary/);
  assert.doesNotMatch(racedContext, /FILE SWAP SECRET MUST NOT ENTER CONTEXT/);
  assert.match(racedContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/,
    "a rejected project file must not remove safe agent-global memory");
  fs.rmSync(swappedSoul, { force: true });
  fs.writeFileSync(soulPath, originalSoul, "utf8");

  // Oversized memory is optional recall, never an unbounded prompt input.
  fs.writeFileSync(soulPath, Buffer.alloc(PROJECT_MEMORY_TEXT_MAX_BYTES + 1, 0x41));
  const oversizedContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.doesNotMatch(oversizedContext, /A{128}/);
  assert.match(oversizedContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  fs.writeFileSync(soulPath, originalSoul, "utf8");

  fs.unlinkSync(soulPath);
  fs.mkdirSync(soulPath);
  const nonRegularContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.doesNotMatch(nonRegularContext, /Preserve the activated read-only memory boundary/,
    "a directory at a memory-file path must be rejected as non-regular");
  assert.match(nonRegularContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  fs.rmdirSync(soulPath);
  fs.writeFileSync(soulPath, originalSoul, "utf8");

  if (process.platform !== "win32") {
    // Neither a memory file nor a nested code-map file may be a symlink, even
    // when the symlink target is a readable regular file.
    const externalSoul = path.join(tmp, "external-private-memory.md");
    fs.writeFileSync(externalSoul, "SYMLINKED PRIVATE SOUL MUST NOT ENTER CONTEXT\n", "utf8");
    fs.unlinkSync(soulPath);
    fs.symlinkSync(externalSoul, soulPath);
    const symlinkSoulContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
    assert.doesNotMatch(symlinkSoulContext, /SYMLINKED PRIVATE SOUL MUST NOT ENTER CONTEXT/);
    assert.match(symlinkSoulContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
    fs.unlinkSync(soulPath);
    fs.writeFileSync(soulPath, originalSoul, "utf8");

    const codeMapDir = path.join(memoryDir, "code-map");
    const externalCodeMap = path.join(tmp, "external-code-map.json");
    fs.mkdirSync(codeMapDir, { recursive: true });
    fs.writeFileSync(externalCodeMap, JSON.stringify({
      project: "SYMLINKED CODE MAP SECRET",
      stats: { codeFiles: 999, symbols: 999 },
    }), "utf8");
    fs.symlinkSync(externalCodeMap, path.join(codeMapDir, "project-map.json"));
    const symlinkMapContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
    assert.doesNotMatch(symlinkMapContext, /SYMLINKED CODE MAP SECRET/);
    fs.rmSync(codeMapDir, { recursive: true, force: true });
  }

  const originalMemoryRoot = path.join(project, ".agentlas-original-root");
  fs.renameSync(memoryDir, originalMemoryRoot);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(
    path.join(memoryDir, "project-soul-memory.md"),
    "REPLACEMENT MEMORY ROOT SECRET MUST NOT ENTER CONTEXT\n",
    "utf8",
  );
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), false,
    "replacing only .agentlas must invalidate the stored memory-root identity");
  const replacedMemoryRootContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.doesNotMatch(replacedMemoryRootContext, /REPLACEMENT MEMORY ROOT SECRET MUST NOT ENTER CONTEXT/);
  assert.match(replacedMemoryRootContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  fs.rmSync(memoryDir, { recursive: true, force: true });
  fs.renameSync(originalMemoryRoot, memoryDir);
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), true);

  // Replacing the activated directory at the same visible path invalidates the
  // persisted root identity. The project sentinel is discarded, but the same
  // agent's global memory remains available.
  const originalProjectPath = path.join(tmp, "project-original-root");
  fs.renameSync(project, originalProjectPath);
  fs.mkdirSync(path.join(project, ".agentlas"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".agentlas", "project-soul-memory.md"),
    "REPLACEMENT FOLDER SECRET MUST NOT ENTER CONTEXT\n",
    "utf8",
  );
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), false);
  const replacedFolderContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
  assert.doesNotMatch(replacedFolderContext, /REPLACEMENT FOLDER SECRET MUST NOT ENTER CONTEXT/);
  assert.match(replacedFolderContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
  fs.rmSync(project, { recursive: true, force: true });
  fs.renameSync(originalProjectPath, project);
  assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), true,
    "restoring the same directory identity must restore optional project recall");

  if (process.platform !== "win32") {
    const originalForLink = path.join(tmp, "project-original-for-link");
    const attackerProject = path.join(tmp, "project-link-target");
    fs.renameSync(project, originalForLink);
    fs.mkdirSync(path.join(attackerProject, ".agentlas"), { recursive: true });
    fs.writeFileSync(
      path.join(attackerProject, ".agentlas", "project-soul-memory.md"),
      "ROOT SYMLINK SECRET MUST NOT ENTER CONTEXT\n",
      "utf8",
    );
    fs.symlinkSync(attackerProject, project, "dir");
    assert.equal(canReadActivatedFolderMemory(project, { permission: "read" }), false);
    const linkedRootContext = buildMemoryContext(project, "fixture-agent", { materializeCodeMap: false });
    assert.doesNotMatch(linkedRootContext, /ROOT SYMLINK SECRET MUST NOT ENTER CONTEXT/);
    assert.match(linkedRootContext, /GLOBAL AGENT MEMORY SURVIVES PROJECT IDENTITY FAILURE/);
    fs.unlinkSync(project);
    fs.renameSync(originalForLink, project);
  }

  assert.deepEqual(
    getDb().prepare("SELECT visits, activated_at, first_seen, last_seen FROM folder_activity WHERE path = ?").get(project),
    activityBeforeRead,
    "rejected read-only probes must not alter activation history",
  );

  const client = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
  const firm = fs.readFileSync(path.join(__dirname, "../electron/mcp/firm-orchestrator.ts"), "utf8");
  const activationSource = fs.readFileSync(path.join(__dirname, "../electron/architecture/activation.ts"), "utf8");
  for (const [label, source] of [["client", client], ["firm", firm]]) {
    assert.match(source, /const memoryReadPath = workingFolder/,
      `${label} must keep project recall separate from its writable activePath`);
    assert.match(source, /buildMemoryContext\(memoryReadPath,[\s\S]{0,180}materializeCodeMap:/,
      `${label} must make materialization authority explicit`);
  }
  assert.match(activationSource, /stat\.ino > 0n/,
    "zero inode values must be treated as unavailable instead of rejecting normal Windows folders");
  assert.match(activationSource, /birthtimeNs/,
    "folder identity needs a Windows-safe replacement signal when inode is unavailable");

  console.log("activated project memory read-only boundary ok");
  fs.rmSync(tmp, { recursive: true, force: true });
  app.quit();
}

main().catch((error) => {
  console.error(error);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  app.exit(1);
});
