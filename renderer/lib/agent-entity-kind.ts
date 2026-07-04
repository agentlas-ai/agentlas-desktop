import type { InstalledAgent, MarketplaceListing } from "./types";

export type AgentEntityClass = "single" | "multi" | "plugin";

type EntityLike = Pick<MarketplaceListing, "entityKind" | "source" | "kind" | "agentCount"> & {
  slug?: string;
  name?: string;
  nameEn?: string;
};

export function classifyHubEntity(entity: EntityLike): AgentEntityClass {
  if (entity.source === "hub-plugin" || entity.entityKind === "plugin") return "plugin";
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
  if (kind === "multi") return locale === "ko" ? "멀티 에이전트 팀" : "Multi-agent team";
  return locale === "ko" ? "싱글 에이전트" : "Single agent";
}

export function entityClassShortLabel(kind: AgentEntityClass, locale: "ko" | "en"): string {
  if (kind === "plugin") return locale === "ko" ? "도구" : "Tool";
  if (kind === "multi") return locale === "ko" ? "멀티" : "Multi";
  return locale === "ko" ? "싱글" : "Single";
}

export function entityClassTone(kind: AgentEntityClass): string {
  if (kind === "plugin") return "plugin";
  return kind === "multi" ? "multi" : "single";
}
