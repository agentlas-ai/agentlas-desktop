"use client";

import { useCallback, useEffect, useMemo, useState, type DragEvent } from "react";
import { AgentAvatar } from "@/components/AgentAvatar";
import {
  IconBolt,
  IconChat,
  IconCheck,
  IconClose,
  IconEdit,
  IconLayers,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSearch,
  IconShield,
  IconTrash,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { classifyHubEntity, classifyInstalledAgent, entityClassLabel, entityClassShortLabel } from "@/lib/agent-entity-kind";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { visibleRosterAgents } from "@/lib/agent-roster";
import {
  callableHubBookmarks,
  hubBookmarkIdentityKey,
  hubBookmarkIdentityKeyFromParts,
  hubListingIdentityKey,
  onHubBookmarkChange,
} from "@/lib/hub-bookmark-events";
import type {
  AgentGroupMember,
  AgentGroupMemberSnapshot,
  AgentGroupResolved,
  HubAgentBookmark,
  InstalledAgent,
  InstalledFirm,
} from "@/lib/types";

type SourceKind = "installed" | "firm-node" | "hub";
type Translate = ReturnType<typeof useT>["t"];
type SourceItem = {
  key: string;
  kind: SourceKind;
  entityClass: "single" | "multi" | "plugin";
  title: string;
  subtitle: string;
  route: string;
  badge: string;
  tone?: InstalledAgent["tone"];
  member: AgentGroupMember;
};

export default function AgentGroupsPage() {
  const { locale, t } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [hubBookmarks, setHubBookmarks] = useState<HubAgentBookmark[]>([]);
  const [groups, setGroups] = useState<AgentGroupResolved[]>([]);
  const [hubStatus, setHubStatus] = useState<"loading" | "online" | "offline">("loading");
  const [query, setQuery] = useState("");
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [groupName, setGroupName] = useState("");
  const [groupDescription, setGroupDescription] = useState("");
  const [groupOrchestratorName, setGroupOrchestratorName] = useState("");
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
      const [agentRows, firmRows, bookmarkRows, groupRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.marketplace.bookmarks().catch(() => [] as HubAgentBookmark[]),
        api.agentGroups.listResolved(),
      ]);
      const visible = visibleRosterAgents(agentRows);
      setAgents(visible);
      setFirms(firmRows);
      setHubBookmarks(bookmarkRows);
      setGroups(groupRows);
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

  useEffect(
    () => onHubBookmarkChange((change) => {
      if (change.action === "synced") {
        setHubBookmarks(change.bookmarks);
      } else if (change.action === "added") {
        const addedIdentity = hubBookmarkIdentityKey(change.bookmark);
        setHubBookmarks((previous) => [
          change.bookmark,
          ...previous.filter((bookmark) => hubBookmarkIdentityKey(bookmark) !== addedIdentity),
        ]);
      } else {
        const removedIdentity = change.entityKind
          ? hubBookmarkIdentityKeyFromParts(change.slug, change.entityKind)
          : null;
        const normalizedSlug = change.slug.trim().toLowerCase();
        setHubBookmarks((previous) => previous.filter((bookmark) =>
          removedIdentity
            ? hubBookmarkIdentityKey(bookmark) !== removedIdentity
            : (bookmark.slug || bookmark.listing.slug).trim().toLowerCase() !== normalizedSlug
        ));
      }
    }),
    [],
  );

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 2800);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const sourceItems = useMemo(() => {
    const agentById = new Map(agents.map((agent) => [agent.id, agent]));
    const items: SourceItem[] = [];

    for (const agent of agents) {
      const loc = pickLocalized(agent, locale);
      const entityClass = classifyInstalledAgent(agent);
      items.push({
        key: `installed:${agent.id}`,
        kind: "installed",
        entityClass,
        title: loc.name,
        subtitle: loc.tagline,
        route: t("agentGroups.route.local"),
        badge: `${entityClassShortLabel(entityClass, locale)} · ${t("agentGroups.route.local")}`,
        tone: agent.tone,
        member: makeInstalledMember({
          source: "installed",
          agent,
          routeLabel: t("agentGroups.route.installed"),
        }),
      });
    }

    for (const firm of firms) {
      const firmLoc = pickLocalized(firm, locale);
      for (const node of firm.orgChart) {
        const agent = agentById.get(node.agentId);
        if (!agent) continue;
        const agentLoc = pickLocalized(agent, locale);
        const entityClass = classifyInstalledAgent(agent);
        const routeLabel = `${firmLoc.name} / ${node.role}`;
        items.push({
          key: `firm-node:${firm.id}:${node.agentSlug}`,
          kind: "firm-node",
          entityClass,
          title: `${node.role} · ${agentLoc.name}`,
          subtitle: agentLoc.tagline || firmLoc.tagline,
          route: routeLabel,
          badge: `${entityClassShortLabel(entityClass, locale)} · ${t("agentGroups.route.org")}`,
          tone: agent.tone,
          member: makeFirmNodeMember({
            firm,
            agent,
            node,
            routeLabel,
          }),
        });
      }
    }

    for (const bookmark of callableHubBookmarks(hubBookmarks, agents)) {
      const hub = bookmark.listing;
      const entityClass = classifyHubEntity(hub);
      if (entityClass === "plugin") continue;
      const hubEntityKind = entityClass === "multi" ? "team" : "agent";
      const loc = pickLocalized(hub, locale);
      items.push({
        key: `hub:${hubListingIdentityKey(hub)}`,
        kind: "hub",
        entityClass,
        title: loc.name,
        subtitle: loc.tagline,
        route: t("agentGroups.route.hub_bookmark"),
        badge: `${entityClassShortLabel(entityClass, locale)} · ${t("agentGroups.route.hub_bookmark")}`,
        member: {
          id: crypto.randomUUID(),
          source: "hub",
          agentSlug: hub.slug,
          hubSlug: hub.slug,
          hubEntityKind,
          snapshot: {
            name: hub.name,
            nameEn: hub.nameEn,
            tagline: hub.tagline,
            taglineEn: hub.taglineEn,
            routeLabel: t("agentGroups.route.hub_bookmark"),
            trustGrade: hub.trustGrade,
            entityKind: hubEntityKind,
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
  }, [agents, firms, hubBookmarks, locale, query, t]);

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

  function resetBuilder() {
    setEditingGroupId(null);
    setGroupName("");
    setGroupDescription("");
    setGroupOrchestratorName("");
    setDraftMembers([]);
  }

  function editGroup(group: AgentGroupResolved) {
    setEditingGroupId(group.id);
    setGroupName(group.name);
    setGroupDescription(group.description);
    setGroupOrchestratorName(group.orchestratorName);
    setDraftMembers(group.members.map(toEditableMember));
  }

  async function saveGroup() {
    const api = ipc();
    const name = groupName.trim();
    if (!api || !name || draftMembers.length === 0) return;
    setBusy(true);
    try {
      const payload = {
        name,
        description: groupDescription.trim(),
        orchestratorName: groupOrchestratorName.trim() || `${name} Orchestrator`,
        members: draftMembers,
      };
      if (editingGroupId) {
        await api.agentGroups.update(editingGroupId, payload);
        setGroups(await api.agentGroups.listResolved());
        setToast(t("agentGroups.toast.updated"));
      } else {
        await api.agentGroups.create(payload);
        resetBuilder();
        setGroups(await api.agentGroups.listResolved());
        setToast(t("agentGroups.toast.created"));
      }
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
    if (editingGroupId === groupId) {
      setDraftMembers((members) => members.filter((member) => member.id !== memberId));
    }
  }

  async function removeGroup(id: string) {
    const api = ipc();
    if (!api) return;
    if (!window.confirm(t("agentGroups.delete_confirm"))) return;
    await api.agentGroups.remove(id);
    setGroups(await api.agentGroups.listResolved());
    if (editingGroupId === id) resetBuilder();
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
  const localCount = sourceItems.filter((item) => item.kind === "installed").length;
  const firmNodeCount = sourceItems.filter((item) => item.kind === "firm-node").length;
  const hubCount = sourceItems.filter((item) => item.kind === "hub").length;
  const blockedPluginCount = hubBookmarks.filter((bookmark) => classifyHubEntity(bookmark.listing) === "plugin").length;
  const selectedGroup = editingGroupId ? groups.find((group) => group.id === editingGroupId) : null;

  return (
    <main className="agent-groups-page">
      <section className="agent-groups-hero">
        <div>
          <div className="agent-groups-kicker">
            <IconLayers size={14} />
            <span>{t("agentGroups.kicker")}</span>
          </div>
          <h2>{t("agentGroups.title")}</h2>
        </div>
        <div className="agent-groups-metrics" aria-label={t("agentGroups.status_label")}>
          <Metric label={t("agentGroups.metric.local")} value={String(localCount)} />
          <Metric label={t("agentGroups.metric.org")} value={String(firmNodeCount)} />
          <Metric label={t("agentGroups.metric.hub")} value={hubStatus === "loading" ? "..." : String(hubCount)} tone={hubStatus} />
          <Metric label={t("agentGroups.metric.saved")} value={String(groups.length)} />
        </div>
      </section>

      <section className="agent-groups-workbench">
        <aside className="agent-groups-source">
          <div className="agent-groups-panel-head">
            <strong>{t("agentGroups.source.title")}</strong>
            <button type="button" className="icon-btn" onClick={() => void refresh()} disabled={busy} title={t("agentGroups.refresh")}>
              <IconRefresh size={15} />
            </button>
          </div>
          <label className="agent-groups-search">
            <IconSearch size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("agentGroups.search")}
            />
          </label>
          <div className="agent-groups-rule">
            {blockedPluginCount > 0
              ? t("agentGroups.rule_hidden", { n: blockedPluginCount })
              : t("agentGroups.rule")}
          </div>
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
                data-entity-class={item.entityClass}
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
                {t("agentGroups.empty_sources")}
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
              <h3>{editingGroupId ? t("agentGroups.builder.edit") : t("agentGroups.builder.new")}</h3>
              {selectedGroup ? <small className="builder-editing-note">{selectedGroup.name}</small> : null}
            </div>
            <div className="builder-actions">
              {editingGroupId ? (
                <button type="button" className="ghost-btn" onClick={resetBuilder} disabled={busy}>
                  <IconPlus size={14} />
                  {t("agentGroups.action.new")}
                </button>
              ) : null}
              <button
                type="button"
                className="primary-btn"
                onClick={() => void saveGroup()}
                disabled={busy || !groupName.trim() || draftMembers.length === 0}
              >
                <IconBolt size={15} />
                {editingGroupId ? t("agentGroups.action.save") : t("agentGroups.action.create")}
              </button>
            </div>
          </div>

          <div className="group-form-grid">
            <label>
              <span>{t("agentGroups.field.name")}</span>
              <input
                value={groupName}
                onChange={(event) => setGroupName(event.target.value)}
                placeholder={t("agentGroups.placeholder.name")}
              />
            </label>
            <label>
              <span>{t("agentGroups.field.note")}</span>
              <input
                value={groupDescription}
                onChange={(event) => setGroupDescription(event.target.value)}
                placeholder={t("agentGroups.placeholder.note")}
              />
            </label>
            <label>
              <span>{t("agentGroups.field.orchestrator")}</span>
              <input
                value={groupOrchestratorName}
                onChange={(event) => setGroupOrchestratorName(event.target.value)}
                placeholder={groupName.trim() ? `${groupName.trim()} Orchestrator` : t("agentGroups.placeholder.auto_name")}
              />
            </label>
          </div>

          <div className="orchestrator-strip">
            <span className="orchestrator-mark"><IconRoute size={15} /></span>
            <div>
              <strong>{groupOrchestratorName.trim() || (groupName.trim() ? `${groupName.trim()} Orchestrator` : t("agentGroups.orchestrator.waiting"))}</strong>
              <small>{t("agentGroups.orchestrator.body")}</small>
            </div>
          </div>

          <div className="drop-zone">
            {draftMembers.length === 0 ? (
              <div className="drop-empty">
                <IconPlus size={18} />
                <strong>{t("agentGroups.drop")}</strong>
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
                        <span className="member-kind" data-entity-kind={memberEntityClass(snapshot)}>
                          {entityClassLabel(memberEntityClass(snapshot), locale)}
                        </span>
                      </div>
                      <button type="button" className="icon-btn" onClick={() => removeDraftMember(member.id)} title={t("agentGroups.action.remove")}>
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
            <strong>{t("agentGroups.saved.title")}</strong>
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
                    <button type="button" className="ghost-btn" onClick={() => editGroup(group)}>
                      <IconEdit size={13} />
                      {t("agentGroups.action.edit")}
                    </button>
                    <button type="button" className="ghost-btn" onClick={() => void startGroupChat(group)}>
                      <IconChat size={13} />
                      {t("agentGroups.action.chat")}
                    </button>
                    <button type="button" className="icon-btn" onClick={() => void removeGroup(group.id)} title={t("agentGroups.action.delete")}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                </header>
                {group.description && <p>{group.description}</p>}
                {group.warningCount > 0 && (
                  <div className="warning-strip">
                    <IconShield size={14} />
                    <span>{t("agentGroups.warning_count", { n: group.warningCount })}</span>
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
                          <small>{member.status === "ok" ? display.routeLabel || pickTagline(display, locale) : warningLabel(member.warnings, t)}</small>
                          <span className="member-kind" data-entity-kind={memberEntityClass(display)}>
                            {entityClassLabel(memberEntityClass(display), locale)}
                          </span>
                        </div>
                        <button type="button" className="icon-btn" onClick={() => void removeGroupMember(group.id, member.id)} title={t("agentGroups.action.remove_agent")}>
                          <IconClose size={13} />
                        </button>
                      </div>
                    );
                  })}
                  {group.members.length === 0 && (
                    <div className="agent-groups-empty compact">
                      {t("agentGroups.empty_members")}
                    </div>
                  )}
                </div>
              </article>
            ))}
            {!groups.length && (
              <div className="agent-groups-empty">
                {t("agentGroups.empty_groups")}
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

function makeInstalledMember(input: {
  source: "installed";
  agent: InstalledAgent;
  routeLabel: string;
}): AgentGroupMember {
  return {
    id: crypto.randomUUID(),
    source: input.source,
    agentId: input.agent.id,
    agentSlug: input.agent.slug,
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

function makeFirmNodeMember(input: {
  firm: InstalledFirm;
  agent: InstalledAgent;
  node: InstalledFirm["orgChart"][number];
  routeLabel: string;
}): AgentGroupMember {
  return {
    id: crypto.randomUUID(),
    source: "firm-node",
    agentId: input.agent.id,
    agentSlug: input.agent.slug,
    firmId: input.firm.id,
    firmSlug: input.firm.slug,
    nodeId: input.node.agentSlug,
    role: input.node.role,
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

function toEditableMember(member: AgentGroupResolved["members"][number]): AgentGroupMember {
  return {
    id: member.id,
    source: member.source,
    agentId: member.agentId,
    agentSlug: member.agentSlug,
    hubSlug: member.hubSlug,
    hubEntityKind: member.hubEntityKind,
    firmId: member.firmId,
    firmSlug: member.firmSlug,
    nodeId: member.nodeId,
    role: member.role,
    snapshot: member.current ?? member.snapshot,
    addedAt: member.addedAt,
  };
}

function memberKey(member: AgentGroupMember): string {
  const hubEntityKind = member.source === "hub"
    ? member.hubEntityKind || (member.snapshot.entityKind === "team" ? "team" : "agent")
    : "";
  return [
    member.source,
    hubEntityKind,
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

function warningLabel(warnings: string[], t: Translate) {
  if (warnings.includes("unsupported_plugin")) return t("agentGroups.warning.plugin");
  if (warnings.includes("unsupported_multi")) return t("agentGroups.warning.unsupported");
  if (warnings.includes("hub_missing")) return t("agentGroups.warning.hub_missing");
  if (warnings.includes("route_changed")) return t("agentGroups.warning.route_changed");
  if (warnings.includes("route_missing")) return t("agentGroups.warning.route_missing");
  if (warnings.includes("agent_missing")) return t("agentGroups.warning.agent_missing");
  return t("agentGroups.warning.needs_review");
}

function memberEntityClass(snapshot: AgentGroupMemberSnapshot): "single" | "multi" | "plugin" {
  if (snapshot.entityKind === "plugin") return "plugin";
  if (snapshot.entityKind === "team") return "multi";
  return "single";
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
        grid-template-columns: repeat(4, minmax(86px, 1fr));
        gap: 8px;
        min-width: 420px;
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
      .agent-groups-rule {
        margin: -2px 12px 10px;
        color: var(--muted-deep);
        font-size: 11.5px;
        line-height: 1.45;
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
      .agent-source-card[data-kind="firm-node"] .source-badge {
        background: color-mix(in oklch, var(--green) 30%, var(--paper));
        color: var(--green-deep);
      }
      .agent-source-card[data-entity-class="multi"] {
        border-color: color-mix(in oklch, var(--accent) 28%, var(--paper-edge));
      }
      .member-kind {
        width: fit-content;
        margin-top: 2px;
        border-radius: 999px;
        padding: 2px 7px;
        font-size: 10px;
        font-weight: 850;
        line-height: 1.2;
      }
      .member-kind[data-entity-kind="single"] {
        background: color-mix(in oklch, var(--green) 42%, var(--paper));
        color: var(--green-deep);
      }
      .member-kind[data-entity-kind="multi"] {
        background: color-mix(in oklch, var(--accent-soft) 72%, var(--paper));
        color: var(--accent-strong);
      }
      .member-kind[data-entity-kind="plugin"] {
        background: var(--peach-soft);
        color: var(--amber-deep);
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
      .builder-editing-note {
        display: block;
        margin-top: 3px;
        color: var(--muted-deep);
        font-size: 11px;
        font-weight: 700;
        max-width: 220px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .builder-step {
        font-family: var(--font-mono);
        font-size: 11px;
        font-weight: 800;
        color: var(--accent-strong);
      }
      .builder-actions {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        flex-shrink: 0;
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
      .ghost-btn:disabled {
        opacity: 0.5;
        cursor: default;
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
        .builder-actions {
          width: 100%;
        }
        .primary-btn {
          width: 100%;
        }
        .builder-actions .ghost-btn {
          flex: 1;
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
