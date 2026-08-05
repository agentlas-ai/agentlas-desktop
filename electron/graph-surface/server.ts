/**
 * 커넥터 C48 — 그래프를 **다른 에이전트가 부를 수 있는 도구**로 내놓는다.
 * 커넥터 C47 — 같은 표면이 SDK의 입구이기도 하다.
 *
 * n8n의 "Call n8n Workflow Tool"(ai_tool 커넥션)과 Dify의 "워크플로를 Tool로 발행"이
 * 같은 자리다. 둘 다 하는 일은 같다: 이미 있는 워크플로에 이름을 붙여 도구 목록에 올린다.
 *
 * ★전송은 stdio뿐이다. 포트를 열지 않는다.
 *   서버 표면을 여는 것은 보안 결정이고, 그 결정은 이 파일이 내릴 것이 아니다. stdio는
 *   부른 쪽이 이 프로세스를 직접 띄웠을 때만 닿는다 — 네트워크에서 도달할 방법이 없다.
 *   나중에 원격이 필요해지면 그때 인증·권한을 갖춰 별도로 연다.
 *
 * ★그리고 이 표면은 그래프를 **직접 돌리지 않는다**. 요청을 대기열에 적고, 실행은
 *   자동화를 소유한 프로세스가 한다(submit.ts 참고).
 */
import { GRAPH_WIRE } from "../../shared/graph-node-protocol";
import { listGraphsForSurface, submitGraphRunRequest } from "./submit";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export const GRAPH_SURFACE_TOOLS = [
  {
    name: "agentlas_list_graphs",
    description:
      "이 컴퓨터의 Agentlas 자동화(그래프) 목록. 꺼진 것도 함께 나온다 — 감추면 부른 쪽이 "
      + "\"없는 자동화\"라는 잘못된 사유를 받는다.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "agentlas_run_graph",
    description:
      "이름 또는 id로 자동화 하나를 실행 요청한다. 실행은 Agentlas가 하고, 이 도구는 요청이 "
      + "접수됐는지만 돌려준다. 켤 수 없으면 코드·사유·다음 행동을 그대로 돌려준다.",
    inputSchema: {
      type: "object",
      properties: {
        ref: { type: "string", description: "자동화 이름 또는 id. id가 정본이다." },
        input: {
          type: "object",
          description: "시작할 때 값을 받는 자동화라면 그 값. 어떤 이름인지는 거절 사유가 알려준다.",
          additionalProperties: { type: "string" },
        },
        dryRun: { type: "boolean", description: "시뮬레이션으로 돌린다 — 바깥을 바꾸는 단계는 호출하지 않는다." },
      },
      required: ["ref"],
      additionalProperties: false,
    },
  },
] as const;

/** 한 요청을 처리한다. 전송(stdio)과 분리해 둬야 게이트가 이 함수만 불러 계약을 잴 수 있다. */
export function handleGraphSurfaceRequest(req: JsonRpcRequest): Record<string, unknown> | null {
  const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: req.id ?? null, result });
  switch (req.method) {
    case "initialize": {
      // 커넥터 C39 — 판 맞추기. 지금까지 두 표면(데스크탑·터미널)은 같은 SQLite를 공유해
      // 전송 채널이 없었고, 그래서 협상 대신 강등(C24)으로 같은 문제를 풀었다. SDK는 다르다:
      // 별도 아티팩트라 앱보다 오래된 판일 수 있다. 그때 조용히 진행하면, 부른 쪽이 모르는
      // 모양의 답을 받아 자기 코드가 고장 난 것으로 읽는다.
      const asked = String(req.params?.wire ?? GRAPH_WIRE);
      const askedMajor = asked.split("/")[1] ?? "";
      if (askedMajor !== GRAPH_WIRE.split("/")[1]) {
        return {
          jsonrpc: "2.0" as const,
          id: req.id ?? null,
          error: {
            code: -32600,
            message: `SCHEMA_UNSUPPORTED_MAJOR: 이 Agentlas는 ${GRAPH_WIRE}로 말합니다 (요청: ${asked}). `
              + "SDK와 Agentlas 중 오래된 쪽을 올려 주세요.",
          },
        };
      }
      return reply({
        protocolVersion: "2024-11-05",
        wire: GRAPH_WIRE,
        capabilities: { tools: {} },
        serverInfo: { name: "agentlas-graphs", version: "1" },
      });
    }
    case "notifications/initialized":
      return null;
    case "tools/list":
      return reply({ tools: GRAPH_SURFACE_TOOLS });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      if (name === "agentlas_list_graphs") {
        return reply({
          content: [{ type: "text", text: JSON.stringify(listGraphsForSurface(), null, 2) }],
        });
      }
      if (name === "agentlas_run_graph") {
        const outcome = submitGraphRunRequest({
          ref: String(args.ref ?? ""),
          ...(args.input && typeof args.input === "object"
            ? { input: args.input as Record<string, unknown> }
            : {}),
          ...(args.dryRun === true ? { dryRun: true } : {}),
          source: "mcp",
        });
        // ★거절도 성공한 도구 호출이다 — isError로 감싸면 부른 에이전트는 사유를 못 읽고
        //   "도구가 고장 났다"로 처리한다. 사유·행동을 그대로 본문에 싣는다.
        return reply({
          content: [{ type: "text", text: JSON.stringify(outcome, null, 2) }],
          ...(outcome.ok ? {} : { isError: false }),
        });
      }
      return {
        jsonrpc: "2.0" as const,
        id: req.id ?? null,
        error: { code: -32601, message: `unknown tool: ${name}` },
      };
    }
    default:
      return {
        jsonrpc: "2.0" as const,
        id: req.id ?? null,
        error: { code: -32601, message: `unknown method: ${req.method}` },
      };
  }
}

/** stdio 전송. 줄 단위 JSON — 부른 쪽이 이 프로세스를 띄웠을 때만 닿는다. */
export function serveGraphSurfaceOverStdio(): void {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (!line) continue;
      try {
        const response = handleGraphSurfaceRequest(JSON.parse(line) as JsonRpcRequest);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (err) {
        process.stdout.write(`${JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
        })}\n`);
      }
    }
  });
}
