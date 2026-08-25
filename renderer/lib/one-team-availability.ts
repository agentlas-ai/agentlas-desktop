import type { OneOrgMember, OneOrgState } from "@shared/one-org";

/**
 * 지금 실제로 말할 수 있는 팀원인가.
 *
 * ★ 이 판정은 한 벌만 존재해야 한다. 아바타를 회색으로 칠하는 자리와 인원수를 세는 자리가
 * 서로 다른 근거를 쓰고 있었기 때문에, 한 명이 나가면 **아바타만 회색이 되고 머릿수는 그대로**
 * 남았다("1명 나갔는데 왜 아직 3명인가" — UX-D-7). 회색으로 칠하는 바로 그 조건으로 세면
 * 두 표시가 어긋날 수 없다.
 *
 * 명단(`memberAgentIds`) 자체는 나간 사람을 지우지 않는다 — 그건 의도다(정직한 회색 인계를
 * 위해 자리에 남긴다, `shared/one-taskforces.ts`). 그래서 "명단 길이"는 인원수가 아니다.
 */
export function memberUnavailable(member: OneOrgMember | undefined): boolean {
  return !member
    || Boolean(member.archivedAt)
    || member.statusKind === "locked"
    || member.statusKind === "failed";
}

function memberFor(org: OneOrgState | null | undefined, agentId: string): OneOrgMember | undefined {
  return org?.members.find((item) => item.installedAgentId === agentId);
}

/** 명단 중 지금 말할 수 있는 사람 수(One 제외). */
export function availableMemberCount(
  memberAgentIds: readonly string[],
  org: OneOrgState | null | undefined,
): number {
  return memberAgentIds.filter((agentId) => !memberUnavailable(memberFor(org, agentId))).length;
}

/** 명단 중 나갔거나 실행할 수 없는 사람 수. */
export function unavailableMemberCount(
  memberAgentIds: readonly string[],
  org: OneOrgState | null | undefined,
): number {
  return memberAgentIds.filter((agentId) => memberUnavailable(memberFor(org, agentId))).length;
}

/** 화면에 적는 "One 포함 N명" 의 N — One + 지금 말할 수 있는 팀원. */
export function speakableCountIncludingOne(
  memberAgentIds: readonly string[],
  org: OneOrgState | null | undefined,
): number {
  return availableMemberCount(memberAgentIds, org) + 1;
}
