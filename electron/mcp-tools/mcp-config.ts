// MCP -> 런타임 브리지. 설치·활성화된 MCP 서버를 런타임별 설정으로 직렬화한다.
// - Claude Code: `--mcp-config` JSON 파일 (vault 값은 `${ENV_ALIAS}` 참조만 기록)
// - Codex CLI: `-c mcp_servers.<name>...` config overrides (시크릿 값 없는 이름/경로만 전달)
// 값(시크릿)은 keychain vault에서 읽어 런타임 env의 불투명 alias로만 전달한다. 모든 stdio MCP는
// 작은 wrapper가 자기 alias만 원래 키로 되돌린 뒤 최소 env로 서버를 spawn한다. 따라서 LLM 인증,
// 다른 MCP 자격증명, unrelated host secret을 MCP 자식이 상속하지 않는다.
//
// 이게 없으면 카탈로그의 Playwright(브라우저) 서버가 "설치"만 되고 채팅 중 호출되지 않았다.
// 이제 에이전트가 실제로 브라우저를 띄워 회원가입/로그인/키 발급을 대신 해줄 수 있다.
import { registerPreparedMcpConfig, mcpServerConfigurationDigest } from "./prepared-transport";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { ensureDefaultMcpPluginsInstalled } from "./defaults";
import { listInstalledServers } from "./registry";
import { readEnvVar } from "../secrets/vault";
import { resolveMcpOAuthAccessToken } from "./oauth";
import {
  OPENCRAB_CATALOG_ID,
  isOpenCrabCredentialUrl,
  isVaultBackedRemoteUrl,
  validateOpenCrabMcpUrl,
  vaultUrlKey,
} from "../opencrab/constants";
import type { InstalledMcpServer } from "../../shared/types";
import { isAuthenticSystemTimeMcpLaunch, isCanonicalSystemTimeMcpServer } from "./system-time-server";
import { BROWSER_APPROVAL_FILE_ENV, browserApprovalInfoPath } from "../browser/approval-channel";
import { WORKSPACE_PREVIEW_CONTROL_ENV, type WorkspacePreviewOwnerGrant } from "../workspace-preview/channel";
import { createWorkspacePreviewCapability, removeWorkspacePreviewCapabilityForConfig } from "../workspace-preview/control-server";
import { isAuthenticWorkspacePreviewMcpLaunch } from "../workspace-preview/mcp-server";
import {
  isAuthenticComputerUseMcpLaunch,
  isCanonicalComputerUseMcpServer,
} from "../computer-use/mcp-server";
import { COMPUTER_USE_CONTROL_FILE_ENV, computerUseControlInfoPath } from "../computer-use/channel";
import { resolveHephaestusStdioLaunch } from "../hephaestus/engine";
import {
  MCP_PROXY_CONTROL_FILE_ENV,
  MCP_PROXY_SERVER_KEY_ENV,
  MCP_PROXY_PLAN_ENV,
  MCP_PROXY_SESSION_ENV,
  MCP_PROXY_TARGET_ENV,
  mcpProxyControlInfoPath,
} from "./proxy-channel";
import { mcpProxyApprovalPort } from "./proxy-server";
import { userDataPath } from "../runtime-paths";
import {
  BROWSER_CDP_LAUNCHER_BASENAME,
  BROWSER_CDP_LAUNCHER_PATH_ENV,
  browserCdpLauncherPath,
  browserCdpPort,
  browserCdpProfilePath,
  ensureBrowserCdpLauncherReady,
} from "./browser-cdp-launcher";

export interface AgentlasBrowserCdpRuntimeContract {
  command: string;
  args: [string];
  env: {
    ELECTRON_RUN_AS_NODE: "1";
    AGENTLAS_CDP_PROFILE: string;
    AGENTLAS_CDP_PORT: string;
  };
}

/** One source of truth for the host bootstrap and every model MCP child. */
export function agentlasBrowserCdpRuntimeContract(scope?: string): AgentlasBrowserCdpRuntimeContract {
  const launcher = ensureBrowserCdpLauncherReady(scope);
  return {
    command: process.execPath,
    args: [launcher],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      AGENTLAS_CDP_PROFILE: browserCdpProfilePath(),
      AGENTLAS_CDP_PORT: String(browserCdpPort()),
    },
  };
}

function isCanonicalAgentlasBrowserLauncher(server: InstalledMcpServer): boolean {
  return Boolean(
    server.catalogId === "agentlas-browser"
    && server.transport === "stdio"
    && server.command === process.execPath
    && server.envKeys.length === 0
    && server.configurationValid !== false
    && server.args.length === 1
    && expandHome(server.args[0]) === path.join(os.homedir(), ".agentlas", BROWSER_CDP_LAUNCHER_BASENAME),
  );
}

export function shouldApplyAgentlasBrowserCdpOverride(server: InstalledMcpServer): boolean {
  return Boolean(process.env[BROWSER_CDP_LAUNCHER_PATH_ENV]?.trim() && isCanonicalAgentlasBrowserLauncher(server));
}

function expandHome(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/")) return os.homedir() + arg.slice(1);
  return arg;
}

function resolveStdioCommand(s: InstalledMcpServer): string {
  // Never borrow another app's private/signed Computer Use helper. OpenAI's
  // service authenticates its sender and rejects Agentlas anyway; silently
  // substituting it made the catalog look installed while every action failed.
  return expandHome(s.command ?? "");
}

/** MCP tool 이름 mcp__<key>__<tool> 의 key — 안전한 슬러그. */
export function mcpConfigKey(s: InstalledMcpServer): string {
  return (s.catalogId || s.name || s.id).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}

function tomlInlineStringTable(values: Record<string, string>): string {
  const pairs = Object.entries(values).map(([key, value]) => `${key}=${tomlString(value)}`);
  return `{${pairs.join(",")}}`;
}

function pushCodexConfig(args: string[], key: string, prop: string, value: string): void {
  args.push("-c", `mcp_servers.${key}.${prop}=${value}`);
}

export interface McpConfigResult {
  /** True only after exact canonical native browser credentials were bound. */
  nativeBrowserBound?: true;
  configPath: string;
  /** ["mcp__playwright", ...] — write/full 권한에서 --allowedTools 자동 승인용. */
  allowedTools: string[];
  /** Codex CLI `exec`에 그대로 붙이는 runtime-local MCP config overrides. 시크릿 값은 포함하지 않는다. */
  codexConfigArgs: string[];
  /** CLI 부모 환경에만 넣는 불투명 alias -> vault 값. 설정 파일/argv에는 값이 기록되지 않는다. */
  runtimeEnv: Record<string, string>;
  /** Exact registry rows that survived the final just-in-time key/config checks. */
  includedServerIds: string[];
  /** Value-free runtime attribution map used only for one-server startup recovery. */
  includedServers?: Array<{ serverId: string; catalogId: string | null; configKey: string }>;
  /** Remove this run's Main capability file and revoke its in-memory binding. */
  workspacePreviewCapabilityCleanup?: () => void;
}

export interface McpConfigBuildOptions {
  /** Exact Main-authorized workspace, including runs without a tool-gate proxy. */
  workingFolder?: string;
  /** Main-only, run-scoped native guest grant; token remains in runtime secret aliases. */
  nativeBrowser?: { endpoint: string; token: string };
  /** Playwright MCP persistent profile key. Used by automations to avoid sharing the interactive browser profile lock. */
  browserProfileKey?: string;
  /** When present, serialize only these selected catalog ids for the current run. */
  catalogIds?: string[];
  /** Graph-declared ids before the selected-tool union; used for safe canonical aliases. */
  requiredToolCatalogIds?: string[];
  /** Main-authoritative exact server allowlist. Prefer this for consented Build plans. */
  serverIds?: string[];
  /** Build plans must never seed defaults as a side effect of config serialization. */
  skipDefaultSeed?: boolean;
  /** Per-run file key. Prevents concurrent Build plans from racing on one shared config. */
  configKey?: string;
  /** Main-minted owner-full evidence for a worker's bounded preview tool. */
  workspacePreviewOwnerGrant?: WorkspacePreviewOwnerGrant;
  /**
   * 이 실행의 도구 관문 정보. 있으면 stdio MCP 서버가 **우리 프록시를 거쳐** 실행되고,
   * 모든 tools/call 이 중재자를 지난다. 없으면 예전처럼 서버를 직접 넘긴다.
   *
   * 관문이 필요한 이유는 런타임마다 다르다 — cursor CLI 는 MCP 훅을 아예 안 쏘고,
   * copilot 은 서브에이전트 내부 호출에 훅이 안 걸린다. claude 처럼 자기 훅이 이미
   * 배선된 런타임에도 붙여 두면 두 관문이 같은 답을 내므로 해롭지 않다.
   */
  toolGate?: {
    runtime: string;
    sessionKey: string;
    permission?: "read" | "write" | "full";
    /** Graph dry-run: mutating MCP calls are denied locally without opening a user approval sheet. */
    simulation?: true;
    cwd?: string;
    chatId?: string;
    unattended?: boolean;
    /** 그래프 노드의 도구 중개 계획 파일(workflow/tool-broker-runtime.ts). */
    planPath?: string;
  };
}

/**
 * stdio 서버 하나를 프록시로 감싼다. 승인 서버가 떠 있지 않거나 이 실행이 관문 정보를
 * 주지 않았으면 `null` — 그때는 감싸지 않는다. 관문 없는 프록시는 통과 파이프일 뿐이고,
 * 한 겹 늘린 만큼 손해만 본다.
 */
function mcpProxySpec(
  serverKey: string,
  actual: { command: string; args: string[]; env: Record<string, string> },
  opts: McpConfigBuildOptions | undefined,
  catalogId: string | null,
): { command: string; args: string[]; env: Record<string, string> } | null {
  const gate = opts?.toolGate;
  if (!gate) return null;
  if (mcpProxyApprovalPort() <= 0) return null;
  const childPath = path.join(__dirname, "proxy-child.cjs");
  if (!fs.existsSync(childPath)) return null;
  // The proxy inherits resolved aliases from its own environment. Repeating
  // ${ALIAS} inside this serialized JSON lets provider string interpolation
  // corrupt the JSON when a vault value contains quotes or backslashes.
  // Keep only exact self-references out of the nested overlay; the outer env
  // and the wrapper's validated target-key mapping retain the same binding.
  const targetEnv = Object.fromEntries(Object.entries(actual.env).filter(([key, value]) =>
    !(/^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/.test(key) && value === envReference(key))));
  return {
    command: process.execPath,
    args: [childPath],
    env: {
      ELECTRON_RUN_AS_NODE: "1",
      [MCP_PROXY_CONTROL_FILE_ENV]: mcpProxyControlInfoPath(),
      [MCP_PROXY_TARGET_ENV]: JSON.stringify({ ...actual, env: targetEnv }),
      [MCP_PROXY_SERVER_KEY_ENV]: serverKey,
      [MCP_PROXY_SESSION_ENV]: JSON.stringify({ ...gate, catalogId }),
      ...(gate.planPath ? { [MCP_PROXY_PLAN_ENV]: gate.planPath } : {}),
      // 실제 서버가 쓰는 alias 참조는 프록시가 그대로 물려줘야 한다 — 프록시는
      // 자기 env 를 자식에게 펼쳐 준다(proxy-child.cjs).
      ...actual.env,
    },
  };
}

function safeProfileKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ALIAS_PREFIX = "AGENTLAS_MCP_SECRET_";
const HEPHAESTUS_NETWORK_CATALOG_ID = "hephaestus-network";

function validateEnvKey(value: string): string {
  const key = value.trim();
  if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid MCP environment key: ${value}`);
  return key;
}

export function mcpRuntimeSecretAlias(serverKey: string, envKey: string): string {
  const digest = createHash("sha256").update(serverKey).update("\0").update(envKey).digest("hex");
  return `${SECRET_ALIAS_PREFIX}${digest.slice(0, 32).toUpperCase()}`;
}

function envReference(alias: string): string {
  return `\${${alias}}`;
}

/**
 * vault URL sentinel이 가리키는 실제 원격 URL. OpenCrab은 전용 검증기를 통과해야
 * 하고, 그 외 vault URL은 https 원본만 허용한다. 검증 실패는 null(fail closed).
 */
function resolveVaultRemoteUrl(s: InstalledMcpServer, rawUrl: string): string | null {
  try {
    if (s.catalogId === OPENCRAB_CATALOG_ID || isOpenCrabCredentialUrl(rawUrl)) {
      return validateOpenCrabMcpUrl(rawUrl).toString();
    }
    const url = new URL(rawUrl);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

const MCP_CHILD_ENV_WRAPPER = `"use strict";
const crossSpawn = require(process.argv[2]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MCP_ALIAS_RE = /^AGENTLAS_MCP_SECRET_[A-F0-9]{32}$/;
const OPERATIONAL_KEYS = [
  "PATH", "PATHEXT", "HOME", "USER", "LOGNAME", "USERNAME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR",
  "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432", "TMPDIR", "TEMP",
  "TMP", "SHELL", "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_CACHE", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
  "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "NO_COLOR",
  "AGENTLAS_BROWSER_APPROVAL_FILE", "AGENTLAS_CDP_AUTO_STOP", "AGENTLAS_CDP_HEADLESS",
  "AGENTLAS_CDP_PROFILE", "AGENTLAS_CDP_PORT", "AGENTLAS_NATIVE_BROWSER_ENDPOINT",
  "AGENTLAS_COMPUTER_USE_CONTROL_FILE"
];
const PROXY_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"];
let mapping;
try {
  mapping = JSON.parse(process.argv[3] || "{}");
} catch {
  process.stderr.write("Agentlas MCP secret wrapper received invalid mapping.\\n");
  process.exit(78);
}
const command = process.argv[4];
const args = process.argv.slice(5);
if (!command || !mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
  process.stderr.write("Agentlas MCP secret wrapper received invalid launch arguments.\\n");
  process.exit(78);
}

const env = {};
for (const key of OPERATIONAL_KEYS) {
  const actual = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === key);
  const value = actual ? process.env[actual] : undefined;
  if (typeof value === "string" && value.length > 0) env[key] = value;
}
for (const key of PROXY_KEYS) {
  const actual = Object.keys(process.env).find((candidate) => candidate.toUpperCase() === key);
  const value = actual ? process.env[actual] : undefined;
  if (typeof value !== "string" || value.length === 0) continue;
  if (key === "NO_PROXY") {
    env[key] = value.slice(0, 8192);
    continue;
  }
  try {
    const parsed = new URL(value);
    if (/^https?:$/.test(parsed.protocol) && !parsed.username && !parsed.password) env[key] = parsed.toString();
  } catch {}
}
// A built-in MCP may use the signed Electron binary as its bundled Node
// runtime. Do not forward this switch to unrelated external executables.
if (command === process.execPath) env.ELECTRON_RUN_AS_NODE = "1";
for (const [targetKey, alias] of Object.entries(mapping)) {
  if (!ENV_KEY_RE.test(targetKey) || typeof alias !== "string" || !MCP_ALIAS_RE.test(alias)) {
    process.stderr.write("Agentlas MCP secret wrapper rejected an invalid environment mapping.\\n");
    process.exit(78);
  }
  const value = process.env[alias];
  if (typeof value !== "string" || value.length === 0) {
    process.stderr.write("Agentlas MCP secret wrapper is missing a required vault value.\\n");
    process.exit(78);
  }
  env[targetKey] = value;
}

const child = crossSpawn(command, args, { stdio: "inherit", env });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
child.once("error", (error) => {
  process.stderr.write(String(error && error.message ? error.message : error) + "\\n");
  process.exit(1);
});
child.once("exit", (code) => process.exit(typeof code === "number" ? code : 1));
`;

/** Value-free integrity pin used by the Agent App execution boundary. */
export const MCP_CHILD_ENV_WRAPPER_SHA256 = createHash("sha256")
  .update(MCP_CHILD_ENV_WRAPPER)
  .digest("hex");

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
}

function writePrivateFile(file: string, content: string): void {
  if (process.platform === "win32") {
    fs.writeFileSync(file, content, { encoding: "utf8", mode: 0o600 });
    return;
  }
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
    // rename 대상이 과거 0644 파일이어도 새 inode의 최소 권한을 다시 명시한다.
    fs.chmodSync(file, 0o600);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function overwriteAndRemovePrivateFile(file: string): void {
  const fd = fs.openSync(file, "r+");
  try {
    const size = fs.fstatSync(fd).size;
    const zeros = Buffer.alloc(64 * 1024);
    for (let offset = 0; offset < size; offset += zeros.length) {
      fs.writeSync(fd, zeros, 0, Math.min(zeros.length, size - offset), offset);
    }
    fs.ftruncateSync(fd, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.rmSync(file, { force: true });
}

/**
 * A pre-Keychain build could serialize an OpenCrab path credential into the
 * generated Claude MCP config. Delete that derived file at startup; it will be
 * recreated from the current registry on the next runtime invocation.
 */
export function scrubLegacyOpenCrabMcpConfig(): boolean {
  const dir = userDataPath("mcp");
  if (!fs.existsSync(dir)) return false;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const names = entries.filter(
    (name) => name === "agentlas-mcp.json" || /^agentlas-mcp\.json\.\d+\.[0-9a-f-]+\.tmp$/i.test(name),
  );
  let removed = false;
  let failure: unknown;
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      const raw = fs.readFileSync(candidate, "utf8");
      const containsCredential = /ocm_[A-Za-z0-9_-]{12,}/.test(raw)
        || /https:\/\/(?:[a-z0-9-]+\.)*opencrab\.sh(?::\d+)?(?:\/|["'\s])/i.test(raw);
      if (!containsCredential) continue;
      overwriteAndRemovePrivateFile(candidate);
      removed = true;
    } catch (error) {
      // Keep scanning sibling derived files, then fail closed so startup logs
      // that at least one candidate could not be proven clean.
      failure ??= error;
    }
  }
  if (failure) throw failure;
  return removed;
}

function ensureMcpChildEnvWrapper(dir: string): string {
  const wrapperPath = path.join(dir, "mcp-child-env-wrapper.cjs");
  writePrivateFile(wrapperPath, MCP_CHILD_ENV_WRAPPER);
  return wrapperPath;
}

/**
 * A user-installed, keyless Playwright MCP can look like a harmless extra
 * tool while actually starting its own empty Chromium profile. That is not a
 * reason to grant it the authenticated CDP: only the canonical Agentlas
 * Browser resolver owns that channel.
 *
 * Keep this deliberately narrow. Explicit credentials, an explicit profile,
 * another executable, or a non-Playwright server remain untouched.
 */
export function isKeylessPlaywrightMcpDuplicate(server: InstalledMcpServer): boolean {
  // The built-in `playwright` catalog row is the same materialized launcher as
  // `agentlas-browser`; only the latter carries the authenticated approval
  // channel. Recognize that row only when its persisted launch is still the
  // host-owned resolver output, so a malformed/stale row is not silently
  // treated as canonical.
  if (
    server.catalogId === "playwright" &&
    server.transport === "stdio" &&
    server.command === process.execPath &&
    server.envKeys.length === 0 &&
    server.configurationValid !== false &&
    server.args.length === 1 &&
    expandHome(server.args[0]) === path.join(os.homedir(), ".agentlas", BROWSER_CDP_LAUNCHER_BASENAME)
  ) return true;
  if (
    server.transport !== "stdio" ||
    !server.command ||
    server.envKeys.length > 0 ||
    server.configurationValid === false
  ) return false;
  const command = path.basename(expandHome(server.command)).toLowerCase();
  if (command !== "npx" && command !== "npx.cmd" && command !== "node" && command !== "node.exe") return false;
  const args = server.args.map(expandHome);
  if (args.some((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="))) return false;
  const packageToken = /^@playwright\/mcp(?:@[^\s]+)?$/i;
  const directPackage = args.some((arg) => packageToken.test(arg.trim()));
  const nodePackagePath = args.some((arg) => /(?:^|[\\/])@playwright[\\/]mcp(?:[\\/]|$)/i.test(arg));
  if (!(command === "npx" || command === "npx.cmd" ? directPackage : nodePackagePath)) return false;
  // Only an unconfigured duplicate can share the selected canonical browser.
  // Profiles, endpoints, headers, config files and all other custom arguments
  // retain their own server identity and launch behavior.
  return args.every((arg) => arg === "-y" || arg === "--yes" || packageToken.test(arg)
    || /(?:^|[\\/])@playwright[\\/]mcp[\\/](?:cli|index)\.js$/i.test(arg));
}

/**
 * ★자격증명 서랍은 하나다 — 실행 키마다 프로필을 새로 파지 않는다.
 *
 * 예전에는 `browserProfileKey` 마다 `<userData>/mcp/browser-profiles/<key>` 를 만들어 줬다.
 * 그 결과 사용자는 Agentlas 브라우저에 로그인해 두고도 실행마다 로그인 0개짜리 창을 받았고,
 * 자격증명이 여러 서랍으로 갈라졌다(2026-08-19 실측: 전용 프로필·browser-profile·per-key 등
 * 서랍 다섯). 지금은 브라우저 도구가 전부 같은 런처를 통해 전용 Chrome 하나에 CDP 로 붙는다.
 *
 * 사용자가 직접 등록한 커스텀 서버가 자기 `--user-data-dir` 을 들고 오면 그건 그대로 존중한다 —
 * 우리가 만든 인자가 아니므로 말없이 바꾸지 않는다.
 */
function argsWithBrowserProfile(_key: string, args: string[], _opts?: McpConfigBuildOptions): string[] {
  return args;
}

/** Narrow default roots before sealing the exact per-run launch transport. */
function argsWithToolGateWorkingFolder(
  server: InstalledMcpServer,
  args: string[],
  opts?: McpConfigBuildOptions,
): string[] {
  const rawFolder = opts?.workingFolder ?? opts?.toolGate?.cwd;
  if (!rawFolder) return args.map(expandHome);
  const folder = path.resolve(rawFolder);
  if (!fs.statSync(folder).isDirectory()) throw new Error("mcp_workspace_not_directory");
  // Preserve the local tool loop's established literal-tilde narrowing for
  // custom servers too; do not reinterpret their other explicit arguments.
  const scoped = args.map((arg) => arg === "~" ? folder : expandHome(arg));
  if (server.catalogId !== "filesystem") return scoped;
  // The trusted catalog places its allowed root in the final argument.
  return scoped.length > 0 ? [...scoped.slice(0, -1), folder] : [folder];
}

/**
 * 설치·활성 MCP 서버를 .mcp.json 으로 써서 경로를 반환. 서버가 하나도 없으면 null.
 * stdio 서버는 command/args/env, sse·http 서버는 type/url 형태로 직렬화한다.
 * opts.catalogIds가 있으면 자동 선택된 도구만 직렬화한다. 예: computer-use 모드에서는
 * Playwright가 설치돼 있어도 config/allowedTools에 싣지 않아 브라우저 우회를 막는다.
 */
export async function buildMcpConfigFile(opts?: McpConfigBuildOptions): Promise<McpConfigResult | null> {
  // Automation must start the canonical Agentlas Browser wrapper itself. A
  // generic Playwright process attached directly to 9222 has no lease,
  // guardian, page cap or idle cleanup and can therefore orphan the browser.
  const automationBrowserRun = Boolean(opts?.browserProfileKey?.startsWith("automation-"));
  if (!opts?.skipDefaultSeed) ensureDefaultMcpPluginsInstalled();
  // ★승인된 자격증명은 실행 직전에 스스로 최신이 된다. 이 함수는 모든 런타임 실행이 지나는
  //   길목이라(모든 채널·그래프 노드 포함), 여기 한 번 걸면 어디서 브라우저를 쓰든 로그인이 있다.
  //   승인이 없으면 즉시 반환하고 아무것도 복사하지 않는다. 실패해도 실행을 막지 않는다.
  try {
    const { refreshBrowserCredentialsIfDue } = await import("../browser/credential-sync");
    await refreshBrowserCredentialsIfDue();
  } catch {
    /* 자격증명 갱신 실패가 도구 설정 작성을 막아서는 안 된다 */
  }
  const dir = userDataPath("mcp");
  const configPath = path.join(
    dir,
    opts?.configKey ? `agentlas-mcp-${safeProfileKey(opts.configKey)}.json` : "agentlas-mcp.json",
  );
  ensurePrivateDir(dir);
  const scopedCatalogIds = opts?.catalogIds ? new Set(opts.catalogIds.filter(Boolean)) : null;
  const scopedServerIds = opts?.serverIds ? new Set(opts.serverIds.filter(Boolean)) : null;
  const installedServers = listInstalledServers();
  const allEnabledServersSelected = !scopedCatalogIds && !scopedServerIds;
  const selectedKeylessPlaywright = installedServers.some((server) =>
    server.enabled
    && isKeylessPlaywrightMcpDuplicate(server)
    && Boolean(
      allEnabledServersSelected
      ||
      scopedCatalogIds?.has(server.catalogId ?? server.id)
      || scopedCatalogIds?.has(server.id)
      || scopedServerIds?.has(server.id),
    ));
  const selectedCanonicalBrowser = installedServers.some((server) =>
    server.enabled
    && server.catalogId === "agentlas-browser"
    && Boolean(
      allEnabledServersSelected
      || scopedCatalogIds?.has("agentlas-browser")
      || scopedServerIds?.has(server.id),
    ));
  const canonicalizeBrowser = (selectedCanonicalBrowser && !allEnabledServersSelected)
    || (automationBrowserRun && (selectedCanonicalBrowser || selectedKeylessPlaywright));
  if (canonicalizeBrowser && scopedCatalogIds) scopedCatalogIds.add("agentlas-browser");
  const servers = installedServers.filter((s) => {
    if (!s.enabled) return false;
    // 평문 credential URL(레거시 행)은 어떤 런타임 설정에도 싣지 않는다. vault://
    // sentinel 서버는 아래 직렬화에서 실제 URL을 keychain에서 읽어 불투명 alias
    // 참조(`${ALIAS}`)로만 기록하므로 Keychain 경계를 지킨 채 세션에 노출된다.
    if (!isVaultBackedRemoteUrl(s.url) && isOpenCrabCredentialUrl(s.url)) return false;
    if (scopedServerIds) {
      return scopedServerIds.has(s.id) || (canonicalizeBrowser && s.catalogId === "agentlas-browser");
    }
    if (!scopedCatalogIds) return true;
    return Boolean((s.catalogId && scopedCatalogIds.has(s.catalogId)) || scopedCatalogIds.has(s.id));
  });
  const requiredToolCatalogIds = new Set(opts?.requiredToolCatalogIds?.filter(Boolean) ?? []);
  const canonicalBrowserRun = Boolean(
    canonicalizeBrowser &&
    servers.some((server) => server.catalogId === "agentlas-browser"),
  );
  const browserAliases = new Map<string, InstalledMcpServer>();
  const serializedServers = servers.filter((server) => {
    if (!server.catalogId && requiredToolCatalogIds.has(server.id)) return true;
    if (!canonicalBrowserRun || !isKeylessPlaywrightMcpDuplicate(server)) return true;
    // Graph declarations have historically used either the installed row id
    // (custom servers) or the catalog id (official rows). Preserve both
    // identities below without ever serializing/spawning the duplicate.
    browserAliases.set(server.id, server);
    if (server.catalogId) browserAliases.set(server.catalogId, server);
    return false;
  });
  if (serializedServers.length === 0) {
    // 구버전이 0644 JSON에 남긴 vault 평문을 선택 결과가 0개인 실행에서도 방치하지 않는다.
    fs.rmSync(configPath, { force: true });
    if (requiredToolCatalogIds.has("workspace-preview")) {
      throw new Error("workspace-preview-required-unavailable");
    }
    return null;
  }

  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];
  const codexConfigArgs: string[] = [];
  const runtimeEnv: Record<string, string> = {};
  let nativeBrowserBound = false;
  const preparedRows: Parameters<typeof registerPreparedMcpConfig>[0]["servers"] = [];
  const includedServerIds: string[] = [];
  const includedServers: NonNullable<McpConfigResult["includedServers"]> = [];
  let workspacePreviewCapabilityCleanup: (() => void) | undefined;
  let mcpChildWrapper: string | null = null;
  // A native browser guest must use a launcher generated by this checkout.
  // Keep the scope value-free and per config/run so it cannot collide with
  // the shared production launcher or another live invocation.
  const nativeBrowserLauncherScope = opts?.nativeBrowser
    ? `native-browser-${opts.configKey ?? randomUUID()}`
    : undefined;
  const callerChatId = opts?.toolGate?.chatId;
  const callerCwd = opts?.toolGate?.cwd;
  let canonicalCallerCwd: string | null = null;
  if (callerCwd) {
    try { canonicalCallerCwd = fs.realpathSync(callerCwd); } catch { canonicalCallerCwd = null; }
  }
  const ownerGrant = opts?.workspacePreviewOwnerGrant;
  const ownerGrantValid = Boolean(
    ownerGrant
    && ownerGrant.schemaVersion === "agentlas.workspace-preview-owner-grant.v1"
    && ownerGrant.ownerExecutionPermission === "full"
    && opts?.toolGate?.simulation !== true
    && ownerGrant.grantId.trim()
    && ownerGrant.chatId === callerChatId
    && ownerGrant.canonicalCwd === canonicalCallerCwd
    && path.isAbsolute(ownerGrant.canonicalCwd)
    && ownerGrant.runId.trim(),
  );
  const workspacePreviewBinding = callerChatId && callerCwd && canonicalCallerCwd
    ? {
        taskScopeId: ownerGrantValid ? ownerGrant!.taskScopeId : callerChatId,
        chatId: callerChatId,
        runId: ownerGrantValid ? ownerGrant!.runId : null,
        cwd: canonicalCallerCwd,
        permission: opts.toolGate?.permission ?? "read",
        ownerGrantId: ownerGrantValid ? ownerGrant!.grantId : null,
        ownerExecutionPermission: ownerGrantValid ? ("full" as const) : null,
      }
    : null;

  for (const s of serializedServers) {
    let preparedRuntimeRoot: string | null = null;
    if (s.catalogId === "agentlas-time" && !isCanonicalSystemTimeMcpServer(s)) {
      // Official built-ins never fall through to generic stdio/remote paths.
      continue;
    }
    if (s.catalogId === "cua-driver" && !isCanonicalComputerUseMcpServer(s)) {
      // The native input capability must never fall through to a mutable or
      // externally installed executable with the same catalog id.
      continue;
    }
    if (s.catalogId === "workspace-preview" && (!workspacePreviewBinding || !ownerGrantValid)) {
      // A preview capability is never global: Main must bind it to this run's
      // task, authorized cwd, and explicit owner-full grant before the MCP child
      // can see the tool. A worker's write permission alone cannot spawn a shell.
      continue;
    }
    if (s.catalogId === "workspace-preview" && !isAuthenticWorkspacePreviewMcpLaunch(s.command, s.args ?? [])) {
      // The Main control capability must never be handed to a mutable command
      // merely because an installed row claims the catalog id.
      continue;
    }
    // Re-check every required value immediately before serialization. A key can
    // be revoked after consent; that server is omitted instead of poisoning the
    // whole CLI bootstrap.
    const resolvedEnv = new Map<string, string>();
    let missingRequiredValue = false;
    for (const rawKey of s.envKeys) {
      const envKey = validateEnvKey(rawKey);
      const value = await readEnvVar(envKey);
      if (!value) {
        missingRequiredValue = true;
        break;
      }
      resolvedEnv.set(envKey, value);
    }
    if (missingRequiredValue) {
      /*
       * 선언된 키가 비었다고 무조건 빼면, OAuth로 이미 연결을 마친 서버가 사라진다.
       *
       * 허브 매니페스트는 그 서버를 수동 토큰으로 쓰는 길을 envKeys 로 적어 두는데,
       * 사용자가 OAuth로 연결했다면 그 칸은 영원히 빈 채로 남는다. 그 상태를 "값이
       * 없다"로 읽어 서버를 통째로 빼면, 사용자는 방금 로그인까지 마쳤는데 도구가
       * 안 붙는 일을 겪는다. 실제로 붙일 자격증명이 있는지로 판정한다.
       */
      const authorized = s.transport !== "stdio" && await resolveMcpOAuthAccessToken(s.id);
      if (!authorized) continue;
    }

    const key = mcpConfigKey(s);
    if (s.transport === "stdio" && s.command) {
      const browserRuntime = (shouldApplyAgentlasBrowserCdpOverride(s) || (opts?.nativeBrowser && isCanonicalAgentlasBrowserLauncher(s)))
        ? agentlasBrowserCdpRuntimeContract(nativeBrowserLauncherScope)
        : null;
      let command = resolveStdioCommand(s);
      let args = argsWithBrowserProfile(key, s.args ?? [], opts);
      args = argsWithToolGateWorkingFolder(s, args, opts);
      if (browserRuntime) {
        // The host-selected path is part of the browser isolation contract.
        // A QA process can use its own generated launcher without mutating the
        // production launcher persisted under ~/.agentlas.
        command = browserRuntime.command;
        args = browserRuntime.args;
      }
      let builtInEnv: Record<string, string> =
        s.catalogId === "agentlas-browser"
          ? {
              [BROWSER_APPROVAL_FILE_ENV]: browserApprovalInfoPath(),
              ...(browserRuntime?.env ?? {}),
              ...(browserRuntime && opts?.nativeBrowser ? { AGENTLAS_NATIVE_BROWSER_ENDPOINT: opts.nativeBrowser.endpoint } : {}),
              // Agent runs render their shared CDP page inside One's Browser
              // rail. Keep the automation host non-windowed; the explicit
              // Browser login action still uses browserOpenLogin's headful
              // dedicated-profile window when a person needs to authenticate.
              AGENTLAS_CDP_AUTO_STOP: "1",
              AGENTLAS_CDP_HEADLESS: "1",
            }
          : s.catalogId === "cua-driver"
            ? { [COMPUTER_USE_CONTROL_FILE_ENV]: computerUseControlInfoPath() }
            : {};
      if (s.catalogId === "workspace-preview" && workspacePreviewBinding) {
        try {
          const capability = await createWorkspacePreviewCapability(workspacePreviewBinding, opts?.configKey ?? key);
          const capabilityConfigKey = opts?.configKey ?? key;
          workspacePreviewCapabilityCleanup = () => {
            removeWorkspacePreviewCapabilityForConfig(capabilityConfigKey, capability.binding.capabilityId);
          };
          builtInEnv = { [WORKSPACE_PREVIEW_CONTROL_ENV]: capability.path };
        } catch (error) {
          console.warn("[workspace-preview] capability unavailable:", error);
          continue;
        }
      }
      if (s.catalogId === HEPHAESTUS_NETWORK_CATALOG_ID) {
        const launch = await resolveHephaestusStdioLaunch("agentlas_cloud", ["mcp", "serve"]);
        if (!launch) continue;
        command = launch.command;
        args = launch.args;
        preparedRuntimeRoot = launch.runtimeRoot;
        builtInEnv = Object.fromEntries(
          Object.entries(launch.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        );
      }
      const secretAliases: Record<string, string> = {};
      for (const rawKey of s.envKeys) {
        const envKey = validateEnvKey(rawKey);
        const value = resolvedEnv.get(envKey);
        if (!value) continue;
        const alias = mcpRuntimeSecretAlias(key, envKey);
        secretAliases[envKey] = alias;
        runtimeEnv[alias] = value;
      }
      if (browserRuntime && s.catalogId === "agentlas-browser" && opts?.nativeBrowser) {
        const alias = mcpRuntimeSecretAlias(key, "AGENTLAS_NATIVE_BROWSER_TOKEN");
        secretAliases.AGENTLAS_NATIVE_BROWSER_TOKEN = alias;
        runtimeEnv[alias] = opts.nativeBrowser.token;
        nativeBrowserBound = true;
      }
      const aliases = Object.values(secretAliases);
      if (
        aliases.length === 0 &&
        (isAuthenticSystemTimeMcpLaunch(command, args)
          || isAuthenticComputerUseMcpLaunch(command, args)
          || isAuthenticWorkspacePreviewMcpLaunch(command, args))
      ) {
        // The keyless built-in already has an exact, compressed in-memory
        // launch contract. Bypass the mutable per-run wrapper so no pathname is
        // re-opened between Agent App validation and runtime spawn.
        const inlineEnv = { ELECTRON_RUN_AS_NODE: "1", ...builtInEnv };
        mcpServers[key] = { command: process.execPath, args, env: inlineEnv };
        pushCodexConfig(codexConfigArgs, key, "command", tomlString(process.execPath));
        pushCodexConfig(codexConfigArgs, key, "args", tomlStringArray(args));
        pushCodexConfig(codexConfigArgs, key, "env", tomlInlineStringTable(inlineEnv));
      } else {
        mcpChildWrapper ??= ensureMcpChildEnvWrapper(dir);
        const wrapperArgs = [
          mcpChildWrapper,
          require.resolve("cross-spawn"),
          JSON.stringify(secretAliases),
          command,
          ...args,
        ];
        const wrapperEnv = {
          ELECTRON_RUN_AS_NODE: "1",
          ...builtInEnv,
          ...Object.fromEntries(aliases.map((alias) => [alias, envReference(alias)])),
        };
        /*
         * ★도구 관문을 우리가 소유한다 — 벤더 훅이 아니라.
         *
         * 실행 전 거절이 실제로 먹히는 곳은 벤더 CLI 의 PreToolUse 훅뿐인데, 그 훅은
         * claude 에만 배선돼 있고 어떤 벤더는 CLI 에서 아예 발화하지 않는다(실측:
         * cursor CLI 는 beforeMCPExecution 을 쏘지 않고, copilot 훅은 서브에이전트
         * 내부 호출에 안 걸린다). 남의 훅에 기대는 한 그 구멍은 못 막는다.
         *
         * 그래서 서버를 런타임에 직접 주지 않고 프록시를 준다. 누가 부르든 모든
         * tools/call 이 우리 프로세스를 지나고, 우리는 ACP·로컬 루프와 같은 중재자에게
         * 묻는다. 프록시를 붙이는 조건은 하나 — 승인 서버가 **실제로 떠 있을 때만**.
         * 관문 없는 프록시는 통과 파이프일 뿐이라 한 겹만 늘리는 손해다.
         */
        const proxied = mcpProxySpec(key, {
          command: process.execPath,
          args: wrapperArgs,
          env: wrapperEnv,
        }, opts, s.catalogId);
        mcpServers[key] = proxied ?? {
          command: process.execPath,
          args: wrapperArgs,
          env: wrapperEnv,
        };
        // External stdio MCPs launch through the least-privilege wrapper. The
        // child gets OS necessities and only its own mapped credentials, never
        // LLM auth or another MCP's opaque alias.
        pushCodexConfig(codexConfigArgs, key, "command", tomlString(process.execPath));
        pushCodexConfig(codexConfigArgs, key, "args", tomlStringArray(wrapperArgs));
        pushCodexConfig(
          codexConfigArgs,
          key,
          "env",
          tomlInlineStringTable({ ELECTRON_RUN_AS_NODE: "1", ...builtInEnv }),
        );
        if (aliases.length > 0) {
          pushCodexConfig(codexConfigArgs, key, "env_vars", tomlStringArray(aliases));
        }
      }
    } else if (s.url) {
      // Claude Code는 HTTP/SSE, 현재 Codex CLI는 Streamable HTTP URL을
      // 네이티브로 지원한다. Codex 0.144.1의 `codex mcp add --help` 계약에
      // 맞춰 legacy SSE와 임의 헤더 인증은 Claude-only로 둔다.
      // vault:// sentinel은 URL 전체가 credential이다. 실제 값은 keychain에서 읽어
      // runtimeEnv의 불투명 alias로만 옮기고, 설정 파일에는 `${ALIAS}` 참조를 쓴다.
      // Claude Code가 시작 시 자기 프로세스 env로 참조를 보간하므로 stdio vault
      // secret과 동일하게 파일/argv에는 값이 남지 않는다.
      const vaultKey = vaultUrlKey(s.url);
      let serializedUrl = s.url;
      if (vaultKey) {
        const rawUrl = resolvedEnv.get(vaultKey)?.trim();
        const resolvedUrl = rawUrl ? resolveVaultRemoteUrl(s, rawUrl) : null;
        if (!resolvedUrl) continue; // vault 값이 없거나 검증 실패면 서버를 싣지 않는다
        const alias = mcpRuntimeSecretAlias(key, vaultKey);
        runtimeEnv[alias] = resolvedUrl;
        serializedUrl = envReference(alias);
      }
      const headers: Record<string, string> = {};
      let codexBearerAlias: string | null = null;
      /*
       * OAuth로 연결한 서버의 토큰은 envKeys를 지나지 않는다.
       *
       * vault의 env 네임스페이스는 전역이라 키 이름이 곧 헤더 이름이다. 즉 서버 둘이
       * 모두 `Authorization`을 선언하면 같은 값을 나눠 갖게 된다 — 서로 다른 계정의
       * 토큰인데 말이다. OAuth 토큰은 서버 id로 격리된 시크릿에서 직접 읽어 여기서
       * 헤더로 만든다. 만료가 가까우면 이 호출 안에서 갱신되고, 갱신마저 실패하면
       * null이 와서 이 서버는 이번 실행에 실리지 않는다(만료 토큰으로 401을 맞아
       * 실행 도중 죽는 것보다 낫다).
       */
      const oauthAccessToken = await resolveMcpOAuthAccessToken(s.id);
      if (oauthAccessToken) {
        const alias = mcpRuntimeSecretAlias(key, "AUTHORIZATION");
        runtimeEnv[alias] = oauthAccessToken;
        headers.Authorization = `Bearer ${envReference(alias)}`;
        codexBearerAlias = alias;
      }
      // URL 자체의 vault 키는 헤더 자격증명이 아니므로 헤더 직렬화에서 제외한다.
      const headerKeys = s.envKeys.filter((headerKey) => headerKey !== vaultKey);
      // 선언된 헤더가 없는 원격 http 서버는 Codex가 표현할 수 있다. OAuth 토큰만 실린
      // 경우도 여기에 해당하고, 그때는 위에서 잡아 둔 codexBearerAlias 가 함께 나간다.
      let codexRemoteSupported = s.transport === "http" && headerKeys.length === 0;
      for (const rawHeader of headerKeys) {
        const header = validateEnvKey(rawHeader);
        const value = resolvedEnv.get(header);
        if (!value) {
          codexRemoteSupported = false;
          continue;
        }
        const alias = mcpRuntimeSecretAlias(key, header);
        const bearer = header.toLowerCase() === "authorization"
          ? value.match(/^Bearer\s+(.+)$/i)
          : null;
        if (bearer) {
          runtimeEnv[alias] = bearer[1];
          headers[header] = `Bearer ${envReference(alias)}`;
          if (s.transport === "http" && headerKeys.length === 1) {
            codexBearerAlias = alias;
            codexRemoteSupported = true;
          }
        } else {
          runtimeEnv[alias] = value;
          headers[header] = envReference(alias);
          // Codex exposes only bearer_token_env_var for remote MCPs. A single
          // raw token in Authorization is representable; arbitrary headers or
          // auth schemes remain Claude-only instead of starting broken.
          if (
            s.transport === "http" &&
            headerKeys.length === 1 &&
            header.toLowerCase() === "authorization" &&
            !/\s/.test(value)
          ) {
            codexBearerAlias = alias;
            codexRemoteSupported = true;
          } else {
            codexRemoteSupported = false;
          }
        }
      }
      // URL이 시크릿인 서버는 Claude-only로 남긴다: Codex는 `${VAR}` URL 보간이
      // 없고, -c argv에 실제 URL을 실으면 프로세스 목록으로 노출되기 때문이다.
      if (vaultKey) codexRemoteSupported = false;
      mcpServers[key] = {
        type: s.transport === "sse" ? "sse" : "http",
        url: serializedUrl,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      if (codexRemoteSupported) {
        pushCodexConfig(codexConfigArgs, key, "url", tomlString(s.url));
        if (codexBearerAlias) {
          pushCodexConfig(
            codexConfigArgs,
            key,
            "bearer_token_env_var",
            tomlString(codexBearerAlias),
          );
        }
      }
    } else {
      continue;
    }
    preparedRows.push({ configKey: key, server: s, transport: mcpServers[key], runtimeRoot: preparedRuntimeRoot });
    includedServerIds.push(s.id);
    includedServers.push({ serverId: s.id, catalogId: s.catalogId, configKey: key });
    allowedTools.push(`mcp__${key}`, `mcp__${key}__*`);
  }

  if (requiredToolCatalogIds.has("workspace-preview")
    && !includedServers.some((server) => server.catalogId === "workspace-preview")) {
    workspacePreviewCapabilityCleanup?.();
    fs.rmSync(configPath, { force: true });
    throw new Error("workspace-preview-required-unavailable");
  }

  // A graph may have declared a legacy custom key or the official Playwright
  // catalog id for the same browser capability. Keep each declaration
  // addressable, but point it at the one canonical config key above. The
  // duplicate process is never serialized or spawned, and aliases are emitted
  // only for explicit graph declarations.
  const canonicalEntry = includedServers.find((server) => server.catalogId === "agentlas-browser");
  if (canonicalEntry) {
    for (const [declaredId, server] of browserAliases) {
      if (!requiredToolCatalogIds.has(declaredId)) continue;
      includedServers.push({ serverId: server.id, catalogId: declaredId, configKey: canonicalEntry.configKey });
    }
  }

  if (Object.keys(mcpServers).length === 0) {
    workspacePreviewCapabilityCleanup?.();
    return null;
  }

  writePrivateFile(configPath, JSON.stringify({ mcpServers }, null, 2));
  const configurations = preparedRows.map(({ server }) => [server.id, mcpServerConfigurationDigest(server)] as const);
  registerPreparedMcpConfig({ path: configPath, servers: preparedRows, runtimeEnv, isCurrent: () => {
    const current = new Map(listInstalledServers().map((server) => [server.id, mcpServerConfigurationDigest(server)]));
    return configurations.every(([id, digest]) => current.get(id) === digest);
  } });
  return { configPath, allowedTools, codexConfigArgs, runtimeEnv, includedServerIds, includedServers,
    ...(workspacePreviewCapabilityCleanup ? { workspacePreviewCapabilityCleanup } : {}),
    ...(nativeBrowserBound ? { nativeBrowserBound: true as const } : {}) };
}
