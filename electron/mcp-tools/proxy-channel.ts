// MCP 프록시 승인 채널 — 프록시 자식이 도구 실행 직전에 이 로컬 엔드포인트로 물어본다.
//
// ★왜 필요한가. 도구 호출을 실제로 막는 유일한 지점은 벤더 CLI 의 PreToolUse 훅인데,
// 그 훅은 벤더마다 다르고 어떤 벤더는 CLI 에서 아예 발화하지 않는다(실측: cursor CLI 는
// beforeMCPExecution 을 쏘지 않고, copilot 은 서브에이전트 내부 호출에 훅이 안 걸린다).
// 남의 훅에 기대는 한 그 구멍은 우리가 못 막는다.
//
// 그래서 기대를 접는다. MCP 서버를 런타임에 **직접** 넘기지 않고 우리 프록시를 넘기면,
// 누가 부르든(에이전트든 서브에이전트든) 모든 도구 호출이 우리 프로세스를 지난다.
// 훅이 없어도, 훅이 죽어도, 벤더가 이벤트를 안 쏴도 경계는 유지된다.
//
// 채널 형태는 browser/approval-server.ts 선례를 그대로 따른다: 127.0.0.1 임의 포트 +
// 토큰, 정보 파일은 인스턴스별 userData 아래. 설치본과 개발본이 같이 떠도 서로의
// 포트·승인 창을 덮어쓰지 않는다.
import path from "node:path";
import { app } from "electron";

export const MCP_PROXY_CONTROL_FILE_ENV = "AGENTLAS_MCP_PROXY_CONTROL";
/** 프록시가 감쌀 실제 서버 스펙(JSON)을 담는 환경변수. */
export const MCP_PROXY_TARGET_ENV = "AGENTLAS_MCP_PROXY_TARGET";
/** 이 프록시가 대변하는 서버 키 — 승인 카드에 "무엇의 도구인지" 를 보이기 위해. */
export const MCP_PROXY_SERVER_KEY_ENV = "AGENTLAS_MCP_PROXY_SERVER_KEY";
/** 이 실행의 승인 세션 키 — 같은 대화의 "이번 세션 동안 허용"이 물려지도록. */
export const MCP_PROXY_SESSION_ENV = "AGENTLAS_MCP_PROXY_SESSION";
/**
 * 이 노드의 도구 중개 계획 파일. 프록시가 사람에게 묻기 **전에** 이걸로 먼저 거른다 —
 * 그래프가 선언하지 않은 도구는 승인 대상이 아니라 애초에 없는 것이다.
 */
export const MCP_PROXY_PLAN_ENV = "AGENTLAS_MCP_PROXY_PLAN";

export function mcpProxyControlInfoPath(): string {
  return path.join(app.getPath("userData"), "mcp", "proxy-control.json");
}
