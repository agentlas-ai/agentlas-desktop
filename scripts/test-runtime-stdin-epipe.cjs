#!/usr/bin/env node
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");

const { writeStdin } = require("../dist/electron/runtime/exec.js");

async function main() {
  const unexpected = [];
  const onUncaught = (error) => unexpected.push(error);
  process.on("uncaughtException", onUncaught);

  try {
    for (let i = 0; i < 24; i += 1) {
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      writeStdin(child, "x".repeat(2 * 1024 * 1024));
      await Promise.race([
        once(child, "close"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("child close timeout")), 5_000)),
      ]);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(unexpected, [], "a child closing stdin early must not surface an uncaught EPIPE");

    const documentSource = fs.readFileSync(require.resolve("../dist/electron/document/generate.js"), "utf8");
    const trexSource = fs.readFileSync(require.resolve("../dist/electron/trex/content.js"), "utf8");
    assert.match(documentSource, /writeStdin\)\(child, prompt\)/);
    assert.match(trexSource, /writeStdin\)\(child, prompt\)/);
    console.log("runtime stdin early-close/EPIPE contract ok");
  } finally {
    process.removeListener("uncaughtException", onUncaught);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
