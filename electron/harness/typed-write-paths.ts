/*
 * The file a runtime's own typed edit event names (the runtimes an earlier version left out: antigravity, the ACP lanes - grok, kimi, cursor, copilot - which report a tool's
 * `kind: "edit"` and its raw input, not an artifact path). The path comes from the EVENT's arguments through a closed list of keys, never from the answer's words, and a
 * receipt is made only for a file that is there. Claude Code / Codex keep their tool-name rule (mcp/client.ts TYPED_FILE_WRITE_TOOLS).
 */
import fs from "node:fs";
import path from "node:path";

const PATH_KEYS = ["file_path", "filePath", "path", "TargetFile", "target_file", "targetFile", "AbsolutePath", "absolutePath"] as const;

/** Absolute path(s) an `edit`-kind tool call wrote, from its raw input JSON; [] when the kind is not an edit, the call failed or the input names none. */
export function editToolWrittenPaths(input: { kind?: string | undefined; args?: string | undefined; isError?: boolean | undefined; exists?: (p: string) => boolean }): string[] {
  if (input.kind !== "edit" || input.isError || !input.args) return [];
  let value: unknown;
  try { value = JSON.parse(input.args); } catch { return []; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const exists = input.exists ?? ((p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  const found: string[] = [];
  for (const key of PATH_KEYS) {
    const candidate = (value as Record<string, unknown>)[key];
    if (typeof candidate !== "string" || /[\u0000\r\n]/u.test(candidate) || !path.isAbsolute(candidate) || candidate.length > 1024) continue;
    if (!found.includes(candidate) && exists(candidate)) found.push(candidate);
  }
  return found.slice(0, 4);
}
