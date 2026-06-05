#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const version = String(args.get("--version") || pkg.version);
const repo = String(args.get("--repo") || process.env.AGENTLAS_DESKTOP_GITHUB_REPO || "agentlas-ai/agentlas-desktop");
const tag = String(args.get("--tag") || process.env.AGENTLAS_DESKTOP_RELEASE_TAG || `v${version}`);
const releaseDir = resolve(desktopRoot, String(args.get("--release-dir") || "release"));
const draft = args.has("--draft");

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: desktopRoot,
    stdio: options.stdio || "pipe",
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024 * 12,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed\n${output}`);
  }
  return output;
}

function requireFile(file) {
  if (!existsSync(file)) throw new Error(`Missing release artifact: ${file}`);
  return file;
}

function cleanupAppleDouble() {
  if (!existsSync(releaseDir)) return;
  run("find", [releaseDir, "-name", "._*", "-delete"]);
  if (process.platform === "darwin") {
    const dotClean = spawnSync("sh", ["-lc", "command -v dot_clean || test ! -x /usr/sbin/dot_clean || printf /usr/sbin/dot_clean"], {
      cwd: desktopRoot,
      encoding: "utf8",
      env: process.env,
    }).stdout.trim();
    if (dotClean) run(dotClean, ["-m", releaseDir]);
  }
}

run("node", ["scripts/verify-mac-release.mjs", "--write-env", `--repo=${repo}`, `--tag=${tag}`, `--version=${version}`]);
run("node", ["scripts/fix-mac-latest-zip.mjs"]);
cleanupAppleDouble();

const notesPath = join(releaseDir, "github-release-notes.md");
writeFileSync(
  notesPath,
  [
    `# Agentlas Desktop ${version}`,
    "",
    "Public macOS release.",
    "",
    "- Apple silicon and Intel DMGs are Developer ID signed, notarized, and Gatekeeper verified.",
    "- Installs approved Agentlas firms from agentlas.cloud.",
    "- Runs with user-selected BYOK APIs or local CLI runtimes.",
    "",
    "Checksums and file sizes are in `desktop-release-verification.json`.",
    "",
  ].join("\n"),
);
cleanupAppleDouble();

const files = [
  requireFile(join(releaseDir, `Agentlas-${version}-arm64.dmg`)),
  requireFile(join(releaseDir, `Agentlas-${version}-arm64.dmg.blockmap`)),
  requireFile(join(releaseDir, `Agentlas-${version}-arm64.zip`)),
  requireFile(join(releaseDir, `Agentlas-${version}-arm64.zip.blockmap`)),
  requireFile(join(releaseDir, `Agentlas-${version}-x64.dmg`)),
  requireFile(join(releaseDir, `Agentlas-${version}-x64.dmg.blockmap`)),
  requireFile(join(releaseDir, `Agentlas-${version}-x64.zip`)),
  requireFile(join(releaseDir, `Agentlas-${version}-x64.zip.blockmap`)),
  requireFile(join(releaseDir, "latest-mac.yml")),
  requireFile(join(releaseDir, "desktop-release-verification.json")),
  requireFile(join(releaseDir, "desktop-release.production.env")),
];

const releaseExists = spawnSync("gh", ["release", "view", tag, "--repo", repo], {
  cwd: desktopRoot,
  encoding: "utf8",
  env: process.env,
});

if (releaseExists.status === 0) {
  run("gh", ["release", "edit", tag, "--repo", repo, "--title", `Agentlas Desktop ${version}`, "--notes-file", notesPath]);
} else {
  const createArgs = ["release", "create", tag, "--repo", repo, "--title", `Agentlas Desktop ${version}`, "--notes-file", notesPath];
  if (draft) createArgs.push("--draft");
  run("gh", createArgs);
}

run("gh", ["release", "upload", tag, "--repo", repo, "--clobber", ...files], { stdio: "inherit" });
cleanupAppleDouble();
console.log(JSON.stringify({ ok: true, repo, tag, uploaded: files.map((file) => file.replace(`${releaseDir}/`, "")) }, null, 2));
