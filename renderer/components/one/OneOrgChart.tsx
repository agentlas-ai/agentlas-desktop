import { useMemo, useState } from "react";
import type { InstalledAgent, InstalledMcpServer, McpServerStatus, McpToolCatalogEntry } from "@shared/types";
import type { OneOrgCollaborationStyle, OneOrgMember, OneOrgState } from "@shared/one-org";
import { OneAgentPortrait } from "./OneAgentPortrait";
import { OneBottomSheet } from "./OneBottomSheet";
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

export function OneOrgChart({
  state,
  installedAgents,
  locale,
  onAdd,
  onRename,
  onUpdate,
  onReplace,
  onArchive,
  onRestore,
  onRead,
  onReorder,
  onFailure,
  onOpenMember,
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
  locale: string;
  onAdd: (installedAgentId: string, displayName?: string, leaseExpiresAt?: string | null) => Promise<void>;
  onRename: (member: OneOrgMember, displayName: string) => Promise<void>;
  onUpdate?: (member: OneOrgMember, displayName: string, collaborationStyle: OneOrgCollaborationStyle) => Promise<void>;
  onReplace: (member: OneOrgMember, installedAgentId: string, handoverNote?: string) => Promise<void>;
  onArchive: (member: OneOrgMember) => Promise<void>;
  onRestore: (member: OneOrgMember) => Promise<void>;
  onRead: (member: OneOrgMember) => Promise<void>;
  onReorder: (orderedIds: string[], expectedRevision: number) => Promise<void>;
  onFailure?: (member: OneOrgMember) => void;
  onOpenMember?: (member: OneOrgMember) => void;
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
  const [addOpen, setAddOpen] = useState(false);
  const [addTab, setAddTab] = useState<"my" | "cloud" | "hub">("my");
  const [selectedAgent, setSelectedAgent] = useState("");
  const [name, setName] = useState("");
  const [leaseDays, setLeaseDays] = useState("0");
  const [busy, setBusy] = useState(false);
  const [editName, setEditName] = useState("");
  const [editorMember, setEditorMember] = useState<OneOrgMember | null>(null);
  const [editStyle, setEditStyle] = useState<OneOrgCollaborationStyle>("default");
  const [replaceId, setReplaceId] = useState("");
  const [handover, setHandover] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [roleFilter, setRoleFilter] = useState<string | null>(null);
  const [toolsMember, setToolsMember] = useState<OneOrgMember | null>(null);
  const [toolsBusy, setToolsBusy] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const ghostRoles = locale === "ko" ? ["개발", "마케팅", "리서치"] : ["Engineering", "Marketing", "Research"];
  const active = state?.members.filter((member) => !member.archivedAt) || [];
  const archived = state?.members.filter((member) => Boolean(member.archivedAt)) || [];
  const insufficientCredits = active.filter((member) => member.creditState === "insufficient");
  const usedIds = useMemo(() => new Set(active.map((member) => member.installedAgentId)), [active]);
  const roleTerms: Record<string, string[]> = {
    "개발": ["개발", "dev", "engineer", "code", "software", "build"],
    "마케팅": ["마케팅", "marketing", "growth", "sales", "content"],
    "리서치": ["리서치", "research", "analysis", "analyst", "조사"],
  };
  const candidates = installedAgents.filter((agent) => {
    if (usedIds.has(agent.id)) return false;
    if (!roleFilter) return true;
    const haystack = `${agent.name} ${agent.nameEn} ${agent.tagline} ${agent.taglineEn} ${agent.slug}`.toLocaleLowerCase();
    return (roleTerms[roleFilter] || []).some((term) => haystack.includes(term));
  });
  const taskForce = (activeTaskForceIds || []).map((id) => installedAgents.find((agent) => agent.id === id)).filter(Boolean);
  const remoteCandidates = installedAgents.filter((agent) => {
    const source = agent.assetSource === "agent-cloud" ? "cloud" : agent.assetSource === "hub" ? "hub" : null;
    return source === addTab && !usedIds.has(agent.id);
  });
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

  const submitAdd = async () => {
    if (!selectedAgent || busy || !state || state.slots.available <= 0 || addTab !== "my") return;
    setBusy(true);
    try {
      const days = Number.parseInt(leaseDays, 10);
      const leaseExpiresAt = Number.isFinite(days) && days > 0
        ? new Date(Date.now() + days * 24 * 60 * 60 * 1_000).toISOString()
        : null;
      await onAdd(selectedAgent, name.trim() || undefined, leaseExpiresAt);
      setSelectedAgent(""); setName(""); setLeaseDays("0"); setRoleFilter(null); setAddOpen(false);
    } finally { setBusy(false); }
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
          <div className={styles.searchSection}><strong>{searchCopy.people}</strong>{peopleResults.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noPeople}</span> : peopleResults.slice(0, 4).map((member) => <button type="button" key={member.id} onClick={() => { onOpenMember?.(member); setSearchOpen(false); setSearchQuery(""); }}><OneAgentPortrait status={member.statusKind} label={member.displayName} size="small" /><span><b>{member.displayName}</b><small>{statusLine(member, locale)}</small></span></button>)}</div>
          <div className={styles.searchSection}><strong>{searchCopy.conversations}</strong>{matchingConversations.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noConversations}</span> : matchingConversations.map((item) => <button type="button" key={item.id} onClick={() => { onOpenConversation?.(item.id); setSearchOpen(false); }}><span><b>{item.title}</b><small>{item.detail}</small></span></button>)}</div>
          <div className={styles.searchSection}><strong>{searchCopy.history}</strong>{matchingHistory.length === 0 ? <span className={styles.searchEmpty}>{searchCopy.noHistory}</span> : matchingHistory.map((item) => <button type="button" key={item.id} onClick={() => { onOpenHistory?.(item); setSearchOpen(false); }}>{<span><b>{item.title}</b><small>{item.detail}</small></span>}</button>)}</div>
        </div>}
      </div>}
      <div className={styles.oneRow}>
        <OneAgentPortrait status="quiet" label="Agentlas One" size="medium" tone="purple" />
        <div className={styles.rowCopy}><strong>One</strong><span>{locale === "ko" ? "CEO 오케스트레이터 · 항상 켜짐" : "CEO orchestrator · Always on"}</span></div>
        <span className={styles.badge}>CEO</span>
      </div>
      {insufficientCredits.length > 0 && <div className={styles.creditWarning} role="status"><span><IconShield size={13} />{locale === "ko" ? `크레딧 부족으로 ${insufficientCredits.length}명 멈춤` : `${insufficientCredits.length} staff paused for insufficient credits`}</span>{onBrowseCredits && <button type="button" onClick={onBrowseCredits}>{locale === "ko" ? "충전" : "Add credits"}</button>}</div>}
      <div className={styles.sectionLabel}>{locale === "ko" ? "상주 스태프" : "Standing Staff"}</div>
      <div className={styles.rows}>
        {active.length === 0 && <>
          <div className={styles.empty}>{locale === "ko" ? "아직 상주 스태프가 없습니다. 아래 역할을 골라 시작하세요." : "No standing staff yet. Pick a role to get started."}</div>
          <div className={styles.ghosts} aria-label={locale === "ko" ? "추천 역할" : "Suggested roles"}>
          {ghostRoles.map((role) => <button key={role} type="button" className={styles.ghost} onClick={() => { setName(role); setRoleFilter(role); setAddTab("my"); setAddOpen(true); }} disabled={!state || state.slots.available <= 0}><span><IconPlus size={14} /></span><strong>{role}</strong><small>{locale === "ko" ? "아직 없음" : "Not assigned"}</small></button>)}
          </div>
        </>}
        {active.map((member) => (
          <div className={styles.row} key={member.id} data-status={member.statusKind} draggable role="button" tabIndex={0} aria-label={`${member.displayName} · ${statusLine(member, locale)}`} onClick={() => onOpenMember?.(member)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenMember?.(member); } }} onDragStart={() => setDraggedId(member.id)} onDragEnd={() => setDraggedId(null)} onDragOver={(event) => event.preventDefault()} onDrop={() => {
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
            {member.unreadCount > 0 && <button type="button" className={styles.readButton} onClick={(event) => { event.stopPropagation(); void onRead(member); }}>{locale === "ko" ? "결과 확인" : "View result"}</button>}
            {member.statusKind === "failed" && onFailure && <button type="button" className={styles.failureButton} onClick={(event) => { event.stopPropagation(); onFailure(member); }}>{locale === "ko" ? "One에게" : "Ask One"}</button>}
            <div className={styles.rowActions}>
              <button
                type="button"
                className={styles.editButton}
                aria-label={locale === "ko" ? `${member.displayName} 편집` : `Edit ${member.displayName}`}
                onClick={(event) => {
                  event.stopPropagation();
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
      <button
        type="button"
        className={styles.addRow}
        onClick={() => setAddOpen(true)}
        disabled={!state || state.slots.available <= 0}
        aria-label={state?.slots.available ? (locale === "ko" ? "에이전트 추가" : "Add agent") : (locale === "ko" ? "슬롯이 가득 참" : "No staff slots available")}
      >
        <span className={styles.addAvatar} aria-hidden="true"><IconPlus size={16} /></span>
      </button>
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
        title={editorMember ? `${editorMember.displayName} 편집` : "조직원 편집"}
        titleId="one-org-member-editor-title"
        ariaLabelledBy="one-org-member-editor-title"
        description={locale === "ko" ? "이름과 협업 방식은 이 조직에만 적용됩니다. 원본 에이전트 패키지는 바뀌지 않습니다." : "Name and collaboration style apply only to this organisation. The source agent package stays unchanged."}
      >
        {editorMember && <div className={styles.memberEditor}>
          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>기본 정보</strong><span>{memberKind(editorMember, installedAgents, locale)} · {sourceLabel(editorMember.source, locale)}</span></div>
            <label className={styles.editorField}>이 조직에서 부를 이름<input value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={80} /></label>
            <div className={styles.editorReadOnly}><span>원본 담당</span><strong>{editorInstalled?.localDisplayName || editorInstalled?.name || editorMember.agentSlug}</strong><small>{editorInstalled?.tagline || editorInstalled?.taglineEn || "설치된 에이전트의 역할 정의를 사용합니다."}</small></div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>협업 말투</strong><span>One이 이 직원에게 일을 넘길 때 적용</span></div>
            <div className={styles.styleOptions} role="radiogroup" aria-label="협업 말투">
              {([
                ["default", "에이전트 기본", "원본 역할과 말투를 그대로 사용"],
                ["concise", "간결하게", "결론과 다음 행동을 먼저"],
                ["warm", "따뜻하게", "협업적이되 위험은 숨기지 않음"],
                ["direct", "직설적으로", "막힘과 선택지를 구체적으로"],
              ] as Array<[OneOrgCollaborationStyle, string, string]>).map(([value, label, detail]) => <button key={value} type="button" role="radio" aria-checked={editStyle === value} data-active={editStyle === value ? "true" : "false"} onClick={() => setEditStyle(value)}><span><strong>{label}</strong><small>{detail}</small></span>{editStyle === value && <span aria-hidden="true"><IconCheck size={13} /></span>}</button>)}
            </div>
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>모델과 도구</strong><span>자동 배정이 기본</span></div>
            <div className={styles.modelPolicy}>
              <IconSparkles size={15} />
              <div><strong>모델 · 자동</strong><span>{editorInstalled?.preferredBackend ? `권장 엔진 ${editorInstalled.preferredBackend} 우선` : "One이 작업마다 사용 가능한 런타임을 배정"}</span></div>
            </div>
            <p className={styles.editorHint}>직원을 추가할 때 모델을 강제로 고정하지 않습니다. 모델 고정은 팀 전체 실행 계획과 충돌할 수 있어 One 오케스트레이터 모델만 설정 메뉴에서 지정합니다.</p>
            {(onBrowseTools || onConnectTool) && <button type="button" className={styles.secondaryAction} onClick={() => { setToolsMember(editorMember); setEditorMember(null); }}>도구 설정 열기</button>}
          </section>

          <section className={styles.editorSection}>
            <div className={styles.editorHeading}><strong>담당 교체</strong><span>이름·대화·산출물은 유지</span></div>
            <label className={styles.editorField}>다른 에이전트<select value={replaceId} onChange={(event) => setReplaceId(event.target.value)}><option value="">교체할 에이전트 선택</option>{candidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.localDisplayName || agent.name}</option>)}</select></label>
            <label className={styles.editorCheck}><input type="checkbox" checked={handover} onChange={(event) => setHandover(event.target.checked)} /> 전임 담당의 인수인계 메모를 새 담당에게 전달</label>
            <p className={styles.editorHint}>교체하면 전임자의 경험·기억과 그 담당 전용 루틴은 이어지지 않습니다.</p>
            <button type="button" className={styles.secondaryAction} disabled={!replaceId || busy} onClick={() => void submitReplace(editorMember, replaceId)}>선택한 담당으로 교체</button>
          </section>

          <div className={styles.editorActions}>
            <button type="button" className={styles.archiveAction} disabled={busy} onClick={() => { void onArchive(editorMember).then(() => setEditorMember(null)); }}>해고 대신 보관</button>
            <span />
            <button type="button" className={styles.secondaryAction} disabled={busy} onClick={() => setEditorMember(null)}>취소</button>
            <button type="button" className={styles.primaryAction} disabled={busy || !editName.trim()} onClick={() => void submitMemberUpdate()}>저장</button>
          </div>
        </div>}
      </OneBottomSheet>

      {addOpen && <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setRoleFilter(null); setAddOpen(false); } }}>
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="one-org-add-title">
          <div className={styles.dialogHeader}><h3 id="one-org-add-title">{locale === "ko" ? "에이전트 추가" : "Add agent"}</h3><button type="button" aria-label={locale === "ko" ? "에이전트 추가 닫기" : "Close add agent"} onClick={() => { setRoleFilter(null); setAddOpen(false); }}><IconClose size={14} /></button></div>
          <p className={styles.slotNote}>슬롯 {state?.slots.used ?? 1}/{state?.slots.capacity ?? 1} 사용 중 · {state?.slots.available ?? 0}자리 남음</p>
          <div className={styles.tabs} role="tablist" aria-label="에이전트 출처">{([['my', 'My agents'], ['cloud', 'Cloud'], ['hub', 'Hub']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={addTab === key} data-active={addTab === key} onClick={() => setAddTab(key)}>{label}</button>)}</div>
          {addTab === "my" ? <>
            <label className={styles.field}>설치된 에이전트<select value={selectedAgent} onChange={(event) => setSelectedAgent(event.target.value)}><option value="">{roleFilter ? `${roleFilter} 역할에 맞는 에이전트` : "선택하세요"}</option>{candidates.map((agent) => <option key={agent.id} value={agent.id}>{agent.localDisplayName || agent.name}{agent.assetSource === "agent-cloud" ? " · Cloud" : agent.assetSource === "hub" ? " · Hub" : " · Local"}</option>)}</select></label>
            {roleFilter && candidates.length === 0 && <p className={styles.note}>설치된 에이전트 중 일치하는 역할이 없습니다. <button type="button" className={styles.inlineLink} onClick={() => setRoleFilter(null)}>전체 목록 보기</button></p>}
            <label className={styles.field}>표시 이름(선택)<input value={name} onChange={(event) => setName(event.target.value)} placeholder="예: 리서치 스태프" /></label>
            <label className={styles.field}>대여 기간<select value={leaseDays} onChange={(event) => setLeaseDays(event.target.value)}><option value="0">상주 · 만료 없음</option><option value="7">7일</option><option value="30">30일</option></select></label>
            {selectedCandidate && <div className={styles.modelPolicy}>
              <IconSparkles size={15} />
              <div><strong>모델 · 자동 배정</strong><span>{selectedCandidate.preferredBackend ? `에이전트 권장 엔진 ${selectedCandidate.preferredBackend}을 우선 사용합니다.` : "One이 작업과 사용 가능한 런타임에 맞춰 고릅니다."}</span></div>
            </div>}
            <p className={styles.note}>이름만 바뀌며 원본 에이전트와 실행 기록은 유지됩니다.</p>
          </> : <div className={styles.remoteEmpty}>
            {remoteCandidates.length > 0 ? <div className={styles.remoteList} role="list">{remoteCandidates.slice(0, 8).map((agent) => <div className={styles.remoteCard} role="listitem" key={agent.id}><OneAgentPortrait status="quiet" label={agent.name} tone={agent.tone} size="small" /><div><strong>{agent.localDisplayName || agent.name}</strong><small>{agent.kind === "team" ? "팀" : "단일"} · {addTab === "cloud" ? "Cloud" : "Hub"} · {agent.tagline || agent.taglineEn}</small></div><button type="button" onClick={() => { setSelectedAgent(agent.id); setName(agent.localDisplayName || agent.name); setLeaseDays(addTab === "hub" ? "7" : "0"); setAddTab("my"); }}>추가</button></div>)}</div> : <span>{addTab === "cloud" ? "Agent Cloud에 저장된 후보가 없습니다. 내 에이전트를 열어 설치한 뒤 붙일 수 있습니다." : "Hub 후보는 먼저 설치하거나 이번 작업에만 소환할 수 있습니다."}</span>}
            <button type="button" onClick={() => onBrowseSource?.(addTab)}>{addTab === "cloud" ? "내 에이전트 열기" : "Hub 검색 열기"}</button>
          </div>}
          <div className={styles.dialogActions}><button type="button" onClick={() => { setRoleFilter(null); setAddOpen(false); }}>취소</button><button type="button" className={styles.primary} disabled={!selectedAgent || busy || addTab !== "my"} onClick={() => void submitAdd()}>추가</button></div>
        </div>
      </div>}
      {toolsMember && <div className={styles.overlay} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setToolsMember(null); }}>
        <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="one-org-tools-title">
          <div className={styles.dialogHeader}><h3 id="one-org-tools-title">{toolsMember.displayName} · {locale === "ko" ? "도구" : "Tools"}</h3><button type="button" onClick={() => setToolsMember(null)} aria-label={locale === "ko" ? "도구 닫기" : "Close tools"}><IconClose size={14} /></button></div>
          <div className={styles.autoSelectRow}>
            <div><strong>자동 선택</strong><small>일에 맞는 도구를 실행 시점에 고릅니다.</small></div>
            <button type="button" className={styles.toggle} data-on={toolsMember.autoSelectTools ? "true" : "false"} disabled={!onSetAutoSelect || toolsBusy} onClick={() => {
              if (!onSetAutoSelect) return;
              const next = !toolsMember.autoSelectTools;
              setToolsBusy(true);
              void onSetAutoSelect(toolsMember, next).then(() => setToolsMember((current) => current ? { ...current, autoSelectTools: next } : current)).finally(() => setToolsBusy(false));
            }} aria-pressed={toolsMember.autoSelectTools}>{toolsMember.autoSelectTools ? "켜짐" : "꺼짐"}</button>
          </div>
          <div className={styles.toolList}>
            <div className={styles.toolRow}><span className={styles.toolMark}><IconCode size={14} /></span><div><strong>{locale === "ko" ? "파일 · 터미널" : "Files · Terminal"}</strong><small>{locale === "ko" ? "내장 · 항상 사용 가능" : "Built in · Always available"}</small></div><span className={styles.toolState}>{locale === "ko" ? "준비됨" : "Ready"}</span></div>
            {assignedTools.length === 0 && <p className={styles.note}>이 에이전트에 배정된 외부 MCP 도구가 없습니다.</p>}
            {assignedTools.map((tool) => <div className={styles.toolRow} key={tool.id}><span className={styles.toolMark}><IconApps size={14} /></span><div><strong>{locale === "ko" ? tool.name : tool.nameEn}</strong><small>{tool.source === "plugin" ? (locale === "ko" ? "플러그인" : "Plugin") : (locale === "ko" ? "내 MCP" : "My MCP")} · {tool.state === "ready" ? (locale === "ko" ? "연결됨" : "Connected") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "연결 필요" : "Connection needed")}</small></div>{tool.state === "needs-connection" && <button type="button" className={styles.toolAction} onClick={() => onConnectTool?.(toolsMember, tool.id)}>{locale === "ko" ? "연결 필요" : "Connect"}</button>}<span className={styles.toolState}>{tool.state === "ready" ? (locale === "ko" ? "준비됨" : "Ready") : tool.state === "disabled" ? (locale === "ko" ? "꺼짐" : "Off") : (locale === "ko" ? "확인 필요" : "Review")}</span></div>)}
          </div>
          <p className={styles.note}>플러그인과 내 MCP는 동일한 MCP 게이트와 권한 승인을 거칩니다.</p>
          <div className={styles.dialogActions}><button type="button" onClick={() => onConnectTool?.(toolsMember)}><IconPlus size={13} />{locale === "ko" ? "도구 붙이기" : "Attach tool"}</button><button type="button" className={styles.primary} onClick={() => setToolsMember(null)}>{locale === "ko" ? "닫기" : "Close"}</button></div>
        </div>
      </div>}
    </section>
  );
}
