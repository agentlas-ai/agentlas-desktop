// MCP -> 런타임 브리지. 설치·활성화된 MCP 서버를 런타임별 설정으로 직렬화한다.
// - Claude Code: `--mcp-config` JSON 파일 (vault 값은 `${ENV_ALIAS}` 참조만 기록)
// - Codex CLI: `-c mcp_servers.<name>...` config overrides (시크릿 값 없는 이름/경로만 전달)
// 값(시크릿)은 keychain vault에서 읽어 런타임 env의 불투명 alias로만 전달한다. Codex MCP는
// 작은 wrapper가 alias를 원래 키로 되돌린 뒤 서버를 spawn해, LLM CLI 인증 env와도 충돌하지 않는다.
//
// 이게 없으면 카탈로그의 Playwright(브라우저) 서버가 "설치"만 되고 채팅 중 호출되지 않았다.
// 이제 에이전트가 실제로 브라우저를 띄워 회원가입/로그인/키 발급을 대신 해줄 수 있다.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { app } from "electron";
import { ensureDefaultMcpPluginsInstalled } from "./defaults";
import { listInstalledServers } from "./registry";
import { readEnvVar } from "../secrets/vault";
import {
  OPENCRAB_CATALOG_ID,
  isOpenCrabCredentialUrl,
  isVaultBackedRemoteUrl,
} from "../opencrab/constants";
import type { InstalledMcpServer } from "../../shared/types";

function expandHome(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/")) return os.homedir() + arg.slice(1);
  return arg;
}

function bundledComputerUseClient(): string | null {
  const candidates = [
    path.join(
      os.homedir(),
      ".codex",
      "computer-use",
      "Codex Computer Use.app",
      "Contents",
      "SharedSupport",
      "SkyComputerUseClient.app",
      "Contents",
      "MacOS",
      "SkyComputerUseClient",
    ),
    "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function resolveStdioCommand(s: InstalledMcpServer): string {
  const command = expandHome(s.command ?? "");
  if (s.catalogId === "cua-driver" && (command === "cua-driver" || !fs.existsSync(command))) {
    return bundledComputerUseClient() ?? command;
  }
  return command;
}

/** MCP tool 이름 mcp__<key>__<tool> 의 key — 안전한 슬러그. */
function mcpKey(s: InstalledMcpServer): string {
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
  configPath: string;
  /** ["mcp__playwright", ...] — write/full 권한에서 --allowedTools 자동 승인용. */
  allowedTools: string[];
  /** Codex CLI `exec`에 그대로 붙이는 runtime-local MCP config overrides. 시크릿 값은 포함하지 않는다. */
  codexConfigArgs: string[];
  /** CLI 부모 환경에만 넣는 불투명 alias -> vault 값. 설정 파일/argv에는 값이 기록되지 않는다. */
  runtimeEnv: Record<string, string>;
}

export interface McpConfigBuildOptions {
  /** Playwright MCP persistent profile key. Used by automations to avoid sharing the interactive browser profile lock. */
  browserProfileKey?: string;
  /** When present, serialize only these selected catalog ids for the current run. */
  catalogIds?: string[];
}

function safeProfileKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "default";
}

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_ALIAS_PREFIX = "AGENTLAS_MCP_SECRET_";

function validateEnvKey(value: string): string {
  const key = value.trim();
  if (!ENV_KEY_RE.test(key)) throw new Error(`Invalid MCP environment key: ${value}`);
  return key;
}

function secretAlias(serverKey: string, envKey: string): string {
  const digest = createHash("sha256").update(serverKey).update("\0").update(envKey).digest("hex");
  return `${SECRET_ALIAS_PREFIX}${digest.slice(0, 32).toUpperCase()}`;
}

function envReference(alias: string): string {
  return `\${${alias}}`;
}

const CODEX_SECRET_WRAPPER = `"use strict";
const crossSpawn = require(process.argv[2]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
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

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
for (const [targetKey, alias] of Object.entries(mapping)) {
  if (!ENV_KEY_RE.test(targetKey) || typeof alias !== "string" || !alias.startsWith("${SECRET_ALIAS_PREFIX}")) {
    process.stderr.write("Agentlas MCP secret wrapper rejected an invalid environment mapping.\\n");
    process.exit(78);
  }
  const value = process.env[alias];
  if (typeof value !== "string" || value.length === 0) {
    process.stderr.write("Agentlas MCP secret wrapper is missing a required vault value.\\n");
    process.exit(78);
  }
  env[targetKey] = value;
  delete env[alias];
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
  const dir = path.join(app.getPath("userData"), "mcp");
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

function ensureCodexSecretWrapper(dir: string): string {
  const wrapperPath = path.join(dir, "codex-mcp-secret-wrapper.cjs");
  writePrivateFile(wrapperPath, CODEX_SECRET_WRAPPER);
  return wrapperPath;
}

function argsWithBrowserProfile(key: string, args: string[], opts?: McpConfigBuildOptions): string[] {
  if (key !== "playwright" || !opts?.browserProfileKey) return args;
  const profileDir = path.join(app.getPath("userData"), "mcp", "browser-profiles", safeProfileKey(opts.browserProfileKey));
  fs.mkdirSync(profileDir, { recursive: true });
  const next = args.slice();
  const flagIndex = next.findIndex((arg) => arg === "--user-data-dir" || arg.startsWith("--user-data-dir="));
  if (flagIndex < 0) return [...next, "--user-data-dir", profileDir];
  if (next[flagIndex] === "--user-data-dir") {
    next[flagIndex + 1] = profileDir;
  } else {
    next[flagIndex] = `--user-data-dir=${profileDir}`;
  }
  return next;
}

/**
 * 설치·활성 MCP 서버를 .mcp.json 으로 써서 경로를 반환. 서버가 하나도 없으면 null.
 * stdio 서버는 command/args/env, sse·http 서버는 type/url 형태로 직렬화한다.
 * opts.catalogIds가 있으면 자동 선택된 도구만 직렬화한다. 예: computer-use 모드에서는
 * Playwright가 설치돼 있어도 config/allowedTools에 싣지 않아 브라우저 우회를 막는다.
 */
export async function buildMcpConfigFile(opts?: McpConfigBuildOptions): Promise<McpConfigResult | null> {
  ensureDefaultMcpPluginsInstalled();
  const dir = path.join(app.getPath("userData"), "mcp");
  const configPath = path.join(dir, "agentlas-mcp.json");
  ensurePrivateDir(dir);
  const scopedCatalogIds = opts?.catalogIds ? new Set(opts.catalogIds.filter(Boolean)) : null;
  const servers = listInstalledServers().filter((s) => {
    if (!s.enabled) return false;
    // URL 경로 자체가 credential인 서버는 Desktop main process 전용이다. Claude/Codex
    // 설정 파일이나 -c argv로 내보내면 Keychain 경계를 우회하게 되므로 항상 제외한다.
    if (
      s.catalogId === OPENCRAB_CATALOG_ID ||
      isVaultBackedRemoteUrl(s.url) ||
      isOpenCrabCredentialUrl(s.url)
    ) return false;
    if (!scopedCatalogIds) return true;
    return Boolean((s.catalogId && scopedCatalogIds.has(s.catalogId)) || scopedCatalogIds.has(s.id));
  });
  if (servers.length === 0) {
    // 구버전이 0644 JSON에 남긴 vault 평문을 선택 결과가 0개인 실행에서도 방치하지 않는다.
    fs.rmSync(configPath, { force: true });
    return null;
  }

  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];
  const codexConfigArgs: string[] = [];
  const runtimeEnv: Record<string, string> = {};
  let codexSecretWrapper: string | null = null;

  for (const s of servers) {
    const key = mcpKey(s);
    if (s.transport === "stdio" && s.command) {
      const command = resolveStdioCommand(s);
      const claudeEnv: Record<string, string> = {};
      const secretAliases: Record<string, string> = {};
      for (const rawKey of s.envKeys) {
        const envKey = validateEnvKey(rawKey);
        const value = await readEnvVar(envKey);
        if (!value) continue;
        const alias = secretAlias(key, envKey);
        claudeEnv[envKey] = envReference(alias);
        secretAliases[envKey] = alias;
        runtimeEnv[alias] = value;
      }
      const args = argsWithBrowserProfile(key, (s.args ?? []).map(expandHome), opts);
      mcpServers[key] = {
        command,
        args,
        ...(Object.keys(claudeEnv).length ? { env: claudeEnv } : {}),
      };
      const aliases = Object.values(secretAliases);
      if (aliases.length === 0) {
        pushCodexConfig(codexConfigArgs, key, "command", tomlString(command));
        pushCodexConfig(codexConfigArgs, key, "args", tomlStringArray(args));
      } else {
        codexSecretWrapper ??= ensureCodexSecretWrapper(dir);
        const wrapperArgs = [
          require.resolve("cross-spawn"),
          JSON.stringify(secretAliases),
          command,
          ...args,
        ];
        // Codex는 `${VAR}` 보간을 지원하지 않는다. env_vars로 alias 값만 MCP wrapper에
        // 전달하고 wrapper가 원래 키로 복원한다. 따라서 vault 값은 `-c` argv에 없다.
        pushCodexConfig(codexConfigArgs, key, "command", tomlString(process.execPath));
        pushCodexConfig(codexConfigArgs, key, "args", tomlStringArray([codexSecretWrapper, ...wrapperArgs]));
        pushCodexConfig(
          codexConfigArgs,
          key,
          "env",
          tomlInlineStringTable({ ELECTRON_RUN_AS_NODE: "1" }),
        );
        pushCodexConfig(codexConfigArgs, key, "env_vars", tomlStringArray(aliases));
      }
    } else if (s.url) {
      // Claude Code는 HTTP/SSE, 현재 Codex CLI는 Streamable HTTP URL을
      // 네이티브로 지원한다. Codex 0.144.1의 `codex mcp add --help` 계약에
      // 맞춰 legacy SSE와 임의 헤더 인증은 Claude-only로 둔다.
      const headers: Record<string, string> = {};
      let codexBearerAlias: string | null = null;
      let codexRemoteSupported = s.transport === "http" && s.envKeys.length === 0;
      for (const rawHeader of s.envKeys) {
        const header = validateEnvKey(rawHeader);
        const value = await readEnvVar(header);
        if (!value) {
          codexRemoteSupported = false;
          continue;
        }
        const alias = secretAlias(key, header);
        const bearer = header.toLowerCase() === "authorization"
          ? value.match(/^Bearer\s+(.+)$/i)
          : null;
        if (bearer) {
          runtimeEnv[alias] = bearer[1];
          headers[header] = `Bearer ${envReference(alias)}`;
          if (s.transport === "http" && s.envKeys.length === 1) {
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
            s.envKeys.length === 1 &&
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
      mcpServers[key] = {
        type: s.transport === "sse" ? "sse" : "http",
        url: s.url,
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
    allowedTools.push(`mcp__${key}`, `mcp__${key}__*`);
  }

  if (Object.keys(mcpServers).length === 0) return null;

  writePrivateFile(configPath, JSON.stringify({ mcpServers }, null, 2));
  return { configPath, allowedTools, codexConfigArgs, runtimeEnv };
}
