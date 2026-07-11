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
import type { InstalledMcpServer, McpServerStatus } from "../../shared/types";

/** npx 첫 다운로드까지 고려한 넉넉한 연결 타임아웃. */
const CONNECT_TIMEOUT_MS = 45_000;

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
 * URL 경로에 토큰이 내장된 서버(예: opencrab)는 envKeys가 비어 헤더도 없이 붙는다.
 */
function buildRemoteHeaders(envKeys: string[], resolved: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const k of envKeys) {
    const v = resolved[k];
    if (v) headers[k] = v;
  }
  return headers;
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
  if (!server.url) throw new Error("sse/http server has no url");
  const url = new URL(server.url);
  const headers = buildRemoteHeaders(server.envKeys, resolved);
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
export async function testServerConnection(server: InstalledMcpServer): Promise<McpServerStatus> {
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

    const tools = await withTimeout(
      (async () => {
        await client.connect(transport);
        const res = await client.listTools();
        return res.tools;
      })(),
      CONNECT_TIMEOUT_MS,
      () => {
        void client.close().catch(() => {});
      },
    );

    await client.close().catch(() => {});
    return { id: server.id, connected: true, tools, error: null, missingEnv: [], checkedAt };
  } catch (err) {
    await client.close().catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
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
): Promise<string | null> {
  const { resolved, missing } = await resolveEnv(server.envKeys);
  if (missing.length > 0) return null; // 자격증명 미충족 — 폴 스킵(needsCredential UI가 안내).

  const client = new Client({ name: "agentlas-desktop", version: app.getVersion() }, { capabilities: {} });
  let transport: unknown;
  try {
    transport = createTransport(server, resolved);

    const text = await withTimeout(
      (async () => {
        await client.connect(transport);
        const res = (await client.callTool({ name: toolName, arguments: args })) as {
          content?: Array<{ type?: string; text?: string }>;
        };
        const parts = (res.content ?? [])
          .filter((c) => c && c.type === "text" && typeof c.text === "string")
          .map((c) => c.text as string);
        return parts.join("\n");
      })(),
      CONNECT_TIMEOUT_MS,
      () => {
        void client.close().catch(() => {});
      },
    );
    await client.close().catch(() => {});
    return text;
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
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
