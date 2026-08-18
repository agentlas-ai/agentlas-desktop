/**
 * 프로젝트에 지정한 리스트 → 실행 가능한 편성 스펙.
 *
 * 이 변환이 없던 것이 "지정한 에이전트가 아무 효과가 없다"의 실체였다. 리스트는
 * 시스템 프롬프트에 이름으로 적히기만 했고, 편성 후보 집합에는 어떤 경로로도 들어가지
 * 않았다. 그래서 실행은 항상 네트워크에서 새로 뽑는 쪽으로 갔다.
 *
 * 조회는 주입받는다 — 이 파일이 Electron 스토어에 직접 매이면 순수 검사가 불가능해지고,
 * 그러면 이 변환이 살아 있는지 확인하는 게이트를 쓸 수 없다. 배선을 검사할 수 없게 만드는
 * 구조가 바로 배선이 조용히 빠지는 이유다.
 */
import type { ProjectAgentPoolMember } from "./types";

export interface RosterSpecAgent {
  id: string;
  slug: string;
  name: string;
  /** 내부 역할 셀은 사용자가 고른 도구가 아니다. */
  userFacing: boolean;
}

export interface RosterSpecFirm {
  id: string;
  slug: string;
  name: string;
}

export interface RosterSpecLookup {
  agentById: (id: string) => RosterSpecAgent | null;
  firmById: (id: string) => RosterSpecFirm | null;
}

export interface ProjectRosterSpec {
  slug: string;
  name: string;
  directive: string;
  entityKind: "agent" | "team";
  source: "installed" | "firm";
  installedAgentId?: string;
  firmId?: string;
}

const DIRECTIVE = {
  ko: {
    agent: "이 프로젝트에 지정된 에이전트다. 이번 작업에서 맡을 부분을 수행하라.",
    team: "이 프로젝트에 지정된 팀이다. 이번 작업에서 맡을 부분을 수행하라.",
  },
  en: {
    agent: "An agent designated for this project. Take the part of this work that fits it.",
    team: "A team designated for this project. Take the part of this work that fits it.",
  },
} as const;

/**
 * 로컬에 실물이 있는 멤버만 스펙이 된다.
 *
 * 로컬 사본이 없는 Cloud/Hub 행은 대여·준비 단계를 거쳐야 실행할 수 있으므로 모집
 * 경로가 계속 소유한다. 여기서 억지로 스펙을 만들면 실행할 수 없는 대상을 편성해 놓고
 * 편성했다고 기록하는 것이 된다.
 */
export function projectRosterSpecs(
  pool: ProjectAgentPoolMember[],
  lookup: RosterSpecLookup,
  locale: "ko" | "en",
): ProjectRosterSpec[] {
  const specs: ProjectRosterSpec[] = [];
  const seen = new Set<string>();
  for (const member of Array.isArray(pool) ? pool : []) {
    if (member.entityKind === "team") {
      const firmId = member.firmId;
      if (!firmId || seen.has(`firm:${firmId}`)) continue;
      const firm = lookup.firmById(firmId);
      if (!firm) continue;
      seen.add(`firm:${firmId}`);
      specs.push({
        slug: firm.slug || firmId,
        name: firm.name || member.nameSnapshot,
        directive: DIRECTIVE[locale].team,
        entityKind: "team",
        source: "firm",
        firmId,
      });
      continue;
    }
    const agentId = member.agentId;
    if (!agentId || seen.has(`agent:${agentId}`)) continue;
    const installed = lookup.agentById(agentId);
    if (!installed || !installed.userFacing) continue;
    seen.add(`agent:${agentId}`);
    specs.push({
      slug: installed.slug || agentId,
      name: installed.name || member.nameSnapshot,
      directive: DIRECTIVE[locale].agent,
      entityKind: "agent",
      source: "installed",
      installedAgentId: agentId,
    });
  }
  return specs;
}
