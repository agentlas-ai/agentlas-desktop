import fs from "node:fs";

/**
 * Main-process-only capability captured at the Mobile Bridge trust boundary.
 *
 * This deliberately does not live in shared/ or any wire DTO. A phone may ask
 * Desktop to run a chat, but it can never supply or alter the local path that
 * Desktop has already bound to that chat.
 */
export interface InvocationWorkspaceBinding {
  readonly source: "mobile";
  readonly canonicalPath: string | null;
  /** BigInt strings keep the host file identity precise without entering JSON DTOs. */
  readonly directoryIdentity: {
    readonly device: string;
    readonly inode: string;
  } | null;
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
 * Revalidate immediately before execution. The path must still resolve to the
 * exact directory captured by Desktop; replacement symlinks fail closed.
 */
export function revalidateInvocationWorkspaceBinding(
  binding: InvocationWorkspaceBinding,
): string | null {
  if (binding.source !== "mobile") throw unavailableWorkspaceError();
  if (binding.canonicalPath === null) {
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
  if (left.source !== "mobile" || right.source !== "mobile") return false;
  if (left.canonicalPath !== right.canonicalPath) return false;
  if (left.canonicalPath === null) {
    return left.directoryIdentity === null && right.directoryIdentity === null;
  }
  if (!left.directoryIdentity || !right.directoryIdentity) return false;
  return (
    left.directoryIdentity.device === right.directoryIdentity.device &&
    left.directoryIdentity.inode === right.directoryIdentity.inode
  );
}

export function enforceMobileReadOnlyPermission(permission: unknown): "read" {
  if (permission === undefined || permission === "read") return "read";
  throw new Error(
    "Mobile can run read-only chats for now. Start write or full-access work on Desktop.",
  );
}

export function isMobileReadRuntimeAllowed(kind: string): boolean {
  return kind === "codex" || kind === "byok" || kind === "ollama";
}

export class MobileReadRuntimeBoundaryError extends Error {
  readonly code = "mobile-runtime-not-read-sandboxed";

  constructor(message: string) {
    super(message);
    this.name = "MobileReadRuntimeBoundaryError";
  }
}
