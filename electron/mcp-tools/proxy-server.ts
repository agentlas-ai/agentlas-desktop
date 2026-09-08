// MCP 프록시 승인 서버 — 프록시 자식(proxy-child.cjs)이 도구 실행 직전에 때리는 엔드포인트.
//
// 판단은 새로 만들지 않는다. ACP·로컬 루프와 **같은 중재자 한 벌**
// (runtime/tool-approval.ts)이 답을 낸다 — 승인 정책이 표면마다 갈리면 사용자가
// 한 곳에서 거절한 것이 다른 곳에서 통과한다.
//
// 형태는 browser/approval-server.ts 선례를 따른다(127.0.0.1 임의 포트 + 토큰 +
// 인스턴스별 정보 파일). 다른 점은 하나뿐이다: 이쪽은 **모든 MCP 도구 호출**을 받는다.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mcpProxyControlInfoPath } from "./proxy-channel";
import {
  defaultRuntimeToolPermission,
  getRuntimeToolPermissionArbiter,
  type RuntimeToolPermissionAsk,
} from "../runtime/tool-approval";

let server: http.Server | null = null;
let boundPort = 0;
let token = "";

function readBody(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total <= maxBytes) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

interface ProxyApprovalRequest {
  /** 프록시가 대변하는 서버 키 — `mcp__<서버>__<도구>` 의 앞부분. */
  serverKey?: string;
  toolName?: string;
  sessionKey?: string;
  runtime?: string;
  permission?: RuntimeToolPermissionAsk["permission"];
  simulation?: boolean;
  cwd?: string;
  chatId?: string;
  unattended?: boolean;
  /** Registry identity resolved by Main for this exact stdio server. */
  catalogId?: string | null;
}

/*
 * Read permission must still be able to inspect the web.  MCP itself has no
 * standard mutation annotation, so the safe answer is an exact allowlist for
 * the one browser runtime Main owns.  Everything else remains mutating by
 * default.  In particular click/type/evaluate/replay are deliberately absent:
 * a simulation may load and inspect X without being able to like, post, upload,
 * or run page JavaScript.
 */
const AGENTLAS_BROWSER_READ_TOOLS = new Set([
  "browser_tabs",
  "browser_console_messages",
  "browser_find",
  "browser_hover",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_request",
  "browser_network_requests",
  "browser_snapshot",
  "browser_take_screenshot",
  "browser_wait_for",
  "browser_skill_list",
]);

export function mcpToolIsMutating(input: {
  catalogId?: string | null;
  toolName: string;
}): boolean {
  return !(
    input.catalogId === "agentlas-browser"
    && AGENTLAS_BROWSER_READ_TOOLS.has(input.toolName)
  );
}

/**
 * A simulation is already an explicit promise that external state will not be
 * changed. Asking the user to approve a mutating call at this point both breaks
 * that promise and leaves unattended graphs waiting forever. Deny it locally;
 * read-only browser inspection continues through the normal arbiter.
 */
export function mcpToolDeniedBySimulation(input: {
  simulation?: boolean;
  catalogId?: string | null;
  toolName: string;
}): boolean {
  return input.simulation === true && mcpToolIsMutating(input);
}

/**
 * 프록시 요청 하나를 중재자에게 묻는다. 중재자가 없거나 던지면 **거부**다 —
 * 실패가 허용으로 바뀌는 순간 이 관문은 없느니만 못하다(acp.ts·local-tool-loop 과 같은 규칙).
 */
async function decide(parsed: ProxyApprovalRequest): Promise<"allow" | "deny"> {
  const toolName = parsed.toolName?.trim();
  if (!toolName) return "deny";
  if (mcpToolDeniedBySimulation({
    simulation: parsed.simulation,
    catalogId: parsed.catalogId,
    toolName,
  })) return "deny";
  const serverKey = parsed.serverKey?.trim() || "mcp";
  const ask: RuntimeToolPermissionAsk = {
    runtime: parsed.runtime?.trim() || "mcp-proxy",
    sessionKey: parsed.sessionKey?.trim() || `mcp-proxy:${serverKey}`,
    // 사용자에게는 런타임이 부르는 이름 그대로 보여야 한다 — 승인 카드와 도구 목록의
    // 이름이 다르면 무엇을 허용하는지 알 수 없다.
    tool: `mcp__${serverKey}__${toolName}`,
    // MCP 도구 정의에는 표준 mutation 칸이 없다. Main이 소유한 정확한 브라우저
    // catalog만 위의 보수적 읽기 목록을 쓰고, 나머지는 전부 변이로 본다.
    kind: "other",
    cwd: parsed.cwd,
    permission: parsed.permission,
    mutating: mcpToolIsMutating({ catalogId: parsed.catalogId, toolName }),
    ...(parsed.chatId ? { chatId: parsed.chatId } : {}),
    ...(parsed.unattended ? { unattended: true as const } : {}),
  };
  const arbiter = getRuntimeToolPermissionArbiter();
  if (!arbiter) return defaultRuntimeToolPermission(ask) === "deny" ? "deny" : "allow";
  try {
    return (await arbiter(ask)) === "deny" ? "deny" : "allow";
  } catch {
    return "deny";
  }
}

export function startMcpProxyApprovalServer(): Promise<number> {
  if (server && boundPort) return Promise.resolve(boundPort);
  token = randomUUID();
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.method !== "POST" || !(req.url ?? "").startsWith("/approve")) {
        res.writeHead(404).end("not found");
        return;
      }
      if ((req.headers["authorization"] ?? "") !== `Bearer ${token}`) {
        res.writeHead(401).end("unauthorized");
        return;
      }
      void readBody(req).then(async (body) => {
        let parsed: ProxyApprovalRequest;
        try {
          parsed = JSON.parse(body) as ProxyApprovalRequest;
        } catch {
          // 형태를 모르는 요청은 통과가 아니라 거부다.
          res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ decision: "deny" }));
          return;
        }
        let decision: "allow" | "deny";
        try {
          decision = await decide(parsed);
        } catch {
          decision = "deny";
        }
        if (res.destroyed) return;
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ decision, ...(decision === "deny" ? { reason: "policy-denied" } : {}) }));
      });
    });

    srv.on("error", () => {
      server = null;
      boundPort = 0;
      resolve(0);
    });

    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      boundPort = typeof addr === "object" && addr ? addr.port : 0;
      server = srv;
      try {
        const infoPath = mcpProxyControlInfoPath();
        const infoDir = path.dirname(infoPath);
        fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
        try { fs.chmodSync(infoDir, 0o700); } catch { /* best-effort */ }
        const temp = `${infoPath}.${process.pid}.${randomUUID()}.tmp`;
        fs.writeFileSync(temp, JSON.stringify({ port: boundPort, token }), { mode: 0o600 });
        try { fs.chmodSync(temp, 0o600); } catch { /* best-effort */ }
        fs.renameSync(temp, infoPath);
      } catch {
        /* best-effort */
      }
      resolve(boundPort);
    });
  });
}

export function stopMcpProxyApprovalServer(): void {
  if (server) {
    try { server.close(); } catch { /* ignore */ }
  }
  server = null;
  boundPort = 0;
  try { fs.rmSync(mcpProxyControlInfoPath(), { force: true }); } catch { /* ignore */ }
}

/** 서버가 실제로 떠 있는가 — 프록시를 붙일지 결정하는 유일한 근거. */
export function mcpProxyApprovalPort(): number {
  return boundPort;
}
