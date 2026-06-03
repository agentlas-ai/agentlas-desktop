import type { InstalledAgent } from "../../shared/types";
import { APP_BUILDER_SLUG, GLOBAL_ORCHESTRATOR_SLUG } from "../architecture/manifest";
import type { RuntimeLocale } from "../runtime/status-i18n";

export interface AutoRouteChoice {
  agent: InstalledAgent;
  reason: string;
  matchedTerms: string[];
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
  "from",
  "into",
  "make",
  "build",
  "create",
  "agent",
  "agents",
  "please",
  "좀",
  "해주세요",
  "해줘",
  "만들어",
  "붙여",
  "연결",
  "작업",
  "요청",
]);

const ROUTE_HINTS: Array<{ slug: string; terms: string[]; reasonKo: string; reasonEn: string }> = [
  {
    slug: APP_BUILDER_SLUG,
    terms: [
      "apps generate",
      "app builder",
      "make an app",
      "build an app",
      "create an app",
      "generated app",
      "generate app",
      "internal app",
      "dedicated app",
      "workflow app",
      "dashboard app",
      "studio app",
      "service-app",
      "creative-studio",
      "scaffold-app",
      "operate-app",
      "앱빌더",
      "앱 빌더",
      "앱 만들어",
      "앱 만들",
      "전용 앱",
      "내장 앱",
      "내부 앱",
      "생성 앱",
      "워크플로우 앱",
      "대시보드 앱",
      "스튜디오 앱",
    ],
    reasonKo: "Agentlas 안에서 열리는 내부 App 생성/설계 요청입니다",
    reasonEn: "the request is to create or design an internal Agentlas App",
  },
  {
    slug: "agentlas-memory-curator",
    terms: ["memory", "remember", "recall", "request_context", "context_json", "메모리", "기억", "회상", "저장"],
    reasonKo: "기억 저장/검색/스코프 품질을 다루는 요청입니다",
    reasonEn: "the request concerns memory storage, recall, or scope quality",
  },
  {
    slug: "agentlas-task-bias",
    terms: ["bias", "sitemap", "evidence", "completion", "coverage", "편향", "사이트맵", "증거", "검증"],
    reasonKo: "작업 편향, 사이트맵, 검증 증거를 다루는 요청입니다",
    reasonEn: "the request concerns task bias, sitemap, or validation evidence",
  },
  {
    slug: "agentlas-pm-soul",
    terms: ["project", "plan", "decision", "handoff", "continuity", "프로젝트", "계획", "결정", "연속성", "핸드오프"],
    reasonKo: "프로젝트 연속성/결정/조율이 중심인 요청입니다",
    reasonEn: "the request is centered on project continuity, decisions, or coordination",
  },
];

export function isGlobalOrchestrator(agent: InstalledAgent | null | undefined): boolean {
  return agent?.slug === GLOBAL_ORCHESTRATOR_SLUG;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[_/]+/g, "-");
}

function tokenize(value: string): string[] {
  const normalized = normalize(value);
  const matches = normalized.match(/[a-z0-9][a-z0-9-]{1,}|[가-힣]{2,}/g) ?? [];
  const expanded = matches.flatMap((term) => term.split("-").filter(Boolean).concat(term));
  return [...new Set(expanded.filter((term) => term.length >= 2 && !STOP_WORDS.has(term)))];
}

function includesTerm(haystack: string, term: string): boolean {
  return haystack.includes(normalize(term));
}

const APP_BUILDER_EXPLICIT_TERMS = [
  "apps generate",
  "app builder",
  "make an app",
  "build an app",
  "create an app",
  "generate app",
  "generated app",
  "internal app",
  "dedicated app",
  "workflow app",
  "dashboard app",
  "studio app",
  "service-app",
  "creative-studio",
  "scaffold-app",
  "operate-app",
  "앱빌더",
  "앱 빌더",
  "앱 만들어",
  "앱 만들",
  "전용 앱",
  "내장 앱",
  "내부 앱",
  "생성 앱",
  "워크플로우 앱",
  "대시보드 앱",
  "스튜디오 앱",
];

const APP_BUILDER_REPEAT_TERMS = [
  "automation",
  "automate",
  "automatic",
  "recurring",
  "repeat",
  "scheduled",
  "scheduler",
  "every day",
  "every week",
  "workflow",
  "pipeline",
  "cron",
  "자동화",
  "자동",
  "반복",
  "정기",
  "매일",
  "매주",
  "스케줄",
  "예약",
  "워크플로우",
  "파이프라인",
];

const APP_BUILDER_SURFACE_TERMS = [
  "dashboard",
  "studio",
  "editor",
  "settings",
  "state",
  "save",
  "saved",
  "export",
  "import",
  "approve",
  "approval",
  "review",
  "queue",
  "table",
  "filter",
  "template",
  "memory",
  "profile",
  "대시보드",
  "스튜디오",
  "편집",
  "수정",
  "설정",
  "상태",
  "저장",
  "내보내기",
  "불러오기",
  "승인",
  "검토",
  "큐",
  "목록",
  "테이블",
  "필터",
  "템플릿",
  "학습",
  "메모리",
  "프로필",
];

const APP_BUILDER_ACTION_TERMS = [
  "build",
  "create",
  "generate",
  "compose",
  "manage",
  "track",
  "research",
  "analyze",
  "monitor",
  "render",
  "convert",
  "만들",
  "생성",
  "작성",
  "관리",
  "추적",
  "리서치",
  "조사",
  "분석",
  "모니터",
  "렌더",
  "변환",
];

const TRIVIAL_PROMPTS = new Set([
  "hi",
  "hello",
  "hey",
  "thanks",
  "thankyou",
  "안녕",
  "안녕하세요",
  "고마워",
  "감사",
  "뭐해",
]);

function matchedTerms(promptText: string, terms: string[]): string[] {
  return [...new Set(terms.filter((term) => includesTerm(promptText, term)))];
}

function isTrivialPrompt(promptText: string): boolean {
  const compact = promptText.replace(/\s+/g, " ").trim();
  const stripped = compact.replace(/[.!?~。！？,，ㅋㅎ\s]/g, "");
  if (!stripped) return true;
  if (stripped.length <= 18 && TRIVIAL_PROMPTS.has(stripped)) return true;
  const words = compact.split(/\s+/).filter(Boolean);
  return words.length <= 3 && TRIVIAL_PROMPTS.has(stripped);
}

export function isAppBuilderWorthyPrompt(prompt: string): boolean {
  const promptText = normalize(prompt);
  if (!promptText.trim() || isTrivialPrompt(promptText)) return false;

  const explicit = matchedTerms(promptText, APP_BUILDER_EXPLICIT_TERMS);
  if (explicit.length) return true;

  const repeat = matchedTerms(promptText, APP_BUILDER_REPEAT_TERMS);
  const surface = matchedTerms(promptText, APP_BUILDER_SURFACE_TERMS);
  const action = matchedTerms(promptText, APP_BUILDER_ACTION_TERMS);
  const signalCount = new Set([...repeat, ...surface, ...action]).size;

  if (repeat.length && (surface.length || action.length)) return true;
  if (surface.length >= 2 && action.length) return true;
  return signalCount >= 4;
}

function agentHaystack(agent: InstalledAgent): string {
  return normalize(
    [
      agent.slug,
      agent.name,
      agent.nameEn,
      agent.tagline,
      agent.taglineEn,
      agent.systemPrompt.slice(0, 3500),
      agent.mcpServers.join(" "),
      agent.envRequirements.map((req) => req.key).join(" "),
    ].join("\n"),
  );
}

function routeHintScore(promptText: string, agent: InstalledAgent, locale: RuntimeLocale): { score: number; reason?: string; terms: string[] } {
  const hint = ROUTE_HINTS.find((item) => item.slug === agent.slug);
  if (!hint) return { score: 0, terms: [] };
  if (hint.slug === APP_BUILDER_SLUG && !isAppBuilderWorthyPrompt(promptText)) {
    return { score: 0, terms: [] };
  }
  const terms = hint.terms.filter((term) => includesTerm(promptText, term));
  if (!terms.length) return { score: 0, terms: [] };
  return {
    score: 12 + terms.length * 3,
    reason: locale === "ko" ? hint.reasonKo : hint.reasonEn,
    terms,
  };
}

function scoreAgent(prompt: string, promptTerms: string[], agent: InstalledAgent, locale: RuntimeLocale): { score: number; reason: string; terms: string[] } {
  const promptText = normalize(prompt);
  if (agent.slug === APP_BUILDER_SLUG && !isAppBuilderWorthyPrompt(promptText)) {
    return {
      score: 0,
      reason:
        locale === "ko"
          ? "전용 App을 만들 만큼 반복·상태·편집·자동화가 뚜렷하지 않아 App Builder 라우트를 보류했습니다"
          : "the request does not clearly need a dedicated App with durable workflow, state, editing, or automation",
      terms: [],
    };
  }
  const haystack = agentHaystack(agent);
  let score = 0;
  const matchedTerms: string[] = [];

  const directNames = [agent.slug, agent.name, agent.nameEn].filter(Boolean);
  for (const name of directNames) {
    const n = normalize(name);
    if (n && promptText.includes(n)) {
      score += 20;
      matchedTerms.push(name);
    }
  }

  for (const term of promptTerms) {
    if (haystack.includes(term)) {
      score += term.length >= 5 ? 3 : 2;
      matchedTerms.push(term);
    }
  }

  const hint = routeHintScore(promptText, agent, locale);
  score += hint.score;
  matchedTerms.push(...hint.terms);

  const uniqueTerms = [...new Set(matchedTerms)].slice(0, 6);
  const reason =
    hint.reason ||
    (locale === "ko"
      ? uniqueTerms.length
        ? `요청어 ${uniqueTerms.map((term) => `"${term}"`).join(", ")}가 이 에이전트의 역할/트리거와 가장 가깝습니다`
        : "명확한 전문 라우트가 없어 기본 프로젝트 조율 에이전트가 가장 안전합니다"
      : uniqueTerms.length
        ? `request terms ${uniqueTerms.map((term) => `"${term}"`).join(", ")} best match this agent's role/triggers`
        : "no specialist matched clearly, so the default project coordinator is safest");

  return { score, reason, terms: uniqueTerms };
}

export function selectAutoRoutedAgent(
  userPrompt: string,
  agents: InstalledAgent[],
  locale: RuntimeLocale,
): AutoRouteChoice | null {
  const candidates = agents.filter((agent) => !isGlobalOrchestrator(agent));
  if (!candidates.length) return null;

  const promptTerms = tokenize(userPrompt);
  const ranked = candidates
    .map((agent) => ({ agent, ...scoreAgent(userPrompt, promptTerms, agent, locale) }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best && best.score > 0) {
    return { agent: best.agent, reason: best.reason, matchedTerms: best.terms };
  }

  const fallback =
    candidates.find((agent) => agent.slug === "agentlas-pm-soul") ??
    candidates[0];
  return {
    agent: fallback,
    reason:
      locale === "ko"
        ? "명확한 전문 에이전트가 없어 기본 프로젝트 조율 경로를 선택했습니다"
        : "no specialist matched clearly, so Agentlas chose the default coordination route",
    matchedTerms: [],
  };
}

export function autoRouteStatus(choice: AutoRouteChoice, locale: RuntimeLocale): string {
  const name = locale === "ko" ? choice.agent.name : choice.agent.nameEn || choice.agent.name;
  return locale === "ko"
    ? `사용 에이전트: ${name}. 이유: ${choice.reason}.`
    : `Selected agent: ${name}. Reason: ${choice.reason}.`;
}

export function autoRouteSystemPreamble(
  choice: AutoRouteChoice,
  locale: RuntimeLocale,
  mode: "default" | "apps-generate" | "app-edit" = "default",
): string {
  const appBuilderNeedsConsent = choice.agent.slug === APP_BUILDER_SLUG && mode !== "apps-generate";
  const instruction = mode === "app-edit"
    ? locale === "ko"
      ? [
          "사용자가 기존 Agentlas App 수정을 요청했습니다.",
          "새 App을 만들지 말고, 제공된 기존 App id/rootPath/manifest를 기준으로 그 App 파일과 동작만 수정하세요.",
          "사용자 편집·상태·저장 데이터는 보존하고 필요한 변경 사항과 검증 결과를 짧게 보고하세요.",
        ].join("\n")
      : [
          "The user asked to edit an existing Agentlas App.",
          "Do not create a new App. Use the provided existing App id/rootPath/manifest and update only that App's files and behavior.",
          "Preserve user edits, state, and saved data, then report the change and verification briefly.",
        ].join("\n")
    : appBuilderNeedsConsent
    ? locale === "ko"
      ? [
          "이 요청은 Agentlas 안에서 열리는 전용 App으로 만드는 것이 적합할 수 있지만, 사용자가 아직 전용 App 생성을 명시적으로 승인하지 않았습니다.",
          "실제 App 파일 생성, Agentlas Surface Manifest emit, scaffold-app/operate-app 액션 선언을 하지 마세요.",
          "대신 먼저 한 문장으로 확인 질문만 하세요: \"이 요청은 Agentlas 안에서 열리는 전용 App으로 만들면 더 편합니다. 전용 App으로 만들어 진행할까요?\"",
          "사용자가 동의하면 다음 메시지에서 App Builder 작업을 진행하세요.",
        ].join("\n")
      : [
          "This request may be a good fit for a dedicated Agentlas App, but the user has not explicitly approved dedicated App creation yet.",
          "Do not create App files, emit an Agentlas Surface Manifest, or declare scaffold-app/operate-app actions.",
          "Ask one confirmation question first: \"This would work better as a dedicated App inside Agentlas. Should I create that App for you?\"",
          "If the user agrees, proceed with the App Builder flow on the next message.",
        ].join("\n")
    : mode === "apps-generate"
      ? locale === "ko"
        ? "Apps Generate 모드가 위 경로를 선택했습니다. 첫 줄에 짧게 밝힌 뒤, 선택된 App Builder 경로로 바로 작업하세요."
        : "Apps Generate mode selected the route above. Briefly state it in the first line, then work as the selected App Builder path."
      : locale === "ko"
        ? "사용자는 에이전트를 직접 지정하지 않았습니다. 위 라우팅 결정을 첫 줄에 짧게 밝힌 뒤, 선택된 에이전트로 바로 작업하세요."
        : "The user did not explicitly choose an agent. Briefly state the route above in the first line, then work as the selected agent.";
  return [
    "## Agentlas automatic routing",
    "",
    autoRouteStatus(choice, locale),
    instruction,
  ].join("\n");
}
