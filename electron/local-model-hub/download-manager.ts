import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  LocalEnginePackageIdentity,
  LocalModelPackageIdentity,
  LocalPackageDownloadReceipt,
  LocalPackageProgress,
} from "../../shared/local-model-hub";
import {
  LOCAL_MODEL_HUB_SCHEMA_VERSION,
  assertLocalEnginePackageIdentity,
  assertLocalModelPackageIdentity,
} from "../../shared/local-model-hub";

type DownloadIdentity = LocalEnginePackageIdentity | LocalModelPackageIdentity;
type PackageKind = LocalPackageDownloadReceipt["kind"];

interface ResumeJournal {
  schemaVersion: 1;
  packageId: string;
  url: string;
  etag: string | null;
  expectedBytes: number;
  expectedSha256: string;
}

export interface PackageDownloadResult {
  receipt: LocalPackageDownloadReceipt;
  verifiedPath: string | null;
}

export interface PackageDownloadOptions {
  signal?: AbortSignal;
  onProgress?: (progress: LocalPackageProgress) => void;
  fetchImpl?: typeof fetch;
}

function packageKey(identity: DownloadIdentity): string {
  return createHash("sha256").update(identity.packageId).digest("hex");
}

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function assertIdentity(identity: DownloadIdentity, kind: PackageKind): void {
  if (kind === "engine") assertLocalEnginePackageIdentity(identity as LocalEnginePackageIdentity);
  else assertLocalModelPackageIdentity(identity as LocalModelPackageIdentity);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

async function existingBytes(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/** A paused download older than this is dropped with its resume journal (a model file is several GB). */
const STALE_PARTIAL_MS = 7 * 86_400_000;
/** Free space a download or import must leave room for: its remaining bytes times this. */
const DISK_HEADROOM = 1.1;
const PACKAGE_DIR_RE = /^[a-f0-9]{64}$/;

async function defaultDiskFreeBytes(path: string): Promise<number | null> {
  try {
    const space = await statfs(path);
    return space.bavail * space.bsize;
  } catch {
    return null;
  }
}

export class LocalPackageDownloadManager {
  private readonly active = new Map<string, Promise<PackageDownloadResult>>();
  private readonly activeRoots = new Set<string>();
  private readonly diskFreeBytes: (path: string) => Promise<number | null>;

  constructor(private readonly rootPath: string, options: { diskFreeBytes?: (path: string) => Promise<number | null> } = {}) {
    this.diskFreeBytes = options.diskFreeBytes ?? defaultDiskFreeBytes;
    // Paused downloads nobody resumed, and quarantine copies kept by older versions, are cleared once per host start.
    void this.expireStale().catch(() => undefined);
  }

  /**
   * Removes `.partial` files and resume journals untouched for 7 days, and keeps only the newest quarantine copy
   * of each package. A package downloading now is skipped.
   */
  async expireStale(now = Date.now()): Promise<{ removed: number }> {
    let removed = 0;
    let packages: string[] = [];
    try { packages = (await readdir(this.rootPath)).filter((name) => PACKAGE_DIR_RE.test(name)); } catch { return { removed }; }
    for (const name of packages) {
      const packageRoot = join(this.rootPath, name);
      if (this.activeRoots.has(packageRoot)) continue;
      let entries: string[] = [];
      try { entries = await readdir(packageRoot); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith(".partial") && entry !== "resume.json") continue;
        const file = join(packageRoot, entry);
        try {
          if (now - (await stat(file)).mtimeMs < STALE_PARTIAL_MS || this.activeRoots.has(packageRoot)) continue;
          await rm(file, { force: true });
          removed += 1;
        } catch { /* gone */ }
      }
      removed += await this.keepNewestQuarantine(join(packageRoot, "quarantine"));
    }
    return { removed };
  }

  /** A failed sha check keeps a full-size copy for inspection; only the newest copy is worth keeping. */
  private async keepNewestQuarantine(quarantineRoot: string, keepName?: string): Promise<number> {
    let names: string[] = [];
    try { names = await readdir(quarantineRoot); } catch { return 0; }
    const dated = await Promise.all(names.map(async (entry) => {
      try { return { entry, mtimeMs: (await stat(join(quarantineRoot, entry))).mtimeMs }; } catch { return null; }
    }));
    const present = dated.filter((value): value is { entry: string; mtimeMs: number } => Boolean(value))
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
    const keep = keepName ?? present[0]?.entry;
    let removed = 0;
    for (const { entry } of present) {
      if (entry === keep) continue;
      await rm(join(quarantineRoot, entry), { force: true }).catch(() => undefined);
      removed += 1;
    }
    return removed;
  }

  /** Refuses before any byte is written when the volume cannot hold `bytes` with headroom. Unknown space is not refused. */
  private async assertDiskRoom(path: string, bytes: number): Promise<void> {
    const free = await this.diskFreeBytes(path);
    if (free !== null && free < bytes * DISK_HEADROOM) throw new Error("local_model_disk_insufficient");
  }

  verifiedPath(identity: DownloadIdentity): string {
    return join(this.rootPath, packageKey(identity), "verified", basename(identity.fileName));
  }

  download(
    identity: DownloadIdentity,
    kind: PackageKind,
    options: PackageDownloadOptions = {},
  ): Promise<PackageDownloadResult> {
    assertIdentity(identity, kind);
    const activeKey = `${kind}:${identity.packageId}`;
    const current = this.active.get(activeKey);
    if (current) return current;
    const packageRoot = join(this.rootPath, packageKey(identity));
    this.activeRoots.add(packageRoot);
    const operation = this.downloadOnce(identity, kind, options).finally(() => {
      if (this.active.get(activeKey) === operation) this.active.delete(activeKey);
      this.activeRoots.delete(packageRoot);
    });
    this.active.set(activeKey, operation);
    return operation;
  }

  async importVerified(
    sourcePath: string,
    identity: DownloadIdentity,
    kind: PackageKind,
    signal?: AbortSignal,
  ): Promise<PackageDownloadResult> {
    assertIdentity(identity, kind);
    const startedAt = new Date().toISOString();
    const receiptId = randomUUID();
    const target = this.verifiedPath(identity);
    const temp = `${target}.import-${receiptId}`;
    let observedBytes = 0;
    let observedSha256: string | null = null;
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const source = await stat(sourcePath);
      observedBytes = source.size;
      if (!source.isFile()) throw new Error("model_import_not_regular_file");
      if (source.size !== identity.byteLength) throw new Error("package_size_mismatch");
      observedSha256 = await sha256File(sourcePath, signal);
      if (observedSha256 !== identity.sha256) throw new Error("package_sha256_mismatch");
      await mkdir(join(this.rootPath, packageKey(identity), "verified"), { recursive: true, mode: 0o700 });
      await this.assertDiskRoom(join(this.rootPath, packageKey(identity)), identity.byteLength);
      await copyFile(sourcePath, temp);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const copiedSha256 = await sha256File(temp, signal);
      if (copiedSha256 !== identity.sha256) throw new Error("package_copy_sha256_mismatch");
      await rename(temp, target);
      return {
        verifiedPath: target,
        receipt: {
          schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
          receiptId,
          packageId: identity.packageId,
          kind,
          state: "verified",
          expectedSha256: identity.sha256,
          observedSha256: copiedSha256,
          expectedBytes: identity.byteLength,
          observedBytes,
          resumedFromBytes: 0,
          rangeAccepted: false,
          etag: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          reasonCode: null,
        },
      };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      return {
        verifiedPath: null,
        receipt: {
          schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
          receiptId,
          packageId: identity.packageId,
          kind,
          state: isAbort(error, signal) ? "cancelled" : "failed",
          expectedSha256: identity.sha256,
          observedSha256,
          expectedBytes: identity.byteLength,
          observedBytes,
          resumedFromBytes: 0,
          rangeAccepted: false,
          etag: null,
          startedAt,
          finishedAt: new Date().toISOString(),
          reasonCode: error instanceof Error ? error.message : "package_import_failed",
        },
      };
    }
  }

  private async downloadOnce(
    identity: DownloadIdentity,
    kind: PackageKind,
    options: PackageDownloadOptions,
  ): Promise<PackageDownloadResult> {
    const startedAt = new Date().toISOString();
    const receiptId = randomUUID();
    const packageRoot = join(this.rootPath, packageKey(identity));
    const partial = join(packageRoot, `${identity.fileName}.partial`);
    const journalPath = join(packageRoot, "resume.json");
    const target = this.verifiedPath(identity);
    await mkdir(join(packageRoot, "verified"), { recursive: true, mode: 0o700 });
    try {
      if (Date.now() - (await stat(partial)).mtimeMs >= STALE_PARTIAL_MS) {
        await rm(partial, { force: true });
        await rm(journalPath, { force: true });
      }
    } catch { /* no partial */ }

    let resumedFromBytes = await existingBytes(partial);
    let rangeAccepted = false;
    let etag: string | null = null;
    let observedBytes = resumedFromBytes;
    let observedSha256: string | null = null;
    const emit = (state: LocalPackageProgress["state"], reasonCode: string | null = null) => {
      options.onProgress?.({
        packageId: identity.packageId,
        state,
        downloadedBytes: observedBytes,
        totalBytes: identity.byteLength,
        reasonCode,
        updatedAt: new Date().toISOString(),
      });
    };

    try {
      const targetSize = await existingBytes(target);
      if (targetSize === identity.byteLength && await sha256File(target) === identity.sha256) {
        return {
          verifiedPath: target,
          receipt: {
            schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
            receiptId,
            packageId: identity.packageId,
            kind,
            state: "verified",
            expectedSha256: identity.sha256,
            observedSha256: identity.sha256,
            expectedBytes: identity.byteLength,
            observedBytes: targetSize,
            resumedFromBytes: targetSize,
            rangeAccepted: false,
            etag: null,
            startedAt,
            finishedAt: new Date().toISOString(),
            reasonCode: "already_verified",
          },
        };
      }
      if (targetSize > 0) await rm(target, { force: true });
      if (resumedFromBytes > identity.byteLength) {
        await rm(partial, { force: true });
        resumedFromBytes = 0;
        observedBytes = 0;
      }

      let previousJournal: ResumeJournal | null = null;
      try {
        const candidate = JSON.parse(await readFile(journalPath, "utf8")) as ResumeJournal;
        if (
          candidate.schemaVersion === 1
          && candidate.packageId === identity.packageId
          && candidate.url === identity.downloadUrl
          && candidate.expectedBytes === identity.byteLength
          && candidate.expectedSha256 === identity.sha256
        ) previousJournal = candidate;
      } catch {
        previousJournal = null;
      }
      if (resumedFromBytes > 0 && !previousJournal) {
        await rm(partial, { force: true });
        resumedFromBytes = 0;
        observedBytes = 0;
      }
      if (resumedFromBytes === identity.byteLength && previousJournal) {
        observedSha256 = await sha256File(partial, options.signal);
        if (observedSha256 === identity.sha256) {
          await rename(partial, target);
          await rm(journalPath, { force: true });
          emit("verified");
          return {
            verifiedPath: target,
            receipt: {
              schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
              receiptId,
              packageId: identity.packageId,
              kind,
              state: "verified",
              expectedSha256: identity.sha256,
              observedSha256,
              expectedBytes: identity.byteLength,
              observedBytes,
              resumedFromBytes,
              rangeAccepted: false,
              etag: previousJournal.etag,
              startedAt,
              finishedAt: new Date().toISOString(),
              reasonCode: "completed_partial_verified",
            },
          };
        }
        const quarantineRoot = join(packageRoot, "quarantine");
        await mkdir(quarantineRoot, { recursive: true, mode: 0o700 });
        const quarantined = `${identity.fileName}.${receiptId}.sha256-mismatch`;
        await rename(partial, join(quarantineRoot, quarantined));
        await this.keepNewestQuarantine(quarantineRoot, quarantined);
        await rm(journalPath, { force: true });
        resumedFromBytes = 0;
        observedBytes = 0;
        observedSha256 = null;
      }

      await this.assertDiskRoom(packageRoot, identity.byteLength - resumedFromBytes);
      emit("downloading");
      const headers: Record<string, string> = { Accept: "application/octet-stream" };
      if (resumedFromBytes > 0) {
        headers.Range = `bytes=${resumedFromBytes}-`;
        if (previousJournal?.etag) headers["If-Range"] = previousJournal.etag;
      }
      const response = await (options.fetchImpl ?? fetch)(identity.downloadUrl, {
        method: "GET",
        headers,
        redirect: "follow",
        signal: options.signal,
      });
      if (!response.ok) throw new Error(`package_http_${response.status}`);
      etag = response.headers.get("etag");
      if (resumedFromBytes > 0 && response.status === 206) {
        const expectedPrefix = `bytes ${resumedFromBytes}-`;
        const contentRange = response.headers.get("content-range")?.toLowerCase() ?? "";
        if (!contentRange.startsWith(expectedPrefix) || !contentRange.endsWith(`/${identity.byteLength}`)) {
          throw new Error("package_invalid_content_range");
        }
        rangeAccepted = true;
      } else if (resumedFromBytes > 0) {
        await rm(partial, { force: true });
        observedBytes = 0;
      }
      const journal: ResumeJournal = {
        schemaVersion: 1,
        packageId: identity.packageId,
        url: identity.downloadUrl,
        etag,
        expectedBytes: identity.byteLength,
        expectedSha256: identity.sha256,
      };
      await writeFile(journalPath, `${JSON.stringify(journal)}\n`, { encoding: "utf8", mode: 0o600 });

      if (!response.body) throw new Error("package_response_body_missing");
      const handle = await open(partial, observedBytes > 0 ? "a" : "w", 0o600);
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          if (!value || value.byteLength === 0) continue;
          observedBytes += value.byteLength;
          if (observedBytes > identity.byteLength) throw new Error("package_size_overflow");
          await handle.write(value);
          emit("downloading");
        }
        if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (observedBytes !== identity.byteLength) throw new Error("package_size_mismatch");
      observedSha256 = await sha256File(partial, options.signal);
      if (observedSha256 !== identity.sha256) throw new Error("package_sha256_mismatch");
      await rename(partial, target);
      await rm(journalPath, { force: true });
      emit("verified");
      return {
        verifiedPath: target,
        receipt: {
          schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
          receiptId,
          packageId: identity.packageId,
          kind,
          state: "verified",
          expectedSha256: identity.sha256,
          observedSha256,
          expectedBytes: identity.byteLength,
          observedBytes,
          resumedFromBytes,
          rangeAccepted,
          etag,
          startedAt,
          finishedAt: new Date().toISOString(),
          reasonCode: null,
        },
      };
    } catch (error) {
      observedBytes = await existingBytes(partial);
      const cancelled = isAbort(error, options.signal);
      const reason = error instanceof Error ? error.message : "package_download_failed";
      if (!cancelled && ["package_sha256_mismatch", "package_size_overflow"].includes(reason) && observedBytes > 0) {
        const quarantineRoot = join(packageRoot, "quarantine");
        const quarantined = `${identity.fileName}.${receiptId}.${reason}`;
        await mkdir(quarantineRoot, { recursive: true, mode: 0o700 }).catch(() => undefined);
        await rename(partial, join(quarantineRoot, quarantined)).catch(() => undefined);
        await this.keepNewestQuarantine(quarantineRoot, quarantined).catch(() => 0);
        await rm(journalPath, { force: true }).catch(() => undefined);
      }
      // A server that answers every ranged request with a wrong Content-Range would fail each retry the same way.
      // Dropping the partial makes the next attempt a plain full request.
      if (reason === "package_invalid_content_range") {
        await rm(partial, { force: true }).catch(() => undefined);
        await rm(journalPath, { force: true }).catch(() => undefined);
      }
      emit(cancelled ? "available" : "failed", cancelled ? "download_cancelled_resumable" : (error instanceof Error ? error.message : "package_download_failed"));
      return {
        verifiedPath: null,
        receipt: {
          schemaVersion: LOCAL_MODEL_HUB_SCHEMA_VERSION,
          receiptId,
          packageId: identity.packageId,
          kind,
          state: cancelled ? "cancelled" : "failed",
          expectedSha256: identity.sha256,
          observedSha256,
          expectedBytes: identity.byteLength,
          observedBytes,
          resumedFromBytes,
          rangeAccepted,
          etag,
          startedAt,
          finishedAt: new Date().toISOString(),
          reasonCode: cancelled ? "download_cancelled_resumable" : (error instanceof Error ? error.message : "package_download_failed"),
        },
      };
    }
  }
}

export { sha256File };
