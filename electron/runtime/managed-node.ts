import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_NODE_VERSION = "24.18.0";

interface LockedNodeAsset {
  archiveName: string;
  archiveSha256: string;
  nodeSha256: string;
  npmCliSha256: string;
  runtimeTreeSha256: string;
}

const LOCKED_NODE_ASSETS: Record<string, LockedNodeAsset> = {
  "win32:x64": {
    archiveName: "node-v24.18.0-win-x64.zip",
    archiveSha256: "0ae68406b42d7725661da979b1403ec9926da205c6770827f33aac9d8f26e821",
    nodeSha256: "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "ced095085eece2e24bb5fe957ab94253b6983729f66df9e112b79d5144116eb6",
  },
  "win32:arm64": {
    archiveName: "node-v24.18.0-win-arm64.zip",
    archiveSha256: "f274669adb93b1fd0fbf8f21fd078609e9dcc84333d4f2718d2dde3f9a161a01",
    nodeSha256: "c7225670c3f477778e18c43a55867f7a0d76468221245e5981ab80eb953c8102",
    npmCliSha256: "3ce7cba6f5128dd5f54c98b6a5036b0f850496878cc2e21044b675fe3c594e3e",
    runtimeTreeSha256: "893e18bdab084c0af59c27eb8573f2bd3d2917b76919336efe97f9440039fb97",
  },
  /*
   * macOS — 2026-08-24 추가.
   *
   * 그전까지 이 표에는 윈도우만 있었다. 그래서 **Node 가 없는 맥에서는 CLI 설치 버튼이
   * "npm 을 찾을 수 없습니다"로 끝났다** — 사용자가 할 수 있는 일이 없는 막다른 길이다.
   * 설치 버튼을 누르면 앱이 알아서 준비하는 것이 제품 요구다.
   */
  "darwin:arm64": {
    archiveName: "node-v24.18.0-darwin-arm64.tar.gz",
    archiveSha256: "e1a97e14c99c803e96c7339403282ea05a499c32f8d83defe9ef5ec66f979ed1",
    nodeSha256: "ee6fb0e015284d83a91e8ec5213f43a157f8a392b58555301682892ba928c04a",
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "26d8a5de52cfe628bb3763366380991f417137967bcc211098552026f6dfe92b",
  },
  "darwin:x64": {
    archiveName: "node-v24.18.0-darwin-x64.tar.gz",
    archiveSha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    nodeSha256: "c5afe80c9fd47c0e1ba3a7221173d061dae04577acc67e21e945d16e34c696c8",
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "1e6949b832796ae46e994760086155fd3e7ee73ab7c03616c02748a5f17209c8",
  },
};

/** 플랫폼별 실행 파일 위치. 윈도우는 루트에, 유닉스는 bin/·lib/ 밑에 있다. */
function expectedLayout(platform: NodeJS.Platform): { node: string; npmCli: string } {
  return platform === "win32"
    ? { node: "node.exe", npmCli: "node_modules/npm/bin/npm-cli.js" }
    : { node: "bin/node", npmCli: "lib/node_modules/npm/bin/npm-cli.js" };
}

interface ManagedNodeManifest {
  schemaVersion: "agentlas.node-runtime.v1";
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  archiveName: string;
  archiveSha256: string;
  nodeRelativePath: string;
  nodeSha256: string;
  npmCliRelativePath: string;
  npmCliSha256: string;
  runtimeTreeSha256: string;
}

interface PersistentNodeManifest {
  schemaVersion: "agentlas.node-executable.v1";
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  nodeSha256: string;
  licenseSha256: string;
  sourceRuntimeTreeSha256: string;
}

export interface ManagedNodeRuntime {
  /** Verified packaged runtime root. npm remains here and is used only while the app is running. */
  root: string;
  /** Stable user-owned copy, so portable builds do not leave CLI shims pointing into a deleted temp dir. */
  node: string;
  npmCli: string;
  version: string;
}

export type ManagedNodeResolution =
  | { ok: true; runtime: ManagedNodeRuntime }
  | { ok: false; reason: string };

const EXPECTED_MANIFEST_KEYS = [
  "arch",
  "archiveName",
  "archiveSha256",
  "nodeRelativePath",
  "nodeSha256",
  "nodeVersion",
  "npmCliRelativePath",
  "npmCliSha256",
  "platform",
  "runtimeTreeSha256",
  "schemaVersion",
].sort();

const EXPECTED_PERSISTENT_KEYS = [
  "arch",
  "licenseSha256",
  "nodeSha256",
  "nodeVersion",
  "platform",
  "schemaVersion",
  "sourceRuntimeTreeSha256",
].sort();

let cached: ManagedNodeResolution | null = null;

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function runtimeTreeSha256(root: string): string {
  const records: Array<
    | { kind: "L"; relative: string; target: string }
    | { kind: "F"; relative: string; absolute: string; size: number }
  > = [];
  const walk = (relative = "") => {
    const absolute = path.join(root, ...relative.split("/").filter(Boolean));
    for (const name of fs.readdirSync(absolute).sort()) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === ".gitkeep" || childRelative === "agentlas-node-runtime.json") continue;
      const childAbsolute = path.join(root, ...childRelative.split("/"));
      const stat = fs.lstatSync(childAbsolute);
      if (stat.isDirectory()) walk(childRelative);
      else if (stat.isSymbolicLink()) {
        records.push({ kind: "L", relative: childRelative, target: fs.readlinkSync(childAbsolute) });
      } else if (stat.isFile()) {
        records.push({ kind: "F", relative: childRelative, absolute: childAbsolute, size: stat.size });
      } else {
        throw new Error(`unsupported managed Node runtime entry: ${childRelative}`);
      }
    }
  };
  walk();
  const digest = createHash("sha256");
  for (const record of records.sort((left, right) => left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0)) {
    if (record.kind === "L") {
      digest.update("L\0").update(record.relative).update("\0").update(record.target).update("\n");
    } else {
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(record.size)).update("\0").update(sha256File(record.absolute)).update("\n");
    }
  }
  return digest.digest("hex");
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function candidateRoots(): string[] {
  const roots: string[] = [];
  if (process.resourcesPath) roots.push(path.join(process.resourcesPath, "node-runtime"));
  if (process.env.NODE_ENV === "development") {
    roots.push(path.resolve(__dirname, "..", "..", "..", "build-resources", "node-runtime"));
  }
  return Array.from(new Set(roots));
}

/** Pure verifier exported for contract tests; production resolution never accepts an environment-selected root. */
export function validateManagedNodeRuntimeRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ManagedNodeResolution {
  const manifestPath = path.join(root, "agentlas-node-runtime.json");
  let manifest: ManagedNodeManifest;
  try {
    const rootStat = fs.lstatSync(root);
    const manifestStat = fs.lstatSync(manifestPath);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !manifestStat.isFile() || manifestStat.isSymbolicLink()) {
      return { ok: false, reason: "managed Node root or manifest is not a regular packaged resource" };
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ManagedNodeManifest;
  } catch {
    return { ok: false, reason: "managed Node manifest is missing or invalid" };
  }

  const locked = LOCKED_NODE_ASSETS[`${platform}:${arch}`];
  if (
    !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.keys(manifest).sort().join("\0") !== EXPECTED_MANIFEST_KEYS.join("\0") ||
    manifest.schemaVersion !== "agentlas.node-runtime.v1" ||
    manifest.nodeVersion !== MANAGED_NODE_VERSION ||
    manifest.platform !== platform ||
    manifest.arch !== arch ||
    !locked ||
    manifest.archiveName !== locked.archiveName ||
    manifest.archiveSha256 !== locked.archiveSha256 ||
    manifest.nodeRelativePath !== expectedLayout(platform).node ||
    manifest.nodeSha256 !== locked.nodeSha256 ||
    manifest.npmCliRelativePath !== expectedLayout(platform).npmCli ||
    manifest.npmCliSha256 !== locked.npmCliSha256 ||
    manifest.runtimeTreeSha256 !== locked.runtimeTreeSha256
  ) {
    return { ok: false, reason: "managed Node manifest does not match this app/platform" };
  }

  const node = path.resolve(root, ...manifest.nodeRelativePath.split("/"));
  const npmCli = path.resolve(root, ...manifest.npmCliRelativePath.split("/"));
  if (!isInside(node, root) || !isInside(npmCli, root)) {
    return { ok: false, reason: "managed Node manifest escapes its runtime root" };
  }

  try {
    const rootReal = fs.realpathSync(root);
    const nodeStat = fs.lstatSync(node);
    const npmStat = fs.lstatSync(npmCli);
    if (
      !nodeStat.isFile() || nodeStat.isSymbolicLink() ||
      !npmStat.isFile() || npmStat.isSymbolicLink()
    ) {
      return { ok: false, reason: "managed Node executable or npm CLI is not a regular file" };
    }
    const nodeReal = fs.realpathSync(node);
    const npmReal = fs.realpathSync(npmCli);
    if (!isInside(nodeReal, rootReal) || !isInside(npmReal, rootReal)) {
      return { ok: false, reason: "managed Node executable resolves outside its runtime root" };
    }
    if (
      sha256File(node) !== locked.nodeSha256 ||
      sha256File(npmCli) !== locked.npmCliSha256 ||
      runtimeTreeSha256(root) !== locked.runtimeTreeSha256
    ) {
      return { ok: false, reason: "managed Node runtime checksum verification failed" };
    }
    if (platform !== "win32") fs.accessSync(node, fs.constants.X_OK);
  } catch {
    return { ok: false, reason: "managed Node runtime files are missing or damaged" };
  }

  return { ok: true, runtime: { root, node, npmCli, version: manifest.nodeVersion } };
}

function persistentNodeManifest(
  locked: LockedNodeAsset,
  platform: NodeJS.Platform,
  arch: string,
  licenseSha256: string,
): PersistentNodeManifest {
  return {
    schemaVersion: "agentlas.node-executable.v1",
    nodeVersion: MANAGED_NODE_VERSION,
    platform,
    arch,
    nodeSha256: locked.nodeSha256,
    licenseSha256,
    sourceRuntimeTreeSha256: locked.runtimeTreeSha256,
  };
}

function validatePersistentNode(
  root: string,
  expected: PersistentNodeManifest,
): string | null {
  try {
    const node = path.join(root, "node.exe");
    const license = path.join(root, "LICENSE");
    const manifestPath = path.join(root, "agentlas-node-executable.json");
    const rootStat = fs.lstatSync(root);
    const nodeStat = fs.lstatSync(node);
    const licenseStat = fs.lstatSync(license);
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      !rootStat.isDirectory() || rootStat.isSymbolicLink() ||
      !nodeStat.isFile() || nodeStat.isSymbolicLink() ||
      !licenseStat.isFile() || licenseStat.isSymbolicLink() ||
      !manifestStat.isFile() || manifestStat.isSymbolicLink()
    ) return null;
    const observed = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as PersistentNodeManifest;
    if (
      !observed || typeof observed !== "object" || Array.isArray(observed) ||
      Object.keys(observed).sort().join("\0") !== EXPECTED_PERSISTENT_KEYS.join("\0") ||
      JSON.stringify(observed) !== JSON.stringify(expected) ||
      sha256File(node) !== expected.nodeSha256 ||
      sha256File(license) !== expected.licenseSha256
    ) return null;
    return node;
  } catch {
    return null;
  }
}

function materializePersistentNode(
  packaged: ManagedNodeRuntime,
  platform: NodeJS.Platform,
  arch: string,
  parentOverride?: string,
): ManagedNodeResolution {
  const locked = LOCKED_NODE_ASSETS[`${platform}:${arch}`];
  if (!locked || platform !== "win32") return { ok: true, runtime: packaged };
  const sourceLicense = path.join(packaged.root, "LICENSE");
  let licenseSha256: string;
  try {
    const stat = fs.lstatSync(sourceLicense);
    const rootReal = fs.realpathSync(packaged.root);
    const licenseReal = fs.realpathSync(sourceLicense);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(licenseReal, rootReal)) {
      return { ok: false, reason: "managed Node license is missing from the packaged runtime" };
    }
    licenseSha256 = sha256File(sourceLicense);
  } catch {
    return { ok: false, reason: "managed Node license is missing from the packaged runtime" };
  }

  const parent = parentOverride ?? path.join(os.homedir(), ".agentlas", "runtime", "node");
  const destination = path.join(
    parent,
    `v${MANAGED_NODE_VERSION}-${arch}-${locked.runtimeTreeSha256.slice(0, 16)}`,
  );
  const expected = persistentNodeManifest(locked, platform, arch, licenseSha256);
  const existing = validatePersistentNode(destination, expected);
  if (existing) return { ok: true, runtime: { ...packaged, node: existing } };

  const staging = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
    fs.copyFileSync(packaged.node, path.join(staging, "node.exe"));
    fs.copyFileSync(sourceLicense, path.join(staging, "LICENSE"));
    fs.writeFileSync(
      path.join(staging, "agentlas-node-executable.json"),
      `${JSON.stringify(expected, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    if (!validatePersistentNode(staging, expected)) {
      throw new Error("persistent Node copy failed verification");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    const node = validatePersistentNode(destination, expected);
    if (!node) throw new Error("persistent Node activation failed verification");
    return { ok: true, runtime: { ...packaged, node } };
  } catch {
    fs.rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: "could not create Agentlas's persistent private Node executable" };
  }
}

/** Contract-test seam with an explicit temporary destination; production resolution never calls this export. */
export function materializeManagedNodeRuntimeForTests(
  packagedRoot: string,
  persistentParent: string,
  platform: NodeJS.Platform,
  arch: string,
): ManagedNodeResolution {
  const verified = validateManagedNodeRuntimeRoot(packagedRoot, platform, arch);
  return verified.ok
    ? materializePersistentNode(verified.runtime, platform, arch, persistentParent)
    : verified;
}

/** Resolve, verify, and stabilize the immutable Node+npm runtime shipped with Agentlas. */
export function resolveManagedNodeRuntime(): ManagedNodeResolution {
  if (cached) return cached;
  const failures: string[] = [];
  for (const root of candidateRoots()) {
    const verified = validateManagedNodeRuntimeRoot(root);
    if (verified.ok) {
      cached = materializePersistentNode(verified.runtime, process.platform, process.arch);
      return cached;
    }
    failures.push(verified.reason);
  }
  cached = {
    ok: false,
    reason: failures[0] ?? "managed Node runtime was not bundled",
  };
  return cached;
}

export function clearManagedNodeRuntimeCacheForTests(): void {
  cached = null;
}
