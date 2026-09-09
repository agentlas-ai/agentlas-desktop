// Main-process filesystem authority.
//
// The renderer may name a target path, but it never names the root that makes
// that target readable. Roots come from either an opaque picker/drop grant or
// main-owned state (the chat working folder and app-generated asset folders).
import { app } from "electron";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FsPathGrant, FsReadScope } from "../../shared/types";
import { getDb } from "../store/db";
import { captureArtifactsRoot } from "../media/capture-artifacts";
import { userDataPath, userDataDir } from "../runtime-paths";

type GrantMode = "tree" | "file";

interface GrantRecord {
  token: string;
  path: string;
  mode: GrantMode;
  durable: boolean;
  createdAt: string;
}

interface RootRule {
  path: string;
  mode: GrantMode;
  /** Picker/chat roots are stored as canonical realpaths and must stay so. */
  canonical?: boolean;
}

const GRANT_FILE = "fs-read-grants.v1.json";
const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATED_ROOT_NAMES = [
  "agent-cwd",
  "generated-agent-os",
  "generated-apps",
  "generated-assets",
  "generated-teams",
  "generated-tools",
  "multimodal-images",
  "multimodal-video",
] as const;
const LOCAL_MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv",
  ".mp3", ".mpeg", ".m4a", ".wav", ".ogg", ".oga", ".opus", ".flac", ".aac", ".weba", ".mid", ".midi",
  /* ★PDF — 렌더러는 `agentlas://app` origin 이고 `webSecurity: true` 라서 `file://`
     iframe 은 무조건 차단된다. 이 목록에 없으면 PDF 뷰어는 **구조적으로** 아무것도
     못 띄운다(칩으로 광고만 하고 있었다). 서빙 경로는 이미지·영상과 동일한
     main-authoritative root + realpath 검사를 그대로 통과한다. */
  ".pdf",
  // Office/iWork/Hangul are only exposed as bytes to the in-app document
  // renderer. Macro-capable containers are parsed for preview; nothing inside
  // them is executed by the renderer.
  ".doc", ".docx", ".docm", ".dot", ".dotx", ".rtf", ".odt", ".pages", ".hwp", ".hwpx",
  ".ppt", ".pptx", ".pptm", ".pot", ".potx", ".ppsx", ".odp", ".key",
  ".xls", ".xlsx", ".xlsm", ".xlsb", ".xlt", ".xltx", ".csv", ".tsv", ".ods", ".numbers",
  ".zip",
]);

/** 붙여넣기에는 원본 경로가 없을 수 있다. Main이 허용 형식·확장자·상한을 결정한다. */
const PASTED_ATTACHMENT_EXTENSIONS: Readonly<Record<string, string>> = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/json": ".json",
});
/** One 첨부 상한과 맞춘다. 이미지만 더 작은 상한을 유지한다. */
const PASTED_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PASTED_FILE_MAX_BYTES = 64 * 1024 * 1024;
/** 첨부로 태우지 않고 남은 붙여넣기 원본을 방치하지 않는다. */
const PASTED_ATTACHMENT_TTL_MS = 6 * 60 * 60 * 1_000;

const grants = new Map<string, GrantRecord>();
let durableLoaded = false;

function looksLikeDeclaredImage(mediaType: string, bytes: Buffer): boolean {
  if (mediaType === "image/png") {
    return bytes.byteLength >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mediaType === "image/jpeg") {
    return bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mediaType === "image/gif") {
    const head = bytes.subarray(0, 6).toString("latin1");
    return head === "GIF87a" || head === "GIF89a";
  }
  if (mediaType === "image/webp") {
    return bytes.byteLength >= 12
      && bytes.subarray(0, 4).toString("latin1") === "RIFF"
      && bytes.subarray(8, 12).toString("latin1") === "WEBP";
  }
  return false;
}

function looksLikeDeclaredPastedAttachment(mediaType: string, bytes: Buffer): boolean {
  if (mediaType.startsWith("image/")) return looksLikeDeclaredImage(mediaType, bytes);
  if (mediaType === "audio/mpeg") return bytes.subarray(0, 3).equals(Buffer.from("ID3")) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  if (mediaType === "audio/wav") return bytes.byteLength >= 12 && bytes.subarray(0, 4).equals(Buffer.from("RIFF")) && bytes.subarray(8, 12).equals(Buffer.from("WAVE"));
  if (mediaType === "audio/flac") return bytes.subarray(0, 4).equals(Buffer.from("fLaC"));
  if (mediaType === "audio/ogg") return bytes.subarray(0, 4).equals(Buffer.from("OggS"));
  if (mediaType === "audio/aac") return bytes.byteLength >= 2 && bytes[0] === 0xff && (bytes[1] & 0xf6) === 0xf0;
  if (mediaType === "audio/mp4" || mediaType === "video/mp4" || mediaType === "video/quicktime") {
    return bytes.byteLength >= 12 && bytes.subarray(4, 8).equals(Buffer.from("ftyp"));
  }
  if (mediaType === "video/webm") return bytes.byteLength >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mediaType === "application/pdf") return bytes.subarray(0, 5).equals(Buffer.from("%PDF-"));
  if (mediaType === "application/json") {
    try { JSON.parse(bytes.toString("utf8")); return true; } catch { return false; }
  }
  // Plain-text formats are staged as inert data. They are never rendered as HTML.
  return mediaType === "text/plain" || mediaType === "text/markdown" || mediaType === "text/csv";
}

/** One 첨부 스테이징 루트 바깥의 전용 비공개 디렉터리(안이면 첨부가 자기 파일로 보고 거부한다). */
function ensurePastedAttachmentRoot(): string {
  const root = userDataPath("one-pasted-attachments-v1");
  const stat = fs.existsSync(root) ? fs.lstatSync(root) : null;
  if (stat && !stat.isDirectory()) {
    throw new FsAccessDeniedError("The pasted-attachment staging path is not a directory.");
  }
  if (!stat) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.realpathSync.native(root);
}

function sweepStalePastedAttachments(root: string): void {
  const staleBefore = Date.now() - PASTED_ATTACHMENT_TTL_MS;
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    const candidate = path.join(root, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (stat.isFile() && stat.mtimeMs < staleBefore) fs.rmSync(candidate, { force: true });
    } catch {
      // 한 파일의 청소 실패가 붙여넣기를 막아선 안 된다.
    }
  }
}

export class FsAccessDeniedError extends Error {
  constructor(message = "Filesystem read is outside the approved scope.") {
    super(message);
    this.name = "FsAccessDeniedError";
  }
}

function grantStorePath(): string {
  return process.env.AGENTLAS_FS_GRANT_STORE?.trim() || userDataPath(GRANT_FILE);
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function realpathExisting(rawPath: string): string | null {
  if (typeof rawPath !== "string" || !path.isAbsolute(rawPath)) return null;
  try {
    return fs.realpathSync.native(path.resolve(rawPath));
  } catch {
    return null;
  }
}

function validStoredGrant(value: unknown): GrantRecord | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Partial<GrantRecord>;
  if (
    typeof item.token !== "string" || !TOKEN_RE.test(item.token) ||
    typeof item.path !== "string" || !path.isAbsolute(item.path) ||
    (item.mode !== "tree" && item.mode !== "file") ||
    item.durable !== true ||
    typeof item.createdAt !== "string"
  ) {
    return null;
  }
  return item as GrantRecord;
}

function loadDurableGrants(): void {
  if (durableLoaded) return;
  durableLoaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(grantStorePath(), "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const item of parsed) {
      const record = validStoredGrant(item);
      if (record) grants.set(record.token, record);
    }
  } catch {
    // First launch, a deleted store, or a malformed store means no authority.
  }
}

function persistDurableGrants(): void {
  const filePath = grantStorePath();
  const tmpPath = `${filePath}.tmp`;
  const records = [...grants.values()].filter((record) => record.durable);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(records, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

function recordToGrant(record: GrantRecord): FsPathGrant {
  return {
    path: record.path,
    kind: record.mode === "tree" ? "directory" : "file",
    durable: record.durable,
    scope: { kind: "capability", token: record.token },
  };
}

/** Called only with a path obtained by main's native picker or preload's webUtils bridge. */
export function grantPath(rawPath: string, options: { durable: boolean; exactFile?: boolean }): FsPathGrant {
  loadDurableGrants();
  const real = realpathExisting(rawPath);
  if (!real) throw new FsAccessDeniedError("The selected path does not exist or is not absolute.");
  const stat = fs.lstatSync(real);
  const mode: GrantMode = options.exactFile ? "file" : "tree";
  if ((mode === "file" && !stat.isFile()) || (mode === "tree" && !stat.isDirectory())) {
    throw new FsAccessDeniedError(mode === "file" ? "The dropped item is not a file." : "The selected item is not a directory.");
  }

  const existing = [...grants.values()].find(
    (record) => record.path === real && record.mode === mode && record.durable === options.durable,
  );
  if (existing) return recordToGrant(existing);

  const record: GrantRecord = {
    token: randomUUID(),
    path: real,
    mode,
    durable: options.durable,
    createdAt: new Date().toISOString(),
  };
  grants.set(record.token, record);
  if (record.durable) persistDurableGrants();
  return recordToGrant(record);
}

/** A trusted preload drop may contain either a file or a directory. */
export function grantDroppedPath(rawPath: string): FsPathGrant {
  const real = realpathExisting(rawPath);
  if (!real) throw new FsAccessDeniedError("The dropped path does not exist or is not absolute.");
  const stat = fs.lstatSync(real);
  if (stat.isFile()) return grantPath(real, { durable: false, exactFile: true });
  if (stat.isDirectory()) return grantPath(real, { durable: false });
  throw new FsAccessDeniedError("The dropped item is not a regular file or directory.");
}

/**
 * 붙여넣기·스크린샷 이미지는 클립보드에만 있고 디스크 경로가 없다. `getPathForFile`이
 * 빈 값을 주므로 드롭용 capability를 받을 수 없고, 그래서 One 첨부 파이프(경로에서
 * 스테이징으로 복사)에 애초에 들어갈 수 없었다(제보 2026-08-13: Work는 되는데 One은 안 됨).
 *
 * 여기서 내용을 사용자 데이터 안의 비공개 파일로 고정하고, 드롭과 **동일 등급**의
 * capability를 발급한다. 파일 이름과 확장자는 호출자가 정하지 못하고(경로 조작·확장자
 * 위장 차단), 선언한 타입은 매직 바이트로 대조한다 — 렌더러의 주장만 믿지 않는다.
 */
export function grantPastedAttachment(input: { mediaType?: unknown; bytes?: unknown }): FsPathGrant {
  const mediaType = typeof input?.mediaType === "string" ? input.mediaType.trim().toLowerCase() : "";
  const extension = PASTED_ATTACHMENT_EXTENSIONS[mediaType];
  if (!extension) {
    throw new FsAccessDeniedError("This pasted file type is not supported in One attachments.");
  }
  const bytes = input?.bytes instanceof Uint8Array
    ? Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
    : Buffer.isBuffer(input?.bytes)
      ? input.bytes as Buffer
      : ArrayBuffer.isView(input?.bytes) || input?.bytes instanceof ArrayBuffer
        ? Buffer.from(input.bytes as ArrayBuffer)
        : null;
  if (!bytes || bytes.byteLength === 0) {
    throw new FsAccessDeniedError("The pasted attachment is empty.");
  }
  const maxBytes = mediaType.startsWith("image/") ? PASTED_IMAGE_MAX_BYTES : PASTED_FILE_MAX_BYTES;
  if (bytes.byteLength > maxBytes) {
    throw new FsAccessDeniedError("The pasted attachment exceeds One's safe size limit.");
  }
  if (!looksLikeDeclaredPastedAttachment(mediaType, bytes)) {
    throw new FsAccessDeniedError("The pasted content does not match the file type it claims to be.");
  }
  const root = ensurePastedAttachmentRoot();
  sweepStalePastedAttachments(root);
  // 이름은 main이 만든다 — 붙여넣기 원본에는 신뢰할 이름 자체가 없다.
  const target = path.join(root, `pasted-${randomUUID()}${extension}`);
  const fd = fs.openSync(target, "wx", 0o600);
  try {
    fs.writeSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  return grantPath(target, { durable: false, exactFile: true });
}

/** Backward-compatible image-only entry point for older preload clients and its contract gate. */
export function grantPastedImage(input: { mediaType?: unknown; bytes?: unknown }): FsPathGrant {
  const mediaType = typeof input?.mediaType === "string" ? input.mediaType.trim().toLowerCase() : "";
  if (!mediaType.startsWith("image/")) {
    throw new FsAccessDeniedError("Only PNG, JPEG, GIF, and WebP images can be pasted.");
  }
  return grantPastedAttachment(input);
}

export function pathFromGrant(grant: FsPathGrant, expectedKind?: FsPathGrant["kind"]): string {
  loadDurableGrants();
  if (
    !grant || typeof grant !== "object" || typeof grant.path !== "string" ||
    grant.scope?.kind !== "capability" || typeof grant.scope.token !== "string"
  ) {
    throw new FsAccessDeniedError("A valid filesystem capability is required.");
  }
  const record = grants.get(grant.scope.token);
  const recordKind: FsPathGrant["kind"] | null = record ? (record.mode === "tree" ? "directory" : "file") : null;
  if (
    !record || record.path !== grant.path || recordKind !== grant.kind ||
    record.durable !== grant.durable || (expectedKind && recordKind !== expectedKind)
  ) {
    throw new FsAccessDeniedError("The filesystem capability is unknown or does not match the path.");
  }
  const currentReal = realpathExisting(record.path);
  if (!currentReal || currentReal !== record.path) {
    throw new FsAccessDeniedError("The approved path is no longer available.");
  }
  return record.path;
}

function generatedRootRules(): RootRule[] {
  const userData = userDataDir();
  return GENERATED_ROOT_NAMES.map((name) => ({ path: path.join(userData, name), mode: "tree" }));
}

function chatWorkspaceRule(chatId: string): RootRule | null {
  if (!chatId || chatId.length > 256) return null;
  try {
    const row = getDb()
      .prepare("SELECT working_folder AS path FROM chats WHERE id = ?")
      .get(chatId) as { path: string | null } | undefined;
    return row?.path ? { path: row.path, mode: "tree", canonical: true } : null;
  } catch {
    return null;
  }
}

function allChatWorkspaceRules(): RootRule[] {
  try {
    const rows = getDb()
      .prepare("SELECT DISTINCT working_folder AS path FROM chats WHERE working_folder IS NOT NULL")
      .all() as Array<{ path: string }>;
    return rows
      .filter((row) => typeof row.path === "string" && path.isAbsolute(row.path))
      .map((row) => ({ path: row.path, mode: "tree", canonical: true }));
  } catch {
    return [];
  }
}

function capabilityRule(scope: FsReadScope): RootRule | null {
  if (scope.kind !== "capability" || typeof scope.token !== "string" || !TOKEN_RE.test(scope.token)) return null;
  loadDurableGrants();
  const record = grants.get(scope.token);
  return record ? { path: record.path, mode: record.mode, canonical: true } : null;
}

function rulesForScope(scope: FsReadScope): RootRule[] {
  if (!scope || typeof scope !== "object" || typeof scope.kind !== "string") return [];
  if (scope.kind === "capability") {
    const rule = capabilityRule(scope);
    return rule ? [rule] : [];
  }
  if (scope.kind === "chat-workspace") {
    const rule = chatWorkspaceRule(scope.chatId);
    return rule ? [rule] : [];
  }
  if (scope.kind === "chat-assets") {
    const workspace = chatWorkspaceRule(scope.chatId);
    return [
      ...(workspace ? [workspace] : []),
      ...generatedRootRules(),
      // Native CLI captures use the same Main-owned store already admitted by
      // the local-file renderer. Task artifact binding must admit it too.
      { path: captureArtifactsRoot(), mode: "tree", canonical: true },
    ];
  }
  return [];
}

function realRule(rule: RootRule): RootRule | null {
  const resolved = path.resolve(rule.path);
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return null;
  } catch {
    return null;
  }
  const real = realpathExisting(rule.path);
  if (!real || (rule.canonical && real !== resolved)) return null;
  return { path: real, mode: rule.mode, canonical: rule.canonical };
}

function ruleAllows(realTarget: string, rule: RootRule): boolean {
  const root = realRule(rule);
  if (!root) return false;
  return root.mode === "file" ? realTarget === root.path : isInsidePath(realTarget, root.path);
}

/** Resolve a renderer-named target only after main derives the allowed roots. */
export function resolveFsReadPath(absPath: string, scope: FsReadScope): string {
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) {
    throw new FsAccessDeniedError("Filesystem reads require an absolute target path.");
  }
  const requested = path.resolve(absPath);
  let targetLstat: fs.Stats;
  try {
    targetLstat = fs.lstatSync(requested);
  } catch {
    throw new FsAccessDeniedError("The requested path does not exist.");
  }
  // A direct symlink is never surfaced. Ancestor symlink escapes are caught by
  // comparing the final realpath to the real authorized root below.
  if (targetLstat.isSymbolicLink()) {
    throw new FsAccessDeniedError("Symbolic links are not readable through the renderer bridge.");
  }
  const realTarget = realpathExisting(requested);
  if (!realTarget || !rulesForScope(scope).some((rule) => ruleAllows(realTarget, rule))) {
    throw new FsAccessDeniedError();
  }
  return realTarget;
}

/** Main-only helper for domain-specific IPCs whose root is derived in main. */
export function resolveMainOwnedReadPath(absPath: string, mainRoot: string): string {
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) {
    throw new FsAccessDeniedError("Filesystem reads require an absolute target path.");
  }
  const requested = path.resolve(absPath);
  let targetLstat: fs.Stats;
  try {
    targetLstat = fs.lstatSync(requested);
  } catch {
    throw new FsAccessDeniedError("The requested path does not exist.");
  }
  if (targetLstat.isSymbolicLink()) {
    throw new FsAccessDeniedError("Symbolic links are not readable through the renderer bridge.");
  }
  const realTarget = realpathExisting(requested);
  if (!realTarget || !ruleAllows(realTarget, { path: mainRoot, mode: "tree" })) {
    throw new FsAccessDeniedError();
  }
  return realTarget;
}

/**
 * Policy used by agentlas://localfile. Only media files under app-generated
 * roots or persisted chat workspaces may be served. Picker/drop grants are not
 * implicitly promoted to media-serving authority.
 */
export function authorizeLocalMediaPath(absPath: string): string | null {
  if (typeof absPath !== "string" || !path.isAbsolute(absPath)) return null;
  const requested = path.resolve(absPath);
  if (!LOCAL_MEDIA_EXTS.has(path.extname(requested).toLowerCase())) return null;
  let targetLstat: fs.Stats;
  try {
    targetLstat = fs.lstatSync(requested);
  } catch {
    return null;
  }
  if (targetLstat.isSymbolicLink() || !targetLstat.isFile()) return null;
  const realTarget = realpathExisting(requested);
  if (!realTarget) return null;

  loadDurableGrants();
  const approved: RootRule[] = [
    ...generatedRootRules(),
    // 캡처 정본 홈(~/.agentlas/captures) — computer-use get_screen 과 브라우저 MCP
    // 스크린샷이 여기 저장되고, 채팅 마크다운이 이 절대경로를 참조한다.
    // 이 루트가 빠지면 캡처는 파일이 있어도 404 → 빈 이미지로 렌더된다.
    { path: captureArtifactsRoot(), mode: "tree" },
    ...allChatWorkspaceRules(),
  ];
  return approved.some((rule) => ruleAllows(realTarget, rule)) ? realTarget : null;
}

/** Test-only reset; production code never revokes durable user picker grants. */
export function resetFsAccessForTests(): void {
  grants.clear();
  durableLoaded = false;
}
