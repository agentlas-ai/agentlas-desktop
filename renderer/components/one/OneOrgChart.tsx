import { useEffect, useMemo, useRef, useState } from "react";
import { takeOrgSheetRequest } from "@/lib/one-org-sheet-request";
import type { InstalledAgent, InstalledMcpServer, McpServerStatus, McpToolCatalogEntry } from "@shared/types";
import { isCallOnlyHubAgent } from "@shared/call-only-agent";
import type { OneOrgCollaborationStyle, OneOrgMember, OneOrgState } from "@shared/one-org";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { OneAgentChoicePicker } from "./OneAgentChoicePicker";
import { OneBottomSheet } from "./OneBottomSheet";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { ipc } from "@/lib/ipc";
import { useOnePersonaName } from "@/lib/one-persona-name";
import styles from "./OneOrgChart.module.css";
import {
  IconApps,
  IconCheck,
  IconClose,
  IconCode,
  IconEdit,
  IconPlus,
  IconSearch,
  IconSparkles,
  IconLayers,
  IconRoute,
  IconShield,
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
  return `${member.displayName} · ${statusLine(member, locale)}${member.unreadCount > 0 ? ` · ${locale === "ko" ? `읽지 않은 결과 ${member.unreadCount}개` : `${member.unreadCount} unread result${member.unreadCount === 1 ? "" : "s"}`}` : ""}`;
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

function AgentInventoryLoading({ locale }: { locale: string }) {
  return <div className={styles.inventoryLoading} role="status" aria-live="polite">
    <span className={styles.inventorySpinner} aria-hidden="true" />
    <span><strong>{locale === "ko" ? "에이전트 목록 불러오는 중" : "Loading agents"}</strong><small>{locale === "ko" ? "저장된 목록을 먼저 확인하고 최신 상태를 동기화합니다." : "Showing cached inventory first, then syncing the latest state."}</small><LoadingEstimate locale={locale === "ko" ? "ko" : "en"} operationKey="one-agent-inventory" expectedSeconds={[1, 20]} /></span>
  </div>;
}

export function OneOrgChart({
  state,
  installedAgents,
  inventoryLoading = false,
  locale,
  onAdd,
  onAddExistingComplete,
  onCreateAgent,
  addRequest,
  onAddRequestTaken,
  onRename,
  onUpdate,
  onReplace,
  onArchive,
  onRestore,
  onReorder,
  onFailure,
  onOpenMember,
  onOpenOne,
  onNewSession,
  onEditOne,
  onEditIdentity,
  sheetRequest,
  onSheetRequestTaken,
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
  onBrowseMoreAgents,
  conversationResults = [],
  historyResults = [],
  onOpenConversation,
  onOpenHistory,
}: {
  state: OneOrgState | null;
  installedAgents: InstalledAgent[];
  inventoryLoading?: boolean;
  locale: string;
  onAdd: (installedAgentId: string, displayName?: string, leaseExpiresAt?: string | null, characterId?: string) => Promise<void>;
  /** Close the preserved New Agent context only after an explicit picker confirmation succeeds. */
  onAddExistingComplete?: () => void;
  onCreateAgent?: () => void;
  /** `source` 는 옛 요청 모양과의 호환용이다 — 추가 창은 이제 로컬 에이전트만 보여준다. */
  addRequest?: { token: number; source: "my" | "cloud" | "hub" };
  /** Spent like sheetRequest: cleared by its owner, so returning to the Agents tab does not reopen the picker. */
  onAddRequestTaken?: (token: number) => void;
  onRename: (member: OneOrgMember, displayName: string) => Promise<void>;
  onUpdate?: (member: OneOrgMember, displayName: string, collaborationStyle: OneOrgCollaborationStyle) => Promise<void>;
  onReplace: (member: OneOrgMember, installedAgentId: string, handoverNote?: string) => Promise<void>;
  onArchive: (member: OneOrgMember) => Promise<void>;
  onRestore: (member: OneOrgMember) => Promise<void>;
  onReorder: (orderedIds: string[], expectedRevision: number) => Promise<void>;
  onFailure?: (member: OneOrgMember) => void;
  onOpenMember?: (member: OneOrgMember) => void;
  onOpenOne?: () => void;
  /** 새 세션 — null 이면 One, 아니면 그 좌석 에이전트와 빈 대화를 새로 연다. */
  onNewSession?: (member: OneOrgMember | null) => void;
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
  /** The request is spent: its owner clears it so the next mount of this chart cannot open it again. */
  onSheetRequestTaken?: (token: number) => void;
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
  /** 좌석에는 로컬에 등록된 에이전트만 앉힌다. 더 필요하면 Hub 메뉴에서 내려받는다. */
  onBrowseMoreAgents?: () => void;
  conversationResults?: OneOrgSearchItem[];
  historyResults?: OneOrgSearchItem[];
  onOpenConversation?: (id: string) => void;
  onOpenHistory?: (item: OneOrgSearchItem) => void;
}) {
  const onePersonaName = useOnePersonaName();
  const ko = locale === "ko";
  const [addOpen, setAddOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
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
      // Installed agents are account-owned. Drop the in-memory picker when the
      // account changes so an old selection cannot be seated into the newly
      // selected account.
      authEpochRef.current += 1;
      setBusy(false);
      setSelectedAgent("");
      setAddSearch("");
      setAddError(null);
      setAddOpen(false);
    };
    window.addEventListener("agentlas:auth-changed", onAuthChanged);
    return () => window.removeEventListener("agentlas:auth-changed", onAuthChanged);
  }, []);
  const handledAddToken = useRef(0);
  useEffect(() => {
    if (!addRequest?.token || addRequest.token === handledAddToken.current) return;
    handledAddToken.current = addRequest.token;
    onAddRequestTaken?.(addRequest.token);
    setSelectedAgent("");
    setAddSearch("");
    setAddError(null);
    setRoleFilter(null);
    setAddOpen(true);
  }, [addRequest]);

  /*
   * 통합 편집 창이 "도구 설정" 또는 "담당 교체"를 열어 달라고 하면 여기서 연다.
   * 대상이 지금 조직에 없으면 아무것도 하지 않는다 — 빈 시트를 띄우는 것보다 낫다.
   */
  const handledSheetToken = useRef(0);
  useEffect(() => {
    const taken = takeOrgSheetRequest(sheetRequest, handledSheetToken.current, state?.members);
    if (!taken || !sheetRequest) return;
    handledSheetToken.current = taken.token;
    onSheetRequestTaken?.(taken.token);
    const member = taken.member;
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
  // 역할 버튼은 안정 id 로 거른다 — 전에는 화면 글자("Engineering")를 한국어 키 표에서 찾아, 영어 화면에서 추가 목록이 늘 비었다(2026-09-14).
  const ghostRoles: Array<{ id: "engineering" | "marketing" | "research"; label: string }> = [
    { id: "engineering", label: locale === "ko" ? "개발" : "Engineering" },
    { id: "marketing", label: locale === "ko" ? "마케팅" : "Marketing" },
    { id: "research", label: locale === "ko" ? "리서치" : "Research" },
  ];
  const active = state?.members.filter((member) => !member.archivedAt) || [];
  const archived = state?.members.filter((member) => Boolean(member.archivedAt)) || [];
  const usedIds = useMemo(() => new Set(active.map((member) => member.installedAgentId)), [active]);
  const roleTerms: Record<string, string[]> = {
    engineering: ["개발", "dev", "engineer", "code", "software", "build"],
    marketing: ["마케팅", "marketing", "growth", "sales", "content"],
    research: ["리서치", "research", "analysis", "analyst", "조사"],
  };
  // A replacement must itself be able to work: never offer an agent whose source folder is gone or that is hidden.
  // A call-only Hub agent has no local instructions, so it cannot be a local replacement either.
  const replacementCandidates = installedAgents.filter((agent) => !usedIds.has(agent.id) && !agent.parentTeamId
    && !isCallOnlyHubAgent(agent)
    && !agent.sourceMissingSince && agent.visibility !== "background" && agent.visibility !== "private");
  const addSearchValue = addSearch.trim().toLocaleLowerCase();
  const candidates = installedAgents.filter((agent) => {
    if (usedIds.has(agent.id)) return false;
    // 좌석에는 이 Mac에 등록된 에이전트만 앉힌다. Hub·Cloud 에서 내려받은 사본은 로컬 에이전트다 —
    // 소스 지시문이 없는 호출 전용 Hub 항목만 뺀다(오너 결정 2026-10-19).
    if (isCallOnlyHubAgent(agent)) return false;
    // 팀 패키지의 내부 역할(Orchestrator·Memory Curator 등)은 앉힐 수 있는 사람이 아니다.
    // 팀은 팀으로 앉힌다 — 실측 2026-08-23: 팀 4개가 구성원 25명으로 풀려 목록을 뒤덮었다.
    if (agent.parentTeamId) return false;
    if (!roleFilter) return true;
    const haystack = `${agent.name} ${agent.nameEn} ${agent.tagline} ${agent.taglineEn} ${agent.slug}`.toLocaleLowerCase();
    return (roleTerms[roleFilter] || []).some((term) => haystack.includes(term));
  }).filter((agent) => !addSearchValue || `${agent.name} ${agent.nameEn} ${agent.tagline} ${agent.taglineEn} ${agent.slug}`.toLocaleLowerCase().includes(addSearchValue));
  const taskForce = (activeTaskForceIds || []).map((id) => installedAgents.find((agent) => agent.id === id)).filter(Boolean);
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
    myAgents: "내 에이전트", installed: "로컬 에이전트", choose: "에이전트를 선택하세요", search: "에이전트 검색",
    matchingRole: (role: string) => `${role} 역할에 맞는 에이전트`, noMatch: "설치된 에이전트 중 일치하는 역할이 없습니다.", showAll: "전체 목록 보기",
    permanent: "상주 · 만료 없음",
    modelAuto: "모델 · 자동 배정", modelPreferred: (backend: string) => `에이전트 권장 엔진 ${backend}을 우선 사용합니다.`, modelDefault: "One이 작업과 사용 가능한 런타임에 맞춰 고릅니다.",
    identityNote: "원본의 이름과 캐릭터 그대로 앉습니다. 바꾸려면 앉힌 뒤 조직도에서 편집하세요.",
    team: "팀", single: "단일", add: "이 에이전트 추가", cancel: "취소 / 뒤로",
    localNote: "이 Mac에 설치된 에이전트입니다. 조직에 상주 직원으로 추가됩니다.",
    browseMore: "더 많은 에이전트 보러가기",
    browseMoreNote: "여기에는 이 Mac에 등록된 에이전트만 보입니다. 공개 에이전트나 내 Agent Cloud 에이전트는 Hub 메뉴에서 내려받으면 여기 나타납니다.",
  } : {
    myAgents: "My agents", installed: "Local agent", choose: "Choose an agent", search: "Search agents",
    matchingRole: (role: string) => `Agents matching ${role}`, noMatch: "No installed agent matches this role.", showAll: "View all agents",
    permanent: "Standing · No expiry",
    modelAuto: "Model · Automatic", modelPreferred: (backend: string) => `Prefers the agent's recommended ${backend} runtime.`, modelDefault: "One chooses for each task from the available runtimes.",
    identityNote: "Joins with the name and character it already has. To change them, edit it in the organisation chart after it joins.",
    team: "Team", single: "Single", add: "Add this agent", cancel: "Cancel / Back",
    localNote: "These agents are installed on this Mac. They join your organisation as standing staff.",
    browseMore: "Browse more agents",
    browseMoreNote: "Only agents registered on this Mac are listed here. Download a public or Agent Cloud agent from the Hub menu and it appears here.",
  };
  const editorCopy = ko ? {
    edit: "편집", defaultTitle: "조직원 편집", basic: "기본 정보", orgName: "이 조직에서 부를 이름", original: "원본 담당", originalFallback: "설치된 에이전트의 역할 정의를 사용합니다.",
    style: "협업 말투", styleDetail: "One이 이 직원에게 일을 넘길 때 적용", modelTools: "모델과 도구", autoDefault: "자동 배정이 기본", modelAuto: "모델 · 자동",
    modelPreferred: (backend: string) => `권장 엔진 ${backend} 우선`, modelDefault: "One이 작업마다 사용 가능한 런타임을 배정",
    modelHint: "직원을 추가할 때 모델을 강제로 고정하지 않습니다. 모델 고정은 팀 전체 실행 계획과 충돌할 수 있어 One 오케스트레이터 모델만 설정 메뉴에서 지정합니다.", openTools: "도구 설정 열기",
    replace: "담당 교체", replaceDetail: "이름·대화·산출물은 유지", otherAgent: "다른 에이전트", chooseReplacement: "교체할 에이전트 선택", searchAgents: "에이전트 검색...", noAgentMatch: "찾는 에이전트가 없습니다",
    handover: "전임 담당의 인수인계 메모를 새 담당에게 전달", replaceHint: "교체하면 전임자의 경험·기억과 그 담당 전용 루틴은 이어지지 않습니다.", replaceAction: "선택한 담당으로 교체",
    archive: "해고 대신 보관", cancel: "취소", save: "저장",
  } : {
    edit: "Edit", defaultTitle: "Edit staff member", basic: "Basic information", orgName: "Name in this organisation", original: "Source agent", originalFallback: "Uses the installed agent's role definition.",
    style: "Collaboration style", styleDetail: "Used when One hands work to this staff member", modelTools: "Model and tools", autoDefault: "Assigned automatically", modelAuto: "Model · Automatic",
    modelPreferred: (backend: string) => `Prefers recommended runtime ${backend}`, modelDefault: "One assigns an available runtime for each task",
    modelHint: "A staff member does not pin a model. Per-agent model pins can conflict with the team execution plan, so only the One orchestrator model is selected in Settings.", openTools: "Open tool settings",
    replace: "Replace assignee", replaceDetail: "Keep the name, conversation, and outputs", otherAgent: "Replacement agent", chooseReplacement: "Choose a replacement", searchAgents: "Search agents...", noAgentMatch: "No matching agent",
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
  const selectedCandidate = selectedAgent ? installedAgents.find((agent) => agent.id === selectedAgent) : undefined;
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

  const submitAdd = async () => {
    if (!selectedAgent || busy || !state) return;
    const requestAuthEpoch = authEpochRef.current;
    const isCurrentRequest = () => authEpochRef.current === requestAuthEpoch;

    setBusy(true);
    setAddError(null);
    try {
      const installed = selectedCandidate;
      if (!isCurrentRequest()) return;
      if (!installed) throw new Error(ko ? "에이전트를 찾을 수 없습니다." : "The selected agent could not be found.");
      const leaseExpiresAt: string | null = null;
      /*
       * 이름·캐릭터를 보내지 않는다 = 원본 패키지의 이름과 얼굴 그대로 앉는다.
       * 로컬 에이전트는 장기대여 없이 상주 좌석 흐름으로 앉는다.
       */
      await onAdd(installed.id, undefined, leaseExpiresAt, undefined);
      if (!isCurrentRequest()) return;
      setSelectedAgent(""); setAddSearch(""); setRoleFilter(null); setAddOpen(false);
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
        <div className={styles.rowCopy}>
          {/* 사람에게 보이는 호칭은 첫 설정/프로필에서 정한 이름. "One" 은 역할 이름으로만 남는다. */}
          <strong>{onePersonaName}</strong>
          {






}
          <span title={locale === "ko" ? "CEO 오케스트레이터 · 항상 켜짐" : "CEO orchestrator · Always on"}>
            {locale === "ko" ? "CEO · 항상 켜짐" : "CEO · Always on"}
          </span>
        </div>
        <span className={styles.badge}>CEO</span>
        {onNewSession && <button
          type="button"
          className={styles.oneEditButton}
          data-one-new-session="one"
          aria-label={locale === "ko" ? `새 세션 · ${onePersonaName}` : `New session with ${onePersonaName}`}
          title={locale === "ko" ? "새 세션" : "New session"}
          onClick={(event) => { event.stopPropagation(); onNewSession(null); }}
        ><IconPlus size={14} /></button>}
        {onEditOne && <button
          type="button"
          className={styles.oneEditButton}
          aria-label={locale === "ko" ? "One 말투와 성격 편집" : "Edit One voice and personality"}
          onClick={(event) => { event.stopPropagation(); onEditOne(); }}
        ><IconEdit size={14} /></button>}
      </div>
      <div className={styles.sectionLabel}>{locale === "ko" ? "상주 스태프" : "Standing Staff"}</div>
      <div className={styles.rows}>
        {active.length === 0 && <>
          <div className={styles.empty}>{locale === "ko" ? "아직 상주 스태프가 없습니다. 아래 역할을 골라 시작하세요." : "No standing staff yet. Pick a role to get started."}</div>
          <div className={styles.ghosts} aria-label={locale === "ko" ? "추천 역할" : "Suggested roles"}>
          {ghostRoles.map((role) => <button key={role.id} type="button" className={styles.ghost} onClick={() => { setRoleFilter(role.id); setAddOpen(true); }} disabled={!state}><span><IconPlus size={14} /></span><strong>{role.label}</strong><small>{locale === "ko" ? "아직 없음" : "Not assigned"}</small></button>)}
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
              {member.unavailable && <span className={styles.unavailableReason} role="status">{locale === "ko" ? member.unavailable.reason.ko : member.unavailable.reason.en}</span>}
              <span className={styles.memberMeta}>{memberKind(member, installedAgents, locale)} · {sourceLabel(member.source, locale)}</span>
            </div>
            <span className={styles.source}>{activityTimeLabel(member, locale)}</span>
            {member.unreadCount > 0 && <span className={styles.unreadDot} aria-hidden="true" title={locale === "ko" ? `읽지 않은 결과 ${member.unreadCount}개` : `${member.unreadCount} unread result${member.unreadCount === 1 ? "" : "s"}`} />}
            {member.statusKind === "failed" && member.unreadCount === 0 && (
              /*
                * ★이 점의 툴팁은 "대화를 열어 상세 확인" 이라고 말하는데 **누를 수 없었다**
                *   (실측 2026-09-08). 부모는 실패한 실행의 대화를 여는 onFailure 를 내려보내고
                *   있었고 그 핸들러도 완성돼 있었는데, 이 조직도가 그 prop 을 한 번도 안 썼다.
                *   말한 대로 하게 만든다 — 점을 누르면 그 실패한 대화가 열린다.
                */
              <button
                type="button"
                className={styles.failureDot}
                aria-label={locale === "ko" ? "실행 실패 — 대화를 열어 상세 확인" : "Run failed — open the conversation for details"}
                title={locale === "ko" ? "실행 실패 — 대화를 열어 상세 확인" : "Run failed — open the conversation for details"}
                onClick={(event) => { event.stopPropagation(); onFailure?.(member); }}
              />
            )}
            <div className={styles.rowActions}>
              {member.unavailable?.replaceable && <button
                type="button"
                className={styles.replaceNeededButton}
                data-one-replace-needed={member.installedAgentId}
                onClick={(event) => {
                  event.stopPropagation();
                  setEditorMember(member);
                  setEditName(member.displayName);
                  setEditStyle(member.collaborationStyle ?? "default");
                  setReplaceId("");
                  setHandover(false);
                }}
              >{locale === "ko" ? "교체" : "Replace"}</button>}
              {onNewSession && <button
                type="button"
                className={styles.editButton}
                data-one-new-session={member.installedAgentId}
                aria-label={locale === "ko" ? `새 세션 · ${member.displayName}` : `New session with ${member.displayName}`}
                title={locale === "ko" ? "새 세션" : "New session"}
                onClick={(event) => { event.stopPropagation(); onNewSession(member); }}
              ><IconPlus size={14} /></button>}
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
        {onCreateAgent && <button type="button" className={styles.createAgentButton} onClick={onCreateAgent} disabled={!state}
          aria-label={!state
            ? (locale === "ko" ? "팀원 수를 읽는 중" : "Reading teammate count")
            : (locale === "ko" ? "새 에이전트 만들기 또는 기존 에이전트 추가" : "Create or add an agent")}
          title={!state
            ? (locale === "ko" ? "팀원 수를 아직 읽지 못했습니다." : "The teammate count has not been read yet.")
            : undefined}>
          <IconPlus size={15} />
        </button>}
      </div>
      <div className={styles.sectionLabel}>{locale === "ko" ? "현재 태스크포스" : "Active Task Force"}</div>
      {taskForce.length > 0 ? <div className={styles.taskForceRows}>{taskForce.map((agent) => <div className={styles.taskForceRow} key={agent!.id}><OneAgentPortrait status="working" label={agent!.name} tone={agent!.tone} size="small" /><span>{agent!.localDisplayName || agent!.name}</span><small>{locale === "ko" ? "이번 작업" : "This task"}</small></div>)}</div> : <div className={styles.taskForceHint}>{locale === "ko" ? "대화에서 소환한 일회성 에이전트는 팀원 수에 들어가지 않고 현재 Work에만 연결됩니다." : "Temporary agents summoned in chat do not count as teammates and stay attached only to the current Work task."}</div>}
      <footer className={styles.footer}>
        <span>{state
          ? (locale === "ko" ? `One 포함 ${state.slots.used}명` : `${state.slots.used} members incl. One`)
          : (locale === "ko" ? "팀원 불러오는 중" : "Loading teammates")}</span>
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
        icon={<IconEdit size={20} />}
        description={ko ? "이 조직에만 적용" : "Applies to this organisation"}
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
            <details className={styles.popupDetails}><summary>{ko ? "모델 배정 방식" : "Model assignment"}</summary><p className={styles.editorHint}>{editorCopy.modelHint}</p></details>
            {(onBrowseTools || onConnectTool) && <button type="button" className={styles.secondaryAction} onClick={() => { setToolsMember(editorMember); setEditorMember(null); }}>{editorCopy.openTools}</button>}
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>{editorCopy.replace}</strong><span>{editorCopy.replaceDetail}</span></div>
            <OneAgentChoicePicker
              label={editorCopy.otherAgent}
              placeholder={editorCopy.chooseReplacement}
              searchPlaceholder={editorCopy.searchAgents}
              emptyLabel={editorCopy.noAgentMatch}
              choices={replacementCandidates.map((agent) => ({ id: agent.id, name: agent.localDisplayName || agent.name, tone: agent.tone,
                detail: (locale === "ko" ? agent.tagline : agent.taglineEn || agent.tagline) || undefined }))}
              value={replaceId}
              onChange={setReplaceId}
              disabled={busy}
            />
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

      <OneBottomSheet
        open={addOpen}
        onClose={() => { if (!busy) { setSelectedAgent(""); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); } }}
        closeLabel={locale === "ko" ? "에이전트 추가 닫기" : "Close add agent"}
        closeDisabled={busy}
        closeOnBackdrop={!busy}
        closeOnEscape={!busy}
        size="wide"
        panelClassName={styles.addDialog}
        bodyClassName={styles.addDialogBody}
        eyebrow={state ? (locale === "ko" ? `One 포함 ${state.slots.used}명` : `${state.slots.used} members incl. One`) : undefined}
        title={locale === "ko" ? "에이전트 추가" : "Add agent"}
        titleId="one-org-add-title"
        ariaLabelledBy="one-org-add-title"
        icon={<IconPlus size={20} />}
      >
        <div className={styles.addSheet}>
          <details className={styles.popupDetails}><summary>{ko ? "가져오기 안내" : "Import details"}</summary><p>{addCopy.localNote} {addCopy.browseMoreNote}</p></details>
          <label className={styles.addSearch}><IconSearch size={15} /><input value={addSearch} onChange={(event) => setAddSearch(event.target.value)} placeholder={addCopy.search} aria-label={addCopy.search} />{addSearch && <button type="button" onClick={() => setAddSearch("")} aria-label={locale === "ko" ? "검색 지우기" : "Clear search"}><IconClose size={14} /></button>}</label>
          {/*
            출처 안내는 시트 머리말(description)이 이미 같은 문장을 찍는다. 여기 한 번 더
            찍으면 같은 말이 두 줄로 나오고 그만큼 후보 목록이 눌린다(오너 지적 2026-08-25).
          */}
          {/* "새 에이전트 만들기 또는 추가" 라벨로 들어온 시트에 '만들기' 경로가
              없었다 (U-D-2) — 검색 결과와 무관하게 만들기 진입점을 상시 제공한다. */}
          {onCreateAgent && (
            <button
              type="button"
              className={styles.secondaryAction}
              onClick={() => { setSelectedAgent(""); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); onCreateAgent(); }}
            ><IconPlus size={13} />{ko ? "새 에이전트 만들기" : "Create a new agent"}</button>
          )}

          {inventoryLoading && candidates.length === 0 ? <AgentInventoryLoading locale={locale} />
            : candidates.length > 0 ? <div className={styles.candidateGrid} role="list" aria-label={addCopy.installed}>{candidates.map((agent) => <button type="button" role="listitem" key={agent.id} data-active={selectedAgent === agent.id ? "true" : "false"} onClick={() => { setSelectedAgent(agent.id); setAddError(null); }}><span><strong>{agent.localDisplayName || (ko ? agent.name : agent.nameEn) || agent.name}</strong><small>{agent.kind === "team" ? addCopy.team : addCopy.single} · {ko ? "로컬" : "Local"}</small><em>{(ko ? agent.tagline : agent.taglineEn) || agent.tagline || agent.taglineEn}</em></span>{selectedAgent === agent.id && <IconCheck size={15} />}</button>)}</div>
            : <div className={styles.sheetEmpty}>{roleFilter ? addCopy.noMatch : (ko ? "사용 가능한 로컬 에이전트가 없습니다." : "No local agents are available.")}{roleFilter && <button type="button" className={styles.inlineLink} onClick={() => setRoleFilter(null)}>{addCopy.showAll}</button>}{onCreateAgent && <button type="button" className={styles.inlineLink} onClick={() => { setSelectedAgent(""); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); onCreateAgent(); }}>{ko ? "새 에이전트 만들기" : "Create a new agent"}</button>}</div>}
          {onBrowseMoreAgents && <button type="button" className={styles.secondaryAction} onClick={() => { setSelectedAgent(""); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); onBrowseMoreAgents(); }}>{addCopy.browseMore}</button>}

          {selectedCandidate && <section className={styles.selectedAgentPanel}>
            <div className={styles.modelPolicy}><IconSparkles size={15} /><div><strong>{addCopy.modelAuto}</strong><span>{selectedCandidate?.preferredBackend ? addCopy.modelPreferred(selectedCandidate.preferredBackend) : addCopy.modelDefault}</span></div></div>
            <p className={styles.note}>{addCopy.identityNote}</p>
          </section>}
          {addError && <p className={styles.addError} role="alert">{addError}</p>}
          {busy && <div className={styles.addBusy} role="status" aria-live="polite"><span className={styles.inventorySpinner} aria-hidden="true" /><span>{ko ? "에이전트를 조직에 연결하고 전용 채팅을 준비하고 있습니다." : "Connecting the agent to the organisation and preparing its dedicated chat."}<LoadingEstimate locale={ko ? "ko" : "en"} operationKey="one-agent-org-add" expectedSeconds={[2, 30]} /></span></div>}
          <div className={styles.sheetActions}><button type="button" disabled={busy} onClick={() => { setSelectedAgent(""); setAddSearch(""); setAddError(null); setRoleFilter(null); setAddOpen(false); }}>{addCopy.cancel}</button><button type="button" className={styles.primaryAction} disabled={!selectedAgent || busy} onClick={() => void submitAdd()}>{busy ? (ko ? "추가 중…" : "Adding…") : addCopy.add}</button></div>
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
        icon={<IconApps size={20} />}
        titleId="one-org-tools-title"
        ariaLabelledBy="one-org-tools-title"
      >
        {toolsMember && <div className={styles.toolsSheet}>
          <div className={styles.autoSelectRow}>
            <span className={styles.autoIcon} aria-hidden="true"><IconSparkles size={18} /></span><div><strong>{toolsCopy.auto}</strong><small>{ko ? "작업에 맞춰 선택" : "Match tools to the task"}</small></div>
            <button type="button" className={styles.toggle} data-on={toolsMember.autoSelectTools ? "true" : "false"} disabled={!onSetAutoSelect || toolsBusy} onClick={() => {
              if (!onSetAutoSelect) return;
              const next = !toolsMember.autoSelectTools;
              setToolsBusy(true);
              void onSetAutoSelect(toolsMember, next).then(() => setToolsMember((current) => current ? { ...current, autoSelectTools: next } : current)).finally(() => setToolsBusy(false));
            }} role="switch" aria-checked={toolsMember.autoSelectTools} aria-label={toolsCopy.auto}><span /></button>
          </div>
          <div className={styles.builtInTool}><span className={styles.toolMark}><IconCode size={15} /></span><div><strong>{locale === "ko" ? "파일 · 터미널" : "Files · Terminal"}</strong><small>{locale === "ko" ? "내장 도구 · 항상 사용 가능" : "Built-in tools · Always available"}</small></div><span className={styles.toolState}>{locale === "ko" ? "준비됨" : "Ready"}</span></div>
          <div className={styles.toolTabs} role="tablist" aria-label={locale === "ko" ? "도구 종류" : "Tool type"}><button type="button" role="tab" aria-selected={toolsTab === "plugins"} data-active={toolsTab === "plugins" ? "true" : "false"} onClick={() => setToolsTab("plugins")}><IconLayers size={15} />{toolsCopy.plugins}<small>{assignedTools.filter(tool => tool.source === "plugin").length}</small></button><button type="button" role="tab" aria-selected={toolsTab === "mcp"} data-active={toolsTab === "mcp" ? "true" : "false"} onClick={() => setToolsTab("mcp")}><IconRoute size={15} />{toolsCopy.mcp}<small>{assignedTools.filter(tool => tool.source === "custom").length}</small></button></div>
          <div className={styles.toolList}>
            {visibleAssignedTools.length === 0 && <div className={styles.sheetEmpty}><span className={styles.emptyToolIcon} aria-hidden="true">{toolsTab === "plugins" ? <IconLayers size={26} /> : <IconRoute size={26} />}</span><span>{ko ? "배정된 도구 없음" : "No assigned tools"}</span></div>}
            {visibleAssignedTools.map((tool) => <div className={styles.toolRow} key={tool.id}><span className={styles.toolMark}><IconApps size={14} /></span><div><strong>{locale === "ko" ? tool.name : tool.nameEn}</strong><small>{toolsTab === "plugins" ? toolsCopy.plugins : toolsCopy.mcp} · {tool.state === "ready" ? (locale === "ko" ? "연결됨" : "Connected") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "연결 필요" : "Connection needed")}</small></div>{tool.state === "needs-connection" && <button type="button" className={styles.toolAction} onClick={() => { const member = toolsMember; setToolsMember(null); onConnectTool?.(member, tool.id); }}>{locale === "ko" ? "연결" : "Connect"}</button>}<span className={styles.toolState}>{tool.state === "ready" ? (locale === "ko" ? "준비됨" : "Ready") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "확인 필요" : "Review")}</span></div>)}
          </div>
          <p className={styles.toolPermission}><IconShield size={14} />{ko ? "실행 권한 적용" : "Execution permissions apply"}</p>
          <div className={styles.sheetActions}><button type="button" onClick={() => { const member = toolsMember; setToolsMember(null); if (toolsTab === "plugins") onBrowseTools?.(member); else onConnectTool?.(member); }}><IconPlus size={13} />{toolsTab === "plugins" ? (locale === "ko" ? "플러그인 관리" : "Manage plugins") : (locale === "ko" ? "MCP 관리" : "Manage MCP")}</button><button type="button" className={styles.primaryAction} onClick={() => setToolsMember(null)}>{locale === "ko" ? "닫기" : "Close"}</button></div>
        </div>}
      </OneBottomSheet>
    </section>
  );
}
