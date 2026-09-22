import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MANAGED_NODE_VERSION = "24.18.0";

interface LockedNodeAsset {
  archiveName: string;
  archiveSha256: string;
  nodeSha256: string;
  /** Upstream `bin/node` size. Needed to rebuild the tree digest when macOS re-signing changed the file. */
  nodeByteLength?: number;
  npmCliSha256: string;
  runtimeTreeSha256: string;
}

/*
 * ★ macOS 배포본의 bin/node 는 업스트림 파일이 아니다 (2026-09-13 실측).
 *
 * electron-builder 가 공증을 위해 번들 안의 모든 Mach-O 를 우리 Developer ID 로 다시 서명한다.
 * 그래서 설치된 1.2.0 의 bin/node 는 sha256 이 38707d62…(잠금값 ee6fb0e0…과 다름, 288바이트 큼)이고
 * 서명 주체는 "Developer ID Application: … (F469CGM7T5)" 다. 이 파일은 맥 서명 배포본에서는
 * **절대로** 잠금 해시와 같을 수 없었고, 그 결과 내장 Node 검증 → 로컬 모델 엔진 서명검증 →
 * 엔진 설치가 맥 프로덕션에서 단 한 번도 성공한 적이 없다(로그: engine_attestation_managed_runtime_unavailable,
 * 검증 자식의 실제 사유는 "checksum verification failed" — 타임아웃이 아니었다).
 *
 * 규칙: 내용 해시가 다르면, 맥에서는 그 파일이 우리 팀의 Developer ID 로 서명된 Mach-O 일 때만 받는다.
 * 릴리스 파이프라인은 서명 전에 업스트림 해시를 검사(after-pack-clean.cjs)하고, 서명 뒤에 이 검증기를
 * 다시 돌린다(after-sign-trust.cjs). 사슬: 업스트림 해시 → 우리 서명 → 실행 시 서명 검증.
 * 트리 지문은 그 파일 자리에 잠금 해시·잠금 크기를 대입해 계산하므로 잠금 상수는 그대로다.
 */
const MAC_RELEASE_TEAM_IDENTIFIER = "F469CGM7T5";
export const MAC_RELEASE_NODE_REQUIREMENT = `identifier "node" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${MAC_RELEASE_TEAM_IDENTIFIER}"`;
const MACHO_MAGICS = new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]);

function defaultMacReleaseNodeSignatureVerifier(node: string): boolean {
  try {
    const header = Buffer.alloc(4);
    const fd = fs.openSync(node, "r");
    try { if (fs.readSync(fd, header, 0, 4, 0) !== 4) return false; } finally { fs.closeSync(fd); }
    if (!MACHO_MAGICS.has(header.readUInt32BE(0))) return false;
    const result = spawnSync("/usr/bin/codesign", ["--verify", "--strict", `-R=${MAC_RELEASE_NODE_REQUIREMENT}`, node], {
      stdio: ["ignore", "ignore", "ignore"], timeout: 30_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

let macReleaseNodeSignatureVerifier = defaultMacReleaseNodeSignatureVerifier;

/** Contract-test seam only: production always runs /usr/bin/codesign against the pinned requirement. */
export function setMacReleaseNodeSignatureVerifierForTests(verifier: ((node: string) => boolean) | null): void {
  macReleaseNodeSignatureVerifier = verifier ?? defaultMacReleaseNodeSignatureVerifier;
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
    nodeByteLength: 120_965_360,
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "26d8a5de52cfe628bb3763366380991f417137967bcc211098552026f6dfe92b",
  },
  /*
   * Linux — 2026-09-13 추가. fetch-node-runtime.mjs 는 2026-08-24 부터 리눅스 런타임을 싣고
   * 있었지만 이 표에는 없어서, 리눅스 배포본(AppImage/deb)에서 내장 Node 검증이 "manifest does
   * not match this app/platform" 으로 항상 실패했다 — 로컬 모델 엔진 설치도 함께. 값은 업스트림
   * tarball 을 내려받아 다시 계산해 fetch 스크립트와 같음을 확인했다.
   */
  "linux:x64": {
    archiveName: "node-v24.18.0-linux-x64.tar.gz",
    archiveSha256: "783130984963db7ba9cbd01089eaf2c2efb055c7c1693c943174b967b3050cb8",
    nodeSha256: "41a74efb34cbde5c7632cdac0cf8bd1a14d0b8d73dc1e82755014d9a9ce70f5c",
    nodeByteLength: 123_655_872,
    npmCliSha256: "8e5f6f3429f8cdbe693cdc29904e9d5a7b127a494bd15c804bd54c7403bfcbe7",
    runtimeTreeSha256: "0cf5b57f8ee6e3adef701ba484b82921e6bbb65c17b7020a7bcdac72bbbc0488",
  },
  "darwin:x64": {
    archiveName: "node-v24.18.0-darwin-x64.tar.gz",
    archiveSha256: "dfd0dbd3e721503434df7b7205e719f61b3a3a31b2bcf9729b8b91fea240f080",
    nodeSha256: "c5afe80c9fd47c0e1ba3a7221173d061dae04577acc67e21e945d16e34c696c8",
    nodeByteLength: 123_320_000,
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

const ASYNC_VERIFY_CHILD_ARG = "--agentlas-verify-managed-node-runtime";
const ASYNC_VERIFY_SCHEMA = "agentlas.managed-node-verification.v1";
const ASYNC_VERIFY_TIMEOUT_MS = 15_000;
const ASYNC_VERIFY_OUTPUT_LIMIT = 8 * 1024;
const activeAsyncVerificationChildren = new Set<ChildProcess>();
let asyncVerificationTail: Promise<void> = Promise.resolve();

interface RuntimePathIdentity {
  realPath: string;
  dev: string;
  ino: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  birthtimeNs: string;
  kind: "directory" | "file";
}

interface RuntimeRootIdentity {
  root: RuntimePathIdentity;
  manifest: RuntimePathIdentity;
  node: RuntimePathIdentity;
  npmCli: RuntimePathIdentity;
}

interface AsyncVerificationReceipt {
  schemaVersion: typeof ASYNC_VERIFY_SCHEMA;
  resolution: ManagedNodeResolution;
}

type AsyncVerificationStatus =
  | "verified"
  | "rejected"
  | "cancelled"
  | "timed_out"
  | "unavailable"
  | "invalid_receipt"
  | "output_overflow";

interface AsyncVerificationResult {
  status: AsyncVerificationStatus;
  resolution: ManagedNodeResolution;
}

export interface ResolveManagedNodeRuntimeAsyncOptions {
  /** Security-sensitive consumers revalidate the full supplied runtime tree. */
  forceVerify?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

interface TreeRecordSubstitute { relative: string; size: number; sha256: string }

/**
 * `substitute` stands in for one file whose bytes were verified another way
 * (the re-signed macOS node): its locked size and hash enter the digest so the
 * pinned tree constant keeps meaning "the upstream tree, nothing added".
 */
function runtimeTreeSha256(root: string, substitute?: TreeRecordSubstitute): string {
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
    } else if (substitute && record.relative === substitute.relative) {
      digest.update("F\0").update(record.relative).update("\0")
        .update(String(substitute.size)).update("\0").update(substitute.sha256).update("\n");
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

function pathIdentity(filePath: string, kind: RuntimePathIdentity["kind"]): RuntimePathIdentity {
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error("managed Node runtime identity is not a regular path");
  }
  return {
    realPath: fs.realpathSync(filePath),
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    birthtimeNs: String(stat.birthtimeNs),
    kind,
  };
}

function managedNodeRootIdentity(root: string, platform: NodeJS.Platform): RuntimeRootIdentity {
  const layout = expectedLayout(platform);
  return {
    root: pathIdentity(root, "directory"),
    manifest: pathIdentity(path.join(root, "agentlas-node-runtime.json"), "file"),
    node: pathIdentity(path.join(root, ...layout.node.split("/")), "file"),
    npmCli: pathIdentity(path.join(root, ...layout.npmCli.split("/")), "file"),
  };
}

function managedNodeRootIdentityEqual(left: RuntimeRootIdentity, right: RuntimeRootIdentity): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
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
    let substitute: TreeRecordSubstitute | undefined;
    if (sha256File(node) !== locked.nodeSha256) {
      // Only a macOS release bundle may differ, and only because our own Developer ID re-signed it.
      if (platform !== "darwin" || !locked.nodeByteLength || !macReleaseNodeSignatureVerifier(node)) {
        return { ok: false, reason: "managed Node runtime checksum verification failed" };
      }
      substitute = { relative: manifest.nodeRelativePath, size: locked.nodeByteLength, sha256: locked.nodeSha256 };
    }
    if (
      sha256File(npmCli) !== locked.npmCliSha256 ||
      runtimeTreeSha256(root, substitute) !== locked.runtimeTreeSha256
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

/**
 * Where a Windows persistent copy may live, best first.
 *
 * `%LOCALAPPDATA%` is the conventional per-user application directory: folder
 * redirection and cloud sync clients leave it alone, while the user profile
 * root can be redirected, synced, or covered by ransomware protection. The home
 * path stays first so existing installs keep the copy they already validated.
 */
function persistentNodeParents(): string[] {
  const parents = [path.join(os.homedir(), ".agentlas", "runtime", "node")];
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) parents.push(path.join(localAppData, "Agentlas", "runtime", "node"));
  return [...new Set(parents)];
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code) return code;
  return error instanceof Error ? error.constructor.name : "unknown";
}

/**
 * Leave a content-free breadcrumb for a materialization that fell back.
 *
 * The user must never be asked to read an error string back to us, so the app
 * records the failing step and its errno itself. Never raises: an unwritable
 * breadcrumb must not be able to affect the install it is describing.
 */
function recordMaterializeFallback(detail: string): void {
  try {
    const dir = path.join(os.homedir(), ".agentlas", "runtime");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(dir, "node-materialize-fallback.json"),
      `${JSON.stringify({
        schemaVersion: "agentlas.node-materialize-fallback.v1",
        at: new Date().toISOString(),
        platform: process.platform,
        arch: process.arch,
        nodeVersion: MANAGED_NODE_VERSION,
        detail,
      }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Observability is best-effort by construction.
  }
}

function copyPersistentNode(
  parent: string,
  packaged: ManagedNodeRuntime,
  locked: LockedNodeAsset,
  platform: NodeJS.Platform,
  arch: string,
  sourceLicense: string,
  licenseSha256: string,
): { node: string } | { error: string } {
  const destination = path.join(
    parent,
    `v${MANAGED_NODE_VERSION}-${arch}-${locked.runtimeTreeSha256.slice(0, 16)}`,
  );
  const expected = persistentNodeManifest(locked, platform, arch, licenseSha256);
  const existing = validatePersistentNode(destination, expected);
  if (existing) return { node: existing };

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
      throw new Error("copy-verification-failed");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    const node = validatePersistentNode(destination, expected);
    if (!node) throw new Error("activation-verification-failed");
    return { node };
  } catch (error) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* staging already gone */ }
    return { error: errorCode(error) };
  }
}

/**
 * Windows only: keep a copy of `node.exe` outside the app folder.
 *
 * ★ This is a DURABILITY optimization, not a correctness requirement.
 *   It exists so the portable build can be deleted while an already-installed
 *   CLI keeps running (verify-cli-bootstrap-contract.cjs states that contract).
 *   The CLI works perfectly well from the packaged executable, which has
 *   already passed checksum verification by the time we get here.
 *
 * ★ Before 2026-09-23 every failure here ended the install with
 *   "could not create Agentlas's persistent private Node executable", which
 *   `resolveNpmRunner` turned into "Reinstall or update Agentlas Desktop".
 *   On Windows a single copy or rename can fail for entirely ordinary reasons —
 *   antivirus holding a freshly written .exe, a sync client locking the folder,
 *   a leftover node process pinning the destination — so a first install could
 *   die on a machine where nothing was actually wrong, and reinstalling the app
 *   could not fix it. A later-only benefit must never block the first run.
 *   Failure now falls back to the packaged executable and leaves a breadcrumb;
 *   the next launch retries the copy.
 */
function materializePersistentNode(
  packaged: ManagedNodeRuntime,
  platform: NodeJS.Platform,
  arch: string,
  parentOverride?: string,
): ManagedNodeResolution {
  const locked = LOCKED_NODE_ASSETS[`${platform}:${arch}`];
  if (!locked || platform !== "win32") return { ok: true, runtime: packaged };

  const fallback = (detail: string): ManagedNodeResolution => {
    recordMaterializeFallback(detail);
    return { ok: true, runtime: packaged };
  };

  const sourceLicense = path.join(packaged.root, "LICENSE");
  let licenseSha256: string;
  try {
    const stat = fs.lstatSync(sourceLicense);
    const rootReal = fs.realpathSync(packaged.root);
    const licenseReal = fs.realpathSync(sourceLicense);
    if (!stat.isFile() || stat.isSymbolicLink() || !isInside(licenseReal, rootReal)) {
      return fallback("license:not-a-regular-file-inside-root");
    }
    licenseSha256 = sha256File(sourceLicense);
  } catch (error) {
    return fallback(`license:${errorCode(error)}`);
  }

  const parents = parentOverride ? [parentOverride] : persistentNodeParents();
  const failures: string[] = [];
  for (const parent of parents) {
    const outcome = copyPersistentNode(parent, packaged, locked, platform, arch, sourceLicense, licenseSha256);
    if ("node" in outcome) return { ok: true, runtime: { ...packaged, node: outcome.node } };
    failures.push(outcome.error);
  }
  return fallback(`copy:${failures.join(",")}`);
}

function resolveManagedNodeRuntimeRoot(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
  persistentParent?: string,
): ManagedNodeResolution {
  const verified = validateManagedNodeRuntimeRoot(root, platform, arch);
  return verified.ok
    ? materializePersistentNode(verified.runtime, platform, arch, persistentParent)
    : verified;
}

/**
 * Contract-test seam for the durability fallback.
 *
 * Drives `materializePersistentNode` with an already-verified runtime so the
 * "a failed copy must not end the install" contract can be asserted from any
 * host platform, not only from Windows.
 */
export function materializePersistentNodeForTests(
  packaged: ManagedNodeRuntime,
  platform: NodeJS.Platform,
  arch: string,
  parentOverride: string,
): ManagedNodeResolution {
  return materializePersistentNode(packaged, platform, arch, parentOverride);
}

/** Contract-test seam with an explicit temporary destination; production resolution never calls this export. */
export function materializeManagedNodeRuntimeForTests(
  packagedRoot: string,
  persistentParent: string,
  platform: NodeJS.Platform,
  arch: string,
): ManagedNodeResolution {
  return resolveManagedNodeRuntimeRoot(packagedRoot, platform, arch, persistentParent);
}

/** Resolve, verify, and stabilize the immutable Node+npm runtime shipped with Agentlas. */
export function resolveManagedNodeRuntime(): ManagedNodeResolution {
  if (cached) return cached;
  const failures: string[] = [];
  for (const root of candidateRoots()) {
    const resolution = resolveManagedNodeRuntimeRoot(root, process.platform, process.arch);
    if (resolution.ok) {
      cached = resolution;
      return cached;
    }
    failures.push(resolution.reason);
  }
  cached = {
    ok: false,
    reason: failures[0] ?? "managed Node runtime was not bundled",
  };
  return cached;
}

function expectedResolvedNodePath(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
  materializePersistent: boolean,
): string | null {
  const layout = expectedLayout(platform);
  if (platform !== "win32" || !materializePersistent) return path.join(root, ...layout.node.split("/"));
  const locked = LOCKED_NODE_ASSETS[`${platform}:${arch}`];
  if (!locked) return null;
  return path.join(
    os.homedir(),
    ".agentlas",
    "runtime",
    "node",
    `v${MANAGED_NODE_VERSION}-${arch}-${locked.runtimeTreeSha256.slice(0, 16)}`,
    "node.exe",
  );
}

function parseAsyncVerificationReceipt(
  raw: string,
  expectedRoot: string,
  platform: NodeJS.Platform,
  arch: string,
  materializePersistent: boolean,
): AsyncVerificationResult | null {
  try {
    const value = JSON.parse(raw) as Partial<AsyncVerificationReceipt>;
    const expectedNode = expectedResolvedNodePath(expectedRoot, platform, arch, materializePersistent);
    const expectedNpmCli = path.join(expectedRoot, ...expectedLayout(platform).npmCli.split("/"));
    if (
      !value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== ["resolution", "schemaVersion"].join("\0") ||
      value.schemaVersion !== ASYNC_VERIFY_SCHEMA ||
      !value.resolution || typeof value.resolution !== "object" || Array.isArray(value.resolution)
    ) return null;
    const resolution = value.resolution;
    if (typeof resolution.ok !== "boolean") return null;
    if (!resolution.ok) {
      if (
        Object.keys(resolution).sort().join("\0") !== ["ok", "reason"].join("\0") ||
        typeof resolution.reason !== "string" || resolution.reason.length < 1 || resolution.reason.length > 240
      ) return null;
      return { status: "rejected", resolution: { ok: false, reason: resolution.reason } };
    }
    if (
      Object.keys(resolution).sort().join("\0") !== ["ok", "runtime"].join("\0") ||
      !resolution.runtime || typeof resolution.runtime !== "object" || Array.isArray(resolution.runtime) ||
      Object.keys(resolution.runtime).sort().join("\0") !== ["node", "npmCli", "root", "version"].join("\0") ||
      resolution.runtime.root !== expectedRoot ||
      resolution.runtime.version !== MANAGED_NODE_VERSION ||
      !expectedNode ||
      path.resolve(resolution.runtime.node) !== path.resolve(expectedNode) ||
      path.resolve(resolution.runtime.npmCli) !== path.resolve(expectedNpmCli)
    ) return null;
    return {
      status: "verified",
      resolution: {
        ok: true,
        runtime: {
          root: resolution.runtime.root,
          node: resolution.runtime.node,
          npmCli: resolution.runtime.npmCli,
          version: resolution.runtime.version,
        },
      },
    };
  } catch {
    return null;
  }
}

function terminateAsyncVerificationChild(child: ChildProcess): void {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  const hardKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }
  }, 250);
  hardKill.unref();
}

function verifyManagedNodeRuntimeRootInChild(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
  materializePersistent: boolean,
  options: ResolveManagedNodeRuntimeAsyncOptions,
): Promise<AsyncVerificationResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({
      status: "cancelled",
      resolution: { ok: false, reason: "managed Node runtime verification cancelled" },
    });
  }
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let overflowed = false;
    let stopResult: AsyncVerificationResult | null = null;
    let child: ChildProcess;
    let timeout: NodeJS.Timeout;
    let forcedSettle: NodeJS.Timeout | null = null;
    const finish = (result: AsyncVerificationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forcedSettle) clearTimeout(forcedSettle);
      options.signal?.removeEventListener("abort", onAbort);
      activeAsyncVerificationChildren.delete(child);
      resolve(result);
    };
    const stop = (result: AsyncVerificationResult) => {
      if (settled || stopResult) return;
      stopResult = result;
      terminateAsyncVerificationChild(child);
      forcedSettle = setTimeout(() => finish(result), 1_000);
      forcedSettle.unref();
    };
    const onAbort = () => {
      stop({
        status: "cancelled",
        resolution: { ok: false, reason: "managed Node runtime verification cancelled" },
      });
    };
    try {
      child = spawn(process.execPath, [__filename, ASYNC_VERIFY_CHILD_ARG], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      resolve({
        status: "unavailable",
        resolution: { ok: false, reason: "managed Node runtime verifier could not start" },
      });
      return;
    }
    activeAsyncVerificationChildren.add(child);
    timeout = setTimeout(() => {
      stop({
        status: "timed_out",
        resolution: { ok: false, reason: "managed Node runtime verification timed out" },
      });
    }, Math.max(25, Math.min(60_000, Math.trunc(options.timeoutMs ?? ASYNC_VERIFY_TIMEOUT_MS))));
    timeout.unref();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (overflowed) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf8") > ASYNC_VERIFY_OUTPUT_LIMIT) {
        overflowed = true;
        output = "";
        stop({
          status: "output_overflow",
          resolution: { ok: false, reason: "managed Node runtime verifier returned too much data" },
        });
      }
    });
    child.once("error", () => finish({
      status: "unavailable",
      resolution: { ok: false, reason: "managed Node runtime verifier could not start" },
    }));
    child.once("close", (code) => {
      if (settled) return;
      if (stopResult) {
        finish(stopResult);
        return;
      }
      if (overflowed) {
        finish({
          status: "output_overflow",
          resolution: { ok: false, reason: "managed Node runtime verifier returned too much data" },
        });
        return;
      }
      const parsed = code === 0
        ? parseAsyncVerificationReceipt(output, root, platform, arch, materializePersistent)
        : null;
      finish(parsed ?? {
        status: "invalid_receipt",
        resolution: { ok: false, reason: "managed Node runtime verifier returned an invalid receipt" },
      });
    });
    child.stdin?.on("error", () => { /* close/error owns the typed result */ });
    child.stdin?.end(JSON.stringify({ root, platform, arch, materializePersistent }));
  });
}

/**
 * Verify the packaged runtime outside Electron Main, then bind the receipt to
 * the same root/manifest/entrypoint identities observed before and after the
 * child. Production never accepts an environment-selected trust root.
 */
async function resolveManagedNodeRuntimeAsyncOnce(
  options: ResolveManagedNodeRuntimeAsyncOptions = {},
): Promise<ManagedNodeResolution> {
  if (cached && !options.forceVerify) return cached;
  if (options.signal?.aborted) return { ok: false, reason: "managed Node runtime verification cancelled" };
  const failures: string[] = [];
  for (const root of candidateRoots()) {
    if (options.signal?.aborted) return { ok: false, reason: "managed Node runtime verification cancelled" };
    let before: RuntimeRootIdentity;
    try {
      before = managedNodeRootIdentity(root, process.platform);
    } catch {
      failures.push("managed Node manifest is missing or invalid");
      continue;
    }
    const attempt = await verifyManagedNodeRuntimeRootInChild(root, process.platform, process.arch, true, options);
    if (attempt.status === "cancelled") return attempt.resolution;
    if (attempt.status === "timed_out") return attempt.resolution;
    if (attempt.status !== "verified" && attempt.status !== "rejected") return attempt.resolution;
    if (!attempt.resolution.ok) {
      failures.push(attempt.resolution.reason);
      continue;
    }
    try {
      if (!managedNodeRootIdentityEqual(before, managedNodeRootIdentity(root, process.platform))) {
        return { ok: false, reason: "managed Node runtime identity changed during verification" };
      }
    } catch {
      return { ok: false, reason: "managed Node runtime identity changed during verification" };
    }
    cached = attempt.resolution;
    return cached;
  }
  cached = { ok: false, reason: failures[0] ?? "managed Node runtime was not bundled" };
  return cached;
}

function enqueueAsyncVerification(work: () => Promise<ManagedNodeResolution>): Promise<ManagedNodeResolution> {
  const result = asyncVerificationTail.then(work, work);
  asyncVerificationTail = result.then(() => undefined, () => undefined);
  return result;
}

export function resolveManagedNodeRuntimeAsync(
  options: ResolveManagedNodeRuntimeAsyncOptions = {},
): Promise<ManagedNodeResolution> {
  return enqueueAsyncVerification(() => resolveManagedNodeRuntimeAsyncOnce(options));
}

/** Contract-test seam: production callers cannot choose a trust root. */
export function validateManagedNodeRuntimeRootAsyncForTests(
  root: string,
  platform: NodeJS.Platform,
  arch: string,
  options: ResolveManagedNodeRuntimeAsyncOptions = {},
): Promise<ManagedNodeResolution> {
  return enqueueAsyncVerification(async () => {
    if (options.signal?.aborted) return { ok: false, reason: "managed Node runtime verification cancelled" };
    let before: RuntimeRootIdentity;
    try {
      before = managedNodeRootIdentity(root, platform);
    } catch {
      return { ok: false, reason: "managed Node manifest is missing or invalid" };
    }
    const attempt = await verifyManagedNodeRuntimeRootInChild(root, platform, arch, false, options);
    if (!attempt.resolution.ok) return attempt.resolution;
    try {
      if (!managedNodeRootIdentityEqual(before, managedNodeRootIdentity(root, platform))) {
        return { ok: false, reason: "managed Node runtime identity changed during verification" };
      }
    } catch {
      return { ok: false, reason: "managed Node runtime identity changed during verification" };
    }
    return attempt.resolution;
  });
}

export function managedNodeRuntimeVerificationChildCountForTests(): number {
  return activeAsyncVerificationChildren.size;
}

export function clearManagedNodeRuntimeCacheForTests(): void {
  cached = null;
}

if (require.main === module && process.argv[2] === ASYNC_VERIFY_CHILD_ARG) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
    if (Buffer.byteLength(input, "utf8") > ASYNC_VERIFY_OUTPUT_LIMIT) process.exit(2);
  });
  process.stdin.on("end", () => {
    try {
      const value = JSON.parse(input) as {
        root?: unknown;
        platform?: unknown;
        arch?: unknown;
        materializePersistent?: unknown;
      };
      if (
        !value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join("\0") !== ["arch", "materializePersistent", "platform", "root"].join("\0") ||
        typeof value.root !== "string" || !path.isAbsolute(value.root) ||
        typeof value.platform !== "string" || typeof value.arch !== "string" ||
        typeof value.materializePersistent !== "boolean"
      ) process.exit(2);
      const resolution = value.materializePersistent
        ? resolveManagedNodeRuntimeRoot(value.root, value.platform as NodeJS.Platform, value.arch)
        : validateManagedNodeRuntimeRoot(value.root, value.platform as NodeJS.Platform, value.arch);
      const receipt: AsyncVerificationReceipt = { schemaVersion: ASYNC_VERIFY_SCHEMA, resolution };
      process.stdout.write(JSON.stringify(receipt), () => process.exit(0));
    } catch {
      process.exit(2);
    }
  });
}
