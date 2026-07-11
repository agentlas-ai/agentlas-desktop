#!/usr/bin/env node
// 사이트 스튜디오 M2/M5 게이트 — 프로젝트/화면 영속 + ZIP 아카이브. electron 바이너리로 실행.
// (`npm run build:electron && electron scripts/test-site-studio-store.cjs`)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-store-"));
app.setPath("userData", path.join(tempDir, "user-data"));

const store = require("../dist/electron/site/store.js");
const { buildZipArchive } = require("../dist/electron/site/zip-writer.js");
const { activeSiteProjectOperation, assertSiteProjectIdle, tryAcquireSiteProjectOperation } = require("../dist/electron/site/operation-lock.js");

const DOC_A = "<!doctype html><html><head><title>a</title></head><body><h1>랜딩</h1></body></html>";
const DOC_B = "<!doctype html><html><head><title>b</title></head><body><h1>로그인</h1></body></html>";

let exitCode = 0;
try {
  // ── 프로젝트/화면 CRUD ───────────────────────────────────
  assert.deepEqual(store.listSiteProjects(), [], "fresh userData → no projects");
  const project = store.createSiteProject("테스트 사이트");
  assert.equal(store.listSiteProjects().length, 1);

  const s1 = store.saveSiteScreen({ projectId: project.id, name: "랜딩", html: DOC_A });
  const s2 = store.saveSiteScreen({ projectId: project.id, name: "로그인 A", html: DOC_B, variantGroup: "g1", variantLabel: "A" });
  const meta = store.getSiteProject(project.id);
  assert.equal(meta.screens.length, 2, "screens must persist in project.json");
  assert.equal(meta.screens[1].variantLabel, "A", "variant metadata must persist");
  assert.equal(store.readSiteScreenHtml(project.id, s1.id), DOC_A, "screen html must round-trip");

  // ── 사람이 읽는 Site Copilot 대화 영속 ────────────────────
  assert.deepEqual(store.listSiteConversation(project.id), [], "new project must start with an empty visible conversation");
  const userTurn = store.appendSiteConversation({
    projectId: project.id,
    role: "user",
    text: "버튼을 더 신뢰감 있게 바꿔줘",
    context: ".hero .cta",
  });
  const assistantTurn = store.appendSiteConversation({
    projectId: project.id,
    role: "assistant",
    text: "CTA의 대비와 여백을 높이고, 나머지 레이아웃은 유지했습니다.",
  });
  const restoredConversation = store.listSiteConversation(project.id);
  assert.deepEqual(
    restoredConversation.map((entry) => entry.id),
    [userTurn.id, assistantTurn.id],
    "visible Site Copilot turns must survive a renderer restart",
  );
  assert.equal(restoredConversation[0].context, ".hero .cta", "selected-element context must persist with the user turn");

  const conversationFile = path.join(app.getPath("userData"), "site-projects", project.id, "conversation.json");
  const durableConversation = fs.readFileSync(conversationFile, "utf8");
  fs.writeFileSync(conversationFile, "{broken-json", "utf8");
  assert.throws(() => store.listSiteConversation(project.id), /손상|preserv/i, "malformed conversation data must be surfaced, not treated as empty");
  assert.throws(
    () => store.appendSiteConversation({ projectId: project.id, role: "user", text: "do not overwrite" }),
    /손상|preserv/i,
    "append must refuse to overwrite a damaged transcript",
  );
  assert.equal(fs.readFileSync(conversationFile, "utf8"), "{broken-json", "a damaged transcript must remain byte-identical");
  fs.writeFileSync(conversationFile, durableConversation, "utf8");

  const beforeRenameFailure = fs.readFileSync(conversationFile, "utf8");
  const originalRenameSync = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === conversationFile) throw new Error("injected conversation rename failure");
    return originalRenameSync(from, to);
  };
  try {
    assert.throws(
      () => store.appendSiteConversation({ projectId: project.id, role: "assistant", text: "must stay staged" }),
      /injected conversation rename failure/,
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(fs.readFileSync(conversationFile, "utf8"), beforeRenameFailure, "failed atomic replace must preserve the old transcript");
  assert.equal(
    fs.readdirSync(path.dirname(conversationFile)).filter((name) => /^\.conversation\.json\..+\.tmp$/.test(name)).length,
    0,
    "failed atomic replace must clean its staging file",
  );

  store.updateSiteScreenHtml(project.id, s1.id, DOC_A.replace("랜딩", "새 랜딩"));
  assert.ok(store.readSiteScreenHtml(project.id, s1.id).includes("새 랜딩"), "update must rewrite the file");
  store.renameSiteScreen(project.id, s1.id, "메인 랜딩");
  assert.equal(store.getSiteProject(project.id).screens[0].name, "메인 랜딩");

  // Renderer 상태를 우회해도 같은 프로젝트의 generate/edit/handoff가 겹치지 않는다.
  const releaseGenerate = tryAcquireSiteProjectOperation(project.id, "generate");
  assert.equal(typeof releaseGenerate, "function", "first Site operation must acquire the project lease");
  assert.equal(activeSiteProjectOperation(project.id), "generate");
  assert.throws(() => assertSiteProjectIdle(project.id), /site-project-busy/, "destructive Site mutations must reject an active project");
  assert.equal(tryAcquireSiteProjectOperation(project.id, "edit"), null, "parallel edit must fail closed while generate owns the project");
  assert.equal(tryAcquireSiteProjectOperation(project.id, "handoff"), null, "parallel handoff must fail closed while generate owns the project");
  releaseGenerate();
  releaseGenerate(); // idempotent cleanup
  const releaseEdit = tryAcquireSiteProjectOperation(project.id, "edit");
  assert.equal(typeof releaseEdit, "function", "project lease must be reusable after terminal cleanup");
  releaseEdit();
  assert.equal(activeSiteProjectOperation(project.id), null);
  assert.doesNotThrow(() => assertSiteProjectIdle(project.id));

  const sitePageSource = fs.readFileSync(path.join(__dirname, "..", "renderer/app/(shell)/site/page.tsx"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "electron/preload.ts"), "utf8");
  assert.match(preloadSource, /operationStatus:[\s\S]{0,100}site:operationStatus/, "preload must expose the main-owned Site mutex state");
  assert.match(sitePageSource, /site\?\.operationStatus/, "Site remount must query the main-owned project operation");
  assert.match(sitePageSource, /remoteOperation !== null/, "restored main activity must keep destructive controls disabled");
  assert.match(sitePageSource, /화면을 삭제하지 못했습니다|Could not delete the screen/, "main busy rejection must be visible instead of unhandled");
  assert.match(sitePageSource, /프로젝트를 삭제하지 못했습니다|Could not delete the project/, "project busy rejection must be visible instead of unhandled");

  // 경로 탈출 방어 — id는 [a-zA-Z0-9-]만.
  assert.throws(() => store.readSiteScreenHtml(project.id, "../secret"), /잘못된 id/, "path traversal must throw");
  assert.throws(() => store.getSiteProject("../../etc"), /잘못된 id/, "project id must be sanitized");

  // ── ZIP 내보내기 ─────────────────────────────────────────
  const files = store.listSiteScreenFiles(project.id);
  assert.equal(files.length, 2, "zip listing must include every screen");
  const zip = buildZipArchive(files);
  // EOCD 시그니처 + 엔트리 수.
  const eocdAt = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocdAt >= 0, "zip must contain EOCD");
  assert.equal(zip.readUInt16LE(eocdAt + 10), 2, "EOCD entry count");
  // 첫 로컬 헤더를 직접 파싱해 payload를 inflate → 원본과 동일해야 한다.
  assert.equal(zip.readUInt32LE(0), 0x04034b50, "local header signature");
  const method = zip.readUInt16LE(8);
  const compSize = zip.readUInt32LE(18);
  const nameLen = zip.readUInt16LE(26);
  const extraLen = zip.readUInt16LE(28);
  const dataStart = 30 + nameLen + extraLen;
  const payload = zip.subarray(dataStart, dataStart + compSize);
  const restored = method === 8 ? zlib.inflateRawSync(payload) : payload;
  assert.equal(restored.toString("utf8"), files[0].data.toString("utf8"), "zip payload must round-trip");
  // 시스템 unzip으로 교차 검증(있을 때만).
  const zipPath = path.join(tempDir, "site.zip");
  fs.writeFileSync(zipPath, zip);
  try {
    const { execFileSync } = require("node:child_process");
    execFileSync("unzip", ["-t", zipPath], { stdio: "pipe" });
    console.log("zip cross-checked with system unzip");
  } catch (err) {
    if (err && err.code === "ENOENT") console.log("system unzip unavailable — skipped cross-check");
    else throw new Error(`system unzip rejected the archive: ${err}`);
  }

  // ── 삭제 ─────────────────────────────────────────────────
  store.deleteSiteScreen(project.id, s2.id);
  assert.equal(store.getSiteProject(project.id).screens.length, 1, "screen delete must persist");
  store.deleteSiteProject(project.id);
  assert.deepEqual(store.listSiteProjects(), [], "project delete must remove everything");

  console.log("site studio store + zip contract ok");
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  app.exit(exitCode);
}
