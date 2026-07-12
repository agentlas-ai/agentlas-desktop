#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-grok-imagine-"));
const fakeBin = path.join(temp, "fake-grok.cjs");
const authFile = path.join(temp, "auth.json");
const sessionsDir = path.join(temp, "sessions");
const workDir = path.join(temp, "work");

fs.mkdirSync(workDir, { recursive: true });
fs.writeFileSync(authFile, JSON.stringify({ qa: { auth_mode: "oidc", refresh_token: "qa-refresh", expires_at: "2000-01-01T00:00:00.000Z" } }), { mode: 0o600 });
fs.writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("grok 0.2.93"); process.exit(0); }
const arg = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : ""; };
const cwd = arg("--cwd");
const promptFile = arg("--prompt-file");
const prompt = fs.readFileSync(promptFile, "utf8");
const sessionId = arg("--session-id");
const kind = prompt.includes("Agentlas media job: generate the requested VIDEO") ? "video" : "image";
fs.writeFileSync(path.join(cwd, "capture-" + kind + ".json"), JSON.stringify({
  args, promptFile, prompt, promptMode: fs.statSync(promptFile).mode & 0o777,
  hasUnrelatedSecret: Boolean(process.env.UNRELATED_PROVIDER_SECRET),
}));
if (prompt.includes("HANG")) {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  fs.writeFileSync(path.join(cwd, "hang-pids.json"), JSON.stringify({ parent: process.pid, child: child.pid }));
  setInterval(() => {}, 1000);
  return;
}
const root = path.join(process.env.AGENTLAS_GROK_SESSIONS_DIR, encodeURIComponent(fs.realpathSync.native(cwd)), sessionId, kind === "image" ? "images" : "videos");
fs.mkdirSync(root, { recursive: true });
if (prompt.includes("CORRUPT")) {
  fs.writeFileSync(path.join(root, kind === "image" ? "1.jpg" : "1.mp4"), Buffer.alloc(64));
} else if (kind === "image") {
  fs.writeFileSync(path.join(root, "1.jpg"), Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(64, 1)]));
} else {
  const media = Buffer.alloc(68, 1); Buffer.from("ftyp").copy(media, 4); fs.writeFileSync(path.join(root, "1.mp4"), media);
}
`,
  { mode: 0o755 },
);

process.env.AGENTLAS_GROK_BIN = fakeBin;
process.env.AGENTLAS_GROK_AUTH_FILE = authFile;
process.env.AGENTLAS_GROK_SESSIONS_DIR = sessionsDir;
process.env.UNRELATED_PROVIDER_SECRET = "must-not-reach-child";

(async () => {
  try {
    const { runGrokImagine } = require("../dist/electron/multimodal/grok-imagine.js");

    const imageTarget = path.join(workDir, "result.jpg");
    assert.equal(await runGrokImagine({ prompt: "SAFE IMAGE", cwd: workDir, kind: "image", targetPath: imageTarget }), imageTarget);
    assert.equal(fs.existsSync(imageTarget), true);
    assertContract("image", "SAFE IMAGE");

    const videoTarget = path.join(workDir, "result.mp4");
    assert.equal(await runGrokImagine({ prompt: "SAFE VIDEO", cwd: workDir, kind: "video", targetPath: videoTarget }), videoTarget);
    assert.equal(fs.readFileSync(videoTarget).subarray(4, 8).toString("ascii"), "ftyp");
    assertContract("video", "SAFE VIDEO");

    const corruptTarget = path.join(workDir, "corrupt.jpg");
    assert.equal(await runGrokImagine({ prompt: "CORRUPT", cwd: workDir, kind: "image", targetPath: corruptTarget }), null);
    assert.equal(fs.existsSync(corruptTarget), false, "corrupt media must not be promoted");

    const hangTarget = path.join(workDir, "hang.jpg");
    assert.equal(await runGrokImagine({ prompt: "HANG", cwd: workDir, kind: "image", targetPath: hangTarget, timeoutMs: 120 }), null);
    const pids = JSON.parse(fs.readFileSync(path.join(workDir, "hang-pids.json"), "utf8"));
    await waitFor(() => !isAlive(pids.parent) && !isAlive(pids.child), 3_000, "timeout must kill the Grok process tree");

    assert.equal(countSessionDirs(sessionsDir), 0, "completed/failed sessions must be removed after promotion");
    console.log("Grok Imagine media-only security contract passed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().then(
  () => process.exit(0),
  (error) => { console.error(error); process.exit(1); },
);

function assertContract(kind, prompt) {
  const row = JSON.parse(fs.readFileSync(path.join(workDir, `capture-${kind}.json`), "utf8"));
  assert.match(row.prompt, new RegExp(`${kind === "image" ? "IMAGE" : "VIDEO"}.*${prompt}`, "s"));
  assert.equal(row.promptMode, 0o600);
  assert.equal(row.args.includes("-p"), false);
  assert.equal(row.args.includes("--single"), false);
  assert.equal(row.args.includes("--prompt-file"), true);
  assert.equal(row.args.includes("--always-approve"), true);
  assert.equal(row.args.includes("--no-memory"), true);
  assert.equal(row.args.includes("--no-subagents"), true);
  assert.equal(row.args.includes("--tools"), false, "broken Grok 0.2.93 tool allowlist must not be used");
  assert.equal(row.args[row.args.indexOf("--sandbox") + 1], "strict");
  assert.equal(row.args[row.args.indexOf("--disallowed-tools") + 1], "search_replace,web_search,web_fetch");
  assert.equal(row.args.filter((value) => value === "--deny").length, 3);
  assert.equal(row.args.includes("Bash"), true);
  assert.equal(row.args.includes("Edit"), true);
  assert.equal(row.args.includes("Write"), true);
  assert.equal(row.args.join(" ").includes(prompt), false, "prompt must stay out of argv");
  assert.equal(row.hasUnrelatedSecret, false, "unrelated secrets must not reach media child env");
  assert.equal(fs.existsSync(row.promptFile), false, "prompt file must be removed after execution");
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(check, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(message);
}

function countSessionDirs(root) {
  if (!fs.existsSync(root)) return 0;
  let count = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const next = path.join(dir, entry.name);
      if (/^[0-9a-f-]{36}$/i.test(entry.name)) count += 1;
      else stack.push(next);
    }
  }
  return count;
}
