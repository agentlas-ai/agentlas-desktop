import fs from "node:fs";

/**
 * Main-process-only workspace capability captured at a trusted host boundary.
 *
 * This deliberately does not live in shared/ or any wire DTO. A phone may ask
 * Desktop to run a chat, but it can never supply or alter the local path that
 * Desktop has already bound to that chat.
 */
/** Science binds its own selected directory without becoming a remote surface. */
export type InvocationWorkspaceBindingSource = "mobile" | "mobile-one" | "telegram-one" | "science";

const REMOTE_BINDING_SOURCES: readonly InvocationWorkspaceBindingSource[] = [
  "mobile",
  "mobile-one",
  "telegram-one",
];

export function isRemoteInvocationWorkspaceBindingSource(value: string): boolean {
  return (REMOTE_BINDING_SOURCES as readonly string[]).includes(value);
}

function isWorkspaceBindingSource(value: string): value is InvocationWorkspaceBindingSource {
  return value === "science" || isRemoteInvocationWorkspaceBindingSource(value);
}

export interface InvocationWorkspaceBinding {
  readonly source: InvocationWorkspaceBindingSource;
  readonly canonicalPath: string | null;
  /** BigInt strings keep the host file identity precise without entering JSON DTOs. */
  readonly directoryIdentity: {
    readonly device: string;
    readonly inode: string;
  } | null;
}

/** Legacy unbound Science runs remain valid; a bound run must match its host surface. */
export function assertInvocationWorkspaceSourceContext(
  binding: InvocationWorkspaceBinding | undefined,
  executionSource: string | undefined,
): void {
  if (binding && (binding.source === "science") !== (executionSource === "science")) {
    throw new Error("science-workspace-context-mismatch");
  }
}

function unavailableWorkspaceError(): Error {
  return new Error(
    "The selected Desktop working folder is unavailable. Re-select an existing folder on Desktop and retry.",
  );
}

function nonDirectoryWorkspaceError(): Error {
  return new Error(
    "The selected Desktop working folder is not a directory. Select a folder on Desktop and retry.",
  );
}

function unverifiableWorkspaceError(): Error {
  return new Error(
    "Desktop could not verify a stable identity for this working folder. Select another folder on Desktop and retry.",
  );
}

function replacedWorkspaceError(): Error {
  return new Error(
    "The selected Desktop working folder changed after approval. Re-select it on Desktop and retry.",
  );
}

interface CanonicalDirectory {
  canonicalPath: string;
  directoryIdentity: InvocationWorkspaceBinding["directoryIdentity"];
}

function canonicalDirectory(rawPath: string): CanonicalDirectory {
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync.native(rawPath);
  } catch {
    throw unavailableWorkspaceError();
  }

  let stat: fs.BigIntStats;
  try {
    stat = fs.statSync(canonicalPath, { bigint: true });
  } catch {
    throw unavailableWorkspaceError();
  }
  if (!stat.isDirectory()) throw nonDirectoryWorkspaceError();
  // Node exposes the native file identity on supported filesystems, including
  // modern Windows. A zero/absent inode cannot prove replacement resistance,
  // so workspace-bound Mobile execution fails closed instead of using path-only
  // best effort. Global chats remain available through the explicit null binding.
  if (stat.ino <= 0n) throw unverifiableWorkspaceError();
  return {
    canonicalPath,
    directoryIdentity: Object.freeze({
      device: stat.dev.toString(),
      inode: stat.ino.toString(),
    }),
  };
}

/** Capture the host-owned chat folder once, resolving symlinks before queuing. */
export function captureInvocationWorkspaceBinding(
  existingChatWorkingFolder: string | null,
): InvocationWorkspaceBinding {
  if (existingChatWorkingFolder === null) {
    return Object.freeze({
      source: "mobile",
      canonicalPath: null,
      directoryIdentity: null,
    });
  }
  const directory = canonicalDirectory(existingChatWorkingFolder);
  return Object.freeze({
    source: "mobile",
    canonicalPath: directory.canonicalPath,
    directoryIdentity: directory.directoryIdentity,
  });
}

/**
 * Main-only identity for a Mobile One first turn. It intentionally carries no
 * caller-selected folder; the paired Desktop remains the sole owner of the
 * workspace, runtime, and One context. The distinct source is never
 * serializable on the Mobile wire.
 */
export function captureMobileOneInvocationBinding(): InvocationWorkspaceBinding {
  return Object.freeze({
    source: "mobile-one",
    canonicalPath: null,
    directoryIdentity: null,
  });
}

/** Capture only the canonical directory already selected and validated by Science Main. */
export function captureScienceInvocationBinding(canonicalPath: string): InvocationWorkspaceBinding {
  const directory = canonicalDirectory(canonicalPath);
  if (directory.canonicalPath !== canonicalPath) throw replacedWorkspaceError();
  return Object.freeze({
    source: "science",
    canonicalPath: directory.canonicalPath,
    directoryIdentity: directory.directoryIdentity,
  });
}

/**
 * Main-only identity for a Telegram One turn.
 *
 * Unlike Mobile One this one DOES carry a folder: the Telegram conversation can
 * designate a project with /project, and `runMcpInvocation` consults only the
 * binding (never the mutable chat folder) once a binding is present. A null
 * path here would silently turn that designation into a no-op.
 */
export function captureTelegramOneInvocationBinding(
  existingChatWorkingFolder: string | null,
): InvocationWorkspaceBinding {
  if (existingChatWorkingFolder === null) {
    return Object.freeze({
      source: "telegram-one",
      canonicalPath: null,
      directoryIdentity: null,
    });
  }
  const directory = canonicalDirectory(existingChatWorkingFolder);
  return Object.freeze({
    source: "telegram-one",
    canonicalPath: directory.canonicalPath,
    directoryIdentity: directory.directoryIdentity,
  });
}

/**
 * Revalidate immediately before execution. The path must still resolve to the
 * exact directory captured by Desktop; replacement symlinks fail closed.
 */
export function revalidateInvocationWorkspaceBinding(
  binding: InvocationWorkspaceBinding,
): string | null {
  if (!isWorkspaceBindingSource(binding.source)) {
    throw unavailableWorkspaceError();
  }
  if (binding.canonicalPath === null) {
    if (binding.source === "science") throw unavailableWorkspaceError();
    if (binding.directoryIdentity !== null) throw unavailableWorkspaceError();
    return null;
  }
  if (!binding.directoryIdentity) throw unverifiableWorkspaceError();
  const current = canonicalDirectory(binding.canonicalPath);
  if (current.canonicalPath !== binding.canonicalPath) throw replacedWorkspaceError();
  if (
    current.directoryIdentity?.device !== binding.directoryIdentity.device ||
    current.directoryIdentity?.inode !== binding.directoryIdentity.inode
  ) {
    throw replacedWorkspaceError();
  }
  return current.canonicalPath;
}

export function invocationWorkspaceBindingsEqual(
  left: InvocationWorkspaceBinding | undefined,
  right: InvocationWorkspaceBinding | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.source !== right.source) return false;
  if (!isWorkspaceBindingSource(left.source) || !isWorkspaceBindingSource(right.source)) return false;
  if (left.canonicalPath !== right.canonicalPath) return false;
  if (left.canonicalPath === null) {
    if (left.source === "science") return false;
    return left.directoryIdentity === null && right.directoryIdentity === null;
  }
  if (!left.directoryIdentity || !right.directoryIdentity) return false;
  return (
    left.directoryIdentity.device === right.directoryIdentity.device &&
    left.directoryIdentity.inode === right.directoryIdentity.inode
  );
}

/**
 * Normalize the standard Desktop permission contract at a remote entry point.
 *
 * A paired phone is a remote Desktop surface, not a reduced-capability
 * runtime. The Desktop process still owns the authenticated pairing, selected
 * workspace, approval prompts, and every tool's own confirmation policy. An
 * omitted or malformed value remains fail-closed to read, but valid write and
 * full requests must reach that same Desktop authority unchanged.
 */
export function normalizeRemoteInvocationPermission(
  permission: unknown,
): "read" | "write" | "full" {
  if (permission === "write" || permission === "full") return permission;
  return "read";
}

export function isMobileReadRuntimeAllowed(kind: string): boolean {
  // This helper protects explicit restricted-read runtime consumers. Paired
  // Mobile invocations use the normal Desktop permission contract and do not
  // set that separate execution flag.
  return kind === "byok" || kind === "ollama";
}

export class MobileReadRuntimeBoundaryError extends Error {
  readonly code = "mobile-runtime-not-read-sandboxed";

  constructor(message: string) {
    super(message);
    this.name = "MobileReadRuntimeBoundaryError";
  }
}
