import type { InstalledAgent, MarketplaceListing } from "./types";

export type AgentEntityClass = "single" | "multi" | "plugin" | "graph";

type EntityLike = Pick<MarketplaceListing, "entityKind" | "source" | "kind" | "agentCount"> & {
  slug?: string;
  name?: string;
  nameEn?: string;
};

export function classifyHubEntity(entity: EntityLike): AgentEntityClass {
  if (entity.source === "hub-plugin" || entity.entityKind === "plugin") return "plugin";
  // 그래프는 실행 주체가 아니라 도면 — 에이전트로 접으면 "고용" 카드로 진열되고
  // 받는 사람은 채워야 할 바인딩을 안내받지 못한다(서버 package-kind와 같은 규율).
  if (entity.entityKind === "graph") return "graph";
  if (entity.entityKind === "team") return "multi";
  if (typeof entity.agentCount === "number" && entity.agentCount > 1) return "multi";
  return "single";
}

export function classifyInstalledAgent(agent: Pick<InstalledAgent, "kind">): AgentEntityClass {
  return agent.kind === "team" ? "multi" : "single";
}

export function isSingleHubAgent(entity: EntityLike): boolean {
  return classifyHubEntity(entity) === "single";
}

export function isSingleInstalledAgent(agent: Pick<InstalledAgent, "kind">): boolean {
  return classifyInstalledAgent(agent) === "single";
}

export function entityClassLabel(kind: AgentEntityClass, locale: "ko" | "en"): string {
  if (kind === "plugin") return locale === "ko" ? "플러그인" : "Plugin";
  if (kind === "graph") return locale === "ko" ? "자동화 그래프" : "Automation graph";
  if (kind === "multi") return locale === "ko" ? "멀티 에이전트 팀" : "Multi-agent team";
  return locale === "ko" ? "싱글 에이전트" : "Single agent";
}

export function entityClassShortLabel(kind: AgentEntityClass, locale: "ko" | "en"): string {
  if (kind === "plugin") return locale === "ko" ? "도구" : "Tool";
  if (kind === "graph") return locale === "ko" ? "그래프" : "Graph";
  if (kind === "multi") return locale === "ko" ? "멀티" : "Multi";
  return locale === "ko" ? "싱글" : "Single";
}

export function entityClassTone(kind: AgentEntityClass): string {
  if (kind === "plugin") return "plugin";
  if (kind === "graph") return "graph";
  return kind === "multi" ? "multi" : "single";
}
