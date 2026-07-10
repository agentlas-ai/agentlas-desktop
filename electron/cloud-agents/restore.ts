import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type {
  CloudAgentCloudScope,
  CloudAgentPackageDownload,
  CloudAgentPackageDownloadFile,
  CloudAgentPackageHashVersion,
  CloudAgentRevisionIdentity,
} from "../../shared/types";

const MAX_TOTAL_BYTES = 3 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 400;
const MARKER_FILE = ".agentlas-cloud-package.json";
const MAX_MARKER_BYTES = 256 * 1024;

interface ValidatedPackageFile {
  path: string;
  bytes: number;
  sha256: string;
  content: Buffer;
  executable: boolean;
}

export interface CloudAgentRestoreMarker {
  schemaVersion?: number;
  source: "agentlas-cloud";
  slug?: string;
  packageHash: string;
  packageHashVersion?: CloudAgentPackageHashVersion;
  fileCount?: number;
  totalBytes?: number;
  /** Portable v2 execution bits for hosts (notably Windows) without POSIX modes. */
  executablePaths?: string[];
  restoredAt?: string;
  /** Per-scope optimistic-concurrency baselines. A local folder may be both
   * owner-private and publicly published, so one scalar revision is unsafe. */
  registrations?: Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>>;
  /** Legacy marker field written by Desktop <=0.7.28. */
  installedAt?: string;
}

export interface CloudAgentRestoreResult {
  path: string;
  packageHash: string;
  previousPackageHash: string | null;
  fileCount: number;
  totalBytes: number;
  changed: boolean;
  reason: "installed" | "updated" | "repaired" | "unchanged";
}

/**
 * Restore an owned Agent Cloud package as an exact local execution copy.
 *
 * The package is fully verified and materialized in a sibling staging folder
 * before the live directory is swapped. A failed validation or write therefore
 * leaves the last usable copy untouched. Replacing the whole directory also
 * removes files that no longer belong to the new package version.
 */
export function restoreCloudAgentPackage(input: {
  destinationDir: string;
  slug: string;
  package: CloudAgentPackageDownload;
  restoredAt?: string;
  registration?: CloudAgentRevisionIdentity;
  /** Registrations from the managed directory that a registry transaction has
   * moved aside. They remain valid baselines for the other Cloud scope. */
  preservedRegistrations?: Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>>;
}): CloudAgentRestoreResult {
  const destinationDir = path.resolve(input.destinationDir);
  const parentDir = path.dirname(destinationDir);
  const validated = validatePackage(input.package);
  assertReplaceableDestination(destinationDir);
  const previousMarker = readCloudAgentRestoreMarker(destinationDir);
  const previousPackageHash = previousMarker?.packageHash ?? null;
  const registration = input.registration
    ? normalizeRegistrationIdentity(input.registration, input.registration.scope)
    : null;
  const preservedRegistrations = normalizeRegistrationMap(input.preservedRegistrations);
  if (
    input.registration &&
    (!registration ||
      registration.slug !== input.slug ||
      registration.packageHash !== validated.packageHash ||
      registration.packageHashVersion !== validated.packageHashVersion)
  ) {
    throw new Error("Agent Cloud restore registration does not match the package snapshot.");
  }
  if (
    preservedRegistrations &&
    Object.values(preservedRegistrations).some((item) => item && item.slug !== input.slug)
  ) {
    throw new Error("Preserved Agent Cloud registration does not match the restore slug.");
  }

  if (isExactRestoredCopy(destinationDir, validated.files, validated.packageHash, validated.packageHashVersion)) {
    if (registration && !sameRegistration(previousMarker?.registrations?.[registration.scope], registration)) {
      writeCloudAgentRegistrationMarker({
        rootPath: destinationDir,
        slug: input.slug,
        packageHash: validated.packageHash,
        packageHashVersion: validated.packageHashVersion,
        fileCount: validated.files.length,
        totalBytes: validated.totalBytes,
        executablePaths: expectedExecutablePaths(validated.files, validated.packageHashVersion),
        registration,
        savedAt: input.restoredAt,
      });
      return {
        path: destinationDir,
        packageHash: validated.packageHash,
        previousPackageHash,
        fileCount: validated.files.length,
        totalBytes: validated.totalBytes,
        changed: true,
        reason: "repaired",
      };
    }
    return {
      path: destinationDir,
      packageHash: validated.packageHash,
      previousPackageHash,
      fileCount: validated.files.length,
      totalBytes: validated.totalBytes,
      changed: false,
      reason: "unchanged",
    };
  }

  fs.mkdirSync(parentDir, { recursive: true });
  const nonce = randomUUID();
  const basename = path.basename(destinationDir);
  const stagingDir = path.join(parentDir, `.${basename}.restore-${nonce}`);
  const backupDir = path.join(parentDir, `.${basename}.backup-${nonce}`);
  let originalMoved = false;
  let stagingMoved = false;

  try {
    fs.mkdirSync(stagingDir, { recursive: false, mode: 0o700 });
    for (const file of validated.files) {
      const target = resolvePackageFile(stagingDir, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, file.content, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
    }

    const restoredAt = input.restoredAt ?? new Date().toISOString();
    const marker: CloudAgentRestoreMarker = {
      schemaVersion: 1,
      source: "agentlas-cloud",
      slug: input.slug,
      packageHash: validated.packageHash,
      packageHashVersion: validated.packageHashVersion,
      fileCount: validated.files.length,
      totalBytes: validated.totalBytes,
      ...(validated.packageHashVersion === "path-sha256-executable-v2"
        ? { executablePaths: expectedExecutablePaths(validated.files, validated.packageHashVersion) }
        : {}),
      restoredAt,
      ...((previousMarker?.registrations || registration)
        ? {
            registrations: {
              ...(previousMarker?.registrations ?? {}),
              ...(preservedRegistrations ?? {}),
              ...(registration ? { [registration.scope]: registration } : {}),
            },
          }
        : {}),
    };
    fs.writeFileSync(
      path.join(stagingDir, MARKER_FILE),
      JSON.stringify(marker, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );

    if (!isExactRestoredCopy(stagingDir, validated.files, validated.packageHash, validated.packageHashVersion)) {
      throw new Error("Agent Cloud restore staging verification failed.");
    }

    if (fs.existsSync(destinationDir)) {
      fs.renameSync(destinationDir, backupDir);
      originalMoved = true;
    }
    fs.renameSync(stagingDir, destinationDir);
    stagingMoved = true;
  } catch (error) {
    if (originalMoved && !fs.existsSync(destinationDir) && fs.existsSync(backupDir)) {
      try {
        fs.renameSync(backupDir, destinationDir);
        originalMoved = false;
      } catch (rollbackError) {
        throw new Error(
          `Agent Cloud restore failed and the previous copy could not be put back: ${errorMessage(error)}; rollback: ${errorMessage(rollbackError)}`,
        );
      }
    }
    throw error;
  } finally {
    if (!stagingMoved) removeTreeBestEffort(stagingDir);
    if (stagingMoved && originalMoved) removeTreeBestEffort(backupDir);
  }

  return {
    path: destinationDir,
    packageHash: validated.packageHash,
    previousPackageHash,
    fileCount: validated.files.length,
    totalBytes: validated.totalBytes,
    changed: true,
    reason:
      previousPackageHash === null
        ? "installed"
        : previousPackageHash === validated.packageHash
          ? "repaired"
          : "updated",
  };
}

export function readCloudAgentRestoreMarker(destinationDir: string): CloudAgentRestoreMarker | null {
  try {
    const root = path.resolve(destinationDir);
    const rootStat = fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return null;
    const rootReal = fs.realpathSync.native(root);
    const markerPath = path.join(rootReal, MARKER_FILE);
    const stableMarker = readStableRegularFile(markerPath, rootReal, MAX_MARKER_BYTES);
    if (!restoredModeMatches(process.platform, stableMarker.mode, false)) return null;
    const bytes = stableMarker.content;
    const parsed = JSON.parse(bytes.toString("utf8")) as Partial<CloudAgentRestoreMarker>;
    const packageHash = normalizeSha256(parsed.packageHash, "marker packageHash");
    const packageHashVersion = normalizePackageHashVersion(parsed.packageHashVersion);
    const executablePaths = normalizeMarkerExecutablePaths(parsed.executablePaths, packageHashVersion);
    const registrations = normalizeRegistrationMap(parsed.registrations);
    if (parsed.source !== "agentlas-cloud") return null;
    if (
      registrations &&
      (typeof parsed.slug !== "string" ||
        Object.values(registrations).some((item) => item && item.slug !== parsed.slug))
    ) return null;
    return {
      ...parsed,
      source: "agentlas-cloud",
      packageHash,
      packageHashVersion,
      executablePaths,
      registrations,
    };
  } catch {
    return null;
  }
}

/** Persist the exact server revision returned after a successful save/publish.
 * The marker is excluded from Cloud package bytes and is the next request's
 * local If-Match authority. */
export function writeCloudAgentRegistrationMarker(input: {
  rootPath: string;
  slug: string;
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  fileCount: number;
  totalBytes: number;
  executablePaths: string[];
  registration: CloudAgentRevisionIdentity;
  savedAt?: string;
}): void {
  const root = path.resolve(input.rootPath);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Agent Cloud sync marker root must be a real directory.");
  }
  const rootReal = fs.realpathSync.native(root);
  const markerPath = path.join(rootReal, MARKER_FILE);
  const existing = fs.existsSync(markerPath) ? readCloudAgentRestoreMarker(rootReal) : null;
  if (fs.existsSync(markerPath) && !existing) {
    throw new Error("Existing Agent Cloud sync marker is unsafe or invalid.");
  }
  const registration = normalizeRegistrationIdentity(input.registration, input.registration.scope);
  if (
    !registration ||
    registration.slug !== input.slug ||
    registration.packageHash !== input.packageHash ||
    registration.packageHashVersion !== input.packageHashVersion
  ) {
    throw new Error("Agent Cloud registration receipt does not match the packaged snapshot.");
  }
  const marker: CloudAgentRestoreMarker = {
    schemaVersion: 1,
    source: "agentlas-cloud",
    slug: input.slug,
    packageHash: normalizeSha256(input.packageHash, "registration packageHash"),
    packageHashVersion: input.packageHashVersion,
    fileCount: input.fileCount,
    totalBytes: input.totalBytes,
    ...(input.packageHashVersion === "path-sha256-executable-v2"
      ? { executablePaths: [...input.executablePaths].sort() }
      : {}),
    restoredAt: input.savedAt ?? new Date().toISOString(),
    registrations: {
      ...(existing?.registrations ?? {}),
      [registration.scope]: registration,
    },
  };
  const tempPath = path.join(rootReal, `.${MARKER_FILE}.tmp-${process.pid}-${randomUUID()}`);
  try {
    const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(marker, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, markerPath);
    if (process.platform !== "win32") fs.chmodSync(markerPath, 0o600);
    fsyncDirectoryBestEffort(rootReal);
  } catch (error) {
    removeFileBestEffort(tempPath);
    throw error;
  }
}

function normalizeRegistrationMap(
  value: unknown,
): Partial<Record<CloudAgentCloudScope, CloudAgentRevisionIdentity>> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const ownerPrivate = normalizeRegistrationIdentity(record["owner-private"], "owner-private");
  const hubPublic = normalizeRegistrationIdentity(record["hub-public"], "hub-public");
  if (!ownerPrivate && !hubPublic) return undefined;
  return {
    ...(ownerPrivate ? { "owner-private": ownerPrivate } : {}),
    ...(hubPublic ? { "hub-public": hubPublic } : {}),
  };
}

function normalizeRegistrationIdentity(
  value: unknown,
  expectedScope: CloudAgentCloudScope,
): CloudAgentRevisionIdentity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<CloudAgentRevisionIdentity>;
  const version = normalizePackageHashVersion(record.packageHashVersion);
  if (
    typeof record.cloudId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(record.cloudId) ||
    typeof record.slug !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(record.slug) ||
    record.scope !== expectedScope ||
    typeof record.revision !== "string" || !/^rev_[a-f0-9]{32}$/.test(record.revision) ||
    typeof record.packageHash !== "string" || !/^[a-f0-9]{64}$/.test(record.packageHash) ||
    (record.packageHashVersion !== "path-sha256-v1" &&
      record.packageHashVersion !== "path-sha256-executable-v2") ||
    (record.updatedAt !== undefined &&
      (typeof record.updatedAt !== "string" || !Number.isFinite(Date.parse(record.updatedAt))))
  ) return null;
  return {
    cloudId: record.cloudId,
    slug: record.slug,
    scope: expectedScope,
    packageHash: record.packageHash,
    packageHashVersion: version,
    revision: record.revision,
    ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
  };
}

function sameRegistration(
  left: CloudAgentRevisionIdentity | undefined,
  right: CloudAgentRevisionIdentity,
): boolean {
  return Boolean(left) &&
    left!.cloudId === right.cloudId &&
    left!.slug === right.slug &&
    left!.scope === right.scope &&
    left!.packageHash === right.packageHash &&
    left!.packageHashVersion === right.packageHashVersion &&
    left!.revision === right.revision &&
    (left!.updatedAt ?? "") === (right.updatedAt ?? "");
}

function validatePackage(pkg: CloudAgentPackageDownload): {
  files: ValidatedPackageFile[];
  packageHash: string;
  packageHashVersion: CloudAgentPackageHashVersion;
  totalBytes: number;
} {
  if (!pkg || !Array.isArray(pkg.files) || pkg.files.length === 0) {
    throw new Error("Agent Cloud package contains no restorable files.");
  }
  if (pkg.files.length > MAX_FILES) {
    throw new Error(`Agent Cloud package exceeds the ${MAX_FILES}-file restore limit.`);
  }
  if (!Number.isSafeInteger(pkg.fileCount) || pkg.fileCount !== pkg.files.length) {
    throw new Error("Agent Cloud package file count does not match its manifest.");
  }

  const packageHashVersion = normalizePackageHashVersion(pkg.packageHashVersion);
  const files: ValidatedPackageFile[] = [];
  const portablePaths = new Map<string, string>();
  const portableDirectories = new Map<string, string>();
  let totalBytes = 0;
  for (const file of pkg.files) {
    const safePath = validatePortableRelativePath(file.path);
    const portableKey = safePath.toLowerCase();
    if (portableKey === MARKER_FILE.toLowerCase()) {
      throw new Error(`Agent Cloud package path is reserved by Desktop: ${safePath}`);
    }
    if (portablePaths.has(portableKey)) {
      throw new Error(`Agent Cloud package has a duplicate cross-platform path: ${safePath}`);
    }
    const parts = safePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const directory = parts.slice(0, index).join("/");
      const directoryKey = portablePathKey(directory);
      const existingDirectory = portableDirectories.get(directoryKey);
      if (existingDirectory && existingDirectory !== directory) {
        throw new Error(
          `Agent Cloud package has colliding cross-platform directory aliases: ${existingDirectory} and ${directory}`,
        );
      }
      portableDirectories.set(directoryKey, directory);
    }
    portablePaths.set(portableKey, safePath);

    const validated = validateFile(file, safePath, packageHashVersion);
    totalBytes += validated.bytes;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(`Agent Cloud package exceeds the ${MAX_TOTAL_BYTES}-byte restore limit.`);
    }
    files.push(validated);
  }
  for (const file of files) {
    const parts = file.path.toLowerCase().split("/");
    for (let index = 1; index < parts.length; index += 1) {
      const parent = portablePathKey(parts.slice(0, index).join("/"));
      if (portablePaths.has(parent)) {
        throw new Error(`Agent Cloud package has a file/directory path collision: ${file.path}`);
      }
    }
  }
  if (!Number.isSafeInteger(pkg.totalBytes) || pkg.totalBytes !== totalBytes) {
    throw new Error("Agent Cloud package byte count does not match its manifest.");
  }

  const packageHash = normalizeSha256(pkg.packageHash, "packageHash");
  const actualHash = hashPackage(files, packageHashVersion);
  if (actualHash !== packageHash) {
    throw new Error("Agent Cloud package hash does not match its files.");
  }
  return { files, packageHash, packageHashVersion, totalBytes };
}

function validateFile(
  file: CloudAgentPackageDownloadFile,
  safePath: string,
  packageHashVersion: CloudAgentPackageHashVersion,
): ValidatedPackageFile {
  if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) {
    throw new Error(`Agent Cloud package file has an invalid byte count: ${safePath}`);
  }
  if (typeof file.contentBase64 !== "string") {
    throw new Error(`Agent Cloud package file is not canonical base64: ${safePath}`);
  }
  const expectedBase64Length = file.bytes === 0 ? 0 : Math.ceil(file.bytes / 3) * 4;
  if (file.contentBase64.length !== expectedBase64Length) {
    throw new Error(`Agent Cloud package file has an invalid encoded length: ${safePath}`);
  }
  if (!isCanonicalBase64(file.contentBase64)) {
    throw new Error(`Agent Cloud package file is not canonical base64: ${safePath}`);
  }
  const content = Buffer.from(file.contentBase64, "base64");
  if (content.length !== file.bytes) {
    throw new Error(`Agent Cloud package file byte count mismatch: ${safePath}`);
  }
  const sha256 = normalizeSha256(file.sha256, `sha256 for ${safePath}`);
  if (hashBytes(content) !== sha256) {
    throw new Error(`Agent Cloud package file hash mismatch: ${safePath}`);
  }
  if (packageHashVersion === "path-sha256-executable-v2" && typeof file.executable !== "boolean") {
    throw new Error(`Agent Cloud v2 package file is missing its executable contract: ${safePath}`);
  }
  if (packageHashVersion === "path-sha256-v1" && file.executable !== undefined) {
    throw new Error(`Agent Cloud legacy v1 package must not carry executable metadata: ${safePath}`);
  }
  return {
    path: safePath,
    bytes: file.bytes,
    sha256,
    content,
    executable: packageHashVersion === "path-sha256-executable-v2" ? file.executable === true : false,
  };
}

function validatePortableRelativePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("\0")
  ) {
    throw new Error(`Unsafe Agent Cloud package path: ${String(value)}`);
  }
  if (value.startsWith("/") || value.endsWith("/") || value.includes("//") || value.length > 260) {
    throw new Error(`Unsafe Agent Cloud package path: ${value}`);
  }
  const parts = value.split("/");
  for (const part of parts) {
    if (!part || part === "." || part === "..") {
      throw new Error(`Unsafe Agent Cloud package path: ${value}`);
    }
    if (/[<>:"|?*\u0000-\u001f]/.test(part) || /[ .]$/.test(part)) {
      throw new Error(`Agent Cloud package path is not portable across supported desktops: ${value}`);
    }
    if (part.length > 255 || Buffer.byteLength(part, "utf8") > 255) {
      throw new Error(`Agent Cloud package path component is too long for a supported desktop: ${value}`);
    }
    if (hasUnpairedSurrogate(part)) {
      throw new Error(`Agent Cloud package path contains invalid Unicode: ${value}`);
    }
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error(`Agent Cloud package path uses a reserved desktop name: ${value}`);
    }
  }
  return parts.join("/");
}

function portablePathKey(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

function normalizeMarkerExecutablePaths(
  value: unknown,
  packageHashVersion: CloudAgentPackageHashVersion,
): string[] {
  if (packageHashVersion === "path-sha256-v1") {
    if (value === undefined) return [];
    throw new Error("Agent Cloud legacy v1 restore marker must not contain executable metadata.");
  }
  if (!Array.isArray(value)) {
    throw new Error("Agent Cloud v2 restore marker is missing executable path metadata.");
  }
  const paths: string[] = [];
  const keys = new Set<string>();
  for (const raw of value) {
    const safe = validatePortableRelativePath(raw as string);
    if (portablePathKey(safe) === portablePathKey(MARKER_FILE)) {
      throw new Error("Agent Cloud restore marker cannot mark itself executable.");
    }
    const key = portablePathKey(safe);
    if (keys.has(key)) throw new Error("Agent Cloud restore marker has duplicate executable paths.");
    keys.add(key);
    paths.push(safe);
  }
  return paths.sort(comparePaths);
}

function expectedExecutablePaths(
  files: ValidatedPackageFile[],
  packageHashVersion: CloudAgentPackageHashVersion,
): string[] {
  if (packageHashVersion === "path-sha256-v1") return [];
  return files.filter((file) => file.executable).map((file) => file.path).sort(comparePaths);
}

function samePaths(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function restoredModeMatches(
  platform: NodeJS.Platform,
  actualMode: number,
  executable: boolean,
): boolean {
  return platform === "win32" || (actualMode & 0o777) === (executable ? 0o700 : 0o600);
}

function restoredDirectoryModeMatches(platform: NodeJS.Platform, actualMode: number): boolean {
  return platform === "win32" || (actualMode & 0o777) === 0o700;
}

function resolvePackageFile(root: string, relPath: string): string {
  const target = path.resolve(root, ...relPath.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Agent Cloud package path escapes the restore folder: ${relPath}`);
  }
  return target;
}

function isExactRestoredCopy(
  destinationDir: string,
  files: ValidatedPackageFile[],
  packageHash: string,
  packageHashVersion: CloudAgentPackageHashVersion,
): boolean {
  const marker = readCloudAgentRestoreMarker(destinationDir);
  if (
    !marker ||
    marker.packageHash !== packageHash ||
    normalizePackageHashVersion(marker.packageHashVersion) !== packageHashVersion ||
    !samePaths(marker.executablePaths ?? [], expectedExecutablePaths(files, packageHashVersion))
  ) return false;
  const expectedFiles = new Map(files.map((file) => [file.path, file]));
  const expectedDirs = expectedDirectorySet(files.map((file) => file.path));
  const actualFiles = new Set<string>();
  let rootReal: string;

  try {
    const rootStat = fs.lstatSync(destinationDir);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
    rootReal = fs.realpathSync.native(destinationDir);
  } catch {
    return false;
  }

  function walk(dir: string, relativeDir: string): boolean {
    let directoryBefore: fs.Stats;
    let directoryRealBefore: string;
    let entries: fs.Dirent[];
    try {
      directoryBefore = fs.lstatSync(dir);
      directoryRealBefore = fs.realpathSync.native(dir);
      if (
        !directoryBefore.isDirectory() ||
        directoryBefore.isSymbolicLink() ||
        !restoredDirectoryModeMatches(process.platform, directoryBefore.mode) ||
        !isPathInsideRoot(rootReal, directoryRealBefore)
      ) {
        return false;
      }
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const absolute = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) return false;
      if (entry.isDirectory()) {
        if (!expectedDirs.has(relative) || !walk(absolute, relative)) return false;
        continue;
      }
      if (!entry.isFile()) return false;
      if (relative === MARKER_FILE) {
        try {
          const stableMarker = readStableRegularFile(absolute, rootReal, MAX_MARKER_BYTES);
          if (!restoredModeMatches(process.platform, stableMarker.mode, false)) return false;
          const liveMarker = JSON.parse(stableMarker.content.toString("utf8")) as Partial<CloudAgentRestoreMarker>;
          if (
            liveMarker.source !== "agentlas-cloud" ||
            normalizeSha256(liveMarker.packageHash, "marker packageHash") !== packageHash ||
            normalizePackageHashVersion(liveMarker.packageHashVersion) !== packageHashVersion ||
            !samePaths(
              normalizeMarkerExecutablePaths(liveMarker.executablePaths, packageHashVersion),
              expectedExecutablePaths(files, packageHashVersion),
            )
          ) {
            return false;
          }
        } catch {
          return false;
        }
        continue;
      }
      const expected = expectedFiles.get(relative);
      if (!expected) return false;
      let content: Buffer;
      try {
        const stable = readStableRegularFile(absolute, rootReal, MAX_FILE_BYTES);
        content = stable.content;
        if (!restoredModeMatches(process.platform, stable.mode, expected.executable)) return false;
      } catch {
        return false;
      }
      if (content.length !== expected.bytes || hashBytes(content) !== expected.sha256) return false;
      actualFiles.add(relative);
    }
    try {
      const directoryAfter = fs.lstatSync(dir);
      const directoryRealAfter = fs.realpathSync.native(dir);
      return (
        directoryAfter.isDirectory() &&
        !directoryAfter.isSymbolicLink() &&
        restoredDirectoryModeMatches(process.platform, directoryAfter.mode) &&
        directoryRealBefore === directoryRealAfter &&
        directoryBefore.dev === directoryAfter.dev &&
        directoryBefore.ino === directoryAfter.ino &&
        directoryBefore.mtimeMs === directoryAfter.mtimeMs &&
        directoryBefore.ctimeMs === directoryAfter.ctimeMs
      );
    } catch {
      return false;
    }
  }
  return walk(destinationDir, "") && actualFiles.size === expectedFiles.size;
}

function readStableRegularFile(
  file: string,
  rootReal: string,
  maxBytes: number,
): { content: Buffer; mode: number } {
  const beforeReal = fs.realpathSync.native(file);
  if (!isPathInsideRoot(rootReal, beforeReal)) throw new Error("restore file resolves outside its root");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error("restore file is not a bounded regular file");
    const chunks: Buffer[] = [];
    let actualBytes = 0;
    for (;;) {
      const remaining = maxBytes + 1 - actualBytes;
      if (remaining <= 0) throw new Error("restore file exceeded its byte limit");
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = fs.readSync(fd, chunk, 0, chunk.byteLength, null);
      if (read === 0) break;
      actualBytes += read;
      if (actualBytes > maxBytes) throw new Error("restore file exceeded its byte limit");
      chunks.push(chunk.subarray(0, read));
    }
    const after = fs.fstatSync(fd);
    const afterReal = fs.realpathSync.native(file);
    const pathStat = fs.lstatSync(file);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      beforeReal !== afterReal ||
      !isPathInsideRoot(rootReal, afterReal) ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode ||
      after.dev !== pathStat.dev ||
      after.ino !== pathStat.ino ||
      after.mode !== pathStat.mode ||
      actualBytes !== after.size
    ) {
      throw new Error("restore file changed while it was being verified");
    }
    return {
      content: Buffer.concat(chunks, actualBytes),
      mode: after.mode & 0o777,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function isPathInsideRoot(rootReal: string, candidateReal: string): boolean {
  const relative = path.relative(rootReal, candidateReal);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function expectedDirectorySet(paths: string[]): Set<string> {
  const directories = new Set<string>();
  for (const filePath of paths) {
    const parts = filePath.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return directories;
}

function assertReplaceableDestination(destinationDir: string): void {
  try {
    const stat = fs.lstatSync(destinationDir);
    if (stat.isSymbolicLink()) {
      throw new Error("Agent Cloud restore destination cannot be a symbolic link.");
    }
    if (!stat.isDirectory()) {
      throw new Error("Agent Cloud restore destination is not a directory.");
    }
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function hashPackage(
  files: ValidatedPackageFile[],
  packageHashVersion: CloudAgentPackageHashVersion,
): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.sha256);
    hash.update("\0");
    if (packageHashVersion === "path-sha256-executable-v2") {
      hash.update(file.executable ? "x" : "-");
      hash.update("\0");
    }
  }
  return hash.digest("hex");
}

function normalizePackageHashVersion(value: unknown): CloudAgentPackageHashVersion {
  if (value === undefined || value === null || value === "path-sha256-v1") return "path-sha256-v1";
  if (value === "path-sha256-executable-v2") return value;
  throw new Error("Agent Cloud package uses an unsupported packageHashVersion.");
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeSha256(value: unknown, label: string): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  const normalized = raw.startsWith("sha256:") ? raw.slice("sha256:".length) : raw;
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new Error(`Agent Cloud ${label} is not a SHA-256 digest.`);
  }
  return normalized;
}

function isCanonicalBase64(value: string): boolean {
  if (value === "") return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, "base64").toString("base64") === value;
}

function removeTreeBestEffort(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
  } catch {
    // The live copy is already valid. A stale sibling is safer than failing the restore.
  }
}

function removeFileBestEffort(target: string): void {
  try {
    fs.unlinkSync(target);
  } catch {
    // Best effort cleanup of an uncommitted temp marker.
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Some supported hosts/filesystems do not allow directory fsync.
  }
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
