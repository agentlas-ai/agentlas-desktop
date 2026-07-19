// 프로젝트 상세 — 헤더(이름·컨텍스트 노트) + 채팅 목록 + 새 채팅 버튼.
"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type {
  Chat,
  InstalledAgent,
  OneProjectDeadlineLeadMinutes,
  OneProjectDeadlineState,
  Project,
} from "@/lib/types";
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
  const [deadlineState, setDeadlineState] = useState<OneProjectDeadlineState | null>(null);
  const [deadlineLocal, setDeadlineLocal] = useState("");
  const [deadlineTimezone] = useState(() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
  });
  const [deadlineLead, setDeadlineLead] = useState<OneProjectDeadlineLeadMinutes>(4320);
  const [deadlineRelativePath, setDeadlineRelativePath] = useState("");
  const [deadlineSaving, setDeadlineSaving] = useState(false);
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
      const [p, cs, ag, deadlines] = await Promise.all([
        api.projects.get(id),
        api.chats.listByProject(id),
        api.team.list(),
        api.oneProjectDeadlines.getState(id),
      ]);
      if (!p) {
        navigate("/", "replace");
        return;
      }
      setProject(p);
      setNoteDraft(p.contextNote ?? "");
      setChats(cs);
      setAgents(visibleAgents(ag));
      setDeadlineState(deadlines);
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

  async function connectDeadlineCheck() {
    const api = ipc();
    if (!api || !project || !deadlineState || deadlineSaving) return;
    if (!project.folderPath) {
      setPageMessage(locale === "en" ? "Connect a project folder before adding a deadline check." : "마감 확인을 추가하기 전에 프로젝트 폴더를 연결하세요.");
      return;
    }
    const parsed = new Date(deadlineLocal);
    if (!deadlineLocal || !Number.isFinite(parsed.getTime())) {
      setPageMessage(locale === "en" ? "Choose a valid deadline." : "유효한 마감 시각을 선택하세요.");
      return;
    }
    const roundTrip = [
      parsed.getFullYear(),
      String(parsed.getMonth() + 1).padStart(2, "0"),
      String(parsed.getDate()).padStart(2, "0"),
      String(parsed.getHours()).padStart(2, "0"),
      String(parsed.getMinutes()).padStart(2, "0"),
    ];
    const normalizedLocal = `${roundTrip[0]}-${roundTrip[1]}-${roundTrip[2]}T${roundTrip[3]}:${roundTrip[4]}`;
    if (normalizedLocal !== deadlineLocal.slice(0, 16)) {
      setPageMessage(locale === "en" ? "That local time does not exist in the current timezone because of a daylight-saving transition." : "현재 시간대의 일광절약시간 전환 때문에 존재하지 않는 시각입니다.");
      return;
    }
    if (!deadlineRelativePath.trim()) {
      setPageMessage(locale === "en" ? "Enter the expected file path relative to this project folder." : "프로젝트 폴더를 기준으로 예상 파일의 상대 경로를 입력하세요.");
      return;
    }
    setDeadlineSaving(true);
    setPageMessage("");
    try {
      const next = await api.oneProjectDeadlines.connect({
        expectedStoreVersion: deadlineState.storeVersion,
        projectId: project.id,
        deadlineAt: parsed.toISOString(),
        timezone: deadlineTimezone,
        leadTimeMinutes: deadlineLead,
        relativeDeliverablePath: deadlineRelativePath,
        confirmedReadOnly: true,
      });
      setDeadlineState(next);
      setDeadlineLocal("");
      setDeadlineRelativePath("");
    } catch (err) {
      setPageMessage(locale === "en" ? `Deadline check was not added. ${String(err)}` : `마감 확인을 추가하지 못했습니다. ${String(err)}`);
    } finally {
      setDeadlineSaving(false);
    }
  }

  async function removeDeadlineCheck(checkId: string, expectedCheckVersion: number) {
    const api = ipc();
    if (!api || !deadlineState || deadlineSaving) return;
    if (!confirm(locale === "en" ? "Remove this local read-only deadline check?" : "이 로컬 읽기 전용 마감 확인을 삭제할까요?")) return;
    setDeadlineSaving(true);
    setPageMessage("");
    try {
      const next = await api.oneProjectDeadlines.remove({
        expectedStoreVersion: deadlineState.storeVersion,
        checkId,
        expectedCheckVersion,
        confirmedByUser: true,
      });
      setDeadlineState(next);
    } catch (err) {
      setPageMessage(locale === "en" ? `Deadline check was not removed. ${String(err)}` : `마감 확인을 삭제하지 못했습니다. ${String(err)}`);
    } finally {
      setDeadlineSaving(false);
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

        {/* One read-only deadline checks. Raw expected paths are write-only to Main. */}
        <div
          style={{
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-lg)",
            padding: 16,
            marginBottom: 24,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: 0.6, textTransform: "uppercase", color: "var(--muted-deep)", marginBottom: 6 }}>
                {locale === "en" ? "One deadline checks" : "One 마감 확인"}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.5, color: "var(--ink-soft)" }}>
                {locale === "en"
                  ? "Add a deadline and one expected file condition. Desktop checks existence only; it does not read file contents, connect a calendar, or change anything."
                  : "마감과 예상 파일 조건 하나를 직접 추가하세요. Desktop은 존재 여부만 확인하며 파일 내용을 읽거나, 캘린더를 연결하거나, 외부 항목을 바꾸지 않습니다."}
              </div>
            </div>
            <span style={{ flexShrink: 0, border: "1px solid var(--paper-edge)", borderRadius: 999, padding: "5px 9px", fontSize: 11, color: "var(--muted-deep)" }}>
              {locale === "en" ? "Local · read-only" : "로컬 · 읽기 전용"}
            </span>
          </div>

          {!project.folderPath ? (
            <div style={{ ...pageNotice, padding: 12 }}>
              {locale === "en" ? "Connect a project folder first. No deadline monitoring is active." : "먼저 프로젝트 폴더를 연결하세요. 현재 활성화된 마감 확인은 없습니다."}
            </div>
          ) : (
            <>
              {(deadlineState?.checks ?? []).length > 0 && (
                <ul style={{ listStyle: "none", padding: 0, margin: "0 0 14px", display: "grid", gap: 8 }}>
                  {(deadlineState?.checks ?? []).map((check) => (
                    <li key={check.checkId} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 52, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper-2)" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 650, color: "var(--ink)" }}>
                          {new Date(check.deadlineAt).toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
                            timeZone: check.timezone,
                            dateStyle: "medium",
                            timeStyle: "short",
                          })}
                        </div>
                        <div style={{ marginTop: 3, fontSize: 11, color: "var(--muted-deep)" }}>
                          {check.timezone} · {locale === "en" ? "expected file condition configured; path stays in Desktop Main" : "예상 파일 조건 설정됨 · 경로는 Desktop Main에만 보관"}
                        </div>
                      </div>
                      <button
                        type="button"
                        disabled={deadlineSaving}
                        onClick={() => void removeDeadlineCheck(check.checkId, check.version)}
                        aria-label={locale === "en" ? "Remove deadline check" : "마감 확인 삭제"}
                        style={{ minWidth: 44, minHeight: 44, display: "grid", placeItems: "center", color: "var(--muted-deep)", opacity: deadlineSaving ? 0.5 : 1 }}
                      >
                        <IconTrash size={16} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr) minmax(150px, auto)", gap: 10, alignItems: "end" }}>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--muted-deep)" }}>
                  {locale === "en" ? "Deadline" : "마감"}
                  <input
                    type="datetime-local"
                    value={deadlineLocal}
                    onChange={(event) => setDeadlineLocal(event.target.value)}
                    style={{ minHeight: 44, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper-2)", color: "var(--ink)" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--muted-deep)" }}>
                  {locale === "en" ? "Expected file (relative path)" : "예상 파일(상대 경로)"}
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    value={deadlineRelativePath}
                    onChange={(event) => setDeadlineRelativePath(event.target.value)}
                    placeholder="deliverables/final.pdf"
                    style={{ minHeight: 44, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper-2)", color: "var(--ink)" }}
                  />
                </label>
                <label style={{ display: "grid", gap: 6, fontSize: 11, color: "var(--muted-deep)" }}>
                  {locale === "en" ? "Warn before" : "미리 알림"}
                  <select
                    value={deadlineLead}
                    onChange={(event) => setDeadlineLead(Number(event.target.value) as OneProjectDeadlineLeadMinutes)}
                    style={{ minHeight: 44, padding: "8px 10px", border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)", background: "var(--paper-2)", color: "var(--ink)" }}
                  >
                    <option value={60}>{locale === "en" ? "1 hour" : "1시간"}</option>
                    <option value={180}>{locale === "en" ? "3 hours" : "3시간"}</option>
                    <option value={1440}>{locale === "en" ? "1 day" : "1일"}</option>
                    <option value={4320}>{locale === "en" ? "3 days" : "3일"}</option>
                    <option value={10080}>{locale === "en" ? "7 days" : "7일"}</option>
                  </select>
                </label>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 10 }}>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                  {locale === "en" ? `Timezone: ${deadlineTimezone}` : `시간대: ${deadlineTimezone}`}
                </span>
                <button
                  type="button"
                  disabled={deadlineSaving || !deadlineState}
                  onClick={() => void connectDeadlineCheck()}
                  style={{ minHeight: 44, padding: "8px 14px", borderRadius: "var(--radius-md)", background: "var(--ink)", color: "var(--paper)", fontWeight: 650, fontSize: 12, opacity: deadlineSaving || !deadlineState ? 0.5 : 1 }}
                >
                  {deadlineSaving
                    ? locale === "en" ? "Saving…" : "저장 중…"
                    : locale === "en" ? "Add read-only check" : "읽기 전용 확인 추가"}
                </button>
              </div>
            </>
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
