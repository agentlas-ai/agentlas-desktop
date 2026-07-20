#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function argument(name) {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : null;
}

async function openStore() {
  const { app } = require("electron");
  const userData = argument("--user-data");
  if (!userData) throw new Error("worker requires --user-data");
  app.setPath("userData", userData);
  await app.whenReady();
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  return { app, db: store.getDb() };
}

function insertAgent(db) {
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-attachment-agent", "agentlas-orchestrator", "One", "Coordinate exact work.", new Date().toISOString());
}

function prepareItem(grant, filePath, overrides = {}) {
  const stat = fs.statSync(filePath);
  return {
    grant,
    displayName: path.basename(filePath),
    claimedMediaType: "application/octet-stream",
    claimedSize: stat.size,
    ...overrides,
  };
}

function createFileGrant(access, filePath, durable = false) {
  return access.grantPath(filePath, { durable, exactFile: true });
}

function waitFor(predicate, timeoutMs = 4_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for attachment run"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

async function runtimeWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const base = argument("--base");
  if (!base) throw new Error("worker requires --base");
  const sources = path.join(base, "sources");
  const workspace = path.join(base, "workspace");
  const outside = path.join(base, "outside");
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  const chats = require("../dist/electron/store/chats.js");
  const tasks = require("../dist/electron/store/tasks.js");
  const access = require("../dist/electron/fs/access.js");
  const attachments = require("../dist/electron/one/attachments.js");
  const contract = require("../dist/shared/one-attachments.js");
  const chat = chats.createChat({ agentId: "one-attachment-agent", title: "Attachment QA", taskMode: "conversation" });
  chats.setChatWorkingFolder(chat.id, workspace);

  // Staging roots are not allowed to redirect through a symlink.
  const realBadRoot = path.join(base, "bad-root-target");
  const badRoot = path.join(base, "bad-root-link");
  fs.mkdirSync(realBadRoot);
  fs.symlinkSync(realBadRoot, badRoot, "dir");
  const originalRoot = process.env.AGENTLAS_ONE_ATTACHMENT_ROOT;
  process.env.AGENTLAS_ONE_ATTACHMENT_ROOT = badRoot;
  assert.throws(
    () => attachments.prepareOneAttachments({ chatId: chat.id, userPrompt: "bad root", attachments: [{
      grant: { path: "/invalid", kind: "file", durable: false, scope: { kind: "capability", token: "invalid" } },
      displayName: "bad.pdf", claimedMediaType: "application/pdf", claimedSize: 1,
    }] }),
    /staging root|regular directory|changed unexpectedly/i,
  );
  process.env.AGENTLAS_ONE_ATTACHMENT_ROOT = originalRoot;

  const pdf = path.join(sources, "actual-report.pdf");
  fs.writeFileSync(pdf, "%PDF-1.7\nclosed attachment verifier\n", { mode: 0o600 });
  const pdfGrant = createFileGrant(access, pdf);

  // Renderer metadata is untrusted: Main derives the actual safe basename,
  // type, size, digest, and returns an opaque path-free capability.
  const prepared = attachments.prepareOneAttachments({
    chatId: chat.id,
    userPrompt: "Summarize the report",
    attachments: [prepareItem(pdfGrant, pdf, { displayName: "../../escape-name.exe", claimedMediaType: "evil/type" })],
  });
  assert.equal(prepared.attachments[0].name, "actual-report.pdf");
  assert.equal(prepared.attachments[0].mediaType, "application/pdf");
  assert.ok(attachments.isSafeOneAttachmentReceipt(prepared.attachments[0]));
  assert.equal(JSON.stringify(prepared).includes(pdf), false, "renderer projection must not expose the source path");
  assert.equal(JSON.stringify(prepared.ref).includes(base), false, "opaque capability must not contain a host path");

  const claimed = attachments.claimOneAttachments({
    ref: prepared.ref,
    chatId: chat.id,
    userPrompt: "Summarize the report",
    runId: "run-direct-safe",
    resultFolder: workspace,
  });
  const stagedPath = claimed.redactions.find((item) => item.path.endsWith("actual-report.pdf")).path;
  const stagedDir = path.dirname(stagedPath);
  assert.ok(stagedPath.startsWith(path.join(workspace, ".agentlas", "one-attachments", "run-direct-safe")));
  assert.equal(path.basename(stagedPath), "01-actual-report.pdf");
  assert.equal(claimed.runtimeContext.includes(pdf), false, "Main runtime context must never contain the source path");
  assert.equal(fs.readFileSync(stagedPath, "utf8"), fs.readFileSync(pdf, "utf8"));
  const hostileEvent = {
    kind: "tool-use",
    text: `partial ${stagedPath}`,
    delta: `delta ${stagedDir}`,
    status: `status ${stagedPath}`,
    error: { code: "hostile", message: `error ${stagedPath}` },
    tool: { name: "hostile", args: `args ${stagedPath}`, result: `result ${stagedPath}` },
  };
  const redactedEvent = attachments.redactOneAttachmentEvent({
    chatId: chat.id,
    userPrompt: "safe",
    oneAttachmentRedactions: claimed.redactions,
  }, hostileEvent);
  assert.equal(JSON.stringify(redactedEvent).includes(stagedPath), false);
  assert.equal(JSON.stringify(redactedEvent).includes(stagedDir), false);
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: prepared.ref, chatId: chat.id, userPrompt: "Summarize the report", runId: "run-duplicate", resultFolder: workspace,
    }),
    /already been used/i,
  );
  attachments.releaseOneAttachmentRun(prepared.ref);
  assert.equal(fs.existsSync(stagedDir), false, "successful run cleanup must remove staged copies");

  // ImageAttachment is built only from Main's verified staged copy.
  const png = path.join(sources, "photo.png");
  fs.writeFileSync(png, Buffer.from("verified-image-bytes"), { mode: 0o600 });
  const pngPrepared = attachments.prepareOneAttachments({
    chatId: chat.id,
    userPrompt: "Inspect this image",
    attachments: [prepareItem(createFileGrant(access, png), png)],
  });
  const pngClaim = attachments.claimOneAttachments({
    ref: pngPrepared.ref, chatId: chat.id, userPrompt: "Inspect this image", runId: "run-image", resultFolder: workspace,
  });
  assert.equal(pngClaim.images.length, 1);
  assert.equal(pngClaim.images[0].mediaType, "image/png");
  assert.equal(Buffer.from(pngClaim.images[0].data, "base64").toString(), "verified-image-bytes");
  attachments.releaseOneAttachmentRun(pngPrepared.ref);

  const other = path.join(sources, "other.pdf");
  fs.writeFileSync(other, "%PDF-other");
  assert.throws(
    () => attachments.prepareOneAttachments({
      chatId: chat.id,
      userPrompt: "forged",
      attachments: [prepareItem({ ...pdfGrant, path: other }, other)],
    }),
    /capability|scope|approved/i,
  );
  const directoryGrant = access.grantPath(sources, { durable: false });
  assert.throws(
    () => attachments.prepareOneAttachments({
      chatId: chat.id, userPrompt: "directory", attachments: [prepareItem(directoryGrant, pdf)],
    }),
    /capability|scope|file/i,
  );
  const executable = path.join(sources, "payload.exe");
  fs.writeFileSync(executable, "MZ-hostile");
  assert.throws(
    () => attachments.prepareOneAttachments({
      chatId: chat.id, userPrompt: "unsupported", attachments: [prepareItem(createFileGrant(access, executable), executable)],
    }),
    /not supported/i,
  );
  assert.throws(
    () => attachments.prepareOneAttachments({
      chatId: chat.id,
      userPrompt: "too many",
      attachments: Array.from({ length: contract.ONE_ATTACHMENT_LIMITS.maxCount + 1 }, () => prepareItem(pdfGrant, pdf)),
    }),
    /at most/i,
  );
  const hugeImage = path.join(sources, "huge.png");
  fs.closeSync(fs.openSync(hugeImage, "w", 0o600));
  fs.truncateSync(hugeImage, contract.ONE_ATTACHMENT_LIMITS.maxImageBytes + 1);
  assert.throws(
    () => attachments.prepareOneAttachments({
      chatId: chat.id, userPrompt: "too large", attachments: [prepareItem(createFileGrant(access, hugeImage), hugeImage)],
    }),
    /limit|large/i,
  );

  // Replacement and symlink swaps between prepare and claim fail closed.
  const replaced = path.join(sources, "replace.txt");
  fs.writeFileSync(replaced, "version-one");
  const replacePrepared = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "replace test", attachments: [prepareItem(createFileGrant(access, replaced), replaced)],
  });
  fs.renameSync(replaced, `${replaced}.old`);
  fs.writeFileSync(replaced, "version-two");
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: replacePrepared.ref, chatId: chat.id, userPrompt: "replace test", runId: "run-replaced", resultFolder: workspace,
    }),
    /changed|available/i,
  );
  attachments.releaseOneAttachmentRun(replacePrepared.ref);

  const symlinked = path.join(sources, "symlink.txt");
  const outsideFile = path.join(outside, "outside.txt");
  fs.writeFileSync(symlinked, "approved");
  fs.writeFileSync(outsideFile, "outside");
  const symlinkPrepared = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "symlink test", attachments: [prepareItem(createFileGrant(access, symlinked), symlinked)],
  });
  fs.renameSync(symlinked, `${symlinked}.old`);
  fs.symlinkSync(outsideFile, symlinked);
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: symlinkPrepared.ref, chatId: chat.id, userPrompt: "symlink test", runId: "run-symlink", resultFolder: workspace,
    }),
    /available|changed|approved/i,
  );
  attachments.releaseOneAttachmentRun(symlinkPrepared.ref);

  // Team execution can use only the exact frozen capability attached to the
  // exact proposal. A mismatched attempt consumes it and cannot be retried.
  const teamA = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "team frozen prompt", attachments: [prepareItem(pdfGrant, pdf)],
  });
  attachments.bindOneAttachmentsToTeam({ ref: teamA.ref, proposalId: "proposal:team-a", chatId: chat.id });
  assert.equal(attachments.teamProposalRequiresOneAttachments("proposal:team-a"), true);
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: teamA.ref, chatId: chat.id, userPrompt: "team frozen prompt", runId: "run-team-wrong", resultFolder: workspace,
    }),
    /team proposal/i,
  );
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: teamA.ref, chatId: chat.id, userPrompt: "team frozen prompt", runId: "run-team-retry", resultFolder: workspace,
      teamProposalId: "proposal:team-a",
    }),
    /already been used/i,
  );
  attachments.releaseOneAttachmentRun(teamA.ref);

  const teamB = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "team exact prompt", attachments: [prepareItem(pdfGrant, pdf)],
  });
  const teamProjection = attachments.bindOneAttachmentsToTeam({ ref: teamB.ref, proposalId: "proposal:team-b", chatId: chat.id });
  assert.equal(JSON.stringify(teamProjection).includes(pdf), false);
  assert.deepEqual(attachments.getOneAttachmentsForTeam("proposal:team-b"), teamProjection);
  const teamClaim = attachments.claimOneAttachments({
    ref: teamB.ref, chatId: chat.id, userPrompt: "team exact prompt", runId: "run-team-exact", resultFolder: workspace,
    teamProposalId: "proposal:team-b",
  });
  assert.ok(teamClaim.runtimeContext.includes("actual-report.pdf"));
  attachments.releaseOneAttachmentRun(teamB.ref);

  // Exercise the InvocationService boundary with a hostile runtime. The fake
  // runner receives the Main-only staged path, then tries to leak it through
  // partial/final/tool data and result-folder receipts.
  const clientPath = require.resolve("../dist/electron/mcp/client.js");
  const clientModule = require(clientPath);
  let runtimeStagedPath = null;
  const runtimeRequestSnapshots = [];
  clientModule.runMcpInvocation = async (req, sink) => {
    runtimeRequestSnapshots.push(JSON.stringify(req));
    runtimeStagedPath = req.oneAttachmentRedactions[0].path;
    sink({ kind: "partial", text: `partial ${runtimeStagedPath}` });
    sink({ kind: "tool-use", status: `status ${runtimeStagedPath}`, tool: {
      name: "hostile.tool", args: `args ${runtimeStagedPath}`, result: `result ${runtimeStagedPath}`,
    } });
    if (req.userPrompt.includes("throw")) throw new Error(`runtime threw ${runtimeStagedPath}`);
    sink({ kind: "final", text: `final ${runtimeStagedPath}` });
    return { finalText: `final ${runtimeStagedPath}`, resultFolder: runtimeStagedPath };
  };
  const { InvocationService } = require("../dist/electron/invocation/service.js");
  const service = new InvocationService();
  const wireEvents = [];
  service.onEvent((event) => wireEvents.push(event));

  const servicePrepared = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "attachment-only service", attachments: [prepareItem(pdfGrant, pdf)],
  });
  const serviceRunId = randomUUID();
  const serviceRun = service.start({
    runId: serviceRunId, chatId: chat.id, userPrompt: "attachment-only service",
    oneMode: true, taskIntent: "conversation", permissions: "read", sessionRouting: false,
    oneAttachmentRef: servicePrepared.ref,
  });
  await waitFor(() => service.receipt(serviceRun.runId)?.status === "completed");
  const serviceReceipt = service.receipt(serviceRun.runId);
  assert.equal(serviceReceipt.resultFolder, workspace, "private staging must not replace the public result folder");
  assert.ok(tasks.findCanonicalTaskForChat(chat.id), "an attachment turn must promote to a canonical Task");
  assert.equal(JSON.stringify(wireEvents).includes(runtimeStagedPath), false, "wire events must redact staged paths");
  assert.equal(runtimeRequestSnapshots.some((snapshot) => snapshot.includes(servicePrepared.ref.capabilityToken)), false,
    "the consumed capability token must not cross into the runtime request");
  assert.equal(runtimeRequestSnapshots.some((snapshot) => snapshot.includes(servicePrepared.ref.attachmentSetId)), false,
    "the process-local attachment set id must not cross into the runtime request");
  assert.equal(JSON.stringify(wireEvents).includes(servicePrepared.ref.capabilityToken), false,
    "wire events must never expose the capability token");
  await waitFor(() => !fs.existsSync(path.dirname(runtimeStagedPath)));
  assert.equal(fs.existsSync(path.dirname(runtimeStagedPath)), false, "service finally must clean staged copies");
  assert.throws(
    () => service.start({
      runId: randomUUID(), chatId: chat.id, userPrompt: "attachment-only service", oneMode: true,
      taskIntent: "task", permissions: "write", oneAttachmentRef: servicePrepared.ref,
    }),
    /unavailable|already been used/i,
  );

  const failurePrepared = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "throw attachment path", attachments: [prepareItem(pdfGrant, pdf)],
  });
  const failureRunId = randomUUID();
  const failureRun = service.start({
    runId: failureRunId, chatId: chat.id, userPrompt: "throw attachment path",
    oneMode: true, taskIntent: "task", permissions: "write", oneAttachmentRef: failurePrepared.ref,
  });
  await waitFor(() => ["failed", "cancelled"].includes(service.receipt(failureRun.runId)?.status));
  assert.equal(runtimeRequestSnapshots.some((snapshot) => snapshot.includes(failurePrepared.ref.capabilityToken)), false);
  assert.equal(runtimeRequestSnapshots.some((snapshot) => snapshot.includes(failurePrepared.ref.attachmentSetId)), false);

  const runEventRows = db.prepare("SELECT * FROM run_events WHERE run_id IN (?, ?) ORDER BY seq").all(serviceRun.runId, failureRun.runId);
  const failureRows = db.prepare("SELECT * FROM failure_events WHERE run_id IN (?, ?) ORDER BY ts").all(serviceRun.runId, failureRun.runId);
  const persisted = JSON.stringify({
    runEvents: runEventRows,
    failures: failureRows,
    receipts: [service.receipt(serviceRun.runId), service.receipt(failureRun.runId)],
  });
  assert.equal(persisted.includes(pdf), false, "source path must never be durable");
  assert.equal(persisted.includes(".agentlas/one-attachments"), false, "staging paths must never enter receipts or ledgers");
  assert.match(persisted, /one_attachments_claimed/);
  const claimedLedger = JSON.stringify(runEventRows.filter((row) => row.kind === "one_attachments_claimed"));
  assert.equal(claimedLedger.includes("actual-report.pdf"), false, "durable attachment claim receipt intentionally excludes names");

  const serviceSource = fs.readFileSync(path.join(__dirname, "../electron/invocation/service.ts"), "utf8");
  const clientSource = fs.readFileSync(path.join(__dirname, "../electron/mcp/client.ts"), "utf8");
  const teamSource = fs.readFileSync(path.join(__dirname, "../electron/mcp/borrowed-task-force.ts"), "utf8");
  assert.match(serviceSource, /rawEvent = redactOneAttachmentEvent\(runReq, rawEvent\)/);
  assert.match(serviceSource, /redactOneAttachmentText\([\s\S]*error instanceof Error \? error\.message/);
  assert.match(clientSource, /appendChatMessage\(chat\.id, "user", req\.userPrompt\)/, "visible user history must keep only the user's prompt");
  assert.match(clientSource, /appendChatMessage\(chat\.id, "assistant", redactOneAttachmentText/);
  assert.match(clientSource, /const displayWithFloor = stripDanglingLanguageFence\(redactOneAttachmentText/);
  assert.match(teamSource, /oneAttachmentExecutionPrompt\(p\.req\)/);
  assert.match(teamSource, /displayText = redactOneAttachmentText\(p\.req, displayText\)/);

  console.log(JSON.stringify({ ok: true, hostileCases: 16, ledgerRedacted: true, teamBinding: true }));
  db.close();
  app.quit();
}

async function prepareRestartWorker() {
  const { app, db } = await openStore();
  insertAgent(db);
  const base = argument("--base");
  const infoFile = argument("--info");
  const workspace = path.join(base, "restart-workspace");
  const source = path.join(base, "restart-source.pdf");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(source, "%PDF-restart");
  const chats = require("../dist/electron/store/chats.js");
  const access = require("../dist/electron/fs/access.js");
  const attachments = require("../dist/electron/one/attachments.js");
  const chat = chats.createChat({ agentId: "one-attachment-agent", title: "Restart attachment", taskMode: "conversation" });
  chats.setChatWorkingFolder(chat.id, workspace);
  const grant = createFileGrant(access, source, true);
  const prepared = attachments.prepareOneAttachments({
    chatId: chat.id, userPrompt: "restart refusal", attachments: [prepareItem(grant, source)],
  });
  fs.writeFileSync(infoFile, JSON.stringify({ ref: prepared.ref, chatId: chat.id, workspace, source }));
  console.log(JSON.stringify({ ok: true, preparedBeforeRestart: true }));
  db.close();
  app.quit();
}

async function recoverRestartWorker() {
  const { app, db } = await openStore();
  const info = JSON.parse(fs.readFileSync(argument("--info"), "utf8"));
  const attachments = require("../dist/electron/one/attachments.js");
  assert.throws(
    () => attachments.claimOneAttachments({
      ref: info.ref, chatId: info.chatId, userPrompt: "restart refusal", runId: "run-after-restart", resultFolder: info.workspace,
    }),
    /unavailable/i,
  );
  const pending = path.join(process.env.AGENTLAS_ONE_ATTACHMENT_ROOT, "pending");
  assert.deepEqual(fs.existsSync(pending) ? fs.readdirSync(pending) : [], [], "restart must remove orphan pending copies");
  assert.equal(JSON.stringify(info.ref).includes(info.source), false);
  console.log(JSON.stringify({ ok: true, restartRejected: true, orphanPendingCleaned: true }));
  db.close();
  app.quit();
}

function runWorker(args, env) {
  const executable = process.versions.electron ? process.execPath : require("electron");
  return spawnSync(executable, [__filename, ...args], { env, encoding: "utf8" });
}

function orchestrate() {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-attachments-")));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  env.AGENTLAS_STORE_PATH = path.join(temp, "agentlas.sqlite");
  env.AGENTLAS_FS_GRANT_STORE = path.join(temp, "fs-grants.json");
  env.AGENTLAS_ONE_ATTACHMENT_ROOT = path.join(temp, "attachment-root");
  const userData = path.join(temp, "user-data");
  const info = path.join(temp, "restart-info.json");
  try {
    const runtime = runWorker(["--runtime", `--base=${path.join(temp, "runtime")}`, `--user-data=${userData}`], env);
    if (runtime.status !== 0) throw new Error(`runtime worker failed\n${runtime.stdout}\n${runtime.stderr}`);
    process.stdout.write(runtime.stdout);

    // Use a fresh store/root for the process-restart capability test.
    env.AGENTLAS_STORE_PATH = path.join(temp, "restart.sqlite");
    env.AGENTLAS_FS_GRANT_STORE = path.join(temp, "restart-fs-grants.json");
    env.AGENTLAS_ONE_ATTACHMENT_ROOT = path.join(temp, "restart-attachment-root");
    const prepared = runWorker(["--prepare-restart", `--base=${path.join(temp, "restart")}`, `--info=${info}`, `--user-data=${userData}`], env);
    if (prepared.status !== 0) throw new Error(`restart prepare worker failed\n${prepared.stdout}\n${prepared.stderr}`);
    process.stdout.write(prepared.stdout);
    const recovered = runWorker(["--recover-restart", `--info=${info}`, `--user-data=${userData}`], env);
    if (recovered.status !== 0) throw new Error(`restart recovery worker failed\n${recovered.stdout}\n${recovered.stderr}`);
    process.stdout.write(recovered.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--runtime")) {
  runtimeWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--prepare-restart")) {
  prepareRestartWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--recover-restart")) {
  recoverRestartWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
