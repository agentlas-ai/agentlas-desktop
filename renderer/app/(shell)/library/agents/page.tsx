"use client";

import { confirmPopup } from "@/lib/popup";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentWorkspace, type AgentWorkspaceView } from "@/components/agent-workspace/AgentWorkspace";
import styles from "@/components/agent-workspace/AgentWorkspace.module.css";
import { IconAlertTriangle, IconBuilding, IconCheck, IconChevronDown, IconChevronRight, IconClose, IconFileUp, IconFolder, IconGithub, IconLayers, IconPaperclip, IconPlus, IconRefresh, IconSearch, IconShield, IconSidebar, IconUsers } from "@/components/Icon";
import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { ipc } from "@/lib/ipc";
import { detailForUser } from "@/lib/invocation-failure";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { firmPoolMember, installedAgentPoolMember, installedTeamPoolMember } from "@/lib/project-agent-roster";
import { projectPoolMemberKey, projectPoolMemberReferences } from "@shared/project-agent-pool";
import type { AgentRuntimeOverride, BorrowedAgentProfile, InstalledAgent, InstalledAgentExactBinding, InstalledFirm, MarketplaceListing, Project, ResolvedOrg, RuntimeStatus } from "@shared/types";

function displayName(agent: InstalledAgent, locale: Locale): string {
  return agent.localDisplayName?.trim() || pickLocalized(agent, locale).name || agent.slug;
}
function sourceOf(agent: InstalledAgent, bindings: InstalledAgentExactBinding[]): "local" | "cloud" | "hub" {
  const binding = bindings.find((item) => item.installedAgentId === agent.id);
  if (binding?.source === "hub-install" || agent.assetSource === "hub") return "hub";
  if (binding?.source === "agent-cloud-restore" || agent.assetSource === "agent-cloud") return "cloud";
  return "local";
}
function initialView(value: string | null): AgentWorkspaceView {
  if (value === "memory" || value === "ontology") return "memory";
  if (value === "activity" || value === "history") return "history";
  if (value === "changes" || value === "sync") return value;
  return "files";
}

export default function LibraryAgentsPage() {
  return <Suspense fallback={null}><LibraryAgentsView /></Suspense>;
}

function LibraryAgentsView() {
  const { locale } = useT();
  const ko = locale === "ko";
  const params = useSearchParams();
  const publishedView = params.get("view") === "published";
  const targetAgentId = params.get("agentId") ?? params.get("nodeId") ?? "";
  const targetFirmId = params.get("firmId") ?? "";
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [bindings, setBindings] = useState<InstalledAgentExactBinding[]>([]);
  const [borrowed, setBorrowed] = useState<BorrowedAgentProfile[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [overrides, setOverrides] = useState<AgentRuntimeOverride[]>([]);
  const [selectedId, setSelectedId] = useState(params.get("agentId") ?? params.get("nodeId") ?? "");
  const [selectedFirmId, setSelectedFirmId] = useState(params.get("firmId") ?? "");
  const [contextFirmId, setContextFirmId] = useState(params.get("firmId") ?? "");
  const [selectedBorrowedId, setSelectedBorrowedId] = useState("");
  const [selectedOrg, setSelectedOrg] = useState<ResolvedOrg | null>(null);
  const [expandedTeams, setExpandedTeams] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | "local" | "cloud" | "hub">("all");
  const [kind, setKind] = useState<"all" | "single" | "multi">("all");
  const [rosterCollapsed, setRosterCollapsed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [published, setPublished] = useState<MarketplaceListing[]>([]);
  const [publishedSignedIn, setPublishedSignedIn] = useState<boolean | null>(null);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const refreshGeneration = useRef(0);
  const dirty = useRef(false);
  const roster = useMemo(() => buildAgentRoster(visibleRosterAgents(agents), firms), [agents, firms]);
  const allAgents = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const selectedFirm = firms.find((firm) => firm.id === selectedFirmId) ?? null;
  const selectedAgent = allAgents.get(selectedId || selectedFirm?.ceoAgentId || "") ?? null;
  const activeFirm = selectedFirm ?? firms.find((firm) => firm.id === contextFirmId) ?? firms.find((firm) => firm.orgChart.some((node) => node.agentId === selectedAgent?.id) || firm.ceoAgentId === selectedAgent?.id) ?? null;
  const selectedProfile = borrowed.find((profile) => profile.profileId === selectedBorrowedId) ?? null;
  const setDirty = useCallback((next: boolean) => { dirty.current = next; }, []);
  const mayChangeAgent = async () => !dirty.current || await confirmPopup(ko ? "저장하지 않은 초안을 버릴까요?" : "Discard the unsaved draft?", { locale, tone: "warning", confirmLabel: ko ? "초안 버리기" : "Discard draft" });
  useEffect(() => {
    if (!targetAgentId && !targetFirmId) return;
    let cancelled = false;
    void (async () => {
      if (dirty.current && !await confirmPopup(ko ? "저장하지 않은 초안을 버릴까요?" : "Discard the unsaved draft?", { locale, tone: "warning" })) return;
      if (cancelled) return;
      setSelectedId(targetAgentId); setSelectedFirmId(targetFirmId); setContextFirmId(targetFirmId); setSelectedBorrowedId("");
    })();
    return () => { cancelled = true; };
  }, [targetAgentId, targetFirmId, ko]);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) { setLoading(false); setError(ko ? "Desktop 브리지를 사용할 수 없습니다." : "Desktop bridge is unavailable."); return; }
    const generation = ++refreshGeneration.current;
    const results = await Promise.allSettled([api.team.list(), api.firms.list(), api.agents.exactBindings(), api.projects.list(), api.runtime.detect(), api.agentRuntime.list(), api.agents.borrowedProfiles()]);
    if (generation !== refreshGeneration.current) return;
    const [agentResult, firmResult, bindingResult, projectResult, runtimeResult, overrideResult, borrowedResult] = results;
    if (agentResult.status === "fulfilled") setAgents(agentResult.value);
    if (firmResult.status === "fulfilled") setFirms(firmResult.value);
    if (bindingResult.status === "fulfilled") setBindings(bindingResult.value);
    if (projectResult.status === "fulfilled") { setProjects(projectResult.value); setProjectId((current) => projectResult.value.some((project) => project.id === current) ? current : projectResult.value[0]?.id ?? ""); }
    if (runtimeResult.status === "fulfilled") setRuntimes(runtimeResult.value);
    if (overrideResult.status === "fulfilled") setOverrides(overrideResult.value);
    if (borrowedResult.status === "fulfilled") setBorrowed(borrowedResult.value);
    const failed = results.filter((result) => result.status === "rejected");
    setError(failed.length ? `${ko ? "일부 정보를 읽지 못했습니다: " : "Some data could not be read: "}${failed.map((result) => result.status === "rejected" ? detailForUser(result.reason) : "").join(" · ")}` : "");
    setLoading(false);
  }, [ko]);
  useEffect(() => { void refresh(); return () => { refreshGeneration.current++; }; }, [refresh]);
  useEffect(() => onAgentRosterChange(() => { void refresh(); }), [refresh]);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1100px)");
    setRosterCollapsed(media.matches);
    const compact = (event: MediaQueryListEvent) => { if (event.matches) setRosterCollapsed(true); };
    media.addEventListener("change", compact);
    return () => media.removeEventListener("change", compact);
  }, []);
  useEffect(() => {
    if (loading || selectedBorrowedId) return;
    if (selectedId && allAgents.has(selectedId)) return;
    const targetFirm = firms.find((firm) => firm.id === selectedFirmId);
    const first = allAgents.get(targetFirm?.ceoAgentId ?? "") ?? roster.singleModeAgents[0] ?? roster.standaloneMultiAgents[0] ?? allAgents.get(roster.multiFirms[0]?.ceoAgentId ?? "");
    if (first) setSelectedId(first.id);
  }, [loading, selectedId, selectedBorrowedId, allAgents, firms, selectedFirmId, roster]);
  useEffect(() => {
    if (!activeFirm) { setSelectedOrg(null); return; }
    let cancelled = false;
    void ipc()?.firms.getResolvedOrg(activeFirm.id).then((org) => { if (!cancelled) setSelectedOrg(org); }).catch(() => { if (!cancelled) setSelectedOrg(null); });
    return () => { cancelled = true; };
  }, [activeFirm]);
  const loadPublished = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setPublishedLoading(true);
    try { const session = await api.auth.getSession(); setPublishedSignedIn(session.signedIn); if (session.signedIn) setPublished(await api.marketplace.listMine()); else setPublished([]); }
    catch (failure) { setError(detailForUser(failure)); }
    finally { setPublishedLoading(false); }
  }, []);
  useEffect(() => { if (publishedView) void loadPublished(); }, [publishedView, loadPublished]);
  useEffect(() => { if (!notice) return; const timeout = window.setTimeout(() => setNotice(""), 4500); return () => window.clearTimeout(timeout); }, [notice]);

  async function chooseAgent(agent: InstalledAgent, firmId = "", contextId = firmId) {
    if (agent.id !== selectedId && !await mayChangeAgent()) return;
    setSelectedId(agent.id); setSelectedFirmId(firmId); setContextFirmId(contextId); setSelectedBorrowedId("");
    if (window.matchMedia("(max-width: 1100px)").matches) setRosterCollapsed(true);
  }
  async function action(label: string, task: () => Promise<void>) {
    if (busy) return;
    setBusy(label); setError("");
    try { await task(); } catch (failure) { setError(detailForUser(failure)); } finally { setBusy(""); }
  }
  async function importFolder() {
    const api = ipc(); if (!api) return;
    const selection = await api.fs.pickDirectory(); if (!selection) return;
    const agent = await api.team.importLocalFolder({ path: selection.path, scope: selection.scope });
    await refresh(); await chooseAgent(agent); setNotice(ko ? "로컬 에이전트를 가져왔습니다." : "Local agent imported.");
  }
  async function attach() {
    const api = ipc(); const project = projects.find((item) => item.id === projectId);
    if (!api || !project || !selectedAgent) return;
    if (selectedAgent.sourceMissingSince) throw new Error(ko ? "원본 폴더 연결이 끊겨 장착할 수 없습니다." : "The source folder is disconnected.");
    const binding = bindings.find((item) => item.installedAgentId === selectedAgent.id) ?? null;
    const controller = activeFirm ? allAgents.get(activeFirm.ceoAgentId) : undefined;
    const controllerBinding = controller ? bindings.find((item) => item.installedAgentId === controller.id) ?? null : null;
    const member = selectedFirm && controller ? firmPoolMember(selectedFirm, controller, controllerBinding, locale)
      : selectedAgent.kind === "team" ? installedTeamPoolMember(selectedAgent, binding, locale)
      : installedAgentPoolMember(selectedAgent, binding, locale);
    if (project.agentPool.some((item) => projectPoolMemberKey(item) === projectPoolMemberKey(member))) { setNotice(ko ? "이미 장착되어 있습니다." : "Already attached."); return; }
    const updated = await api.projects.update(project.id, { agentPool: [...project.agentPool, member] });
    setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
    setNotice(ko ? `${updated.name}에 장착했습니다.` : `Attached to ${updated.name}.`);
  }
  async function rename(value: string) {
    const api = ipc(); if (!api || !selectedAgent) throw new Error(ko ? "에이전트가 없습니다." : "No agent selected.");
    const updated = await api.team.setLocalDisplayName(selectedAgent.id, value);
    setAgents((current) => current.map((agent) => agent.id === updated.id ? updated : agent));
    setNotice(ko ? "표시 이름을 저장했습니다." : "Display name saved.");
  }
  async function remove() {
    const api = ipc(); if (!api || !selectedAgent) return;
    if (!await mayChangeAgent()) return;
    const entityIds = selectedFirm ? [selectedFirm.ceoAgentId, ...selectedFirm.orgChart.map((node) => node.agentId)] : [selectedAgent.id];
    const referenceSet = { agentIds: new Set(entityIds), firmIds: new Set(selectedFirm ? [selectedFirm.id] : []), remoteTargetIds: new Set(entityIds.map((id) => allAgents.get(id)?.slug.toLowerCase()).filter((slug): slug is string => Boolean(slug))) };
    const affected = projects.filter((project) => project.agentPool.some((member) => projectPoolMemberReferences(member, referenceSet)));
    const origin = sourceOf(selectedAgent, bindings);
    let preserved = ko ? "대화 기록은 유지됩니다." : "Conversation history is preserved.";
    if (!selectedFirm) { try { const preview = await api.team.uninstallPreview(selectedAgent.id); preserved = ko ? `좌석 ${preview.seatCount}곳이 비며 대화 ${preview.chatCount}개는 유지됩니다.` : `${preview.seatCount} seats become empty; ${preview.chatCount} conversations are preserved.`; } catch { /* No invented impact counts. */ } }
    const sourceAction = origin === "cloud" ? (ko ? "Cloud 원격 자산도 삭제됩니다." : "The Cloud asset is also deleted.") : origin === "hub" ? (ko ? "Hub 북마크도 제거됩니다." : "The Hub bookmark is also removed.") : (ko ? "원본 폴더를 휴지통으로 이동합니다." : "The source folder moves to Trash.");
    const name = selectedFirm ? pickLocalized(selectedFirm, locale).name : displayName(selectedAgent, locale);
    if (!await confirmPopup(`${ko ? `‘${name}’ 제거?` : `Remove “${name}”?`}\n${sourceAction}\n${preserved}${affected.length ? `\n${ko ? "장착 해제" : "Detach from"}: ${affected.map((project) => project.name).join(", ")}` : ""}`, { locale, tone: "danger", confirmLabel: ko ? "제거" : "Remove" })) return;
    if (origin === "cloud") await api.marketplace.deleteMine(selectedAgent.slug);
    if (origin === "hub") await api.marketplace.bookmarkRemove(selectedAgent.slug, selectedFirm || selectedAgent.kind === "team" ? "team" : "agent");
    const result = selectedFirm ? await api.firms.uninstall(selectedFirm.id, { removeMembers: true, removeSource: origin === "local" }) : await api.team.uninstall(selectedAgent.id, { removeSource: origin === "local" });
    setSelectedId(""); setSelectedFirmId(""); dirty.current = false; await refresh();
    setNotice(ko ? `제거했습니다.${origin === "local" && !result.sourceMovedToTrash ? " 원본의 휴지통 이동은 실패했습니다." : ""}` : `Removed.${origin === "local" && !result.sourceMovedToTrash ? " Moving the source to Trash failed." : ""}`);
  }
  const matches = (agent: InstalledAgent) => (source === "all" || sourceOf(agent, bindings) === source) && (!query.trim() || [displayName(agent, locale), agent.slug].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  const singleAgents = roster.singleModeAgents.filter(matches);
  const teams = roster.standaloneMultiAgents.filter(matches);
  const multiFirms = roster.multiFirms.filter((firm) => {
    const controller = allAgents.get(firm.ceoAgentId);
    return (source === "all" || (controller ? sourceOf(controller, bindings) === source : source === "local")) && (!query.trim() || [pickLocalized(firm, locale).name, firm.slug, ...firm.orgChart.map((node) => allAgents.get(node.agentId) ? displayName(allAgents.get(node.agentId)!, locale) : node.role)].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  });
  const installedExactPairs = new Set(bindings.map((binding) => `${binding.agentDefinitionId}:${binding.agentReleaseId}`));
  const borrowedRows = borrowed.filter((profile) => (profile.componentId || !installedExactPairs.has(`${profile.agentDefinitionId}:${profile.agentReleaseId}`)) && (source === "all" || source === "hub") && (!query.trim() || [profile.name, profile.nameEn, profile.slug].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
  const row = (agent: InstalledAgent, firmId = "", child = false, contextId = firmId) => <button key={`${firmId}:${agent.id}`} className={`${styles.rosterRow} ${child ? styles.subRow : ""} ${selectedId === agent.id && !selectedBorrowedId ? styles.selected : ""}`} onClick={() => void chooseAgent(agent, firmId, contextId)} title={displayName(agent, locale)} aria-pressed={selectedId === agent.id && !selectedBorrowedId}><AgentAvatar name={displayName(agent, locale)} size={rosterCollapsed ? 26 : 23} />{!rosterCollapsed && <><span className={styles.rosterText}>{displayName(agent, locale)}</span>{agent.bookmarkedAt && <IconCheck size={10} />}<span className={`${styles.dot} ${agent.sourceMissingSince ? styles.warningDot : ""}`} title={agent.sourceMissingSince ? (ko ? "원본 연결 끊김" : "Source disconnected") : sourceOf(agent, bindings)} /></>}</button>;
  const projectControl = <div className={styles.projectAttach}><select aria-label={ko ? "장착할 프로젝트" : "Project to attach"} value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={!projects.length || Boolean(busy)}><option value="">{ko ? "프로젝트" : "Project"}</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select><button className={styles.iconButton} title={ko ? "프로젝트에 장착" : "Attach to project"} aria-label={ko ? "프로젝트에 장착" : "Attach to project"} disabled={!projectId || !selectedAgent || Boolean(busy) || Boolean(selectedAgent.sourceMissingSince)} onClick={() => void action("attach", attach)}><IconPaperclip size={15} /></button>{selectedAgent && <button className={`${styles.iconButton} ${selectedAgent.bookmarkedAt ? styles.selected : ""}`} aria-pressed={Boolean(selectedAgent.bookmarkedAt)} title={ko ? "즐겨찾기" : "Bookmark"} aria-label={ko ? "즐겨찾기" : "Bookmark"} onClick={() => void action("bookmark", async () => { const api = ipc(); if (!api || !selectedAgent) return; await api.agents.setBookmark(selectedAgent.id, !selectedAgent.bookmarkedAt); await refresh(); })}><IconCheck size={13} /></button>}</div>;

  return <div className={styles.shell} data-testid="manage-agent-workspace">
    {!rosterCollapsed && <button className={`${styles.scrim} ${styles.rosterScrim}`} aria-label={ko ? "에이전트 목록 닫기" : "Close agent roster"} onClick={() => setRosterCollapsed(true)} />}
    <aside className={`${styles.roster} ${rosterCollapsed ? styles.rosterCollapsed : ""}`} data-tour-id="agents.roster">
      <div className={styles.rosterHeader}>{!rosterCollapsed && <strong>{publishedView ? (ko ? "게시 자산" : "Published assets") : (ko ? "에이전트" : "Agents")}</strong>}<button className={styles.iconButton} aria-label={ko ? "에이전트 목록 접기/펴기" : "Toggle agent roster"} title={ko ? "에이전트 목록" : "Agent roster"} onClick={() => setRosterCollapsed((current) => !current)}><IconSidebar size={17} /></button>{!rosterCollapsed && <button className={styles.iconButton} disabled={loading} onClick={() => void refresh()} title={ko ? "목록 새로고침" : "Refresh roster"} aria-label={ko ? "목록 새로고침" : "Refresh roster"}><IconRefresh size={14} /></button>}</div>
      {!rosterCollapsed && <><div className={styles.search}><IconSearch size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={ko ? "에이전트 검색" : "Search agents"} placeholder={ko ? "에이전트 검색" : "Search agents"} /></div><div className={styles.rosterFilters}>{(["all", "single", "multi"] as const).map((value) => <button key={value} className={`${styles.filterButton} ${kind === value ? styles.filterActive : ""}`} onClick={() => setKind(value)}>{value === "all" ? (ko ? "전체" : "All") : value === "single" ? (ko ? "개별" : "Agents") : (ko ? "팀" : "Teams")}</button>)}<select aria-label={ko ? "원본 위치" : "Origin location"} value={source} onChange={(event) => setSource(event.target.value as typeof source)} className={styles.filterButton}><option value="all">{ko ? "위치" : "Origin"}</option><option value="local">Local</option><option value="cloud">Cloud</option><option value="hub">Hub</option></select></div></>}
      <div className={styles.rosterRows}>{loading && <div className={styles.empty}><span className={styles.loading} /></div>}
        {kind !== "multi" && <>{!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "개별 에이전트" : "AGENTS"}</span><span>{singleAgents.length}</span></div>}{singleAgents.map((agent) => row(agent))}</>}
        {kind !== "single" && <>{!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "에이전트 팀" : "TEAMS"}</span><span>{multiFirms.length + teams.length}</span></div>}{multiFirms.map((firm) => {
          const controller = allAgents.get(firm.ceoAgentId);
          const members = firm.orgChart.filter((node) => isUserFacingAgentText(allAgents.get(node.agentId)?.name ?? node.role, node.role));
          const name = pickLocalized(firm, locale).name;
          return <div key={firm.id}><div className={styles.rosterGroup}>{!rosterCollapsed && <button className={styles.iconButton} aria-label={`${name} ${ko ? "멤버 보기" : "members"}`} aria-expanded={expandedTeams.has(firm.id)} onClick={() => setExpandedTeams((previous) => { const next = new Set(previous); if (next.has(firm.id)) next.delete(firm.id); else next.add(firm.id); return next; })}>{expandedTeams.has(firm.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}<button className={`${styles.rosterRow} ${selectedFirmId === firm.id && !selectedBorrowedId ? styles.selected : ""}`} title={name} onClick={() => { if (controller) void chooseAgent(controller, firm.id); else { setError(ko ? "팀 실행 에이전트를 찾을 수 없습니다." : "The team controller is missing."); } }}><IconUsers size={rosterCollapsed ? 21 : 17} />{!rosterCollapsed && <span className={styles.rosterText}>{name}</span>}</button></div>{!rosterCollapsed && expandedTeams.has(firm.id) && members.map((node) => { const agent = allAgents.get(node.agentId); return agent ? row(agent, "", true, firm.id) : <div className={`${styles.rosterRow} ${styles.subRow}`} key={`${node.agentId}:${node.role}`}><IconAlertTriangle size={12} /><span className={styles.rosterText}>{node.role}</span></div>; })}</div>;
        })}{teams.map((team) => { const members = agents.filter((agent) => agent.parentTeamId === team.id); return <div key={team.id}><div className={styles.rosterGroup}>{!rosterCollapsed && members.length > 0 && <button className={styles.iconButton} aria-label={`${displayName(team, locale)} ${ko ? "멤버 보기" : "members"}`} aria-expanded={expandedTeams.has(team.id)} onClick={() => setExpandedTeams((previous) => { const next = new Set(previous); if (next.has(team.id)) next.delete(team.id); else next.add(team.id); return next; })}>{expandedTeams.has(team.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}{row(team)}</div>{!rosterCollapsed && expandedTeams.has(team.id) && members.map((member) => row(member, "", true))}</div>; })}</>}
        {borrowedRows.length > 0 && <>{!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "Hub 사용 기록" : "HUB REFERENCES"}</span><span>{borrowedRows.length}</span></div>}{borrowedRows.map((profile) => <button key={profile.profileId} className={`${styles.rosterRow} ${selectedBorrowedId === profile.profileId ? styles.selected : ""}`} title={locale === "en" ? profile.nameEn : profile.name} onClick={async () => { if (!await mayChangeAgent()) return; setSelectedBorrowedId(profile.profileId); }}><IconGithub size={18} />{!rosterCollapsed && <><span className={styles.rosterText}>{locale === "en" ? profile.nameEn : profile.name}</span><IconShield size={11} /></>}</button>)}</>}
        {!loading && !agents.length && !firms.length && !borrowed.length && <div className={styles.empty}><IconFolder size={28} />{!rosterCollapsed && (ko ? "에이전트 없음" : "No agents")}</div>}
      </div><div className={styles.rosterFoot}><button className={styles.iconButton} disabled={Boolean(busy)} onClick={() => void action("import", importFolder)} aria-label={ko ? "로컬 폴더 가져오기" : "Import local folder"} title={ko ? "로컬 폴더 가져오기" : "Import local folder"}><IconFileUp size={17} /></button>{!rosterCollapsed && <><Link className={styles.iconButton} href="/build" aria-label={ko ? "에이전트 만들기" : "Build agent"} title={ko ? "에이전트 만들기" : "Build agent"}><IconPlus size={17} /></Link><Link className={styles.iconButton} href={publishedView ? "/library/agents" : "/library/agents?view=published"} title={publishedView ? (ko ? "설치 에이전트" : "Installed agents") : (ko ? "내 게시 자산" : "My published assets")} aria-label={publishedView ? (ko ? "설치 에이전트" : "Installed agents") : (ko ? "내 게시 자산" : "My published assets")}><IconLayers size={17} /></Link></>}</div>
    </aside>
    <div className={styles.workspace}>{error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={14} /><span>{error}</span><button className={styles.iconButton} aria-label={ko ? "오류 닫기" : "Dismiss error"} onClick={() => setError("")}><IconClose size={13} /></button></div>}
      {publishedView ? <div className={styles.workspace}><header className={styles.toolbar}><strong>{ko ? "내 게시 자산" : "My published assets"}</strong><button className={styles.iconButton} onClick={() => void loadPublished()} aria-label={ko ? "게시 자산 새로고침" : "Refresh published assets"}><IconRefresh size={15} /></button><Link className={styles.button} href="/library/agents">{ko ? "에이전트 파일" : "Agent files"}</Link></header>{publishedLoading ? <div className={styles.empty}><span className={styles.loading} /></div> : publishedSignedIn === false ? <div className={styles.empty}><IconShield size={30} /><button className={styles.button} onClick={() => void action("sign-in", async () => { const api = ipc(); if (!api) return; await api.auth.signInWithGoogle(); await loadPublished(); })}>{ko ? "로그인" : "Sign in"}</button></div> : <div className={styles.history}>{published.filter((listing) => !query.trim() || [listing.name, listing.nameEn, listing.slug].some((value) => value?.toLowerCase().includes(query.toLowerCase()))).map((listing) => <div className={styles.revisionBody} key={listing.slug}><div className={styles.revisionTitle}><IconBuilding size={17} /><strong>{pickLocalized(listing, locale).name}</strong><code className={styles.meta}>{listing.slug}</code><button className={styles.button} disabled={Boolean(busy)} onClick={() => void action("install", async () => { const api = ipc(); if (!api || !await mayChangeAgent()) return; const installed = await api.team.installMine(listing.slug); await refresh(); await chooseAgent(installed); setNotice(ko ? "설치했습니다. 에이전트 파일에서 확인하세요." : "Installed. Open Agent files to inspect it."); })}><IconFileUp size={12} />{ko ? "로컬 설치" : "Install locally"}</button></div></div>)}{!published.length && <div className={styles.empty}>{ko ? "게시 자산 없음" : "No published assets"}</div>}</div>}</div>
      : selectedProfile ? <div className={styles.workspace} data-testid="borrowed-agent-detail"><header className={styles.toolbar}><button className={styles.iconButton} onClick={() => setRosterCollapsed((current) => !current)} aria-label={ko ? "에이전트 목록" : "Agent roster"}><IconSidebar size={17} /></button><div className={styles.agentTitle}><IconGithub size={20} /><strong>{locale === "en" ? selectedProfile.nameEn : selectedProfile.name}</strong></div><span className={styles.state}>{ko ? "읽기 전용 Hub 참조" : "Read-only Hub reference"}</span></header><article className={styles.detail}><dl className={styles.definition}><dt>{ko ? "정의 ID" : "Definition"}</dt><dd>{selectedProfile.agentDefinitionId}</dd><dt>{ko ? "릴리스 ID" : "Release"}</dt><dd>{selectedProfile.agentReleaseId}</dd>{selectedProfile.componentId && <><dt>{ko ? "구성원 ID" : "Component"}</dt><dd>{selectedProfile.componentId}</dd></>}<dt>{ko ? "최근 사용" : "Last use"}</dt><dd>{selectedProfile.lastUsedAt ? new Date(selectedProfile.lastUsedAt).toLocaleString(locale) : "—"}</dd><dt>{ko ? "사용 횟수" : "Uses"}</dt><dd>{selectedProfile.useCount}</dd></dl><div className={styles.banner} style={{ marginTop: 20 }}>{ko ? "이 참조에는 로컬 원본 파일 편집 권한이 없습니다." : "This reference has no permission to edit local source files."}</div><Link className={styles.button} href="/marketplace" style={{ marginTop: 14 }}><IconGithub size={14} />{ko ? "Hub 열기" : "Open Hub"}</Link></article></div>
      : selectedAgent ? <AgentWorkspace key={selectedAgent.id} agent={selectedAgent} name={displayName(selectedAgent, locale)} locale={locale} initialView={initialView(params.get("tab"))} onToggleRoster={() => setRosterCollapsed((current) => !current)} projectControl={projectControl} firm={activeFirm} org={selectedOrg} binding={bindings.find((item) => item.installedAgentId === selectedAgent.id)} runtimes={runtimes} overrides={overrides} onRename={rename} onRemove={remove} onOverridesChange={setOverrides} onDirtyChange={setDirty} />
      : <div className={styles.empty}><IconFolder size={40} /><strong>{loading ? (ko ? "에이전트 읽는 중" : "Reading agents") : (ko ? "에이전트를 선택하세요" : "Select an agent")}</strong>{!loading && <button className={styles.button} disabled={Boolean(busy)} onClick={() => void action("import", importFolder)}><IconFileUp size={14} />{ko ? "로컬 폴더 가져오기" : "Import local folder"}</button>}</div>}
      {notice && <div className={styles.toast} role="status">{notice}</div>}
    </div>
  </div>;
}
