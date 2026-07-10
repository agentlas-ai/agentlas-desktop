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
  "oberon",
  "oberon-animate",
  "oberon-motion",
  "trex-images",
] as const;
const LOCAL_MEDIA_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".avif", ".bmp",
  ".mp4", ".webm", ".mov", ".m4v", ".ogv",
]);

const grants = new Map<string, GrantRecord>();
let durableLoaded = false;

export class FsAccessDeniedError extends Error {
  constructor(message = "Filesystem read is outside the approved scope.") {
    super(message);
    this.name = "FsAccessDeniedError";
  }
}

function grantStorePath(): string {
  return process.env.AGENTLAS_FS_GRANT_STORE?.trim() || path.join(app.getPath("userData"), GRANT_FILE);
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
  const userData = app.getPath("userData");
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
    return [...(workspace ? [workspace] : []), ...generatedRootRules()];
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
    ...allChatWorkspaceRules(),
  ];
  return approved.some((rule) => ruleAllows(realTarget, rule)) ? realTarget : null;
}

/** Test-only reset; production code never revokes durable user picker grants. */
export function resetFsAccessForTests(): void {
  grants.clear();
  durableLoaded = false;
}
