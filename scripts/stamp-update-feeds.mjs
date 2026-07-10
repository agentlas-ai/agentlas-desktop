#!/usr/bin/env node
import { createRequire } from "node:module";
import { existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const { stampUpdateCompatibilityFile } = require("../build-resources/update-compatibility.cjs");
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);
const releaseDir = resolve(root, String(args.get("--release-dir") || "release"));
const required = args.has("--require");

const files = existsSync(releaseDir)
  ? readdirSync(releaseDir)
      .filter((name) => /^latest(?:-[0-9A-Za-z._-]+)?\.yml$/.test(name))
      .map((name) => join(releaseDir, name))
      .sort()
  : [];

if (files.length === 0 && required) {
  console.error(`[stamp-update-feeds] no latest*.yml files in ${releaseDir}`);
  process.exit(1);
}
for (const file of files) stampUpdateCompatibilityFile(file, join(root, "package.json"));
console.log(JSON.stringify({ ok: true, releaseDir, stamped: files }, null, 2));
