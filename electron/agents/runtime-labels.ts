import fs from "node:fs";
import path from "node:path";
import type { RuntimeLabel } from "./routes";

function exists(target: string): boolean {
  try {
    fs.accessSync(target);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Pure package inspection shared by import and Cloud packaging. */
export function detectRuntimeLabels(dir: string): RuntimeLabel[] {
  const labels: RuntimeLabel[] = [];
  if (exists(path.join(dir, "CLAUDE.md")) || isDirectory(path.join(dir, ".claude"))) labels.push("claude-code");
  if (exists(path.join(dir, "AGENTS.md"))) labels.push("codex");
  if (exists(path.join(dir, "GEMINI.md"))) labels.push("gemini");
  if (isDirectory(path.join(dir, ".cursor")) || exists(path.join(dir, ".cursorrules"))) labels.push("cursor");
  if (labels.length === 0) labels.push("generic");
  return labels;
}

/**
 * Detect runtime compatibility from an already captured package snapshot.
 * Cloud packaging uses this variant so a post-scan filesystem swap cannot
 * change manifest metadata or make us follow a newly introduced symlink.
 */
export function detectRuntimeLabelsFromPaths(paths: Iterable<string>): RuntimeLabel[] {
  const normalized = new Set(Array.from(paths, (value) => value.replaceAll("\\", "/")));
  const hasFile = (value: string): boolean => normalized.has(value);
  const hasDirectory = (value: string): boolean => {
    const prefix = `${value.replace(/\/$/, "")}/`;
    return Array.from(normalized).some((entry) => entry.startsWith(prefix));
  };

  const labels: RuntimeLabel[] = [];
  if (hasFile("CLAUDE.md") || hasDirectory(".claude")) labels.push("claude-code");
  if (hasFile("AGENTS.md")) labels.push("codex");
  if (hasFile("GEMINI.md")) labels.push("gemini");
  if (hasDirectory(".cursor") || hasFile(".cursorrules")) labels.push("cursor");
  if (labels.length === 0) labels.push("generic");
  return labels;
}
