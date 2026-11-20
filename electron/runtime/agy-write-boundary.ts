/**
 * Antigravity (agy) write runs: where the file tools may write (the agy cell).
 *
 * A write run starts agy with `--dangerously-skip-permissions --sandbox`; the sandbox limits the terminal only, so `write_file` / `edit_file`
 * wrote anywhere on disk (measured with agy 1.5.13: a file in a folder beside the working folder was created without any question). Claude Code
 * (acceptEdits) and Codex (workspace-write) stop that in the CLI; for agy the same line is a PreToolUse hook of the product mirror plugin
 * (antigravity-delete-gate.ts), which this file decides. A path the run may write is inside its working folder or a folder registered with it
 * (`--add-dir`), or agy's own artifact folder of the conversation. Everything else is refused with the same marker line every runner's
 * refusal ends with, so the app asks the person for full access (shared/permission-escalation.ts); it never decides by itself.
 */
import fs from "node:fs";
import path from "node:path";
import { PERMISSION_ESCALATION_MARKER } from "../../shared/permission-escalation";

/** agy's own file-changing tools: the name a PreToolUse hook is given (measured) and the names its tool list carries. */
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  "write_file", "edit_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "sed_file", "notebook_edit", "delete_file",
]);
/** The argument names that hold a file the tool changes (the text being replaced is `Target`, which is not one). */
const PATH_ARGS = /^(?:path|targetfile|absolutepath|filepath|file_path|filename|file|notebookpath|destinationpath|destination)$/i;

export function isAgyWriteTool(name: unknown): boolean {
  return typeof name === "string" && WRITE_TOOLS.has(name);
}

/** The nearest existing ancestor resolved through symlinks (a file to be created does not exist yet), with the rest appended. */
function realish(target: string): string {
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try { return path.join(fs.realpathSync(cursor), ...missing.reverse()); } catch { /* not there yet */ }
    const parent = path.dirname(cursor);
    if (parent === cursor) return target;
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

const within = (root: string, candidate: string): boolean => candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

export interface AgyHookInput {
  cwd?: unknown;
  artifactDirectoryPath?: unknown;
  toolCall?: { name?: unknown; args?: unknown };
}

/** The refusal text for a hook call, or null when the call may go on. `extraRoots` are the folders registered with the run besides its working folder. */
export function agyWriteBoundaryRefusal(input: AgyHookInput, extraRoots: readonly string[]): string | null {
  const call = input.toolCall;
  if (!call || !isAgyWriteTool(call.name)) return null;
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : "";
  const roots = [cwd, ...extraRoots, typeof input.artifactDirectoryPath === "string" ? input.artifactDirectoryPath : ""]
    .filter((root) => root && path.isAbsolute(root)).map((root) => realish(path.resolve(root)));
  const args = call.args && typeof call.args === "object" ? call.args as Record<string, unknown> : {};
  const named = Object.entries(args).filter(([key, value]) => PATH_ARGS.test(key) && typeof value === "string" && value.length > 0) as Array<[string, string]>;
  // A write tool whose target this hook cannot read is not let through: the gate must not be open exactly where it cannot see.
  if (named.length === 0 || roots.length === 0) return refusal(cwd || "the working folder", "the file it changes");
  for (const [, value] of named) {
    const resolved = realish(path.resolve(cwd || roots[0]!, value));
    if (!roots.some((root) => within(root, resolved))) return refusal(cwd, value);
  }
  return null;
}

function refusal(folder: string, target: string): string {
  return `permission denied: ${target} is outside this run's working folder (${folder}). That is a permission boundary, not a bug: do not write it somewhere else or leave it in a temp folder. `
    + `Say in one sentence what needs writing there and why, then put exactly ${PERMISSION_ESCALATION_MARKER} on its own final line so the app can ask the user for full access.`;
}

/** The folders a run registers besides its working folder, as the runner put them in the environment (a JSON array of absolute paths). */
export function agyWriteRootsFromEnv(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

export const AGY_WRITE_ROOTS_ENV = "AGENTLAS_AGY_WRITE_ROOTS";
