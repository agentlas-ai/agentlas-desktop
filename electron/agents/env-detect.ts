import fs from "node:fs";
import path from "node:path";
import type { AgentEnvRequirement } from "../../shared/types";

const MAX_FILE_BYTES = 256 * 1024;
const ENV_KEY_RE =
  /\b[A-Z][A-Z0-9_]{2,}(?:API_KEY|TOKEN|SECRET|PASSWORD|CLIENT_ID|CLIENT_SECRET|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|SERVICE_ACCOUNT|WEBHOOK_SECRET|CREDENTIALS|KEY)\b/g;
const PROCESS_ENV_RE = /process\.env\.([A-Z][A-Z0-9_]{2,})/g;
const DOTENV_LINE_RE = /^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=/gm;
const SAFE_IGNORES = new Set([
  "CI",
  "HOME",
  "LANG",
  "NODE_ENV",
  "PATH",
  "PORT",
  "PWD",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
]);

const CANDIDATE_FILES = [
  ".env",
  ".env.local",
  ".env.example",
  ".env.sample",
  ".env.template",
  "env.example",
  "README.md",
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "manifest.md",
  "package.json",
  ".mcp.json",
];

export function detectEnvRequirementsFromFolder(dir: string, extraText = ""): AgentEnvRequirement[] {
  const found = new Map<string, { sources: Set<string>; required: boolean }>();
  const add = (key: string, source: string, required: boolean) => {
    if (!isEnvKeyCandidate(key)) return;
    const entry = found.get(key) ?? { sources: new Set<string>(), required: false };
    entry.sources.add(source);
    entry.required = entry.required || required;
    found.set(key, entry);
  };

  for (const name of CANDIDATE_FILES) {
    const file = path.join(dir, name);
    const text = readSmallText(file);
    if (!text) continue;
    collectEnvKeys(text, name, add);
  }
  if (extraText.trim()) collectEnvKeys(extraText, "system prompt", add);

  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, info]) => ({
      key,
      label: humanizeEnvKey(key),
      labelEn: humanizeEnvKey(key),
      required: info.required,
      hint: `Detected in ${[...info.sources].slice(0, 3).join(", ")}`,
      hintEn: `Detected in ${[...info.sources].slice(0, 3).join(", ")}`,
    }));
}

function collectEnvKeys(
  text: string,
  source: string,
  add: (key: string, source: string, required: boolean) => void,
): void {
  for (const match of text.matchAll(DOTENV_LINE_RE)) add(match[1], source, true);
  for (const match of text.matchAll(PROCESS_ENV_RE)) add(match[1], source, true);
  for (const match of text.matchAll(ENV_KEY_RE)) add(match[0], source, source.includes(".env"));
}

function readSmallText(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function isEnvKeyCandidate(key: string): boolean {
  if (!key || SAFE_IGNORES.has(key)) return false;
  if (key.startsWith("npm_")) return false;
  if (key.length < 4 || key.length > 96) return false;
  return /^[A-Z][A-Z0-9_]+$/.test(key);
}

function humanizeEnvKey(key: string): string {
  return key
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}
