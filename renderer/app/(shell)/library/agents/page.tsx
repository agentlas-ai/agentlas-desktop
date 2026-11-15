"use client";

import { confirmPopup } from "@/lib/popup";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentWorkspace, type AgentWorkspaceView } from "@/components/agent-workspace/AgentWorkspace";
import styles from "@/components/agent-workspace/AgentWorkspace.module.css";
import { IconAlertTriangle, IconBuilding, IconCheck, IconChevronDown, IconDownload, IconChevronRight, IconClose, IconFileUp, IconFolder, IconCloud, IconLayers, IconPlus, IconRefresh, IconSearch, IconShield, IconSidebar, IconTrash } from "@/components/Icon";
import { buildAgentRoster, ownerListedAgents } from "@/lib/agent-roster";
import { onAgentRosterChange } from "@/lib/agent-roster-events";
import { isUserFacingAgentText } from "@/lib/agent-visibility";
import { ipc } from "@/lib/ipc";
import { agentWorkspaceFailure } from "@/lib/agent-workspace-error";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";
import { firmPoolMember, installedAgentPoolMember, installedTeamPoolMember } from "@/lib/project-agent-roster";
import { projectPoolMemberKey, projectPoolMemberReferences } from "@shared/project-agent-pool";
import type { AgentRuntimeOverride, BorrowedAgentProfile, InstalledAgent, InstalledAgentExactBinding, InstalledFirm, MarketplaceListing, Project, ResolvedOrg, RuntimeStatus } from "@shared/types";
import { Select } from "@/components/Select";

const ROSTER_WIDTH_KEY = "agentlas.agentRosterWidth";
const ROSTER_WIDTH_DEFAULT = 220;
const ROSTER_WIDTH_MIN = 180;
const ROSTER_WIDTH_MAX = 480;

function displayName(agent: InstalledAgent, locale: Locale): string {
  return agent.localDisplayName?.trim() || pickLocalized(agent, locale).name || agent.slug;
}
type HeldLocalAgent = Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["agents"]["heldLocal"]>>[number];
function heldImportReason(code: string, ko: boolean): string {
  switch (code) {
    case "folder_missing": return ko ? "가져오지 못했어요: 폴더를 찾을 수 없어요. 폴더가 있는 곳을 확인해 주세요." : "Could not import: the folder was not found. Check that it is still there.";
    case "no_agent_in_folder": return ko ? "가져오지 못했어요: 이 폴더에서 에이전트를 찾지 못했어요." : "Could not import: no agent was found in this folder.";
    case "not_a_held_local_agent": return ko ? "가져오지 못했어요: 이 항목이 더 이상 가져올 목록에 없어요. 목록을 새로고침해 주세요." : "Could not import: this item is no longer on the import list. Refresh the list.";
    default: return ko ? "가져오지 못했어요. 폴더를 확인한 뒤 다시 눌러 주세요." : "Could not import it. Check the folder and press Import again.";
  }
}
function sourceOf(agent: InstalledAgent, bindings: InstalledAgentExactBinding[]): "local" | "cloud" | "hub" {
  if (agent.assetSource === "local-import") return "local";
  if (agent.assetSource === "hub") return "hub";
  if (agent.assetSource === "agent-cloud") return "cloud";
  const binding = bindings.find((item) => item.installedAgentId === agent.id);
  if (binding?.source === "hub-install") return "hub";
  if (binding?.source === "agent-cloud-restore") return "cloud";
  return "local";
}
function initialView(value: string | null): AgentWorkspaceView {
  // The five tabs are Timeline, Memory, Skills, Files and Sync. Older links keep working: `?tab=memory` has always meant what the agent remembers,
  // `?tab=skills` the learning review, and the model / rooms / activity / history pages now live in the Timeline (the model opens from the profile head).
  if (value === "recall" || value === "memory" || value === "ontology") return "memory";
  if (value === "skills") return "skills";
  if (value === "files") return "files";
  if (value === "changes" || value === "sync") return value;
  return "timeline";
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
  const [held, setHeld] = useState<HeldLocalAgent[]>([]);
  // Import attempts that failed: the row stays (even if the queue no longer lists it) with its reason, until the import works or the folder is dismissed.
  const [heldFailures, setHeldFailures] = useState<Record<string, { candidate: HeldLocalAgent; reason: string }>>({});
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId] = useState("");
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
  const [rosterCollapsed, setRosterCollapsed] = useState(false);
  const [rosterWidth, setRosterWidth] = useState(ROSTER_WIDTH_DEFAULT);
  useEffect(() => { try { const saved = Number(window.localStorage.getItem(ROSTER_WIDTH_KEY)); if (Number.isFinite(saved) && saved >= ROSTER_WIDTH_MIN && saved <= ROSTER_WIDTH_MAX) setRosterWidth(saved); } catch { /* A blocked store keeps the default width. */ } }, []);
  const startRosterResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX; const startWidth = rosterWidth; let latest = startWidth;
    const move = (next: PointerEvent) => { latest = Math.max(ROSTER_WIDTH_MIN, Math.min(ROSTER_WIDTH_MAX, startWidth + next.clientX - startX)); setRosterWidth(latest); };
    const end = () => { window.removeEventListener("pointermove", move); try { window.localStorage.setItem(ROSTER_WIDTH_KEY, String(latest)); } catch { /* Width is a preference only. */ } };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  };
  const resetRosterWidth = () => { setRosterWidth(ROSTER_WIDTH_DEFAULT); try { window.localStorage.removeItem(ROSTER_WIDTH_KEY); } catch { /* Preference only. */ } };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const [published, setPublished] = useState<MarketplaceListing[]>([]);
  const [publishedSignedIn, setPublishedSignedIn] = useState<boolean | null>(null);
  const [publishedLoading, setPublishedLoading] = useState(false);
  const [memoryCounts, setMemoryCounts] = useState<Record<string, number>>({});
  const memoryCountGeneration = useRef(0);
  const memoryCountVersions = useRef(new Map<string, number>());
  const refreshGeneration = useRef(0);
  const dirty = useRef(false);
  const roster = useMemo(() => buildAgentRoster(ownerListedAgents(agents), firms), [agents, firms]);
  const allAgents = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const selectedFirm = firms.find((firm) => firm.id === selectedFirmId) ?? null;
  const selectedAgent = allAgents.get(selectedId || selectedFirm?.ceoAgentId || "") ?? null;
  const activeFirm = selectedFirm ?? firms.find((firm) => firm.id === contextFirmId) ?? firms.find((firm) => firm.orgChart.some((node) => node.agentId === selectedAgent?.id) || firm.ceoAgentId === selectedAgent?.id) ?? null;
  const selectedProfile = borrowed.find((profile) => profile.profileId === selectedBorrowedId) ?? null;
  const setDirty = useCallback((next: boolean) => { dirty.current = next; }, []);
  const onMemoryCountChange = useCallback((agentId: string, count: number) => {
    memoryCountVersions.current.set(agentId, (memoryCountVersions.current.get(agentId) ?? 0) + 1);
    setMemoryCounts(current => ({ ...current, [agentId]: count }));
  }, []);
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
    const results = await Promise.allSettled([api.team.list(), api.firms.list(), api.agents.exactBindings(), api.projects.list(), api.runtime.detect(), api.agentRuntime.list(), api.agents.borrowedProfiles(), api.agents.heldLocal ? api.agents.heldLocal() : Promise.resolve([])]);
    if (generation !== refreshGeneration.current) return;
    // A read that answers "nothing" (null / not a list: no agents yet, a first run) is an empty list, never a crash of the screen.
    const asList = <T,>(value: readonly T[] | null | undefined): T[] => (Array.isArray(value) ? [...value] : []);
    const [agentResult, firmResult, bindingResult, projectResult, runtimeResult, overrideResult, borrowedResult, heldResult] = results;
    if (agentResult.status === "fulfilled") setAgents(asList(agentResult.value));
    if (firmResult.status === "fulfilled") setFirms(asList(firmResult.value));
    if (bindingResult.status === "fulfilled") setBindings(asList(bindingResult.value));
    if (projectResult.status === "fulfilled") { setProjects(asList(projectResult.value)); }
    if (runtimeResult.status === "fulfilled") setRuntimes(asList(runtimeResult.value));
    if (overrideResult.status === "fulfilled") setOverrides(asList(overrideResult.value));
    if (borrowedResult.status === "fulfilled") setBorrowed(asList(borrowedResult.value));
    if (heldResult.status === "fulfilled") setHeld(asList(heldResult.value));
    const failed = results.filter((result) => result.status === "rejected");
    setError(failed.length ? `${ko ? "일부 정보를 읽지 못했습니다: " : "Some data could not be read: "}${failed.map((result) => result.status === "rejected" ? agentWorkspaceFailure(result.reason, ko) : "").join(" · ")}` : "");
    setLoading(false);
  }, [ko]);
  useEffect(() => { void refresh(); return () => { refreshGeneration.current++; }; }, [refresh]);
  useEffect(() => onAgentRosterChange(() => { void refresh(); }), [refresh]);
  // Leftover memory cleanup of agents removed earlier: a read-only count (the retry itself runs at app start and after the next removal), said in one line while some wait.
  useEffect(() => {
    let cancelled = false;
    void ipc()?.agents.forgetPending?.().then((state) => {
      if (!cancelled && state.pending > 0) setNotice(ko ? `지운 에이전트의 기억 정리가 ${state.pending}건 남아 있어요. 다음에 다시 시도합니다.` : `${state.pending} memory cleanup${state.pending === 1 ? "" : "s"} of removed agents ${state.pending === 1 ? "is" : "are"} still waiting; they will be retried.`);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [ko]);
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
    catch (failure) { setError(agentWorkspaceFailure(failure, ko)); }
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
    try { await task(); } catch (failure) { setError(agentWorkspaceFailure(failure, ko)); } finally { setBusy(""); }
  }
  async function importFolder() {
    const api = ipc(); if (!api) return;
    const selection = await api.fs.pickDirectory(); if (!selection) return;
    const agent = await api.team.importLocalFolder({ path: selection.path, scope: selection.scope });
    await refresh(); await chooseAgent(agent); setNotice(ko ? "로컬 에이전트를 가져왔습니다." : "Local agent imported.");
  }
  async function importHeld(candidate: HeldLocalAgent) {
    const api = ipc(); if (!api) return;
    try {
      await api.agents.importHeldLocal(candidate.ref);
    } catch (failure) {
      // The rejection message IS the reason code. The candidate stays on this list (with its reason) so the owner can fix the folder and press Import again;
      // nothing disappears without a line on screen.
      // Electron wraps the rejection ("Error invoking remote method '…': Error: <code>"), so the code is found in the text, not assumed to be all of it.
      const code = /\b(folder_missing|no_agent_in_folder|import_failed|not_a_held_local_agent)\b/.exec(failure instanceof Error ? failure.message : String(failure))?.[1] ?? "";
      const reason = heldImportReason(code, ko);
      setHeldFailures((current) => ({ ...current, [candidate.ref]: { candidate, reason } }));
      await refresh();
      setNotice(reason);
      return;
    }
    setHeldFailures((current) => { const next = { ...current }; delete next[candidate.ref]; return next; });
    await refresh();
    setNotice(ko ? "에이전트를 가져왔습니다." : "Agent imported.");
  }
  // 화면 입구는 없다(오너 결정: 에이전트는 프로젝트별로 나누지 않는다). 고정된 검증 계약(assertAttachmentIdentity)이
  // 이 함수의 정의를 요구해 남겨 둔다 — 검증 세트를 새로 고정할 때 함께 지운다.
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
  async function remove(targetAgent: InstalledAgent | null = selectedAgent, targetFirm: InstalledFirm | null = selectedFirm, clearSelection = true) {
    const api = ipc(); if (!api || !targetAgent) return;
    if (clearSelection && !await mayChangeAgent()) return;
    const entityIds = targetFirm ? [targetFirm.ceoAgentId, ...targetFirm.orgChart.map((node) => node.agentId)] : [targetAgent.id];
    const referenceSet = { agentIds: new Set(entityIds), firmIds: new Set(targetFirm ? [targetFirm.id] : []), remoteTargetIds: new Set(entityIds.map((id) => allAgents.get(id)?.slug.toLowerCase()).filter((slug): slug is string => Boolean(slug))) };
    const affected = projects.filter((project) => project.agentPool.some((member) => projectPoolMemberReferences(member, referenceSet)));
    const origin = sourceOf(targetAgent, bindings);
    let preserved = ko ? "대화 기록은 유지됩니다." : "Conversation history is preserved.";
    if (!targetFirm) { try { const preview = await api.team.uninstallPreview(targetAgent.id); preserved = ko ? `좌석 ${preview.seatCount}곳이 비며 대화 ${preview.chatCount}개는 유지됩니다.` : `${preview.seatCount} seats become empty; ${preview.chatCount} conversations are preserved.`; } catch { /* No invented impact counts. */ } }
    const sourceAction = origin === "cloud" ? (ko ? "Cloud 원격 자산도 삭제됩니다." : "The Cloud asset is also deleted.") : origin === "hub" ? (ko ? "Hub 북마크도 제거됩니다." : "The Hub bookmark is also removed.") : "";
    const folderLine = ko ? "내가 가져온 폴더(제자리 등록)는 지워지지 않고, 앱이 만든 폴더만 휴지통으로 옮깁니다." : "A folder you registered in place is not deleted; only a folder the app created moves to Trash.";
    const memoryLine = ko ? "이 에이전트의 기억도 지워집니다." : "This agent's memory is also erased.";
    const name = targetFirm ? pickLocalized(targetFirm, locale).name : displayName(targetAgent, locale);
    if (!await confirmPopup(`${ko ? `‘${name}’ 제거?` : `Remove “${name}”?`}\n${memoryLine}${sourceAction ? `\n${sourceAction}` : ""}\n${folderLine}\n${preserved}${affected.length ? `\n${ko ? "장착 해제" : "Detach from"}: ${affected.map((project) => project.name).join(", ")}` : ""}`, { locale, tone: "danger", confirmLabel: ko ? "제거" : "Remove" })) return;
    if (origin === "cloud") await api.marketplace.deleteMine(targetAgent.slug);
    if (origin === "hub") await api.marketplace.bookmarkRemove(targetAgent.slug, targetFirm || targetAgent.kind === "team" ? "team" : "agent");
    const result = targetFirm ? await api.firms.uninstall(targetFirm.id, { removeMembers: true, removeSource: true }) : await api.team.uninstall(targetAgent.id, { removeSource: true });
    if (clearSelection) { setSelectedId(""); setSelectedFirmId(""); dirty.current = false; } await refresh();
    const left = await api.agents?.forgetPending?.().then((state) => state.pending).catch(() => 0) ?? 0;
    setNotice(`${ko ? "제거했습니다." : "Removed."}${left > 0 ? (ko ? ` 기억 정리가 ${left}건 남아 다음에 다시 시도합니다.` : ` ${left} memory cleanup${left === 1 ? "" : "s"} left; they will be retried.`) : ""}`);
  }
  const heldRows = [...held, ...Object.values(heldFailures).map((entry) => entry.candidate).filter((candidate) => !held.some((item) => item.ref === candidate.ref))];
  const matches = (agent: InstalledAgent) => (source === "all" || sourceOf(agent, bindings) === source) && (!query.trim() || [displayName(agent, locale), agent.slug].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  // One flat list: installed teams and firms are just more agents here; the team/single split is gone from the screen.
  const firmMatches = (firm: InstalledFirm) => {
    const controller = allAgents.get(firm.ceoAgentId);
    return (source === "all" || (controller ? sourceOf(controller, bindings) === source : source === "local")) && (!query.trim() || [pickLocalized(firm, locale).name, firm.slug, ...firm.orgChart.map((node) => allAgents.get(node.agentId) ? displayName(allAgents.get(node.agentId)!, locale) : node.role)].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  };
  const multiAgentIds = new Set(roster.standaloneMultiAgents.map((agent) => agent.id));
  type RosterEntry = { key: string; name: string; agent?: InstalledAgent; firm?: InstalledFirm };
  const entries: RosterEntry[] = [
    ...[...roster.singleModeAgents, ...roster.standaloneMultiAgents].filter(matches).map((agent): RosterEntry => ({ key: agent.id, name: displayName(agent, locale), agent })),
    ...roster.multiFirms.filter(firmMatches).map((firm): RosterEntry => ({ key: `firm:${firm.id}`, name: pickLocalized(firm, locale).name, firm })),
  ].sort((a, b) => a.name.localeCompare(b.name, locale));
  const installedExactPairs = new Set(bindings.map((binding) => `${binding.agentDefinitionId}:${binding.agentReleaseId}`));
  const borrowedRows = borrowed.filter((profile) => (profile.componentId || !installedExactPairs.has(`${profile.agentDefinitionId}:${profile.agentReleaseId}`)) && (source === "all" || source === "hub") && (!query.trim() || [profile.name, profile.nameEn, profile.slug].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
  const badgeAgentKey = JSON.stringify([...new Set(entries.flatMap((entry) => entry.firm
    ? [entry.firm.ceoAgentId, ...(!rosterCollapsed && expandedTeams.has(entry.firm.id) ? entry.firm.orgChart.filter(node => isUserFacingAgentText(allAgents.get(node.agentId)?.name ?? node.role, node.role)).map(node => node.agentId) : [])]
    : [entry.agent!.id, ...(multiAgentIds.has(entry.agent!.id) && !rosterCollapsed && expandedTeams.has(entry.agent!.id) ? agents.filter(agent => agent.parentTeamId === entry.agent!.id).map(agent => agent.id) : [])]))].sort());
  useEffect(() => {
    const bridge = ipc()?.agentWorkspace;
    if (!bridge?.memoryCounts) return;
    const generation = ++memoryCountGeneration.current;
    const ids = JSON.parse(badgeAgentKey) as string[];
    const versions = new Map(ids.map(id => [id, memoryCountVersions.current.get(id) ?? 0]));
    void (async () => {
      for (let offset = 0; offset < ids.length; offset += 250) {
        const batch = ids.slice(offset, offset + 250);
        let counts: Record<string, number> = {};
        try { counts = (await bridge.memoryCounts(batch)).counts; } catch { /* Unknown counts stay absent, never zero. */ }
        if (generation !== memoryCountGeneration.current) return;
        setMemoryCounts(current => {
          const next = { ...current };
          for (const id of batch) {
            // A live Workspace refresh may be newer than this roster request.
            if (versions.get(id) !== (memoryCountVersions.current.get(id) ?? 0)) continue;
            if (Number.isInteger(counts[id]) && counts[id] >= 0) next[id] = counts[id]; else delete next[id];
          }
          return next;
        });
      }
    })();
    return () => { memoryCountGeneration.current++; };
  }, [badgeAgentKey, agents, firms]);
  const memoryBadge = (agentId: string) => typeof memoryCounts[agentId] === "number" && memoryCounts[agentId] > 0 ? <span className={styles.memoryCount} title={ko ? `검토할 학습 ${memoryCounts[agentId]}개` : `${memoryCounts[agentId]} learnings to review`} aria-label={ko ? `검토할 학습 ${memoryCounts[agentId]}개` : `${memoryCounts[agentId]} learnings to review`}>{memoryCounts[agentId]}</span> : null;
  const rowButton = (agent: InstalledAgent, firmId = "", child = false, contextId = firmId) => <button className={`${styles.rosterRow} ${child ? styles.subRow : ""} ${selectedId === agent.id && !selectedBorrowedId ? styles.selected : ""}`} onClick={() => void chooseAgent(agent, firmId, contextId)} title={displayName(agent, locale)} aria-pressed={selectedId === agent.id && !selectedBorrowedId}><AgentAvatar name={displayName(agent, locale)} agentId={agent.id} size={26} />{!rosterCollapsed && <><span className={styles.rosterText}>{displayName(agent, locale)}</span>{agent.bookmarkedAt && <IconCheck size={10} />}{agent.sourceMissingSince && <span className={styles.sourceWarning} title={ko ? "원본 연결 끊김" : "Source disconnected"}><IconAlertTriangle size={12} /></span>}{memoryBadge(agent.id)}</>}</button>;
  const deletable = (key: string, name: string, node: ReactNode, onDelete: () => Promise<void>) => <div key={key} className={styles.rowWrap}>{node}{!rosterCollapsed && <button type="button" className={styles.rowDelete} disabled={Boolean(busy)} title={ko ? `${name} 삭제` : `Delete ${name}`} aria-label={ko ? `${name} 삭제` : `Delete ${name}`} onClick={(event) => { event.stopPropagation(); void action("remove", onDelete); }}><IconTrash size={13} /></button>}</div>;
  const row = (agent: InstalledAgent, firmId = "", child = false, contextId = firmId) => deletable(`${firmId}:${agent.id}`, displayName(agent, locale), rowButton(agent, firmId, child, contextId), () => remove(agent, null, agent.id === selectedId));

  return <div className={styles.shell} data-testid="manage-agent-workspace">
    {!rosterCollapsed && <button className={`${styles.scrim} ${styles.rosterScrim}`} aria-label={ko ? "에이전트 목록 닫기" : "Close agent roster"} onClick={() => setRosterCollapsed(true)} />}
    <aside className={`${styles.roster} ${rosterCollapsed ? styles.rosterCollapsed : ""}`} style={rosterCollapsed ? undefined : { width: rosterWidth, flexBasis: rosterWidth }} data-tour-id="agents.roster">
      <div className={styles.rosterHeader}>{!rosterCollapsed && <strong>{publishedView ? (ko ? "게시 자산" : "Published assets") : (ko ? "에이전트" : "Agents")}</strong>}<button className={`${styles.iconButton} ${styles.rosterToggleBtn}`} aria-label={ko ? "에이전트 목록 접기/펴기" : "Toggle agent roster"} title={ko ? "에이전트 목록" : "Agent roster"} onClick={() => setRosterCollapsed((current) => !current)}><IconSidebar size={17} /></button><button className={styles.iconButton} disabled={Boolean(busy)} onClick={() => void action("import", importFolder)} aria-label={ko ? "로컬 폴더 가져오기" : "Import local folder"} title={ko ? "로컬 폴더 가져오기" : "Import local folder"}><IconFileUp size={17} /></button>{!rosterCollapsed && <Link className={styles.iconButton} href="/build" aria-label={ko ? "에이전트 만들기" : "Build agent"} title={ko ? "에이전트 만들기" : "Build agent"}><IconPlus size={17} /></Link>}</div>
      {!rosterCollapsed && <div className={styles.search}><IconSearch size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label={ko ? "에이전트 검색" : "Search agents"} placeholder={ko ? "에이전트 검색" : "Search agents"} /></div>}
      <div className={styles.rosterRows}>{loading && <div className={styles.empty}><span className={styles.loading} /></div>}
        {!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "에이전트" : "AGENTS"}</span><span>{entries.length}</span></div>}
        {entries.map((entry) => {
          if (entry.firm) { const firm = entry.firm;
          const controller = allAgents.get(firm.ceoAgentId);
          const members = firm.orgChart.filter((node) => isUserFacingAgentText(allAgents.get(node.agentId)?.name ?? node.role, node.role));
          const name = pickLocalized(firm, locale).name;
          return <div key={firm.id}><div className={styles.rosterGroup}>{!rosterCollapsed && <button className={styles.iconButton} aria-label={`${name} ${ko ? "구성원 보기" : "members"}`} aria-expanded={expandedTeams.has(firm.id)} onClick={() => setExpandedTeams((previous) => { const next = new Set(previous); if (next.has(firm.id)) next.delete(firm.id); else next.add(firm.id); return next; })}>{expandedTeams.has(firm.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}{deletable(`firm:${firm.id}`, name, <button className={`${styles.rosterRow} ${selectedFirmId === firm.id && !selectedBorrowedId ? styles.selected : ""}`} title={name} onClick={() => { if (controller) void chooseAgent(controller, firm.id); else { setError(ko ? "팀 실행 에이전트를 찾을 수 없습니다." : "The team controller is missing."); } }}><AgentAvatar name={name} agentId={firm.ceoAgentId} size={26} />{!rosterCollapsed && <><span className={styles.rosterText}>{name}</span>{controller && memoryBadge(controller.id)}</>}</button>, () => remove(controller ?? null, firm, firm.id === selectedFirmId))}</div>{!rosterCollapsed && expandedTeams.has(firm.id) && members.map((node) => { const agent = allAgents.get(node.agentId); return agent ? row(agent, "", true, firm.id) : <div className={`${styles.rosterRow} ${styles.subRow}`} key={`${node.agentId}:${node.role}`}><IconAlertTriangle size={12} /><span className={styles.rosterText}>{node.role}</span></div>; })}</div>;
        }
          const team = entry.agent!;
          if (!multiAgentIds.has(team.id)) return row(team);
 const members = agents.filter((agent) => agent.parentTeamId === team.id); return <div key={team.id}><div className={styles.rosterGroup}>{!rosterCollapsed && members.length > 0 && <button className={styles.iconButton} aria-label={`${displayName(team, locale)} ${ko ? "구성원 보기" : "members"}`} aria-expanded={expandedTeams.has(team.id)} onClick={() => setExpandedTeams((previous) => { const next = new Set(previous); if (next.has(team.id)) next.delete(team.id); else next.add(team.id); return next; })}>{expandedTeams.has(team.id) ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}</button>}{row(team)}</div>{!rosterCollapsed && expandedTeams.has(team.id) && members.map((member) => row(member, "", true))}</div>; })}
        {heldRows.length > 0 && !publishedView && <section aria-label={ko ? "가져올 수 있는 에이전트" : "Agents you can import"} data-testid="held-local-agents">{!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "가져올 수 있는 에이전트" : "CAN BE IMPORTED"}</span><span>{heldRows.length}</span></div>}
          {!rosterCollapsed && heldRows.map((candidate) => <div key={candidate.ref}><div className={styles.heldRow}><div className={styles.rosterRow} title={candidate.ref}><IconFolder size={18} /><span className={styles.rosterText}>{candidate.name || candidate.ref.split(/[\\/]/).filter(Boolean).at(-1) || candidate.ref}</span></div>{heldFailures[candidate.ref] ? <button type="button" className={styles.button} disabled={Boolean(busy)} aria-label={ko ? `${candidate.name || "에이전트"} 가져오기` : `Import ${candidate.name || "agent"}`} onClick={() => void action("import-held", () => importHeld(candidate))}>{ko ? "다시 시도" : "Try again"}</button>
            : <button type="button" className={styles.importIcon} disabled={Boolean(busy)} title={ko ? "가져오기" : "Import"} aria-label={ko ? `${candidate.name || "에이전트"} 가져오기` : `Import ${candidate.name || "agent"}`} onClick={() => void action("import-held", () => importHeld(candidate))}><IconDownload size={16} /></button>}</div>{heldFailures[candidate.ref] && <div className={styles.sourceWarning} role="alert" data-testid="held-import-failure" style={{ display: "block", whiteSpace: "normal", padding: "2px 10px 6px", fontSize: 12, lineHeight: 1.4 }}>{heldFailures[candidate.ref].reason}</div>}</div>)}</section>}
        {borrowedRows.length > 0 && <>{!rosterCollapsed && <div className={styles.groupLabel}><span>{ko ? "Hub" : "HUB"}</span><span>{borrowedRows.length}</span></div>}{borrowedRows.map((profile) => <button key={profile.profileId} className={`${styles.rosterRow} ${selectedBorrowedId === profile.profileId ? styles.selected : ""}`} title={locale === "en" ? profile.nameEn : profile.name} onClick={async () => { if (!await mayChangeAgent()) return; setSelectedBorrowedId(profile.profileId); }}><IconCloud size={18} />{!rosterCollapsed && <><span className={styles.rosterText}>{locale === "en" ? profile.nameEn : profile.name}</span><IconShield size={11} /></>}</button>)}</>}
        {!loading && !agents.length && !firms.length && !borrowed.length && <div className={styles.empty}><IconFolder size={28} />{!rosterCollapsed && (ko ? "에이전트 없음" : "No agents")}</div>}
      </div>
    {!rosterCollapsed && <div className={styles.rosterResize} role="separator" aria-orientation="vertical" aria-label={ko ? "목록 너비 조절 (더블클릭: 원래대로)" : "Resize list (double-click to reset)"} title={ko ? "끌어서 너비 조절 · 더블클릭: 원래대로" : "Drag to resize · double-click to reset"} onPointerDown={startRosterResize} onDoubleClick={resetRosterWidth} />}</aside>
    <div className={styles.workspace}>{error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={14} /><span>{error}</span><button className={styles.iconButton} aria-label={ko ? "오류 닫기" : "Dismiss error"} onClick={() => setError("")}><IconClose size={13} /></button></div>}
      {publishedView ? <div className={styles.workspace}><header className={styles.toolbar}><strong>{ko ? "내 게시 자산" : "My published assets"}</strong><button className={styles.iconButton} onClick={() => void loadPublished()} aria-label={ko ? "게시 자산 새로고침" : "Refresh published assets"}><IconRefresh size={15} /></button><Link className={styles.button} href="/library/agents">{ko ? "에이전트 파일" : "Agent files"}</Link></header>{publishedLoading ? <div className={styles.empty}><span className={styles.loading} /></div> : publishedSignedIn === false ? <div className={styles.empty}><IconShield size={30} /><button className={styles.button} onClick={() => void action("sign-in", async () => { const api = ipc(); if (!api) return; await api.auth.signInWithGoogle(); await loadPublished(); })}>{ko ? "로그인" : "Sign in"}</button></div> : <div className={styles.history}>{published.filter((listing) => !query.trim() || [listing.name, listing.nameEn, listing.slug].some((value) => value?.toLowerCase().includes(query.toLowerCase()))).map((listing) => <div className={styles.revisionBody} key={listing.slug}><div className={styles.revisionTitle}><IconBuilding size={17} /><strong>{pickLocalized(listing, locale).name}</strong><code className={styles.meta}>{listing.slug}</code><button className={styles.button} disabled={Boolean(busy) || agents.some((agent) => agent.slug === listing.slug)} onClick={() => void action("install", async () => { const api = ipc(); if (!api || !await mayChangeAgent()) return; const installed = await api.team.installMine(listing.slug); await refresh(); await chooseAgent(installed); setNotice(ko ? "설치했습니다. 에이전트 파일에서 확인하세요." : "Installed. Open Agent files to inspect it."); })}><IconFileUp size={12} />{agents.some((agent) => agent.slug === listing.slug) ? (ko ? "설치됨" : "Installed") : (ko ? "로컬 설치" : "Install locally")}</button></div></div>)}{!published.length && <div className={styles.empty}>{ko ? "게시 자산 없음" : "No published assets"}</div>}</div>}</div>
      : selectedProfile ? <div className={styles.workspace} data-testid="borrowed-agent-detail"><header className={styles.toolbar}><button className={styles.iconButton} onClick={() => setRosterCollapsed((current) => !current)} aria-label={ko ? "에이전트 목록" : "Agent roster"}><IconSidebar size={17} /></button><div className={styles.agentTitle}><IconCloud size={20} /><strong>{locale === "en" ? selectedProfile.nameEn : selectedProfile.name}</strong></div><span className={styles.state}>{ko ? "읽기 전용 Hub 참조" : "Read-only Hub reference"}</span></header><article className={styles.detail}><dl className={styles.definition}><dt>{ko ? "정의 ID" : "Definition"}</dt><dd>{selectedProfile.agentDefinitionId}</dd><dt>{ko ? "릴리스 ID" : "Release"}</dt><dd>{selectedProfile.agentReleaseId}</dd>{selectedProfile.componentId && <><dt>{ko ? "구성원 ID" : "Component"}</dt><dd>{selectedProfile.componentId}</dd></>}<dt>{ko ? "최근 사용" : "Last use"}</dt><dd>{selectedProfile.lastUsedAt ? new Date(selectedProfile.lastUsedAt).toLocaleString(locale) : "—"}</dd><dt>{ko ? "사용 횟수" : "Uses"}</dt><dd>{selectedProfile.useCount}</dd></dl><div className={styles.banner} style={{ marginTop: 20 }}>{ko ? "이 참조에는 로컬 원본 파일 편집 권한이 없습니다." : "This reference has no permission to edit local source files."}</div><Link className={styles.button} href="/marketplace" style={{ marginTop: 14 }}><IconCloud size={14} />{ko ? "Hub 열기" : "Open Hub"}</Link></article></div>
      : selectedAgent ? <AgentWorkspace key={selectedAgent.id} agent={selectedAgent} name={displayName(selectedAgent, locale)} locale={locale} initialView={initialView(params.get("tab"))} onToggleRoster={() => setRosterCollapsed((current) => !current)} runtimes={runtimes} onRename={rename} onDirtyChange={setDirty} onMemoryCountChange={onMemoryCountChange} />
      : <div className={styles.empty}><IconFolder size={40} /><strong>{loading ? (ko ? "에이전트 읽는 중" : "Reading agents") : (ko ? "에이전트를 선택하세요" : "Select an agent")}</strong>{!loading && <button className={styles.button} disabled={Boolean(busy)} onClick={() => void action("import", importFolder)}><IconFileUp size={14} />{ko ? "로컬 폴더 가져오기" : "Import local folder"}</button>}</div>}
      {notice && <div className={styles.toast} role="status">{notice}</div>}
    </div>
  </div>;
}
