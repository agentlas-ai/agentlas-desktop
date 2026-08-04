import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { hubBookmarksWithoutLocalDuplicates } from "@/lib/hub-bookmark-events";
import { pickLocalized, type Locale } from "@/lib/i18n";
import {
  isUserFacingProjectAgent,
  projectPoolMemberKey,
} from "@shared/project-agent-pool";
import type {
  HubAgentBookmark,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  ProjectAgentPoolMember,
} from "@/lib/types";

export type ProjectRosterSource = "local" | "cloud" | "hub";

export interface ProjectRosterCandidate {
  key: string;
  member: ProjectAgentPoolMember;
  name: string;
  tagline: string;
  source: ProjectRosterSource;
  kind: "agent" | "team";
  installed: boolean;
  callable: boolean;
}

export interface ProjectRosterFirm {
  id: string;
  name: string;
  members: ProjectRosterCandidate[];
  /**
   * True when this firm's entire membership is the team itself. An imported
   * local team is registered as an agent of kind "team" that is also its own
   * ceoAgentId, with an empty orgChart, so its member list resolves to one
   * entry: a duplicate of the row above it. Expanding such a firm promises
   * member detail and delivers nothing, and the count badge counts the team
   * counting itself. Callers render these as a leaf instead of an expander.
   */
  selfReferential: boolean;
}

export interface ProjectRosterSection {
  source: ProjectRosterSource;
  labelKo: string;
  labelEn: string;
  firms: ProjectRosterFirm[];
  standalone: ProjectRosterCandidate[];
}

// The pool key and the user-facing predicate are shared with the Mobile Bridge
// authority so both staffing surfaces accept exactly the same agents.
export { isUserFacingProjectAgent, projectPoolMemberKey };

export function isUserFacingProjectPoolMember(
  member: ProjectAgentPoolMember,
  agents: InstalledAgent[],
): boolean {
  if (member.source !== "local") return true;
  const installed = agents.find((agent) => agent.id === member.agentId);
  // Preserve a deleted/unmounted saved agent so the project can explain and
  // repair it. Filter only identities we can prove are internal role cells.
  return !installed || isUserFacingProjectAgent(installed);
}

function installedRosterSource(agent: InstalledAgent): ProjectRosterSource {
  if (agent.assetSource === "agent-cloud") return "cloud";
  if (agent.assetSource === "hub") return "hub";
  return "local";
}

function installedProjectCandidate(agent: InstalledAgent, locale: Locale): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const member: ProjectAgentPoolMember = {
    agentId: agent.id,
    source: "local",
    releaseId: null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source: installedRosterSource(agent),
    kind: agent.kind === "team" ? "team" : "agent",
    installed: true,
    callable: isUserFacingProjectAgent(agent),
  };
}

function remoteProjectCandidate(
  listing: MarketplaceListing,
  source: "cloud" | "hub",
  locale: Locale,
): ProjectRosterCandidate {
  const localized = pickLocalized(listing, locale);
  const member: ProjectAgentPoolMember = {
    agentId: listing.slug,
    source,
    releaseId: listing.agentReleaseId ?? listing.cloudRegistration?.revision ?? listing.packageHash ?? null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: listing.entityKind === "team" ? "team" : "agent",
    installed: false,
    callable: true,
  };
}

export function buildProjectRosterSections(
  agents: InstalledAgent[],
  firms: InstalledFirm[],
  cloudListings: MarketplaceListing[],
  hubBookmarks: HubAgentBookmark[],
  locale: Locale,
): ProjectRosterSection[] {
  const roster = buildAgentRoster(agents, firms);
  const installedSlugs = new Set(agents.map((agent) => agent.slug));
  const visibleRemoteListing = (listing: MarketplaceListing) => (
    listing.visibility !== "background" && listing.visibility !== "private"
  );
  const sections: ProjectRosterSection[] = [
    { source: "local", labelKo: "로컬", labelEn: "Local", firms: [], standalone: [] },
    { source: "cloud", labelKo: "내 에이전트", labelEn: "My agents", firms: [], standalone: [] },
    { source: "hub", labelKo: "Hub", labelEn: "Hub", firms: [], standalone: [] },
  ];
  const sectionBySource = new Map(sections.map((section) => [section.source, section]));

  for (const firm of firms) {
    const ceo = roster.agentById.get(firm.ceoAgentId);
    const orderedIds = [firm.ceoAgentId, ...firm.orgChart.map((node) => node.agentId)];
    const seen = new Set<string>();
    const members = orderedIds.flatMap((agentId) => {
      if (seen.has(agentId)) return [];
      seen.add(agentId);
      const agent = roster.agentById.get(agentId);
      return agent && isUserFacingProjectAgent(agent)
        ? [installedProjectCandidate(agent, locale)]
        : [];
    });
    if (members.length === 0) continue;
    const source = ceo ? installedRosterSource(ceo) : members[0].source;
    sectionBySource.get(source)?.firms.push({
      id: firm.id,
      name: pickLocalized(firm, locale).name,
      members,
      // The one member is the team itself: nothing to disclose.
      selfReferential: members.length === 1 && members[0].kind === "team",
    });
  }

  for (const agent of visibleRosterAgents(roster.standaloneAgents).filter(isUserFacingProjectAgent)) {
    const candidate = installedProjectCandidate(agent, locale);
    sectionBySource.get(candidate.source)?.standalone.push(candidate);
  }

  for (const listing of cloudListings) {
    if (installedSlugs.has(listing.slug) || !visibleRemoteListing(listing)) continue;
    sectionBySource.get("cloud")?.standalone.push(remoteProjectCandidate(listing, "cloud", locale));
  }
  for (const bookmark of hubBookmarksWithoutLocalDuplicates(hubBookmarks, agents)) {
    if (!visibleRemoteListing(bookmark.listing)) continue;
    sectionBySource.get("hub")?.standalone.push(remoteProjectCandidate(bookmark.listing, "hub", locale));
  }

  for (const section of sections) {
    section.firms.sort((left, right) => left.name.localeCompare(right.name, locale));
    section.standalone.sort((left, right) => left.name.localeCompare(right.name, locale));
  }
  return sections;
}
