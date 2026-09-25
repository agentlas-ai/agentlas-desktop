/**
 * Work 자동 팀(PLAN §6) — 이름·목표로 역할을 정하고, 역할마다 로컬·내 Cloud·Hub
 * 후보 중 맞는 것을 고르는 두 단계 모델 판정 계약.
 *
 * 의미 판정은 상주 판정 서비스(judgeSubset)가 한다. 렌더러는 역할 어휘·후보 메뉴를
 * 그대로 건네고 고른 라벨만 받는다. 가격은 입력에 넣지 않는다 — Work 에이전트는
 * 무료 정책이므로 가격으로 거르거나 순위를 매기지 않는다(오너 2026-09-25).
 */
export const PROJECT_TEAM_ROLE_LABELS = [
  "research",
  "writing",
  "design",
  "frontend",
  "backend",
  "data",
  "marketing",
  "sales",
  "operations",
  "finance",
  "legal",
  "qa",
  "product",
  "support",
] as const;

export type ProjectTeamRole = typeof PROJECT_TEAM_ROLE_LABELS[number];

export const PROJECT_TEAM_ROLE_NAMES: Record<ProjectTeamRole, { ko: string; en: string }> = {
  research: { ko: "리서치", en: "Research" },
  writing: { ko: "글쓰기", en: "Writing" },
  design: { ko: "디자인", en: "Design" },
  frontend: { ko: "프론트엔드", en: "Frontend" },
  backend: { ko: "백엔드", en: "Backend" },
  data: { ko: "데이터 분석", en: "Data analysis" },
  marketing: { ko: "마케팅", en: "Marketing" },
  sales: { ko: "영업", en: "Sales" },
  operations: { ko: "운영", en: "Operations" },
  finance: { ko: "재무", en: "Finance" },
  legal: { ko: "법무", en: "Legal" },
  qa: { ko: "품질 검증", en: "QA" },
  product: { ko: "기획", en: "Product" },
  support: { ko: "고객 지원", en: "Support" },
};

export const PROJECT_TEAM_ROLES_JUDGMENT = {
  kind: "project-team-roles",
  question: "Which listed roles does this project's stated goal directly need? Choose one to four.",
  guidance:
    "Use only the project name and goal. Choose the smallest set of distinct roles that would actually do the stated work. " +
    "Do not add coordination, QA, or support roles unless the goal asks for them. Never choose more than four.",
  maxInputChars: 4_000,
  timeoutMs: 30_000,
  minConfidence: 0.5,
} as const;

export const PROJECT_TEAM_ROLE_FILL_JUDGMENT = {
  kind: "project-team-role-fill",
  question: "Which listed candidate ids can directly perform the named role for this project? Choose zero to two.",
  guidance:
    "Use only the project context, the named role, and each candidate's published name and capability description. " +
    "Prefer specialists that directly do the role's work. An empty selection is correct when no candidate fits the role. Never choose more than two ids.",
  maxInputChars: 24_000,
  timeoutMs: 45_000,
  minConfidence: 0.5,
} as const;
