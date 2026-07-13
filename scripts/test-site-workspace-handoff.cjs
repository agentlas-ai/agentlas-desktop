#!/usr/bin/env node
// Site Studio → Build 작업공간 handoff 계약. Electron userData 스토어와 실제
// 임시 워크스페이스를 사용해 리비전/피드백/심볼릭링크 방어를 검증한다.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-site-handoff-"));
app.setPath("userData", path.join(tempDir, "user-data"));

const store = require("../dist/electron/site/store.js");
const { handoffSiteProjectToWorkspace } = require("../dist/electron/site/workspace-handoff.js");

let exitCode = 0;
try {
  const project = store.createSiteProject("Atlas Console");
  const landing = store.saveSiteScreen({
    projectId: project.id,
    name: "Landing",
    html: "<!doctype html><html><body><main><h1>Atlas</h1></main></body></html>",
  });
  const settings = store.saveSiteScreen({
    projectId: project.id,
    name: "Settings A",
    html: "<!doctype html><html><body><main><h1>Settings</h1></main></body></html>",
    variantGroup: "settings",
    variantLabel: "A",
  });
  store.appendSiteConversation({ projectId: project.id, role: "user", text: "CTA를 더 선명하게", context: ".hero .cta" });
  store.appendSiteConversation({ projectId: project.id, role: "assistant", text: "대비와 여백을 높였습니다." });

  const workspace = path.join(tempDir, "workspace");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "existing.txt"), "must stay intact");
  const handoff = handoffSiteProjectToWorkspace({ projectId: project.id, workspacePath: workspace, locale: "ko" });
  const handoffDir = path.join(workspace, ...handoff.relativePath.split("/"));

  assert.equal(handoff.screenCount, 2, "every screen must be included");
  assert.ok(handoff.relativePath.startsWith(".agentlas/site-designs/"), "handoff stays under the workspace metadata folder");
  assert.ok(handoff.buildPrompt.includes(handoff.relativePath), "Build prompt must point to the exact design revision");
  assert.equal(fs.readFileSync(path.join(workspace, "existing.txt"), "utf8"), "must stay intact", "handoff must not touch unrelated files");
  assert.equal(fs.readFileSync(path.join(handoffDir, "screens", `01-${landing.id}.html`), "utf8").includes("Atlas"), true);
  assert.equal(fs.readFileSync(path.join(handoffDir, "screens", `02-${settings.id}.html`), "utf8").includes("Settings"), true);
  const manifest = JSON.parse(fs.readFileSync(path.join(handoffDir, "manifest.json"), "utf8"));
  assert.equal(manifest.screens[1].variantLabel, "A", "screen variant metadata must be carried over");
  const feedback = fs.readFileSync(path.join(handoffDir, "feedback.md"), "utf8");
  assert.ok(feedback.includes("CTA를 더 선명하게") && feedback.includes(".hero .cta"), "visible conversation and selected context must be carried over");
  assert.ok(fs.readFileSync(path.join(handoffDir, "README.md"), "utf8").includes("시각 기준"), "handoff guide must explain how Build uses the design");

  const agentAppProject = store.createSiteProject({
    name: "Research Agent App",
    surface: "agent-app",
    agentAppTarget: {
      kind: "agent",
      id: "agent-123",
      name: "Research Agent",
      description: "Creates cited briefs",
      memberCount: 1,
    },
    astryxTemplate: "ai-chat-landing",
    agentAppContract: {
      schemaVersion: 1,
      source: "declared-package",
      inputs: [{ name: "topic", type: "string", label: "Research topic", description: "Question", required: true, format: "textarea", options: [], defaultValue: null }],
      outputs: [{ name: "brief", label: "Cited brief", type: "markdown", description: "Findings" }],
    },
  });
  store.saveSiteScreen({
    projectId: agentAppProject.id,
    name: "Workspace",
    html: "<!doctype html><html><body data-astryx-template=\"ai-chat-landing\"><main><h1>Research Agent</h1></main></body></html>",
  });
  const agentAppHandoff = handoffSiteProjectToWorkspace({ projectId: agentAppProject.id, workspacePath: workspace, locale: "en" });
  const agentAppDir = path.join(workspace, ...agentAppHandoff.relativePath.split("/"));
  const agentManifest = JSON.parse(fs.readFileSync(path.join(agentAppDir, "manifest.json"), "utf8"));
  assert.equal(agentManifest.surface, "agent-app");
  assert.equal(agentManifest.astryxTemplate, "ai-chat-landing");
  assert.deepEqual(agentManifest.agentAppContract.inputs.map((field) => field.name), ["topic"]);
  assert.deepEqual(agentManifest.agentAppContract.outputs.map((field) => field.name), ["brief"]);
  assert.equal(agentManifest.agentAppContract.source, "declared-package");
  assert.equal(agentManifest.agentAppVisual.colorMode, "light");
  assert.equal(agentManifest.agentAppVisual.accent, "teal");
  assert.match(agentAppHandoff.buildPrompt, /@astryxdesign\/core@0\.1\.4/);
  assert.match(fs.readFileSync(path.join(agentAppDir, "README.md"), "utf8"), /launch-scoped Agentlas capability[\s\S]*same-origin server API/);
  assert.match(fs.readFileSync(path.join(agentAppDir, "THIRD_PARTY_NOTICES.md"), "utf8"), /Meta Platforms, Inc/);

  // 이전 리비전을 수정하지 않고 새 리비전을 만든다.
  const second = handoffSiteProjectToWorkspace({ projectId: project.id, workspacePath: workspace, locale: "ko" });
  assert.notEqual(second.relativePath, handoff.relativePath, "each handoff must create an immutable revision");

  // 중간 파일 write가 실패해도 final 또는 hidden staging 리비전이 남지 않는다.
  const revisionsDir = path.join(workspace, ".agentlas", "site-designs", project.id, "revisions");
  const revisionsBeforeFailure = fs.readdirSync(revisionsDir).sort();
  const originalWriteFileSync = fs.writeFileSync;
  let writes = 0;
  fs.writeFileSync = function injectedHandoffFailure(...args) {
    writes += 1;
    if (writes === 2) throw new Error("injected handoff write failure");
    return originalWriteFileSync.apply(this, args);
  };
  try {
    assert.throws(
      () => handoffSiteProjectToWorkspace({ projectId: project.id, workspacePath: workspace, locale: "ko" }),
      /injected handoff write failure/,
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.deepEqual(fs.readdirSync(revisionsDir).sort(), revisionsBeforeFailure, "failed handoff must publish no partial revision");
  assert.equal(fs.readdirSync(revisionsDir).some((name) => name.includes(".tmp-")), false, "failed handoff must clean hidden staging directories");

  // 악성/우연한 symlink를 따라 워크스페이스 밖으로 쓰면 안 된다.
  const guardedWorkspace = path.join(tempDir, "guarded-workspace");
  const outside = path.join(tempDir, "outside");
  fs.mkdirSync(guardedWorkspace);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(guardedWorkspace, ".agentlas"));
  assert.throws(
    () => handoffSiteProjectToWorkspace({ projectId: project.id, workspacePath: guardedWorkspace, locale: "ko" }),
    /심볼릭 링크/,
    "handoff must reject a symlinked metadata root",
  );
  assert.deepEqual(fs.readdirSync(outside), [], "symlink target must never receive handoff files");

  console.log("site workspace handoff contract ok");
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
  app.exit(exitCode);
}
