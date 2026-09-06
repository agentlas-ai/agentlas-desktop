// 라이브러리 > 에이전트 우측 패널 — 선택한 에이전트 폴더의 파일 목록 + 인라인 에디터.
// system-prompt.md를 편집하면 main이 DB에도 반영해 새 메시지에 즉시 적용된다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { DirListing, TextFilePreview, WorkspaceNode } from "@/lib/types";
import { IconCheck, IconClose, IconRefresh } from "@/components/Icon";

export function AgentFilesPanel({
  agentId,
  agentName,
  onClose,
  width = 420,
  onWidthChange,
}: {
  agentId: string | null;
  agentName: string;
  onClose: () => void;
  /** 패널 폭(px). 드래그 리사이즈 시 onWidthChange로 갱신 */
  width?: number;
  onWidthChange?: (w: number) => void;
}) {
  const { t } = useT();
  const [files, setFiles] = useState<WorkspaceNode[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [preview, setPreview] = useState<TextFilePreview | null>(null);
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceMissing, setSourceMissing] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadFiles = useCallback(async () => {
    const api = ipc();
    if (!api || !agentId) {
      setFiles([]);
      setSourceMissing(false);
      setLoadError(null);
      return;
    }
    setLoading(true);
    setSourceMissing(false);
    setLoadError(null);
    try {
      const listing: DirListing = await api.agentFiles.list(agentId);
      const fileEntries = listing.entries.filter((e) => e.kind === "file");
      setFiles(fileEntries);
      const missing = listing.exists === false && listing.reason === "source-missing";
      setSourceMissing(missing);
      // 기본으로 system-prompt.md 또는 첫 파일을 연다.
      const preferred =
        fileEntries.find((e) => e.name === "system-prompt.md") ?? fileEntries[0] ?? null;
      setActivePath(missing ? null : preferred?.path ?? null);
      if (missing) {
        setPreview(null);
        setDraft("");
        setDirty(false);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // 에이전트가 바뀌면 이전 에이전트의 활성 파일/내용을 즉시 비운다 (잘못된 경로 읽기 방지).
  useEffect(() => {
    setActivePath(null);
    setPreview(null);
    setDraft("");
    setDirty(false);
    setSourceMissing(false);
    setLoadError(null);
  }, [agentId]);

  useEffect(() => {
    void loadFiles();
  }, [loadFiles]);

  // 활성 파일 읽기
  useEffect(() => {
    const api = ipc();
    if (!api || !agentId || !activePath) {
      setPreview(null);
      setDraft("");
      setDirty(false);
      return;
    }
    let cancelled = false;
    void api.agentFiles.read(agentId, activePath).then((p) => {
      if (cancelled) return;
      setPreview(p);
      setDraft(p.content);
      setDirty(false);
    });
    return () => {
      cancelled = true;
    };
  }, [agentId, activePath]);

  async function save() {
    const api = ipc();
    if (!api || !agentId || !activePath) return;
    setSaving(true);
    try {
      await api.agentFiles.write(agentId, activePath, draft);
      setDirty(false);
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1400);
    } finally {
      setSaving(false);
    }
  }

  const editable = preview != null && !preview.reason;
  const activeName = activePath ? activePath.split("/").pop() : null;

  // 좌측 가장자리 드래그로 패널 폭 조정
  function startResize(e: React.MouseEvent) {
    if (!onWidthChange) return;
    e.preventDefault();
    const move = (ev: MouseEvent) => onWidthChange(window.innerWidth - ev.clientX);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  return (
    <aside
      className="glass-thin"
      style={{
        width,
        flexShrink: 0,
        borderLeft: "1px solid var(--glass-border)",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        height: "100%",
        position: "relative",
      }}
    >
      {onWidthChange && (
        <div
          onMouseDown={startResize}
          title=""
          style={{
            position: "absolute",
            left: -3,
            top: 0,
            bottom: 0,
            width: 6,
            cursor: "col-resize",
            zIndex: 5,
          }}
        />
      )}
      <header
        style={{
          padding: "14px 16px 10px",
          borderBottom: "1px solid var(--glass-border)",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: "var(--muted-deep)", fontWeight: 600 }}>
            {t("agentfiles.title")}
          </div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 700,
              fontFamily: "var(--font-head)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={agentName}
          >
            {agentName || "—"}
          </div>
        </div>
        <button
          onClick={() => void loadFiles()}
          aria-label={t("workspace.refresh")}
          title={t("workspace.refresh")}
          style={iconBtn}
        >
          <IconRefresh size={14} />
        </button>
        <button onClick={onClose} aria-label={t("workspace.close_panel")} title={t("workspace.close_panel")} style={iconBtn}>
          <IconClose size={15} />
        </button>
      </header>

      {!agentId ? (
        <Centered>{t("agentfiles.pick")}</Centered>
      ) : (
        <>
          {/* 파일 목록 (가로 칩) */}
          <div
            style={{
              display: "flex",
              gap: 6,
              padding: "10px 12px",
              flexWrap: "wrap",
              borderBottom: "1px solid var(--glass-border)",
            }}
          >
            {loading && files.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("import.loading")}</span>
            ) : sourceMissing ? (
              <span role="status" style={{ fontSize: 12, color: "var(--amber-deep, var(--warn))" }}>
                {t("agentfiles.source_missing")}
              </span>
            ) : loadError ? (
              <span role="alert" style={{ fontSize: 12, color: "var(--danger, var(--danger))" }}>
                {t("agentfiles.load_error")}: {loadError}
              </span>
            ) : files.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--muted)" }}>{t("workspace.empty.folder")}</span>
            ) : (
              files.map((f) => {
                const active = f.path === activePath;
                return (
                  <button
                    key={f.path}
                    onClick={() => setActivePath(f.path)}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      fontSize: 11.5,
                      fontFamily: "var(--font-mono)",
                      fontWeight: active ? 700 : 500,
                      background: active ? "var(--paper)" : "var(--paper-2)",
                      color: active ? "var(--ink)" : "var(--ink-soft)",
                      border: "1px solid var(--paper-edge)",
                      boxShadow: active ? "var(--neu-raised)" : "none",
                    }}
                  >
                    {f.name}
                  </button>
                );
              })
            )}
          </div>

          {/* 에디터 / 미리보기 */}
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", padding: 12, gap: 8 }}>
            {!activePath ? (
              <Centered>{t("agentfiles.pick_file")}</Centered>
            ) : !editable ? (
              <Centered>
                {preview?.reason === "too-large"
                  ? t("workspace.preview.too_large")
                  : t("workspace.preview.binary")}
              </Centered>
            ) : (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{ fontSize: 11.5, color: "var(--muted-deep)", flex: 1, fontFamily: "var(--font-mono)" }}>
                    {activeName}
                    {preview?.truncated ? ` · ${t("workspace.preview.truncated")}` : ""}
                  </code>
                  {savedTick && (
                    <span style={{ fontSize: 11, color: "var(--green-deep)", display: "inline-flex", alignItems: "center", gap: 3 }}>
                      <IconCheck size={11} /> {t("env.saved")}
                    </span>
                  )}
                  <button
                    onClick={() => void save()}
                    disabled={!dirty || saving || (preview?.truncated ?? false)}
                    style={{
                      padding: "5px 14px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 700,
                      border: "1px solid var(--paper-edge)",
                      boxShadow: dirty && !saving ? "var(--neu-raised)" : "none",
                      background: dirty && !saving ? "var(--paper)" : "var(--paper-2)",
                      color: dirty && !saving ? "var(--ink)" : "var(--muted-deep)",
                    }}
                  >
                    {saving ? t("agentfiles.saving") : t("common.save")}
                  </button>
                </div>
                {activeName === "system-prompt.md" && (
                  <div style={{ fontSize: 10.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
                    {t("agentfiles.prompt_hint")}
                  </div>
                )}
                <textarea
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDirty(true);
                  }}
                  spellCheck={false}
                  disabled={preview?.truncated ?? false}
                  style={{
                    flex: 1,
                    minHeight: 0,
                    resize: "none",
                    width: "100%",
                    padding: 12,
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-md)",
                    background: "var(--paper)",
                    fontFamily: "var(--font-mono)",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                    color: "var(--ink)",
                    outline: "none",
                  }}
                />
              </>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

const iconBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 6,
  borderRadius: 8,
  color: "var(--muted-deep)",
  background: "transparent",
  border: "1px solid var(--paper-edge)",
  cursor: "pointer",
};

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: 24,
        color: "var(--muted-deep)",
        fontSize: 12.5,
        lineHeight: 1.6,
      }}
    >
      {children}
    </div>
  );
}
