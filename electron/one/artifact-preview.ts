import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  isOneArtifactBindingRequestV1,
  isOneArtifactPreviewRevokeV1,
  type OneArtifactBindingRequestV1,
  type OneArtifactPreviewCapabilityV1,
} from "../../shared/one-artifacts";
import { isDurableOneSurfaceManifestV1 } from "../../shared/one-surface-durable";
import type { OneSurfaceBlock, OneSurfaceManifestV1 } from "../../shared/one-surface";
import type { AgentlasSurfaceDataSet, AgentlasSurfaceManifest, JsonObject } from "../../shared/types";
import { resolveFsReadPath } from "../fs/access";
import { listOneDomainEvents } from "./domain-events";
import { getOneValueClosureState } from "./value-closure";
import { getDb } from "../store/db";
import { getDurableOneSurfaceResult } from "../store/one-surface-results";
import { getInvocationRunReceipt } from "../store/run-events";
import { getCanonicalTask } from "../store/tasks";

export const ONE_ARTIFACT_PREVIEW_TTL_MS = 5 * 60 * 1_000;
export const ONE_ARTIFACT_MAX_BINDINGS_PER_SURFACE = 24;
export const ONE_ARTIFACT_MAX_RANGE_BYTES = 8 * 1_024 * 1_024;

const MAX_IMAGE_BYTES = 24 * 1_024 * 1_024;
const MAX_MOBILE_IMAGE_PREVIEW_BYTES = 5 * 1_024 * 1_024;
// Keep this exact set aligned with Mobile's bounded Image.memory contract.
// AVIF/BMP remain valid Desktop artifacts, but sending them through the
// Bridge would make the strict Mobile decoder reject the entire reply.
const MOBILE_IMAGE_PREVIEW_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_VIDEO_BYTES = 192 * 1_024 * 1_024;
const MAX_AUDIO_BYTES = 96 * 1_024 * 1_024;
const MAX_DOCUMENT_BYTES = 64 * 1_024 * 1_024;
const MAX_DATA_BYTES = 64 * 1_024 * 1_024;
const MAX_ACTIVE_TOKENS = 256;
const TOKEN_RE = /^[a-f0-9]{64}$/;
// A Surface is emitted after the run begins, on the same host clock. Keep a
// small allowance for filesystem timestamp rounding, but never let a file
// that predates the run be presented as a newly made One result.
const ONE_ARTIFACT_OUTPUT_TIME_SKEW_MS = 500;
const SOURCE_KEYS = [
  "path", "filePath", "localPath", "fileUrl", "src", "url", "previewUrl",
  "thumbnail", "imageUrl", "videoUrl", "audioUrl", "file",
] as const;

type ArtifactKind = "document" | "spreadsheet" | "image" | "video" | "audio" | "archive" | "data";

interface ArtifactSpec {
  kind: ArtifactKind;
  mimeType: string;
  maxBytes: number;
}

const ARTIFACT_BY_EXTENSION: Readonly<Record<string, ArtifactSpec>> = Object.freeze({
  ".png": { kind: "image", mimeType: "image/png", maxBytes: MAX_IMAGE_BYTES },
  ".jpg": { kind: "image", mimeType: "image/jpeg", maxBytes: MAX_IMAGE_BYTES },
  ".jpeg": { kind: "image", mimeType: "image/jpeg", maxBytes: MAX_IMAGE_BYTES },
  ".webp": { kind: "image", mimeType: "image/webp", maxBytes: MAX_IMAGE_BYTES },
  ".gif": { kind: "image", mimeType: "image/gif", maxBytes: MAX_IMAGE_BYTES },
  ".avif": { kind: "image", mimeType: "image/avif", maxBytes: MAX_IMAGE_BYTES },
  ".bmp": { kind: "image", mimeType: "image/bmp", maxBytes: MAX_IMAGE_BYTES },
  ".mp4": { kind: "video", mimeType: "video/mp4", maxBytes: MAX_VIDEO_BYTES },
  ".webm": { kind: "video", mimeType: "video/webm", maxBytes: MAX_VIDEO_BYTES },
  ".mov": { kind: "video", mimeType: "video/quicktime", maxBytes: MAX_VIDEO_BYTES },
  ".m4v": { kind: "video", mimeType: "video/x-m4v", maxBytes: MAX_VIDEO_BYTES },
  ".ogv": { kind: "video", mimeType: "video/ogg", maxBytes: MAX_VIDEO_BYTES },
  ".mp3": { kind: "audio", mimeType: "audio/mpeg", maxBytes: MAX_AUDIO_BYTES },
  ".m4a": { kind: "audio", mimeType: "audio/mp4", maxBytes: MAX_AUDIO_BYTES },
  ".wav": { kind: "audio", mimeType: "audio/wav", maxBytes: MAX_AUDIO_BYTES },
  ".ogg": { kind: "audio", mimeType: "audio/ogg", maxBytes: MAX_AUDIO_BYTES },
  ".flac": { kind: "audio", mimeType: "audio/flac", maxBytes: MAX_AUDIO_BYTES },
  ".aac": { kind: "audio", mimeType: "audio/aac", maxBytes: MAX_AUDIO_BYTES },
  ".pdf": { kind: "document", mimeType: "application/pdf", maxBytes: MAX_DOCUMENT_BYTES },
  ".doc": { kind: "document", mimeType: "application/msword", maxBytes: MAX_DOCUMENT_BYTES },
  ".docx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", maxBytes: MAX_DOCUMENT_BYTES },
  ".docm": { kind: "document", mimeType: "application/vnd.ms-word.document.macroenabled.12", maxBytes: MAX_DOCUMENT_BYTES },
  ".rtf": { kind: "document", mimeType: "application/rtf", maxBytes: MAX_DOCUMENT_BYTES },
  ".odt": { kind: "document", mimeType: "application/vnd.oasis.opendocument.text", maxBytes: MAX_DOCUMENT_BYTES },
  ".pages": { kind: "document", mimeType: "application/vnd.apple.pages", maxBytes: MAX_DOCUMENT_BYTES },
  ".hwp": { kind: "document", mimeType: "application/x-hwp", maxBytes: MAX_DOCUMENT_BYTES },
  ".hwpx": { kind: "document", mimeType: "application/vnd.hancom.hwpx", maxBytes: MAX_DOCUMENT_BYTES },
  ".ppt": { kind: "document", mimeType: "application/vnd.ms-powerpoint", maxBytes: MAX_DOCUMENT_BYTES },
  ".pptx": { kind: "document", mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", maxBytes: MAX_DOCUMENT_BYTES },
  ".pptm": { kind: "document", mimeType: "application/vnd.ms-powerpoint.presentation.macroenabled.12", maxBytes: MAX_DOCUMENT_BYTES },
  ".odp": { kind: "document", mimeType: "application/vnd.oasis.opendocument.presentation", maxBytes: MAX_DOCUMENT_BYTES },
  ".key": { kind: "document", mimeType: "application/vnd.apple.keynote", maxBytes: MAX_DOCUMENT_BYTES },
  ".txt": { kind: "document", mimeType: "text/plain", maxBytes: MAX_DOCUMENT_BYTES },
  ".md": { kind: "document", mimeType: "text/markdown", maxBytes: MAX_DOCUMENT_BYTES },
  ".xls": { kind: "spreadsheet", mimeType: "application/vnd.ms-excel", maxBytes: MAX_DATA_BYTES },
  ".xlsx": { kind: "spreadsheet", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", maxBytes: MAX_DATA_BYTES },
  ".xlsm": { kind: "spreadsheet", mimeType: "application/vnd.ms-excel.sheet.macroenabled.12", maxBytes: MAX_DATA_BYTES },
  ".xlsb": { kind: "spreadsheet", mimeType: "application/vnd.ms-excel.sheet.binary.macroenabled.12", maxBytes: MAX_DATA_BYTES },
  ".csv": { kind: "spreadsheet", mimeType: "text/csv", maxBytes: MAX_DATA_BYTES },
  ".tsv": { kind: "spreadsheet", mimeType: "text/tab-separated-values", maxBytes: MAX_DATA_BYTES },
  ".ods": { kind: "spreadsheet", mimeType: "application/vnd.oasis.opendocument.spreadsheet", maxBytes: MAX_DATA_BYTES },
  ".numbers": { kind: "spreadsheet", mimeType: "application/vnd.apple.numbers", maxBytes: MAX_DATA_BYTES },
  ".json": { kind: "data", mimeType: "application/json", maxBytes: MAX_DATA_BYTES },
  ".zip": { kind: "archive", mimeType: "application/zip", maxBytes: MAX_DATA_BYTES },
  ".js": { kind: "data", mimeType: "text/javascript", maxBytes: MAX_DATA_BYTES },
  ".mjs": { kind: "data", mimeType: "text/javascript", maxBytes: MAX_DATA_BYTES },
  ".cjs": { kind: "data", mimeType: "text/javascript", maxBytes: MAX_DATA_BYTES },
  ".jsx": { kind: "data", mimeType: "text/javascript", maxBytes: MAX_DATA_BYTES },
  ".ts": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".tsx": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".py": { kind: "data", mimeType: "text/x-python", maxBytes: MAX_DATA_BYTES },
  ".rb": { kind: "data", mimeType: "text/x-ruby", maxBytes: MAX_DATA_BYTES },
  ".go": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".rs": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".java": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".kt": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".swift": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".sh": { kind: "data", mimeType: "text/x-shellscript", maxBytes: MAX_DATA_BYTES },
  ".bash": { kind: "data", mimeType: "text/x-shellscript", maxBytes: MAX_DATA_BYTES },
  ".zsh": { kind: "data", mimeType: "text/x-shellscript", maxBytes: MAX_DATA_BYTES },
  ".html": { kind: "data", mimeType: "text/html", maxBytes: MAX_DATA_BYTES },
  ".htm": { kind: "data", mimeType: "text/html", maxBytes: MAX_DATA_BYTES },
  ".css": { kind: "data", mimeType: "text/css", maxBytes: MAX_DATA_BYTES },
  ".scss": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".vue": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".svelte": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".xml": { kind: "data", mimeType: "application/xml", maxBytes: MAX_DATA_BYTES },
  ".graphql": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".gql": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".yaml": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".yml": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".toml": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
  ".sql": { kind: "data", mimeType: "text/plain", maxBytes: MAX_DATA_BYTES },
});

interface BindingRow {
  id: string;
  task_id: string;
  task_version: number;
  bound_task_version: number;
  chat_id: string;
  run_id: string;
  manifest_id: string;
  artifact_ref: string;
  source_path: string;
  kind: ArtifactKind;
  mime_type: string;
  size_bytes: number;
  file_dev: string;
  file_ino: string;
  file_mtime_ns: string;
  file_ctime_ns: string;
  sha256: string;
  created_at: string;
}

interface TokenRecord {
  token: string;
  request: OneArtifactBindingRequestV1;
  expiresAtMs: number;
}

interface VerifiedFile {
  fd: number;
  row: BindingRow;
}

export interface OneVerifiedBoundArtifactSet {
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  manifestId: string;
  observedAt: string;
  setRef: string;
  artifacts: Array<{
    artifactRef: string;
    bindingRef: string;
    sizeBytes: number;
  }>;
}

const tokens = new Map<string, TokenRecord>();

/**
 * PRD §5.25 — 이 표는 이제 마이그레이션 사다리(electron/store/db.ts)가 만든다. 여기서는
 * **호환성만 확인**한다. 예전처럼 여기서 만들면 스키마 게이트가 그 존재를 못 본다.
 * (CREATE 문은 사다리와 같은 모양을 유지한다 — 사다리를 지나지 않은 오래된 개발 DB 대비.)
 */
function ensureBindingTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS one_artifact_bindings (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_version INTEGER NOT NULL,
      bound_task_version INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      manifest_id TEXT NOT NULL,
      artifact_ref TEXT NOT NULL,
      source_path TEXT NOT NULL,
      kind TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      file_dev TEXT NOT NULL,
      file_ino TEXT NOT NULL,
      file_mtime_ns TEXT NOT NULL,
      file_ctime_ns TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(task_id, chat_id, run_id, manifest_id, artifact_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_one_artifact_binding_exact
      ON one_artifact_bindings(task_id, chat_id, run_id, manifest_id, artifact_ref);
  `);
  const columns = new Set((db.prepare("PRAGMA table_info(one_artifact_bindings)").all() as Array<{ name: string }>).map((item) => item.name));
  for (const required of [
    "id", "task_id", "task_version", "bound_task_version", "chat_id", "run_id", "manifest_id",
    "artifact_ref", "source_path", "kind", "mime_type", "size_bytes", "file_dev", "file_ino",
    "file_mtime_ns", "file_ctime_ns", "sha256", "created_at",
  ]) {
    if (!columns.has(required)) throw new Error("One artifact binding store is not compatible with this runtime");
  }
}

function orderedDataKeys(manifest: AgentlasSurfaceManifest): string[] {
  const keys = Object.keys(manifest.data ?? {});
  const ordered: string[] = [];
  for (const widget of manifest.widgets ?? []) {
    if (widget.data && keys.includes(widget.data) && !ordered.includes(widget.data)) ordered.push(widget.data);
  }
  for (const key of keys) if (!ordered.includes(key)) ordered.push(key);
  return ordered.slice(0, 12);
}

function rowsOf(dataset: AgentlasSurfaceDataSet): JsonObject[] {
  if (Array.isArray(dataset.items) && dataset.items.length > 0) return dataset.items;
  return Array.isArray(dataset.rows) ? dataset.rows : [];
}

function artifactRefsForBlock(block: OneSurfaceManifestV1["blocks"][number] | undefined): Array<{ artifactRef: string; kind: string }> {
  if (block?.type === "Gallery") return block.items.map((item) => ({ artifactRef: item.artifactRef, kind: "image" }));
  if (block?.type === "Media") return block.outputs.map((item) => ({ artifactRef: item.artifactRef, kind: item.type }));
  if (block?.type === "ArtifactList") return block.items
    .filter((item) => item.type !== "other")
    .map((item) => ({ artifactRef: item.artifactRef, kind: item.type }));
  if (block?.type === "Document") return [{ artifactRef: block.artifactRef, kind: "document" }];
  return [];
}

function chatWorkspace(chatId: string): string | null {
  try {
    const row = getDb().prepare("SELECT working_folder FROM chats WHERE id = ? LIMIT 1").get(chatId) as { working_folder?: string | null } | undefined;
    return row?.working_folder && path.isAbsolute(row.working_folder) ? path.resolve(row.working_folder) : null;
  } catch {
    return null;
  }
}

function localCandidate(row: JsonObject, workspace: string | null): string | null {
  for (const key of SOURCE_KEYS) {
    const value = row[key];
    if (typeof value !== "string" || !value.trim()) continue;
    const candidate = value.trim();
    if (path.isAbsolute(candidate)) return path.resolve(candidate);
    if (workspace && !candidate.includes("://") && !path.isAbsolute(candidate)) {
      return path.resolve(workspace, candidate);
    }
    if (!candidate.startsWith("file://")) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol !== "file:" || url.search || url.hash || url.username || url.password || url.port) continue;
      const filePath = fileURLToPath(url);
      if (path.isAbsolute(filePath)) return path.resolve(filePath);
    } catch {
      // A malformed, remote, embedded, or executable transport has no local authority.
    }
  }
  return null;
}

function pathIsArchived(candidate: string): boolean {
  const normalized = candidate.split(path.sep).join("/").toLowerCase();
  return normalized.includes("/.agentlas/archive/asset-packs/") || normalized.includes("/.trash/");
}

function digestFd(fd: number, size: number): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(1_024 * 1_024, Math.max(1, size)));
  let offset = 0;
  while (offset < size) {
    const length = Math.min(buffer.byteLength, size - offset);
    const read = fs.readSync(fd, buffer, 0, length, offset);
    if (read <= 0) throw new Error("One artifact file ended before its recorded size");
    hash.update(buffer.subarray(0, read));
    offset += read;
  }
  return hash.digest("hex");
}

function safeOpen(candidate: string, spec: ArtifactSpec): {
  fd: number;
  size: number;
  mtimeMs: number;
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
  sha256: string;
} {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(candidate, flags);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size <= 0n || stat.size > BigInt(spec.maxBytes)) throw new Error("One artifact file is not a supported bounded regular file");
    const size = Number(stat.size);
    return {
      fd,
      size,
      mtimeMs: Number(stat.mtimeNs) / 1_000_000,
      dev: String(stat.dev),
      ino: String(stat.ino),
      mtimeNs: String(stat.mtimeNs),
      ctimeNs: String(stat.ctimeNs),
      sha256: digestFd(fd, size),
    };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function bindCandidate(input: {
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  manifestId: string;
  artifactRef: string;
  candidate: string;
  expectedKind: string;
  createdAt: string;
  /** Main records this before runtime invocation; model prose cannot supply it. */
  runStartedAtMs?: number | null;
}): number | null {
  if (pathIsArchived(input.candidate)) return null;
  const spec = ARTIFACT_BY_EXTENSION[path.extname(input.candidate).toLowerCase()];
  if (!spec || spec.kind !== input.expectedKind) return null;
  let resolved: string;
  try {
    resolved = resolveFsReadPath(input.candidate, { kind: "chat-assets", chatId: input.chatId });
  } catch {
    return null;
  }
  // Requiring the lexical path to equal the canonical target also rejects an
  // ancestor symlink, even when it happens to land back inside an allowed root.
  if (path.resolve(input.candidate) !== resolved || pathIsArchived(resolved)) return null;
  const opened = safeOpen(resolved, spec);
  if (
    input.runStartedAtMs != null
    && opened.mtimeMs + ONE_ARTIFACT_OUTPUT_TIME_SKEW_MS < input.runStartedAtMs
  ) {
    fs.closeSync(opened.fd);
    return null;
  }
  fs.closeSync(opened.fd);
  ensureBindingTable();
  const db = getDb();
  const existing = db.prepare(
    `SELECT * FROM one_artifact_bindings
     WHERE task_id = ? AND chat_id = ? AND run_id = ? AND manifest_id = ? AND artifact_ref = ?
     LIMIT 1`,
  ).get(input.taskId, input.chatId, input.runId, input.manifestId, input.artifactRef) as BindingRow | undefined;
  if (existing) {
    return existing.source_path === resolved
      && existing.kind === spec.kind
      && existing.mime_type === spec.mimeType
      && existing.size_bytes === opened.size
      && existing.file_dev === opened.dev
      && existing.file_ino === opened.ino
      && existing.file_mtime_ns === opened.mtimeNs
      && existing.file_ctime_ns === opened.ctimeNs
      && existing.sha256 === opened.sha256
      ? opened.size
      : null;
  }
  db.prepare(
    `INSERT INTO one_artifact_bindings (
       id, task_id, task_version, bound_task_version, chat_id, run_id, manifest_id, artifact_ref,
       source_path, kind, mime_type, size_bytes, file_dev, file_ino, file_mtime_ns,
       file_ctime_ns, sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(), input.taskId, input.taskVersion, input.taskVersion, input.chatId, input.runId,
    input.manifestId, input.artifactRef, resolved, spec.kind, spec.mimeType, opened.size,
    opened.dev, opened.ino, opened.mtimeNs, opened.ctimeNs, opened.sha256, input.createdAt,
  );
  return opened.size;
}

function markBoundArtifactVerified(surface: OneSurfaceManifestV1, artifactRef: string, sizeBytes: number): void {
  const fallback = surface.fallback.artifacts.find((item) => item.artifactRef === artifactRef);
  if (fallback) {
    fallback.verificationStatus = "verified";
    fallback.sizeBytes = sizeBytes;
  }
  for (const block of surface.blocks) {
    if (block.type === "ArtifactList") {
      const item = block.items.find((candidate) => candidate.artifactRef === artifactRef);
      if (item) {
        item.verificationStatus = "verified";
        item.sizeBytes = sizeBytes;
      }
    } else if (block.type === "Media") {
      const item = block.outputs.find((candidate) => candidate.artifactRef === artifactRef);
      if (item) {
        item.verificationStatus = "verified";
        item.sizeBytes = sizeBytes;
      }
    }
  }
}

/**
 * A model can name a file that it merely read.  Until Main has bound that
 * exact file to this run, it is not an output and must not occupy the
 * user-facing "made files" slot.  Keep the semantic result, but remove every
 * unsealed artifact reference from the shared Desktop/Mobile Surface.
 */
export function removeUnboundOneSurfaceArtifacts(surface: OneSurfaceManifestV1): number {
  const sealedRefs = new Set(
    surface.fallback.artifacts
      .filter((artifact) => artifact.verificationStatus === "verified")
      .map((artifact) => artifact.artifactRef),
  );
  const originalCount = surface.fallback.artifacts.length;
  surface.fallback.artifacts = surface.fallback.artifacts.filter((artifact) => sealedRefs.has(artifact.artifactRef));

  surface.blocks = surface.blocks.flatMap<OneSurfaceBlock>((block): OneSurfaceBlock[] => {
    if (block.type === "ArtifactList") {
      const items = block.items.filter((item) => sealedRefs.has(item.artifactRef));
      return items.length > 0 ? [{ ...block, items }] : [];
    }
    if (block.type === "Media") {
      const outputs = block.outputs.filter((item) => sealedRefs.has(item.artifactRef));
      if (outputs.length === 0) return [];
      const primaryArtifactRef = outputs.some((item) => item.artifactRef === block.primaryArtifactRef)
        ? block.primaryArtifactRef
        : outputs[0].artifactRef;
      return [{ ...block, outputs, primaryArtifactRef }];
    }
    if (block.type === "Gallery") {
      const items = block.items.filter((item) => sealedRefs.has(item.artifactRef));
      return items.length > 0 ? [{ ...block, items }] : [];
    }
    if (block.type === "Document") return sealedRefs.has(block.artifactRef) ? [block] : [];
    if (block.type === "Comparison") {
      return [{
        ...block,
        options: block.options.map((option) => (
          option.artifactRef && !sealedRefs.has(option.artifactRef)
            ? { ...option, artifactRef: undefined }
            : option
        )),
      }];
    }
    return [block];
  });
  if (surface.blocks.length === 0) {
    surface.blocks = [{
      blockId: "block:unverified-artifacts-omitted",
      type: "Narrative",
      title: "Result",
      paragraphs: ["No run-created files were verified."],
    }];
  }
  const blockOrder = surface.blocks.map((block) => block.blockId);
  surface.recomposition.desktop.blockOrder = blockOrder;
  surface.recomposition.mobile.blockOrder = blockOrder;
  return originalCount - surface.fallback.artifacts.length;
}

/**
 * Bind raw legacy transports only after the exact safe One manifest has been
 * persisted. A rejected row leaves its artifactRef as an honest Work fallback.
 */
export function bindOneSurfaceArtifacts(input: {
  rawManifest: AgentlasSurfaceManifest;
  surface: OneSurfaceManifestV1;
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  createdAt?: string;
  /** Main-owned start time used to reject pre-existing source files. */
  runStartedAt?: string;
}): number {
  if (!isDurableOneSurfaceManifestV1(input.surface, input.taskId)) return 0;
  const task = getCanonicalTask(input.taskId);
  if (!task || task.originChatId !== input.chatId || task.status === "archived" || task.version !== input.taskVersion) return 0;
  const keys = orderedDataKeys(input.rawManifest);
  const workspace = chatWorkspace(input.chatId);
  const startedAtMs = typeof input.runStartedAt === "string" ? Date.parse(input.runStartedAt) : Number.NaN;
  const trustedRunStartedAtMs = Number.isFinite(startedAtMs) ? startedAtMs : null;
  let bound = 0;
  for (let dataIndex = 0; dataIndex < keys.length && bound < ONE_ARTIFACT_MAX_BINDINGS_PER_SURFACE; dataIndex += 1) {
    const dataset = input.rawManifest.data[keys[dataIndex]];
    if (!dataset || (dataset.type !== "media" && dataset.type !== "artifacts")) continue;
    const refs = artifactRefsForBlock(input.surface.blocks[dataIndex]);
    if (!refs.length) continue;
    const rows = rowsOf(dataset).slice(0, refs.length);
    for (let rowIndex = 0; rowIndex < rows.length && bound < ONE_ARTIFACT_MAX_BINDINGS_PER_SURFACE; rowIndex += 1) {
      const row = rows[rowIndex];
      const explicitRef = typeof row.artifactRef === "string" && refs.some((item) => item.artifactRef === row.artifactRef)
        ? row.artifactRef
        : null;
      const ref = explicitRef ? refs.find((item) => item.artifactRef === explicitRef) : refs[rowIndex];
      const candidate = localCandidate(row, workspace);
      if (!ref || !candidate) continue;
      try {
        const sizeBytes = bindCandidate({
          taskId: input.taskId,
          taskVersion: input.taskVersion,
          chatId: input.chatId,
          runId: input.runId,
          manifestId: input.surface.manifestId,
          artifactRef: ref.artifactRef,
          candidate,
          expectedKind: ref.kind,
          createdAt: input.createdAt ?? new Date().toISOString(),
          runStartedAtMs: trustedRunStartedAtMs,
        });
        if (sizeBytes != null) {
          markBoundArtifactVerified(input.surface, ref.artifactRef, sizeBytes);
          bound += 1;
        }
      } catch {
        // One bad row never widens authority or breaks the rest of the Surface.
      }
    }
  }
  return bound;
}

function runtimeManifestId(runId: string): string {
  return `runtime:${createHash("sha256").update(runId, "utf8").digest("hex").slice(0, 32)}`;
}

/**
 * Admit only host-structured file completion paths (currently Codex's native
 * `patch_apply_end` event). Unlike a Surface artifact this is an in-progress
 * work product, so it has no model-authored manifest to trust. Main binds the
 * exact Task/run/version and reopens the file with O_NOFOLLOW before exposing
 * an opaque ref to the renderer. Shell text, tool args, and model prose never
 * call this boundary.
 */
export function bindOneRuntimeToolArtifacts(input: {
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
  toolId: string;
  paths: readonly string[];
  createdAt?: string;
}): Array<{
  manifestId: string;
  artifactRef: string;
  label: string;
  type: ArtifactKind;
  sizeBytes: number;
}> {
  const task = getCanonicalTask(input.taskId);
  if (!task || task.originChatId !== input.chatId || task.status === "archived" || task.version !== input.taskVersion) return [];
  const manifestId = runtimeManifestId(input.runId);
  const uniquePaths = [...new Set(input.paths
    .filter((candidate): candidate is string => typeof candidate === "string" && path.isAbsolute(candidate))
    .map((candidate) => path.resolve(candidate)))].slice(0, ONE_ARTIFACT_MAX_BINDINGS_PER_SURFACE);
  const bound: Array<{
    manifestId: string;
    artifactRef: string;
    label: string;
    type: ArtifactKind;
    sizeBytes: number;
  }> = [];
  for (const [index, candidate] of uniquePaths.entries()) {
    const spec = ARTIFACT_BY_EXTENSION[path.extname(candidate).toLowerCase()];
    if (!spec) continue;
    const artifactRef = `runtime:${createHash("sha256").update(`${input.runId}:${input.toolId}:${index}:${candidate}`, "utf8").digest("hex").slice(0, 48)}`;
    try {
      const sizeBytes = bindCandidate({
        taskId: input.taskId,
        taskVersion: input.taskVersion,
        chatId: input.chatId,
        runId: input.runId,
        manifestId,
        artifactRef,
        candidate,
        expectedKind: spec.kind,
        createdAt: input.createdAt ?? new Date().toISOString(),
      });
      if (sizeBytes != null) {
        bound.push({ manifestId, artifactRef, label: path.basename(candidate), type: spec.kind, sizeBytes });
      }
    } catch {
      // A missing, symlinked, unreadable, or out-of-scope file is not output.
    }
  }
  return bound;
}

function manifestContainsArtifact(manifest: OneSurfaceManifestV1, artifactRef: string): boolean {
  const inBlock = manifest.blocks.some((block) => {
    if (block.type === "Gallery") return block.items.some((item) => item.artifactRef === artifactRef);
    if (block.type === "Media") return block.outputs.some((item) => item.artifactRef === artifactRef)
      && (block.primaryArtifactRef !== artifactRef || ["image", "video", "audio"].includes(block.mediaType));
    if (block.type === "ArtifactList") return block.items.some((item) => item.artifactRef === artifactRef);
    if (block.type === "Document") return block.artifactRef === artifactRef;
    return false;
  });
  return inBlock && manifest.fallback.artifacts.some((item) => item.artifactRef === artifactRef);
}

function domainEntries(event: ReturnType<typeof listOneDomainEvents>[number]): Map<string, unknown> {
  return new Map(event.payload.entries.map((entry) => [entry.name, entry.value]));
}

/**
 * A binding normally stays on the Task version at which Main persisted the
 * manifest. It may follow exactly two authoritative lifecycle transitions:
 * the same run's completed terminal receipt, then that result's explicit user
 * acceptance. A rename, participant change, different run, or arbitrary later
 * Task version cannot silently re-authorize old local bytes.
 */
function exactLifecycleTransition(row: BindingRow, input: OneArtifactBindingRequestV1): boolean {
  if (row.task_version !== row.bound_task_version || input.taskVersion <= row.bound_task_version) return false;
  const receipt = getInvocationRunReceipt(row.run_id);
  if (!receipt || receipt.runId !== row.run_id || receipt.chatId !== row.chat_id || receipt.status !== "completed") return false;
  const taskEvents = listOneDomainEvents(row.task_id, 500);
  const manifestReady = taskEvents.some((event) => {
    if (event.eventType !== "result.manifest_ready"
      || event.actor !== "system"
      || event.entityId !== row.task_id
      || event.taskId !== row.task_id
      || event.version !== row.bound_task_version) return false;
    const entries = domainEntries(event);
    const artifactRefs = entries.get("artifactRefs");
    return entries.get("manifestId") === row.manifest_id
      && Array.isArray(artifactRefs)
      && artifactRefs.includes(row.artifact_ref);
  });
  if (!manifestReady) return false;
  const runStarted = listOneDomainEvents(row.run_id, 100).some((event) => {
    if (event.eventType !== "run.started"
      || event.entityId !== row.run_id
      || event.taskId !== row.task_id) return false;
    return domainEntries(event).get("runId") === row.run_id;
  });
  if (!runStarted) return false;
  const terminalReceipt = taskEvents.find((event) => {
    if (event.eventType !== "receipt.recorded"
      || event.actor !== "system"
      || event.entityId !== row.task_id
      || event.taskId !== row.task_id
      || event.version <= row.bound_task_version) return false;
    const entries = domainEntries(event);
    const refs = entries.get("sourceOrRunRefs");
    return entries.get("receiptId") === `receipt:${row.run_id}`
      && entries.get("kind") === "invoke_completed"
      && Array.isArray(refs)
      && refs.length === 1
      && refs[0] === row.run_id;
  });
  if (!terminalReceipt) return false;
  if (input.taskVersion === terminalReceipt.version) return true;
  const acceptance = taskEvents.find((event) => {
    if (event.eventType !== "task.state_changed"
      || event.actor !== "user"
      || event.entityId !== row.task_id
      || event.taskId !== row.task_id
      || event.version !== input.taskVersion
      || event.version <= terminalReceipt.version) return false;
    const entries = domainEntries(event);
    return entries.get("from") === "partial"
      && entries.get("to") === "completed"
      && entries.get("reason") === "explicit user acceptance of a matching completed run receipt";
  });
  if (!acceptance) return false;
  const closureState = getOneValueClosureState();
  return closureState.closures.some((record) => {
    if (record.closure.taskId !== row.task_id || record.taskVersion !== input.taskVersion) return false;
    return closureState.evidence.some((evidence) =>
      record.trustedEvidenceRefs.includes(evidence.evidenceRef)
      && evidence.taskId === row.task_id
      && evidence.taskVersion === input.taskVersion
      && evidence.kind === "result_acceptance"
      && evidence.source === "canonical_task_runtime"
      && evidence.verificationStatus === "verified"
      && evidence.sourceRunRef === row.run_id,
    );
  });
}

function exactBinding(input: unknown): BindingRow | null {
  if (!isOneArtifactBindingRequestV1(input)) return null;
  const task = getCanonicalTask(input.taskId);
  const runtimeBinding = input.manifestId === runtimeManifestId(input.runId) && input.artifactRef.startsWith("runtime:");
  // Runtime tool artifacts are emitted while the run is active. The terminal
  // Task transition may advance its version before the user reopens the file;
  // the opaque row remains pinned to its creation version, so a later version
  // of the same non-archived Task must not invalidate that exact run binding.
  // Durable surface artifacts retain the stricter exact-version/lifecycle gate.
  if (
    !task
    || task.originChatId !== input.chatId
    || task.status === "archived"
    || (runtimeBinding ? task.version < input.taskVersion : task.version !== input.taskVersion)
  ) return null;
  if (!runtimeBinding) {
    const durable = getDurableOneSurfaceResult({ runId: input.runId, chatId: input.chatId, taskId: input.taskId });
    if (!durable || durable.manifest.manifestId !== input.manifestId || !manifestContainsArtifact(durable.manifest, input.artifactRef)) return null;
  }
  ensureBindingTable();
  const row = getDb().prepare(
    `SELECT * FROM one_artifact_bindings
     WHERE task_id = ? AND chat_id = ? AND run_id = ? AND manifest_id = ? AND artifact_ref = ?
     LIMIT 1`,
  ).get(input.taskId, input.chatId, input.runId, input.manifestId, input.artifactRef) as BindingRow | undefined;
  if (!row) return null;
  if (runtimeBinding) return input.taskVersion === row.bound_task_version ? row : null;
  if (input.taskVersion !== row.bound_task_version && !exactLifecycleTransition(row, input)) return null;
  return row;
}

function verifiedFile(input: unknown): VerifiedFile | null {
  const row = exactBinding(input);
  if (!row || pathIsArchived(row.source_path)) return null;
  const spec = ARTIFACT_BY_EXTENSION[path.extname(row.source_path).toLowerCase()];
  if (!spec || spec.kind !== row.kind || spec.mimeType !== row.mime_type) return null;
  let resolved: string;
  try {
    resolved = resolveFsReadPath(row.source_path, { kind: "chat-assets", chatId: row.chat_id });
  } catch {
    return null;
  }
  if (resolved !== row.source_path || pathIsArchived(resolved)) return null;
  try {
    const opened = safeOpen(resolved, spec);
    const same = opened.size === row.size_bytes
      && opened.dev === row.file_dev
      && opened.ino === row.file_ino
      && opened.mtimeNs === row.file_mtime_ns
      && opened.ctimeNs === row.file_ctime_ns
      && opened.sha256 === row.sha256;
    if (!same) {
      fs.closeSync(opened.fd);
      return null;
    }
    return { fd: opened.fd, row };
  } catch {
    return null;
  }
}

/**
 * Re-verify the complete, exact media deliverable for an accepted One run.
 *
 * This intentionally ignores renderer/model-authored `verificationStatus`.
 * Authority comes only from the Main-private binding row and a fresh
 * O_NOFOLLOW reopen whose dev/ino/timestamps/size/SHA-256 still match. A mixed
 * document bundle, an unbound media item, or even one stale byte keeps the
 * accepted result partially verified.
 */
export function verifyOneAcceptedSurfaceArtifactSet(input: {
  taskId: string;
  taskVersion: number;
  chatId: string;
  runId: string;
}): OneVerifiedBoundArtifactSet | null {
  const task = getCanonicalTask(input.taskId);
  if (
    !task
    || task.status !== "completed"
    || task.version !== input.taskVersion
    || task.originChatId !== input.chatId
  ) return null;
  const receipt = getInvocationRunReceipt(input.runId);
  if (
    !receipt
    || receipt.status !== "completed"
    || receipt.chatId !== input.chatId
    || typeof receipt.finishedAt !== "string"
  ) return null;
  const durable = getDurableOneSurfaceResult(input);
  if (!durable) return null;
  const artifacts = durable.manifest.fallback.artifacts;
  if (
    artifacts.length < 1
    || new Set(artifacts.map((artifact) => artifact.artifactRef)).size !== artifacts.length
    || artifacts.some((artifact) => !["image", "video", "audio"].includes(artifact.type))
  ) return null;

  const verified: Array<{ artifactRef: string; row: BindingRow }> = [];
  for (const artifact of artifacts) {
    const file = verifiedFile({
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      chatId: input.chatId,
      runId: input.runId,
      manifestId: durable.manifest.manifestId,
      artifactRef: artifact.artifactRef,
    });
    if (!file) return null;
    if (
      file.row.kind !== artifact.type
      || (artifact.sizeBytes !== undefined && artifact.sizeBytes !== file.row.size_bytes)
    ) {
      fs.closeSync(file.fd);
      return null;
    }
    fs.closeSync(file.fd);
    verified.push({ artifactRef: artifact.artifactRef, row: file.row });
  }

  const canonical = verified
    .map(({ artifactRef, row }) => ({
      artifactRef,
      kind: row.kind,
      mimeType: row.mime_type,
      sizeBytes: row.size_bytes,
      dev: row.file_dev,
      ino: row.file_ino,
      mtimeNs: row.file_mtime_ns,
      ctimeNs: row.file_ctime_ns,
      sha256: row.sha256,
    }))
    .sort((left, right) => left.artifactRef.localeCompare(right.artifactRef));
  const setDigest = createHash("sha256")
    .update(JSON.stringify({
      taskId: input.taskId,
      taskVersion: input.taskVersion,
      chatId: input.chatId,
      runId: input.runId,
      manifestId: durable.manifest.manifestId,
      artifacts: canonical,
    }), "utf8")
    .digest("hex");
  return {
    taskId: input.taskId,
    taskVersion: input.taskVersion,
    chatId: input.chatId,
    runId: input.runId,
    manifestId: durable.manifest.manifestId,
    observedAt: task.updatedAt,
    setRef: `filesystem-artifact-set:${setDigest}`,
    artifacts: canonical.map((artifact) => ({
      artifactRef: artifact.artifactRef,
      bindingRef: `filesystem-artifact-binding:${createHash("sha256")
        .update(`${setDigest}:${artifact.artifactRef}:${artifact.sha256}`, "utf8")
        .digest("hex")}`,
      sizeBytes: artifact.sizeBytes,
    })),
  };
}

function pruneTokens(nowMs: number): void {
  for (const [token, record] of tokens) if (record.expiresAtMs <= nowMs) tokens.delete(token);
  while (tokens.size >= MAX_ACTIVE_TOKENS) {
    const oldest = tokens.keys().next().value as string | undefined;
    if (!oldest) break;
    tokens.delete(oldest);
  }
}

export function issueOneArtifactPreviewCapability(
  input: unknown,
  nowMs = Date.now(),
): OneArtifactPreviewCapabilityV1 | null {
  if (!Number.isFinite(nowMs)) return null;
  const verified = verifiedFile(input);
  if (!verified || !isOneArtifactBindingRequestV1(input)) return null;
  fs.closeSync(verified.fd);
  pruneTokens(nowMs);
  let token = "";
  do token = randomBytes(32).toString("hex"); while (tokens.has(token));
  const expiresAtMs = nowMs + ONE_ARTIFACT_PREVIEW_TTL_MS;
  tokens.set(token, { token, request: { ...input }, expiresAtMs });
  return {
    capabilityUrl: `agentlas://one-artifact/${token}`,
    mimeType: verified.row.mime_type,
    kind: verified.row.kind,
    sizeBytes: verified.row.size_bytes,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

function tokenFromUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "agentlas:" || url.hostname !== "one-artifact" || url.search || url.hash) return null;
    const token = url.pathname.replace(/^\//, "");
    return TOKEN_RE.test(token) ? token : null;
  } catch {
    return null;
  }
}

export function revokeOneArtifactPreview(input: unknown): boolean {
  if (!isOneArtifactPreviewRevokeV1(input)) return false;
  const token = tokenFromUrl(input.capabilityUrl);
  if (!token) return false;
  const record = tokens.get(token);
  if (!record) return false;
  if (record.request.taskId !== input.taskId
    || record.request.taskVersion !== input.taskVersion
    || record.request.chatId !== input.chatId
    || record.request.runId !== input.runId
    || record.request.manifestId !== input.manifestId
    || record.request.artifactRef !== input.artifactRef) return false;
  return tokens.delete(token);
}

/** Main-only result for the explicit shell.openPath action. */
export function resolveOneArtifactOpenPath(input: unknown): string | null {
  const verified = verifiedFile(input);
  if (!verified) return null;
  fs.closeSync(verified.fd);
  return verified.row.source_path;
}

/**
 * Mobile receives only bytes from the exact Main-private artifact binding.
 * The 5 MiB cap keeps canonical base64 below the Bridge frame/Flutter decoder
 * limits; larger images retain their semantic artifact row without a preview.
 */
export function readOneArtifactImagePreview(
  input: unknown,
): { mimeType: string; base64: string } | null {
  const verified = verifiedFile(input);
  if (!verified) return null;
  try {
    if (
      verified.row.kind !== "image"
      || !MOBILE_IMAGE_PREVIEW_MIME_TYPES.has(verified.row.mime_type)
      || verified.row.size_bytes > MAX_MOBILE_IMAGE_PREVIEW_BYTES
    ) {
      return null;
    }
    const bytes = Buffer.allocUnsafe(verified.row.size_bytes);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = fs.readSync(verified.fd, bytes, offset, bytes.byteLength - offset, offset);
      if (read <= 0) return null;
      offset += read;
    }
    return { mimeType: verified.row.mime_type, base64: bytes.toString("base64") };
  } finally {
    fs.closeSync(verified.fd);
  }
}

function parseRange(raw: string | null, size: number): { start: number; end: number; partial: boolean } | null {
  if (!raw) return { start: 0, end: size - 1, partial: false };
  if (raw.includes(",")) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(raw.trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size) return null;
    end = Math.min(end, size - 1);
  }
  end = Math.min(end, start + ONE_ARTIFACT_MAX_RANGE_BYTES - 1);
  return { start, end, partial: true };
}

function safeError(status: 404 | 416, size?: number): Response {
  return new Response(status === 404 ? "Not found" : "Range not satisfiable", {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(status === 416 && size != null ? { "Content-Range": `bytes */${size}` } : {}),
    },
  });
}

/** Protocol boundary for agentlas://one-artifact/<opaque token>. */
export function serveOneArtifactProtocolRequest(
  rawUrl: string,
  rangeHeader: string | null,
  nowMs = Date.now(),
): Response {
  const token = tokenFromUrl(rawUrl);
  if (!token) return safeError(404);
  pruneTokens(nowMs);
  const record = tokens.get(token);
  if (!record || record.expiresAtMs <= nowMs) return safeError(404);
  const verified = verifiedFile(record.request);
  if (!verified) {
    tokens.delete(token);
    return safeError(404);
  }
  const range = parseRange(rangeHeader, verified.row.size_bytes);
  if (!range) {
    fs.closeSync(verified.fd);
    return safeError(416, verified.row.size_bytes);
  }
  const stream = fs.createReadStream(verified.row.source_path, {
    fd: verified.fd,
    autoClose: true,
    start: range.start,
    end: range.end,
  });
  const length = range.end - range.start + 1;
  return new Response(Readable.toWeb(stream) as unknown as BodyInit, {
    status: range.partial ? 206 : 200,
    headers: {
      "Content-Type": verified.row.mime_type,
      "Content-Length": String(length),
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, no-store, max-age=0",
      "Content-Disposition": "inline",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      ...(range.partial ? { "Content-Range": `bytes ${range.start}-${range.end}/${verified.row.size_bytes}` } : {}),
    },
  });
}

/** Test-only process restart simulation; production tokens die with Main. */
export function resetOneArtifactPreviewCapabilitiesForTests(): void {
  tokens.clear();
}
