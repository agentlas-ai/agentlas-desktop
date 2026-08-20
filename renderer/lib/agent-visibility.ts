import type { InstalledAgent } from "./types";

const SYSTEM_AGENT_RE =
  /(orchestrator|pm[\s-]?soul|memory[\s-]?curator|policy[\s-]?gate|eval[\s-]?qa|task[\s-]?bias|meta[\s-]?agent|app[\s-]?builder|marketplace[\s-]?packager|packager|governance)/i;

export function isUserFacingAgentText(name?: string | null, role?: string | null): boolean {
  return !SYSTEM_AGENT_RE.test(`${name ?? ""} ${role ?? ""}`);
}

export interface VisibleAgentOptions {
  /** 팀(멀티에이전트) 엔티티도 포함한다 — 에이전트 선택기처럼 팀을 골라야 하는 곳에서 true. */
  includeTeams?: boolean;
}

export function isVisibleAgent(agent: InstalledAgent, opts?: VisibleAgentOptions): boolean {
  if (agent.visibility === "background" || agent.visibility === "private") return false;
  if (!opts?.includeTeams && (agent.kind ?? "agent") === "team") return false;
  // Installed assets have an authoritative visibility column. Never hide a
  // user-owned agent merely because its chosen name contains "orchestrator",
  // "app builder", "governance", or another internal-looking word.
  return true;
}

export function visibleAgents(agents: InstalledAgent[], opts?: VisibleAgentOptions): InstalledAgent[] {
  return agents.filter((agent) => isVisibleAgent(agent, opts));
}

/**
 * 편집 중인 자동화가 **이미 쓰고 있는 대상**은 그 자동화의 편집기에서 빼지 않는다.
 *
 * ★실측 2026-08-21 (캠페인 E3 4단계): 말로 만든 그래프 자동화의 대상은 빌더가 붙인
 *   `builtin-agentlas-orchestrator` 이고, 그것은 `visibility: "background"` 라 이 목록에서
 *   걸러진다. 그래서 자기 편집기를 열면 자기 대상이 후보에 없고, 화면은
 *   "No valid target is selected" 를 띄우며 저장 버튼이 꺼진다 —
 *   **일정 하나 바꾸려면 실행 주체를 다른 것으로 바꿔야 한다.** 빌더가 만든 자동화 전부가
 *   이름·일정을 못 고치는 상태였고, 그래서 "10분마다 돌게 켜기"에 도달할 수가 없었다.
 *
 *   숨김 규칙은 **새로 고를 때**의 규칙이다. 이미 고른 것을 되돌려 보여 주는 것은 그 규칙과
 *   충돌하지 않는다 — 저장된 값이 사람의 선택이려면, 사람이 그것을 볼 수 있어야 한다.
 */
export function withCurrentTarget(
  visible: InstalledAgent[],
  all: InstalledAgent[],
  targetType: string | null | undefined,
  targetId: string | null | undefined,
): InstalledAgent[] {
  if (targetType !== "agent") return visible;
  const id = String(targetId ?? "").trim();
  if (!id || visible.some((agent) => agent.id === id)) return visible;
  const current = all.find((agent) => agent.id === id);
  return current ? [current, ...visible] : visible;
}
