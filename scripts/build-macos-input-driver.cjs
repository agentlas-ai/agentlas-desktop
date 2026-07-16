#!/usr/bin/env node
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

if (process.platform !== "darwin") {
  process.stdout.write("[computer-use] macOS input driver skipped on this platform.\n");
  process.exit(0);
}

const root = path.resolve(__dirname, "..");
const source = path.join(root, "native", "macos", "AgentlasInputDriver.swift");
const outputDir = path.join(root, "build-resources", "native", "macos");
const output = path.join(outputDir, "agentlas-input-driver");
fs.mkdirSync(outputDir, { recursive: true, mode: 0o755 });
const tempDir = fs.mkdtempSync(path.join(outputDir, ".build-"));

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

try {
  const swiftc = execFileSync("/usr/bin/xcrun", ["--find", "swiftc"], { encoding: "utf8" }).trim();
  const sdk = execFileSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"], { encoding: "utf8" }).trim();
  const arm64 = path.join(tempDir, "agentlas-input-driver-arm64");
  const x64 = path.join(tempDir, "agentlas-input-driver-x86_64");
  const common = ["-sdk", sdk, "-O", "-whole-module-optimization", "-framework", "AppKit", "-framework", "ApplicationServices"];

  run(swiftc, ["-target", "arm64-apple-macos12.0", ...common, source, "-o", arm64]);
  run(swiftc, ["-target", "x86_64-apple-macos12.0", ...common, source, "-o", x64]);
  run("/usr/bin/lipo", ["-create", arm64, x64, "-output", output]);
  fs.chmodSync(output, 0o755);
  const architectures = execFileSync("/usr/bin/lipo", ["-archs", output], { encoding: "utf8" }).trim();
  if (!architectures.includes("arm64") || !architectures.includes("x86_64")) {
    throw new Error(`unexpected driver architectures: ${architectures}`);
  }
  process.stdout.write(`[computer-use] built universal macOS input driver (${architectures}).\n`);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
