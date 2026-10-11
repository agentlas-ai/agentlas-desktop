/**
 * Test and scratch imports.
 *
 * Test suites and coding agents sometimes register a package from a throwaway
 * folder (a pytest temp dir, an agent scratchpad, an OS temp dir) into the real
 * app. Once that folder is gone the registration is a ghost: it must not look
 * like a teammate the owner invited. Callers combine this path test with
 * "the source is missing"; a folder that still exists is never treated as junk
 * by path alone.
 */

const SCRATCH_PATH_PATTERNS: readonly RegExp[] = [
  // pytest: basetemp (`pytest-tmp/`), per-user root (`pytest-of-<user>/`), numbered runs (`pytest-123/`).
  /(?:^|\/)pytest-tmp\//i,
  /(?:^|\/)pytest-of-[^/]+\//i,
  /(?:^|\/)pytest-\d+\//i,
  // Claude Code per-project tmp roots and their scratchpad (`/tmp/claude-501/<project>/<session>/scratchpad/...`).
  /(?:^|\/)tmp\/claude-[^/]+\//i,
  /(?:^|\/)claude-\d+\/[^/]+\/[^/]+\/scratchpad\//i,
  // macOS per-user temp (`/var/folders/xx/yyyy/T/tmp.AbC123/...`, `.../T/tmpab12cd/...`).
  /(?:^|\/)var\/folders\/[^/]+\/[^/]+\/T\/(?:tmp[._]?[A-Za-z0-9]+|[^/]*pytest[^/]*)\//i,
];

/** True when the path lies inside a pytest, agent-scratchpad or OS temp directory. */
export function isScratchImportPath(sourcePath: string | null | undefined): boolean {
  const normalized = String(sourcePath ?? "").replace(/\\/g, "/");
  if (!normalized) return false;
  return SCRATCH_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}
