import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { hubBookmarksWithoutLocalDuplicates } from "@/lib/hub-bookmark-events";
import { pickLocalized, type Locale } from "@/lib/i18n";
import { redactSecrets } from "@shared/secret-patterns";
import { PROJECT_HUB_RECOMMENDATION_JUDGMENT } from "@shared/project-hub-recommendation";
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
  Project,
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
  /** Equivalent source-native ids (for Hub, slug and definition id). */
  identityAliases?: string[];
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

export interface ProjectHubRecommendation {
  listing: MarketplaceListing;
  candidate: ProjectRosterCandidate;
  reason: string;
  bookmarked: boolean;
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

/**
 * Staging a tool in a project is SELECTION, not INVOCATION.
 *
 * v0.9.76 made every remote row require a Hub exact pair
 * (agentDefinitionId + agentReleaseId) before it could be selected. No server
 * surface that feeds this roster returns that pair: the owner shelf comes from
 * `cargo.search_agents`, whose projection carries cloudId/manifestId/revision/
 * packageHash and never a definition/release, and the Hub search projection
 * drops both fields outright. The gate was therefore unsatisfiable — the entire
 * "내 에이전트" section was permanently disabled, and so was every installed
 * agent restored from Cloud without a public Hub registration.
 *
 * The Mobile Bridge hit this exact defect first and recorded the measurement
 * (`shared/mobile-bridge.ts`: "requiring a Hub binding to show a cloud row hid
 * the owner's entire shelf — measured: 50 rows, 1 shown"). Its answer was to
 * let cloud identity be cloud-shaped instead of fabricating a Hub pair. This is
 * the same answer for the Desktop roster: each source resolves its identity in
 * its OWN namespace, and the exact-release authority stays where a remote call
 * is actually prepared — `workforce-orchestrator` still requires a definition
 * and release id on every pin, fail-closed, before anything is invoked.
 *
 * targetId keeps the pre-v0.9.76 derivation (`agentDefinitionId ?? slug`) so
 * saved pools are not orphaned: for cloud rows that has always resolved to the
 * slug, and for Hub rows it keeps the exact definition id whenever the Hub
 * supplies one.
 */
function remoteReleasePin(listing: MarketplaceListing): string | null {
  const exact = listing.agentReleaseId?.trim();
  if (exact) return exact;
  const revision = listing.revision === undefined || listing.revision === null
    ? ""
    : String(listing.revision).trim();
  if (revision) return revision;
  return listing.packageHash?.trim() || null;
}

/**
 * Pool members for installed assets, exported so the agents page's "attach to
 * project" buttons stage exactly what this roster stages. Those buttons used to
 * derive their own members behind their own copies of the Hub-pair gate, so an
 * asset could be selectable in one screen and refused in the other.
 */
export function installedAgentPoolMember(
  agent: InstalledAgent,
  binding: InstalledAgentExactBinding | null,
  locale: Locale,
): ProjectAgentPoolMember {
  return {
    entityKind: "agent",
    targetId: binding?.agentDefinitionId ?? agent.id,
    agentId: agent.id,
    firmId: null,
    controllerAgentId: null,
    source: installedSource(agent, binding),
    releaseId: binding?.agentReleaseId ?? null,
    nameSnapshot: pickLocalized(agent, locale).name,
  };
}

export function installedTeamPoolMember(
  agent: InstalledAgent,
  binding: InstalledAgentExactBinding | null,
  locale: Locale,
): ProjectAgentPoolMember {
  return {
    entityKind: "team",
    targetId: binding?.agentDefinitionId ?? agent.id,
    agentId: null,
    firmId: null,
    controllerAgentId: null,
    source: installedSource(agent, binding),
    releaseId: binding?.agentReleaseId ?? null,
    nameSnapshot: pickLocalized(agent, locale).name,
  };
}

export function firmPoolMember(
  firm: InstalledFirm,
  ceo: InstalledAgent,
  ceoBinding: InstalledAgentExactBinding | null,
  locale: Locale,
): ProjectAgentPoolMember {
  return {
    entityKind: "team",
    targetId: firm.id,
    agentId: null,
    firmId: firm.id,
    controllerAgentId: ceo.id,
    source: installedSource(ceo, ceoBinding),
    // Never the controller's release: a team is keyed by the firm alone.
    releaseId: null,
    nameSnapshot: pickLocalized(firm, locale).name,
  };
}

function installedProjectCandidate(
  agent: InstalledAgent,
  locale: Locale,
  binding: InstalledAgentExactBinding | null,
): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const source = installedSource(agent, binding);
  // An installed agent executes from the local registry. Its provenance decides
  // which section it sits in, never whether it can be staged.
  const sourceAvailable = !agent.sourceMissingSince;
  const member = installedAgentPoolMember(agent, binding, locale);
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: "agent",
    installed: true,
    callable: isUserFacingProjectAgent(agent) && sourceAvailable,
    blockedReason: sourceAvailable
      ? undefined
      : (locale === "ko" ? "로컬 원본 경로 연결이 끊겼습니다." : "The local source path is disconnected."),
  };
}

function installedTeamProjectCandidate(
  agent: InstalledAgent,
  locale: Locale,
  binding: InstalledAgentExactBinding | null,
): ProjectRosterCandidate {
  const localized = pickLocalized(agent, locale);
  const source = installedSource(agent, binding);
  const sourceAvailable = !agent.sourceMissingSince;
  const member = installedTeamPoolMember(agent, binding, locale);
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: "team",
    installed: true,
    // An imported team runs through its own installed package, exactly like an
    // imported agent. Requiring a Hub release here disabled every locally
    // imported and Cloud-restored team, which are the common cases.
    callable: sourceAvailable,
    blockedReason: sourceAvailable
      ? undefined
      : (locale === "ko" ? "로컬 원본 경로 연결이 끊겼습니다." : "The local source path is disconnected."),
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
    releaseId: remoteReleasePin(listing),
    nameSnapshot: localized.name,
  };
  // A row is selectable when it resolves to an identity in its own source
  // namespace. A listing with no slug and no definition id is not an asset at
  // all — that is the only remote row this surface refuses.
  const hasIdentity = Boolean(targetId.trim());
  return {
    key: projectPoolMemberKey(member),
    member,
    name: localized.name,
    tagline: localized.tagline,
    source,
    kind: entityKind,
    installed: false,
    callable: hasIdentity,
    identityAliases: [listing.slug, listing.agentDefinitionId]
      .map((value) => String(value ?? "").trim().toLowerCase())
      .filter(Boolean),
    blockedReason: hasIdentity
      ? undefined
      : (locale === "ko" ? "이 목록 행에는 식별자가 없습니다." : "This catalog row carries no identity."),
  };
}

/**
 * Turn the user's existing project context into one natural-language Hub query.
 * `marketplace.search` owns remote matching and result order. This helper
 * deliberately does not invent a client-side score or label substring matching
 * as AI judgment because the remote search may use a lexical fallback.
 */
export function buildProjectHubRecommendationQuery(project: Pick<Project, "name" | "description" | "systemPrompt">): string {
  const publicSafe = (value: string): string => redactSecrets(value)
    .replace(/https?:\/\/[^\s<>"']+/gi, "[redacted-url]")
    .replace(/\b[A-Z]:\\(?:[^\\\s]+\\)*[^\\\s]*/gi, "[redacted-path]")
    .replace(/(^|[\s"'(])\/(?:[^/\s"'<>]+\/)+[^\s"'<>)]*/g, "$1[redacted-path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]+\b/g, "[redacted-identifier]");
  const passage = (value: string | null) => {
    const cleaned = publicSafe(String(value ?? "")).replace(/\s+/g, " ").trim();
    return cleaned ? cleaned.slice(0, 1_200) : null;
  };
  return [
    passage(project.name),
    passage(project.description),
    passage(project.systemPrompt),
  ].filter((value): value is string => Boolean(value)).join("\n");
}

/**
 * Compact, redacted model input for selecting from the public Hub recall menu.
 * The resident judgment service owns semantic selection; this helper only
 * supplies the project context and published catalog evidence verbatim.
 */
export function buildProjectHubRecommendationJudgmentInput(
  project: Pick<Project, "name" | "description" | "systemPrompt">,
  recommendations: ProjectHubRecommendation[],
): string {
  const context = buildProjectHubRecommendationQuery(project);
  const header = `PROJECT\n${context}\n\nPUBLIC HUB CANDIDATES\n`;
  const bases = recommendations.slice(0, 50).map((recommendation, index) => {
    const slug = recommendation.listing.slug.replace(/\s+/g, " ").trim().slice(0, 160);
    const name = recommendation.candidate.name.replace(/\s+/g, " ").trim().slice(0, 100);
    return {
      prefix: `candidate-${index + 1}\t${slug}\t${name}\t`,
      capability: recommendation.reason.replace(/\s+/g, " ").trim(),
    };
  });
  const fixedChars = header.length + bases.reduce((sum, row) => sum + row.prefix.length, 0) + Math.max(0, bases.length - 1);
  const capabilityChars = bases.length > 0
    ? Math.max(0, Math.min(360, Math.floor((23_900 - fixedChars) / bases.length)))
    : 0;
  const rows = bases.map((row) => `${row.prefix}${row.capability.slice(0, capabilityChars)}`);
  return `${header}${rows.join("\n")}`;
}

export function buildProjectHubRecommendationJudgmentSpec(
  project: Pick<Project, "name" | "description" | "systemPrompt">,
  recommendations: ProjectHubRecommendation[],
) {
  const candidates = recommendations.slice(0, 50);
  const options = candidates.map((recommendation, index) => ({
    label: `candidate-${index + 1}`,
    recommendation,
  }));
  return {
    candidates,
    options,
    kind: PROJECT_HUB_RECOMMENDATION_JUDGMENT.kind,
    labels: options.map((option) => option.label),
    input: buildProjectHubRecommendationJudgmentInput(project, candidates),
    timeoutMs: PROJECT_HUB_RECOMMENDATION_JUDGMENT.timeoutMs,
    minConfidence: PROJECT_HUB_RECOMMENDATION_JUDGMENT.minConfidence,
  };
}

/** Public Hub search results and saved bookmarks are different surfaces. */
export function hubProjectCandidate(listing: MarketplaceListing, locale: Locale): ProjectRosterCandidate {
  return remoteProjectCandidate(listing, "hub", locale);
}

/**
 * Keep usable public agents/teams that are not already attached to this
 * project. Result order stays exactly as Hub returned it. Explicit bookmarks
 * remain in the results with a marker because the user asked to discover beyond
 * bookmarks, not to hide bookmarked best fits. Server-observed prior use
 * (`bookmarked:false`) is not presented as a bookmark.
 */
export function buildProjectHubRecommendations(
  listings: MarketplaceListing[],
  bookmarks: HubAgentBookmark[],
  members: ProjectAgentPoolMember[],
  locale: Locale,
  limit = 6,
): ProjectHubRecommendation[] {
  const explicitBookmarks = new Set(
    (Array.isArray(bookmarks) ? bookmarks : [])
      .filter((bookmark) => bookmark.bookmarked !== false)
      .map((bookmark) => String(bookmark.slug || bookmark.listing?.slug || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const attached = new Set(
    (Array.isArray(members) ? members : [])
      .filter((member) => member.source === "hub")
      .map((member) => `${member.entityKind}:${member.targetId.trim().toLowerCase()}`),
  );
  const seen = new Set<string>();
  const out: ProjectHubRecommendation[] = [];
  for (const listing of Array.isArray(listings) ? listings : []) {
    const slug = String(listing.slug ?? "").trim().toLowerCase();
    const entityKind = listing.entityKind === "team" ? "team" : listing.entityKind === "agent" ? "agent" : null;
    if (
      !slug
      || !entityKind
      || seen.has(slug)
      || listing.visibility === "background"
      || listing.visibility === "private"
      || listing.callable !== true
      || listing.routingReady === false
      || listing.kind === "install-only"
    ) continue;
    const candidate = hubProjectCandidate(listing, locale);
    const aliases = candidate.identityAliases?.length
      ? candidate.identityAliases
      : [candidate.member.targetId.trim().toLowerCase()];
    if (!candidate.callable || aliases.some((alias) => attached.has(`${candidate.member.entityKind}:${alias}`))) continue;
    seen.add(slug);
    const tagline = pickLocalized(listing, locale).tagline.trim();
    out.push({
      listing,
      candidate,
      reason: tagline || (locale === "ko"
        ? "프로젝트 문맥으로 찾은 공개 Hub 후보입니다."
        : "A public Hub candidate found from the project context."),
      bookmarked: explicitBookmarks.has(slug),
    });
    if (out.length >= Math.max(1, limit)) break;
  }
  return out;
}

export type AppendProjectPoolResult =
  | { status: "added"; members: ProjectAgentPoolMember[] }
  | { status: "duplicate" | "full"; members: ProjectAgentPoolMember[] };

/** One write path for ordinary clicks and recommendation attachments. */
export function appendProjectPoolMember(
  members: ProjectAgentPoolMember[],
  candidate: ProjectRosterCandidate,
  maxMembers = 32,
): AppendProjectPoolResult {
  const current = Array.isArray(members) ? members : [];
  const candidateAliases = new Set(
    (candidate.identityAliases?.length ? candidate.identityAliases : [candidate.member.targetId])
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  const sameIdentity = current.some((member) => (
    member.source === candidate.member.source
    && member.entityKind === candidate.member.entityKind
    && candidateAliases.has(member.targetId.trim().toLowerCase())
  ));
  if (sameIdentity) return { status: "duplicate", members: current };
  if (current.length >= maxMembers) return { status: "full", members: current };
  return { status: "added", members: [...current, candidate.member] };
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
  // Local ownership wins over a remote catalog row. The exact-pair test alone
  // could never fire for a cloud row (that pair does not exist on the shelf), so
  // an agent already installed from Cloud was listed twice: once as an installed
  // row and once as a shelf row. Slug is the identity the organization chart and
  // the Hub bookmark helper already dedupe on; this surface now uses the same
  // authority instead of a third private rule.
  const installedSlugs = new Set(
    safeAgents.map((agent) => String(agent.slug ?? "").trim().toLowerCase()).filter(Boolean),
  );
  const listingAlreadyInstalled = (listing: MarketplaceListing, source: "cloud" | "hub") => {
    const slug = String(listing.slug ?? "").trim().toLowerCase();
    if (slug && installedSlugs.has(slug)) return true;
    return Boolean(
      listing.agentDefinitionId
      && listing.agentReleaseId
      && installedExactRemote.has(`${source}:${listing.agentDefinitionId}:${listing.agentReleaseId}`),
    );
  };
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
    const teamMember = firmPoolMember(firm, ceo, ceoBinding, locale);
    const team: ProjectRosterCandidate = {
      key: projectPoolMemberKey(teamMember),
      member: teamMember,
      name: pickLocalized(firm, locale).name,
      tagline: pickLocalized(firm, locale).tagline,
      source,
      kind: "team",
      installed: true,
      // "A controller release is not a team release" was the right rule, and it
      // is already satisfied structurally: this member is keyed by firm.id with
      // releaseId null, so the CEO's release can never stand in for the team's.
      // Blocking selection on top of that added nothing and disabled every firm
      // whose CEO came from Cloud or Hub.
      callable: true,
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
  // Every other caller of this helper (organization chart, chat context) passes
  // the installed agents so a locally owned asset hides its Hub reference. This
  // surface was the only one that omitted them, which is why the same asset
  // could appear under both the organization chart and the project Hub section.
  for (const bookmark of hubBookmarksWithoutLocalDuplicates(safeHubBookmarks, safeAgents)) {
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
