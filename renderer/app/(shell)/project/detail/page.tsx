// 프로젝트 상세 — 헤더(이름·컨텍스트 노트) + 채팅 목록 + 새 채팅 버튼.
"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { Chat, InstalledAgent, OntologyProjectStatus, OntologySourceKind, OntologySourceScope, Project } from "@/lib/types";
import { IconFileUp, IconFolder, IconPlus, IconShield, IconTrash } from "@/components/Icon";

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
  const [ontology, setOntology] = useState<OntologyProjectStatus | null>(null);
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [sourceScope, setSourceScope] = useState<OntologySourceScope>("private");
  const [sourceKind, setSourceKind] = useState<OntologySourceKind>("company");
  const [ontologyBusy, setOntologyBusy] = useState(false);
  const [ontologyMessage, setOntologyMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [pageMessage, setPageMessage] = useState("");

  const refresh = useCallback(async () => {
    const api = ipc();
    setLoading(true);
    setPageMessage("");
    if (!api || !id) {
      setPageMessage(locale === "en" ? "Project could not be opened. Nothing changed." : "프로젝트를 열 수 없습니다. 바뀐 내용은 없습니다.");
      setLoading(false);
      return;
    }
    try {
      const [p, cs, ag, ont] = await Promise.all([
        api.projects.get(id),
        api.chats.listByProject(id),
        api.team.list(),
        api.ontology.getProject(id),
      ]);
      if (!p) {
        navigate("/", "replace");
        return;
      }
      setProject(p);
      setNoteDraft(p.contextNote ?? "");
      setChats(cs);
      setAgents(visibleAgents(ag));
      setOntology(ont);
    } catch (err) {
      setPageMessage(locale === "en" ? `Project could not be loaded. Nothing changed. ${String(err)}` : `프로젝트를 불러오지 못했습니다. 바뀐 내용은 없습니다. ${String(err)}`);
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
      project.defaultAgentId ??
      agents.find((agent) => agent.slug === "agentlas-orchestrator")?.id ??
      agents[0]?.id;
    if (!agentId) {
      navigate("/marketplace");
      return;
    }
    try {
      const chat = await api.chats.create({ agentId, projectId: project.id });
      navigate(`/chat?id=${chat.id}`);
    } catch (err) {
      setPageMessage(locale === "en" ? `New chat was not created. ${String(err)}` : `새 채팅을 만들지 못했습니다. ${String(err)}`);
    }
  }

  async function saveNote() {
    const api = ipc();
    if (!api || !project) return;
    try {
      const updated = await api.projects.update(project.id, { contextNote: noteDraft.trim() || null });
      setProject(updated);
      setEditingNote(false);
      setPageMessage("");
    } catch (err) {
      setPageMessage(locale === "en" ? `Note was not saved. ${String(err)}` : `노트를 저장하지 못했습니다. ${String(err)}`);
    }
  }

  async function removeProject() {
    const api = ipc();
    if (!api || !project) return;
    if (!confirm(t("project.confirm_delete", { name: project.name }))) return;
    try {
      await api.projects.remove(project.id);
      navigate("/", "replace");
    } catch (err) {
      setPageMessage(locale === "en" ? `Project was not deleted. ${String(err)}` : `프로젝트를 삭제하지 못했습니다. ${String(err)}`);
    }
  }

  async function chooseProjectFolder() {
    const api = ipc();
    if (!api || !project) return;
    const picked = await api.workspace.selectFolder();
    if (!picked) return;
    const updated = await api.projects.update(project.id, { folderPath: picked });
    setProject(updated);
    await refresh();
  }

  async function openOntologyInbox() {
    const api = ipc();
    if (!api || !project) return;
    setOntologyMessage("");
    const result = await api.ontology.openInbox(project.id);
    if (!result.ok) setOntologyMessage(result.message);
  }

  async function chooseSourceFolder() {
    const api = ipc();
    if (!api) return;
    const picked = await api.workspace.selectFolder();
    if (picked) setSourcePath(picked);
  }

  async function addOntologySource() {
    const api = ipc();
    if (!api || !project || !sourcePath.trim()) return;
    setOntologyBusy(true);
    setOntologyMessage("");
    try {
      const next = await api.ontology.addSource(project.id, sourcePath.trim(), sourceScope, sourceKind);
      setOntology(next);
      setSourcePath("");
    } catch (err) {
      setOntologyMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setOntologyBusy(false);
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
  const agentById = new Map(visibleAgents(agents).map((a) => [a.id, a]));

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

      {pageMessage && (
        <section style={{ maxWidth: 960, margin: "16px auto 0", padding: "0 24px" }}>
          <div style={pageNotice}>{pageMessage}</div>
        </section>
      )}

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

        {/* 프로젝트 온톨로지 */}
        <div
          style={{
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-lg)",
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div
              style={{
                width: 28,
                height: 28,
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--paper-edge)",
                display: "grid",
                placeItems: "center",
                color: "var(--accent)",
              }}
            >
              <IconShield size={15} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: 0.6, textTransform: "uppercase", color: "var(--muted-deep)" }}>
                Ontology
              </div>
              <div style={{ fontSize: 13, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {ontology?.state === "active"
                  ? locale === "en"
                    ? "Project-local vault is active"
                    : "프로젝트 전용 저장소 활성"
                  : locale === "en"
                    ? "Choose a project folder to activate"
                    : "프로젝트 폴더를 고르면 활성화됩니다"}
              </div>
            </div>
            {ontology?.state === "active" ? (
              <button
                onClick={() => void openOntologyInbox()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--paper)",
                  color: "var(--ink)",
                  border: "1px solid var(--paper-edge)",
                  boxShadow: "var(--neu-raised)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <IconFolder size={14} />
                {locale === "en" ? "Open inbox" : "Inbox 열기"}
              </button>
            ) : (
              <button
                onClick={() => void chooseProjectFolder()}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "7px 12px",
                  borderRadius: "var(--radius-md)",
                  background: "var(--paper)",
                  color: "var(--ink)",
                  border: "1px solid var(--paper-edge)",
                  boxShadow: "var(--neu-raised)",
                  fontSize: 12,
                  fontWeight: 600,
                }}
              >
                <IconFolder size={14} />
                {locale === "en" ? "Choose folder" : "폴더 선택"}
              </button>
            )}
          </div>

          {ontology?.state === "active" ? (
            <>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                <OntologyFact label="Project" value={ontology.projectPath ?? ""} />
                <OntologyFact label="Inbox" value={ontology.inboxPath ?? ""} />
                <OntologyFact label="Database" value={ontology.dbPath ?? ""} />
                <OntologyFact label="Policy" value="inbox + registered only" />
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                <input
                  value={sourcePath}
                  onChange={(e) => setSourcePath(e.target.value)}
                  placeholder={locale === "en" ? "Folder/file path to register" : "등록할 폴더/파일 경로"}
                  style={{
                    flex: "1 1 260px",
                    minWidth: 0,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper-2)",
                    fontSize: 12,
                  }}
                />
                <button
                  onClick={() => void chooseSourceFolder()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 10px",
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--paper-edge)",
                    fontSize: 12,
                    color: "var(--ink-soft)",
                  }}
                >
                  <IconFolder size={13} />
                  {locale === "en" ? "Pick" : "선택"}
                </button>
                <select
                  value={sourceKind}
                  onChange={(e) => setSourceKind(e.target.value as OntologySourceKind)}
                  style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--paper-edge)", fontSize: 12, background: "var(--paper)" }}
                >
                  <option value="company">{locale === "en" ? "Company" : "회사"}</option>
                  <option value="personal">{locale === "en" ? "Personal" : "개인"}</option>
                  <option value="project">{locale === "en" ? "Project" : "프로젝트"}</option>
                </select>
                <select
                  value={sourceScope}
                  onChange={(e) => setSourceScope(e.target.value as OntologySourceScope)}
                  style={{ padding: "8px 10px", borderRadius: "var(--radius-md)", border: "1px solid var(--paper-edge)", fontSize: 12, background: "var(--paper)" }}
                >
                  <option value="private">{locale === "en" ? "Private" : "비공개"}</option>
                  <option value="internal">{locale === "en" ? "Internal" : "내부"}</option>
                  <option value="public">{locale === "en" ? "Public" : "공개"}</option>
                </select>
                <button
                  disabled={ontologyBusy || !sourcePath.trim()}
                  onClick={() => void addOntologySource()}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "8px 12px",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    color: sourcePath.trim() ? "var(--ink)" : "var(--muted)",
                    border: "1px solid var(--paper-edge)",
                    boxShadow: sourcePath.trim() ? "var(--neu-raised)" : "none",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  <IconPlus size={13} />
                  {ontologyBusy ? (locale === "en" ? "Adding" : "등록 중") : locale === "en" ? "Add" : "등록"}
                </button>
              </div>
              {ontologyMessage && (
                <div style={{ fontSize: 12, color: "var(--red-deep)", marginBottom: 10 }}>
                  {ontologyMessage}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12 }}>
                <OntologyList
                  title={locale === "en" ? "Inbox" : "Inbox 파일"}
                  empty={locale === "en" ? "Drop txt, md, json, or csv files here." : "txt, md, json, csv 파일을 여기에 넣습니다."}
                  items={ontology.inboxEntries.map((entry) => ({
                    key: entry.path,
                    title: entry.name,
                    meta: entry.supported ? (locale === "en" ? "supported" : "지원") : "adapter pending",
                  }))}
                />
                <OntologyList
                  title={locale === "en" ? "Registered sources" : "등록 소스"}
                  empty={locale === "en" ? "No external source registered." : "등록된 외부 소스가 없습니다."}
                  items={ontology.sources.map((source) => ({
                    key: source.path,
                    title: source.path,
                    meta: `${source.kind} · ${source.scope}${source.exists ? "" : " · missing"}`,
                  }))}
                />
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 12, fontSize: 11, color: "var(--muted-deep)" }}>
                <IconFileUp size={13} />
                {locale === "en"
                  ? "Home folders and sibling projects are never scanned automatically."
                  : "홈 폴더와 다른 프로젝트는 자동으로 훑지 않습니다."}
              </div>
            </>
          ) : null}
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
                      {new Date(c.updatedAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
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

const pageNotice: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

function OntologyFact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "var(--muted-deep)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {value}
      </div>
    </div>
  );
}

function OntologyList({
  title,
  empty,
  items,
}: {
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; meta: string }>;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", color: "var(--muted-deep)", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
        {title}
      </div>
      {items.length === 0 ? (
        <div style={{ border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", padding: 12, color: "var(--muted-deep)", fontSize: 12 }}>
          {empty}
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {items.map((item) => (
            <li
              key={item.key}
              style={{
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                padding: "8px 10px",
                background: "var(--paper-2)",
                minWidth: 0,
              }}
            >
              <div style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.title}
              </div>
              <div style={{ fontSize: 10, color: "var(--muted-deep)", marginTop: 3 }}>
                {item.meta}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
