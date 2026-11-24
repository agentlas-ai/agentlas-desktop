/**
 * The one reader of the name every screen shows for an installed agent.
 *
 * The owner's own name (installed_agents.local_display_name, set in Agent files, the org form or the rename dialog) wins in both
 * languages; otherwise the package name, and in English the package's English name when it has one. A team member has no name of
 * its own: it is read through this function, never copied (a copy goes stale and was the cause of two names for one agent).
 */
export interface AgentNameFields {
  name?: string | null;
  nameEn?: string | null;
  localDisplayName?: string | null;
  slug?: string | null;
}
export interface AgentTaglineFields {
  tagline?: string | null;
  taglineEn?: string | null;
}

export type AgentNameLocale = "ko" | "en";

/** The English-UI form of AGENT_DISPLAY_NAME_SQL: the owner's name, else the package's English name when it has one, else the package name. */
export const AGENT_DISPLAY_NAME_EN_SQL = "COALESCE(NULLIF(TRIM(local_display_name), ''), NULLIF(TRIM(name_en), ''), name)";

/** The same order in SQL, for readers that join installed_agents (home tree). Needs the plain `name` and `local_display_name` columns. */
export const AGENT_DISPLAY_NAME_SQL = "COALESCE(NULLIF(TRIM(local_display_name), ''), name)";

export function agentDisplayName(agent: AgentNameFields | null | undefined, locale?: AgentNameLocale): string {
  if (!agent) return "";
  const own = agent.localDisplayName?.trim();
  if (own) return own;
  if (locale === "en") {
    const english = agent.nameEn?.trim();
    if (english) return english;
  }
  return agent.name?.trim() || agent.slug?.trim() || "";
}

/** The one reader of the description every screen shows: English UI shows `taglineEn` when the package has one, otherwise the description as written. */
export function agentDisplayTagline(agent: AgentTaglineFields | null | undefined, locale?: AgentNameLocale): string {
  if (!agent) return "";
  if (locale === "en") {
    const english = agent.taglineEn?.trim();
    if (english) return english;
  }
  return agent.tagline ?? "";
}
