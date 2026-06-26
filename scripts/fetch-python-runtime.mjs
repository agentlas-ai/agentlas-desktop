#!/usr/bin/env node
// 현재 플랫폼용 standalone Python(python-build-standalone)을 받아
// build-resources/python-runtime/ 에 채운다. 이걸 실행한 뒤 빌드하면 extraResources 로 동봉되어
// Python 미설치 머신에서도 엔진이 동작한다(브리지가 이 경로를 최우선 탐색).
//
// 비우면(.gitkeep만) 앱은 시스템 python3 로 폴백한다 — 즉 이 스크립트는 선택사항(하드닝)이다.
//
// 환경변수:
//   PYBS_PYVER   원하는 CPython major.minor (기본 3.12)
//   PYBS_TAG     python-build-standalone 릴리스 태그(기본 latest)
//   PYBS_ARCH    타깃 아키텍처 오버라이드(arm64|x64) — 기본은 빌드 머신 arch.
//
// 주의(dual-arch macOS): 이 스크립트는 단일 아키텍처 python 만 채운다. electron-builder mac
// 타깃은 arm64+x64 둘 다 빌드하므로, 번들 python 을 쓰려면 각 arch 빌드 전에 PYBS_ARCH 를
// 맞춰 다시 fetch 하거나, 빌드 머신 arch 의 단일-arch 릴리스만 번들 python 으로 배포할 것.
// (번들 python 은 선택사항 — 비우면 시스템 python 폴백이라 dual-arch 빌드는 그대로 동작한다.)
//
// 산출물 레이아웃: build-resources/python-runtime/bin/python3 (mac/linux),
//                  build-resources/python-runtime/python.exe (win)
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "build-resources", "python-runtime");
const pyver = process.env.PYBS_PYVER || "3.12";
const tag = process.env.PYBS_TAG || "latest";

const TRIPLES = {
  "darwin:arm64": "aarch64-apple-darwin",
  "darwin:x64": "x86_64-apple-darwin",
  "win32:x64": "x86_64-pc-windows-msvc",
  "linux:x64": "x86_64-unknown-linux-gnu",
  "linux:arm64": "aarch64-unknown-linux-gnu",
};

function fail(m) {
  console.error(`[fetch-python] ${m}`);
  process.exit(1);
}

const targetArch = process.env.PYBS_ARCH || process.arch;
const triple = TRIPLES[`${process.platform}:${targetArch}`];
if (!triple) fail(`지원하지 않는 플랫폼/아키텍처: ${process.platform}/${targetArch}`);
if (targetArch !== process.arch) console.log(`[fetch-python] PYBS_ARCH override → ${targetArch}`);

const apiUrl =
  tag === "latest"
    ? "https://api.github.com/repos/astral-sh/python-build-standalone/releases/latest"
    : `https://api.github.com/repos/astral-sh/python-build-standalone/releases/tags/${tag}`;

const release = await fetch(apiUrl, {
  headers: { "User-Agent": "agentlas-desktop-build", Accept: "application/vnd.github+json" },
}).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub API ${r.status}`)))).catch((e) => fail(e.message));

// install_only 아카이브 중 원하는 버전 + triple 매칭(최신 빌드 우선).
const want = (name) =>
  name.startsWith(`cpython-${pyver}.`) && name.includes(`-${triple}-`) && name.endsWith("-install_only.tar.gz");
const asset = (release.assets || []).filter((a) => want(a.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
if (!asset) fail(`매칭 에셋 없음: cpython-${pyver}.* ${triple} install_only (release: ${release.tag_name})`);

console.log(`[fetch-python] ${asset.name} (${(asset.size / 1e6).toFixed(1)} MB)`);
const tmp = path.join(os.tmpdir(), `pybs-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
const tarPath = path.join(tmp, asset.name);

const dl = await fetch(asset.browser_download_url, { headers: { "User-Agent": "agentlas-desktop-build" } });
if (!dl.ok || !dl.body) fail(`다운로드 실패 ${dl.status}`);
await pipeline(Readable.fromWeb(dl.body), createWriteStream(tarPath));

console.log("[fetch-python] extracting…");
execFileSync("tar", ["-xzf", tarPath, "-C", tmp], { stdio: "inherit" });
// 아카이브는 최상위 python/ 디렉터리를 가진다.
const extractedPython = path.join(tmp, "python");
if (!existsSync(extractedPython)) fail("추출물에 python/ 디렉터리가 없습니다.");

// 기존 내용 비우고(.gitkeep 보존 위해 디렉터리는 유지) 새로 채운다.
if (existsSync(outDir)) {
  for (const e of readdirSync(outDir)) {
    if (e === ".gitkeep") continue;
    rmSync(path.join(outDir, e), { recursive: true, force: true });
  }
} else {
  mkdirSync(outDir, { recursive: true });
}
for (const e of readdirSync(extractedPython)) {
  renameSync(path.join(extractedPython, e), path.join(outDir, e));
}
rmSync(tmp, { recursive: true, force: true });

const bin = process.platform === "win32" ? path.join(outDir, "python.exe") : path.join(outDir, "bin", "python3");
if (!existsSync(bin)) fail(`설치 후 python 바이너리를 찾지 못함: ${bin}`);
const ver = execFileSync(bin, ["--version"]).toString().trim();
console.log(`[fetch-python] ready → ${bin} (${ver})`);
console.log("[fetch-python] 이제 빌드하면 이 Python 이 앱에 동봉됩니다.");
