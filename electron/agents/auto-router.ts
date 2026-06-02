import type { InstalledAgent } from "../../shared/types";
import { GLOBAL_ORCHESTRATOR_SLUG } from "../architecture/manifest";
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

export function autoRouteSystemPreamble(choice: AutoRouteChoice, locale: RuntimeLocale): string {
  return [
    "## Agentlas automatic routing",
    "",
    autoRouteStatus(choice, locale),
    locale === "ko"
      ? "사용자는 에이전트를 직접 지정하지 않았습니다. 위 라우팅 결정을 첫 줄에 짧게 밝힌 뒤, 선택된 에이전트로 바로 작업하세요."
      : "The user did not explicitly choose an agent. Briefly state the route above in the first line, then work as the selected agent.",
  ].join("\n");
}
