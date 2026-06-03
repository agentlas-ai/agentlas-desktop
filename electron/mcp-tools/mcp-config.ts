// MCP -> 런타임 브리지. 설치·활성화된 MCP 서버를 런타임별 설정으로 직렬화한다.
// - Claude Code: `--mcp-config` JSON 파일
// - Codex CLI: `-c mcp_servers.<name>...` config overrides
// 값(시크릿)은 keychain vault에서 읽어 자식 env로 인라인.
//
// 이게 없으면 카탈로그의 Playwright(브라우저) 서버가 "설치"만 되고 채팅 중 호출되지 않았다.
// 이제 에이전트가 실제로 브라우저를 띄워 회원가입/로그인/키 발급을 대신 해줄 수 있다.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { app } from "electron";
import { ensureDefaultMcpPluginsInstalled } from "./defaults";
import { listInstalledServers } from "./registry";
import { readEnvVar } from "../secrets/vault";
import type { InstalledMcpServer } from "../../shared/types";

function expandHome(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/")) return os.homedir() + arg.slice(1);
  return arg;
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
  /** Codex CLI `exec`에 그대로 붙이는 runtime-local MCP config overrides. */
  codexConfigArgs: string[];
}

/**
 * 설치·활성 MCP 서버를 .mcp.json 으로 써서 경로를 반환. 서버가 하나도 없으면 null.
 * stdio 서버는 command/args/env, sse·http 서버는 type/url 형태로 직렬화한다.
 */
export async function buildMcpConfigFile(): Promise<McpConfigResult | null> {
  ensureDefaultMcpPluginsInstalled();
  const servers = listInstalledServers().filter((s) => s.enabled);
  if (servers.length === 0) return null;

  const mcpServers: Record<string, unknown> = {};
  const allowedTools: string[] = [];
  const codexConfigArgs: string[] = [];

  for (const s of servers) {
    const key = mcpKey(s);
    if (s.transport === "stdio" && s.command) {
      const env: Record<string, string> = {};
      for (const k of s.envKeys) {
        const v = await readEnvVar(k);
        if (v) env[k] = v;
      }
      mcpServers[key] = {
        command: s.command,
        args: (s.args ?? []).map(expandHome),
        ...(Object.keys(env).length ? { env } : {}),
      };
      pushCodexConfig(codexConfigArgs, key, "command", tomlString(s.command));
      pushCodexConfig(codexConfigArgs, key, "args", tomlStringArray((s.args ?? []).map(expandHome)));
      if (Object.keys(env).length > 0) {
        pushCodexConfig(codexConfigArgs, key, "env", tomlInlineStringTable(env));
      }
    } else if (s.url) {
      mcpServers[key] = { type: s.transport === "sse" ? "sse" : "http", url: s.url };
      pushCodexConfig(codexConfigArgs, key, "url", tomlString(s.url));
    } else {
      continue;
    }
    allowedTools.push(`mcp__${key}`);
  }

  if (Object.keys(mcpServers).length === 0) return null;

  const dir = path.join(app.getPath("userData"), "mcp");
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, "agentlas-mcp.json");
  fs.writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), "utf8");
  return { configPath, allowedTools, codexConfigArgs };
}
