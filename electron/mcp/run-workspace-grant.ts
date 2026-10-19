import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**










 */

export const RUN_WORKSPACE_GRANT_SCHEMA = "agentlas.run-workspace-grant.v1" as const;
/** Mobile renders this tool as a folder card (mobile/app/lib/features/chat/tool_approval_presentation.dart). */
export const RUN_WORKSPACE_GRANT_TOOL = "folder-access" as const;

export type RunWorkspaceRefusal =
  | "not_absolute"
  | "outside_home"
  | "home_root"
  | "protected_path"
  | "other_room_folder"
  | "not_directory";

export type RunWorkspaceValidation =
  | {
      ok: true;
      /** Canonical absolute path (existing ancestors resolved through symlinks). */
      path: string;
      exists: boolean;
      sameAsRoomFolder: boolean;
      insideRoomFolder: boolean;
    }
  | { ok: false; reason: RunWorkspaceRefusal };

export interface RunWorkspaceContext {
  home: string;
  roomFolder: string | null;
  /** Saved working folders of the owner's other rooms (never this room's). */
  otherRoomFolders: readonly string[];
  platform?: NodeJS.Platform;
}

/** Segment names that hold credentials, signing material or keychains anywhere under home. */
const PROTECTED_SEGMENTS = new Set([
  "signing", "credentials", "keychains", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".password-store",
]);

function caseKey(value: string, platform: NodeJS.Platform): string {
  return platform === "linux" ? value : value.toLowerCase();
}

/** True when `child` is `parent` itself or below it. */
function within(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const relative = path.relative(caseKey(parent, platform), caseKey(child, platform));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve an absolute path through its deepest existing ancestor, so a symlinked parent cannot carry the folder out of
 * home. Missing tail segments are appended unchanged.
 */
function canonicalize(target: string): { canonical: string; exists: boolean; directory: boolean } {
  const missing: string[] = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      const stat = fs.statSync(real);
      const canonical = missing.length ? path.join(real, ...missing.reverse()) : real;
      return { canonical, exists: missing.length === 0, directory: missing.length === 0 ? stat.isDirectory() : true };
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return { canonical: path.resolve(target), exists: false, directory: true };
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function canonicalOrNull(value: string | null | undefined): string | null {
  if (!value || !path.isAbsolute(value)) return null;
  try { return canonicalize(value).canonical; } catch { return null; }
}

export function validateRequestedRunWorkspace(raw: unknown, context: RunWorkspaceContext): RunWorkspaceValidation {
  const platform = context.platform ?? process.platform;
  if (typeof raw !== "string") return { ok: false, reason: "not_absolute" };
  const requested = raw.trim();
  if (!requested || requested.length > 1024 || /[\u0000-\u001f\u007f]/.test(requested) || !path.isAbsolute(requested)) {
    return { ok: false, reason: "not_absolute" };
  }
  const home = canonicalOrNull(context.home);
  if (!home) return { ok: false, reason: "outside_home" };
  const resolved = canonicalize(requested);
  if (!within(home, resolved.canonical, platform)) return { ok: false, reason: "outside_home" };
  const segments = path.relative(home, resolved.canonical).split(path.sep).filter(Boolean);
  if (segments.length === 0) return { ok: false, reason: "home_root" };
  const top = caseKey(segments[0], platform);
  // Hidden top-level folders hold tool homes and credentials (~/.agentlas, ~/.codex, ~/.config ...); ~/Library and
  // AppData hold application data, keychains and the product's own userData.
  if (top.startsWith(".") || (platform === "darwin" && top === "library") || (platform === "win32" && top === "appdata")) {
    return { ok: false, reason: "protected_path" };
  }
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(caseKey(segment, platform)) || caseKey(segment, platform).startsWith(".env"))) {
    return { ok: false, reason: "protected_path" };
  }
  if (resolved.exists && !resolved.directory) return { ok: false, reason: "not_directory" };
  const room = canonicalOrNull(context.roomFolder);
  const sameAsRoomFolder = room !== null && caseKey(room, platform) === caseKey(resolved.canonical, platform);
  const insideRoomFolder = room !== null && within(room, resolved.canonical, platform);
  // Inside this room's own folder is this room's scope even when another room shares that folder.
  if (!insideRoomFolder) {
    for (const other of context.otherRoomFolders) {
      const folder = canonicalOrNull(other);
      if (!folder) continue;
      if (within(folder, resolved.canonical, platform) || within(resolved.canonical, folder, platform)) {
        return { ok: false, reason: "other_room_folder" };
      }
    }
  }
  return { ok: true, path: resolved.canonical, exists: resolved.exists, sameAsRoomFolder, insideRoomFolder };
}

export type RunAccessChip = "read" | "write" | "full";

/**
 * Whether the room's chip already allows working there. A folder inside the room folder is inside the ordinary write
 * scope; any other folder needs the owner's full-access chip. Below that, the room asks the owner once.
 */
export function runWorkspaceChipCovers(chip: RunAccessChip | undefined, validation: RunWorkspaceValidation): boolean {
  if (!validation.ok) return false;
  if (validation.insideRoomFolder) return chip === "write" || chip === "full";
  return chip === "full";
}

/** Create a missing granted folder and re-check where it landed (a racing symlink cannot move it out of home). */
export function ensureRunWorkspaceDirectory(granted: string, home: string, platform: NodeJS.Platform = process.platform): string {
  fs.mkdirSync(granted, { recursive: true, mode: 0o755 });
  const real = fs.realpathSync.native(granted);
  const homeReal = fs.realpathSync.native(home);
  if (!fs.statSync(real).isDirectory() || !within(homeReal, real, platform) || caseKey(real, platform) === caseKey(homeReal, platform)) {
    throw new Error("run_workspace_uncreatable");
  }
  return real;
}

export function runWorkspaceDigest(canonicalPath: string): string {
  return `sha256:${createHash("sha256").update(`agentlas-run-workspace-v1\u0000${canonicalPath}`, "utf8").digest("hex")}`;
}
