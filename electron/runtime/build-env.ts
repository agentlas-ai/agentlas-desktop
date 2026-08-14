import type { RuntimeKind } from "../../shared/types";

/**
 * Build runs with full shell authority, so its environment is a separate trust
 * boundary. Passing process.env wholesale would expose every host credential to
 * both the LLM CLI and any MCP child it starts.
 */
const BUILD_OPERATIONAL_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "TERM",
  "COLORTERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NPM_CONFIG_PREFIX",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
] as const;

/** Only credentials/configuration used by the one selected LLM runtime. */
const BUILD_RUNTIME_ENV_KEYS: Record<RuntimeKind, readonly string[]> = {
  "claude-code": [
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_SAFE_MODE",
    "CLAUDE_CODE_SIMPLE",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_DATA",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
  ],
  codex: ["CODEX_HOME", "CODEX_API_KEY", "OPENAI_API_KEY"],
  antigravity: [
    "GEMINI_CLI_HOME",
    "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    "GEMINI_CLI_USER_SETTINGS",
    "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
    "GEMINI_CLI_EXTENSION_REGISTRY_URI",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENAI_USE_VERTEXAI",
    "GOOGLE_CLOUD_PROJECT",
    "GOOGLE_CLOUD_LOCATION",
    "GOOGLE_APPLICATION_CREDENTIALS",
  ],
  // Kimi Code keeps OAuth state in its own home directory. No unrelated host
  // credential is copied into build workers.
  kimi: ["KIMI_CODE_HOME", "AGENTLAS_KIMI_BIN"],
  grok: [
    "AGENTLAS_GROK_BIN",
    "AGENTLAS_GROK_SESSIONS_DIR",
    "GROK_API_KEY",
    "XAI_API_KEY",
  ],
  // Cursor Agent CLI owns its authenticated account state under ~/.cursor.
  // No API secret is copied into build workers.
  cursor: ["CURSOR_AGENT_HOME", "CURSOR_CONFIG_DIR"],
  ollama: ["OLLAMA_HOST", "OLLAMA_API_KEY"],
  lmstudio: ["LMSTUDIO_HOST"],
  mlx: ["MLX_HOST"],
  // BYOK runners read their one selected key directly from the Main vault and
  // do not need any host environment credential.
  byok: [],
};

const MCP_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"] as const;

function hostValue(hostEnv: NodeJS.ProcessEnv, key: string): string | undefined {
  const actual = Object.keys(hostEnv).find((candidate) => candidate.toUpperCase() === key);
  const value = actual ? hostEnv[actual] : undefined;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function safeProxyValue(key: string, value: string): string | null {
  if (key === "NO_PROXY") return value.slice(0, 8_192);
  try {
    const parsed = new URL(value);
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Minimal cross-platform environment for a Build runner and its MCP children.
 * MCP values are accepted only under Main-generated opaque aliases; arbitrary
 * keys from a config object can never smuggle another host secret back in.
 */
export function buildIsolatedBuildRunnerEnv(
  runtimeKind: RuntimeKind,
  mcpRuntimeEnv: Record<string, string> = {},
  hostEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [...BUILD_OPERATIONAL_ENV_KEYS, ...BUILD_RUNTIME_ENV_KEYS[runtimeKind]]) {
    const value = hostValue(hostEnv, key);
    if (value !== undefined) env[key] = value;
  }
  for (const key of PROXY_KEYS) {
    const value = hostValue(hostEnv, key);
    if (!value) continue;
    const safe = safeProxyValue(key, value);
    if (safe) env[key] = safe;
  }
  for (const [key, value] of Object.entries(mcpRuntimeEnv)) {
    if (MCP_SECRET_ALIAS_RE.test(key) && typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export function isBuildMcpSecretAlias(key: string): boolean {
  return MCP_SECRET_ALIAS_RE.test(key);
}
