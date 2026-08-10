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
  InstalledAgentExactBinding,
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
  blockedReason?: string;
}

export interface ProjectRosterFirm {
  id: string;
  name: string;
  team: ProjectRosterCandidate;
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
  if (member.entityKind === "team") return true;
  if (!member.agentId) return true;
  const installed = agents.find((agent) => agent.id === member.agentId);
  // Preserve a deleted/unmounted saved agent so the project can explain and
  // repair it. Filter only identities we can prove are internal role cells.
  return !installed || isUserFacingProjectAgent(installed);
}

function bindingSource(binding: InstalledAgentExactBinding | null): ProjectRosterSource {
  if (binding?.source === "agent-cloud-restore") return "cloud";
  if (binding?.source === "hub-install") return "hub";
  return "local";
}

function installedSource(agent: InstalledAgent, binding: InstalledAgentExactBinding | null): ProjectRosterSource {
  const exactSource = bindingSource(binding);
  if (binding) return exactSource;
  if (agent.assetSource === "agent-cloud") return "cloud";
  if (agent.assetSource === "hub") return "hub";
  return "local";
}

function installedProjectCandidate(
  agent: InstalledAgent,
  locale: Locale,
  binding: InstalledAgentExactBinding | null,
): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const source = installedSource(agent, binding);
  const exactRemote = source === "local" || Boolean(binding?.agentDefinitionId && binding?.agentReleaseId);
  const sourceAvailable = !agent.sourceMissingSince;
  const member: ProjectAgentPoolMember = {
    entityKind: "agent",
    targetId: binding?.agentDefinitionId ?? agent.id,
    agentId: agent.id,
    firmId: null,
    controllerAgentId: null,
    source,
    releaseId: binding?.agentReleaseId ?? null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: "agent",
    installed: true,
    callable: isUserFacingProjectAgent(agent) && exactRemote && sourceAvailable,
    blockedReason: !sourceAvailable
      ? (locale === "ko" ? "로컬 원본 경로 연결이 끊겼습니다." : "The local source path is disconnected.")
      : !exactRemote
        ? (locale === "ko" ? "정확한 Definition ID와 릴리스 확인 필요" : "Exact Definition ID and release required")
        : undefined,
  };
}

function installedTeamProjectCandidate(
  agent: InstalledAgent,
  locale: Locale,
  binding: InstalledAgentExactBinding | null,
): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const source = installedSource(agent, binding);
  const hasExactRemoteBinding = source !== "local" && Boolean(binding?.agentDefinitionId && binding?.agentReleaseId);
  const member: ProjectAgentPoolMember = {
    entityKind: "team",
    targetId: binding?.agentDefinitionId ?? agent.id,
    agentId: null,
    firmId: null,
    controllerAgentId: null,
    source,
    releaseId: binding?.agentReleaseId ?? null,
    nameSnapshot: localized.name,
  };
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: "team",
    installed: true,
    callable: hasExactRemoteBinding,
    blockedReason: hasExactRemoteBinding
      ? undefined
      : (locale === "ko"
          ? "독립 팀은 팀 자체의 정확한 Definition ID와 릴리스가 필요합니다."
          : "A standalone team requires its own exact Definition ID and release."),
  };
}

function remoteProjectCandidate(
  listing: MarketplaceListing,
  source: "cloud" | "hub",
  locale: Locale,
): ProjectRosterCandidate {
  const localized = pickLocalized(listing, locale);
  const entityKind = listing.entityKind === "team" ? "team" : "agent";
  const targetId = listing.agentDefinitionId ?? listing.slug;
  const member: ProjectAgentPoolMember = {
    entityKind,
    targetId,
    agentId: null,
    firmId: null,
    controllerAgentId: null,
    source,
    releaseId: listing.agentReleaseId ?? null,
    nameSnapshot: localized.name,
  };
  const hasExactBinding = Boolean(listing.agentDefinitionId && listing.agentReleaseId);
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: entityKind,
    installed: false,
    callable: hasExactBinding,
    blockedReason: hasExactBinding
      ? undefined
      : (locale === "ko" ? "정확한 Definition ID와 릴리스 확인 필요" : "Exact Definition ID and release required"),
  };
}

export function buildProjectRosterSections(
  agents: InstalledAgent[],
  firms: InstalledFirm[],
  cloudListings: MarketplaceListing[],
  hubBookmarks: HubAgentBookmark[],
  locale: Locale,
  exactBindings: InstalledAgentExactBinding[] = [],
): ProjectRosterSection[] {
  // Preload/API versions can temporarily disagree during an in-place Desktop
  // update. Treat a missing optional collection as empty instead of crashing
  // both project creation and project detail before the user can recover it.
  const safeAgents = Array.isArray(agents) ? agents : [];
  const safeFirms = Array.isArray(firms) ? firms : [];
  const safeCloudListings = Array.isArray(cloudListings) ? cloudListings : [];
  const safeHubBookmarks = Array.isArray(hubBookmarks) ? hubBookmarks : [];
  const safeExactBindings = Array.isArray(exactBindings) ? exactBindings : [];
  const roster = buildAgentRoster(safeAgents, safeFirms);
  const installedExactRemote = new Set(safeExactBindings.map((binding) =>
    `${bindingSource(binding)}:${binding.agentDefinitionId}:${binding.agentReleaseId}`));
  const listingAlreadyInstalled = (listing: MarketplaceListing, source: "cloud" | "hub") => Boolean(
    listing.agentDefinitionId
    && listing.agentReleaseId
    && installedExactRemote.has(`${source}:${listing.agentDefinitionId}:${listing.agentReleaseId}`),
  );
  const visibleRemoteListing = (listing: MarketplaceListing) => (
    listing.visibility !== "background" && listing.visibility !== "private"
  );
  const sections: ProjectRosterSection[] = [
    { source: "local", labelKo: "로컬", labelEn: "Local", firms: [], standalone: [] },
    { source: "cloud", labelKo: "내 에이전트", labelEn: "My agents", firms: [], standalone: [] },
    { source: "hub", labelKo: "Hub", labelEn: "Hub", firms: [], standalone: [] },
  ];
  const sectionBySource = new Map(sections.map((section) => [section.source, section]));
  const bindingByInstalledId = new Map(safeExactBindings.map((binding) => [binding.installedAgentId, binding] as const));

  for (const firm of safeFirms) {
    const ceo = roster.agentById.get(firm.ceoAgentId);
    if (!ceo || !isUserFacingProjectAgent(ceo)) continue;
    const ceoBinding = bindingByInstalledId.get(ceo.id) ?? null;
    const source = installedSource(ceo, ceoBinding);
    const remoteControllerOnly = source !== "local" || ceo.assetSource === "hub" || ceo.assetSource === "agent-cloud";
    const teamMember: ProjectAgentPoolMember = {
      entityKind: "team",
      targetId: firm.id,
      agentId: null,
      firmId: firm.id,
      controllerAgentId: ceo.id,
      source,
      releaseId: null,
      nameSnapshot: pickLocalized(firm, locale).name,
    };
    const team: ProjectRosterCandidate = {
      key: projectPoolMemberKey(teamMember),
      member: teamMember,
      name: pickLocalized(firm, locale).name,
      tagline: pickLocalized(firm, locale).tagline,
      source,
      kind: "team",
      installed: true,
      callable: !remoteControllerOnly,
      blockedReason: remoteControllerOnly
        ? (locale === "ko"
            ? "컨트롤러 릴리스는 팀 릴리스가 아닙니다. 팀 자체의 정확한 ID·릴리스 확인이 필요합니다."
            : "A controller release is not a team release. The team's own exact identity and release are required.")
        : undefined,
    };
    const orderedIds = [firm.ceoAgentId, ...firm.orgChart.map((node) => node.agentId)];
    const seen = new Set<string>();
    const members = orderedIds.flatMap((agentId) => {
      if (seen.has(agentId)) return [];
      seen.add(agentId);
      const agent = roster.agentById.get(agentId);
      return agent && agent.kind !== "team" && isUserFacingProjectAgent(agent)
        ? [installedProjectCandidate(agent, locale, bindingByInstalledId.get(agent.id) ?? null)]
        : [];
    });
    sectionBySource.get(source)?.firms.push({
      id: firm.id,
      name: pickLocalized(firm, locale).name,
      team,
      members,
      // The one member is the team itself: nothing to disclose.
      selfReferential: members.length === 0,
    });
  }

  for (const agent of visibleRosterAgents(roster.standaloneAgents).filter(isUserFacingProjectAgent)) {
    const binding = bindingByInstalledId.get(agent.id) ?? null;
    const candidate = agent.kind === "team"
      ? installedTeamProjectCandidate(agent, locale, binding)
      : installedProjectCandidate(agent, locale, binding);
    sectionBySource.get(candidate.source)?.standalone.push(candidate);
  }

  for (const listing of safeCloudListings) {
    if (listingAlreadyInstalled(listing, "cloud") || !visibleRemoteListing(listing)) continue;
    sectionBySource.get("cloud")?.standalone.push(remoteProjectCandidate(listing, "cloud", locale));
  }
  for (const bookmark of hubBookmarksWithoutLocalDuplicates(safeHubBookmarks)) {
    if (!visibleRemoteListing(bookmark.listing)) continue;
    if (listingAlreadyInstalled(bookmark.listing, "hub")) continue;
    sectionBySource.get("hub")?.standalone.push(remoteProjectCandidate(bookmark.listing, "hub", locale));
  }

  for (const section of sections) {
    section.firms.sort((left, right) => left.name.localeCompare(right.name, locale));
    section.standalone.sort((left, right) => left.name.localeCompare(right.name, locale));
  }
  return sections;
}
