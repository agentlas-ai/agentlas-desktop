"use client";

import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  IconBolt,
  IconChat,
  IconCheck,
  IconClose,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconShield,
  IconTrash,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { visibleAgents } from "@/lib/agent-visibility";
import type {
  AgentGroupMember,
  AgentGroupResolved,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  ResolvedNode,
} from "@/lib/types";

type SourceKind = "org" | "installed" | "hub";
type SourceItem = {
  key: string;
  kind: SourceKind;
  title: string;
  subtitle: string;
  route: string;
  badge: string;
  tone?: InstalledAgent["tone"];
  member: AgentGroupMember;
};

export default function AgentGroupsPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [resolvedNodes, setResolvedNodes] = useState<Record<string, ResolvedNode[]>>({});
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [groups, setGroups] = useState<AgentGroupResolved[]>([]);
  const [hubStatus, setHubStatus] = useState<"loading" | "online" | "offline">("loading");
  const [query, setQuery] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [draftMembers, setDraftMembers] = useState<AgentGroupMember[]>([]);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    setHubStatus("loading");
    try {
      const [agentRows, firmRows, groupRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.agentGroups.listResolved(),
      ]);
      const visible = visibleAgents(agentRows);
      setAgents(visible);
      setFirms(firmRows);
      setGroups(groupRows);

      const nextResolved: Record<string, ResolvedNode[]> = {};
      await Promise.all(
        firmRows.map(async (firm) => {
          const org = await api.firms.getResolvedOrg(firm.id).catch(() => null);
          if (org) {
            nextResolved[firm.id] = [
              org.ceo,
              ...org.divisions.flatMap((division) => [division, ...division.specialists]),
            ];
          }
        }),
      );
      setResolvedNodes(nextResolved);

      const hub = await api.marketplace.search("").catch(() => []);
      setHubAgents(hub);
      const status = await api.marketplace.status().catch(() => null);
      setHubStatus(status?.online ? "online" : "offline");
    } catch (err) {
      setToast(String(err));
      setHubStatus("offline");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sourceItems = useMemo(() => {
    const agentMap = new Map(agents.map((agent) => [agent.id, agent]));
    const inFirm = new Set<string>();
    const items: SourceItem[] = [];

    for (const firm of firms) {
      const firmLoc = pickLocalized(firm, locale);
      const resolved = resolvedNodes[firm.id];
      if (resolved?.length) {
        for (const node of resolved) {
          if (!node.agentId) continue;
          const agent = agentMap.get(node.agentId);
          if (!agent) continue;
          inFirm.add(agent.id);
          const loc = pickLocalized(agent, locale);
          items.push({
            key: `org:${firm.id}:${node.id}:${agent.id}`,
            kind: "org",
            title: loc.name,
            subtitle: node.role,
            route: `${firmLoc.name} / ${node.role}`,
            badge: ko ? "조직도" : "Org",
            tone: agent.tone,
            member: makeMember({
              source: "firm-node",
              agent,
              routeLabel: `${firmLoc.name} / ${node.role}`,
              firm,
              node,
            }),
          });
        }
      } else {
        for (const node of firm.orgChart) {
          const agent = agentMap.get(node.agentId);
          if (!agent) continue;
          inFirm.add(agent.id);
          const loc = pickLocalized(agent, locale);
          items.push({
            key: `org:${firm.id}:${node.agentSlug}:${agent.id}`,
            kind: "org",
            title: loc.name,
            subtitle: node.role,
            route: `${firmLoc.name} / ${node.role}`,
            badge: ko ? "조직도" : "Org",
            tone: agent.tone,
            member: makeMember({
              source: "firm-node",
              agent,
              routeLabel: `${firmLoc.name} / ${node.role}`,
              firm,
              node: { id: node.agentSlug, name: loc.name, role: node.role, agentId: agent.id },
            }),
          });
        }
      }
    }

    for (const agent of agents) {
      if (inFirm.has(agent.id)) continue;
      const loc = pickLocalized(agent, locale);
      items.push({
        key: `installed:${agent.id}`,
        kind: "installed",
        title: loc.name,
        subtitle: loc.tagline,
        route: ko ? "설치됨" : "Installed",
        badge: agent.kind === "team" ? (ko ? "팀" : "Team") : (ko ? "로컬" : "Local"),
        tone: agent.tone,
        member: makeMember({
          source: "installed",
          agent,
          routeLabel: ko ? "설치됨" : "Installed",
        }),
      });
    }

    for (const hub of hubAgents) {
      const loc = pickLocalized(hub, locale);
      items.push({
        key: `hub:${hub.slug}`,
        kind: "hub",
        title: loc.name,
        subtitle: loc.tagline,
        route: "Hub",
        badge: hub.entityKind === "team" ? (ko ? "Hub 팀" : "Hub team") : "Hub",
        member: {
          id: crypto.randomUUID(),
          source: "hub",
          agentSlug: hub.slug,
          hubSlug: hub.slug,
          snapshot: {
            name: hub.name,
            nameEn: hub.nameEn,
            tagline: hub.tagline,
            taglineEn: hub.taglineEn,
            routeLabel: "Hub",
            trustGrade: hub.trustGrade,
            entityKind: hub.entityKind ?? hub.kind,
            routingStatus: hub.routingStatus ?? null,
          },
          addedAt: new Date().toISOString(),
        },
      });
    }

    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) =>
      `${item.title} ${item.subtitle} ${item.route} ${item.badge}`.toLowerCase().includes(q),
    );
  }, [agents, firms, hubAgents, ko, locale, query, resolvedNodes]);

  function addMember(item: SourceItem) {
    setDraftMembers((prev) => {
      const key = memberKey(item.member);
      if (prev.some((member) => memberKey(member) === key)) return prev;
      return [{ ...item.member, id: crypto.randomUUID(), addedAt: new Date().toISOString() }, ...prev];
    });
  }

  function removeDraftMember(id: string) {
    setDraftMembers((prev) => prev.filter((member) => member.id !== id));
  }

  async function createGroup() {
    const api = ipc();
    const name = groupName.trim();
    if (!api || !name || draftMembers.length === 0) return;
    setBusy(true);
    try {
      await api.agentGroups.create({
        name,
        description: groupDescription.trim(),
        orchestratorName: `${name} Orchestrator`,
        members: draftMembers,
      });
      setGroupName("");
      setGroupDescription("");
      setDraftMembers([]);
      setGroups(await api.agentGroups.listResolved());
      setToast(ko ? "에이전트 조합을 만들었습니다." : "Agent group created.");
    } catch (err) {
      setToast(String(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeGroupMember(groupId: string, memberId: string) {
    const api = ipc();
    if (!api) return;
    await api.agentGroups.removeMember(groupId, memberId);
    setGroups(await api.agentGroups.listResolved());
  }

  async function removeGroup(id: string) {
    const api = ipc();
    if (!api) return;
    if (!window.confirm(ko ? "이 에이전트 조합을 삭제할까요?" : "Delete this agent group?")) return;
    await api.agentGroups.remove(id);
    setGroups(await api.agentGroups.listResolved());
  }

  async function startGroupChat(group: AgentGroupResolved) {
    const api = ipc();
    if (!api) return;
    try {
      const chat = await api.chats.create({
        agentGroupId: group.id,
        title: group.name,
      });
      navigate(`/chat?id=${chat.id}`);
    } catch (err) {
      setToast(String(err));
    }
  }

  function onDragStart(event: DragEvent<HTMLElement>, item: SourceItem) {
    event.dataTransfer.setData("application/x-agentlas-source", item.key);
    event.dataTransfer.effectAllowed = "copy";
    setDraggingKey(item.key);
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const key = event.dataTransfer.getData("application/x-agentlas-source");
    const item = sourceItems.find((entry) => entry.key === key);
    if (item) addMember(item);
    setDropActive(false);
    setDraggingKey(null);
  }

  const draftSnapshots = draftMembers.map((member) => member.snapshot);
  const orgCount = sourceItems.filter((item) => item.kind === "org").length;
  const hubCount = hubAgents.length;

  return (
    <main className="agent-groups-page">
      <section className="agent-groups-hero">
        <div>
          <div className="agent-groups-kicker">
            <IconLayers size={14} />
            <span>{ko ? "에이전트 조합" : "Agent group"}</span>
          </div>
          <h2>{ko ? "자주 쓰는 조합을 상위 오케스트레이터로 묶기" : "Compose frequent agent sets into one orchestrator"}</h2>
        </div>
        <div className="agent-groups-metrics" aria-label={ko ? "에이전트 조합 상태" : "Agent group status"}>
          <Metric label={ko ? "조직도 후보" : "Org routes"} value={String(orgCount)} />
          <Metric label="Hub" value={hubStatus === "loading" ? "..." : String(hubCount)} tone={hubStatus} />
          <Metric label={ko ? "저장된 조합" : "Saved groups"} value={String(groups.length)} />
        </div>
      </section>

      <section className="agent-groups-workbench">
        <aside className="agent-groups-source">
          <div className="agent-groups-panel-head">
            <strong>{ko ? "에이전트 소스" : "Agent sources"}</strong>
            <button type="button" className="icon-btn" onClick={() => void refresh()} disabled={busy} title={ko ? "새로고침" : "Refresh"}>
              <IconRefresh size={15} />
            </button>
          </div>
          <label className="agent-groups-search">
            <IconSearch size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={ko ? "조직도, 로컬, Hub 검색" : "Search org, local, Hub"}
            />
          </label>
          <div className="agent-source-list">
            {sourceItems.map((item) => (
              <button
                key={item.key}
                type="button"
                draggable
                onDragStart={(event) => onDragStart(event, item)}
                onDragEnd={() => setDraggingKey(null)}
                onClick={() => addMember(item)}
                className="agent-source-card"
                data-kind={item.kind}
                data-dragging={draggingKey === item.key ? "true" : "false"}
              >
                <AgentAvatar name={item.title} tone={item.tone ?? "blue"} size={30} />
                <span className="agent-source-copy">
                  <strong>{item.title}</strong>
                  <small>{item.subtitle}</small>
                  <em>{item.route}</em>
                </span>
                <span className="source-badge">{item.badge}</span>
              </button>
            ))}
            {!sourceItems.length && (
              <div className="agent-groups-empty">
                {ko ? "표시할 에이전트가 없습니다." : "No agents to show."}
              </div>
            )}
          </div>
        </aside>

        <section
          className="agent-groups-builder"
          data-drop-active={dropActive ? "true" : "false"}
          onDragOver={(event) => {
            event.preventDefault();
            setDropActive(true);
          }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDrop}
        >
          <div className="builder-title-row">
            <div>
              <span className="builder-step">01</span>
              <h3>{ko ? "새 조합" : "New group"}</h3>
            </div>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void createGroup()}
              disabled={busy || !groupName.trim() || draftMembers.length === 0}
            >
              <IconBolt size={15} />
              {ko ? "그룹 만들기" : "Create group"}
            </button>
          </div>

          <div className="group-form-grid">
            <label>
              <span>{ko ? "이름" : "Name"}</span>
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder={ko ? "예: 출시 점검 조합" : "e.g. Launch review group"}
              />
            </label>
            <label>
              <span>{ko ? "메모" : "Note"}</span>
              <input
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder={ko ? "짧은 목적" : "Short purpose"}
              />
            </label>
          </div>

          <div className="orchestrator-strip">
            <span className="orchestrator-mark"><IconRoute size={15} /></span>
            <div>
              <strong>{groupName.trim() ? `${groupName.trim()} Orchestrator` : ko ? "오케스트레이터 이름 대기" : "Waiting for orchestrator name"}</strong>
              <small>{ko ? "멤버는 최신 설치 목록과 Hub 카탈로그에서 다시 해석됩니다." : "Members re-resolve from installed agents and the live Hub catalog."}</small>
            </div>
          </div>

          <div className="drop-zone">
            {draftMembers.length === 0 ? (
              <div className="drop-empty">
                <IconPlus size={18} />
                <strong>{ko ? "여기에 에이전트를 놓기" : "Drop agents here"}</strong>
              </div>
            ) : (
              <div className="draft-member-grid">
                {draftMembers.map((member, index) => {
                  const snapshot = draftSnapshots[index];
                  return (
                    <div key={member.id} className="draft-member">
                      <span className="member-order">{index + 1}</span>
                      <div>
                        <strong>{pickName(snapshot, locale)}</strong>
                        <small>{snapshot.routeLabel || pickTagline(snapshot, locale)}</small>
                      </div>
                      <button type="button" className="icon-btn" onClick={() => removeDraftMember(member.id)} title={ko ? "제거" : "Remove"}>
                        <IconClose size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <aside className="agent-groups-saved">
          <div className="agent-groups-panel-head">
            <strong>{ko ? "저장된 조합" : "Saved groups"}</strong>
            <span className="saved-count">{groups.length}</span>
          </div>
          <div className="saved-groups-list">
            {groups.map((group) => (
              <article key={group.id} className="saved-group" data-warning={group.warningCount > 0 ? "true" : "false"}>
                <header>
                  <div>
                    <strong>{group.name}</strong>
                    <small>{group.orchestratorName}</small>
                  </div>
                  <div className="saved-group-actions">
                    <button type="button" className="ghost-btn" onClick={() => void startGroupChat(group)}>
                      <IconChat size={13} />
                      {ko ? "채팅 시작" : "Chat"}
                    </button>
                    <button type="button" className="icon-btn" onClick={() => void removeGroup(group.id)} title={ko ? "삭제" : "Delete"}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                </header>
                {group.description && <p>{group.description}</p>}
                {group.warningCount > 0 && (
                  <div className="warning-strip">
                    <IconShield size={14} />
                    <span>{ko ? `${group.warningCount}개 라우팅 경고` : `${group.warningCount} routing warning(s)`}</span>
                  </div>
                )}
                <div className="saved-member-list">
                  {group.members.map((member) => {
                    const display = member.current ?? member.snapshot;
                    return (
                      <div key={member.id} className="saved-member" data-status={member.status}>
                        <span className="status-dot">
                          {member.status === "ok" ? <IconCheck size={11} /> : "!"}
                        </span>
                        <div>
                          <strong>{pickName(display, locale)}</strong>
                          <small>{member.status === "ok" ? display.routeLabel || pickTagline(display, locale) : warningLabel(member.warnings, ko)}</small>
                        </div>
                        <button type="button" className="icon-btn" onClick={() => void removeGroupMember(group.id, member.id)} title={ko ? "이 에이전트만 삭제" : "Remove this agent"}>
                          <IconClose size={13} />
                        </button>
                      </div>
                    );
                  })}
                  {group.members.length === 0 && (
                    <div className="agent-groups-empty compact">
                      {ko ? "멤버가 없습니다." : "No members."}
                    </div>
                  )}
                </div>
              </article>
            ))}
            {!groups.length && (
              <div className="agent-groups-empty">
                {ko ? "아직 저장된 조합이 없습니다." : "No saved groups yet."}
              </div>
            )}
          </div>
        </aside>
      </section>

      {toast && <div className="agent-groups-toast">{toast}</div>}
      <AgentGroupsStyles />
    </main>
  );
}

function makeMember(input: {
  source: "installed" | "firm-node";
  agent: InstalledAgent;
  routeLabel: string;
  firm?: InstalledFirm;
  node?: ResolvedNode;
}): AgentGroupMember {
  return {
    id: crypto.randomUUID(),
    source: input.source,
    agentId: input.agent.id,
    agentSlug: input.agent.slug,
    firmId: input.firm?.id,
    firmSlug: input.firm?.slug,
    nodeId: input.node?.id,
    role: input.node?.role,
    snapshot: {
      name: input.agent.name,
      nameEn: input.agent.nameEn,
      tagline: input.agent.tagline,
      taglineEn: input.agent.taglineEn,
      routeLabel: input.routeLabel,
      trustGrade: input.agent.trustGrade,
      runtimeLabel: input.agent.runtimeLabel,
      entityKind: input.agent.kind,
    },
    addedAt: new Date().toISOString(),
  };
}

function memberKey(member: AgentGroupMember): string {
  return [
    member.source,
    member.firmId || member.firmSlug || "",
    member.nodeId || "",
    member.agentId || "",
    member.agentSlug || member.hubSlug || "",
  ].join(":");
}

function pickName(value: { name: string; nameEn?: string }, locale: "ko" | "en") {
  return locale === "ko" ? value.name : value.nameEn || value.name;
}

function pickTagline(value: { tagline?: string; taglineEn?: string }, locale: "ko" | "en") {
  return locale === "ko" ? value.tagline || "" : value.taglineEn || value.tagline || "";
}

function warningLabel(warnings: string[], ko: boolean) {
  if (warnings.includes("hub_missing")) return ko ? "Hub에서 찾을 수 없음" : "Missing from Hub";
  if (warnings.includes("route_changed")) return ko ? "조직도 위치 변경됨" : "Org route changed";
  if (warnings.includes("route_missing")) return ko ? "조직도 위치 없음" : "Org route missing";
  if (warnings.includes("agent_missing")) return ko ? "설치 에이전트 없음" : "Installed agent missing";
  return ko ? "확인 필요" : "Needs review";
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="agent-groups-metric" data-tone={tone ?? "neutral"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AgentGroupsStyles() {
  return (
    <style>{`
      .agent-groups-page {
        min-height: 100%;
        padding: 22px 24px 26px;
        color: var(--ink);
        background: var(--rd-bg);
      }
      .agent-groups-hero {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 18px;
        margin-bottom: 18px;
      }
      .agent-groups-kicker {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        color: var(--accent-strong);
        font-size: 12px;
        font-weight: 800;
      }
      .agent-groups-hero h2 {
        margin: 8px 0 0;
        font-family: var(--font-head);
        font-size: 24px;
        line-height: 1.15;
        letter-spacing: 0;
      }
      .agent-groups-metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(92px, 1fr));
        gap: 8px;
        min-width: 330px;
      }
      .agent-groups-metric {
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        padding: 9px 10px;
      }
      .agent-groups-metric span {
        display: block;
        color: var(--muted-deep);
        font-size: 11px;
        font-weight: 700;
      }
      .agent-groups-metric strong {
        display: block;
        margin-top: 4px;
        font-size: 18px;
        line-height: 1;
      }
      .agent-groups-metric[data-tone="online"] strong { color: var(--green-deep); }
      .agent-groups-metric[data-tone="offline"] strong { color: var(--red-deep); }
      .agent-groups-workbench {
        display: grid;
        grid-template-columns: minmax(270px, 0.86fr) minmax(390px, 1.26fr) minmax(300px, 0.95fr);
        gap: 14px;
        align-items: stretch;
        min-height: calc(100vh - 172px);
      }
      .agent-groups-source,
      .agent-groups-builder,
      .agent-groups-saved {
        min-width: 0;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        box-shadow: var(--shadow-1);
        overflow: hidden;
      }
      .agent-groups-source,
      .agent-groups-saved {
        display: flex;
        flex-direction: column;
      }
      .agent-groups-panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 13px 14px;
        border-bottom: 1px solid var(--paper-edge);
      }
      .agent-groups-panel-head strong {
        font-size: 13px;
        font-family: var(--font-head);
      }
      .icon-btn {
        width: 28px;
        height: 28px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        color: var(--ink-soft);
        cursor: pointer;
        flex-shrink: 0;
      }
      .icon-btn:hover:not(:disabled) {
        background: var(--fill-1);
        color: var(--ink);
      }
      .icon-btn:disabled {
        opacity: 0.55;
        cursor: default;
      }
      .agent-groups-search {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 12px 12px 10px;
        padding: 9px 10px;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper-2);
      }
      .agent-groups-search input,
      .group-form-grid input {
        width: 100%;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--ink);
        font: inherit;
        min-width: 0;
      }
      .agent-source-list,
      .saved-groups-list {
        flex: 1;
        overflow: auto;
        padding: 0 12px 12px;
      }
      .agent-source-card {
        width: 100%;
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 9px;
        margin-bottom: 7px;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        color: var(--ink);
        text-align: left;
        cursor: grab;
      }
      .agent-source-card:hover,
      .agent-source-card[data-dragging="true"] {
        border-color: var(--accent);
        background: var(--fill-1);
      }
      .agent-source-copy {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .agent-source-copy strong,
      .draft-member strong,
      .saved-group header strong,
      .saved-member strong {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12.5px;
      }
      .agent-source-copy small,
      .agent-source-copy em,
      .draft-member small,
      .saved-member small,
      .saved-group header small,
      .orchestrator-strip small {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--muted-deep);
        font-style: normal;
      }
      .source-badge,
      .saved-count {
        border-radius: 999px;
        background: var(--paper-2);
        color: var(--muted-deep);
        padding: 3px 7px;
        font-size: 10px;
        font-weight: 800;
        white-space: nowrap;
      }
      .agent-source-card[data-kind="hub"] .source-badge {
        background: var(--accent-soft);
        color: var(--accent-strong);
      }
      .agent-groups-builder {
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        transition: border-color 0.16s ease, background 0.16s ease;
      }
      .agent-groups-builder[data-drop-active="true"] {
        border-color: var(--accent);
        background: color-mix(in oklch, var(--paper) 88%, var(--accent-soft));
      }
      .builder-title-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
      }
      .builder-title-row h3 {
        margin: 3px 0 0;
        font-size: 18px;
        font-family: var(--font-head);
      }
      .builder-step {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 800;
        color: var(--accent-strong);
      }
      .primary-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 7px;
        min-height: 34px;
        padding: 0 13px;
        border: 1px solid var(--accent);
        border-radius: 8px;
        background: var(--accent);
        color: white;
        font-size: 12px;
        font-weight: 800;
        cursor: pointer;
      }
      .primary-btn:disabled {
        opacity: 0.5;
        cursor: default;
      }
      .group-form-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .group-form-grid label {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 11px;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper-2);
      }
      .group-form-grid span {
        color: var(--muted-deep);
        font-size: 11px;
        font-weight: 800;
      }
      .orchestrator-strip {
        display: flex;
        align-items: center;
        gap: 11px;
        padding: 12px;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: linear-gradient(135deg, var(--fill-1), var(--paper));
      }
      .orchestrator-mark {
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 8px;
        color: white;
        background: var(--accent);
      }
      .orchestrator-strip div {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .drop-zone {
        flex: 1;
        min-height: 300px;
        border: 1px dashed var(--paper-edge);
        border-radius: 8px;
        background: var(--paper-2);
        padding: 12px;
        overflow: auto;
      }
      .drop-empty {
        min-height: 260px;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 8px;
        color: var(--muted-deep);
      }
      .draft-member-grid {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .draft-member,
      .saved-member {
        display: grid;
        grid-template-columns: auto minmax(0, 1fr) auto;
        gap: 9px;
        align-items: center;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        padding: 9px;
      }
      .member-order,
      .status-dot {
        width: 23px;
        height: 23px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 7px;
        background: var(--paper-2);
        color: var(--muted-deep);
        font-size: 10px;
        font-weight: 900;
      }
      .draft-member > div,
      .saved-member > div {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .status-dot {
        background: var(--green);
        color: var(--ink);
      }
      .saved-member[data-status="moved"] .status-dot,
      .saved-member[data-status="missing"] .status-dot {
        background: var(--amber);
        color: var(--ink);
      }
      .saved-group {
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        padding: 11px;
        margin-bottom: 10px;
      }
      .saved-group[data-warning="true"] {
        border-color: color-mix(in oklch, var(--amber-deep) 42%, var(--paper-edge));
      }
      .saved-group header {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 8px;
        align-items: start;
      }
      .saved-group-actions {
        display: inline-flex;
        align-items: center;
        gap: 6px;
      }
      .ghost-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 5px;
        min-height: 28px;
        padding: 0 9px;
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        color: var(--ink-soft);
        font-size: 11px;
        font-weight: 800;
        cursor: pointer;
        white-space: nowrap;
      }
      .ghost-btn:hover {
        background: var(--fill-1);
        color: var(--ink);
      }
      .saved-group header div {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .saved-group p {
        margin: 7px 0 0;
        color: var(--muted-deep);
        font-size: 12px;
        line-height: 1.45;
      }
      .warning-strip {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-top: 9px;
        padding: 7px 8px;
        border-radius: 8px;
        background: var(--peach-soft);
        color: var(--amber-deep);
        font-size: 11px;
        font-weight: 800;
      }
      .saved-member-list {
        display: flex;
        flex-direction: column;
        gap: 7px;
        margin-top: 10px;
      }
      .agent-groups-empty {
        border: 1px dashed var(--paper-edge);
        border-radius: 8px;
        padding: 18px 12px;
        color: var(--muted-deep);
        text-align: center;
        font-size: 12px;
      }
      .agent-groups-empty.compact {
        padding: 10px;
      }
      .agent-groups-toast {
        position: fixed;
        right: 22px;
        bottom: 22px;
        z-index: 50;
        max-width: min(360px, calc(100vw - 44px));
        border: 1px solid var(--paper-edge);
        border-radius: 8px;
        background: var(--paper);
        color: var(--ink);
        box-shadow: var(--shadow-2);
        padding: 10px 12px;
        font-size: 12px;
        font-weight: 700;
      }
      @media (max-width: 1180px) {
        .agent-groups-workbench {
          grid-template-columns: 1fr;
          min-height: 0;
        }
        .agent-groups-source,
        .agent-groups-builder,
        .agent-groups-saved {
          min-height: 360px;
        }
      }
      @media (max-width: 760px) {
        .agent-groups-page {
          padding: 12px 10px;
        }
        .agent-groups-hero {
          align-items: stretch;
          flex-direction: column;
        }
        .agent-groups-hero h2 {
          font-size: 20px;
          line-height: 1.18;
        }
        .agent-groups-metrics,
        .group-form-grid {
          grid-template-columns: 1fr;
          min-width: 0;
        }
        .agent-groups-workbench {
          gap: 10px;
        }
        .agent-groups-source,
        .agent-groups-builder,
        .agent-groups-saved {
          min-height: 280px;
        }
        .builder-title-row {
          align-items: stretch;
          flex-direction: column;
        }
        .primary-btn {
          width: 100%;
        }
        .agent-source-card {
          grid-template-columns: auto minmax(0, 1fr);
        }
        .source-badge {
          grid-column: 2;
          justify-self: start;
        }
        .draft-member,
        .saved-member {
          grid-template-columns: auto minmax(0, 1fr);
        }
        .saved-group header {
          grid-template-columns: 1fr;
        }
        .saved-group-actions {
          justify-content: flex-end;
        }
        .draft-member .icon-btn,
        .saved-member .icon-btn {
          grid-column: 2;
          justify-self: end;
          width: 24px;
          height: 24px;
        }
      }
    `}</style>
  );
}
