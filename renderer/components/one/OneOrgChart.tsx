import { useEffect, useMemo, useRef, useState } from "react";
import type { HubAgentBookmark, InstalledAgent, InstalledMcpServer, MarketplaceListing, McpServerStatus, McpToolCatalogEntry } from "@shared/types";
import type { OneOrgCollaborationStyle, OneOrgMember, OneOrgState } from "@shared/one-org";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { OneBottomSheet } from "./OneBottomSheet";
import { AgentLeaseDialog } from "@/components/AgentLeaseDialog";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { ipc } from "@/lib/ipc";
import styles from "./OneOrgChart.module.css";
import {
  IconApps,
  IconCheck,
  IconClose,
  IconCode,
  IconEdit,
  IconPlus,
  IconSearch,
  IconShield,
  IconSparkles,
} from "@/components/Icon";

export interface OneOrgSearchItem {
  id: string;
  title: string;
  detail: string;
}

function sourceLabel(source: OneOrgMember["source"], locale: string): string {
  if (locale === "ko") return source === "local" ? "로컬" : source === "cloud" ? "클라우드" : "허브";
  return source;
}

function statusLine(member: OneOrgMember, locale: string): string {
  return locale === "ko" ? member.statusLine : member.statusLineEn;
}

function memberEntryAriaLabel(member: OneOrgMember, locale: string): string {
  return `${member.displayName} · ${statusLine(member, locale)}${member.statusKind === "failed" ? ` · ${locale === "ko" ? "실행 실패" : "Run failed"}` : ""}${member.unreadCount > 0 ? ` · ${locale === "ko" ? `읽지 않은 결과 ${member.unreadCount}개` : `${member.unreadCount} unread result${member.unreadCount === 1 ? "" : "s"}`}` : ""}`;
}

function shouldOpenOneOrgRowFromKeyboard(key: string, eventOriginatesOnRow: boolean): boolean {
  return eventOriginatesOnRow && (key === "Enter" || key === " ");
}

function activityTimeLabel(member: OneOrgMember, locale: string): string {
  if (!member.lastActivityAt) return sourceLabel(member.source, locale);
  const date = new Date(member.lastActivityAt);
  if (!Number.isFinite(date.getTime())) return sourceLabel(member.source, locale);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  if (sameDay) return date.toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", { hour: "numeric", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  const wasYesterday = date.getFullYear() === yesterday.getFullYear()
    && date.getMonth() === yesterday.getMonth()
    && date.getDate() === yesterday.getDate();
  if (wasYesterday) return locale === "ko" ? "어제" : "Yesterday";
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { weekday: "short" });
}

function memberKind(member: OneOrgMember, installedAgents: InstalledAgent[], locale: string): string {
  const installed = installedAgents.find((agent) => agent.id === member.installedAgentId);
  if (installed?.kind === "team") return locale === "ko" ? "팀" : "Team";
  return locale === "ko" ? "단일" : "Single";
}

function leaseLabel(member: OneOrgMember, locale: string): string | null {
  if (!member.leaseExpiresAt) return null;
  const date = new Date(member.leaseExpiresAt);
  if (!Number.isFinite(date.getTime())) return null;
  return locale === "ko"
    ? `${date.getMonth() + 1}/${date.getDate()} 만료`
    : `Expires ${date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}`;
}

type PendingHubAdd = {
  listing: MarketplaceListing;
  leasedUntil: string;
  installed?: InstalledAgent;
};

function validLeaseExpiry(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now() ? value : null;
}

function hubLeaseQuoteError(code: string | undefined, ko: boolean): string {
  if (code === "signed_out") return ko ? "Agentlas 로그인이 필요합니다. 로그인 후 다시 시도하세요." : "Sign in to Agentlas, then try again.";
  if (code === "account_changed") return ko ? "계정이 바뀌어 이전 대여 조건을 적용하지 않았습니다. 현재 계정에서 다시 시도하세요." : "The account changed, so the previous lease terms were discarded. Try again for the current account.";
  if (code === "lease_not_offered") return ko ? "이 Hub 에이전트는 장기대여를 제공하지 않습니다." : "This Hub agent does not offer long-term leases.";
  return ko ? "Hub 대여 조건을 확인하지 못했습니다. 네트워크를 확인한 뒤 다시 시도하세요." : "The Hub lease terms could not be checked. Check the network and try again.";
}

function AgentInventoryLoading({ locale }: { locale: string }) {
  return <div className={styles.inventoryLoading} role="status" aria-live="polite">
    <span className={styles.inventorySpinner} aria-hidden="true" />
    <span><strong>{locale === "ko" ? "에이전트 목록 불러오는 중" : "Loading agents"}</strong><small>{locale === "ko" ? "저장된 목록을 먼저 확인하고 최신 상태를 동기화합니다." : "Showing cached inventory first, then syncing the latest state."}</small><LoadingEstimate locale={locale === "ko" ? "ko" : "en"} operationKey="one-agent-inventory" expectedSeconds={[1, 20]} /></span>
  </div>;
}

export function OneOrgChart({
  state,
  installedAgents,
  cloudListings,
  hubBookmarks,
  inventoryLoading = false,
  accountSignedIn = null,
  locale,
  onAdd,
  onAddExistingComplete,
  onCreateAgent,
  addRequest,
  onMaterializeSource,
  onRename,
  onUpdate,
  onReplace,
  onArchive,
  onRestore,
  onReorder,
  onFailure,
  onOpenMember,
  onOpenOne,
  onEditOne,
  onEditIdentity,
  sheetRequest,
  oneAvatarIcon,
  activeOne = false,
  activeMemberId,
  activeTaskForceIds,
  onBrowseTools,
  installedPlugins = [],
  pluginCatalog = [],
  pluginStatuses = [],
  onSetAutoSelect,
  onConnectTool,
  onBrowseSource,
  onBrowseCredits,
  onOpenConcurrency,
  conversationResults = [],
  historyResults = [],
  onOpenConversation,
  onOpenHistory,
}: {
  state: OneOrgState | null;
  installedAgents: InstalledAgent[];
  cloudListings: MarketplaceListing[];
  hubBookmarks: HubAgentBookmark[];
  inventoryLoading?: boolean;
  /** null = 세션 미확인 — 그때는 로그인 안내 대신 기존 빈 상태 문구를 쓴다(D-10). */
  accountSignedIn?: boolean | null;
  locale: string;
  onAdd: (installedAgentId: string, displayName?: string, leaseExpiresAt?: string | null, characterId?: string) => Promise<void>;
  /** Close the preserved New Agent context only after an explicit picker confirmation succeeds. */
  onAddExistingComplete?: () => void;
  onCreateAgent?: () => void;
  addRequest?: { token: number; source: "my" | "cloud" | "hub" };
  onMaterializeSource: (source: "cloud" | "hub", listing: MarketplaceListing) => Promise<InstalledAgent>;
  onRename: (member: OneOrgMember, displayName: string) => Promise<void>;
  onUpdate?: (member: OneOrgMember, displayName: string, collaborationStyle: OneOrgCollaborationStyle) => Promise<void>;
  onReplace: (member: OneOrgMember, installedAgentId: string, handoverNote?: string) => Promise<void>;
  onArchive: (member: OneOrgMember) => Promise<void>;
  onRestore: (member: OneOrgMember) => Promise<void>;
  onReorder: (orderedIds: string[], expectedRevision: number) => Promise<void>;
  onFailure?: (member: OneOrgMember) => void;
  onOpenMember?: (member: OneOrgMember) => void;
  onOpenOne?: () => void;
  onEditOne?: () => void;
  /** 이름·캐릭터는 '에이전트 만들기'와 같은 창에서 고친다(오너 지적 2026-08-23). */
  onEditIdentity?: (member: OneOrgMember) => void;
  /**
   * 통합 편집 창이 요청한 부속 화면(도구 설정·담당 교체).
   *
   * 창을 하나로 합치면서 이 두 화면의 진입점이 사라졌다. 기능을 잃지 않으려면 통합 창이
   * 여기에 열어 달라고 말할 수 있어야 한다. `token` 은 같은 대상을 다시 눌러도 열리게 한다.
   */
  sheetRequest?: { token: number; kind: "tools" | "replace"; memberId: string };
  /** One 이 프로필에서 고른 캐릭터. 없으면 지금까지의 기본 얼굴. */
  oneAvatarIcon?: string;
  activeOne?: boolean;
  activeMemberId?: string | null;
  activeTaskForceIds?: string[];
  onBrowseTools?: (member: OneOrgMember) => void;
  installedPlugins?: InstalledMcpServer[];
  pluginCatalog?: McpToolCatalogEntry[];
  pluginStatuses?: McpServerStatus[];
  onSetAutoSelect?: (member: OneOrgMember, enabled: boolean) => Promise<void>;
  onConnectTool?: (member: OneOrgMember, serverId?: string) => void;
  onBrowseSource?: (source: "cloud" | "hub") => void;
  onBrowseCredits?: () => void;
  onOpenConcurrency?: () => void;
  conversationResults?: OneOrgSearchItem[];
  historyResults?: OneOrgSearchItem[];
  onOpenConversation?: (id: string) => void;
  onOpenHistory?: (item: OneOrgSearchItem) => void;
}) {
  const ko = locale === "ko";
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<"my" | "cloud" | "hub">("my");
  const [addSearch, setAddSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [leaseDays, setLeaseDays] = useState("0");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [leaseDialogListing, setLeaseDialogListing] = useState<MarketplaceListing | null>(null);
  const [pendingHubAdd, setPendingHubAdd] = useState<PendingHubAdd | null>(null);
  const [editName, setEditName] = useState("");
  const [editorMember, setEditorMember] = useState<OneOrgMember | null>(null);
  /*
   * 앉힐 때는 이름도 캐릭터도 묻지 않는다(오너 지적 2026-08-25:
   * "이미 2번째 사진에서 에이전트 캐릭터 이름 다 설정하는데 왜 또 하냐고").
   *
   * 데려오는 에이전트는 원본 패키지가 이미 이름과 얼굴을 갖고 있다. 그래서 좌석
   * 배치는 **원본 그대로 앉히는 것**이 기본이고, 바꾸고 싶으면 앉힌 뒤 조직도 행의
   * 편집(= 만들기와 같은 창)에서 바꾼다. 2026-08-23 에 여기에 캐릭터 고르기를 넣은
   * 이유였던 "앉히면 얼굴을 못 고른다"는 그 편집 경로로 이미 해결돼 있다.
   */
  const [editStyle, setEditStyle] = useState<OneOrgCollaborationStyle>("default");
  const [replaceId, setReplaceId] = useState("");
  const [handover, setHandover] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [toolsMember, setToolsMember] = useState<OneOrgMember | null>(null);
  const [toolsTab, setToolsTab] = useState<"plugins" | "mcp">("plugins");
  const [toolsBusy, setToolsBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const authEpochRef = useRef(0);
  useEffect(() => {
    const onAuthChanged = () => {
      // Hub purchase/install state is account-owned. Drop the in-memory picker
      // and receipt when the account changes so an old result cannot be seated
      // into the newly selected account; the dialog's durable request key stays
      // scoped for a later retry under its original account.
      authEpochRef.current += 1;
      setLeaseDialogListing(null);
      setPendingHubAdd(null);
      setBusy(false);
      setSelectedAgent("");
      setLeaseDays("0");
      setAddSearch("");
      setAddError(null);
      setAddOpen(false);
    };
    window.addEventListener("agentlas:auth-changed", onAuthChanged);
    return () => window.removeEventListener("agentlas:auth-changed", onAuthChanged);
  }, []);
  useEffect(() => {
    if (!addRequest?.token) return;
    setAddTab(addRequest.source);
    setSelectedAgent("");
    setLeaseDays(addRequest.source === "hub" ? "7" : "0");
    setAddSearch("");
    setAddError(null);
    setRoleFilter(null);
    setAddOpen(true);
  }, [addRequest]);

  /*
   * 통합 편집 창이 "도구 설정" 또는 "담당 교체"를 열어 달라고 하면 여기서 연다.
   * 대상이 지금 조직에 없으면 아무것도 하지 않는다 — 빈 시트를 띄우는 것보다 낫다.
   */
  useEffect(() => {
    if (!sheetRequest?.token) return;
    const member = state?.members.find((row) => row.id === sheetRequest.memberId);
    if (!member) return;
    if (sheetRequest.kind === "tools") {
      setToolsMember(member);
      return;
    }
    /*
     * 이 진입점만 예전 조직원 설정 시트를 그대로 열고 있었다. 그래서 같은
     * 사람을 고치는 창이 두 개로 보였다(오너 지적 2026-08-24: 사진 두 장).
     * 통합 창이 있으면 언제나 그쪽이다.
     *
     * 단 **"담당 교체"는 예외다**(2026-08-25 실측). 그 요청은 "교체 화면을 열어 달라"는
     * 명시적 요청인데, 여기서 통합 편집 창으로 되돌리면 통합 창이 닫혔다가 똑같은 창이
     * 다시 열린다 — 누르면 아무 일도 안 일어나고 이유도 안 알려주는 죽은 버튼이었다.
     * (OneShell 이 onEditIdentity 를 항상 넘기므로 교체 시트는 도달 불가였다.)
     */
    if (onEditIdentity && sheetRequest.kind !== "replace") { onEditIdentity(member); return; }
    setEditorMember(member);
    setEditName(member.displayName);
    setEditStyle(member.collaborationStyle ?? "default");
    setReplaceId("");
    setHandover(false);
  }, [sheetRequest, state?.members]);
  const ghostRoles = locale === "ko" ? ["개발", "마케팅", "리서치"] : ["Engineering", "Marketing", "Research"];
  const active = state?.members.filter((member) => !member.archivedAt) || [];
  const archived = state?.members.filter((member) => Boolean(member.archivedAt)) || [];
  const insufficientCredits = active.filter((member) => member.creditState === "insufficient");
  const usedIds = useMemo(() => new Set(active.map((member) => member.installedAgentId)), [active]);
  const usedSlugs = useMemo(() => new Set(active
    .map((member) => installedAgents.find((agent) => agent.id === member.installedAgentId)?.slug.toLocaleLowerCase())
    .filter((slug): slug is string => Boolean(slug))), [active, installedAgents]);
  const roleTerms: Record<string, string[]> = {
    "개발": ["개발", "dev", "engineer", "code", "software", "build"],
    "마케팅": ["마케팅", "marketing", "growth", "sales", "content"],
    "리서치": ["리서치", "research", "analysis", "analyst", "조사"],
  };
  const replacementCandidates = installedAgents.filter((agent) => !usedIds.has(agent.id) && !agent.parentTeamId);
  const addSearchValue = addSearch.trim().toLocaleLowerCase();
  const candidates = installedAgents.filter((agent) => {
    if (usedIds.has(agent.id)) return false;
    if (agent.assetSource === "agent-cloud" || agent.assetSource === "hub") return false;
    // 팀 패키지의 내부 역할(Orchestrator·Memory Curator 등)은 앉힐 수 있는 사람이 아니다.
    // 팀은 팀으로 앉힌다 — 실측 2026-08-23: 팀 4개가 구성원 25명으로 풀려 목록을 뒤덮었다.
    if (agent.parentTeamId) return false;
    if (!roleFilter) return true;
    const haystack = `${agent.name} ${agent.nameEn} ${agent.tagline} ${agent.taglineEn} ${agent.slug}`.toLocaleLowerCase();
    return (roleTerms[roleFilter] || []).some((term) => haystack.includes(term));
  }).filter((agent) => !addSearchValue || `${agent.name} ${agent.nameEn} ${agent.tagline} ${agent.taglineEn} ${agent.slug}`.toLocaleLowerCase().includes(addSearchValue));
  const taskForce = (activeTaskForceIds || []).map((id) => installedAgents.find((agent) => agent.id === id)).filter(Boolean);
  const hubBookmarkListings = hubBookmarks
    .filter((bookmark) => bookmark.bookmarked !== false)
    .map((bookmark) => ({ ...bookmark.listing, slug: bookmark.slug || bookmark.listing.slug }))
    .filter((listing) => listing.entityKind !== "plugin" && listing.source !== "hub-plugin");
  const remoteCandidates = (addTab === "cloud" ? cloudListings : addTab === "hub" ? hubBookmarkListings : [])
    .filter((listing) => !usedSlugs.has(listing.slug.toLocaleLowerCase()))
    .filter((listing) => !addSearchValue || `${listing.name} ${listing.nameEn} ${listing.tagline} ${listing.taglineEn} ${listing.slug}`.toLocaleLowerCase().includes(addSearchValue));
  const searchValue = searchQuery.trim().toLocaleLowerCase();
  const peopleResults = active.filter((member) => !searchValue || `${member.displayName} ${member.nameEn} ${member.statusLine} ${member.statusLineEn}`.toLocaleLowerCase().includes(searchValue));
  const matchingConversations = conversationResults.filter((item) => !searchValue || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(searchValue)).slice(0, 4);
  const matchingHistory = historyResults.filter((item) => !searchValue || `${item.title} ${item.detail}`.toLocaleLowerCase().includes(searchValue)).slice(0, 4);
  const searchCopy = locale === "ko" ? {
    open: "조직도 검색", placeholder: "조직·대화·기록 검색", close: "검색 닫기",
    people: "사람", conversations: "대화", history: "기록",
    noPeople: "일치하는 조직원이 없습니다.", noConversations: "일치하는 대화가 없습니다.", noHistory: "일치하는 기록이 없습니다.",
  } : {
    open: "Search organisation", placeholder: "Search staff, conversations, and history", close: "Close search",
    people: "People", conversations: "Conversations", history: "History",
    noPeople: "No staff members match.", noConversations: "No conversations match.", noHistory: "No history matches.",
  };
  const addCopy = ko ? {
    slots: "슬롯", used: "사용 중", remaining: "자리 남음", sourceAria: "에이전트 출처",
    myAgents: "내 에이전트", installed: "로컬 에이전트", choose: "에이전트를 선택하세요", search: "에이전트 검색",
    matchingRole: (role: string) => `${role} 역할에 맞는 에이전트`, noMatch: "설치된 에이전트 중 일치하는 역할이 없습니다.", showAll: "전체 목록 보기",
    lease: "대여 기간", permanent: "상주 · 만료 없음",
    modelAuto: "모델 · 자동 배정", modelPreferred: (backend: string) => `에이전트 권장 엔진 ${backend}을 우선 사용합니다.`, modelDefault: "One이 작업과 사용 가능한 런타임에 맞춰 고릅니다.",
    identityNote: "원본의 이름과 캐릭터 그대로 앉습니다. 바꾸려면 앉힌 뒤 조직도에서 편집하세요.",
    team: "팀", single: "단일", add: "이 에이전트 추가", cancel: "취소 / 뒤로",
    localNote: "이 Mac에 설치된 에이전트입니다. 상주 직원으로 추가되며 대여 기간이 없습니다.",
    cloudNote: "내 Agent Cloud에 저장된 에이전트가 바로 표시됩니다. 상주 직원으로 추가되며 대여 기간이 없습니다.",
    hubNote: "Hub에서 북마크한 에이전트만 표시됩니다. 상주 좌석에 붙일 때만 대여 기간을 정합니다.",
    cloudEmpty: "Agent Cloud에 저장된 에이전트가 없습니다.",
    hubEmpty: "북마크한 Hub 에이전트가 없습니다.", cloudBrowse: "Agent Cloud 관리", hubBrowse: "Hub에서 북마크하기",
    cloudSignedOut: "Agentlas 로그인이 필요합니다. 로그인하면 Agent Cloud에 저장한 에이전트가 여기 표시됩니다.",
    hubSignedOut: "Agentlas 로그인이 필요합니다. 로그인하면 Hub에서 북마크한 에이전트가 여기 표시됩니다.",
  } : {
    slots: "Slots", used: "used", remaining: "available", sourceAria: "Agent source",
    myAgents: "My agents", installed: "Local agent", choose: "Choose an agent", search: "Search agents",
    matchingRole: (role: string) => `Agents matching ${role}`, noMatch: "No installed agent matches this role.", showAll: "View all agents",
    lease: "Lease", permanent: "Standing · No expiry",
    modelAuto: "Model · Automatic", modelPreferred: (backend: string) => `Prefers the agent's recommended ${backend} runtime.`, modelDefault: "One chooses for each task from the available runtimes.",
    identityNote: "Joins with the name and character it already has. To change them, edit it in the organisation chart after it joins.",
    team: "Team", single: "Single", add: "Add this agent", cancel: "Cancel / Back",
    localNote: "These agents are installed on this Mac. They join as standing staff with no lease term.",
    cloudNote: "Agents saved in your Agent Cloud appear immediately. They join as standing staff with no lease term.",
    hubNote: "Only agents you bookmarked in Hub appear here. Choose a lease only when attaching one to a standing seat.",
    cloudEmpty: "No agents are saved in Agent Cloud.",
    hubEmpty: "No Hub agents are bookmarked.", cloudBrowse: "Manage Agent Cloud", hubBrowse: "Bookmark in Hub",
    cloudSignedOut: "Sign in to Agentlas to see the agents saved in your Agent Cloud.",
    hubSignedOut: "Sign in to Agentlas to see the Hub agents you bookmarked.",
  };
  const editorCopy = ko ? {
    edit: "편집", defaultTitle: "조직원 편집", basic: "기본 정보", orgName: "이 조직에서 부를 이름", original: "원본 담당", originalFallback: "설치된 에이전트의 역할 정의를 사용합니다.",
    style: "협업 말투", styleDetail: "One이 이 직원에게 일을 넘길 때 적용", modelTools: "모델과 도구", autoDefault: "자동 배정이 기본", modelAuto: "모델 · 자동",
    modelPreferred: (backend: string) => `권장 엔진 ${backend} 우선`, modelDefault: "One이 작업마다 사용 가능한 런타임을 배정",
    modelHint: "직원을 추가할 때 모델을 강제로 고정하지 않습니다. 모델 고정은 팀 전체 실행 계획과 충돌할 수 있어 One 오케스트레이터 모델만 설정 메뉴에서 지정합니다.", openTools: "도구 설정 열기",
    replace: "담당 교체", replaceDetail: "이름·대화·산출물은 유지", otherAgent: "다른 에이전트", chooseReplacement: "교체할 에이전트 선택",
    handover: "전임 담당의 인수인계 메모를 새 담당에게 전달", replaceHint: "교체하면 전임자의 경험·기억과 그 담당 전용 루틴은 이어지지 않습니다.", replaceAction: "선택한 담당으로 교체",
    archive: "해고 대신 보관", cancel: "취소", save: "저장",
  } : {
    edit: "Edit", defaultTitle: "Edit staff member", basic: "Basic information", orgName: "Name in this organisation", original: "Source agent", originalFallback: "Uses the installed agent's role definition.",
    style: "Collaboration style", styleDetail: "Used when One hands work to this staff member", modelTools: "Model and tools", autoDefault: "Assigned automatically", modelAuto: "Model · Automatic",
    modelPreferred: (backend: string) => `Prefers recommended runtime ${backend}`, modelDefault: "One assigns an available runtime for each task",
    modelHint: "A staff member does not pin a model. Per-agent model pins can conflict with the team execution plan, so only the One orchestrator model is selected in Settings.", openTools: "Open tool settings",
    replace: "Replace assignee", replaceDetail: "Keep the name, conversation, and outputs", otherAgent: "Replacement agent", chooseReplacement: "Choose a replacement",
    handover: "Pass a handover note from the previous assignee", replaceHint: "The previous assignee's experience, memory, and dedicated routines do not transfer automatically.", replaceAction: "Replace with selected agent",
    archive: "Archive instead of dismissing", cancel: "Cancel", save: "Save",
  };
  const collaborationStyles: Array<[OneOrgCollaborationStyle, string, string]> = ko ? [
    ["default", "에이전트 기본", "원본 역할과 말투를 그대로 사용"],
    ["concise", "간결하게", "결론과 다음 행동을 먼저"],
    ["warm", "따뜻하게", "협업적이되 위험은 숨기지 않음"],
    ["direct", "직설적으로", "막힘과 선택지를 구체적으로"],
  ] : [
    ["default", "Agent default", "Use the source role and voice"],
    ["concise", "Concise", "Lead with the conclusion and next action"],
    ["warm", "Warm", "Collaborative without hiding risks"],
    ["direct", "Direct", "State blockers and choices precisely"],
  ];
  const toolsCopy = ko ? {
    auto: "자동 선택", autoDetail: "일에 맞는 도구를 실행 시점에 고릅니다.", on: "켜짐", off: "꺼짐",
    plugins: "플러그인", mcp: "MCP", noPlugins: "이 에이전트에 배정된 플러그인이 없습니다.", noMcp: "이 에이전트에 배정된 MCP 서버가 없습니다.",
    permissionNote: "플러그인과 MCP는 다른 목록이지만 실행 시 같은 권한 승인을 거칩니다.",
  } : {
    auto: "Automatic selection", autoDetail: "Chooses the right tools when a task runs.", on: "On", off: "Off",
    plugins: "Plugins", mcp: "MCP", noPlugins: "No plugins are assigned to this agent.", noMcp: "No MCP servers are assigned to this agent.",
    permissionNote: "Plugins and MCP are separate lists, but both use the same permission approval at run time.",
  };
  const selectedInstalled = toolsMember ? installedAgents.find((agent) => agent.id === toolsMember.installedAgentId) : undefined;
  const selectedCandidate = addTab === "my" && selectedAgent ? installedAgents.find((agent) => agent.id === selectedAgent) : undefined;
  const selectedListing = addTab !== "my" && selectedAgent ? remoteCandidates.find((listing) => listing.slug === selectedAgent) : undefined;
  // Capture the auth epoch in the render that opened the lease dialog. A stale
  // promise retains this value even after the auth-change render unmounts it.
  const leaseDialogAuthEpoch = leaseDialogListing ? authEpochRef.current : null;
  const editorInstalled = editorMember ? installedAgents.find((agent) => agent.id === editorMember.installedAgentId) : undefined;
  const assignedTools = (selectedInstalled?.mcpServers ?? []).map((serverId) => {
    const installed = installedPlugins.find((server) => server.id === serverId || server.catalogId === serverId);
    const catalog = pluginCatalog.find((entry) => entry.id === serverId || entry.id === installed?.catalogId);
    const status = installed ? pluginStatuses.find((item) => item.id === installed.id) : undefined;
    return {
      id: installed?.id ?? serverId,
      name: catalog?.name || installed?.name || serverId,
      nameEn: catalog?.nameEn || installed?.nameEn || serverId,
      source: installed?.catalogId || catalog ? ("plugin" as const) : ("custom" as const),
      state: installed?.configurationValid === false || Boolean(status?.missingEnv?.length)
        ? ("needs-connection" as const)
        : installed?.enabled === false
          ? ("disabled" as const)
          : status?.connected === false
            ? ("needs-connection" as const)
            : ("ready" as const),
    };
  });
  const visibleAssignedTools = assignedTools.filter((tool) => toolsTab === "plugins" ? tool.source === "plugin" : tool.source === "custom");

  const completeHubAdd = async (request: PendingHubAdd) => {
    const requestAuthEpoch = authEpochRef.current;
    const isCurrentRequest = () => authEpochRef.current === requestAuthEpoch;
    if (!isCurrentRequest()) return;
    if (!state || state.slots.available <= 0) {
      setAddError(ko ? "One 슬롯이 가득 찼습니다." : "There is no available One slot.");
      setPendingHubAdd(request);
      return;
    }
    setBusy(true);
    setAddError(null);
    let installed = request.installed;
    try {
      // The receipt is kept in component state before install/seat mutation. A retry
      // after either step fails therefore never purchases the same lease again.
      installed = installed ?? await onMaterializeSource("hub", request.listing);
      if (!isCurrentRequest()) return;
      if (!installed) throw new Error(ko ? "에이전트를 찾을 수 없습니다." : "The selected agent could not be found.");
      setPendingHubAdd({ ...request, installed });
      /*
       * 이름·캐릭터를 보내지 않는다 = 원본 패키지의 이름과 얼굴 그대로 앉는다.
       * org.ts 는 이 호출 직전에 서버의 활성 lease를 다시 확인한다.
       */
      if (!isCurrentRequest()) return;
      await onAdd(installed.id, undefined, request.leasedUntil, undefined);
      if (!isCurrentRequest()) return;
      setPendingHubAdd(null);
      setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setRoleFilter(null); setAddOpen(false);
      // The seat mutation has committed at this point. A picker cleanup callback
      // must not turn that success into a retryable receipt if it throws.
      try { onAddExistingComplete?.(); } catch { /* preserve the committed seat */ }
    } catch (cause) {
      if (!isCurrentRequest()) return;
      setPendingHubAdd({ ...request, ...(installed ? { installed } : {}) });
      // Keep the retryable Hub selection visible after install or seat failure.
      // The lease receipt is already in `request`; retrying the picker must not
      // require a fresh confirmation (or a second purchase).
      setAddTab("hub");
      setSelectedAgent(request.listing.slug);
      setAddOpen(true);
      setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const submitAdd = async () => {
    if (!selectedAgent || busy || !state || state.slots.available <= 0) return;
    if (addTab !== "my" && !selectedListing) return;
    const requestAuthEpoch = authEpochRef.current;
    const isCurrentRequest = () => authEpochRef.current === requestAuthEpoch;

    if (addTab === "hub") {
      const listing = selectedListing;
      if (!listing) return;
      const preserved = pendingHubAdd?.listing.slug === listing.slug ? pendingHubAdd : null;
      if (preserved) {
        await completeHubAdd(preserved);
        return;
      }

      setBusy(true);
      setAddError(null);
      try {
        const bridge = ipc();
        if (!bridge) throw new Error("network");
        const quote = await bridge.agentLeases.quote(listing.slug);
        if (!isCurrentRequest()) return;
        const leasedUntil = quote?.ok && quote.active ? validLeaseExpiry(quote.leasedUntil) : null;
        if (leasedUntil) {
          // An active account lease is already the server receipt. Do not open the
          // purchase dialog or bill a second time; proceed directly to installation.
          await completeHubAdd({ listing, leasedUntil });
        } else if (!quote?.ok || quote.code === "signed_out" || quote.code === "network" || quote.code === "http" || quote.code === "invalid_slug") {
          setAddError(hubLeaseQuoteError(quote?.code, ko));
        } else {
          setLeaseDialogListing(listing);
        }
      } catch {
        if (isCurrentRequest()) setAddError(hubLeaseQuoteError("network", ko));
      } finally {
        if (isCurrentRequest()) setBusy(false);
      }
      return;
    }

    setBusy(true);
    setAddError(null);
    try {
      const installed = addTab === "my"
        ? selectedCandidate
        : await onMaterializeSource(addTab, selectedListing!);
      if (!isCurrentRequest()) return;
      if (!installed) throw new Error(ko ? "에이전트를 찾을 수 없습니다." : "The selected agent could not be found.");
      const leaseExpiresAt: string | null = null;
      /*
       * 이름·캐릭터를 보내지 않는다 = 원본 패키지의 이름과 얼굴 그대로 앉는다.
       * Cloud와 로컬은 장기대여 없이 기존 상주 좌석 흐름을 유지한다.
       */
      if (!isCurrentRequest()) return;
      await onAdd(installed.id, undefined, leaseExpiresAt, undefined);
      if (!isCurrentRequest()) return;
      setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setRoleFilter(null); setAddOpen(false);
      onAddExistingComplete?.();
    } catch (cause) {
      if (isCurrentRequest()) setAddError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (isCurrentRequest()) setBusy(false);
    }
  };

  const submitMemberUpdate = async () => {
    if (!editorMember || !editName.trim() || busy) return;
    setBusy(true);
    try {
      if (onUpdate) await onUpdate(editorMember, editName.trim(), editStyle);
      else await onRename(editorMember, editName.trim());
      setEditorMember(null);
    } finally { setBusy(false); }
  };

  const submitReplace = async (member: OneOrgMember, nextId: string) => {
    if (!nextId || busy) return;
    setBusy(true);
    try {
      await onReplace(member, nextId, handover ? "__one_auto_handover__" : undefined);
      setReplaceId(""); setHandover(false); setEditorMember(null);
    } finally { setBusy(false); }
  };

  return (
    <section className={styles.root} aria-label={locale === "ko" ? "One 조직도" : "One organisation"}>
      <div className={styles.header}>
        <button type="button" className={styles.searchToggle} onClick={() => { setSearchOpen((value) => !value); if (searchOpen) setSearchQuery(""); }} aria-label={searchCopy.open} aria-expanded={searchOpen}><IconSearch size={14} /><span>{locale === "ko" ? "검색" : "Search"}</span></button>
      </div>
      {searchOpen && <div className={styles.searchBox} role="search">
        <div className={styles.searchInputWrap}><IconSearch size={13} /><input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={searchCopy.placeholder} aria-label={searchCopy.placeholder} /><button type="button" onClick={() => { setSearchQuery(""); setSearchOpen(false); }} aria-label={searchCopy.close}><IconClose size={13} /></button></div>
        {searchValue && <div className={styles.searchResults}>
          <div className={styles.searchSection}><strong>{searchCopy.people}</strong>{peopleResults.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noPeople}</span> : peopleResults.slice(0, 4).map((member) => <button type="button" key={member.id} aria-label={memberEntryAriaLabel(member, locale)} onClick={() => { onOpenMember?.(member); setSearchOpen(false); setSearchQuery(""); }}><OneAgentPortrait status={member.statusKind} label={member.displayName} size="small" /><span><b>{member.displayName}</b><small>{statusLine(member, locale)}</small></span><span className={styles.searchMemberFeedback} aria-hidden="true">{member.unreadCount > 0 && <span className={styles.unreadDot} />}{member.statusKind === "failed" && member.unreadCount === 0 && <span className={styles.failureDot} />}</span></button>)}</div>
          <div className={styles.searchSection}><strong>{searchCopy.conversations}</strong>{matchingConversations.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noConversations}</span> : matchingConversations.map((item) => <button type="button" key={item.id} onClick={() => { onOpenConversation?.(item.id); setSearchOpen(false); }}><span><b>{item.title}</b><small>{item.detail}</small></span></button>)}</div>
          <div className={styles.searchSection}><strong>{searchCopy.history}</strong>{matchingHistory.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noHistory}</span> : matchingHistory.map((item) => <button type="button" key={item.id} onClick={() => { onOpenHistory?.(item); setSearchOpen(false); }}>{<span><b>{item.title}</b><small>{item.detail}</small></span>}</button>)}</div>
        </div>}
      </div>}
      <div
        className={styles.oneRow}
        data-active={activeOne ? "true" : "false"}
        aria-current={activeOne ? "page" : undefined}
        role={onOpenOne ? "button" : undefined}
        tabIndex={onOpenOne ? 0 : undefined}
        onClick={onOpenOne}
        onKeyDown={(event) => {
          if (!onOpenOne || !shouldOpenOneOrgRowFromKeyboard(event.key, event.target === event.currentTarget)) return;
          event.preventDefault();
          onOpenOne();
        }}
      >
        <OneAgentPortrait status="quiet" label="Agentlas One" size="medium" tone={oneAvatarIcon?.trim() || "character:orange-dino"} />
        <div className={styles.rowCopy}><strong>One</strong><span>{locale === "ko" ? "CEO 오케스트레이터 · 항상 켜짐" : "CEO orchestrator · Always on"}</span></div>
        <span className={styles.badge}>CEO</span>
        {onEditOne && <button
          type="button"
          className={styles.oneEditButton}
          aria-label={locale === "ko" ? "One 말투와 성격 편집" : "Edit One voice and personality"}
          onClick={(event) => { event.stopPropagation(); onEditOne(); }}
        ><IconEdit size={14} /></button>}
      </div>
      {insufficientCredits.length > 0 && <div className={styles.creditWarning} role="status"><span><IconShield size={13} />{locale === "ko" ? `크레딧 부족으로 ${insufficientCredits.length}명 멈춤` : `${insufficientCredits.length} staff paused for insufficient credits`}</span>{onBrowseCredits && <button type="button" onClick={onBrowseCredits}>{locale === "ko" ? "충전" : "Add credits"}</button>}</div>}
      <div className={styles.sectionLabel}>{locale === "ko" ? "상주 스태프" : "Standing Staff"}</div>
      <div className={styles.rows}>
        {active.length === 0 && <>
          <div className={styles.empty}>{locale === "ko" ? "아직 상주 스태프가 없습니다. 아래 역할을 골라 시작하세요." : "No standing staff yet. Pick a role to get started."}</div>
          <div className={styles.ghosts} aria-label={locale === "ko" ? "추천 역할" : "Suggested roles"}>
          {ghostRoles.map((role) => <button key={role} type="button" className={styles.ghost} onClick={() => { setRoleFilter(role); setAddTab("my"); setAddOpen(true); }} disabled={!state || state.slots.available <= 0}><span><IconPlus size={14} /></span><strong>{role}</strong><small>{locale === "ko" ? "아직 없음" : "Not assigned"}</small></button>)}
          </div>
        </>}
        {active.map((member) => (
          <div className={styles.row} key={member.id} data-status={member.statusKind} data-active={activeMemberId === member.installedAgentId ? "true" : "false"} draggable role="button" tabIndex={0} aria-current={activeMemberId === member.installedAgentId ? "page" : undefined} aria-label={memberEntryAriaLabel(member, locale)} onClick={() => onOpenMember?.(member)} onKeyDown={(event) => { if (shouldOpenOneOrgRowFromKeyboard(event.key, event.target === event.currentTarget)) { event.preventDefault(); onOpenMember?.(member); } }} onDragStart={() => setDraggedId(member.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
            if (!draggedId || draggedId === member.id || !state) return;
            const ordered = active.map((item) => item.id);
            const from = ordered.indexOf(draggedId); const to = ordered.indexOf(member.id);
            if (from < 0 || to < 0) return;
            ordered.splice(from, 1); ordered.splice(to, 0, draggedId);
            setDraggedId(null); void onReorder(ordered, state.revision);
          }}>
        <OneAgentPortrait status={member.statusKind} label={member.displayName} tone={member.icon} />
            <div className={styles.rowCopy}>
              <strong>{member.displayName}</strong>
              <span className={styles.statusLine}>{statusLine(member, locale)}</span>
              <span className={styles.memberMeta}>{memberKind(member, installedAgents, locale)} · {sourceLabel(member.source, locale)}{leaseLabel(member, locale) ? ` · ${leaseLabel(member, locale)}` : ""}</span>
            </div>
            <span className={styles.source}>{activityTimeLabel(member, locale)}</span>
            {member.creditState === "insufficient" && <span className={styles.creditBadge}><IconShield size={11} />{locale === "ko" ? "크레딧 부족" : "Credits needed"}</span>}
            {member.unreadCount > 0 && <span className={styles.unreadDot} aria-hidden="true" title={locale === "ko" ? `읽지 않은 결과 ${member.unreadCount}개` : `${member.unreadCount} unread result${member.unreadCount === 1 ? "" : "s"}`} />}
            {member.statusKind === "failed" && member.unreadCount === 0 && <span className={styles.failureDot} aria-hidden="true" title={locale === "ko" ? "실행 실패 — 대화를 열어 상세 확인" : "Run failed — open the conversation for details"} />}
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.editButton}
                aria-label={locale === "ko" ? `${member.displayName} 편집` : `Edit ${member.displayName}`}
                onClick={(event) => {
                  event.stopPropagation();
                  /*
                   * 편집은 **만들 때와 같은 창**으로 바로 연다(오너 지시 2026-08-23).
                   * 예전에는 여기서 조직원 설정 시트를 먼저 띄우고, 그 안의 버튼을 한 번 더
                   * 눌러야 만들기 창이 나왔다 — 같은 일을 두 화면으로 배우게 만드는 구조였다.
                   * 통합 창이 없는 화면(구형 임베드)에서만 예전 시트로 되돌아간다.
                   */
                  if (onEditIdentity) { onEditIdentity(member); return; }
                  setEditorMember(member);
                  setEditName(member.displayName);
                  setEditStyle(member.collaborationStyle ?? "default");
                  setReplaceId("");
                  setHandover(false);
                }}
              ><IconEdit size={14} /></button>
            </div>
          </div>
        ))}
      </div>
      <div className={styles.agentActions}>
        {onCreateAgent && <button type="button" className={styles.createAgentButton} onClick={onCreateAgent} disabled={!state || state.slots.available <= 0} aria-label={state?.slots.available ? (locale === "ko" ? "새 에이전트 만들기 또는 기존 에이전트 추가" : "Create or add an agent") : (locale === "ko" ? "슬롯이 가득 참" : "No staff slots available")}>
          <IconPlus size={15} />
        </button>}
      </div>
      <div className={styles.sectionLabel}>{locale === "ko" ? "현재 태스크포스" : "Active Task Force"}</div>
      {taskForce.length > 0 ? <div className={styles.taskForceRows}>{taskForce.map((agent) => <div className={styles.taskForceRow} key={agent!.id}><OneAgentPortrait status="working" label={agent!.name} tone={agent!.tone} size="small" /><span>{agent!.localDisplayName || agent!.name}</span><small>{locale === "ko" ? "이번 작업" : "This task"}</small></div>)}</div> : <div className={styles.taskForceHint}>{locale === "ko" ? "대화에서 소환한 일회성 에이전트는 여기 슬롯을 차지하지 않고 현재 Work에만 연결됩니다." : "Temporary agents summoned in chat do not occupy a standing slot and stay attached only to the current Work task."}</div>}
      <footer className={styles.footer}>
        <span>{locale === "ko" ? "슬롯" : "Slots"} {state?.slots.used ?? 1}/{state?.slots.capacity ?? 1}</span>
        <span className={styles.slotBudget} title={state ? (locale === "ko" ? `${state.slots.cores}코어 · ${state.slots.totalMemGB}GB RAM · 권장 ${state.slots.recommended} · 최대 ${state.slots.hardMax}` : `${state.slots.cores} cores · ${state.slots.totalMemGB}GB RAM · Recommended ${state.slots.recommended} · Maximum ${state.slots.hardMax}`) : undefined}>
          {state?.slots.available ? (locale === "ko" ? "추가 가능" : "Available") : (locale === "ko" ? "가득 참" : "Full")}
          {onOpenConcurrency && <button type="button" onClick={onOpenConcurrency} aria-label={locale === "ko" ? "동시 에이전트 슬롯 설정" : "Configure concurrent agent slots"}>{locale === "ko" ? "설정" : "Settings"}</button>}
        </span>
      </footer>
      {archived.length > 0 && <details className={styles.archived}><summary>{locale === "ko" ? "보관됨" : "Archived"} · {archived.length}</summary>{archived.map((member) => <div className={styles.archivedRow} key={member.id}><span>{member.displayName}</span><button type="button" onClick={() => void onRestore(member)}>{locale === "ko" ? "복원" : "Restore"}</button></div>)}</details>}

      <OneBottomSheet
        open={Boolean(editorMember)}
        onClose={() => { if (!busy) setEditorMember(null); }}
        closeLabel={locale === "ko" ? "조직원 설정 닫기" : "Close staff settings"}
        closeDisabled={busy}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        size="wide"
        eyebrow={locale === "ko" ? "조직원 설정" : "Staff settings"}
        title={editorMember ? `${editorMember.displayName} · ${editorCopy.edit}` : editorCopy.defaultTitle}
        titleId="one-org-member-editor-title"
        ariaLabelledBy="one-org-member-editor-title"
        description={locale === "ko" ? "이름과 협업 방식은 이 조직에만 적용됩니다. 원본 에이전트 패키지는 바뀌지 않습니다." : "Name and collaboration style apply only to this organisation. The source agent package stays unchanged."}
      >
        {editorMember && <div className={styles.memberEditor}>
          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>{editorCopy.basic}</strong><span>{memberKind(editorMember, installedAgents, locale)} · {sourceLabel(editorMember.source, locale)}</span></div>
            {onEditIdentity
              ? <button
                  type="button"
                  className={styles.secondaryAction}
                  onClick={() => { const target = editorMember; setEditorMember(null); if (target) onEditIdentity(target); }}
                >{locale === "ko" ? `이름·캐릭터 바꾸기 — ${editName || editorMember.displayName}` : `Change name & character — ${editName || editorMember.displayName}`}</button>
              : <label className={styles.editorField}>{editorCopy.orgName}<input value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={80} /></label>}
            <div className={styles.editorReadOnly}><span>{editorCopy.original}</span><strong>{editorInstalled?.localDisplayName || editorInstalled?.name || editorMember.agentSlug}</strong><small>{(ko ? editorInstalled?.tagline : editorInstalled?.taglineEn) || editorInstalled?.tagline || editorInstalled?.taglineEn || editorCopy.originalFallback}</small></div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>{editorCopy.style}</strong><span>{editorCopy.styleDetail}</span></div>
            <div className={styles.styleOptions} role="radiogroup" aria-label={editorCopy.style}>
              {collaborationStyles.map(([value, label, detail]) => <button key={value} type="button" role="radio" aria-checked={editStyle === value} data-active={editStyle === value ? "true" : "false"} onClick={() => setEditStyle(value)}><span><strong>{label}</strong><small>{detail}</small></span>{editStyle === value && <span aria-hidden="true"><IconCheck size={13} /></span>}</button>)}
            </div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>{editorCopy.modelTools}</strong><span>{editorCopy.autoDefault}</span></div>
            <div className={styles.modelPolicy}>
              <IconSparkles size={15} />
              <div><strong>{editorCopy.modelAuto}</strong><span>{editorInstalled?.preferredBackend ? editorCopy.modelPreferred(editorInstalled.preferredBackend) : editorCopy.modelDefault}</span></div>
            </div>
            <p className={styles.editorHint}>{editorCopy.modelHint}</p>
            {(onBrowseTools || onConnectTool) && <button type="button" className={styles.secondaryAction} onClick={() => { setToolsMember(editorMember); setEditorMember(null); }}>{editorCopy.openTools}</button>}
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>{editorCopy.replace}</strong><span>{editorCopy.replaceDetail}</span></div>
            <label className={styles.editorField}>{editorCopy.otherAgent}<select value={replaceId} onChange={(event) => setReplaceId(event.target.value)}><option value="">{editorCopy.chooseReplacement}</option>{replacementCandidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.localDisplayName || agent.name}</option>)}</select></label>
            <label className={styles.editorCheck}><input type="checkbox" checked={handover} onChange={(event) => setHandover(event.target.checked)} /> {editorCopy.handover}</label>
            <p className={styles.editorHint}>{editorCopy.replaceHint}</p>
            <button type="button" className={styles.secondaryAction} disabled={!replaceId || busy} onClick={() => void submitReplace(editorMember, replaceId)}>{editorCopy.replaceAction}</button>
          </section>

          <div className={styles.editorActions}>
            <button type="button" className={styles.archiveAction} disabled={busy} onClick={() => { void onArchive(editorMember).then(() => setEditorMember(null)); }}>{editorCopy.archive}</button>
            <span />
            <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => setEditorMember(null)}>{editorCopy.cancel}</button>
            <button type="button" className={styles.primaryAction} disabled={busy || !editName.trim()} onClick={() => void submitMemberUpdate()}>{editorCopy.save}</button>
          </div>
        </div>}
      </OneBottomSheet>

      {leaseDialogListing && (
        <AgentLeaseDialog
          slug={leaseDialogListing.slug}
          agentName={(ko ? leaseDialogListing.name : leaseDialogListing.nameEn) || leaseDialogListing.name || leaseDialogListing.slug}
          locale={locale}
          initialDays={Number.parseInt(leaseDays, 10)}
          skipPurchaseIfActive
          onClose={() => setLeaseDialogListing(null)}
          onLeased={(leasedUntil) => {
            // The dialog can finish after auth-changed unmounted it. Its receipt
            // belongs to the epoch that opened this dialog; never materialize or
            // seat that receipt into the newly selected account.
            if (leaseDialogAuthEpoch === null || authEpochRef.current !== leaseDialogAuthEpoch) return;
            const listing = leaseDialogListing;
            setLeaseDialogListing(null);
            if (listing && authEpochRef.current === leaseDialogAuthEpoch) void completeHubAdd({ listing, leasedUntil });
          }}
        />
      )}

      <OneBottomSheet
        open={addOpen}
        onClose={() => { if (!busy) { setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); } }}
        closeLabel={locale === "ko" ? "에이전트 추가 닫기" : "Close add agent"}
        closeDisabled={busy}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        size="wide"
        panelClassName={styles.addDialog}
        bodyClassName={styles.addDialogBody}
        eyebrow={`${addCopy.slots} ${state?.slots.used ?? 1}/${state?.slots.capacity ?? 1} ${addCopy.used} · ${state?.slots.available ?? 0} ${addCopy.remaining}`}
        title={locale === "ko" ? "에이전트 추가" : "Add agent"}
        titleId="one-org-add-title"
        ariaLabelledBy="one-org-add-title"
        description={addTab === "my" ? addCopy.localNote : addTab === "cloud" ? addCopy.cloudNote : addCopy.hubNote}
      >
        <div className={styles.addSheet}>
          <div className={styles.tabs} role="tablist" aria-label={addCopy.sourceAria}>{([['my', addCopy.myAgents], ['cloud', 'Cloud'], ['hub', 'Hub']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={addTab === key} data-active={addTab === key} onClick={() => { setAddTab(key); setSelectedAgent(""); setLeaseDays(key === "hub" ? "7" : "0"); setAddError(null); }}>{label}</button>)}</div>
          <label className={styles.addSearch}><IconSearch size={15} /><input value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder={addCopy.search} aria-label={addCopy.search} />{addSearch && <button type="button" onClick={() => setAddSearch("")} aria-label={locale === "ko" ? "검색 지우기" : "Clear search"}><IconClose size={14} /></button>}</label>
          {/*
            출처 안내는 시트 머리말(description)이 이미 같은 문장을 찍는다. 여기 한 번 더
            찍으면 같은 말이 두 줄로 나오고 그만큼 후보 목록이 눌린다(오너 지적 2026-08-25).
          */}
          {/* "새 에이전트 만들기 또는 추가" 라벨로 들어온 시트에 '만들기' 경로가
              없었다 (U-D-2) — 검색 결과와 무관하게 만들기 진입점을 상시 제공한다. */}
          {addTab === "my" && onCreateAgent && (
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={() => { setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); onCreateAgent(); }}
            ><IconPlus size={13} />{ko ? "새 에이전트 만들기" : "Create a new agent"}</button>
          )}

          {addTab === "my" ? (
            inventoryLoading && candidates.length === 0 ? <AgentInventoryLoading locale={locale} />
              : candidates.length > 0 ? <div className={styles.candidateGrid} role="list" aria-label={addCopy.installed}>{candidates.map((agent) => <button type="button" role="listitem" key={agent.id} data-active={selectedAgent === agent.id ? "true" : "false"} onClick={() => { setSelectedAgent(agent.id); setAddError(null); }}><span><strong>{agent.localDisplayName || (ko ? agent.name : agent.nameEn) || agent.name}</strong><small>{agent.kind === "team" ? addCopy.team : addCopy.single} · {ko ? "로컬" : "Local"}</small><em>{(ko ? agent.tagline : agent.taglineEn) || agent.tagline || agent.taglineEn}</em></span>{selectedAgent === agent.id && <IconCheck size={15} />}</button>)}</div>
              : <div className={styles.sheetEmpty}>{roleFilter ? addCopy.noMatch : (ko ? "사용 가능한 로컬 에이전트가 없습니다." : "No local agents are available.")}{roleFilter && <button type="button" className={styles.inlineLink} onClick={() => setRoleFilter(null)}>{addCopy.showAll}</button>}{onCreateAgent && <button type="button" className={styles.inlineLink} onClick={() => { setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); onCreateAgent(); }}>{ko ? "새 에이전트 만들기" : "Create a new agent"}</button>}</div>
          ) : inventoryLoading && remoteCandidates.length === 0 ? <AgentInventoryLoading locale={locale} /> : remoteCandidates.length > 0 ? (
            <div className={styles.candidateGrid} role="list" aria-label={addTab === "cloud" ? "Cloud" : "Hub"}>{remoteCandidates.map((listing) => <button type="button" role="listitem" key={`${addTab}:${listing.entityKind || "agent"}:${listing.slug}`} data-active={selectedAgent === listing.slug ? "true" : "false"} onClick={() => { setSelectedAgent(listing.slug); setLeaseDays(addTab === "hub" ? "7" : "0"); setAddError(null); }}><span><strong>{(ko ? listing.name : listing.nameEn) || listing.name || listing.slug}</strong><small>{listing.entityKind === "team" || (listing.agentCount ?? 0) > 1 ? addCopy.team : addCopy.single} · {addTab === "cloud" ? "Cloud" : "Hub"}</small><em>{(ko ? listing.tagline : listing.taglineEn) || listing.tagline || listing.taglineEn}</em></span>{selectedAgent === listing.slug && <IconCheck size={15} />}</button>)}</div>
          ) : <div className={styles.sheetEmpty}><span>{accountSignedIn === false
            /* 미로그인을 빈 계정처럼 보이게 하지 않는다(D-10) — signedIn===false 로 확인된 때만 로그인 안내. */
            ? (addTab === "cloud" ? addCopy.cloudSignedOut : addCopy.hubSignedOut)
            : (addTab === "cloud" ? addCopy.cloudEmpty : addCopy.hubEmpty)}</span>{onBrowseSource && <button type="button" onClick={() => onBrowseSource(addTab)}>{addTab === "cloud" ? addCopy.cloudBrowse : addCopy.hubBrowse}</button>}</div>}

          {/*
            고른 뒤에 나오는 칸은 **좌석에서만 정하는 것**만 남긴다(대여 기간).
            이름·캐릭터를 여기서 또 받으면 목록이 눌려 고를 수 없게 되고, 방금 만들기
            창에서 정한 것을 한 번 더 묻는 꼴이 된다(오너 지적 2026-08-25).
          */}
          {(selectedCandidate || selectedListing) && <section className={styles.selectedAgentPanel}>
            {addTab === "hub" && <label className={styles.editorField}>{addCopy.lease}<select value={leaseDays} onChange={(event) => setLeaseDays(event.target.value)}><option value="7">7 {ko ? "일" : "days"}</option><option value="30">30 {ko ? "일" : "days"}</option></select></label>}
            <div className={styles.modelPolicy}><IconSparkles size={15} /><div><strong>{addCopy.modelAuto}</strong><span>{selectedCandidate?.preferredBackend ? addCopy.modelPreferred(selectedCandidate.preferredBackend) : addCopy.modelDefault}</span></div></div>
            <p className={styles.note}>{addCopy.identityNote}</p>
          </section>}
          {addError && <p className={styles.addError} role="alert">{addError}</p>}
          {busy && <div className={styles.addBusy} role="status" aria-live="polite"><span className={styles.inventorySpinner} aria-hidden="true" /><span>{ko ? "에이전트를 조직에 연결하고 전용 채팅을 준비하고 있습니다." : "Connecting the agent to the organisation and preparing its dedicated chat."}<LoadingEstimate locale={ko ? "ko" : "en"} operationKey="one-agent-org-add" expectedSeconds={[2, 30]} /></span></div>}
          <div className={styles.sheetActions}><button type="button" disabled={busy} onClick={() => { setSelectedAgent(""); setLeaseDays("0"); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); }}>{addCopy.cancel}</button><button type="button" className={styles.primaryAction} disabled={!selectedAgent || busy} onClick={() => void submitAdd()}>{busy ? (ko ? "추가 중…" : "Adding…") : addCopy.add}</button></div>
        </div>
      </OneBottomSheet>

      <OneBottomSheet
        open={Boolean(toolsMember)}
        onClose={() => { if (!toolsBusy) setToolsMember(null); }}
        closeLabel={locale === "ko" ? "도구 닫기" : "Close tools"}
        closeDisabled={toolsBusy}
        closeOnBackdrop={!toolsBusy}
        closeOnEscape={!toolsBusy}
        /* 내용이 목록 몇 줄뿐이라 팝업2. 예전 full 은 화면을 다 먹고 아래 70%가 비었다. */
        size="compact"
        panelClassName={styles.toolsDialog}
        bodyClassName={styles.toolsDialogBody}
        eyebrow={toolsMember?.displayName}
        title={locale === "ko" ? "도구" : "Tools"}
        titleId="one-org-tools-title"
        ariaLabelledBy="one-org-tools-title"
        description={locale === "ko" ? "플러그인과 MCP를 나눠 보고, 이 동료가 실행 시 사용할 도구를 관리합니다." : "Review Plugins and MCP separately, then manage the tools this teammate may use at run time."}
      >
        {toolsMember && <div className={styles.toolsSheet}>
          <div className={styles.autoSelectRow}>
            <div><strong>{toolsCopy.auto}</strong><small>{toolsCopy.autoDetail}</small></div>
            <button type="button" className={styles.toggle} data-on={toolsMember.autoSelectTools ? "true" : "false"} disabled={!onSetAutoSelect || toolsBusy} onClick={() => {
              if (!onSetAutoSelect) return;
              const next = !toolsMember.autoSelectTools;
              setToolsBusy(true);
              void onSetAutoSelect(toolsMember, next).then(() => setToolsMember((current) => current ? { ...current, autoSelectTools: next } : current)).finally(() => setToolsBusy(false));
            }} aria-pressed={toolsMember.autoSelectTools}>{toolsMember.autoSelectTools ? toolsCopy.on : toolsCopy.off}</button>
          </div>
          <div className={styles.builtInTool}><span className={styles.toolMark}><IconCode size={15} /></span><div><strong>{locale === "ko" ? "파일 · 터미널" : "Files · Terminal"}</strong><small>{locale === "ko" ? "내장 도구 · 항상 사용 가능" : "Built-in tools · Always available"}</small></div><span className={styles.toolState}>{locale === "ko" ? "준비됨" : "Ready"}</span></div>
          <div className={styles.toolTabs} role="tablist" aria-label={locale === "ko" ? "도구 종류" : "Tool type"}><button type="button" role="tab" aria-selected={toolsTab === "plugins"} data-active={toolsTab === "plugins" ? "true" : "false"} onClick={() => setToolsTab("plugins")}>{toolsCopy.plugins}</button><button type="button" role="tab" aria-selected={toolsTab === "mcp"} data-active={toolsTab === "mcp" ? "true" : "false"} onClick={() => setToolsTab("mcp")}>{toolsCopy.mcp}</button></div>
          <div className={styles.toolList}>
            {visibleAssignedTools.length === 0 && <p className={styles.sheetEmpty}>{toolsTab === "plugins" ? toolsCopy.noPlugins : toolsCopy.noMcp}</p>}
            {visibleAssignedTools.map((tool) => <div className={styles.toolRow} key={tool.id}><span className={styles.toolMark}><IconApps size={14} /></span><div><strong>{locale === "ko" ? tool.name : tool.nameEn}</strong><small>{toolsTab === "plugins" ? toolsCopy.plugins : toolsCopy.mcp} · {tool.state === "ready" ? (locale === "ko" ? "연결됨" : "Connected") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "연결 필요" : "Connection needed")}</small></div>{tool.state === "needs-connection" && <button type="button" className={styles.toolAction} onClick={() => { const member = toolsMember; setToolsMember(null); onConnectTool?.(member, tool.id); }}>{locale === "ko" ? "연결" : "Connect"}</button>}<span className={styles.toolState}>{tool.state === "ready" ? (locale === "ko" ? "준비됨" : "Ready") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "확인 필요" : "Review")}</span></div>)}
          </div>
          <p className={styles.note}>{toolsCopy.permissionNote}</p>
          <div className={styles.sheetActions}><button type="button" onClick={() => { const member = toolsMember; setToolsMember(null); if (toolsTab === "plugins") onBrowseTools?.(member); else onConnectTool?.(member); }}><IconPlus size={13} />{toolsTab === "plugins" ? (locale === "ko" ? "플러그인 관리" : "Manage plugins") : (locale === "ko" ? "MCP 관리" : "Manage MCP")}</button><button type="button" className={styles.primaryAction} onClick={() => setToolsMember(null)}>{locale === "ko" ? "닫기" : "Close"}</button></div>
        </div>}
      </OneBottomSheet>
    </section>
  );
}
