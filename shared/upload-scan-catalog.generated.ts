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

/** Package ceilings. The wall is the store: a package's bytes ride inside one
 *  manifest document (16 MiB BSON cap) as base64, so the document carries 4/3
 *  of PACKAGE_MAX_TOTAL_BYTES. Never restate these — import them. */
export const PACKAGE_MAX_TOTAL_BYTES = 10485760;
export const PACKAGE_MAX_FILE_BYTES = 2097152;
export const PACKAGE_MAX_UNCOMPRESSED_TOTAL_BYTES = 41943040;
export const PACKAGE_MAX_UNCOMPRESSED_FILE_BYTES = 8388608;
export const PACKAGE_MAX_FILES = 400;
export const PACKAGE_MAX_REQUEST_BYTES = 15728640;
