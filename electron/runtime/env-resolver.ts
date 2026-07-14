import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "electron";
import type { InstalledAgent } from "../../shared/types";
import { agentFolderPath } from "../agents/files";
import { resolveActiveProvider } from "../multimodal/availability";
import { getMultimodalSettings } from "../multimodal/settings";
import { readEnvVar } from "../secrets/vault";

const DOTENV_FILES = [".env", ".env.local"];

// 프로젝트/에이전트 dotenv는 작업에 필요한 API 키를 덮어쓸 수 있어야 하지만, 호스트 런타임의
// 신원·설치·플러그인 탐색 루트까지 바꾸면 전역 skills/plugins가 사라지거나 다른 CLI/코드가
// 실행될 수 있다. 이 값들은 Agentlas를 시작한 신뢰된 프로세스 환경에서만 상속한다.
const PROTECTED_RUNNER_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_SAFE_MODE",
  "CLAUDE_CODE_SIMPLE",
  "CLAUDE_PLUGIN_ROOT",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_PROJECT_DIR",
  "GEMINI_CLI_HOME",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GEMINI_CLI_USER_SETTINGS",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  "GEMINI_CLI_TRUST_WORKSPACE",
  "GEMINI_CLI_EXTENSION_REGISTRY_URI",
  "HEPHAESTUS_RUNTIME_ROOT",
  "HEPHAESTUS_RUNTIME_BASE",
  "HEPHAESTUS_PYTHON",
  "HEPHAESTUS_AUTO_UPDATE",
  "HEPHAESTUS_UPDATE_CHECK",
  "NPM_CONFIG_PREFIX",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONHOME",
  "PYTHONPATH",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

export function isProtectedRunnerEnvKey(key: string): boolean {
  return PROTECTED_RUNNER_ENV_KEYS.has(key.trim().toUpperCase());
}

/** 보호 키를 제외하고 dotenv/vault 값을 병합. 반환값은 실제 주입된 키 목록이다. */
export function mergeRunnerEnvValues(
  target: NodeJS.ProcessEnv,
  values: Record<string, string>,
  overwrite: boolean,
): string[] {
  const injected: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!value || isProtectedRunnerEnvKey(key)) continue;
    if (!overwrite && target[key]) continue;
    target[key] = value;
    injected.push(key);
  }
  return injected;
}

export interface RunnerEnvResolution {
  env: NodeJS.ProcessEnv;
  injectedKeys: string[];
}

export interface RunnerEnvOptions {
  /** Main-authored Mobile/unattended read boundary. Never hydrate dotenv/vault secrets. */
  restrictedReadBoundary?: boolean;
}

// Restricted runs are BYOK/Ollama protocol calls, not local CLI processes.
// Their runner implementations ignore `env`, so inherit nothing at all.
export function restrictedRunnerEnv(): NodeJS.ProcessEnv {
  return {};
}

// Browser-originated Agent App input is untrusted. Its model process receives
// only the host coordinates required to locate the installed CLI and its
// subscription login. Project/agent dotenv files, Agentlas credential files,
// vault keys, proxy credentials, preload hooks, and arbitrary process env are
// deliberately absent.
const AGENT_APP_RUNNER_ENV_ALLOWLIST = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_RUNTIME_DIR",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
]);

const AGENT_APP_MCP_SECRET_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;

export function buildAgentAppRunnerEnv(
  source: NodeJS.ProcessEnv = process.env,
  mainOwnedCapabilityEnv?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of AGENT_APP_RUNNER_ENV_ALLOWLIST) {
    const value = source[key];
    if (typeof value === "string" && value) env[key] = value;
  }
  // Only the main-owned MCP config builder can mint these opaque aliases.
  // Never copy a raw key name/value from process.env or renderer-shaped input.
  for (const [key, value] of Object.entries(mainOwnedCapabilityEnv ?? {})) {
    if (AGENT_APP_MCP_SECRET_ALIAS_RE.test(key) && typeof value === "string" && value) env[key] = value;
  }
  env.AGENTLAS_UNTRUSTED_NO_TOOLS = "1";
  // Empty Claude setting sources exclude user/project/local instructions,
  // skills, plugins, and hooks. These two host-level sources sit outside that
  // switch, so disable them explicitly for browser-originated Agent Apps.
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.NO_COLOR = "1";
  return env;
}

export async function buildRunnerEnv(
  agent: InstalledAgent | null,
  cwd?: string | null,
  options: RunnerEnvOptions = {},
): Promise<RunnerEnvResolution> {
  if (options.restrictedReadBoundary) {
    return { env: restrictedRunnerEnv(), injectedKeys: [] };
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  const injected = new Set<string>();
  const apply = (values: Record<string, string>, overwrite: boolean) => {
    for (const key of mergeRunnerEnvValues(env, values, overwrite)) injected.add(key);
  };

  apply(readDotEnvFile(path.join(app.getPath("userData"), "credentials.env")), false);
  apply(readDotEnvFile(path.join(os.homedir(), ".agentlas", "credentials.env")), false);
  if (cwd) apply(readDotEnvFiles(cwd), true);

  const agentDir = agent ? agent.localPath || agentFolderPath(agent.slug) : null;
  if (agentDir) apply(readDotEnvFiles(agentDir), true);

  const vaultKeys = new Set<string>();
  if (agent) {
    for (const req of agent.envRequirements) {
      if (req.key) vaultKeys.add(req.key);
    }
  }

  // 멀티모달 엔진을 실행 전에 결정적으로 확정한다(런타임 LLM이 사다리를 되짚지 않게).
  // auto면 키리스 우선 순서로 첫 가용 엔진을 고르고, 그 엔진의 키만 주입한다.
  const settings = getMultimodalSettings();
  const [image, video, audio] = await Promise.all([
    resolveActiveProvider("image", settings),
    resolveActiveProvider("video", settings),
    resolveActiveProvider("audio", settings),
  ]);
  for (const resolved of [image, video, audio]) {
    if (resolved.provider) {
      for (const key of resolved.provider.envKeys) vaultKeys.add(key);
    }
  }

  for (const key of vaultKeys) {
    if (isProtectedRunnerEnvKey(key) || env[key]) continue;
    const value = await readEnvVar(key);
    if (value) {
      env[key] = value;
      injected.add(key);
    }
  }

  // 확정된 엔진 id + 준비 여부를 env로 넘긴다. 에이전트는 이 값을 "그대로 써라"만 하면 된다.
  env.AGENTLAS_MULTIMODAL_IMAGE_PROVIDER = image.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_IMAGE_READY = image.ready ? "1" : "0";
  env.AGENTLAS_MULTIMODAL_VIDEO_PROVIDER = video.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_VIDEO_READY = video.ready ? "1" : "0";
  env.AGENTLAS_MULTIMODAL_AUDIO_PROVIDER = audio.provider?.id ?? "none";
  env.AGENTLAS_MULTIMODAL_AUDIO_READY = audio.ready ? "1" : "0";

  return { env, injectedKeys: [...injected].sort() };
}

export function readDotEnvFiles(dir: string): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const name of DOTENV_FILES) {
    const file = path.join(dir, name);
    Object.assign(merged, parseDotEnv(readSmallText(file)));
  }
  return merged;
}

export function readDotEnvFile(file: string): Record<string, string> {
  return parseDotEnv(readSmallText(file));
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z][A-Z0-9_]{2,})\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function readSmallText(file: string): string {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 512 * 1024) return "";
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}
