import fs from "node:fs";
import path from "node:path";
import { packagePathFromText } from "../../shared/build-path";
import { resolveMainOwnedReadPath } from "../fs/access";

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
