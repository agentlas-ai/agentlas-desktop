// 실제 MCP 클라이언트 — @modelcontextprotocol/sdk로 외부 서버에 붙어 tools/list.
// 트랜스포트 3종: stdio(npx) / SSE(레거시 원격) / Streamable HTTP(현대 원격 표준).
// 시크릿은 keychain 글로벌 vault에서 읽어 stdio는 자식 env로, 원격은 HTTP 헤더로 주입.
//
// 현재 범위: 연결 테스트 + 툴 목록 조회(관리 화면용). 채팅 중 실제 tool-call 실행은
// 다음 단계(런너의 function-calling 루프 + CLI mcp.json 주입)로 분리.
import os from "node:os";
import { app } from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readEnvVar } from "../secrets/vault";
import { listInstalledServers, getServer } from "./registry";
import { withCliPath } from "../runtime/exec";
import {
  OPENCRAB_CATALOG_ID,
  validateOpenCrabMcpUrl,
  vaultUrlKey,
} from "../opencrab/constants";
import type { InstalledMcpServer, McpServerStatus } from "../../shared/types";

/** npx 첫 다운로드까지 고려한 넉넉한 연결 타임아웃. */
const CONNECT_TIMEOUT_MS = 45_000;
const MAX_REMOTE_URL_CHARS = 4_096;
const DEFAULT_TOOL_TEXT_LIMIT = 256_000;

function expandHome(arg: string): string {
  if (arg === "~") return os.homedir();
  if (arg.startsWith("~/")) return os.homedir() + arg.slice(1);
  return arg;
}

/** 서버가 요구하는 env 키를 vault에서 채워 { resolved, missing } 반환. */
async function resolveEnv(envKeys: string[]): Promise<{ resolved: Record<string, string>; missing: string[] }> {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  for (const k of envKeys) {
    const v = await readEnvVar(k);
    if (v) resolved[k] = v;
    else missing.push(k);
  }
  return { resolved, missing };
}

/**
 * 원격(sse/http) 서버의 envKeys→vault 값을 HTTP 요청 헤더로 매핑한다.
 * 헤더 이름은 envKey 그대로(예: `Authorization`), 값은 vault 값(예: `Bearer …`).
 * URL 경로에 토큰이 내장된 서버는 URL 자체를 vault에서 읽고 해당 키를 헤더에 넣지 않는다.
 */
function buildRemoteHeaders(
  envKeys: string[],
  resolved: Record<string, string>,
  urlVaultKey: string | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const k of envKeys) {
    // URL vault 포인터는 인증 헤더가 아니다. 원격 요청에 키 이름/URL을 중복 노출하지 않는다.
    if (k === urlVaultKey) continue;
    const v = resolved[k];
    if (v) headers[k] = v;
  }
  return headers;
}

function parseRemoteUrl(server: InstalledMcpServer, resolved: Record<string, string>): {
  url: URL;
  urlVaultKey: string | null;
} {
  if (!server.url) throw new Error("sse/http server has no url");
  const urlVaultKey = vaultUrlKey(server.url);
  if (urlVaultKey && !server.envKeys.includes(urlVaultKey)) {
    throw new Error("secure remote MCP endpoint is missing");
  }
  const raw = urlVaultKey ? resolved[urlVaultKey] : server.url;
  if (!raw) throw new Error("secure remote MCP endpoint is missing");
  if (raw.length > MAX_REMOTE_URL_CHARS) throw new Error("secure remote MCP endpoint is invalid");

  let url: URL;
  try {
    url = server.catalogId === OPENCRAB_CATALOG_ID ? validateOpenCrabMcpUrl(raw) : new URL(raw);
  } catch {
    // URL 파서 오류에는 입력값이 포함될 수 있으므로 원래 예외를 전달하지 않는다.
    throw new Error("secure remote MCP endpoint is invalid");
  }
  // Existing explicit custom URLs retain their current localhost/http support.
  // A vault-backed URL is credential material and must never use plaintext HTTP.
  if (urlVaultKey && (url.protocol !== "https:" || url.username || url.password)) {
    throw new Error("secure remote MCP endpoint is invalid");
  }
  return { url, urlVaultKey };
}

function redactResolvedSecrets(message: string, resolved: Record<string, string>): string {
  let safe = message;
  const candidates = new Set<string>();
  for (const value of Object.values(resolved)) {
    if (!value) continue;
    candidates.add(value);
    candidates.add(encodeURIComponent(value));
    try {
      const url = new URL(value);
      if (url.pathname.length >= 8) candidates.add(url.pathname);
      if (url.pathname.length >= 8) candidates.add(encodeURI(url.pathname));
      for (const segment of url.pathname.split("/")) {
        if (segment.length >= 8) {
          candidates.add(segment);
          candidates.add(encodeURIComponent(segment));
        }
      }
      for (const value of url.searchParams.values()) {
        if (value.length >= 8) candidates.add(value);
      }
    } catch {
      // 일반 env secret은 정확한 전체 값만 가린다.
    }
  }
  for (const candidate of [...candidates].sort((a, b) => b.length - a.length)) {
    safe = safe.split(candidate).join("[redacted]");
  }
  // OpenCrab URL 토큰이 서버 오류에 단독으로 반사되는 경우까지 막는다.
  return safe.replace(/ocm_[A-Za-z0-9_-]{12,}/g, "[redacted]");
}

/**
 * 트랜스포트 팩토리 — stdio / sse / http 분기를 한 곳에.
 * stdio는 resolved를 자식 env로, 원격은 HTTP 헤더로 주입한다.
 * http는 현대 표준인 Streamable HTTP로, sse만 레거시 SSE로 연결한다(예전엔 둘 다 SSE라
 * Streamable HTTP 전용 서버 연결이 깨졌다).
 */
function createTransport(server: InstalledMcpServer, resolved: Record<string, string>): unknown {
  if (server.transport === "stdio") {
    if (!server.command) throw new Error("stdio server has no command");
    const baseEnv = withCliPath({ ...getDefaultEnvironment(), PATH: process.env.PATH ?? "" });
    const stdioEnv = Object.fromEntries(
      Object.entries(baseEnv).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
    return new StdioClientTransport({
      command: expandHome(server.command),
      args: (server.args ?? []).map(expandHome),
      // getDefaultEnvironment()는 PATH/HOME 등 안전한 기본값 — 거기에 시크릿을 얹는다.
      env: { ...stdioEnv, ...resolved },
      stderr: "ignore",
    });
  }
  const { url, urlVaultKey } = parseRemoteUrl(server, resolved);
  const headers = buildRemoteHeaders(server.envKeys, resolved, urlVaultKey);
  const init = Object.keys(headers).length ? { requestInit: { headers } } : undefined;
  return server.transport === "sse"
    ? new SSEClientTransport(url, init)
    : new StreamableHTTPClientTransport(url, init);
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** 한 서버에 붙어 tools/list 해보고 상태 반환. 연결은 즉시 닫는다(테스트 전용). */
export async function testServerConnection(
  server: InstalledMcpServer,
  options?: { timeoutMs?: number },
): Promise<McpServerStatus> {
  const checkedAt = new Date().toISOString();
  const { resolved, missing } = await resolveEnv(server.envKeys);

  // 필수 env가 비어 있으면 굳이 spawn하지 않고 막힌 상태로 반환.
  if (missing.length > 0) {
    return { id: server.id, connected: false, tools: [], error: null, missingEnv: missing, checkedAt };
  }

  const client = new Client(
    { name: "agentlas-desktop", version: app.getVersion() },
    { capabilities: {} },
  );

  let transport: unknown;
  try {
    transport = createTransport(server, resolved);

    const timeoutMs = Math.max(250, Math.min(options?.timeoutMs ?? CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS));
    const tools = await withTimeout(
      (async () => {
        await client.connect(transport);
        const res = await client.listTools();
        return res.tools;
      })(),
      timeoutMs,
      () => {
        void client.close().catch(() => {});
      },
    );

    await client.close().catch(() => {});
    return { id: server.id, connected: true, tools, error: null, missingEnv: [], checkedAt };
  } catch (err) {
    await client.close().catch(() => {});
    const rawMessage = err instanceof Error ? err.message : String(err);
    const message = server.catalogId === OPENCRAB_CATALOG_ID
      ? "OpenCrab connection failed"
      : redactResolvedSecrets(rawMessage, resolved);
    return {
      id: server.id,
      connected: false,
      tools: [],
      error: message.slice(0, 300),
      missingEnv: missing,
      checkedAt,
    };
  }
}

/**
 * 한 서버에 붙어 tool 1개를 호출하고 텍스트 결과를 반환한다(폴 소스용, 설계 §3.4 Tier 1).
 * 매 폴마다 spawn→call→close하는 단발 호출이라 무겁지만, 폴 매니저의 적응형 간격이
 * 호출 빈도를 통제하므로(설계 §3.1) 유휴 비용은 0에 수렴한다. 필수 env 미충족이면 null.
 *
 * 반환은 MCP content의 text 조각을 이어붙인 문자열(구조화 파싱은 호출자가). 실패 시 throw.
 */
export async function callServerTool(
  server: InstalledMcpServer,
  toolName: string,
  args: Record<string, unknown>,
  options?: { timeoutMs?: number; maxTextChars?: number },
): Promise<string | null> {
  const { resolved, missing } = await resolveEnv(server.envKeys);
  if (missing.length > 0) return null; // 자격증명 미충족 — 폴 스킵(needsCredential UI가 안내).

  const client = new Client({ name: "agentlas-desktop", version: app.getVersion() }, { capabilities: {} });
  let transport: unknown;
  try {
    transport = createTransport(server, resolved);

    const timeoutMs = Math.max(250, Math.min(options?.timeoutMs ?? CONNECT_TIMEOUT_MS, CONNECT_TIMEOUT_MS));
    const maxTextChars = Math.max(1, Math.min(options?.maxTextChars ?? DEFAULT_TOOL_TEXT_LIMIT, DEFAULT_TOOL_TEXT_LIMIT));
    const text = await withTimeout(
      (async () => {
        await client.connect(transport);
        const res = (await client.callTool({ name: toolName, arguments: args })) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const parts = (res.content ?? [])
          .filter((c) => c && c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
        const joined = parts.join("\n");
        return joined.length > maxTextChars ? joined.slice(0, maxTextChars) : joined;
      })(),
      timeoutMs,
      () => {
        void client.close().catch(() => {});
      },
    );
    await client.close().catch(() => {});
    return text;
  } catch (err) {
    await client.close().catch(() => {});
    const rawMessage = err instanceof Error ? err.message : String(err);
    throw new Error(
      server.catalogId === OPENCRAB_CATALOG_ID
        ? "OpenCrab query failed"
        : redactResolvedSecrets(rawMessage, resolved),
    );
  }
}

export async function testServerById(id: string): Promise<McpServerStatus> {
  const server = getServer(id);
  if (!server) {
    return {
      id,
      connected: false,
      tools: [],
      error: "server not found",
      missingEnv: [],
      checkedAt: new Date().toISOString(),
    };
  }
  return testServerConnection(server);
}

/** 활성화된 모든 서버를 병렬로 점검. env 부족분만 빠르게 표시(연결 안 함). */
export async function statusAllServers(): Promise<McpServerStatus[]> {
  const servers = listInstalledServers().filter((s) => s.enabled);
  // 전부 동시에 spawn하면 무거우니 env 누락은 즉시, 나머지는 연결 점검.
  return Promise.all(servers.map((s) => testServerConnection(s)));
}
