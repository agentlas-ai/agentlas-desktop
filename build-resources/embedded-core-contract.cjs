"use strict";

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const EMBEDDED_CORE_STAGE_RELATIVE = path.join("dist", "embedded-core");
const EMBEDDED_CORE_RECEIPT = "agentlas-embedded-core.json";
const RETIREMENT_TRANSFORM_ID = "agentlas.desktop.embedded-core-retirement.v1";
const RETAINED_CAPABILITIES = Object.freeze([
  "agent-ontology",
  "workforce-ontology",
  "semantic-ontology",
  "context-map",
  "career-graph",
]);
const REQUIRED_RUNTIME_PATHS = Object.freeze([
  "agentlas_cloud/__main__.py",
  "agentlas_cloud/cli.py",
  "agentlas_cloud/agent_graph/loader.py",
  "agentlas_cloud/agent_graph/validator.py",
  "agentlas_cloud/workforce/ontology_v1.json",
  "agentlas_cloud/context_map.py",
  "ontology/__main__.py",
  "career_graph/__main__.py",
  "manifest.json",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function policySha256() {
  const digest = createHash("sha256");
  for (const policyPath of [
    __filename,
    path.join(__dirname, "..", "scripts", "prepare-embedded-core.mjs"),
  ]) {
    digest.update(path.basename(policyPath)).update("\0").update(fs.readFileSync(policyPath)).update("\n");
  }
  return digest.digest("hex");
}

function relativeFiles(root) {
  const files = [];
  const queue = [""];
  while (queue.length > 0) {
    const relativeDir = queue.pop();
    const absoluteDir = path.join(root, ...relativeDir.split("/").filter(Boolean));
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(relative);
      else files.push(relative);
    }
  }
  return files.sort();
}

function treeSha256(root, { excludeReceipt = true, include = () => true } = {}) {
  const digest = createHash("sha256");
  for (const relative of relativeFiles(root)) {
    if (excludeReceipt && relative === EMBEDDED_CORE_RECEIPT) continue;
    if (!include(relative)) continue;
    const absolute = path.join(root, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      digest.update("L\0").update(relative).update("\0").update(fs.readlinkSync(absolute)).update("\n");
      continue;
    }
    if (!stat.isFile()) throw new Error(`unsupported embedded Core entry: ${relative}`);
    digest.update("F\0").update(relative).update("\0")
      .update(String(stat.mode & 0o111)).update("\0")
      .update(sha256(fs.readFileSync(absolute))).update("\n");
  }
  return digest.digest("hex");
}

function packageOmissionReason(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const parts = normalized.toLowerCase().split("/").filter(Boolean);
  const base = parts.at(-1) || "";
  if (normalized === EMBEDDED_CORE_RECEIPT) return null;
  if (parts.includes(".git")) return "vcs-metadata";
  if (parts.includes(".agentlas")) {
    return normalized === ".agentlas/product-runtime-contract.json" ? null : "private-agentlas-state";
  }
  if (["signing", "credentials", ".memory.local"].some((segment) => parts.includes(segment))) {
    return "private-runtime-state";
  }
  if (["tests", "test", "benchmarks", "benchmark", "docs", "fixtures", "fixture", "findings", "evidence", "artifacts", "output"]
    .some((segment) => parts.includes(segment))) return "development-only-tree";
  if (parts[0] === "research" || parts[0] === "examples") return "development-only-root";
  if (["__pycache__", ".ontology-runtime", ".codex"].some((segment) => parts.includes(segment))) {
    return "generated-runtime-state";
  }
  if (parts[0] === ".pytest_cache" || parts[0] === ".playwright-mcp") return "generated-runtime-state";
  if (base === ".env" || base.startsWith(".env.")) return "secret-bearing-file";
  if (/\.(?:pem|key|p12|p8|mobileprovision|jks|keystore)$/.test(base)) return "secret-bearing-file";
  if (/\.(?:pyc|pyo|log)$/.test(base) || base === ".ds_store" || base.startsWith("._")) {
    return "generated-file";
  }
  if (/^(?:test[-_]|.*[-_.]test\.|.*benchmark|.*fixture)/.test(base)) return "development-only-file";
  const claudeIndex = parts.lastIndexOf(".claude");
  if (claudeIndex >= 0 && /^settings(?:\..+)?\.local\.json$/.test(base)) return "private-tool-settings";
  return null;
}

function packageProjection(root) {
  const omissions = [];
  let includedFileCount = 0;
  for (const relative of relativeFiles(root)) {
    if (relative === EMBEDDED_CORE_RECEIPT) continue;
    const reason = packageOmissionReason(relative);
    if (reason) omissions.push({ path: relative, reason });
    else includedFileCount += 1;
  }
  return {
    schemaVersion: "agentlas.desktop.embedded-core-package-projection.v1",
    includedFileCount,
    includedTreeSha256: treeSha256(root, { include: (relative) => !packageOmissionReason(relative) }),
    omissions,
  };
}

function scanRetiredRuntime(root) {
  const findings = [];
  for (const relative of relativeFiles(root)) {
    if (packageOmissionReason(relative)) continue;
    const normalized = relative.replaceAll("\\", "/");
    const base = path.posix.basename(normalized);
    if (/super[-_]ontology/i.test(base)) {
      findings.push(`${normalized}:retired_path`);
      continue;
    }
    if (/(?:^|\/)agentlas_cloud\/agent_graph\/kernel\.py$/i.test(normalized)) {
      findings.push(`${normalized}:retired_loader`);
      continue;
    }
    if (!/\.(?:py|json|jsonl|tpl|sh)$/i.test(base)) continue;
    const absolute = path.join(root, ...normalized.split("/"));
    const source = fs.readFileSync(absolute, "utf8");
    if (/super[-_ ]ontology/i.test(source)) findings.push(`${normalized}:retired_reference`);
    if (/from\s+\.kernel\s+import|agent_graph\.kernel|\b(?:load_kernel|verify_enforcement|ENFORCED_SEEDS)\b/.test(source)) {
      findings.push(`${normalized}:retired_loader_reference`);
    }
  }
  return [...new Set(findings)].sort();
}

function assertRetainedCapabilities(root) {
  for (const relative of REQUIRED_RUNTIME_PATHS) {
    const absolute = path.join(root, ...relative.split("/"));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`retained embedded Core capability is missing or mutable: ${relative}`);
    }
  }
}

function readReceipt(root) {
  const receiptPath = path.join(root, EMBEDDED_CORE_RECEIPT);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  return { receipt, receiptPath };
}

function writeReceipt(root, { sourceCommit, sourceVersion }) {
  const receipt = {
    schemaVersion: "agentlas.desktop.embedded-core.v1",
    sourceCommit,
    sourceVersion,
    transformId: RETIREMENT_TRANSFORM_ID,
    transformPolicySha256: policySha256(),
    stagedTreeSha256: treeSha256(root),
    packageProjection: packageProjection(root),
    retainedCapabilities: [...RETAINED_CAPABILITIES],
  };
  fs.writeFileSync(path.join(root, EMBEDDED_CORE_RECEIPT), `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return receipt;
}

function verifyReceipt(root, pkg) {
  const { receipt } = readReceipt(root);
  const source = pkg.agentlasBundledRuntimeSource || {};
  const version = pkg.agentlasUpdateCompatibility?.bundledRuntimeVersion;
  if (receipt.schemaVersion !== "agentlas.desktop.embedded-core.v1") throw new Error("invalid embedded Core receipt schema");
  if (receipt.sourceCommit !== source.commit) throw new Error("embedded Core receipt commit does not match immutable package pin");
  if (receipt.sourceVersion !== version) throw new Error("embedded Core receipt version does not match compatibility contract");
  if (receipt.transformId !== RETIREMENT_TRANSFORM_ID) throw new Error("embedded Core retirement transform ID mismatch");
  if (receipt.transformPolicySha256 !== policySha256()) throw new Error("embedded Core retirement policy checksum mismatch");
  if (receipt.stagedTreeSha256 !== treeSha256(root)) throw new Error("prepared embedded Core tree checksum mismatch");
  if (JSON.stringify(receipt.packageProjection) !== JSON.stringify(packageProjection(root))) {
    throw new Error("embedded Core package projection receipt mismatch");
  }
  if (JSON.stringify(receipt.retainedCapabilities) !== JSON.stringify(RETAINED_CAPABILITIES)) {
    throw new Error("embedded Core retained-capability receipt mismatch");
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  if (manifest.version !== version) throw new Error("prepared embedded Core manifest version mismatch");
  assertRetainedCapabilities(root);
  const retired = scanRetiredRuntime(root);
  if (retired.length > 0) throw new Error(`retired embedded Core runtime surface remains: ${retired.slice(0, 8).join(", ")}`);
  return receipt;
}

function verifyPinnedSource(sourceRoot, pkg) {
  const source = pkg.agentlasBundledRuntimeSource || {};
  const result = spawnSync("git", ["-C", sourceRoot, "rev-parse", "HEAD^{commit}"], { encoding: "utf8" });
  if (result.status !== 0 || result.stdout.trim() !== source.commit) {
    throw new Error("embedded Core source checkout does not match the immutable package pin");
  }
  const dirty = spawnSync("git", ["-C", sourceRoot, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" });
  if (dirty.status !== 0 || dirty.stdout.trim()) throw new Error("embedded Core source checkout is not clean");
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "manifest.json"), "utf8"));
  if (manifest.version !== pkg.agentlasUpdateCompatibility?.bundledRuntimeVersion) {
    throw new Error("embedded Core source manifest does not match the package runtime version");
  }
}

function verifyPackagedSubset(packagedRoot, stagedRoot) {
  const projection = packageProjection(stagedRoot);
  const expectedFiles = relativeFiles(stagedRoot).filter(
    (relative) => relative === EMBEDDED_CORE_RECEIPT || !packageOmissionReason(relative),
  );
  const packagedFiles = relativeFiles(packagedRoot);
  const expectedSet = new Set(expectedFiles);
  const packagedSet = new Set(packagedFiles);
  const missing = expectedFiles.filter((relative) => !packagedSet.has(relative));
  if (missing.length > 0) {
    throw new Error(`packaged embedded Core is missing prepared runtime file: ${missing.slice(0, 8).join(", ")}`);
  }
  const unexpected = packagedFiles.filter((relative) => !expectedSet.has(relative));
  if (unexpected.length > 0) {
    throw new Error(`packaged embedded Core contains unexpected or intentionally omitted file: ${unexpected.slice(0, 8).join(", ")}`);
  }
  if (packagedFiles.length !== projection.includedFileCount + 1) {
    throw new Error("packaged embedded Core file count does not match preparation receipt");
  }
  for (const relative of packagedFiles) {
    const packaged = path.join(packagedRoot, ...relative.split("/"));
    const staged = path.join(stagedRoot, ...relative.split("/"));
    if (!fs.existsSync(staged)) throw new Error(`packaged embedded Core file is absent from prepared source: ${relative}`);
    const packagedStat = fs.lstatSync(packaged);
    const stagedStat = fs.lstatSync(staged);
    if (packagedStat.isSymbolicLink() || stagedStat.isSymbolicLink()) {
      if (!packagedStat.isSymbolicLink() || !stagedStat.isSymbolicLink() || fs.readlinkSync(packaged) !== fs.readlinkSync(staged)) {
        throw new Error(`packaged embedded Core symlink drift: ${relative}`);
      }
      continue;
    }
    if (!packagedStat.isFile() || !stagedStat.isFile()) throw new Error(`unsupported packaged embedded Core entry: ${relative}`);
    if (sha256(fs.readFileSync(packaged)) !== sha256(fs.readFileSync(staged))) {
      throw new Error(`packaged embedded Core byte drift: ${relative}`);
    }
  }
  assertRetainedCapabilities(packagedRoot);
  const retired = scanRetiredRuntime(packagedRoot);
  if (retired.length > 0) throw new Error(`retired surface reached packaged embedded Core: ${retired.slice(0, 8).join(", ")}`);
}

module.exports = {
  EMBEDDED_CORE_RECEIPT,
  EMBEDDED_CORE_STAGE_RELATIVE,
  REQUIRED_RUNTIME_PATHS,
  RETAINED_CAPABILITIES,
  RETIREMENT_TRANSFORM_ID,
  assertRetainedCapabilities,
  packageOmissionReason,
  packageProjection,
  policySha256,
  scanRetiredRuntime,
  treeSha256,
  verifyPackagedSubset,
  verifyPinnedSource,
  verifyReceipt,
  writeReceipt,
};
