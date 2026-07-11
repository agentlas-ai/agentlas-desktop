#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-grok-runtime-"));
const fakeBin = path.join(temp, "grok-fake.cjs");
const capture = path.join(temp, "capture.json");

fs.writeFileSync(
  fakeBin,
  `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--version")) { console.log("grok 0.2.93"); process.exit(0); }
const promptAt = args.indexOf("--prompt-file");
const promptFile = promptAt >= 0 ? args[promptAt + 1] : "";
const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : "";
fs.writeFileSync(process.env.GROK_CAPTURE, JSON.stringify({ args, promptFile, prompt }));
console.log(JSON.stringify({ type: "thought", data: "PRIVATE_REASONING_MUST_NOT_SURFACE" }));
console.log(JSON.stringify({ type: "text", data: "hello " }));
console.log(JSON.stringify({ type: "text", data: "world" }));
console.log(JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "qa" }));
`,
  { mode: 0o755 },
);

process.env.AGENTLAS_GROK_BIN = fakeBin;
process.env.GROK_CAPTURE = capture;

(async () => {
  try {
    const { runGrok } = require("../dist/electron/runtime/grok.js");
    const partials = [];
    const statuses = [];
    const result = await runGrok(
      {
        systemPrompt: "SYSTEM CONTRACT",
        userPrompt: "USER REQUEST THAT MUST NOT APPEAR IN ARGV",
        history: [],
        locale: "en",
        permission: "write",
        backendLabel: "Grok CLI",
        cwd: temp,
        model: "grok-test-model",
        effort: "high",
      },
      {
        onStatus: (value) => statuses.push(value),
        onPartial: (value) => partials.push(value),
      },
    );

    assert.equal(result.text, "hello world");
    assert.equal(statuses.join("\n").includes("PRIVATE_REASONING_MUST_NOT_SURFACE"), false);
    assert.equal(partials.join("\n").includes("PRIVATE_REASONING_MUST_NOT_SURFACE"), false);

    const recorded = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.deepEqual(recorded.args.slice(0, 2), ["--prompt-file", recorded.promptFile]);
    assert.ok(recorded.args.includes("--cwd"));
    assert.ok(recorded.args.includes("streaming-json"));
    assert.ok(recorded.args.includes("--no-subagents"));
    assert.ok(recorded.args.includes("acceptEdits"));
    assert.ok(recorded.args.includes("grok-test-model"));
    assert.ok(recorded.args.includes("high"));
    assert.equal(recorded.args.join(" ").includes("USER REQUEST"), false, "prompt content must stay out of argv");
    assert.match(recorded.prompt, /SYSTEM CONTRACT/);
    assert.match(recorded.prompt, /USER REQUEST THAT MUST NOT APPEAR IN ARGV/);

    await waitFor(() => !fs.existsSync(recorded.promptFile), 2_000);
    console.log("Official xAI Grok runtime headless contract passed");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);

async function waitFor(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("temporary Grok prompt file was not removed");
}
