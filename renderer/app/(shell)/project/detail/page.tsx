// 프로젝트 상세 — 프로젝트 문맥, 채팅, PM 메모리 기반 작업 타임라인.
"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { IconPlus, IconTrash } from "@/components/Icon";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import type {
  Chat,
  InstalledAgent,
  Project,
  ProjectTimelineEntry,
  ProjectTimelineSnapshot,
} from "@/lib/types";

export default function ProjectPageWrapper() {
  return (
    <Suspense fallback={null}>
      <ProjectPage />
    </Suspense>
  );
}

function ProjectPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const { t, locale } = useT();
  const [project, setProject] = useState<Project | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [timeline, setTimeline] = useState<ProjectTimelineSnapshot | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageMessage, setPageMessage] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    setLoading(true);
    setPageMessage("");
    if (!api || !id) {
      setPageMessage(
        locale === "en"
          ? "Project could not be opened. Nothing changed."
          : "프로젝트를 열 수 없습니다. 바뀐 내용은 없습니다.",
      );
      setLoading(false);
      return;
    }
    try {
      const [p, cs, ag, timelineResult] = await Promise.all([
        api.projects.get(id),
        api.chats.listByProject(id),
        api.team.list(),
        api.projects.timeline(id).catch(() => null),
      ]);
      if (!p) {
        navigate("/", "replace");
        return;
      }
      setProject(p);
      setNoteDraft(p.contextNote ?? "");
      setChats(cs);
      setAgents(visibleAgents(ag));
      setTimeline(timelineResult);
      if (!timelineResult) {
        setPageMessage(
          locale === "en"
            ? "The project opened, but its work timeline could not be read."
            : "프로젝트는 열었지만 작업 타임라인을 읽지 못했습니다.",
        );
      }
    } catch (error) {
      setPageMessage(
        locale === "en"
          ? `Project could not be loaded. Nothing changed. ${String(error)}`
          : `프로젝트를 불러오지 못했습니다. 바뀐 내용은 없습니다. ${String(error)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [id, locale]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startNewChat() {
    const api = ipc();
    if (!api || !project) return;
    const agentId =
      project.defaultAgentId
      ?? agents.find((agent) => agent.slug === "agentlas-orchestrator")?.id
      ?? agents[0]?.id;
    if (!agentId) {
      navigate("/marketplace");
      return;
    }
    try {
      const chat = await api.chats.create({ agentId, projectId: project.id });
      navigate(`/chat?id=${encodeURIComponent(chat.id)}`);
    } catch (error) {
      setPageMessage(
        locale === "en"
          ? `New chat was not created. ${String(error)}`
          : `새 채팅을 만들지 못했습니다. ${String(error)}`,
      );
    }
  }

  async function saveNote() {
    const api = ipc();
    if (!api || !project) return;
    try {
      const updated = await api.projects.update(project.id, {
        contextNote: noteDraft.trim() || null,
      });
      setProject(updated);
      setEditingNote(false);
      setPageMessage("");
    } catch (error) {
      setPageMessage(
        locale === "en"
          ? `Note was not saved. ${String(error)}`
          : `노트를 저장하지 못했습니다. ${String(error)}`,
      );
    }
  }

  async function removeProject() {
    const api = ipc();
    if (!api || !project) return;
    if (!confirm(t("project.confirm_delete", { name: project.name }))) return;
    try {
      await api.projects.remove(project.id);
      navigate("/", "replace");
    } catch (error) {
      setPageMessage(
        locale === "en"
          ? `Project was not deleted. ${String(error)}`
          : `프로젝트를 삭제하지 못했습니다. ${String(error)}`,
      );
    }
  }

  if (loading || !project) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <section style={{ maxWidth: 720, margin: "24px auto", padding: "0 24px" }}>
          <div style={pageNotice}>
            {loading
              ? locale === "en" ? "Loading project…" : "프로젝트를 불러오는 중입니다…"
              : pageMessage || (locale === "en" ? "Project could not be opened." : "프로젝트를 열 수 없습니다.")}
          </div>
        </section>
      </div>
    );
  }

  const agentById = new Map(visibleAgents(agents).map((agent) => [agent.id, agent]));

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={eyebrowStyle}>{t("project.kind")}</div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700 }}>
            {project.name}
          </h1>
        </div>
        <button
          onClick={() => void startNewChat()}
          className="titlebar-nodrag"
          style={raisedButton}
        >
          <IconPlus size={14} />
          {t("project.new_chat")}
        </button>
        <button
          onClick={() => void removeProject()}
          className="titlebar-nodrag"
          aria-label={t("common.delete")}
          title={t("common.delete")}
          style={{ color: "var(--muted-deep)", padding: 6 }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      {pageMessage && (
        <section style={{ maxWidth: 1280, margin: "16px auto 0", padding: "0 24px" }}>
          <div style={pageNotice}>{pageMessage}</div>
        </section>
      )}

      <section
        className="titlebar-nodrag project-detail-grid"
        style={{ maxWidth: 1280, margin: "24px auto", padding: "0 24px" }}
      >
        <main style={{ minWidth: 0 }}>
          <div style={{ ...cardStyle, marginBottom: 24 }}>
            <div style={{ ...eyebrowStyle, marginBottom: 8 }}>{t("project.section.note")}</div>
            {editingNote ? (
              <>
                <textarea
                  value={noteDraft}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  rows={4}
                  style={{
                    width: "100%",
                    padding: "10px 12px",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    fontFamily: "var(--font-body)",
                    fontSize: 13,
                    background: "var(--paper-2)",
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                  <button onClick={() => void saveNote()} style={raisedButton}>
                    {t("common.save")}
                  </button>
                  <button
                    onClick={() => {
                      setNoteDraft(project.contextNote ?? "");
                      setEditingNote(false);
                    }}
                    style={{ fontSize: 12, color: "var(--muted-deep)" }}
                  >
                    {t("common.cancel")}
                  </button>
                </div>
              </>
            ) : project.contextNote ? (
              <div
                onDoubleClick={() => setEditingNote(true)}
                style={{
                  whiteSpace: "pre-wrap",
                  fontSize: 13,
                  lineHeight: 1.6,
                  color: "var(--ink-soft)",
                  cursor: "text",
                }}
                title={locale === "en" ? "Double-click to edit" : "더블클릭으로 편집"}
              >
                {project.contextNote}
              </div>
            ) : (
              <button
                onClick={() => setEditingNote(true)}
                style={{ fontSize: 12, color: "var(--accent)", fontWeight: 600 }}
              >
                {t("project.add_note")}
              </button>
            )}
          </div>

          <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px" }}>
            {t("project.section.chats")} ({chats.length})
          </h2>
          {chats.length === 0 ? (
            <div style={emptyStyle}>{t("project.empty_chats")}</div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
              {chats.map((chat) => {
                const agent = agentById.get(chat.agentId);
                return (
                  <li key={chat.id}>
                    <Link
                      href={`/chat?id=${encodeURIComponent(chat.id)}`}
                      style={chatLinkStyle}
                    >
                      <span style={chatTitleStyle}>
                        {chat.title.trim() || t("chat.untitled")}
                      </span>
                      {agent && (
                        <span style={{ fontSize: 11, color: "var(--muted-deep)", flexShrink: 0 }}>
                          {pickLocalized(agent, locale).name}
                        </span>
                      )}
                      <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0 }}>
                        {new Date(chat.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
                          month: "numeric",
                          day: "numeric",
                          hour: "numeric",
                          minute: "numeric",
                        })}
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        <aside className="project-timeline-aside" style={{ minWidth: 0 }}>
          <ProjectTimelinePanel timeline={timeline} locale={locale} />
        </aside>
      </section>

      <style jsx global>{`
        .project-detail-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(300px, 370px);
          gap: 24px;
          align-items: start;
        }
        .project-timeline-aside {
          position: sticky;
          top: 20px;
          max-height: calc(100vh - 44px);
        }
        .project-memory-tree-panel {
          max-height: inherit;
          overflow-y: auto;
          padding: 2px 2px 18px;
        }
        .project-memory-tree {
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .project-memory-tree-group {
          position: relative;
          padding: 0 0 22px 20px;
        }
        .project-memory-tree-group:last-child {
          padding-bottom: 0;
        }
        .project-memory-tree-group::before {
          content: "";
          position: absolute;
          left: 0;
          top: 5px;
          width: 8px;
          height: 8px;
          border-radius: 999px;
          background: var(--accent);
        }
        .project-memory-tree-group::after {
          content: "";
          position: absolute;
          left: 3px;
          top: 15px;
          bottom: -2px;
          width: 1px;
          background: var(--paper-edge);
        }
        .project-memory-tree-group:last-child::after {
          display: none;
        }
        .project-memory-tree-date {
          display: block;
          color: var(--muted-deep);
          font: 650 11px/1.45 var(--font-mono);
          letter-spacing: -0.1px;
        }
        .project-memory-tree-entries {
          display: grid;
          gap: 6px;
          margin: 7px 0 0;
          padding: 0;
          list-style: none;
        }
        .project-memory-tree-entry {
          position: relative;
          min-width: 0;
          padding-left: 13px;
        }
        .project-memory-tree-entry::before {
          content: "–";
          position: absolute;
          left: 0;
          top: 1px;
          color: var(--muted);
          font-size: 12px;
        }
        .project-memory-tree-link,
        .project-memory-tree-static {
          display: block;
          min-width: 0;
          color: var(--ink);
          font-size: 12.5px;
          line-height: 1.5;
          text-decoration: none;
          overflow-wrap: anywhere;
        }
        .project-memory-tree-link:hover {
          color: var(--accent);
          text-decoration: underline;
          text-underline-offset: 3px;
        }
        .project-memory-tree-link:focus-visible {
          border-radius: 4px;
          outline: 2px solid var(--accent);
          outline-offset: 3px;
        }
        .project-memory-tree-static {
          color: var(--ink-soft);
        }
        .project-memory-tree-status {
          margin-left: 6px;
          color: var(--muted-deep);
          font-size: 10.5px;
          white-space: nowrap;
        }
        @media (max-width: 940px) {
          .project-detail-grid {
            grid-template-columns: minmax(0, 1fr);
          }
          .project-timeline-aside {
            position: static;
            max-height: none;
            grid-row: 1;
          }
        }
      `}</style>
    </div>
  );
}

function ProjectTimelinePanel({
  timeline,
  locale,
}: {
  timeline: ProjectTimelineSnapshot | null;
  locale: string;
}) {
  const groups = useMemo(
    () => groupTimelineEntries(timeline?.entries ?? [], locale),
    [locale, timeline?.entries],
  );

  return (
    <section
      className="project-memory-tree-panel"
      aria-label={locale === "en" ? "Project work timeline" : "프로젝트 작업 타임라인"}
    >
      {!timeline ? (
        <p style={timelineEmptyStyle}>
          {locale === "en" ? "Timeline unavailable." : "타임라인을 불러올 수 없습니다."}
        </p>
      ) : groups.length === 0 ? (
        <p style={timelineEmptyStyle}>
          {locale === "en" ? "No work recorded yet." : "아직 기록된 작업이 없습니다."}
        </p>
      ) : (
        <ol className="project-memory-tree">
          {groups.map((group) => (
            <li key={group.key} className="project-memory-tree-group">
              <time className="project-memory-tree-date">{group.label}</time>
              <ul className="project-memory-tree-entries">
                {group.entries.map((entry) => (
                  <TimelineRow key={entry.id} entry={entry} locale={locale} />
                ))}
              </ul>
            </li>
          ))}
        </ol>
      )}
      {timeline?.truncated && (
        <p style={{ margin: "14px 0 0 20px", fontSize: 10.5, color: "var(--muted-deep)" }}>
          {locale === "en"
            ? "Showing the latest 80 records."
            : "최근 기록 80개만 표시합니다."}
        </p>
      )}
    </section>
  );
}

function TimelineRow({ entry, locale }: { entry: ProjectTimelineEntry; locale: string }) {
  const href = timelineEntryHref(entry);
  const status = timelineVisibleStatus(entry, locale);
  const ariaStatus = timelineNavigationLabel(entry, locale);
  const content = (
    <>
      {entry.summary}
      {status && <span className="project-memory-tree-status">({status})</span>}
    </>
  );

  return (
    <li className="project-memory-tree-entry">
      {href ? (
        <Link
          href={href}
          className="project-memory-tree-link"
          aria-label={`${entry.summary}. ${ariaStatus}`}
        >
          {content}
        </Link>
      ) : (
        <span
          className="project-memory-tree-static"
          aria-label={`${entry.summary}. ${ariaStatus}`}
        >
          {content}
        </span>
      )}
    </li>
  );
}

function timelineEntryHref(entry: ProjectTimelineEntry): string | null {
  if (!entry.chatId) return null;
  if (entry.navigationStatus !== "exact" && entry.navigationStatus !== "chat_only") return null;
  const params = new URLSearchParams({ id: entry.chatId, from: "project-timeline" });
  if (entry.navigationStatus === "exact" && entry.messageId) {
    params.set("focus", entry.messageId);
  }
  return `/chat?${params.toString()}`;
}

function timelineNavigationLabel(entry: ProjectTimelineEntry, locale: string): string {
  const archived = entry.archived
    ? locale === "en" ? "Archived session" : "보관된 세션"
    : "";
  const base = entry.navigationStatus === "exact"
    ? locale === "en" ? "Open original message" : "원문 메시지로 이동"
    : entry.navigationStatus === "chat_only"
      ? locale === "en" ? "Original message deleted · open session" : "원문 삭제됨 · 세션 열기"
      : entry.navigationStatus === "chat_deleted"
        ? locale === "en" ? "Session deleted · work record preserved" : "세션 삭제됨 · 작업 기록만 보존"
        : locale === "en" ? "Work record preserved without a session" : "세션 연결 없이 작업 기록만 보존";
  return archived ? `${base} · ${archived}` : base;
}

function timelineVisibleStatus(entry: ProjectTimelineEntry, locale: string): string {
  if (entry.navigationStatus === "chat_only") {
    return locale === "en" ? "original deleted" : "원문 삭제됨";
  }
  if (entry.navigationStatus === "chat_deleted") {
    return locale === "en" ? "session deleted" : "세션 삭제됨";
  }
  if (entry.navigationStatus === "unlinked") {
    return locale === "en" ? "record only" : "기록만 보존";
  }
  return entry.archived ? locale === "en" ? "archived" : "보관됨" : "";
}

function groupTimelineEntries(entries: ProjectTimelineEntry[], locale: string) {
  const groups = new Map<string, { key: string; label: string; entries: ProjectTimelineEntry[] }>();
  for (const entry of entries) {
    const date = new Date(entry.occurredAt);
    const valid = !Number.isNaN(date.getTime());
    const key = valid
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      : "unknown";
    const label = valid
      ? locale === "en"
        ? new Intl.DateTimeFormat("en-US", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date)
        : `${String(date.getFullYear()).slice(-2)}년 ${String(date.getMonth() + 1).padStart(2, "0")}월 ${String(date.getDate()).padStart(2, "0")}일`
      : locale === "en" ? "Unknown date" : "날짜 미상";
    const group = groups.get(key) ?? { key, label, entries: [] };
    group.entries.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()];
}

const eyebrowStyle: React.CSSProperties = {
  fontSize: 10,
  color: "var(--muted-deep)",
  textTransform: "uppercase",
  letterSpacing: 0.6,
  fontFamily: "var(--font-mono)",
};

const cardStyle: React.CSSProperties = {
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-lg)",
  padding: 16,
};

const raisedButton: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 14px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink)",
  fontWeight: 600,
  fontSize: 12,
  border: "1px solid var(--paper-edge)",
  boxShadow: "var(--neu-raised)",
};

const pageNotice: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

const emptyStyle: React.CSSProperties = {
  padding: 24,
  border: "1px dashed var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  color: "var(--muted-deep)",
  textAlign: "center",
};

const timelineEmptyStyle: React.CSSProperties = {
  margin: 0,
  padding: "4px 0",
  color: "var(--muted-deep)",
  fontSize: 12,
  lineHeight: 1.55,
};

const chatLinkStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 14px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  textDecoration: "none",
  color: "var(--ink)",
};

const chatTitleStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontWeight: 500,
  fontSize: 13,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
