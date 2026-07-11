#!/usr/bin/env node
// 빌드 전 임베딩 엔진(Hephaestus) 확보 가드.
//
// 데스크탑 레포는 비공개이고 Hephaestus/ 는 git-ignore 되어 있어, 깨끗한 클론에는 엔진이
// 없다. 패키징(extraResources)이 엔진을 번들하려면 디스크에 엔진이 있어야 하므로, 이 스크립트가
// 없으면 클론한다. 이미 있으면 깨끗한 checkout만 요청 ref로 맞추며, 로컬 변경은 덮지 않고 실패한다.
//
// 환경변수:
//   HEPHAESTUS_REPO   기본 https://github.com/agentlas-ai/Agentlas-OS.git
//   HEPHAESTUS_REF    기본 v1.1.18 (브랜치/태그/커밋)
//   HEPHAESTUS_DIR    기본 <repo>/Hephaestus
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.HEPHAESTUS_DIR
  ? path.resolve(process.env.HEPHAESTUS_DIR)
  : path.join(repoRoot, "Hephaestus");
const repo = process.env.HEPHAESTUS_REPO || "https://github.com/agentlas-ai/Agentlas-OS.git";
const ref = process.env.HEPHAESTUS_REF || "v1.1.18";

// 엔진 존재 판정: 런타임 진입 모듈이 있어야 "있다"로 본다(빈 폴더/부분 클론 방지).
const sentinel = path.join(dir, "agentlas_cloud", "__main__.py");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

function capture(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function fail(message) {
  console.error(`[ensure-engine] ERROR: ${message}`);
  process.exit(1);
}

function verifyPinnedVersion() {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.exec(ref);
  if (!match) return;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch (error) {
    fail(`could not read the pinned runtime manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (`v${manifest?.version ?? ""}` !== ref) {
    fail(`HEPHAESTUS_REF=${ref} does not match ${dir}/manifest.json version=${manifest?.version ?? "missing"}`);
  }
}

function verifyReady() {
  if (!existsSync(sentinel)) fail(`runtime entrypoint not found after preparation: ${sentinel}`);
  const dirty = capture("git", ["-C", dir, "status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) fail(`embedded Agentlas OS checkout is dirty after preparation: ${dir}`);
  verifyPinnedVersion();
}

if (existsSync(sentinel)) {
  let insideWorktree = "";
  try {
    insideWorktree = capture("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"]);
  } catch {
    fail(`runtime entrypoint exists but ${dir} is not a verifiable Git checkout`);
  }
  if (insideWorktree !== "true") fail(`${dir} is not a Git worktree`);

  const dirty = capture("git", ["-C", dir, "status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) {
    fail(`embedded Agentlas OS checkout has local changes; refusing to overwrite ${dir}`);
  }

  console.log(`[ensure-engine] Verifying existing Agentlas OS checkout against ${repo}@${ref}`);
  try {
    run("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", repo, ref]);
  } catch {
    console.log("[ensure-engine] shallow ref fetch failed; retrying with a full ref fetch");
    run("git", ["-C", dir, "fetch", "--quiet", repo, ref]);
  }
  const desired = capture("git", ["-C", dir, "rev-parse", "FETCH_HEAD^{commit}"]);
  const current = capture("git", ["-C", dir, "rev-parse", "HEAD^{commit}"]);
  if (current !== desired) {
    run("git", ["-C", dir, "switch", "--detach", desired]);
    console.log(`[ensure-engine] Updated embedded Agentlas OS ${current.slice(0, 8)} → ${desired.slice(0, 8)}.`);
  } else {
    console.log(`[ensure-engine] Embedded Agentlas OS already pinned at ${desired.slice(0, 8)}.`);
  }
  verifyReady();
  process.exit(0);
}

console.log(`[ensure-engine] Hephaestus missing — cloning ${repo}@${ref} → ${dir}`);
try {
  run("git", ["clone", "--depth", "1", "--branch", ref, repo, dir]);
} catch {
  // ref 가 브랜치가 아닐 수 있음(커밋 SHA) — full 클론 후 checkout 폴백.
  console.log("[ensure-engine] shallow branch clone failed; retrying with full clone + checkout");
  run("git", ["clone", repo, dir]);
  run("git", ["-C", dir, "checkout", ref]);
}

verifyReady();
console.log("[ensure-engine] Hephaestus engine ready.");
