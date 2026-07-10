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

  store.updateSiteScreenHtml(project.id, s1.id, DOC_A.replace("랜딩", "새 랜딩"));
  assert.ok(store.readSiteScreenHtml(project.id, s1.id).includes("새 랜딩"), "update must rewrite the file");
  store.renameSiteScreen(project.id, s1.id, "메인 랜딩");
  assert.equal(store.getSiteProject(project.id).screens[0].name, "메인 랜딩");

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
