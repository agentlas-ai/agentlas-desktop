import { judgeSubsetViaBridge } from "@/lib/judgment";
import {
  buildProjectHubRecommendationQuery,
  buildProjectHubRecommendations,
  type ProjectRosterCandidate,
  type ProjectRosterSection,
} from "@/lib/project-agent-roster";
import type { Locale } from "@/lib/i18n";
import type { HubAgentBookmark, MarketplaceListing, ProjectAgentPoolMember } from "@/lib/types";
import {
  PROJECT_TEAM_ROLE_FILL_JUDGMENT,
  PROJECT_TEAM_ROLE_LABELS,
  PROJECT_TEAM_ROLES_JUDGMENT,
  type ProjectTeamRole,
} from "@shared/project-team-recommendation";

/*
 * Work 자동 팀 추천(PLAN §6).
 *
 *  1. 메뉴: 로컬 설치본 → 내 Cloud → Hub 북마크 → Hub 검색(프로젝트 이름·목표로)
 *     순서. 기존 카탈로그 빌더(buildProjectRosterSections·buildProjectHubRecommendations)
 *     를 그대로 쓴다 — 이 화면만의 세 번째 식별 규칙을 만들지 않는다.
 *  2. 역할: 판정 서비스가 고정 어휘에서 1~4개를 고른다.
 *  3. 역할마다 판정 서비스가 메뉴에서 0~2개를 고른다(병렬).
 *
 * 추천은 제안일 뿐이다. 저장은 사람이 확인한 뒤 ProjectSettingsModal 의 기존 저장
 * 한 번으로만 일어난다. 가격은 메뉴에 넣지 않는다(Work 에이전트 무료 정책).
 */

export type AutoTeamRunnable = "ready" | "install_on_first_run" | "access_unverified";

export interface AutoTeamPick {
  role: ProjectTeamRole;
  candidate: ProjectRosterCandidate;
  /** Hub 검색 결과에서 왔다면 원본 행(북마크 저장에 필요). */
  listing: MarketplaceListing | null;
  bookmarked: boolean;
  runnable: AutoTeamRunnable;
  /** 후보가 공개한 능력 설명 + 역할 판정 이유. */
  reason: string;
  /** 이미 프로젝트에 붙어 있음. */
  alreadyInPool: boolean;
  /** 앞 역할에서 같은 후보가 이미 추천됨. */
  duplicateOfRole: ProjectTeamRole | null;
}

export interface AutoTeamRecommendation {
  roles: ProjectTeamRole[];
  picks: AutoTeamPick[];
  /** 불러오지 못한 출처 — 0개와 구분해 화면에 적는다. */
  failedSources: Array<"cloud" | "hub" | "hub-search">;
  rolesWithoutCandidate: ProjectTeamRole[];
}

export class AutoTeamError extends Error {
  constructor(readonly code: "judgment_unavailable" | "low_confidence" | "no_candidates") {
    super(code);
  }
}

interface MenuRow {
  label: string;
  candidate: ProjectRosterCandidate;
  listing: MarketplaceListing | null;
  bookmarked: boolean;
  capability: string;
}

function aliases(candidate: ProjectRosterCandidate): string[] {
  return (candidate.identityAliases?.length ? candidate.identityAliases : [candidate.member.targetId])
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function identityKeys(candidate: ProjectRosterCandidate): string[] {
  return aliases(candidate).map((alias) => `${candidate.member.entityKind}:${alias}`);
}

export function candidateInPool(candidate: ProjectRosterCandidate, pool: ProjectAgentPoolMember[]): boolean {
  const own = new Set(aliases(candidate));
  return pool.some((member) => member.source === candidate.member.source
    && member.entityKind === candidate.member.entityKind
    && own.has(member.targetId.trim().toLowerCase()));
}

function runnableOf(candidate: ProjectRosterCandidate): AutoTeamRunnable {
  if (candidate.installed) return "ready";
  // 내 Cloud 의 호출형(cloud-callable) 행은 설치 없이 실행 때마다 정확한 릴리스를 준비해
  // 바로 돈다(실측 2026-09-26: 솔로 턴 hephaestus_call cloud:growth-hacker, 목표 턴
  // "프로젝트 지정 1명으로 편성" 둘 다 완주). 설치형(install-only) Cloud 행만 준비가 남는다.
  // Hub 공개 행은 첫 실행 때 접근이 실제로 확인되기 전까지 "확인 필요"다.
  if (candidate.source === "cloud") return candidate.remoteCallable === false ? "install_on_first_run" : "ready";
  return "access_unverified";
}

export function buildAutoTeamMenu(
  sections: ProjectRosterSection[],
  hubSearch: { listings: MarketplaceListing[]; bookmarks: HubAgentBookmark[] } | null,
  locale: Locale,
  max = 60,
): MenuRow[] {
  const rows: MenuRow[] = [];
  const seen = new Set<string>();
  const push = (candidate: ProjectRosterCandidate, listing: MarketplaceListing | null, bookmarked: boolean, capability: string) => {
    if (!candidate.callable || rows.length >= max) return;
    const keys = identityKeys(candidate);
    if (keys.some((key) => seen.has(key))) return;
    keys.forEach((key) => seen.add(key));
    rows.push({ label: `c${rows.length + 1}`, candidate, listing, bookmarked, capability });
  };
  const order: Array<ProjectRosterSection["source"]> = ["local", "cloud", "hub"];
  for (const source of order) {
    const section = sections.find((item) => item.source === source);
    if (!section) continue;
    for (const firm of section.firms) {
      push(firm.team, null, source === "hub", firm.team.tagline);
      for (const member of firm.members) push(member, null, source === "hub", member.tagline);
    }
    for (const candidate of section.standalone) push(candidate, null, source === "hub", candidate.tagline);
  }
  if (hubSearch) {
    // 이미 붙은 Hub 도 메뉴에 남긴다(빈 pool 전달) — "이미 연결됨"은 화면이 중복으로 표시한다.
    for (const row of buildProjectHubRecommendations(hubSearch.listings, hubSearch.bookmarks, [], locale, 30)) {
      push(row.candidate, row.listing, row.bookmarked, row.reason);
    }
  }
  return rows;
}

function projectContext(name: string, goal: string): string {
  return buildProjectHubRecommendationQuery({ name, description: goal, systemPrompt: null });
}

function menuInput(context: string, role: ProjectTeamRole, rows: MenuRow[]): string {
  const header = `PROJECT\n${context}\n\nROLE\n${role}\n\nCANDIDATES (id\\tsource\\tkind\\tname\\tcapability)\n`;
  const budget = Math.max(40, Math.floor((PROJECT_TEAM_ROLE_FILL_JUDGMENT.maxInputChars - header.length - 200) / Math.max(1, rows.length)));
  const lines = rows.map((row) => {
    const name = row.candidate.name.replace(/\s+/g, " ").trim().slice(0, 80);
    const capability = row.capability.replace(/\s+/g, " ").trim();
    const prefix = `${row.label}\t${row.candidate.source}\t${row.candidate.kind}\t${name}\t`;
    return `${prefix}${capability.slice(0, Math.max(0, budget - prefix.length))}`;
  });
  return `${header}${lines.join("\n")}`;
}

export async function recommendAutoTeam(input: {
  name: string;
  goal: string;
  sections: ProjectRosterSection[];
  catalogFailedSources: Array<"cloud" | "hub">;
  searchHub: (query: string) => Promise<MarketplaceListing[]>;
  hubBookmarks: HubAgentBookmark[];
  pool: ProjectAgentPoolMember[];
  locale: Locale;
}): Promise<AutoTeamRecommendation> {
  const context = projectContext(input.name, input.goal);
  const failedSources: AutoTeamRecommendation["failedSources"] = [...input.catalogFailedSources];
  const [rolesJudgment, hubListings] = await Promise.all([
    judgeSubsetViaBridge<ProjectTeamRole>({
      kind: PROJECT_TEAM_ROLES_JUDGMENT.kind,
      labels: PROJECT_TEAM_ROLE_LABELS,
      input: `PROJECT\n${context}`,
      timeoutMs: PROJECT_TEAM_ROLES_JUDGMENT.timeoutMs,
    }).catch(() => { throw new AutoTeamError("judgment_unavailable"); }),
    input.searchHub(context).catch(() => { failedSources.push("hub-search"); return [] as MarketplaceListing[]; }),
  ]);
  if (rolesJudgment.confidence < PROJECT_TEAM_ROLES_JUDGMENT.minConfidence || rolesJudgment.selected.length === 0) {
    throw new AutoTeamError("low_confidence");
  }
  const roles = rolesJudgment.selected.slice(0, 4);
  const menu = buildAutoTeamMenu(input.sections, { listings: hubListings, bookmarks: input.hubBookmarks }, input.locale);
  if (menu.length === 0) throw new AutoTeamError("no_candidates");
  const byLabel = new Map(menu.map((row) => [row.label, row]));
  const labels = menu.map((row) => row.label);
  const fills = await Promise.all(roles.map((role) => judgeSubsetViaBridge<string>({
    kind: PROJECT_TEAM_ROLE_FILL_JUDGMENT.kind,
    labels,
    input: menuInput(context, role, menu),
    timeoutMs: PROJECT_TEAM_ROLE_FILL_JUDGMENT.timeoutMs,
  }).then((result) => ({ role, result })).catch(() => ({ role, result: null }))));
  if (fills.every((fill) => fill.result === null)) throw new AutoTeamError("judgment_unavailable");

  const picks: AutoTeamPick[] = [];
  const firstRoleByKey = new Map<string, ProjectTeamRole>();
  const rolesWithoutCandidate: ProjectTeamRole[] = [];
  for (const { role, result } of fills) {
    const chosen = result && result.confidence >= PROJECT_TEAM_ROLE_FILL_JUDGMENT.minConfidence
      ? result.selected.slice(0, 2).map((label) => byLabel.get(label)).filter((row): row is MenuRow => Boolean(row))
      : [];
    if (chosen.length === 0) rolesWithoutCandidate.push(role);
    for (const row of chosen) {
      const key = row.candidate.key;
      const duplicateOfRole = firstRoleByKey.get(key) ?? null;
      if (!duplicateOfRole) firstRoleByKey.set(key, role);
      // 판정 이유는 메뉴 라벨(c12)로 후보를 가리킨다 — 화면에는 이름으로 바꿔 보인다.
      // 판정 서비스는 영어로 답하므로 한국어 화면에는 후보가 공개한 능력 설명만 쓴다.
      const roleReason = input.locale === "en"
        ? (result?.reason ?? "").replace(/\bc(\d+)\b/g, (label) => byLabel.get(label)?.candidate.name ?? label).replace(/\s+/g, " ").trim()
        : "";
      picks.push({
        role,
        candidate: row.candidate,
        listing: row.listing,
        bookmarked: row.bookmarked,
        runnable: runnableOf(row.candidate),
        reason: [row.capability.trim(), roleReason].filter(Boolean).join(" — ").slice(0, 280),
        alreadyInPool: candidateInPool(row.candidate, input.pool),
        duplicateOfRole,
      });
    }
  }
  return { roles, picks, failedSources, rolesWithoutCandidate };
}
