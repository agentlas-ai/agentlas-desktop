#!/usr/bin/env node
// 빌드 전 임베딩 엔진(Hephaestus) 확보 가드.
//
// 데스크탑 레포는 비공개이고 Hephaestus/ 는 git-ignore 되어 있어, 깨끗한 클론에는 엔진이
// 없다. 패키징(extraResources)이 엔진을 번들하려면 디스크에 엔진이 있어야 하므로, 이 스크립트가
// 없으면 클론한다. 이미 있으면 무엇도 변경하지 않는다(엔진 레포를 절대 더럽히지 않음).
//
// 환경변수:
//   HEPHAESTUS_REPO   기본 https://github.com/agentlas-ai/Agentlas-OS.git
//   HEPHAESTUS_REF    기본 v1.1.16 (브랜치/태그/커밋)
//   HEPHAESTUS_DIR    기본 <repo>/Hephaestus
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.HEPHAESTUS_DIR
  ? path.resolve(process.env.HEPHAESTUS_DIR)
  : path.join(repoRoot, "Hephaestus");
const repo = process.env.HEPHAESTUS_REPO || "https://github.com/agentlas-ai/Agentlas-OS.git";
const ref = process.env.HEPHAESTUS_REF || "v1.1.16";

// 엔진 존재 판정: 런타임 진입 모듈이 있어야 "있다"로 본다(빈 폴더/부분 클론 방지).
const sentinel = path.join(dir, "agentlas_cloud", "__main__.py");

function run(cmd, args, opts = {}) {
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

if (existsSync(sentinel)) {
  console.log(`[ensure-engine] Hephaestus already present at ${dir} — leaving untouched.`);
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

if (!existsSync(sentinel)) {
  console.error(`[ensure-engine] ERROR: clone completed but ${sentinel} not found. Aborting.`);
  process.exit(1);
}
console.log("[ensure-engine] Hephaestus engine ready.");
