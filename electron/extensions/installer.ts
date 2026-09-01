import fs from "node:fs";
import path from "node:path";
import crypto, { randomUUID } from "node:crypto";
import {
  PRODUCT_EXTENSION_INSTALL_SCHEMA,
  compareProductExtensionVersions,
  isProductExtensionId,
  isProductExtensionManifest,
  isSafeProductExtensionPath,
  productExtensionSignedPayload,
  type ProductExtensionInstallReceipt,
  type ProductExtensionManifest,
  type ProductExtensionStatus,
  type ProductExtensionUninstallReceipt,
} from "../../shared/product-extension";

const MANIFEST_NAME = "extension.json";
const CURRENT_NAME = "current.json";
const MAX_MANIFEST_BYTES = 1_048_576;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024 * 1024;

export interface ProductExtensionInstallerOptions {
  rootDir: string;
  /** Durable extension-owned data. Defaults under rootDir for isolated tests. */
  dataRootDir?: string;
  desktopVersion: string;
  trustedPublicKeys: Readonly<Record<string, string>>;
  now?: () => Date;
}

export interface ActiveProductExtension {
  manifest: ProductExtensionManifest;
  releaseDir: string;
  entryPath: string;
}

interface CurrentPointer {
  schema: typeof PRODUCT_EXTENSION_INSTALL_SCHEMA;
  id: string;
  version: string;
  manifestDigest: string;
  installedAt: string;
  enabled: boolean;
}

interface ExtensionLock {
  fd: number;
  filePath: string;
}

function acquireExtensionLock(rootDir: string, id: string): ExtensionLock {
  const root = extensionRoot(rootDir, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const filePath = path.join(root, ".install.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(filePath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
      return { fd, filePath };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = fs.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("invalid-extension-install-lock");
      if (Date.now() - stat.mtimeMs < 15 * 60_000 || attempt > 0) throw new Error("extension-install-busy");
      fs.rmSync(filePath);
    }
  }
  throw new Error("extension-install-busy");
}

function releaseExtensionLock(lock: ExtensionLock | null): void {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch {}
  try {
    const stat = fs.lstatSync(lock.filePath);
    if (!stat.isSymbolicLink() && stat.isFile()) fs.rmSync(lock.filePath);
  } catch {}
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function sha256Text(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function readJsonFile(filePath: string, maxBytes = MAX_MANIFEST_BYTES): unknown {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) throw new Error("invalid-json-file");
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function extensionRoot(rootDir: string, id: string): string {
  if (!isProductExtensionId(id)) throw new Error("invalid-extension-id");
  return path.join(rootDir, id);
}

function releasesRoot(rootDir: string, id: string): string {
  return path.join(extensionRoot(rootDir, id), "releases");
}

function currentPath(rootDir: string, id: string): string {
  return path.join(extensionRoot(rootDir, id), CURRENT_NAME);
}

function stateRoot(options: ProductExtensionInstallerOptions, id: string): string {
  const dataRoot = options.dataRootDir ?? options.rootDir;
  if (!isProductExtensionId(id)) throw new Error("invalid-extension-id");
  return path.join(dataRoot, id, "state");
}

function exactChild(root: string, child: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(root, child);
  if (resolved === resolvedRoot || !resolved.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("path-outside-extension-root");
  return resolved;
}

function manifestPath(sourceDir: string): string {
  return path.join(sourceDir, MANIFEST_NAME);
}

function readManifest(sourceDir: string): ProductExtensionManifest {
  const sourceStat = fs.lstatSync(sourceDir);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error("package-root-must-be-real-directory");
  const value = readJsonFile(manifestPath(sourceDir));
  if (!isProductExtensionManifest(value)) throw new Error("invalid-extension-manifest");
  return value;
}

function assertSignature(manifest: ProductExtensionManifest, keys: Readonly<Record<string, string>>): void {
  const publicKey = keys[manifest.signature.keyId];
  if (!publicKey) throw new Error("untrusted-signing-key");
  const signature = Buffer.from(manifest.signature.value, "base64");
  const valid = crypto.verify(null, Buffer.from(productExtensionSignedPayload(manifest), "utf8"), publicKey, signature);
  if (!valid) throw new Error("invalid-extension-signature");
}

function walkPackage(root: string, relative = ""): string[] {
  const directory = relative ? exactChild(root, relative) : root;
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("package-directory-must-be-real");
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) throw new Error("hidden-package-entry-forbidden");
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (!isSafeProductExtensionPath(child)) throw new Error("unsafe-package-path");
    const childPath = exactChild(root, child);
    const childStat = fs.lstatSync(childPath);
    if (childStat.isSymbolicLink()) throw new Error("package-symlink-forbidden");
    if (childStat.isDirectory()) files.push(...walkPackage(root, child));
    else if (childStat.isFile()) files.push(child);
    else throw new Error("unsupported-package-entry");
  }
  return files;
}

function verifyPackage(sourceDir: string, manifest: ProductExtensionManifest): void {
  const declared = new Map(manifest.files.map((file) => [file.path, file]));
  const actual = walkPackage(sourceDir).filter((file) => file !== MANIFEST_NAME).sort();
  const expected = [...declared.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("extension-file-list-mismatch");
  let total = 0;
  for (const [relative, file] of declared) {
    const filePath = exactChild(sourceDir, relative);
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== file.size) throw new Error(`extension-file-size-mismatch:${relative}`);
    total += stat.size;
    if (total > MAX_PACKAGE_BYTES) throw new Error("extension-package-too-large");
    if (sha256File(filePath) !== file.sha256) throw new Error(`extension-file-digest-mismatch:${relative}`);
  }
}

function copyPackage(sourceDir: string, destinationDir: string, manifest: ProductExtensionManifest): void {
  fs.mkdirSync(destinationDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifestPath(sourceDir), path.join(destinationDir, MANIFEST_NAME), fs.constants.COPYFILE_EXCL);
  for (const file of manifest.files) {
    const destination = exactChild(destinationDir, file.path);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    fs.copyFileSync(exactChild(sourceDir, file.path), destination, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(destination, 0o600);
  }
}

function writeJsonAtomic(target: string, value: unknown): void {
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  const backup = path.join(parent, `.${path.basename(target)}.${randomUUID()}.backup`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  let movedCurrent = false;
  try {
    if (fs.existsSync(target)) {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("atomic-target-must-be-real-file");
      fs.renameSync(target, backup);
      movedCurrent = true;
    }
    fs.renameSync(temporary, target);
    if (movedCurrent) fs.rmSync(backup, { force: true });
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); } catch {}
    try { if (movedCurrent && !fs.existsSync(target) && fs.existsSync(backup)) fs.renameSync(backup, target); } catch {}
    throw error;
  }
}

function readCurrent(rootDir: string, id: string): CurrentPointer | null {
  try {
    const value = readJsonFile(currentPath(rootDir, id)) as Partial<CurrentPointer>;
    if (value.schema !== PRODUCT_EXTENSION_INSTALL_SCHEMA || value.id !== id) return null;
    if (typeof value.version !== "string" || typeof value.manifestDigest !== "string" || typeof value.installedAt !== "string" || typeof value.enabled !== "boolean") return null;
    return value as CurrentPointer;
  } catch {
    return null;
  }
}

function emptyStatus(id: string): ProductExtensionStatus {
  return {
    id,
    phase: "not-installed",
    installed: false,
    enabled: false,
    version: null,
    installedAt: null,
    errorCode: null,
    errorMessage: null,
  };
}

export class ProductExtensionInstaller {
  private readonly options: ProductExtensionInstallerOptions;

  constructor(options: ProductExtensionInstallerOptions) {
    this.options = options;
  }

  status(id: string): ProductExtensionStatus {
    if (!isProductExtensionId(id)) return {
      ...emptyStatus(id),
      phase: "repair-required",
      errorCode: "invalid-extension-id",
      errorMessage: "invalid-extension-id",
    };
    const pointer = readCurrent(this.options.rootDir, id);
    if (!pointer) return emptyStatus(id);
    try {
      const release = exactChild(releasesRoot(this.options.rootDir, id), pointer.version);
      const manifest = readManifest(release);
      assertSignature(manifest, this.options.trustedPublicKeys);
      verifyPackage(release, manifest);
      if (sha256Text(productExtensionSignedPayload(manifest)) !== pointer.manifestDigest) throw new Error("active-manifest-digest-mismatch");
      return {
        id,
        phase: pointer.enabled ? "installed" : "disabled",
        installed: true,
        enabled: pointer.enabled,
        version: pointer.version,
        installedAt: pointer.installedAt,
        errorCode: null,
        errorMessage: null,
      };
    } catch (error) {
      return {
        id,
        phase: "repair-required",
        installed: true,
        enabled: false,
        version: pointer.version,
        installedAt: pointer.installedAt,
        errorCode: error instanceof Error ? error.message.split(":", 1)[0] : "extension-integrity-failed",
        errorMessage: error instanceof Error ? error.message : String(error),
      };
    }
  }

  listStatuses(prefix = ""): ProductExtensionStatus[] {
    if (prefix && (!/^[a-z][a-z0-9-]{0,63}$/.test(prefix) || prefix.length > 64)) throw new Error("invalid-extension-prefix");
    let entries: fs.Dirent[];
    try {
      const rootStat = fs.lstatSync(this.options.rootDir);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("invalid-extension-root");
      entries = fs.readdirSync(this.options.rootDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && isProductExtensionId(entry.name) && entry.name.startsWith(prefix))
      .map((entry) => this.status(entry.name))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  activeRelease(id: string): ActiveProductExtension | null {
    const status = this.status(id);
    if (status.phase !== "installed" || !status.version) return null;
    const releaseDir = exactChild(releasesRoot(this.options.rootDir, id), status.version);
    const manifest = readManifest(releaseDir);
    assertSignature(manifest, this.options.trustedPublicKeys);
    verifyPackage(releaseDir, manifest);
    return {
      manifest,
      releaseDir,
      entryPath: exactChild(releaseDir, manifest.entry),
    };
  }

  installFromDirectory(sourceDir: string): ProductExtensionInstallReceipt {
    let id = "unknown";
    let version: string | null = null;
    let stage = "";
    let lock: ExtensionLock | null = null;
    try {
      const manifest = readManifest(sourceDir);
      id = manifest.id;
      version = manifest.version;
      lock = acquireExtensionLock(this.options.rootDir, id);
      if (compareProductExtensionVersions(this.options.desktopVersion, manifest.minimumDesktopVersion) < 0) {
        throw new Error("desktop-version-incompatible");
      }
      assertSignature(manifest, this.options.trustedPublicKeys);
      verifyPackage(sourceDir, manifest);
      const existing = readCurrent(this.options.rootDir, id);
      if (existing && compareProductExtensionVersions(existing.version, manifest.version) > 0) throw new Error("extension-downgrade-forbidden");
      const manifestDigest = sha256Text(productExtensionSignedPayload(manifest));
      if (existing?.version === manifest.version && existing.manifestDigest === manifestDigest && this.status(id).phase === "installed") {
        return { ok: true, id, action: "unchanged", version, code: null, message: null };
      }

      const releases = releasesRoot(this.options.rootDir, id);
      fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
      fs.mkdirSync(stateRoot(this.options, id), { recursive: true, mode: 0o700 });
      stage = fs.mkdtempSync(path.join(extensionRoot(this.options.rootDir, id), `.stage-${manifest.version}-`));
      copyPackage(sourceDir, stage, manifest);
      const stagedManifest = readManifest(stage);
      assertSignature(stagedManifest, this.options.trustedPublicKeys);
      verifyPackage(stage, stagedManifest);
      const release = exactChild(releases, manifest.version);
      if (fs.existsSync(release)) {
        const currentManifest = readManifest(release);
        assertSignature(currentManifest, this.options.trustedPublicKeys);
        verifyPackage(release, currentManifest);
        if (sha256Text(productExtensionSignedPayload(currentManifest)) !== manifestDigest) throw new Error("release-version-collision");
        fs.rmSync(stage, { recursive: true, force: true });
        stage = "";
      } else {
        fs.renameSync(stage, release);
        stage = "";
      }

      const installedAt = (this.options.now ?? (() => new Date()))().toISOString();
      writeJsonAtomic(currentPath(this.options.rootDir, id), {
        schema: PRODUCT_EXTENSION_INSTALL_SCHEMA,
        id,
        version: manifest.version,
        manifestDigest,
        installedAt,
        enabled: true,
      } satisfies CurrentPointer);
      const finalStatus = this.status(id);
      if (finalStatus.phase !== "installed") throw new Error(finalStatus.errorCode ?? "extension-activation-failed");
      return {
        ok: true,
        id,
        action: existing ? "updated" : "installed",
        version,
        code: null,
        message: null,
      };
    } catch (error) {
      if (stage) {
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* preserve original failure */ }
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, id, action: "failed", version, code: message.split(":", 1)[0], message };
    } finally {
      releaseExtensionLock(lock);
    }
  }

  setEnabled(id: string, enabled: boolean): ProductExtensionStatus {
    if (!isProductExtensionId(id)) return {
      ...emptyStatus(id),
      phase: "repair-required",
      errorCode: "invalid-extension-id",
      errorMessage: "invalid-extension-id",
    };
    let lock: ExtensionLock | null = null;
    try {
      lock = acquireExtensionLock(this.options.rootDir, id);
      const pointer = readCurrent(this.options.rootDir, id);
      if (!pointer) return emptyStatus(id);
      writeJsonAtomic(currentPath(this.options.rootDir, id), { ...pointer, enabled });
      return this.status(id);
    } finally {
      releaseExtensionLock(lock);
    }
  }

  uninstall(id: string): ProductExtensionUninstallReceipt {
    if (!isProductExtensionId(id)) return { ok: false, id, removedVersion: null, dataPreserved: true, code: "invalid-extension-id", message: "invalid-extension-id" };
    let lock: ExtensionLock | null = null;
    try {
      lock = acquireExtensionLock(this.options.rootDir, id);
      const pointer = readCurrent(this.options.rootDir, id);
      if (!pointer) return { ok: true, id, removedVersion: null, dataPreserved: true, code: null, message: null };
      const current = currentPath(this.options.rootDir, id);
      const releases = releasesRoot(this.options.rootDir, id);
      const currentStat = fs.lstatSync(current);
      if (currentStat.isSymbolicLink() || !currentStat.isFile()) throw new Error("invalid-current-pointer");
      if (fs.existsSync(releases)) {
        const releaseStat = fs.lstatSync(releases);
        if (releaseStat.isSymbolicLink() || !releaseStat.isDirectory()) throw new Error("invalid-releases-root");
      }
      fs.rmSync(current);
      if (fs.existsSync(releases)) fs.rmSync(releases, { recursive: true, force: true });
      const durableState = stateRoot(this.options, id);
      fs.mkdirSync(durableState, { recursive: true, mode: 0o700 });
      const expectedDataRoot = path.resolve(this.options.dataRootDir ?? this.options.rootDir);
      if (!path.resolve(durableState).startsWith(`${expectedDataRoot}${path.sep}`)) throw new Error("invalid-state-root");
      return { ok: true, id, removedVersion: pointer.version, dataPreserved: true, code: null, message: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, id, removedVersion: null, dataPreserved: true, code: message.split(":", 1)[0], message };
    } finally {
      releaseExtensionLock(lock);
    }
  }
}
