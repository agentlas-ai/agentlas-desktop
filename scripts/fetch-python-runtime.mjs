#!/usr/bin/env node
// 현재 플랫폼용 standalone Python(python-build-standalone)을 받아
// build-resources/python-runtime/ 에 채운다. 이걸 실행한 뒤 빌드하면 extraResources 로 동봉되어
// Python 미설치 머신에서도 엔진이 동작한다(브리지가 이 경로를 최우선 탐색).
//
// 공개 패키지는 이 런타임을 필수로 동봉한다. 빈 디렉터리나 시스템 Python 폴백은
// 패키징 계약 위반이며 afterPack에서 실패한다.
//
// 공급망 핀은 이 파일에 고정한다. PYBS_TAG/PYBS_PYVER 환경변수는 정확히
// 같은 값만 허용하며 latest/임의 자산으로 조용히 이동하지 않는다.
// PYBS_ARCH만 타깃 아키텍처 오버라이드(arm64|x64)로 쓴다.
//
// 주의(dual-arch macOS): 이 스크립트는 단일 아키텍처 python 만 채운다. electron-builder mac
// 타깃은 arm64+x64 둘 다 빌드하므로, 번들 python 을 쓰려면 각 arch 빌드 전에 PYBS_ARCH 를
// 맞춰 다시 fetch 하거나, 빌드 머신 arch 의 단일-arch 릴리스만 번들 python 으로 배포할 것.
// 각 아키텍처용 immutable 자산을 해당 electron-builder 호출 직전에 다시 채운다.
//
// 산출물 레이아웃: build-resources/python-runtime/bin/python3 (mac/linux),
//                  build-resources/python-runtime/python.exe (win)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "build-resources", "python-runtime");
const pyver = "3.12.13";
const tag = "20260510";

const LOCKED_ASSETS = {
  "aarch64-apple-darwin": {
    name: "cpython-3.12.13+20260510-aarch64-apple-darwin-install_only.tar.gz",
    sha256: "5a30271f8d345a5b02b0c9e4e31e0f1e1455a8e4a04fba95cd9762472abc3b17",
  },
  "x86_64-apple-darwin": {
    name: "cpython-3.12.13+20260510-x86_64-apple-darwin-install_only.tar.gz",
    sha256: "cd369e76973c3179bc578230d8615ab621968ed758c5e32f636eecef4ad79894",
  },
  "x86_64-pc-windows-msvc": {
    name: "cpython-3.12.13+20260510-x86_64-pc-windows-msvc-install_only.tar.gz",
    sha256: "346dfbcb95171dd6d1275e6f8cb2e656cc15cb054c399ae54db57bfad4b1a60f",
  },
  "x86_64-unknown-linux-gnu": {
    name: "cpython-3.12.13+20260510-x86_64-unknown-linux-gnu-install_only.tar.gz",
    sha256: "e7332b4b4bb85006deb48d251c786a04c14de104c9b3a006b33457a4a604b8bc",
  },
};

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

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function runtimeTreeSha256(root) {
  const records = [];
  const walk = (relative) => {
    const absolute = path.join(root, relative);
    for (const name of readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-python-runtime.json") continue;
      // 바이트코드 캐시는 계약 밖 — 인터프리터를 한 번만 실행해도 소스 트리에 생기고
      // 패키징 필터(!**/__pycache__/**, !**/*.pyc)가 걷어낸다. afterPack 검증과
      // 같은 해시 도메인을 유지해야 소스/패키지 양쪽이 manifest와 일치한다.
      if (name === "__pycache__" || /\.py[co]$/.test(name)) continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = lstatSync(childAbsolute);
      if (stat.isDirectory()) walk(childRelative);
      else if (stat.isSymbolicLink()) records.push({ kind: "L", relative: childRelative, target: readlinkSync(childAbsolute) });
      else if (stat.isFile()) records.push({ kind: "F", relative: childRelative, absolute: childAbsolute, size: stat.size });
      else fail(`지원하지 않는 Python runtime entry: ${childRelative}`);
    }
  };
  walk("");
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(await sha256File(record.absolute)).update("\n");
    }
  }
  return digest.digest("hex");
}

const targetArch = process.env.PYBS_ARCH || process.arch;
const triple = TRIPLES[`${process.platform}:${targetArch}`];
if (!triple) fail(`지원하지 않는 플랫폼/아키텍처: ${process.platform}/${targetArch}`);
if (targetArch !== process.arch) console.log(`[fetch-python] PYBS_ARCH override → ${targetArch}`);
if (process.env.PYBS_TAG && process.env.PYBS_TAG !== tag) fail(`PYBS_TAG must stay pinned to ${tag}`);
if (process.env.PYBS_PYVER && process.env.PYBS_PYVER !== pyver) fail(`PYBS_PYVER must stay pinned to ${pyver}`);

const asset = LOCKED_ASSETS[triple];
if (!asset) fail(`잠긴 Python 자산 없음: ${triple}`);

console.log(`[fetch-python] pinned ${asset.name}`);
const tmp = path.join(os.tmpdir(), `pybs-${Date.now()}`);
mkdirSync(tmp, { recursive: true });
const tarPath = path.join(tmp, asset.name);

const assetUrl = `https://github.com/astral-sh/python-build-standalone/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
let downloadError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
  try {
    const dl = await fetch(assetUrl, {
      headers: { "User-Agent": "agentlas-desktop-build" },
      redirect: "follow",
      signal: AbortSignal.timeout(120_000),
    });
    if (!dl.ok || !dl.body) throw new Error(`HTTP ${dl.status}`);
    await pipeline(Readable.fromWeb(dl.body), createWriteStream(tarPath));
    downloadError = undefined;
    break;
  } catch (error) {
    downloadError = error;
    rmSync(tarPath, { force: true });
    if (attempt < 3) {
      console.warn(`[fetch-python] download attempt ${attempt}/3 failed; retrying pinned asset`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 1_000));
    }
  }
}
if (downloadError) fail(`다운로드 실패: ${downloadError instanceof Error ? downloadError.message : String(downloadError)}`);
const observedSha256 = await sha256File(tarPath);
if (observedSha256 !== asset.sha256) {
  fail(`SHA-256 불일치: ${asset.name} expected=${asset.sha256} observed=${observedSha256}`);
}
console.log(`[fetch-python] sha256 verified ${observedSha256}`);

console.log("[fetch-python] extracting…");
// Windows에서 PATH의 tar가 Git Bash GNU tar면 `C:\...`를 원격 호스트로 해석해
// "Cannot connect to C:"로 죽는다. System32의 bsdtar는 Windows 경로를 그대로 안다.
const systemTar = process.platform === "win32"
  ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe")
  : null;
const tarBin = systemTar && existsSync(systemTar) ? systemTar : "tar";
execFileSync(tarBin, ["-xzf", tarPath, "-C", tmp], { stdio: "inherit" });
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
  // The workspace may live on an external disk while os.tmpdir() lives on the
  // system volume. copy avoids EXDEV failures that rename would cause there.
  cpSync(path.join(extractedPython, e), path.join(outDir, e), {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
  });
}
rmSync(tmp, { recursive: true, force: true });

const bin = process.platform === "win32" ? path.join(outDir, "python.exe") : path.join(outDir, "bin", "python3");
if (!existsSync(bin)) fail(`설치 후 python 바이너리를 찾지 못함: ${bin}`);

/*
 * 엔진이 쓰는 파이썬 패키지를 번들 안에 넣는다.
 *
 * ★ 왜 (2026-08-24 실측): 동봉 엔진은 `jsonschema` 와 `referencing` 을 import 한다. 번들에
 *   없으면 그 기능은 사용자의 `~/.local` 에 있는 것을 집어 쓰다가 아키텍처가 다르면 죽고,
 *   `~/.local` 을 무시하도록 막아 두면 이번엔 모듈이 없어서 죽는다 — 어느 쪽이든 실패다.
 *   그래서 우리가 배포하는 인터프리터가 스스로 갖고 있어야 한다.
 *
 * ★ 왜 여기(지문 계산 앞): 트리 지문은 이 아래에서 계산되고 afterPack 이 그 값과 대조한다.
 *   설치를 지문 뒤에 하거나 손으로 하면 지문이 어긋나 **맥 빌드가 통째로 멈춘다**(실제로
 *   손으로 깔린 148개 파일이 그렇게 빌드를 막고 있었다).
 *
 * 버전은 전부 고정한다 — 재현되지 않으면 지문도 재현되지 않는다.
 */
const BUNDLED_PYTHON_PACKAGES = [
  "jsonschema==4.26.0",
  "jsonschema-specifications==2025.9.1",
  "referencing==0.37.0",
  "rpds-py==2026.6.3",
  "attrs==26.1.0",
  "typing-extensions==4.16.0",
];

/** 대상 플랫폼의 휠 태그. 크로스 아키텍처 빌드에서 네이티브 휠(rpds-py)을 바르게 고르게 한다. */
function pipPlatformTags(tripleValue) {
  if (tripleValue.includes("apple-darwin")) {
    return tripleValue.startsWith("aarch64")
      ? ["macosx_11_0_arm64", "macosx_12_0_arm64", "macosx_14_0_arm64"]
      : ["macosx_10_9_x86_64", "macosx_10_12_x86_64", "macosx_11_0_x86_64"];
  }
  if (tripleValue.includes("windows")) return tripleValue.startsWith("aarch64") ? ["win_arm64"] : ["win_amd64"];
  return tripleValue.startsWith("aarch64")
    ? ["manylinux_2_17_aarch64", "manylinux2014_aarch64"]
    : ["manylinux_2_17_x86_64", "manylinux2014_x86_64"];
}

const sitePackages = process.platform === "win32"
  ? path.join(outDir, "Lib", "site-packages")
  : path.join(outDir, "lib", `python${pyver.split(".").slice(0, 2).join(".")}`, "site-packages");
if (!existsSync(sitePackages)) fail(`site-packages 를 찾지 못함: ${sitePackages}`);
console.log(`[fetch-python] bundling ${BUNDLED_PYTHON_PACKAGES.length} engine package(s)…`);
{
  const pipArgs = [
    "-m", "pip", "install", "--quiet", "--no-input", "--disable-pip-version-check",
    "--no-compile", "--target", sitePackages, "--upgrade",
  ];
  // 이 기계에서 그대로 돌 수 있는 파이썬이면 직접 풀게 두고, 아니면 대상 플랫폼 휠만 받는다.
  if (targetArch !== process.arch || process.platform !== (triple.includes("apple-darwin") ? "darwin" : triple.includes("windows") ? "win32" : "linux")) {
    pipArgs.push("--only-binary=:all:", "--python-version", pyver.split(".").slice(0, 2).join("."));
    for (const tag of pipPlatformTags(triple)) pipArgs.push("--platform", tag);
  }
  execFileSync(bin, [...pipArgs, ...BUNDLED_PYTHON_PACKAGES], {
    stdio: "inherit",
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" },
  });
}
// 넣었다고 믿지 않고 실제로 불러 본다 — 없으면 그 기능은 사용자 손에서 죽는다.
for (const moduleName of ["jsonschema", "referencing"]) {
  execFileSync(bin, ["-c", `import ${moduleName}`], {
    env: { ...process.env, PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
}
console.log("[fetch-python] engine packages import cleanly from the bundled interpreter.");

const executableRelativePath = path.relative(outDir, bin).split(path.sep).join("/");
const executableSha256 = await sha256File(bin);
const runtimeTreeDigest = await runtimeTreeSha256(outDir);
writeFileSync(
  path.join(outDir, "agentlas-python-runtime.json"),
  `${JSON.stringify({
    schemaVersion: "agentlas.python-runtime.v1",
    pythonVersion: pyver,
    releaseTag: tag,
    triple,
    archiveName: asset.name,
    archiveSha256: asset.sha256,
    executableRelativePath,
    executableSha256,
    runtimeTreeSha256: runtimeTreeDigest,
  }, null, 2)}\n`,
  { encoding: "utf8", mode: 0o644 },
);
let versionEvidence = `${pyver} (${triple})`;
if (targetArch === process.arch) {
  // 증거 실행이 소스 트리에 바이트코드 캐시를 쓰지 않게 한다 — 해시 도메인에서
  // 제외했더라도 fetch 직후의 트리는 아카이브 그대로가 가장 진단하기 쉽다.
  versionEvidence = execFileSync(bin, ["--version"], {
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
  }).toString().trim();
} else if (process.platform === "darwin") {
  const arches = execFileSync("lipo", ["-archs", bin]).toString().trim().split(/\s+/);
  const expectedArch = targetArch === "x64" ? "x86_64" : "arm64";
  if (!arches.includes(expectedArch)) fail(`Python Mach-O architecture mismatch: expected ${expectedArch}`);
}
console.log(`[fetch-python] ready → ${bin} (${versionEvidence})`);
console.log("[fetch-python] 이제 빌드하면 이 Python 이 앱에 동봉됩니다.");
