#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nM8AAAAASUVORK5CYII=",
  "base64",
);

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
  const db = store.getDb();
  db.prepare(
    `INSERT OR IGNORE INTO installed_agents
       (id, slug, name, tagline, system_prompt, mcp_servers_json, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', 'A', ?, 'neutral')`,
  ).run("one-artifact-agent", "agentlas-orchestrator", "One", "Exact artifact verifier", new Date().toISOString());
  return { app, db };
}

function mediaManifest(title, rows) {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "one-artifact-runtime-test",
    layout: "gallery",
    data: { media: { type: "media", rows } },
    widgets: [{ type: "gallery", data: "media", title }],
  };
}

function artifactManifest(title, rows) {
  return {
    version: "0.1",
    kind: "surface",
    title,
    domain: "one-artifact-runtime-test",
    layout: "document",
    data: { artifacts: { type: "artifacts", rows } },
    widgets: [{ type: "artifact-list", data: "artifacts", title }],
  };
}

function createBoundSurface(ctx, input) {
  const chat = ctx.chats.createChat({ agentId: "one-artifact-agent", title: input.title });
  ctx.chats.setChatWorkingFolder(chat.id, input.workspace);
  const task = ctx.tasks.getCanonicalTaskForChat(chat.id);
  const runId = input.runId;
  ctx.runEvents.recordRunEvent({ runId, kind: "invoke_started", chatId: chat.id, payload: { oneMode: true } });
  ctx.domain.recordOneDomainEvent({
    eventType: "run.started",
    actor: "one",
    entityId: runId,
    taskId: task.id,
    version: 1,
    visibility: "personal",
    entries: [
      { name: "runId", value: runId },
      { name: "policyVersion", value: "agentlas-one-runtime-v1" },
    ],
  });
  const rawManifest = input.rawManifest || mediaManifest(input.title, input.rows);
  const surface = ctx.surface.adaptLegacySurfaceToOneV1({
    manifest: rawManifest,
    surfaceId: `surface:${runId}`,
    taskId: task.id,
    syncedAt: new Date().toISOString(),
  });
  ctx.results.recordDurableOneSurfaceResult({ runId, chatId: chat.id, manifest: surface });
  const bound = ctx.artifacts.bindOneSurfaceArtifacts({
    rawManifest,
    surface,
    taskId: task.id,
    taskVersion: task.version,
    chatId: chat.id,
    runId,
  });
  ctx.domain.recordOneDomainEvent({
    eventType: "result.manifest_ready",
    actor: "system",
    entityId: task.id,
    taskId: task.id,
    version: task.version,
    visibility: "personal",
    entries: [
      { name: "manifestId", value: surface.manifestId },
      { name: "contractVersion", value: surface.contractVersion },
      { name: "artifactRefs", value: surface.fallback.artifacts.map((item) => item.artifactRef) },
    ],
  });
  return { chat, task, runId, rawManifest, surface, bound };
}

function requestFor(value, artifactRef = value.surface.fallback.artifacts[0].artifactRef) {
  return {
    taskId: value.task.id,
    taskVersion: value.task.version,
    chatId: value.chat.id,
    runId: value.runId,
    manifestId: value.surface.manifestId,
    artifactRef,
  };
}

function finishRun(ctx, value) {
  ctx.runEvents.recordRunEvent({ runId: value.runId, kind: "invoke_completed", chatId: value.chat.id, payload: { resultFolder: "[workspace]" } });
  const partial = ctx.tasks.setCanonicalTaskStatus(value.task.id, "partial");
  ctx.domain.recordOneDomainEvent({
    eventType: "task.state_changed",
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "from", value: "running" },
      { name: "to", value: "partial" },
      { name: "reason", value: "authoritative invocation lifecycle" },
    ],
  });
  ctx.domain.recordOneDomainEvent({
    eventType: "receipt.recorded",
    actor: "system",
    entityId: partial.id,
    taskId: partial.id,
    version: partial.version,
    visibility: "personal",
    entries: [
      { name: "receiptId", value: `receipt:${value.runId}` },
      { name: "kind", value: "invoke_completed" },
      { name: "sourceOrRunRefs", value: [value.runId] },
    ],
  });
  return partial;
}

function acceptRun(ctx, value, partial, acceptedRunId = value.runId) {
  const receipt = ctx.runEvents.getInvocationRunReceipt(acceptedRunId);
  const accepted = ctx.tasks.acceptCanonicalTaskResult({
    taskId: value.task.id,
    expectedVersion: partial.version,
    expectedRunId: acceptedRunId,
  }, receipt);
  ctx.accepted.ensureAcceptedResultValueClosure({
    priorTaskVersion: partial.version,
    acceptedTask: accepted,
    expectedRunId: acceptedRunId,
    receipt,
    confirmedByUser: true,
  });
  return accepted;
}

function contextModules() {
  return {
    chats: require("../dist/electron/store/chats.js"),
    tasks: require("../dist/electron/store/tasks.js"),
    runEvents: require("../dist/electron/store/run-events.js"),
    results: require("../dist/electron/store/one-surface-results.js"),
    domain: require("../dist/electron/one/domain-events.js"),
    accepted: require("../dist/electron/one/accepted-result-value-closure.js"),
    artifacts: require("../dist/electron/one/artifact-preview.js"),
    surface: require("../dist/shared/one-surface.js"),
  };
}

async function bodyBytes(response) {
  return Buffer.from(await response.arrayBuffer());
}

async function runtimeWorker() {
  const { app, db } = await openStore();
  const base = argument("--base");
  if (!base) throw new Error("runtime worker requires --base");
  const workspace = fs.realpathSync.native(fs.mkdirSync(path.join(base, "workspace"), { recursive: true }) || path.join(base, "workspace"));
  const ctx = contextModules();

  const image = path.join(workspace, "actual.png");
  fs.writeFileSync(image, PNG_BYTES, { mode: 0o600 });
  const direct = createBoundSurface(ctx, {
    title: "Exact local gallery",
    workspace,
    runId: "run_artifact_exact_a",
    rows: [{ filePath: image, mediaType: "image", label: "Actual image" }],
  });
  assert.equal(direct.bound, 1);
  assert.equal(direct.surface.blocks[0].type, "Gallery");
  assert.equal(direct.surface.blocks[0].items[0].provenance, "unknown_source", "unproven legacy media must not be relabeled as a user original");
  const directRequest = requestFor(direct);
  const serializedSurface = JSON.stringify(direct.surface);
  assert.equal(serializedSurface.includes(base), false);
  assert.equal(serializedSurface.includes("file://"), false);

  const issuedAt = Date.now();
  const capability = ctx.artifacts.issueOneArtifactPreviewCapability(directRequest, issuedAt);
  assert.ok(capability);
  assert.match(capability.capabilityUrl, /^agentlas:\/\/one-artifact\/[a-f0-9]{64}$/);
  assert.equal(capability.mimeType, "image/png");
  assert.equal(JSON.stringify(capability).includes(base), false);
  assert.deepEqual(await bodyBytes(ctx.artifacts.serveOneArtifactProtocolRequest(capability.capabilityUrl, null, issuedAt + 1)), PNG_BYTES);
  assert.equal(ctx.artifacts.resolveOneArtifactOpenPath(directRequest), image);

  const document = path.join(workspace, "customer-interviews.docx");
  const spreadsheet = path.join(workspace, "july-expenses.xlsx");
  fs.writeFileSync(document, Buffer.from("PK\u0003\u0004docx-test"), { mode: 0o600 });
  fs.writeFileSync(spreadsheet, Buffer.from("PK\u0003\u0004xlsx-test"), { mode: 0o600 });
  const office = createBoundSurface(ctx, {
    title: "Exact local office files",
    workspace,
    runId: "run_artifact_office_files",
    rawManifest: artifactManifest("Exact local office files", [
      { path: path.basename(document), format: "docx", label: "Customer interviews" },
      { path: path.basename(spreadsheet), format: "xlsx", label: "July expenses" },
    ]),
  });
  assert.equal(office.bound, 2);
  assert.equal(office.surface.blocks[0].type, "ArtifactList");
  assert.deepEqual(office.surface.fallback.artifacts.map((item) => item.verificationStatus), ["verified", "verified"]);
  assert.ok(office.surface.fallback.artifacts.every((item) => Number(item.sizeBytes) > 0));
  const documentRequest = requestFor(office, office.surface.blocks[0].items[0].artifactRef);
  const spreadsheetRequest = requestFor(office, office.surface.blocks[0].items[1].artifactRef);
  assert.equal(ctx.artifacts.resolveOneArtifactOpenPath(documentRequest), document);
  assert.equal(ctx.artifacts.resolveOneArtifactOpenPath(spreadsheetRequest), spreadsheet);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability(documentRequest), null, "office files open through the OS and never receive media preview URLs");

  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, taskVersion: directRequest.taskVersion + 1 }), null);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, chatId: "chat_forged_123" }), null);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, runId: "run_forged_123" }), null);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, manifestId: "manifest_forged_123" }), null);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, artifactRef: "artifact_forged_123" }), null);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...directRequest, extra: "authority" }), null);
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(`agentlas://one-artifact/${"f".repeat(64)}`, null).status, 404);
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(`${capability.capabilityUrl}?p=${encodeURIComponent(image)}`, null).status, 404);
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(capability.capabilityUrl, null, issuedAt + ctx.artifacts.ONE_ARTIFACT_PREVIEW_TTL_MS + 1).status, 404);

  const replacementCapability = ctx.artifacts.issueOneArtifactPreviewCapability(directRequest);
  fs.writeFileSync(image, Buffer.from(PNG_BYTES.map((byte, index) => index === 20 ? byte ^ 1 : byte)));
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability(directRequest), null, "same-size replacement must fail identity/digest verification");
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(replacementCapability.capabilityUrl, null).status, 404);

  const video = path.join(workspace, "clip.mp4");
  const videoBytes = Buffer.alloc(ctx.artifacts.ONE_ARTIFACT_MAX_RANGE_BYTES + 1024, 0x5a);
  fs.writeFileSync(video, videoBytes, { mode: 0o600 });
  const media = createBoundSurface(ctx, {
    title: "Range media",
    workspace,
    runId: "run_artifact_range",
    rows: [{ path: video, mediaType: "video", label: "Clip", provenance: "generated" }],
  });
  assert.equal(media.bound, 1);
  assert.equal(media.surface.blocks[0].type, "Media");
  const mediaCapability = ctx.artifacts.issueOneArtifactPreviewCapability(requestFor(media));
  const range = ctx.artifacts.serveOneArtifactProtocolRequest(mediaCapability.capabilityUrl, "bytes=2-5");
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-range"), `bytes 2-5/${videoBytes.length}`);
  assert.deepEqual(await bodyBytes(range), videoBytes.subarray(2, 6));
  const clamped = ctx.artifacts.serveOneArtifactProtocolRequest(mediaCapability.capabilityUrl, "bytes=0-");
  assert.equal(clamped.status, 206);
  assert.equal(Number(clamped.headers.get("content-length")), ctx.artifacts.ONE_ARTIFACT_MAX_RANGE_BYTES);
  await clamped.body.cancel();
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(mediaCapability.capabilityUrl, "bytes=0-1,4-5").status, 416);

  const safeAgain = path.join(workspace, "safe-again.png");
  fs.writeFileSync(safeAgain, PNG_BYTES);
  const target = path.join(workspace, "real-target.png");
  const symlink = path.join(workspace, "symlink.png");
  fs.writeFileSync(target, PNG_BYTES);
  fs.symlinkSync(target, symlink);
  const archiveDir = path.join(workspace, ".agentlas", "archive", "asset-packs");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archived = path.join(archiveDir, "old.png");
  fs.writeFileSync(archived, PNG_BYTES);
  const hostileRows = [
    { path: symlink, mediaType: "image", label: "symlink" },
    { path: archived, mediaType: "image", label: "archive" },
    { path: path.join(workspace, "missing.png"), mediaType: "image", label: "missing" },
    { path: "https://example.com/remote.png", mediaType: "image", label: "remote" },
    { path: "data:image/png;base64,AAAA", mediaType: "image", label: "embedded" },
    { path: path.join(workspace, "payload.html"), mediaType: "image", label: "confused" },
  ];
  fs.writeFileSync(path.join(workspace, "payload.html"), "<script>hostile</script>");
  const hostile = createBoundSurface(ctx, { title: "Hostile media", workspace, runId: "run_artifact_hostile", rows: hostileRows });
  assert.equal(hostile.bound, 0);

  const terminalImage = path.join(workspace, "terminal.png");
  fs.writeFileSync(terminalImage, PNG_BYTES);
  const terminal = createBoundSurface(ctx, {
    title: "Terminal transition",
    workspace,
    runId: "run_artifact_terminal_a",
    rows: [{ path: terminalImage, mediaType: "image", label: "Terminal", provenance: "user original" }],
  });
  const terminalPartial = finishRun(ctx, terminal);
  const terminalRequest = { ...requestFor(terminal), taskVersion: terminalPartial.version };
  assert.ok(ctx.artifacts.issueOneArtifactPreviewCapability(terminalRequest), "same-run terminal receipt must authorize its exact result-ready version");

  // A later run B can be accepted for the same Task, but its Value Closure may
  // never authorize run A's artifact binding.
  const runB = "run_artifact_terminal_b";
  ctx.runEvents.recordRunEvent({ runId: runB, kind: "invoke_started", chatId: terminal.chat.id, payload: { oneMode: true } });
  ctx.runEvents.recordRunEvent({ runId: runB, kind: "invoke_completed", chatId: terminal.chat.id, payload: {} });
  ctx.domain.recordOneDomainEvent({
    eventType: "run.started", actor: "one", entityId: runB, taskId: terminal.task.id, version: 1, visibility: "personal",
    entries: [{ name: "runId", value: runB }, { name: "policyVersion", value: "agentlas-one-runtime-v1" }],
  });
  const acceptedB = acceptRun(ctx, terminal, terminalPartial, runB);
  assert.equal(ctx.artifacts.issueOneArtifactPreviewCapability({ ...terminalRequest, taskVersion: acceptedB.version }), null,
    "run B acceptance must not re-authorize run A bytes");

  const acceptedImage = path.join(workspace, "accepted.png");
  fs.writeFileSync(acceptedImage, PNG_BYTES);
  const acceptedSame = createBoundSurface(ctx, {
    title: "Same-run acceptance",
    workspace,
    runId: "run_artifact_accepted_same",
    rows: [{ path: acceptedImage, mediaType: "image", label: "Accepted", provenance: "uploaded" }],
  });
  const acceptedPartial = finishRun(ctx, acceptedSame);
  const acceptedTask = acceptRun(ctx, acceptedSame, acceptedPartial);
  const acceptedRequest = { ...requestFor(acceptedSame), taskVersion: acceptedTask.version };
  const acceptedCapability = ctx.artifacts.issueOneArtifactPreviewCapability(acceptedRequest);
  assert.ok(acceptedCapability, "same-run explicit acceptance evidence must retain exact preview authority");
  const wrongRevoke = ctx.artifacts.revokeOneArtifactPreview({ ...acceptedRequest, artifactRef: "artifact_forged_123", capabilityUrl: acceptedCapability.capabilityUrl });
  assert.equal(wrongRevoke, false);
  assert.equal(ctx.artifacts.revokeOneArtifactPreview({ ...acceptedRequest, capabilityUrl: acceptedCapability.capabilityUrl }), true);
  assert.equal(ctx.artifacts.serveOneArtifactProtocolRequest(acceptedCapability.capabilityUrl, null).status, 404);

  const durableLeaks = db.prepare("SELECT payload_json FROM run_events").all().map((row) => row.payload_json).join("\n");
  const messageLeaks = db.prepare("SELECT text FROM chat_messages").all().map((row) => row.text).join("\n");
  assert.equal(durableLeaks.includes(base), false, "run events must not contain local source paths");
  assert.equal(messageLeaks.includes(base), false, "chat messages must not contain local source paths");
  const privateRows = db.prepare("SELECT source_path FROM one_artifact_bindings").all();
  assert.ok(privateRows.some((row) => row.source_path === video), "only the Main-private binding table retains canonical paths");

  console.log(JSON.stringify({
    ok: true,
    actualImageBytes: true,
    exactOfficeFiles: true,
    exactBinding: true,
    range: true,
    forgedExpiredRevoked: true,
    replacementSymlinkArchiveRemoteRejected: true,
    crossRunAcceptanceRejected: true,
    unknownProvenanceHonest: true,
  }));
  db.close();
  app.quit();
}

async function prepareRestartWorker() {
  const { app, db } = await openStore();
  const base = argument("--base");
  const infoFile = argument("--info");
  if (!base || !infoFile) throw new Error("restart prepare requires --base and --info");
  const workspace = fs.realpathSync.native(fs.mkdirSync(path.join(base, "workspace"), { recursive: true }) || path.join(base, "workspace"));
  const image = path.join(workspace, "restart.png");
  fs.writeFileSync(image, PNG_BYTES);
  const ctx = contextModules();
  const value = createBoundSurface(ctx, {
    title: "Restart reissue",
    workspace,
    runId: "run_artifact_restart",
    rows: [{ path: image, mediaType: "image", label: "Restart" }],
  });
  assert.equal(value.bound, 1);
  fs.writeFileSync(infoFile, JSON.stringify({ request: requestFor(value), image }));
  console.log(JSON.stringify({ ok: true, durableBindingPrepared: true }));
  db.close();
  app.quit();
}

async function probeRestartWorker() {
  const { app, db } = await openStore();
  const info = JSON.parse(fs.readFileSync(argument("--info"), "utf8"));
  const artifacts = require("../dist/electron/one/artifact-preview.js");
  const first = artifacts.issueOneArtifactPreviewCapability(info.request);
  assert.ok(first, "a fresh Main process must reissue from the exact durable binding");
  assert.deepEqual(await bodyBytes(artifacts.serveOneArtifactProtocolRequest(first.capabilityUrl, null)), PNG_BYTES);
  artifacts.resetOneArtifactPreviewCapabilitiesForTests();
  assert.equal(artifacts.serveOneArtifactProtocolRequest(first.capabilityUrl, null).status, 404, "old process token must die on restart/reset");
  const second = artifacts.issueOneArtifactPreviewCapability(info.request);
  assert.ok(second);
  assert.notEqual(second.capabilityUrl, first.capabilityUrl);
  console.log(JSON.stringify({ ok: true, restartReissue: true, staleTokenRejected: true }));
  db.close();
  app.quit();
}

function runWorker(args, env) {
  const executable = process.versions.electron ? process.execPath : require("electron");
  return spawnSync(executable, [__filename, ...args], { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
}

function orchestrate() {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-one-artifacts-")));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const userData = path.join(temp, "user-data");
  try {
    env.AGENTLAS_STORE_PATH = path.join(temp, "runtime.sqlite");
    const runtime = runWorker(["--runtime", `--base=${path.join(temp, "runtime")}`, `--user-data=${userData}`], env);
    if (runtime.status !== 0) throw new Error(`runtime worker failed\n${runtime.stdout}\n${runtime.stderr}`);
    process.stdout.write(runtime.stdout);

    env.AGENTLAS_STORE_PATH = path.join(temp, "restart.sqlite");
    const info = path.join(temp, "restart-info.json");
    const prepared = runWorker(["--prepare-restart", `--base=${path.join(temp, "restart")}`, `--info=${info}`, `--user-data=${userData}`], env);
    if (prepared.status !== 0) throw new Error(`restart prepare failed\n${prepared.stdout}\n${prepared.stderr}`);
    process.stdout.write(prepared.stdout);
    const probed = runWorker(["--probe-restart", `--info=${info}`, `--user-data=${userData}`], env);
    if (probed.status !== 0) throw new Error(`restart probe failed\n${probed.stdout}\n${probed.stderr}`);
    process.stdout.write(probed.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv.includes("--runtime")) {
  runtimeWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--prepare-restart")) {
  prepareRestartWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else if (process.argv.includes("--probe-restart")) {
  probeRestartWorker().then(() => process.exit(0)).catch((error) => { console.error(error); process.exit(1); });
} else {
  try {
    orchestrate();
    process.exit(0);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
}
