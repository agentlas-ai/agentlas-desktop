export type AgentEntityKind = "agent" | "team";

export function deriveListingEntityKind(listing: {
  entityKind?: string;
  agentCount?: number;
}): AgentEntityKind {
  if (listing.entityKind === "team") return "team";
  if (typeof listing.agentCount === "number" && listing.agentCount > 1) return "team";
  return "agent";
}

/** LLM/org resolver의 명시적 자가교정값은 다음 Hub metadata refresh보다 우선한다. */
export function entityKindAfterRefresh(
  persisted: AgentEntityKind | null | undefined,
  listing: { entityKind?: string; agentCount?: number },
): AgentEntityKind {
  return persisted ?? deriveListingEntityKind(listing);
}
