/** Recall and curation follow the executing actor, not the storage chat's UI owner. */
export function invocationMemoryScope(
  context: { source: string; science?: { projectId: string; researchDirectorAgentId: string } } | undefined,
  chatAgentId: string,
  desktopProjectId: string | null,
): { agentId: string | null; projectId: string | null } {
  if (context?.source === "science") return {
    agentId: context.science?.researchDirectorAgentId ?? null,
    projectId: context.science?.projectId ?? null,
  };
  return { agentId: chatAgentId, projectId: desktopProjectId };
}
