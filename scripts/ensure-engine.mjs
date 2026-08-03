#!/usr/bin/env node
// 빌드 전 임베딩 엔진(Hephaestus) 확보 가드.
//
// 데스크탑 레포는 비공개이고 Hephaestus/ 는 git-ignore 되어 있어, 깨끗한 클론에는 엔진이
// 없다. 패키징(extraResources)이 엔진을 번들하려면 디스크에 엔진이 있어야 하므로, 이 스크립트가
// 없으면 클론한다. 이미 있으면 깨끗한 checkout만 요청 ref로 맞추며, 로컬 변경은 덮지 않고 실패한다.
//
// 환경변수:
//   HEPHAESTUS_REPO   기본 https://github.com/agentlas-ai/Agentlas-OS.git
//   HEPHAESTUS_REF    기본 package.json의 bundledRuntimeVersion 태그 (브랜치/태그/커밋 override 가능)
//   HEPHAESTUS_COMMIT release workflow가 재확인하는 immutable commit (custom repo/ref 테스트도 지원)
//   HEPHAESTUS_DIR    기본 <repo>/Hephaestus
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = process.env.HEPHAESTUS_DIR
  ? path.resolve(process.env.HEPHAESTUS_DIR)
  : path.join(repoRoot, "Hephaestus");
const desktopPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const bundledRuntimeVersion = String(
  desktopPackage?.agentlasUpdateCompatibility?.bundledRuntimeVersion ?? "",
).trim();
if (!bundledRuntimeVersion) {
  throw new Error("package.json is missing agentlasUpdateCompatibility.bundledRuntimeVersion");
}
const runtimeSource = desktopPackage?.agentlasBundledRuntimeSource ?? {};
const canonicalRepository = String(runtimeSource.repository ?? "").trim();
const canonicalRef = String(runtimeSource.ref ?? "").trim();
const canonicalCommit = String(runtimeSource.commit ?? "").trim().toLowerCase();
if (!canonicalRepository || canonicalRef !== `v${bundledRuntimeVersion}` || !/^[0-9a-f]{40}$/.test(canonicalCommit)) {
  throw new Error("package.json has an invalid agentlasBundledRuntimeSource immutable pin");
}
const repo = process.env.HEPHAESTUS_REPO || canonicalRepository;
const ref = process.env.HEPHAESTUS_REF || canonicalRef;
const requestedCommit = String(process.env.HEPHAESTUS_COMMIT ?? "").trim().toLowerCase();
if (requestedCommit && !/^[0-9a-f]{40}$/.test(requestedCommit)) {
  throw new Error("HEPHAESTUS_COMMIT must be a full 40-character lowercase Git commit");
}
const usesCanonicalSource = repo === canonicalRepository && ref === canonicalRef;
if (usesCanonicalSource && requestedCommit && requestedCommit !== canonicalCommit) {
  throw new Error(`HEPHAESTUS_COMMIT=${requestedCommit} does not match package source pin ${canonicalCommit}`);
}
const expectedCommit = requestedCommit || (usesCanonicalSource ? canonicalCommit : "");

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

const sourceByteCheckoutConfig = ["-c", "core.autocrlf=false", "-c", "core.eol=lf"];

function materializeSourceBytes() {
  // actions/checkout follows the Windows global core.autocrlf setting. That is
  // fine for ordinary source code, but the embedded runtime contains assets
  // whose manifest records exact byte sizes and hashes. Re-materialize an
  // already-clean checkout without CRLF conversion before it can be packaged.
  run("git", ["-C", dir, "config", "--local", "core.autocrlf", "false"]);
  run("git", ["-C", dir, "config", "--local", "core.eol", "lf"]);
  const stagingDir = mkdtempSync(path.join(tmpdir(), "agentlas-core-source-"));
  try {
    const prefix = `${stagingDir.replaceAll("\\", "/")}/`;
    run("git", [
      ...sourceByteCheckoutConfig,
      "-C",
      dir,
      "checkout-index",
      "--all",
      "--force",
      `--prefix=${prefix}`,
    ]);
    cpSync(stagingDir, dir, { recursive: true, force: true, dereference: false });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
  // Refresh only index metadata after replacing files from that same index.
  // The cached tree must remain byte-for-byte identical to HEAD.
  run("git", [...sourceByteCheckoutConfig, "-C", dir, "add", "--update", "--"]);
  try {
    execFileSync("git", ["-C", dir, "diff", "--cached", "--quiet", "HEAD", "--"], {
      stdio: "ignore",
    });
  } catch {
    fail("source-byte materialization changed the embedded Agentlas OS index");
  }
  console.log("[ensure-engine] Re-materialized tracked Agentlas OS files with source line endings.");
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

function verifyPinnedCommit(actual = capture("git", ["-C", dir, "rev-parse", "HEAD^{commit}"])) {
  if (!expectedCommit) return;
  if (actual.toLowerCase() !== expectedCommit) {
    fail(`resolved Agentlas OS commit ${actual} does not match expected commit ${expectedCommit}`);
  }
}

// Ignored files are not covered by the immutable Git commit. Keep only the
// generated paths that both electron-builder configs explicitly exclude from
// extraResources; everything else could otherwise bypass the source pin and
// enter a signed/public package.
function isPackagingExcludedIgnoredPath(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  const parts = normalized.split("/").filter(Boolean);
  const root = parts[0] ?? "";
  const base = parts.at(-1) ?? "";
  if (["output", "tests", "benchmarks", "examples", ".playwright-mcp", ".pytest_cache"].includes(root)) {
    return true;
  }
  // Private project state, excluded at copy time by electron-builder's
  // "!.agentlas/**" filter. Listed here only because that filter now genuinely
  // removes it — never add a path here to silence this check while the file
  // still reaches the package.
  if (parts.includes(".agentlas")) return true;
  if (parts.includes("__pycache__")) return true;
  if (base === ".DS_Store") return true;
  return /\.(?:pyc|pyo)$/.test(base);
}

function verifyNoIgnoredPackagingMaterial() {
  let raw;
  try {
    raw = execFileSync(
      "git",
      ["-C", dir, "ls-files", "--others", "--ignored", "--exclude-standard", "-z"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    fail(`could not inspect ignored Agentlas OS files: ${error instanceof Error ? error.message : String(error)}`);
  }
  const unsafe = raw.split("\0").filter(Boolean).filter((entry) => !isPackagingExcludedIgnoredPath(entry));
  if (unsafe.length > 0) {
    const preview = unsafe.slice(0, 8).join(", ");
    const remainder = unsafe.length > 8 ? ` (+${unsafe.length - 8} more)` : "";
    fail(`embedded Agentlas OS contains ignored files eligible for packaging: ${preview}${remainder}`);
  }
}

function verifyReady() {
  if (!existsSync(sentinel)) fail(`runtime entrypoint not found after preparation: ${sentinel}`);
  const dirty = capture("git", ["-C", dir, "status", "--porcelain", "--untracked-files=normal"]);
  if (dirty) fail(`embedded Agentlas OS checkout is dirty after preparation: ${dir}`);
  verifyNoIgnoredPackagingMaterial();
  verifyPinnedVersion();
  verifyPinnedCommit();
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
  verifyNoIgnoredPackagingMaterial();

  console.log(`[ensure-engine] Verifying existing Agentlas OS checkout against ${repo}@${ref}`);
  try {
    run("git", ["-C", dir, "fetch", "--quiet", "--depth", "1", repo, ref]);
  } catch {
    console.log("[ensure-engine] shallow ref fetch failed; retrying with a full ref fetch");
    run("git", ["-C", dir, "fetch", "--quiet", repo, ref]);
  }
  const desired = capture("git", ["-C", dir, "rev-parse", "FETCH_HEAD^{commit}"]);
  verifyPinnedCommit(desired);
  materializeSourceBytes();
  const current = capture("git", ["-C", dir, "rev-parse", "HEAD^{commit}"]);
  if (current !== desired) {
    run("git", [...sourceByteCheckoutConfig, "-C", dir, "switch", "--detach", desired]);
    console.log(`[ensure-engine] Updated embedded Agentlas OS ${current.slice(0, 8)} → ${desired.slice(0, 8)}.`);
  } else {
    console.log(`[ensure-engine] Embedded Agentlas OS already pinned at ${desired.slice(0, 8)}.`);
  }
  verifyReady();
  process.exit(0);
}

console.log(`[ensure-engine] Hephaestus missing — cloning ${repo}@${ref} → ${dir}`);
try {
  run("git", [...sourceByteCheckoutConfig, "clone", "--depth", "1", "--branch", ref, repo, dir]);
} catch {
  // ref 가 브랜치가 아닐 수 있음(커밋 SHA) — full 클론 후 checkout 폴백.
  console.log("[ensure-engine] shallow branch clone failed; retrying with full clone + checkout");
  run("git", [...sourceByteCheckoutConfig, "clone", repo, dir]);
  run("git", [...sourceByteCheckoutConfig, "-C", dir, "checkout", ref]);
}

materializeSourceBytes();
verifyReady();
console.log("[ensure-engine] Hephaestus engine ready.");
