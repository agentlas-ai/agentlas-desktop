import fs from "node:fs";
import path from "node:path";
import { packagePathFromText } from "../../shared/build-path";
import { resolveMainOwnedReadPath } from "../fs/access";

/** The file that marks a folder as an Agentlas package rather than a container. */
const PACKAGE_MARKER = path.join(".agentlas", "routing-card.json");

/**












 */
export function soleChildPackageRoot(workspace: string): string | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspace, { withFileTypes: true });
  } catch {
    return null;
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(workspace, entry.name);
    if (fs.existsSync(path.join(candidate, PACKAGE_MARKER))) found.push(candidate);
    if (found.length > 1) return null;
  }
  return found[0] ?? null;
}

/** Does this folder itself declare a package? */
function isPackageRoot(folder: string): boolean {
  return fs.existsSync(path.join(folder, PACKAGE_MARKER));
}

/** Resolve a model-authored BUILD_COMPLETE path under the main-owned workspace. */
export function verifiedCompletedPackageRoot(
  workspace: string,
  assistantText: string,
): { root: string; error?: string } {
  const canonicalWorkspace = fs.realpathSync.native(workspace);
  const signalled = packagePathFromText(canonicalWorkspace, assistantText);
  if (!signalled) {
    const rawSignal = assistantText.match(/BUILD_COMPLETE\s*:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "";
    const unquoted = /^(["'`])(.*)\1$/.test(rawSignal) ? rawSignal.slice(1, -1).trim() : rawSignal;
    const normalizedSignal = unquoted.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    if (normalizedSignal === path.basename(canonicalWorkspace)) return { root: canonicalWorkspace };
    return { root: canonicalWorkspace, error: "BUILD_COMPLETE target is invalid or outside the approved workspace" };
  }
  try {
    const root = resolveMainOwnedReadPath(signalled, canonicalWorkspace);
    if (!fs.statSync(root).isDirectory()) {
      return { root: canonicalWorkspace, error: "BUILD_COMPLETE target is not a directory" };
    }
    return { root };
  } catch (error) {
    return {
      root: canonicalWorkspace,
      error: `BUILD_COMPLETE target could not be verified: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The folder the package contract gate must judge.
 *
 * Order matters and mirrors the canonical rule:
 *  1. A verified BUILD_COMPLETE target wins — the model said where it built.
 *  2. Otherwise, if the workspace itself is a package, judge the workspace.
 *  3. Otherwise, if exactly one child is a package, judge that child.
 *  4. Otherwise refuse to guess. Judging a container folder scores every unrelated
 *     file inside it as a defect of this build, which is how a working package was
 *     reported as 46 blockers.
 */
export function contractTargetRoot(input: {
  workspace: string;
  completed: { root: string; error?: string };
}): { root: string | null; reason: "build-complete" | "workspace-package" | "sole-child-package" | "ambiguous" } {
  const workspace = fs.realpathSync.native(input.workspace);
  if (!input.completed.error && path.resolve(input.completed.root) !== workspace) {
    return { root: input.completed.root, reason: "build-complete" };
  }
  if (isPackageRoot(workspace)) return { root: workspace, reason: "workspace-package" };
  const child = soleChildPackageRoot(workspace);
  if (child) return { root: child, reason: "sole-child-package" };
  return { root: null, reason: "ambiguous" };
}
