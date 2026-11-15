/**
 * Special agents that are not part of the owner's Agents list:
 * Science and Finance have their own screens, so the Dashboard cards and the Agents list leave them out. They keep the same
 * folder structure as every other agent; only the list hides them. Pure — shared by the renderer and tests.
 */
const SPECIAL_AGENT_SLUGS = new Set<string>([
  "agentlas-science-research-director",
]);
const SPECIAL_AGENT_PATTERN = /^agentlas-(science|finance)(-|$)/;

export function isSpecialHiddenAgentSlug(slug: string | null | undefined): boolean {
  const value = (slug ?? "").trim().toLowerCase();
  return value !== "" && (SPECIAL_AGENT_SLUGS.has(value) || SPECIAL_AGENT_PATTERN.test(value));
}
