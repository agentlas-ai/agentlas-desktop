#!/usr/bin/env node
// electron-builder(25.x)는 dmg+zip을 모두 빌드해도 latest-mac.yml의 path/files를
// .dmg로 써버린다. macOS 자동업데이트(Squirrel.Mac)는 .zip만 적용 가능하므로,
// 빌드 직후 latest-mac.yml을 zip 기준으로 재작성한다. (없으면 "ZIP file not provided")
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const files = [];
for (const arch of ["arm64", "x64"]) {
  const f = join(releaseDir, `Agentlas-${version}-${arch}.zip`);
  if (!existsSync(f)) continue;
  const buf = readFileSync(f);
  files.push({
    url: `Agentlas-${version}-${arch}.zip`,
    sha512: createHash("sha512").update(buf).digest("base64"),
    size: buf.length,
  });
}

if (files.length === 0) {
  console.log("[fix-mac-latest-zip] no zip artifacts found — leaving latest-mac.yml as-is");
  process.exit(0);
}

const primary = files[0]; // arm64 우선
const yml =
  [
    `version: ${version}`,
    "files:",
    ...files.flatMap((f) => [`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${primary.url}`,
    `sha512: ${primary.sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
  ].join("\n") + "\n";

const latestMacPath = join(releaseDir, "latest-mac.yml");
writeFileSync(latestMacPath, yml, "utf8");
stampUpdateCompatibilityFile(latestMacPath, join(root, "package.json"));
console.log(`[fix-mac-latest-zip] latest-mac.yml -> ${primary.url} (${files.length} zip entries)`);
