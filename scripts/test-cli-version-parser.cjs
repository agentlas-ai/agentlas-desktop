#!/usr/bin/env node
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { clearCliVersionProbeCache, parseCliVersionOutput, probeCliVersion } = require("../dist/electron/runtime/exec.js");
  assert.equal(parseCliVersionOutput("2.1.206 (Claude Code)"), "2.1.206");
  assert.equal(parseCliVersionOutput("codex-cli 0.144.1"), "0.144.1");
  assert.equal(parseCliVersionOutput("Gemini CLI 0.50.0"), "0.50.0");
  assert.equal(parseCliVersionOutput("grok 0.2.93 (Grok CLI) [stable]"), "0.2.93");
  assert.equal(parseCliVersionOutput("\u001b[32mGemini CLI v0.27.0-beta.1\u001b[0m"), "0.27.0-beta.1");
  assert.equal(parseCliVersionOutput("grok version v1.2.3+build.5"), "1.2.3+build.5");
  assert.equal(parseCliVersionOutput("Claude Code)"), null);
  assert.equal(parseCliVersionOutput(""), null);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-cli-version-"));
  try {
    const ext = process.platform === "win32" ? ".cmd" : "";
    const command = (name, posixBody, windowsBody) => {
      const target = path.join(temp, `${name}${ext}`);
      fs.writeFileSync(
        target,
        process.platform === "win32" ? `@echo off\r\n${windowsBody}\r\n` : `#!/bin/sh\n${posixBody}\n`,
        { mode: 0o755 },
      );
      return target;
    };
    const claude = command("claude", 'echo "2.1.206 (Claude Code)"', 'echo 2.1.206 ^(Claude Code^)');
    const stderrOnly = command("stderr-version", 'echo "codex-cli 0.144.1" >&2', '>&2 echo codex-cli 0.144.1');
    const stdoutFirst = command("stdout-first", 'echo "1.2.3"; echo "9.9.9" >&2', 'echo 1.2.3\r\n>&2 echo 9.9.9');
    const unknown = command("unknown-cli", 'echo "development build"', 'echo development build');
    const failing = command("failing-cli", 'echo "7.7.7"; exit 3', 'echo 7.7.7\r\nexit /b 3');
    const mutable = path.join(temp, `mutable${ext}`);
    const writeMutable = (version) => fs.writeFileSync(
      mutable,
      process.platform === "win32" ? `@echo off\r\necho ${version}\r\n` : `#!/bin/sh\necho "${version}"\n`,
      { mode: 0o755 },
    );

    assert.equal(await probeCliVersion(claude, 1_000), "2.1.206");
    assert.equal(await probeCliVersion(stderrOnly, 1_000), "0.144.1");
    assert.equal(await probeCliVersion(stdoutFirst, 1_000), "1.2.3");
    assert.equal(await probeCliVersion(unknown, 1_000), "unknown");
    assert.equal(await probeCliVersion(failing, 1_000), null);
    assert.equal(await probeCliVersion("\0", 100), null, "synchronous spawn failures must resolve null");

    writeMutable("3.4.5");
    assert.equal(await probeCliVersion(mutable, 1_000), "3.4.5");
    writeMutable("3.4.6");
    assert.equal(await probeCliVersion(mutable, 1_000), "3.4.5", "normal probes should reuse the short cache");
    clearCliVersionProbeCache();
    assert.equal(await probeCliVersion(mutable, 1_000), "3.4.6", "explicit checks must invalidate the probe cache");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log("test-cli-version-parser: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
