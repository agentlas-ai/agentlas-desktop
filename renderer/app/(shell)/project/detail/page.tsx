// 프로젝트 상세 — 헤더(이름·컨텍스트 노트) + 채팅 목록 + 새 채팅 버튼.
"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { Chat, InstalledAgent, Project } from "@/lib/types";
import { IconPlus, IconTrash } from "@/components/Icon";

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
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !id) return;
    const [p, cs, ag] = await Promise.all([
      api.projects.get(id),
      api.chats.listByProject(id),
      api.team.list(),
    ]);
    if (!p) {
      navigate("/", "replace");
      return;
    }
    setProject(p);
    setNoteDraft(p.contextNote ?? "");
    setChats(cs);
    setAgents(ag);
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function startNewChat() {
    const api = ipc();
    if (!api || !project) return;
    const agentId =
      project.defaultAgentId ??
      agents.find((agent) => agent.slug === "agentlas-orchestrator")?.id ??
      agents[0]?.id;
    if (!agentId) {
      navigate("/marketplace");
      return;
    }
    const chat = await api.chats.create({ agentId, projectId: project.id });
    navigate(`/chat?id=${chat.id}`);
  }

  async function saveNote() {
    const api = ipc();
    if (!api || !project) return;
    const updated = await api.projects.update(project.id, { contextNote: noteDraft.trim() || null });
    setProject(updated);
    setEditingNote(false);
  }

  async function removeProject() {
    const api = ipc();
    if (!api || !project) return;
    if (!confirm(t("project.confirm_delete", { name: project.name }))) return;
    await api.projects.remove(project.id);
    navigate("/", "replace");
  }

  if (!project) return null;
  const agentById = new Map(agents.map((a) => [a.id, a]));

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
          <div style={{ fontSize: 10, color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.6, fontFamily: "var(--font-mono)" }}>
            {t("project.kind")}
          </div>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 18, fontWeight: 700 }}>
            {project.name}
          </h1>
        </div>
        <button
          onClick={() => void startNewChat()}
          className="titlebar-nodrag"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
          }}
        >
          <IconPlus size={14} />{t("project.new_chat")}
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

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 960, margin: "24px auto", padding: "0 24px" }}
      >
        {/* 컨텍스트 노트 */}
        <div
          style={{
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-lg)",
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: 0.6, textTransform: "uppercase", color: "var(--muted-deep)", marginBottom: 8 }}>
            {t("project.section.note")}
          </div>
          {editingNote ? (
            <>
              <textarea
                value={noteDraft}
                onChange={(e) => setNoteDraft(e.target.value)}
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
                <button
                  onClick={() => void saveNote()}
                  style={{
                    padding: "6px 14px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    color: "var(--ink)",
                    fontWeight: 600,
                    fontSize: 12,
                    border: "1px solid var(--paper-edge)",
                    boxShadow: "var(--neu-raised)",
                  }}
                >
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
              style={{ whiteSpace: "pre-wrap", fontSize: 13, lineHeight: 1.6, color: "var(--ink-soft)", cursor: "text" }}
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

        {/* 채팅 목록 */}
        <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "0 0 12px" }}>
          {t("project.section.chats")} ({chats.length})
        </h2>
        {chats.length === 0 ? (
          <div
            style={{
              padding: 24,
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
              color: "var(--muted-deep)",
              textAlign: "center",
            }}
          >
            {t("project.empty_chats")}
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {chats.map((c) => {
              const agent = agentById.get(c.agentId);
              return (
                <li key={c.id}>
                  <Link
                    href={`/chat?id=${c.id}`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 12,
                      padding: "10px 14px",
                      border: "1px solid var(--paper-edge)",
                      borderRadius: "var(--radius-md)",
                      background: "var(--paper)",
                      textDecoration: "none",
                      color: "var(--ink)",
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        fontWeight: 500,
                        fontSize: 13,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {c.title.trim() || t("chat.untitled")}
                    </span>
                    {agent && (
                      <span style={{ fontSize: 11, color: "var(--muted-deep)", flexShrink: 0 }}>
                        {pickLocalized(agent, locale).name}
                      </span>
                    )}
                    <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0 }}>
                      {new Date(c.updatedAt).toLocaleString("ko-KR", {
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
      </section>
    </div>
  );
}
