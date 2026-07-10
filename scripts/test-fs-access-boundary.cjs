#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app } = require("electron");

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-fs-boundary-"));
  const userData = path.join(temp, "user-data");
  const workspace = path.join(temp, "workspace");
  const outside = path.join(temp, "outside");
  const generated = path.join(userData, "generated-assets");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(generated, { recursive: true });
  app.setPath("userData", userData);
  process.env.AGENTLAS_STORE_PATH = path.join(userData, "test.sqlite");
  process.env.AGENTLAS_FS_GRANT_STORE = path.join(userData, "test-grants.json");

  const insideText = path.join(workspace, "inside.md");
  const siblingText = path.join(outside, "sibling.md");
  const insideMedia = path.join(workspace, "inside.png");
  const outsideMedia = path.join(outside, "outside.png");
  const generatedMedia = path.join(generated, "generated.png");
  fs.writeFileSync(insideText, "inside\n");
  fs.writeFileSync(siblingText, "outside\n");
  fs.writeFileSync(insideMedia, "not-a-real-png");
  fs.writeFileSync(outsideMedia, "not-a-real-png");
  fs.writeFileSync(generatedMedia, "not-a-real-png");

  const access = require("../dist/electron/fs/access.js");
  const workspaceFs = require("../dist/electron/fs/workspace.js");
  const store = require("../dist/electron/store/db.js");
  store.initStore();
  const db = store.getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO installed_agents
      (id, slug, name, tagline, system_prompt, mcp_servers_json, preferred_backend, trust_grade, installed_at, tone)
     VALUES (?, ?, ?, ?, '', '[]', NULL, 'local', ?, 'neutral')`,
  ).run("agent-test", "agent-test", "Agent Test", "test", now);
  db.prepare(
    `INSERT INTO chats (id, agent_id, title, created_at, updated_at, working_folder)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run("chat-test", "agent-test", "test", now, now, fs.realpathSync(workspace));

  const durable = access.grantPath(workspace, { durable: true });
  assert.equal(durable.kind, "directory");
  assert.equal(access.resolveFsReadPath(insideText, durable.scope), fs.realpathSync(insideText));
  await workspaceFs.listDirectory(workspace, durable.scope, true);
  const preview = await workspaceFs.readTextFilePreview(insideText, durable.scope);
  assert.equal(preview.content, "inside\n");

  assert.throws(
    () => access.resolveFsReadPath(insideText, undefined),
    /approved scope/,
    "missing scope must fail closed",
  );
  await assert.rejects(
    workspaceFs.listDirectory(workspace, undefined, true),
    /approved scope/,
    "the public list API must not retain an unscoped overload",
  );
  await assert.rejects(
    workspaceFs.readTextFilePreview(insideText, undefined),
    /approved scope/,
    "the public preview API must not retain an unscoped overload",
  );
  assert.throws(
    () => access.resolveFsReadPath(insideText, { kind: "capability", token: "00000000-0000-4000-8000-000000000000" }),
    /approved scope/,
    "forged capability must fail",
  );
  assert.throws(
    () => access.resolveFsReadPath(siblingText, durable.scope),
    /approved scope/,
    "sibling escape must fail",
  );

  const directLink = path.join(workspace, "direct-link.md");
  const linkedDir = path.join(workspace, "linked-dir");
  fs.symlinkSync(siblingText, directLink);
  fs.symlinkSync(outside, linkedDir, "dir");
  assert.throws(
    () => access.resolveFsReadPath(directLink, durable.scope),
    /Symbolic links/,
    "direct symlink must fail",
  );
  assert.throws(
    () => access.resolveFsReadPath(path.join(linkedDir, "sibling.md"), durable.scope),
    /approved scope/,
    "ancestor symlink escape must fail after realpath",
  );

  const replaceable = path.join(temp, "replaceable-root");
  const movedReplaceable = path.join(temp, "moved-replaceable-root");
  fs.mkdirSync(replaceable);
  fs.writeFileSync(path.join(replaceable, "before.md"), "before\n");
  const replaceableGrant = access.grantPath(replaceable, { durable: true });
  fs.renameSync(replaceable, movedReplaceable);
  fs.symlinkSync(outside, replaceable, "dir");
  assert.throws(
    () => access.resolveFsReadPath(path.join(replaceable, "sibling.md"), replaceableGrant.scope),
    /approved scope/,
    "replacing an approved root with a symlink must not retarget the capability",
  );

  const exact = access.grantDroppedPath(insideText);
  assert.equal(exact.durable, false);
  assert.equal(exact.kind, "file");
  assert.equal(access.resolveFsReadPath(insideText, exact.scope), fs.realpathSync(insideText));
  assert.throws(
    () => access.pathFromGrant(exact, "directory"),
    /does not match/,
    "an exact-file drop grant must not become a durable workspace root",
  );
  assert.throws(
    () => access.resolveFsReadPath(insideMedia, exact.scope),
    /approved scope/,
    "drop grant must authorize only the exact file",
  );

  access.resetFsAccessForTests();
  assert.equal(
    access.resolveFsReadPath(insideText, durable.scope),
    fs.realpathSync(insideText),
    "durable native-picker capability must survive registry reload",
  );
  assert.throws(
    () => access.resolveFsReadPath(insideText, exact.scope),
    /approved scope/,
    "non-durable drop capability must not survive registry reload",
  );

  assert.equal(access.authorizeLocalMediaPath(generatedMedia), fs.realpathSync(generatedMedia));
  assert.equal(access.authorizeLocalMediaPath(insideMedia), fs.realpathSync(insideMedia));
  assert.equal(access.authorizeLocalMediaPath(outsideMedia), null);
  assert.equal(access.authorizeLocalMediaPath(insideText), null, "non-media extension must fail");

  const mediaLink = path.join(workspace, "media-link.png");
  const mediaDirLink = path.join(workspace, "media-dir-link");
  fs.symlinkSync(outsideMedia, mediaLink);
  fs.symlinkSync(outside, mediaDirLink, "dir");
  assert.equal(access.authorizeLocalMediaPath(mediaLink), null, "localfile direct symlink must fail");
  assert.equal(
    access.authorizeLocalMediaPath(path.join(mediaDirLink, "outside.png")),
    null,
    "localfile ancestor symlink escape must fail",
  );

  const pickerOnly = path.join(temp, "picker-only");
  const pickerOnlyMedia = path.join(pickerOnly, "private.png");
  fs.mkdirSync(pickerOnly);
  fs.writeFileSync(pickerOnlyMedia, "not-a-real-png");
  access.grantPath(pickerOnly, { durable: true });
  assert.equal(
    access.authorizeLocalMediaPath(pickerOnlyMedia),
    null,
    "a generic picker grant must not silently become localfile serving authority",
  );

  console.log("fs access boundary: all adversarial checks passed");
  fs.rmSync(temp, { recursive: true, force: true });
}

app.whenReady().then(() => main().then(() => app.quit())).catch((error) => {
  console.error(error);
  app.exit(1);
});
