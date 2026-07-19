import { app } from "electron";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED,
  ONE_HUB_DERIVATIVE_CONTRACT_VERSION,
  isOneHubDerivativeDraft,
  isOneHubDerivativeState,
  type GetOneHubDerivativeDraftInput,
  type OneHubDerivativeDraft,
  type OneHubDerivativeExcludedSummary,
  type OneHubDerivativeExclusionCategory,
  type OneHubDerivativeIncludedFile,
  type OneHubDerivativeState,
} from "../../shared/one-hub-derivative";
import { unsafeOneSuggestionTextReason } from "../../shared/one-suggestions";
import {
  scanCloudAgentFolderForLocalReview,
  type CloudAgentLocalReviewScan,
  type PackagedFile,
} from "../cloud-agents/package";
import { readCloudAgentRestoreMarker } from "../cloud-agents/restore";
import { getAgentById } from "../mcp/registry";
import { getDb } from "../store/db";

export const ONE_HUB_DERIVATIVE_META_KEY = "agentlas.one.hub-derivative-drafts.v1";

const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const DRAFT_ID_RE = /^one_hub_draft_[a-f0-9]{32}$/;
const SUGGESTION_ID_RE = /^one_suggestion_[a-f0-9]{32}$/;
const REVIEW_ID_RE = /^one_suggestion_review_[a-f0-9]{32}$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const MAX_DRAFT_FILES = 64;
const MAX_DRAFT_BYTES = 768 * 1024;
const MANIFEST_FILE = "review.manifest.json";
const PUBLIC_ROOT = "package";

const PRIVATE_CONTENT_RE = /\b(?:confidential|internal[- ]only|private[- ]example|customer[- ]data|client[- ]data|do not distribute)\b/i;
const CUSTOMER_CONTENT_RE = /(?:\b(?:customer|client|account holder)\s*(?:name|email|phone|record|id)\b|\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b)/i;

interface PrepareOneHubDerivativeDraftInput {
  draftId: string;
  suggestionId: string;
  reviewRequestId: string;
  originTaskId: string;
  privateSourceId: string;
  createdAt: string;
}

export interface PreparedOneHubDerivativeDraft {
  draft: OneHubDerivativeDraft;
  commit: () => void;
  rollback: () => void;
}

interface ExactOwnerPrivateRelease {
  slug: string;
  packageHash: string;
  packageHashVersion: "path-sha256-executable-v2";
  cloudId: string;
  revision: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value);
  const allowed = new Set(expected);
  if (actual.length !== expected.length || actual.some((key) => !allowed.has(key))) {
    throw new TypeError(`${label} must be a closed object`);
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function initialState(): OneHubDerivativeState {
  const version = Math.max(1, Date.now());
  const now = new Date(version).toISOString();
  return {
    contractVersion: ONE_HUB_DERIVATIVE_CONTRACT_VERSION,
    version,
    drafts: [],
    createdAt: now,
    updatedAt: now,
  };
}

function parseState(raw: string): OneHubDerivativeState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Stored One Hub derivative state is corrupt; it was not overwritten");
  }
  if (!isOneHubDerivativeState(value)) {
    throw new Error("Stored One Hub derivative state violates its closed contract; it was not overwritten");
  }
  return value;
}

function readOrCreateState(): { raw: string; state: OneHubDerivativeState } {
  const db = getDb();
  let row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
    .get(ONE_HUB_DERIVATIVE_META_KEY) as { value: string } | undefined;
  if (!row) {
    db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
      .run(ONE_HUB_DERIVATIVE_META_KEY, JSON.stringify(initialState()));
    row = db.prepare("SELECT value FROM meta WHERE key = ? LIMIT 1")
      .get(ONE_HUB_DERIVATIVE_META_KEY) as { value: string } | undefined;
  }
  if (!row) throw new Error("Could not initialize One Hub derivative state");
  return { raw: row.value, state: parseState(row.value) };
}

export function getOneHubDerivativeState(): OneHubDerivativeState {
  return readOrCreateState().state;
}

function ensurePrivateDirectory(parent: string, name: string): string {
  const candidate = path.join(parent, name);
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Hub derivative storage contains an unsafe directory");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    fs.mkdirSync(candidate, { mode: 0o700 });
  }
  const real = fs.realpathSync.native(candidate);
  ensureInside(parent, real);
  return real;
}

function oneHubDerivativeParentPath(): string {
  const requestedUserData = path.resolve(app.getPath("userData"));
  fs.mkdirSync(requestedUserData, { recursive: true, mode: 0o700 });
  const userData = fs.realpathSync.native(requestedUserData);
  const one = ensurePrivateDirectory(userData, "one");
  return ensurePrivateDirectory(one, "hub-derivative-drafts");
}

export function oneHubDerivativeDraftPath(draftId: string): string {
  if (!DRAFT_ID_RE.test(draftId)) throw new TypeError("Hub derivative draftId is invalid");
  return path.join(oneHubDerivativeParentPath(), draftId);
}

function pathCategory(value: string): OneHubDerivativeExclusionCategory | null {
  const lower = value.replaceAll("\\", "/").toLowerCase();
  const parts = lower.split("/");
  if (parts.some((part) => /^(?:memory|memories|memory-store|memory_graph)$/.test(part))) return "memory";
  if (parts.some((part) => /^(?:experience|experiences|experience-packs?)$/.test(part))) return "private_experience";
  if (parts.some((part) => /^(?:customer|customers|client|clients|accounts?)$/.test(part))) return "customer_data";
  if (parts.some((part) => /^(?:internal|private|confidential|docs?)$/.test(part))) return "internal_docs";
  if (parts.some((part) => /^(?:examples?|fixtures?|samples?)$/.test(part))) return "private_examples";
  if (parts.some((part) => /^(?:tasks?|chats?|transcripts?|history|runs?|receipts?)$/.test(part))) return "raw_task_context";
  if (parts.some((part) => /(?:credential|secret|token|password|passwd|api[-_]?key|\.env)/.test(part))) return "credentials";
  return null;
}

function sourceFileFindingCategory(
  relativePath: string,
  file: CloudAgentLocalReviewScan["files"][number],
  scan: CloudAgentLocalReviewScan,
  packaged: PackagedFile | undefined,
): { category: OneHubDerivativeExclusionCategory | null; text?: string } {
  const pathReason = pathCategory(relativePath);
  if (pathReason) return { category: pathReason };
  if (file.reason === "symlink-blocked" || scan.findings.some((item) => item.file === relativePath && /symlink/i.test(item.id))) {
    return { category: "symlink" };
  }
  if (scan.findings.some((item) => item.file === relativePath && item.category === "secret")) {
    return { category: "secrets" };
  }
  if (!file.included || !packaged) {
    return { category: /size|large|count/i.test(file.reason ?? "") ? "size_policy" : "unsafe_content" };
  }
  if (file.kind !== "text") return { category: "non_allowlisted" };
  // V1 intentionally copies no source bytes. Regex/path scanners cannot prove
  // that a plausible AGENT.md or README is free of names, phone numbers, or
  // internal operating detail. Safe source files can be promoted only by a
  // future explicit per-file review flow; this draft is a generated scaffold.
  if (file.kind !== "text") return { category: "non_allowlisted" };
  const fileFindings = scan.findings.filter((item) => item.file === relativePath);
  if (fileFindings.some((item) => item.severity === "blocker" || item.severity === "high")) {
    return { category: "unsafe_content" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(packaged.contentBase64, "base64"));
  } catch {
    return { category: "unsafe_content" };
  }
  const unsafe = unsafeOneSuggestionTextReason(text);
  if (unsafe === "secret") return { category: "secrets" };
  if (unsafe === "local_path") return { category: "local_paths" };
  if (unsafe === "raw_transcript") return { category: "raw_task_context" };
  if (unsafe) return { category: "unsafe_content" };
  if (CUSTOMER_CONTENT_RE.test(text)) return { category: "customer_data" };
  if (PRIVATE_CONTENT_RE.test(text)) return { category: "internal_docs" };
  return { category: null, text };
}

function generatedFiles(draftId: string): Array<{ path: string; bytes: Buffer }> {
  const publicReadme = Buffer.from([
    "# Public agent derivative review",
    "",
    "This generated scaffold is ready for explicit per-file public-content review.",
    "",
    "No private source file was copied into this draft. Memory, credentials, customer data, internal documents, raw Task context, private Experience, local paths, and secrets remain excluded.",
    "Publishing is locked until entitlement, rights, live economy, fee terms, and a separate explicit publish approval are verified.",
    "",
  ].join("\n"), "utf8");
  const routingCard = Buffer.from(JSON.stringify({
    schemaVersion: "routing-card/2.0",
    id: `draft/public-agent-${draftId.slice(-16)}`,
    type: "agent",
    name: "Public agent derivative review",
    summary: "Generated local scaffold awaiting explicit public-content review.",
    capabilities: ["review_required"],
    routing_status: "draft",
  }, null, 2) + "\n", "utf8");
  return [
    { path: `${PUBLIC_ROOT}/PUBLIC_DERIVATIVE.md`, bytes: publicReadme },
    { path: `${PUBLIC_ROOT}/.agentlas/routing-card.json`, bytes: routingCard },
  ];
}

function ensureInside(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Hub derivative output path escaped its draft root");
  }
}

function writeFileExclusive(root: string, relativePath: string, bytes: Buffer): void {
  const target = path.join(root, ...relativePath.split("/"));
  ensureInside(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(
    target,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDirectoryBestEffort(directory: string): void {
  try {
    const fd = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Best-effort only; the file-level fsync and atomic rename remain binding.
  }
}

function writeDraftDirectory(
  draft: OneHubDerivativeDraft,
  fileBytes: ReadonlyMap<string, Buffer>,
): string {
  const finalRoot = oneHubDerivativeDraftPath(draft.draftId);
  const parent = path.dirname(finalRoot);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temp = path.join(parent, `.${draft.draftId}.${process.pid}.${Date.now()}.tmp`);
  if (fs.existsSync(finalRoot) || fs.existsSync(temp)) throw new Error("Hub derivative draft path already exists");
  fs.mkdirSync(temp, { mode: 0o700 });
  try {
    for (const file of draft.includedFiles) {
      const bytes = fileBytes.get(file.path);
      if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw new Error("Hub derivative draft bytes no longer match the closed manifest");
      }
      writeFileExclusive(temp, file.path, bytes);
    }
    writeFileExclusive(temp, MANIFEST_FILE, Buffer.from(JSON.stringify(draft, null, 2) + "\n", "utf8"));
    fsyncDirectoryBestEffort(temp);
    fs.renameSync(temp, finalRoot);
    fsyncDirectoryBestEffort(parent);
    return finalRoot;
  } catch (error) {
    fs.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
}

function removeDraftDirectory(draftId: string): void {
  const target = oneHubDerivativeDraftPath(draftId);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) fs.unlinkSync(target);
    else fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Startup recovery for a crash after filesystem materialization but before
 * the coupled suggestion/Hub-state SQLite transaction committed. Only exact
 * internal draft/temp names beneath the verified private parent are touched. */
export function reconcileOneHubDerivativeDraftStorage(): { removedOrphans: number; removedTemps: number } {
  const state = readOrCreateState().state;
  const durable = new Set(state.drafts.map((draft) => draft.draftId));
  const parent = oneHubDerivativeParentPath();
  let removedOrphans = 0;
  let removedTemps = 0;
  for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
    const absolute = path.join(parent, entry.name);
    if (DRAFT_ID_RE.test(entry.name) && !durable.has(entry.name)) {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fs.unlinkSync(absolute);
      else fs.rmSync(absolute, { recursive: true, force: true });
      removedOrphans += 1;
      continue;
    }
    if (/^\.one_hub_draft_[a-f0-9]{32}\.\d+\.\d+\.tmp$/.test(entry.name)) {
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) fs.unlinkSync(absolute);
      else fs.rmSync(absolute, { recursive: true, force: true });
      removedTemps += 1;
    }
  }
  return { removedOrphans, removedTemps };
}

function assertPrepareInput(value: PrepareOneHubDerivativeDraftInput): void {
  if (!record(value)) throw new TypeError("Hub derivative preparation input is invalid");
  exactKeys(value, [
    "draftId", "suggestionId", "reviewRequestId", "originTaskId", "privateSourceId", "createdAt",
  ], "Hub derivative preparation input");
  if (!DRAFT_ID_RE.test(value.draftId)
    || !SUGGESTION_ID_RE.test(value.suggestionId)
    || !REVIEW_ID_RE.test(value.reviewRequestId)
    || !SAFE_ID_RE.test(value.originTaskId)
    || !SAFE_ID_RE.test(value.privateSourceId)
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new TypeError("Hub derivative preparation bindings are invalid");
  }
}

function exactOwnerPrivateRelease(rootPath: string, expectedSlug: string, expectedHash: string): ExactOwnerPrivateRelease {
  const marker = readCloudAgentRestoreMarker(rootPath);
  const registration = marker?.registrations?.["owner-private"];
  if (
    !marker || marker.source !== "agentlas-cloud"
    || marker.slug !== expectedSlug
    || marker.packageHash !== expectedHash
    || marker.packageHashVersion !== "path-sha256-executable-v2"
    || !registration
    || registration.scope !== "owner-private"
    || registration.slug !== expectedSlug
    || registration.packageHash !== expectedHash
    || registration.packageHashVersion !== "path-sha256-executable-v2"
    || typeof registration.cloudId !== "string" || registration.cloudId.length < 1
    || typeof registration.revision !== "string" || registration.revision.length < 1
  ) {
    throw new Error("Hub derivative review requires an exact owner-private Agent Cloud v2 release");
  }
  return {
    slug: marker.slug,
    packageHash: marker.packageHash,
    packageHashVersion: "path-sha256-executable-v2",
    cloudId: registration.cloudId,
    revision: registration.revision,
  };
}

function prepareOneHubDerivativeDraftUnsafe(
  input: PrepareOneHubDerivativeDraftInput,
): PreparedOneHubDerivativeDraft {
  assertPrepareInput(input);
  const { raw, state } = readOrCreateState();
  if (state.drafts.some((item) => item.draftId === input.draftId || item.suggestionId === input.suggestionId)) {
    throw new Error("This Hub derivative suggestion already has a local review draft");
  }
  if (state.drafts.length >= 256) {
    throw new Error("The local Hub derivative review store reached its strict capacity");
  }

  const row = getDb().prepare("SELECT builtin, visibility FROM installed_agents WHERE id = ? LIMIT 1")
    .get(input.privateSourceId) as { builtin: number; visibility: string } | undefined;
  const source = getAgentById(input.privateSourceId);
  if (
    !row || row.builtin !== 0 || row.visibility !== "visible"
    || !source || source.kind === "team" || source.assetSource !== "agent-cloud"
    || !source.localPath || source.sourceMissingSince
    || !source.packageHash || !HASH_RE.test(source.packageHash)
  ) {
    throw new Error("Hub derivative review requires an owner-restored private Agent Cloud release with an exact package hash");
  }

  const ownerRelease = exactOwnerPrivateRelease(source.localPath, source.slug, source.packageHash);
  let scan: CloudAgentLocalReviewScan;
  try {
    scan = scanCloudAgentFolderForLocalReview(source.localPath);
  } catch {
    throw new Error("The private Agent Cloud release could not be read safely");
  }
  const sourceAfter = getAgentById(input.privateSourceId);
  const ownerReleaseAfter = exactOwnerPrivateRelease(source.localPath, source.slug, source.packageHash);
  if (
    scan.packageHash !== source.packageHash
    || !sourceAfter || sourceAfter.localPath !== source.localPath
    || sourceAfter.assetSource !== "agent-cloud" || sourceAfter.packageHash !== source.packageHash
    || JSON.stringify(ownerReleaseAfter) !== JSON.stringify(ownerRelease)
  ) {
    throw new Error("The private Agent Cloud release changed; restore its exact verified package before creating a public derivative");
  }
  const globalBlocker = scan.findings.find((item) =>
    (item.severity === "blocker" || item.severity === "high")
    && (!item.file || !scan.files.some((file) => file.path === item.file)),
  );
  if (globalBlocker) throw new Error(`Private release cannot be reviewed safely: ${globalBlocker.id}`);

  const packagedByPath = new Map(scan.included.map((file) => [file.path, file] as const));
  const counts = new Map<OneHubDerivativeExclusionCategory, number>();
  const increment = (category: OneHubDerivativeExclusionCategory): void => {
    counts.set(category, (counts.get(category) ?? 0) + 1);
  };
  const fileBytes = new Map<string, Buffer>();
  const includedFiles: OneHubDerivativeIncludedFile[] = [];
  const addIncluded = (outputPath: string, bytes: Buffer, fileSource: OneHubDerivativeIncludedFile["source"]): void => {
    if (includedFiles.length >= MAX_DRAFT_FILES) throw new Error("Hub derivative draft exceeds its strict file allowlist limit");
    const total = includedFiles.reduce((sum, item) => sum + item.bytes, 0) + bytes.length;
    if (total > MAX_DRAFT_BYTES) throw new Error("Hub derivative draft exceeds its strict byte limit");
    const entry: OneHubDerivativeIncludedFile = {
      path: outputPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
      source: fileSource,
    };
    includedFiles.push(entry);
    fileBytes.set(outputPath, bytes);
  };

  const generated = generatedFiles(input.draftId);
  for (const file of generated) addIncluded(file.path, file.bytes, "generated");

  for (const file of scan.files) {
    const packaged = packagedByPath.get(file.path);
    const decision = sourceFileFindingCategory(file.path, file, scan, packaged);
    if (decision.category) {
      increment(decision.category);
      continue;
    }
    // Even a scanner-clean source file remains excluded until a future UI lets
    // the owner review that exact content for public reuse.
    increment("non_allowlisted");
  }
  includedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const excluded: OneHubDerivativeExcludedSummary[] = [...counts.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([category, count]) => ({ category, count, reasonCode: category }));
  const version = Math.max(Date.now(), state.version + 1, Date.parse(input.createdAt));
  const now = new Date(version).toISOString();
  const draft: OneHubDerivativeDraft = {
    contractVersion: ONE_HUB_DERIVATIVE_CONTRACT_VERSION,
    draftId: input.draftId,
    version,
    suggestionId: input.suggestionId,
    reviewRequestId: input.reviewRequestId,
    originTaskId: input.originTaskId,
    privateSourceId: input.privateSourceId,
    sourcePackageHash: source.packageHash,
    sourceAssetSource: "agent-cloud",
    draftPathRef: `one/hub-derivative-drafts/${input.draftId}`,
    status: "local_review",
    includedFiles,
    excluded,
    alwaysExcludedCategories: [...ONE_HUB_DERIVATIVE_ALWAYS_EXCLUDED],
    gates: {
      entitlement: { status: "unknown", ref: null },
      rights: { status: "unknown", ref: null },
      economy: { status: "unknown", ref: null },
      fee: { status: "unknown", ref: null },
      explicitPublishApproval: false,
      publishAllowed: false,
      publishingStarted: false,
      revenueGuaranteed: false,
    },
    original: { sourceUnchanged: true, privateSourceIncluded: false },
    createdAt: input.createdAt,
    updatedAt: now,
  };
  if (!isOneHubDerivativeDraft(draft)) throw new Error("Refused to create an invalid Hub derivative review draft");
  writeDraftDirectory(draft, fileBytes);
  const next: OneHubDerivativeState = {
    ...state,
    version,
    drafts: [...state.drafts, draft],
    updatedAt: now,
  };
  if (!isOneHubDerivativeState(next)) {
    removeDraftDirectory(draft.draftId);
    throw new Error("Hub derivative store mutation violated its closed contract");
  }
  let committed = false;
  return {
    draft,
    commit: () => {
      if (committed) throw new Error("Hub derivative draft commit was already consumed");
      const changed = getDb().prepare("UPDATE meta SET value = ? WHERE key = ? AND value = ?")
        .run(JSON.stringify(next), ONE_HUB_DERIVATIVE_META_KEY, raw).changes;
      if (changed !== 1) throw new Error("One Hub derivative state changed concurrently; refresh and retry");
      committed = true;
    },
    rollback: () => {
      removeDraftDirectory(draft.draftId);
    },
  };
}

export function prepareOneHubDerivativeDraft(
  input: PrepareOneHubDerivativeDraftInput,
): PreparedOneHubDerivativeDraft {
  try {
    return prepareOneHubDerivativeDraftUnsafe(input);
  } catch (error) {
    const code = record(error) && typeof error.code === "string" ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    if (code || /(?:\/Users\/|\/private\/|[A-Za-z]:\\)/.test(message)) {
      throw new Error("The local Hub derivative review draft could not be prepared safely");
    }
    throw error;
  }
}

function assertGetInput(value: unknown): asserts value is GetOneHubDerivativeDraftInput {
  if (!record(value)) throw new TypeError("Hub derivative draft request is invalid");
  exactKeys(value, [
    "suggestionId", "expectedSuggestionVersion", "reviewRequestId", "draftId", "originTaskId",
  ], "Hub derivative draft request");
  if (!SUGGESTION_ID_RE.test(String(value.suggestionId))
    || !Number.isSafeInteger(value.expectedSuggestionVersion) || Number(value.expectedSuggestionVersion) <= 0
    || !REVIEW_ID_RE.test(String(value.reviewRequestId))
    || !DRAFT_ID_RE.test(String(value.draftId))
    || !SAFE_ID_RE.test(String(value.originTaskId))) {
    throw new TypeError("Hub derivative draft request bindings are invalid");
  }
}

function readFileNoFollow(file: string, maximum: number, rootReal: string): Buffer {
  const beforeReal = fs.realpathSync.native(file);
  ensureInside(rootReal, beforeReal);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) {
    throw new Error("Hub derivative draft contains an unsafe file");
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const afterReal = fs.realpathSync.native(file);
    const pathStat = fs.statSync(file);
    if (!before.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size
      || beforeReal !== afterReal || before.dev !== pathStat.dev || before.ino !== pathStat.ino) {
      throw new Error("Hub derivative draft file changed while it was read");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function actualDraftTree(root: string, maximumFiles: number): { files: string[]; directories: string[] } {
  const files: string[] = [];
  const directoryPaths: string[] = [];
  let directories = 0;
  const walk = (directory: string, depth: number): void => {
    directories += 1;
    if (depth > 32 || directories > 128) throw new Error("Hub derivative draft directory tree exceeds its strict limit");
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Hub derivative draft directory is unsafe");
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Hub derivative draft must not contain symbolic links");
      if (entry.isDirectory()) {
        directoryPaths.push(path.relative(root, absolute).split(path.sep).join("/"));
        walk(absolute, depth + 1);
      }
      else if (entry.isFile()) {
        files.push(path.relative(root, absolute).split(path.sep).join("/"));
        if (files.length > maximumFiles) throw new Error("Hub derivative draft contains too many files");
      }
      else throw new Error("Hub derivative draft contains an unsupported filesystem entry");
    }
  };
  walk(root, 0);
  return { files: files.sort(), directories: directoryPaths.sort() };
}

function expectedDraftDirectories(files: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join("/"));
    }
  }
  return [...directories].sort();
}

function readOneHubDerivativeDraft(rawInput: unknown): OneHubDerivativeDraft {
  assertGetInput(rawInput);
  const input = rawInput;
  const draft = readOrCreateState().state.drafts.find((item) => item.draftId === input.draftId);
  if (!draft
    || Date.parse(draft.createdAt) !== input.expectedSuggestionVersion
    || draft.suggestionId !== input.suggestionId
    || draft.reviewRequestId !== input.reviewRequestId
    || draft.originTaskId !== input.originTaskId) {
    throw new Error("Hub derivative draft no longer matches its canonical review handoff");
  }
  const root = oneHubDerivativeDraftPath(draft.draftId);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Hub derivative draft path is unsafe");
  const rootReal = fs.realpathSync.native(root);
  ensureInside(oneHubDerivativeParentPath(), rootReal);
  const manifestBytes = readFileNoFollow(path.join(rootReal, MANIFEST_FILE), 1024 * 1024, rootReal);
  let manifest: unknown;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); } catch {
    throw new Error("Hub derivative review manifest is invalid JSON");
  }
  if (!isOneHubDerivativeDraft(manifest) || JSON.stringify(manifest) !== JSON.stringify(draft)) {
    throw new Error("Hub derivative review manifest no longer matches its durable state");
  }
  const expectedFiles = [MANIFEST_FILE, ...draft.includedFiles.map((item) => item.path)].sort();
  const actualTree = actualDraftTree(rootReal, expectedFiles.length);
  if (JSON.stringify(actualTree.files) !== JSON.stringify(expectedFiles)
    || JSON.stringify(actualTree.directories) !== JSON.stringify(expectedDraftDirectories(expectedFiles))) {
    throw new Error("Hub derivative draft contains files outside its strict allowlist");
  }
  for (const file of draft.includedFiles) {
    const bytes = readFileNoFollow(path.join(rootReal, ...file.path.split("/")), 512 * 1024, rootReal);
    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error("Hub derivative draft file no longer matches its reviewed hash");
    }
  }
  return JSON.parse(JSON.stringify(draft)) as OneHubDerivativeDraft;
}

export function getOneHubDerivativeDraft(rawInput: unknown): OneHubDerivativeDraft {
  try {
    return readOneHubDerivativeDraft(rawInput);
  } catch (error) {
    const code = record(error) && typeof error.code === "string" ? error.code : null;
    const message = error instanceof Error ? error.message : String(error);
    const userData = path.resolve(app.getPath("userData"));
    if (code || message.includes(userData)) {
      throw new Error("The local Hub derivative review draft could not be read safely");
    }
    throw error;
  }
}
