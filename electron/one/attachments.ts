import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getChat } from "../store/chats";
import { pathFromGrant } from "../fs/access";
import type { McpInvocationEvent, McpInvocationRequest } from "../../shared/types";
import {
  ONE_ATTACHMENT_CONTRACT_VERSION,
  ONE_ATTACHMENT_LIMITS,
  type BindOneAttachmentsToTeamInput,
  type ClaimedOneAttachments,
  type DiscardOneAttachmentsInput,
  type OneAttachmentKind,
  type OneAttachmentRef,
  type OneAttachmentSafeItem,
  type PrepareOneAttachmentsInput,
  type PreparedOneAttachments,
} from "../../shared/one-attachments";
import { userDataPath } from "../runtime-paths";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const SAFE_MEDIA_RE = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,127}$/;
const O_NOFOLLOW = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

const MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".rtf": "application/rtf",
  ".csv": "text/csv", ".tsv": "text/tab-separated-values", ".json": "application/json", ".jsonl": "application/x-ndjson",
  ".yaml": "application/yaml", ".yml": "application/yaml", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text", ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation", ".hwp": "application/x-hwp", ".hwpx": "application/x-hwpx",
  ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac", ".ogg": "audio/ogg",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".m4v": "video/x-m4v",
  ".js": "text/javascript", ".jsx": "text/jsx", ".ts": "text/typescript", ".tsx": "text/tsx", ".css": "text/css",
  ".py": "text/x-python", ".rb": "text/x-ruby", ".go": "text/x-go", ".rs": "text/x-rust", ".java": "text/x-java-source",
  ".c": "text/x-c", ".h": "text/x-c", ".cpp": "text/x-c++", ".hpp": "text/x-c++", ".sql": "application/sql",
});

interface SourceIdentity {
  dev: string;
  ino: string;
  size: number;
  mode: number;
  mtimeNs: string;
  ctimeNs: string;
}

interface PreparedItemRecord {
  grant: PrepareOneAttachmentsInput["attachments"][number]["grant"];
  sourcePath: string;
  identity: SourceIdentity;
  safe: OneAttachmentSafeItem;
  pendingPath: string;
}

interface AttachmentSetRecord {
  ref: OneAttachmentRef;
  chatId: string;
  promptDigest: string;
  status: "prepared" | "claiming" | "claimed" | "failed";
  items: PreparedItemRecord[];
  pendingDir: string;
  runDir: string | null;
  teamProposalId: string | null;
  createdAt: string;
  expiresAt: string;
}

type MainAttachmentRequest = McpInvocationRequest & {
  oneAttachmentContext?: string;
  oneAttachmentRedactions?: Array<{ path: string; replacement: string }>;
};

const records = new Map<string, AttachmentSetRecord>();

export class OneAttachmentError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsupported_type"
      | "too_many"
      | "too_large"
      | "stale_grant"
      | "changed_source"
      | "expired"
      | "already_used",
    message: string,
  ) {
    super(message);
    this.name = "OneAttachmentError";
  }
}

function attachmentRoot(): string {
  return process.env.AGENTLAS_ONE_ATTACHMENT_ROOT?.trim()
    || userDataPath("one-attachments-v1");
}

function ensureCanonicalPrivateDirectory(directory: string, recursive: boolean): string {
  const resolved = path.resolve(directory);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new OneAttachmentError("stale_grant", "The One attachment staging root is not a regular directory.");
    }
  } else {
    fs.mkdirSync(resolved, { recursive, mode: 0o700 });
  }
  // `/tmp` is a system parent alias for `/private/tmp` on macOS. Reject a
  // symlink at the staging directory itself, but canonicalize safe parent
  // aliases instead of treating them as a mutated attachment root.
  const current = fs.lstatSync(resolved);
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new OneAttachmentError("stale_grant", "The One attachment staging root changed unexpectedly.");
  }
  const canonical = fs.realpathSync.native(resolved);
  const canonicalCurrent = fs.lstatSync(canonical);
  if (canonicalCurrent.isSymbolicLink() || !canonicalCurrent.isDirectory()) {
    throw new OneAttachmentError("stale_grant", "The One attachment staging root changed unexpectedly.");
  }
  if (process.platform !== "win32") fs.chmodSync(canonical, 0o700);
  return canonical;
}

function pendingRoot(create: boolean): string | null {
  const root = path.resolve(attachmentRoot());
  if (!create && !fs.existsSync(root)) return null;
  const canonicalRoot = ensureCanonicalPrivateDirectory(root, true);
  const pending = path.join(canonicalRoot, "pending");
  if (!create && !fs.existsSync(pending)) return null;
  return ensureCanonicalPrivateDirectory(pending, false);
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function statIdentity(stat: fs.BigIntStats): SourceIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mode: Number(stat.mode),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

function identitiesEqual(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function safeBasename(raw: string, fallback: string): string {
  const basename = path.basename(raw.normalize("NFKC"));
  const sanitized = basename
    .replace(/[\u0000-\u001f\u007f/\\:]+/g, "_")
    .replace(/[^\p{L}\p{N}._()\- ]+/gu, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim();
  return (sanitized || fallback).slice(0, 96);
}

function canonicalMediaType(filePath: string): string {
  const mediaType = MEDIA_BY_EXTENSION[path.extname(filePath).toLowerCase()];
  if (!mediaType || !SAFE_MEDIA_RE.test(mediaType)) {
    throw new OneAttachmentError("unsupported_type", "This file type is not supported in One attachments.");
  }
  return mediaType;
}

function openStableRegularFile(filePath: string): { fd: number; identity: SourceIdentity } {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile()) throw new OneAttachmentError("stale_grant", "The attachment is no longer a regular file.");
    return { fd, identity: statIdentity(stat) };
  } catch (error) {
    if (fd !== null) fs.closeSync(fd);
    if (error instanceof OneAttachmentError) throw error;
    throw new OneAttachmentError("stale_grant", "The attachment could not be opened through the approved file grant.");
  }
}

function copyAndHashFd(sourceFd: number, targetPath: string, maxBytes: number): { size: number; digest: `sha256:${string}` } {
  const targetFd = fs.openSync(targetPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  try {
    while (true) {
      const read = fs.readSync(sourceFd, buffer, 0, buffer.length, offset);
      if (read === 0) break;
      offset += read;
      if (offset > maxBytes) throw new OneAttachmentError("too_large", "The attachment exceeds One's safe size limit.");
      hash.update(buffer.subarray(0, read));
      let written = 0;
      while (written < read) written += fs.writeSync(targetFd, buffer, written, read - written);
    }
    fs.fsyncSync(targetFd);
    return { size: offset, digest: `sha256:${hash.digest("hex")}` };
  } finally {
    fs.closeSync(targetFd);
  }
}

function hashFd(sourceFd: number, maxBytes: number): { size: number; digest: `sha256:${string}` } {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(256 * 1024);
  let offset = 0;
  while (true) {
    const read = fs.readSync(sourceFd, buffer, 0, buffer.length, offset);
    if (read === 0) break;
    offset += read;
    if (offset > maxBytes) throw new OneAttachmentError("too_large", "The attachment exceeds One's safe size limit.");
    hash.update(buffer.subarray(0, read));
  }
  return { size: offset, digest: `sha256:${hash.digest("hex")}` };
}

function stableDirectorySnapshot(sourceRoot: string, targetRoot?: string): { size: number; digest: `sha256:${string}`; entries: number } {
  const aggregate = createHash("sha256");
  let totalBytes = 0;
  let entries = 0;
  if (targetRoot) fs.mkdirSync(targetRoot, { mode: 0o700 });
  const visit = (sourceDir: string, targetDir: string | null) => {
    let names: string[];
    try { names = fs.readdirSync(sourceDir).sort((left, right) => left.localeCompare(right, "en")); }
    catch { throw new OneAttachmentError("stale_grant", "The approved folder could not be read."); }
    for (const name of names) {
      const source = path.join(sourceDir, name);
      const relative = path.relative(sourceRoot, source).replaceAll(path.sep, "/");
      if (Buffer.byteLength(relative, "utf8") > ONE_ATTACHMENT_LIMITS.maxRelativePathBytes) {
        throw new OneAttachmentError("invalid_request", `A folder entry path is too long: ${relative.slice(0, 120)}`);
      }
      let stat: fs.Stats;
      try { stat = fs.lstatSync(source); }
      catch { throw new OneAttachmentError("changed_source", `A folder entry disappeared: ${relative}`); }
      if (stat.isSymbolicLink()) throw new OneAttachmentError("unsupported_type", `Symbolic links are not supported in folder attachments: ${relative}`);
      if (stat.isDirectory()) {
        aggregate.update(`D\u0000${relative}\n`, "utf8");
        const nextTarget = targetDir ? path.join(targetDir, name) : null;
        if (nextTarget) fs.mkdirSync(nextTarget, { mode: 0o700 });
        visit(source, nextTarget);
        continue;
      }
      if (!stat.isFile()) throw new OneAttachmentError("unsupported_type", `Unsupported folder entry: ${relative}`);
      entries += 1;
      if (entries > ONE_ATTACHMENT_LIMITS.maxDirectoryEntries) {
        throw new OneAttachmentError("too_many", `A folder attachment may contain at most ${ONE_ATTACHMENT_LIMITS.maxDirectoryEntries} files.`);
      }
      totalBytes += stat.size;
      if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new OneAttachmentError("too_large", "The folder attachment exceeds One's safe total size limit.");
      const opened = openStableRegularFile(source);
      try {
        const measured = targetDir
          ? copyAndHashFd(opened.fd, path.join(targetDir, name), ONE_ATTACHMENT_LIMITS.maxFileBytes)
          : hashFd(opened.fd, ONE_ATTACHMENT_LIMITS.maxFileBytes);
        if (measured.size !== stat.size) throw new OneAttachmentError("changed_source", `A folder entry changed while it was read: ${relative}`);
        aggregate.update(`F\u0000${relative}\u0000${measured.size}\u0000${measured.digest}\n`, "utf8");
      } finally {
        fs.closeSync(opened.fd);
      }
    }
  };
  visit(sourceRoot, targetRoot ?? null);
  return { size: totalBytes, entries, digest: `sha256:${aggregate.digest("hex")}` };
}

function safeRemove(target: string | null): void {
  if (!target) return;
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 2 }); } catch {}
}

function pathInside(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function createSafeRunDirectory(resultFolder: string, runId: string): string {
  const canonicalResult = fs.realpathSync.native(path.resolve(resultFolder));
  if (canonicalResult !== path.resolve(resultFolder)) {
    throw new OneAttachmentError("stale_grant", "The run workspace changed before attachment staging.");
  }
  const agentlasDir = path.join(canonicalResult, ".agentlas");
  const attachmentsDir = path.join(agentlasDir, "one-attachments");
  for (const directory of [agentlasDir, attachmentsDir]) {
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new OneAttachmentError("stale_grant", "The One attachment staging directory is not a regular directory.");
      }
    } else {
      fs.mkdirSync(directory, { mode: 0o700 });
    }
  }
  const staleBefore = Date.now() - ONE_ATTACHMENT_LIMITS.capabilityTtlMs;
  for (const name of fs.readdirSync(attachmentsDir)) {
    const candidate = path.join(attachmentsDir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() && stat.isDirectory() && stat.mtimeMs < staleBefore) safeRemove(candidate);
    } catch {}
  }
  const runDir = path.join(attachmentsDir, runId.replace(/[^A-Za-z0-9._-]/g, "_"));
  if (fs.existsSync(runDir)) throw new OneAttachmentError("already_used", "This run already has an attachment staging directory.");
  fs.mkdirSync(runDir, { mode: 0o700 });
  return runDir;
}

/** 만료된 팀 귀속 첨부 기록을 붙잡아 두는 시간(그 뒤에는 목록에서도 지운다). */
const EXPIRED_RECORD_RETENTION_MS = 10 * 60_000;

function cleanupExpired(): void {
  const now = Date.now();
  for (const [setId, record] of records) {
    if (record.status === "claimed") continue;
    if (Date.parse(record.expiresAt) > now) continue;
    safeRemove(record.pendingDir);
    safeRemove(record.runDir);
    if (record.teamProposalId) {
      record.status = "failed";
      // 만료 기록은 "다시 첨부하세요"를 말하기 위한 것이므로 잠시만 남긴다. 프로세스가
      // 살아 있는 동안 영원히 쌓이면 그 제안은 계속 만료 상태로 읽힌다.
      if (now - Date.parse(record.expiresAt) > EXPIRED_RECORD_RETENTION_MS) records.delete(setId);
    } else records.delete(setId);
  }
  // Capabilities are deliberately process-local. After a restart no pending
  // directory can still be authorized, so remove it at the first attachment
  // operation instead of waiting for the TTL.
  const root = pendingRoot(false);
  if (!root) return;
  const livePending = new Set(
    [...records.values()]
      .filter((record) => record.status === "prepared" || record.status === "claiming")
      .map((record) => path.resolve(record.pendingDir)),
  );
  for (const name of fs.readdirSync(root)) {
    const candidate = path.join(root, name);
    if (livePending.has(path.resolve(candidate))) continue;
    safeRemove(candidate);
  }
}

function exactRef(ref: OneAttachmentRef, record: AttachmentSetRecord): boolean {
  return ref?.contractVersion === ONE_ATTACHMENT_CONTRACT_VERSION
    && ref.attachmentSetId === record.ref.attachmentSetId
    && ref.capabilityToken === record.ref.capabilityToken;
}

function validatedRecord(ref: OneAttachmentRef): AttachmentSetRecord {
  cleanupExpired();
  if (!ref || typeof ref !== "object" || Object.keys(ref).sort().join(",") !== "attachmentSetId,capabilityToken,contractVersion") {
    throw new OneAttachmentError("invalid_request", "Invalid One attachment capability.");
  }
  const record = records.get(ref.attachmentSetId);
  if (!record || !exactRef(ref, record)) throw new OneAttachmentError("stale_grant", "The One attachment capability is unavailable.");
  if (Date.parse(record.expiresAt) <= Date.now()) throw new OneAttachmentError("expired", "The One attachment capability expired.");
  if (record.status !== "prepared") throw new OneAttachmentError("already_used", "The One attachment capability has already been used.");
  return record;
}

function validatePrepareInput(input: PrepareOneAttachmentsInput): void {
  if (!input || typeof input !== "object" || !ID_RE.test(input.chatId) || typeof input.userPrompt !== "string" || input.userPrompt.length > 32_000) {
    throw new OneAttachmentError("invalid_request", "Invalid One attachment request.");
  }
  if (!getChat(input.chatId)) throw new OneAttachmentError("invalid_request", "The attachment chat does not exist.");
  if (!Array.isArray(input.attachments) || input.attachments.length < 1) {
    throw new OneAttachmentError("invalid_request", "Select at least one attachment.");
  }
  if (input.attachments.length > ONE_ATTACHMENT_LIMITS.maxCount) {
    throw new OneAttachmentError("too_many", `One accepts at most ${ONE_ATTACHMENT_LIMITS.maxCount} attachments per request.`);
  }
}

export function prepareOneAttachments(input: PrepareOneAttachmentsInput): PreparedOneAttachments {
  cleanupExpired();
  validatePrepareInput(input);
  const attachmentSetId = `one-att:${randomUUID()}`;
  const ref: OneAttachmentRef = {
    contractVersion: ONE_ATTACHMENT_CONTRACT_VERSION,
    attachmentSetId,
    capabilityToken: randomUUID(),
  };
  const safePendingRoot = pendingRoot(true)!;
  const pendingDir = path.join(safePendingRoot, attachmentSetId.replace(/[^A-Za-z0-9._-]/g, "_"));
  const staleBefore = Date.now() - ONE_ATTACHMENT_LIMITS.capabilityTtlMs;
  for (const name of fs.readdirSync(safePendingRoot)) {
    const candidate = path.join(safePendingRoot, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isSymbolicLink() && stat.isDirectory() && stat.mtimeMs < staleBefore) safeRemove(candidate);
    } catch {}
  }
  fs.mkdirSync(pendingDir, { mode: 0o700 });
  const items: PreparedItemRecord[] = [];
  let totalBytes = 0;
  const usedNames = new Set<string>();
  const seenSources = new Set<string>();
  try {
    for (const [index, item] of input.attachments.entries()) {
      if (!item || typeof item !== "object" || typeof item.displayName !== "string" || item.displayName.length > 512
        || typeof item.claimedMediaType !== "string" || item.claimedMediaType.length > 200
        || !Number.isSafeInteger(item.claimedSize) || item.claimedSize < 0) {
        throw new OneAttachmentError("invalid_request", "Invalid attachment metadata.");
      }
      const requestedKind = item.grant?.kind === "directory" ? "directory" : "file";
      const sourcePath = pathFromGrant(item.grant, requestedKind);
      if (pathInside(sourcePath, attachmentRoot()) || seenSources.has(sourcePath)) {
        throw new OneAttachmentError("invalid_request", "Duplicate or internal One staging files cannot be attached.");
      }
      seenSources.add(sourcePath);
      if (requestedKind === "directory") {
        let rootStat: fs.BigIntStats;
        try { rootStat = fs.lstatSync(sourcePath, { bigint: true }); }
        catch { throw new OneAttachmentError("stale_grant", "The approved folder no longer exists."); }
        if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new OneAttachmentError("stale_grant", "The approved folder is no longer a regular directory.");
        const originalName = safeBasename(path.basename(sourcePath), `folder-${index + 1}`);
        const stagedName = `${String(index + 1).padStart(2, "0")}-${originalName}`;
        usedNames.add(stagedName.toLowerCase());
        const pendingPath = path.join(pendingDir, stagedName);
        const copied = stableDirectorySnapshot(sourcePath, pendingPath);
        totalBytes += copied.size;
        if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new OneAttachmentError("too_large", "The selected attachments exceed One's safe total size limit.");
        const safe: OneAttachmentSafeItem = {
          attachmentId: `attachment:${index + 1}:${copied.digest.slice("sha256:".length, "sha256:".length + 24)}`,
          name: originalName,
          mediaType: "application/vnd.agentlas.directory",
          size: copied.size,
          kind: "directory",
          digest: copied.digest,
        };
        items.push({ grant: item.grant, sourcePath, identity: statIdentity(rootStat), safe, pendingPath });
        continue;
      }
      const canonicalType = canonicalMediaType(sourcePath);
      const kind: OneAttachmentKind = canonicalType.startsWith("image/") ? "image" : "file";
      const maxBytes = kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes;
      const opened = openStableRegularFile(sourcePath);
      let pendingPath = "";
      try {
        if (opened.identity.size !== item.claimedSize) {
          throw new OneAttachmentError("changed_source", "The selected attachment changed before Main could prepare it.");
        }
        if (opened.identity.size > maxBytes) throw new OneAttachmentError("too_large", "An attachment exceeds One's safe per-file size limit.");
        totalBytes += opened.identity.size;
        if (totalBytes > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new OneAttachmentError("too_large", "The selected attachments exceed One's safe total size limit.");
        const originalName = safeBasename(path.basename(sourcePath), `attachment-${index + 1}`);
        let stagedName = `${String(index + 1).padStart(2, "0")}-${originalName}`;
        let collision = 2;
        while (usedNames.has(stagedName.toLowerCase())) {
          const ext = path.extname(originalName);
          const stem = path.basename(originalName, ext);
          stagedName = `${String(index + 1).padStart(2, "0")}-${stem}-${collision}${ext}`;
          collision += 1;
        }
        usedNames.add(stagedName.toLowerCase());
        pendingPath = path.join(pendingDir, stagedName);
        const copied = copyAndHashFd(opened.fd, pendingPath, maxBytes);
        if (copied.size !== opened.identity.size) throw new OneAttachmentError("changed_source", "The selected attachment changed while Main was preparing it.");
        const safe: OneAttachmentSafeItem = {
          // The digest proves bytes; the ordinal keeps two intentionally
          // identical files as distinct closed-contract items and stable UI keys.
          attachmentId: `attachment:${index + 1}:${copied.digest.slice("sha256:".length, "sha256:".length + 24)}`,
          name: originalName,
          mediaType: canonicalType,
          size: copied.size,
          kind,
          digest: copied.digest,
        };
        items.push({ grant: item.grant, sourcePath, identity: opened.identity, safe, pendingPath });
      } finally {
        fs.closeSync(opened.fd);
      }
    }
    const createdAt = new Date().toISOString();
    const record: AttachmentSetRecord = {
      ref,
      chatId: input.chatId,
      promptDigest: sha256Text(input.userPrompt),
      status: "prepared",
      items,
      pendingDir,
      runDir: null,
      teamProposalId: null,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ONE_ATTACHMENT_LIMITS.capabilityTtlMs).toISOString(),
    };
    records.set(attachmentSetId, record);
    return {
      contractVersion: ONE_ATTACHMENT_CONTRACT_VERSION,
      ref: { ...ref },
      attachments: items.map((entry) => ({ ...entry.safe })),
      totalBytes,
      expiresAt: record.expiresAt,
      limits: ONE_ATTACHMENT_LIMITS,
    };
  } catch (error) {
    safeRemove(pendingDir);
    throw error;
  }
}

function revalidatePreparedItem(item: PreparedItemRecord): void {
  const expectedKind = item.safe.kind === "directory" ? "directory" : "file";
  const currentPath = pathFromGrant(item.grant, expectedKind);
  if (currentPath !== item.sourcePath) throw new OneAttachmentError("changed_source", "The approved attachment path changed.");
  if (item.safe.kind === "directory") {
    let currentStat: fs.BigIntStats;
    try { currentStat = fs.lstatSync(currentPath, { bigint: true }); }
    catch { throw new OneAttachmentError("changed_source", "The approved folder is no longer available."); }
    if (currentStat.isSymbolicLink() || !currentStat.isDirectory() || !identitiesEqual(statIdentity(currentStat), item.identity)) {
      throw new OneAttachmentError("changed_source", "A folder attachment changed after it was selected.");
    }
    const current = stableDirectorySnapshot(currentPath);
    if (current.size !== item.safe.size || current.digest !== item.safe.digest) throw new OneAttachmentError("changed_source", "A folder attachment's contents changed after it was selected.");
    return;
  }
  const opened = openStableRegularFile(currentPath);
  try {
    if (!identitiesEqual(opened.identity, item.identity)) throw new OneAttachmentError("changed_source", "An attachment changed after it was selected.");
    const current = hashFd(opened.fd, item.safe.kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes);
    if (current.size !== item.safe.size || current.digest !== item.safe.digest) {
      throw new OneAttachmentError("changed_source", "An attachment's contents changed after it was selected.");
    }
  } finally {
    fs.closeSync(opened.fd);
  }
}

function copyPreparedFile(source: string, target: string, expected: OneAttachmentSafeItem): void {
  if (expected.kind === "directory") {
    const copied = stableDirectorySnapshot(source, target);
    if (copied.size !== expected.size || copied.digest !== expected.digest) throw new OneAttachmentError("changed_source", "The prepared folder copy is no longer valid.");
    return;
  }
  const opened = openStableRegularFile(source);
  try {
    const copied = copyAndHashFd(opened.fd, target, expected.kind === "image" ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes);
    if (copied.size !== expected.size || copied.digest !== expected.digest) {
      throw new OneAttachmentError("changed_source", "The prepared attachment copy is no longer valid.");
    }
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function claimOneAttachments(input: {
  ref: OneAttachmentRef;
  chatId: string;
  userPrompt: string;
  runId: string;
  resultFolder: string;
  teamProposalId?: string | null;
}): ClaimedOneAttachments {
  const record = validatedRecord(input.ref);
  record.status = "claiming";
  if (record.chatId !== input.chatId || record.promptDigest !== sha256Text(input.userPrompt)) {
    record.status = "failed";
    safeRemove(record.pendingDir);
    throw new OneAttachmentError("stale_grant", "The attachment capability does not match this chat and request.");
  }
  if ((record.teamProposalId ?? null) !== (input.teamProposalId ?? null)) {
    record.status = "failed";
    safeRemove(record.pendingDir);
    throw new OneAttachmentError("stale_grant", "The attachment capability does not match this team proposal.");
  }
  if (!ID_RE.test(input.runId) || !path.isAbsolute(input.resultFolder)) {
    record.status = "failed";
    safeRemove(record.pendingDir);
    throw new OneAttachmentError("invalid_request", "The attachment run binding is invalid.");
  }
  let runDir: string | null = null;
  try {
    for (const item of record.items) revalidatePreparedItem(item);
    const stagingParent = path.join(path.resolve(input.resultFolder), ".agentlas", "one-attachments");
    if (record.items.some((item) => pathInside(item.sourcePath, stagingParent))) {
      throw new OneAttachmentError("invalid_request", "An existing One staging file cannot be attached as new input.");
    }
    runDir = createSafeRunDirectory(input.resultFolder, input.runId);
    record.runDir = runDir;
    const redactions: ClaimedOneAttachments["redactions"] = [];
    const images: ClaimedOneAttachments["images"] = [];
    const lines: string[] = [];
    for (const [index, item] of record.items.entries()) {
      const target = path.join(runDir, path.basename(item.pendingPath));
      copyPreparedFile(item.pendingPath, target, item.safe);
      const replacement = `[One attachment: ${item.safe.name}]`;
      redactions.push({ path: target, replacement }, { path: runDir, replacement: "[One attachment staging]" });
      lines.push(`${index + 1}. ${JSON.stringify(item.safe.name)} -> ${target} (${item.safe.mediaType}, ${item.safe.size} bytes, ${item.safe.digest})`);
      if (item.safe.kind === "image") {
        images.push({ mediaType: item.safe.mediaType, name: item.safe.name, data: fs.readFileSync(target).toString("base64") });
      }
    }
    safeRemove(record.pendingDir);
    record.status = "claimed";
    return {
      ref: { ...record.ref },
      receipt: {
        contractVersion: ONE_ATTACHMENT_CONTRACT_VERSION,
        attachments: record.items.map((item) => ({ ...item.safe })),
        totalBytes: record.items.reduce((sum, item) => sum + item.safe.size, 0),
      },
      images,
      runtimeContext: [
        "[Agentlas One attachments - Main verified]",
        `The user attached ${record.items.length} file or folder item(s). Read only the exact staged copies below.`,
        ...lines,
        "Do not search Downloads or recent files. Do not repeat internal staging paths in the answer; refer to each file by its original name.",
        "[/Agentlas One attachments]",
      ].join("\n"),
      redactions,
    };
  } catch (error) {
    record.status = "failed";
    safeRemove(record.pendingDir);
    safeRemove(runDir);
    throw error;
  }
}

function preparedProjection(record: AttachmentSetRecord): PreparedOneAttachments {
  return {
    contractVersion: ONE_ATTACHMENT_CONTRACT_VERSION,
    ref: { ...record.ref },
    attachments: record.items.map((item) => ({ ...item.safe })),
    totalBytes: record.items.reduce((sum, item) => sum + item.safe.size, 0),
    expiresAt: record.expiresAt,
    limits: ONE_ATTACHMENT_LIMITS,
  };
}

export function bindOneAttachmentsToTeam(input: BindOneAttachmentsToTeamInput): PreparedOneAttachments {
  if (!input || typeof input !== "object" || !ID_RE.test(input.proposalId) || !ID_RE.test(input.chatId)) {
    throw new OneAttachmentError("invalid_request", "Invalid team attachment binding.");
  }
  const record = validatedRecord(input.ref);
  if (record.chatId !== input.chatId) throw new OneAttachmentError("stale_grant", "The attachment chat binding changed.");
  if (record.teamProposalId && record.teamProposalId !== input.proposalId) {
    throw new OneAttachmentError("already_used", "The attachment set is already bound to another team proposal.");
  }
  record.teamProposalId = input.proposalId;
  return preparedProjection(record);
}

export function getOneAttachmentsForTeam(proposalId: string): PreparedOneAttachments | null {
  cleanupExpired();
  if (!ID_RE.test(proposalId)) return null;
  const record = [...records.values()].find((candidate) => (
    candidate.teamProposalId === proposalId && candidate.status === "prepared" && Date.parse(candidate.expiresAt) > Date.now()
  ));
  return record ? preparedProjection(record) : null;
}

/**
 * PRD §4.26 — 이 판정이 **상태를 안 보고** 제안 id 만 봤다. 만료된 첨부는 `failed` 로 표시된
 * 채 목록에 남으므로, 30분이 지나면 화면은 첨부 없이 보내고 실행은 "정확히 준비된 첨부가
 * 필요하다"며 거절했다 — 그 제안에 대해 **영구히**. 요구 판정도 만료를 만료로 본다.
 * 요구가 남아 있는 것은 아직 쓸 수 있는 첨부(prepared/claiming/claimed)뿐이다.
 */
export function teamProposalRequiresOneAttachments(proposalId: string): boolean {
  cleanupExpired();
  return [...records.values()].some((candidate) => (
    candidate.teamProposalId === proposalId
    && candidate.status !== "failed"
    && (candidate.status === "claimed" || Date.parse(candidate.expiresAt) > Date.now())
  ));
}

/**
 * 만료돼 더 못 쓰는 팀 귀속 첨부가 있었는가 — 화면이 "다시 첨부하세요"라고 말할 근거다.
 * 사실을 감추지 않되, 실행을 영구히 막지도 않는다.
 */
export function teamProposalHasExpiredOneAttachments(proposalId: string): boolean {
  cleanupExpired();
  return [...records.values()].some((candidate) => (
    candidate.teamProposalId === proposalId
    && candidate.status !== "claimed"
    && (candidate.status === "failed" || Date.parse(candidate.expiresAt) <= Date.now())
  ));
}

export function discardOneAttachments(input: DiscardOneAttachmentsInput): { discarded: boolean } {
  cleanupExpired();
  if (!input?.ref || typeof input.ref !== "object") return { discarded: false };
  const record = records.get(input.ref.attachmentSetId);
  if (!record || !exactRef(input.ref, record) || record.status !== "prepared") return { discarded: false };
  record.status = "failed";
  safeRemove(record.pendingDir);
  if (!record.teamProposalId) records.delete(record.ref.attachmentSetId);
  return { discarded: true };
}

export function releaseOneAttachmentRun(ref: OneAttachmentRef | null | undefined): void {
  if (!ref) return;
  const record = records.get(ref.attachmentSetId);
  if (!record || !exactRef(ref, record)) return;
  safeRemove(record.pendingDir);
  safeRemove(record.runDir);
  records.delete(ref.attachmentSetId);
}

export function mainOneAttachmentContext(req: McpInvocationRequest): string {
  const value = (req as MainAttachmentRequest).oneAttachmentContext;
  return typeof value === "string" && value.length > 0 && value.length <= 24_000 ? value : "";
}

export function oneAttachmentExecutionPrompt(req: McpInvocationRequest): string {
  const context = mainOneAttachmentContext(req);
  return context ? `${context}\n\n${req.userPrompt}` : req.userPrompt;
}

function replaceAllLiteral(text: string, search: string, replacement: string): string {
  return search ? text.split(search).join(replacement) : text;
}

export function redactOneAttachmentText(req: McpInvocationRequest, value: string): string {
  let output = value;
  const redactions = (req as MainAttachmentRequest).oneAttachmentRedactions;
  if (!Array.isArray(redactions)) return output;
  for (const item of [...redactions].sort((left, right) => right.path.length - left.path.length)) {
    if (!item || typeof item.path !== "string" || typeof item.replacement !== "string") continue;
    output = replaceAllLiteral(output, item.path, item.replacement);
    output = replaceAllLiteral(output, item.path.replaceAll("\\", "/"), item.replacement);
  }
  return output;
}

export function redactOneAttachmentEvent(req: McpInvocationRequest, event: McpInvocationEvent): McpInvocationEvent {
  const redact = (value: string | undefined) => typeof value === "string" ? redactOneAttachmentText(req, value) : value;
  return {
    ...event,
    text: redact(event.text),
    delta: redact(event.delta),
    status: redact(event.status),
    ...(event.error ? { error: { ...event.error, message: redact(event.error.message) ?? "Attachment execution failed." } } : {}),
    ...(event.tool ? {
      tool: {
        ...event.tool,
        args: redact(event.tool.args),
        result: redact(event.tool.result),
      },
    } : {}),
  };
}

export function isSafeOneAttachmentReceipt(value: OneAttachmentSafeItem): boolean {
  return ID_RE.test(value.attachmentId)
    && value.name.length > 0 && value.name.length <= 96
    && SAFE_MEDIA_RE.test(value.mediaType)
    && Number.isSafeInteger(value.size) && value.size >= 0
    && (value.kind === "image" || value.kind === "file" || value.kind === "directory")
    && SHA256_RE.test(value.digest);
}
