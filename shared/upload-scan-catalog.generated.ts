// ⚠️ GENERATED FILE — do not hand-edit; the next generation erases your change.
// 정본: agentlas/AgentsAtlas/app/src/lib/agentlas-cloud/upload-scan-catalog.json
// 생성: (agentlas/AgentsAtlas/app) node scripts/gen-upload-scan-catalog.mjs
//
// Cloud-agent upload + secret-scan catalog. Three products used to restate
// this by hand and drifted; the server-side scan was the one that lost.

export const SECRET_SCAN_TEXT_EXTENSIONS = [
  ".bat",
  ".cfg",
  ".cjs",
  ".cmd",
  ".conf",
  ".config",
  ".css",
  ".csv",
  ".env",
  ".html",
  ".ini",
  ".js",
  ".json",
  ".jsonl",
  ".jsx",
  ".md",
  ".mjs",
  ".properties",
  ".ps1",
  ".psd1",
  ".psm1",
  ".py",
  ".sh",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
] as const;

export const UPLOAD_SKIP_DIRECTORIES = [
  ".git",
  ".next",
  ".studio-runtime",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "release",
] as const;

/** Every filename that can define one agent. */
export const AGENT_DEFINITION_FILES = [
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
  "system.md",
  "soul.md",
  "prompt.md",
  "persona.md",
] as const;

/** Packaging + server-side registration. Narrower by declaration, not by omission. */
export const UPLOAD_AGENT_DEFINITION_FILES = [
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "README.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
] as const;

/** Detecting whether a folder is one agent. */
export const FOLDER_SCAN_AGENT_DEFINITION_FILES = [
  "AGENT.md",
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
  "agent.md",
  "manifest.md",
  "system-prompt.md",
  "system.md",
  "soul.md",
  "prompt.md",
  "persona.md",
] as const;
