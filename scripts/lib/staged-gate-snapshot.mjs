// Export the immutable index to a private directory, never a Git worktree.
// Only explicitly hash-frozen dependencies are copied or shared; source, gate
// bodies and generated files are not.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const gateName = /^(test|verify)-.*\.(cjs|mjs)$/;
const generic = new Set(["package.json", "package-lock.json", "tsconfig.json", "README.md", "CHANGELOG.md"]);
const marker = ".agentlas-index-gates.json";
const freshnessMarker = ".agentlas-gate-freshness.json";
const blobHash = (data) => createHash("sha1").update(`blob ${data.length}\0`).update(data).digest("hex");
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const externalTargetPattern = /^\.\.\/(?:agentlas_terminal|docs)(?:\/[A-Za-z0-9_.-]+)+$/;
const mobileExternalTargets = new Set([
  "../mobile/app/lib/core/transport/desktop_transport.dart",
  "../mobile/app/lib/core/transport/mock_desktop_transport.dart",
  "../mobile/app/lib/features/terminal/mobile_terminal_panel.dart",
  "../mobile/app/lib/features/screens/agentlas_screen.dart",
]);

function validateExternalTarget(target) {
  const parts = typeof target === "string" ? target.split("/") : [];
  if (typeof target !== "string" || (!externalTargetPattern.test(target) && !mobileExternalTargets.has(target))
    || path.posix.normalize(target) !== target || parts[0] !== ".." || parts.slice(1).includes("..")) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${target}`);
  }
}

function externalTargetPath(root, target) {
  validateExternalTarget(target);
  const parent = path.dirname(root);
  const resolved = path.resolve(root, target);
  if (resolved === root || !(resolved === parent || resolved.startsWith(`${parent}${path.sep}`))) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_TARGET: ${target}`);
  }
  return resolved;
}

function externalFiles(source) {
  const files = [];
  const visit = (directory, relative = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`PRIVATE_EXTERNAL_SYMLINK: ${absolute}`);
      const next = relative ? path.join(relative, name) : name;
      if (stat.isDirectory()) visit(absolute, next);
      else if (stat.isFile()) files.push({ absolute, relative: next.split(path.sep).join("/"), mode: stat.mode & 0o777 });
      else throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${absolute}`);
    }
  };
  visit(source);
  return files;
}

function externalDigest(source) {
  const rows = externalFiles(source).map(({ absolute, relative }) =>
    `${relative}\0${sha256(fs.readFileSync(absolute))}\n`).join("");
  return sha256(Buffer.from(rows));
}

function privateGateSourcePath(root, entry, allowRootSource = false) {
  if (entry?.source === undefined) return path.join(root, entry.path);
  if (typeof entry.source !== "string" || !path.isAbsolute(entry.source)) {
    throw new Error(`INVALID_PRIVATE_GATE_SOURCE: ${entry?.path || "unknown"}`);
  }
  const source = path.resolve(entry.source);
  if (!allowRootSource && (source === root || source.startsWith(`${root}${path.sep}`))) {
    throw new Error(`PRIVATE_GATE_SOURCE_IN_SNAPSHOT: ${entry.path}`);
  }
  return source;
}

function readPrivateGateSource(root, entry, changedCode = "PRIVATE_GATE_HASH_MISMATCH", allowRootSource = false) {
  const source = privateGateSourcePath(root, entry, allowRootSource);
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(source);
    bytes = fs.readFileSync(source);
    if (fs.realpathSync(source) !== source) throw new Error("PRIVATE_GATE_SYMLINK");
  } catch (error) {
    if (error?.message === "PRIVATE_GATE_SYMLINK") throw new Error(`PRIVATE_GATE_NOT_REGULAR: ${entry.path}`);
    throw new Error(`PRIVATE_GATE_NOT_REGULAR: ${entry.path}`);
  }
  if (!stat.isFile()) {
    throw new Error(`PRIVATE_GATE_NOT_REGULAR: ${entry.path}`);
  }
  if (sha256(bytes) !== entry.sha256) throw new Error(`${changedCode}: ${entry.path}`);
  return { source, bytes };
}

function normalizePrivateGateEntry(root, names, entry) {
  const validPrivatePath = typeof entry?.path === "string"
    && (/^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:cjs|mjs|json)$/.test(entry.path)
      || /^scripts\/fixtures\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.txt$/.test(entry.path));
  if (!validPrivatePath || names.has(entry.path)) {
    throw new Error(`INVALID_PRIVATE_GATE_ENTRY: ${entry?.path}`);
  }
  // 오너 결정 2026-09-13: 이 맥에만 있는 게이트는 그대로 믿고 돌린다. 해시는 커밋하는 그 순간의
  // 바이트로 얼린다 — 목록에 적힌 옛 해시와 대조하지 않는다(게이트를 고칠 때마다 모든 커밋이 막혔다).
  // 실행 중에 바뀌면 여전히 거부한다(verifyFrozenPrivateGateInputs).
  let current;
  try {
    current = sha256(fs.readFileSync(privateGateSourcePath(root, entry)));
  } catch {
    throw new Error(`PRIVATE_GATE_NOT_REGULAR: ${entry.path}`);
  }
  const frozen = { ...entry, sha256: current };
  const { source, bytes } = readPrivateGateSource(root, frozen);
  return { entry: { ...frozen, source }, bytes };
}

export function readFrozenPrivateGateInputs(root, names) {
  const entries = process.env.AGENTLAS_PRIVATE_GATE_ALLOWLIST
    ? JSON.parse(fs.readFileSync(process.env.AGENTLAS_PRIVATE_GATE_ALLOWLIST, "utf8")) : [];
  if (!Array.isArray(entries)) throw new Error("INVALID_PRIVATE_GATE_ALLOWLIST");
  const inputs = new Map();
  for (const entry of entries) {
    if (inputs.has(entry?.path)) throw new Error(`INVALID_PRIVATE_GATE_ENTRY: ${entry?.path}`);
    inputs.set(entry.path, normalizePrivateGateEntry(root, names, entry));
  }
  return inputs;
}

export function verifyFrozenPrivateGateInputs(root, inputs) {
  for (const { entry } of inputs.values()) {
    readPrivateGateSource(root, entry, "PRIVATE_GATE_CHANGED_DURING_RUN", true);
  }
}

function validateExternalSource(root, entry) {
  const kind = entry?.kind || "file";
  if (!entry || !["file", "directory"].includes(kind) || !path.isAbsolute(entry.source)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${entry?.target || "unknown"}`);
  }
  externalTargetPath(root, entry.target);
  const source = path.resolve(entry.source);
  if (source === root || source.startsWith(`${root}${path.sep}`)) {
    throw new Error(`PRIVATE_EXTERNAL_SOURCE_IN_SNAPSHOT: ${entry.target}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(source);
    if (fs.realpathSync(source) !== source) throw new Error("PRIVATE_EXTERNAL_SYMLINK");
  } catch {
    throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${entry.target}`);
  }
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${entry.target}`);
  }
  if (kind === "file" && !/^[a-f0-9]{64}$/.test(entry.sha256)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_HASH: ${entry.target}`);
  }
  if (kind === "directory" && !/^[a-f0-9]{64}$/.test(entry.digest)) {
    throw new Error(`INVALID_PRIVATE_EXTERNAL_DIGEST: ${entry.target}`);
  }
  let observed;
  try {
    observed = kind === "file" ? sha256(fs.readFileSync(source)) : externalDigest(source);
  } catch {
    throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${entry.target}`);
  }
  const expected = kind === "file" ? entry.sha256 : entry.digest;
  if (observed !== expected) throw new Error(`PRIVATE_EXTERNAL_HASH_MISMATCH: ${entry.target}`);
}

function readExternalAllowlist(root) {
  const filename = process.env.AGENTLAS_PRIVATE_EXTERNAL_ALLOWLIST;
  if (!filename) return [];
  const absolute = path.resolve(filename);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || fs.realpathSync(absolute) !== absolute) throw new Error("INVALID_PRIVATE_EXTERNAL_ALLOWLIST");
  const manifest = JSON.parse(fs.readFileSync(absolute, "utf8"));
  const entries = manifest?.protocol === 1 && manifest?.scope === "private-frozen-external-dependencies"
    ? manifest.dependencies : null;
  if (!Array.isArray(entries) || entries.length > 128) throw new Error("INVALID_PRIVATE_EXTERNAL_ALLOWLIST");
  const seen = new Set();
  for (const entry of entries) {
    validateExternalSource(root, entry);
    if (seen.has(entry.target)) throw new Error(`INVALID_PRIVATE_EXTERNAL_ENTRY: ${entry.target}`);
    seen.add(entry.target);
  }
  const mobileEntries = entries.filter((entry) => mobileExternalTargets.has(entry.target));
  if (mobileEntries.length > mobileExternalTargets.size || entries.some((entry) => entry.target.startsWith("../mobile/")
    && (!mobileExternalTargets.has(entry.target) || (entry.kind || "file") !== "file"))) {
    throw new Error("INVALID_PRIVATE_EXTERNAL_MOBILE_SCOPE");
  }
  return entries;
}

function verifyExternalTarget(root, entry) {
  const target = externalTargetPath(root, entry.target);
  const stat = fs.lstatSync(target);
  if (fs.realpathSync(target) !== target) throw new Error(`PRIVATE_EXTERNAL_TARGET_SYMLINK: ${entry.target}`);
  if ((entry.kind || "file") === "file") {
    if (!stat.isFile() || sha256(fs.readFileSync(target)) !== entry.sha256) {
      throw new Error(`PRIVATE_EXTERNAL_CONTENT_MISMATCH: ${entry.target}`);
    }
  } else if (!stat.isDirectory() || externalDigest(target) !== entry.digest) {
    throw new Error(`PRIVATE_EXTERNAL_CONTENT_MISMATCH: ${entry.target}`);
  }
}

function copyExternal(root, entry, createdRoots) {
  const target = externalTargetPath(root, entry.target);
  const targetRoot = path.resolve(root, "..", entry.target.split("/")[1]);
  if (!createdRoots.has(targetRoot)) {
    if (fs.existsSync(targetRoot)) throw new Error(`PRIVATE_EXTERNAL_TARGET_EXISTS: ${entry.target}`);
    fs.mkdirSync(targetRoot, { mode: 0o700 });
    createdRoots.add(targetRoot);
  }
  let existingParent = path.dirname(target);
  while (!fs.existsSync(existingParent) && existingParent !== targetRoot) existingParent = path.dirname(existingParent);
  if (fs.existsSync(target) || fs.lstatSync(existingParent).isSymbolicLink()) {
    throw new Error(`PRIVATE_EXTERNAL_TARGET_EXISTS: ${entry.target}`);
  }
  if ((entry.kind || "file") === "file") {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    try {
      const sourceStat = fs.statSync(entry.source);
      fs.writeFileSync(target, fs.readFileSync(entry.source), { mode: sourceStat.mode & 0o777 });
    } catch {
      throw new Error(`PRIVATE_EXTERNAL_NOT_REGULAR: ${entry.target}`);
    }
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.mkdirSync(target, { mode: 0o700 });
  for (const file of externalFiles(entry.source)) {
    const destination = path.join(target, file.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.writeFileSync(destination, fs.readFileSync(file.absolute), { mode: file.mode });
  }
}

function git(root, args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options,
  });
}

function treeEntries(root, tree) {
  return git(root, ["ls-tree", "-r", "-z", tree]).split("\0").filter(Boolean).map((row) => {
    const tab = row.indexOf("\t");
    const [mode, type, oid] = row.slice(0, tab).split(" ");
    const name = row.slice(tab + 1);
    if (!["100644", "100755"].includes(mode) || type !== "blob" || !/^[a-f0-9]{40}$/.test(oid)
      || path.isAbsolute(name) || name.split("/").some((part) => ["..", ".git", "node_modules"].includes(part))
      || name === marker || name === freshnessMarker) {
      throw new Error(`INDEX_SNAPSHOT_UNSUPPORTED_ENTRY: ${name}`);
    }
    return { name, mode, oid };
  });
}

function snapshotStateRoot(root, stateRoot) {
  if (typeof stateRoot !== "string" || path.isAbsolute(stateRoot)
    || path.posix.normalize(stateRoot.replaceAll(path.sep, "/")) !== stateRoot.replaceAll(path.sep, "/")) {
    throw new Error("PRIVATE_FRESHNESS_INVALID_ROOT");
  }
  const resolved = path.resolve(root, stateRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error("PRIVATE_FRESHNESS_INVALID_ROOT");
  }
  try {
    if (fs.realpathSync(resolved) !== resolved) throw new Error("PRIVATE_FRESHNESS_ROOT_SYMLINK");
  } catch (error) {
    if (error?.message === "PRIVATE_FRESHNESS_ROOT_SYMLINK") throw error;
    throw new Error("PRIVATE_FRESHNESS_ROOT_MISSING");
  }
  return resolved;
}

function verifyPrivateTree(root, state) {
  if (!state || !/^[a-f0-9]{40}$/.test(state.tree) || !Array.isArray(state.files)) {
    throw new Error("PRIVATE_FRESHNESS_INVALID_STATE");
  }
  const stateRoot = snapshotStateRoot(root, state.root);
  const seen = new Set();
  for (const file of state.files) {
    if (!file || typeof file.name !== "string" || seen.has(file.name)
      || !["100644", "100755"].includes(file.mode) || !/^[a-f0-9]{40}$/.test(file.oid)
      || path.isAbsolute(file.name) || path.posix.normalize(file.name) !== file.name
      || file.name.split("/").some((part) => ["..", ".git", "node_modules"].includes(part))) {
      throw new Error(`PRIVATE_FRESHNESS_INVALID_FILE: ${file?.name || "unknown"}`);
    }
    seen.add(file.name);
    const absolute = path.resolve(stateRoot, file.name);
    if (absolute !== stateRoot && !absolute.startsWith(`${stateRoot}${path.sep}`)) {
      throw new Error(`PRIVATE_FRESHNESS_INVALID_FILE: ${file.name}`);
    }
    let stat;
    let bytes;
    try {
      stat = fs.lstatSync(absolute);
      bytes = fs.readFileSync(absolute);
      if (fs.realpathSync(absolute) !== absolute) throw new Error("PRIVATE_FRESHNESS_SYMLINK");
    } catch {
      throw new Error(`PRIVATE_FRESHNESS_CONTENT_MISMATCH: ${file.name}`);
    }
    if (!stat.isFile() || blobHash(bytes) !== file.oid
      || Boolean(stat.mode & 0o111) !== (file.mode === "100755")) {
      throw new Error(`PRIVATE_FRESHNESS_CONTENT_MISMATCH: ${file.name}`);
    }
  }
  return stateRoot;
}

export function verifyPrivateFreshnessSnapshot(root, snapshot) {
  if (!snapshot || snapshot.protocol !== 1 || !/^[a-f0-9]{40}$/.test(snapshot.tree)
    || !/^[a-f0-9]{40}$/.test(snapshot.baseTree) || snapshot.tree !== snapshot.index?.tree
    || snapshot.baseTree !== snapshot.head?.tree) {
    throw new Error("PRIVATE_FRESHNESS_INVALID_MANIFEST");
  }
  verifyPrivateTree(root, snapshot.head);
  verifyPrivateTree(root, snapshot.index);
  return snapshot;
}

export function readPrivateFreshnessSnapshot(root, filename) {
  if (typeof filename !== "string" || path.isAbsolute(filename)
    || path.posix.normalize(filename) !== filename) throw new Error("PRIVATE_FRESHNESS_INVALID_MANIFEST");
  const absolute = path.resolve(root, filename);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error("PRIVATE_FRESHNESS_INVALID_MANIFEST");
  }
  let stat;
  let bytes;
  try {
    stat = fs.lstatSync(absolute);
    bytes = fs.readFileSync(absolute, "utf8");
    if (fs.realpathSync(absolute) !== absolute) throw new Error("PRIVATE_FRESHNESS_SYMLINK");
  } catch {
    throw new Error("PRIVATE_FRESHNESS_INVALID_MANIFEST");
  }
  if (!stat.isFile()) throw new Error("PRIVATE_FRESHNESS_INVALID_MANIFEST");
  const snapshot = JSON.parse(bytes);
  return verifyPrivateFreshnessSnapshot(root, snapshot);
}

export function verifySnapshot(root, receipt) {
  if (fs.realpathSync(root) !== receipt.root || fs.existsSync(path.join(root, ".git"))) {
    throw new Error("INDEX_SNAPSHOT_INVALID_ROOT");
  }
  for (const file of receipt.files) {
    const absolute = path.join(root, file.name);
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || blobHash(fs.readFileSync(absolute)) !== file.oid
      || Boolean(stat.mode & 0o111) !== (file.mode === "100755")) {
      throw new Error(`INDEX_SNAPSHOT_CONTENT_MISMATCH: ${file.name}`);
    }
  }
  for (const file of receipt.privateGates || []) {
    const absolute = path.join(root, file.path);
    if (!fs.lstatSync(absolute).isFile() || sha256(fs.readFileSync(absolute)) !== file.sha256) {
      throw new Error(`PRIVATE_GATE_CONTENT_MISMATCH: ${file.path}`);
    }
  }
  for (const dependency of receipt.externalDependencies || []) verifyExternalTarget(root, dependency);
  if (receipt.freshness) verifyPrivateFreshnessSnapshot(root, receipt.freshness);
  for (const name of fs.readdirSync(root).filter((name) => /^\.agentlas-index-build-\d+\.json$/.test(name))) {
    const build = JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
    if (build.tree !== receipt.tree) throw new Error("INDEX_BUILD_TREE_MISMATCH");
    for (const artifact of build.artifacts) {
      const source = receipt.files.find((file) => file.name === artifact.source);
      if (!source || source.oid !== artifact.sourceBlob || !/^dist\/(electron|shared|plugins)\//.test(artifact.output)
        || artifact.output.split("/").includes("..")
        || sha256(fs.readFileSync(path.join(root, artifact.source))) !== artifact.sourceSha256
        || sha256(fs.readFileSync(path.join(root, artifact.output))) !== artifact.outputSha256) {
        throw new Error(`INDEX_BUILD_CONTENT_MISMATCH: ${artifact.output}`);
      }
    }
  }
}

export function readSnapshot(root, filename) {
  if (path.resolve(filename) !== path.join(root, marker)) throw new Error("INDEX_SNAPSHOT_INVALID_RECEIPT");
  const receipt = JSON.parse(fs.readFileSync(filename, "utf8"));
  verifySnapshot(root, receipt);
  return receipt;
}

export function runIndexGates(root) {
  const tree = git(root, ["write-tree"]).trim(); // Conflict/missing object is a failure, never an empty change list.
  const base = git(root, ["rev-parse", "HEAD^{tree}"]).trim();
  const changed = git(root, ["diff-tree", "--no-commit-id", "--no-renames", "--name-only", "-r", "-z", base, tree])
    .split("\0").filter(Boolean);
  const files = treeEntries(root, tree);
  const headFiles = treeEntries(root, base);
  const names = new Set(files.map((file) => file.name));
  // Private verifiers are tools, not product source; they are never called INDEX-owned.
  const privateBytes = readFrozenPrivateGateInputs(root, names);
  const externalDependencies = readExternalAllowlist(root);
  // 오너 결정 2026-09-13: 이번 변경을 물고 있는 이 맥의 게이트(scripts/test-*·verify-*, 공개 저장소라
  // git 밖)는 허용목록에 없어도 거절하지 않고 지금 바이트로 얼려 함께 돌린다. 예전엔 INDEX_GATE_MISSING
  // 으로 막았는데, 목록은 환경변수를 켜야만 읽혀 훅 경로에선 늘 비어 있었고, 그래서 모든 세션이
  // 매번 AGENTLAS_SKIP_PRECOMMIT=1 로 넘어가 게이트가 아무것도 지키지 못했다.
  for (const entry of fs.readdirSync(path.join(root, "scripts"))) {
    const gatePath = `scripts/${entry}`;
    if (!gateName.test(entry) || names.has(gatePath) || privateBytes.has(gatePath)) continue;
    const body = fs.readFileSync(path.join(root, "scripts", entry), "utf8");
    if (changed.some((file) => !generic.has(file) && (file === gatePath || body.includes(file)))) {
      privateBytes.set(gatePath, normalizePrivateGateEntry(root, names, { path: gatePath }));
    }
  }
  const privateGates = [...privateBytes.values()].map(({ entry }) => entry);
  // 같은 이유로, 그 게이트들이 읽는 형제 저장소 파일(허용된 범위만)도 목록 없이 지금 바이트로 복사한다.
  // 없으면 스냅샷 안에서 ../mobile/... 을 못 찾아, 직접 돌리면 통과하는 게이트가 커밋 때만 실패했다.
  const externalTargets = new Set(externalDependencies.map((entry) => entry.target));
  const siblingReference = /\.\.\/(?:mobile|agentlas_terminal|docs)\/[A-Za-z0-9_./-]+/g;
  for (const { bytes } of privateBytes.values()) {
    for (const target of new Set(bytes.toString("utf8").match(siblingReference) || [])) {
      if (externalTargets.has(target)) continue;
      try {
        validateExternalTarget(target);
      } catch {
        continue;
      }
      const source = path.resolve(root, target);
      let stat;
      try {
        stat = fs.lstatSync(source);
      } catch {
        continue;
      }
      if (!stat.isFile() || fs.realpathSync(source) !== source) continue;
      externalDependencies.push({ target, kind: "file", source, sha256: sha256(fs.readFileSync(source)) });
      externalTargets.add(target);
    }
  }
  // Sibling roots (../docs, ../agentlas_terminal, ../mobile) resolve next to the snapshot root. Give every
  // run its own private parent so a crashed run's leftovers can never collide with the next one
  // (a shared os.tmpdir()/docs made every commit fail with PRIVATE_EXTERNAL_TARGET_EXISTS).
  const snapshotParent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlas-index-gates-")));
  const temp = path.join(snapshotParent, "agentlas_desktop");
  fs.mkdirSync(temp, { mode: 0o700 });
  const externalRoots = new Set();
  try {
    const archive = git(root, ["archive", "--format=tar", tree], { encoding: null });
    execFileSync("tar", ["-xf", "-", "-C", temp], { input: archive, stdio: ["pipe", "pipe", "pipe"] });
    const headRoot = path.join(temp, ".agentlas-head-snapshot");
    fs.mkdirSync(headRoot, { mode: 0o700 });
    const headArchive = git(root, ["archive", "--format=tar", base], { encoding: null });
    execFileSync("tar", ["-xf", "-", "-C", headRoot], { input: headArchive, stdio: ["pipe", "pipe", "pipe"] });
    const receipt = {
      version: 1, root: fs.realpathSync(temp), sourceRoot: fs.realpathSync(root), tree, changed, files,
      privateGates: [], dependencies: [], externalDependencies: [], freshness: null,
    };
    // Verification also rejects export-ignore omissions/export-subst transformations.
    verifySnapshot(temp, receipt);
    for (const entry of privateGates) {
      fs.mkdirSync(path.dirname(path.join(temp, entry.path)), { recursive: true });
      const privateGate = privateBytes.get(entry.path);
      fs.writeFileSync(path.join(temp, entry.path), privateGate.bytes);
      receipt.privateGates.push(privateGate.entry);
    }
    for (const entry of externalDependencies) copyExternal(temp, entry, externalRoots);
    receipt.externalDependencies = externalDependencies;
    for (const entry of externalDependencies) verifyExternalTarget(temp, entry);
    const freshness = {
      protocol: 1,
      tree,
      baseTree: base,
      head: { root: ".agentlas-head-snapshot", tree: base, files: headFiles },
      index: { root: ".", tree, files },
    };
    const freshnessText = `${JSON.stringify(freshness)}\n`;
    fs.writeFileSync(path.join(temp, freshnessMarker), freshnessText, { mode: 0o600 });
    verifyPrivateFreshnessSnapshot(temp, freshness);
    receipt.freshness = freshness;
    if (!fs.readFileSync(path.join(temp, "scripts/run-bound-gates.mjs"), "utf8")
      .includes("// index-snapshot-protocol: 1")) throw new Error("INDEX_RUNNER_PROTOCOL_UNSUPPORTED");
    const gatePaths = fs.readdirSync(path.join(temp, "scripts"))
      .filter((name) => gateName.test(name)).map((name) => `scripts/${name}`);
    receipt.expectedGates = gatePaths.filter((gate) => {
      const body = fs.readFileSync(path.join(temp, gate), "utf8");
      return changed.some((file) => !generic.has(file) && (file === gate || body.includes(file)));
    }).sort();
    const dependencies = path.join(root, "node_modules");
    if (fs.existsSync(dependencies)) {
      const resolved = fs.realpathSync(dependencies);
      fs.symlinkSync(resolved, path.join(temp, "node_modules"), "dir");
      receipt.dependencies.push({ path: "node_modules", source: resolved, policy: "read-only; no install or rebuild" });
    }
    fs.writeFileSync(path.join(temp, marker), `${JSON.stringify(receipt)}\n`);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith("GIT_") && !["NODE_PATH", "NODE_OPTIONS", "INIT_CWD", "PWD"].includes(key)));
    env.AGENTLAS_PRIVATE_GATE_FRESHNESS_MANIFEST = freshnessMarker;
    const safeDependencies = receipt.dependencies.map(({ path: dependencyPath, policy }) => ({ path: dependencyPath, policy }));
    const safePrivateGates = privateGates.map(({ path: privatePath, sha256: privateHash }) => ({ path: privatePath, sha256: privateHash }));
    const safeExternalDependencies = externalDependencies.map(({ target, kind = "file", sha256: fileHash, digest }) => ({
      target, kind, ...(fileHash ? { sha256: fileHash } : {}), ...(digest ? { digest } : {}),
    }));
    console.log(`run-bound-gates: INDEX ${tree}; private non-Git snapshot; dependencies ${JSON.stringify(safeDependencies)}`);
    console.log(`run-bound-gates: frozen private verifier allowlist (NOT index source): ${JSON.stringify(safePrivateGates)}`);
    console.log(`run-bound-gates: frozen external dependency allowlist (NOT index source): ${JSON.stringify(safeExternalDependencies)}`);
    const result = spawnSync(process.execPath, [path.join(temp, "scripts/run-bound-gates.mjs"), "--snapshot", path.join(temp, marker)], {
      cwd: temp, env, stdio: "inherit",
    });
    const execution = JSON.parse(fs.readFileSync(path.join(temp, ".agentlas-index-gate-results.json"), "utf8"));
    if (execution.protocol !== 1 || execution.tree !== tree || execution.complete !== true
      || JSON.stringify(execution.gates) !== JSON.stringify(receipt.expectedGates)
      || execution.results.length !== receipt.expectedGates.length
      || execution.results.some((row, i) => row.gate !== receipt.expectedGates[i] || !["PASS", "SELFTEST", "SKIP", "FAIL"].includes(row.status))
      || execution.exitStatus !== result.status) throw new Error("INDEX_RUNNER_RECEIPT_INVALID");
    if (sha256(fs.readFileSync(path.join(temp, freshnessMarker))) !== sha256(Buffer.from(freshnessText))) {
      throw new Error("PRIVATE_FRESHNESS_MANIFEST_CHANGED_DURING_RUN");
    }
    verifyPrivateFreshnessSnapshot(temp, freshness);
    verifySnapshot(temp, receipt);
    verifyFrozenPrivateGateInputs(root, privateBytes);
    for (const entry of externalDependencies) validateExternalSource(root, entry);
    if (process.env.AGENTLAS_GATE_EVIDENCE_DIR) {
      const evidence = path.resolve(process.env.AGENTLAS_GATE_EVIDENCE_DIR);
      if (evidence === root || evidence.startsWith(`${root}${path.sep}`)) throw new Error("EVIDENCE_MUST_BE_OUTSIDE_REPOSITORY");
      fs.mkdirSync(evidence, { recursive: true });
      const builds = fs.readdirSync(temp).filter((name) => /^\.agentlas-index-build-\d+\.json$/.test(name))
        .map((name) => JSON.parse(fs.readFileSync(path.join(temp, name), "utf8")));
      fs.writeFileSync(path.join(evidence, `${tree}.json`), `${JSON.stringify({ ...receipt, execution, builds, exitStatus: result.status }, null, 2)}\n`);
    }
    if (git(root, ["write-tree"]).trim() !== tree) throw new Error("INDEX_CHANGED_DURING_GATES");
    if (result.error) throw result.error;
    return result.status ?? 1;
  } finally {
    // Only the exact directory created above; unlinking node_modules never follows it.
    // External roots are sibling directories created exclusively for this snapshot.
    for (const externalRoot of externalRoots || []) fs.rmSync(externalRoot, { recursive: true, force: true });
    fs.rmSync(snapshotParent, { recursive: true, force: true });
  }
}
