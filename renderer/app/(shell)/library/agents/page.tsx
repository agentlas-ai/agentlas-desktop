// 설치된 에이전트 라이브러리.
// 좌측: 컴팩트 리스트(런타임 라벨 배지, 선택). 폴더 드래그&드롭 또는 버튼으로 로컬 임포트.
//       클라우드 가져오기는 별도 버튼 → 팝업(ImportAgentsModal).
// 우측: 선택한 에이전트의 폴더 파일 목록 + 에디터(AgentFilesPanel). 로컬 임포트면 원본 폴더.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ipc, pathForDroppedFile } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import type { InstalledAgent, RuntimeStatus } from "@/lib/types";
import { AgentAvatar } from "@/components/AgentAvatar";
import { AgentFilesPanel } from "@/components/AgentFilesPanel";
import { ImportAgentsModal } from "@/components/ImportAgentsModal";
import {
  IconBuilding,
  IconFileUp,
  IconFolder,
  IconPlus,
  IconSparkles,
  IconTrash,
} from "@/components/Icon";

// 런타임 라벨 → 표시/색
const RUNTIME_META: Record<string, { label: string; bg: string; fg: string }> = {
  "claude-code": { label: "Claude", bg: "rgba(217,119,87,0.16)", fg: "#b8623c" },
  codex: { label: "Codex", bg: "rgba(120,160,120,0.18)", fg: "var(--green-deep)" },
  gemini: { label: "Gemini", bg: "rgba(96,139,224,0.16)", fg: "var(--blue-deep)" },
  cursor: { label: "Cursor", bg: "var(--paper-2)", fg: "var(--ink-soft)" },
  generic: { label: "Local", bg: "var(--paper-2)", fg: "var(--muted-deep)" },
};

export default function LibraryAgentsPage() {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [importOpen, setImportOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [panelWidth, setPanelWidth] = useState(420);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    // 에이전트는 즉시 표시 (빠른 SQLite). 런타임 감지는 느릴 수 있어 분리 — 배너가 먼저 깜빡이지 않게.
    const list = await api.team.list();
    setAgents(list);
    const visible = visibleAgents(list);
    setSelectedId((cur) => (cur && visible.some((agent) => agent.id === cur) ? cur : visible[0]?.id ?? null));
    void api.runtime
      .detect()
      .then((rs) => setRuntimes(rs))
      .catch(() => {})
      .finally(() => setRuntimeChecked(true));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 패널 폭 — localStorage에 기억
  useEffect(() => {
    try {
      const saved = Number(window.localStorage.getItem("agentlas.agentPanelWidth"));
      if (saved >= 280 && saved <= 760) setPanelWidth(saved);
    } catch {
      /* ignore */
    }
  }, []);
  const onPanelResize = useCallback((w: number) => {
    const clamped = Math.max(280, Math.min(760, w));
    setPanelWidth(clamped);
    try {
      window.localStorage.setItem("agentlas.agentPanelWidth", String(clamped));
    } catch {
      /* ignore */
    }
  }, []);

  async function uninstall(id: string, name: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("library.agents.confirm_uninstall", { name }))) return;
    await api.team.uninstall(id);
    if (selectedId === id) setSelectedId(null);
    await refresh();
  }

  async function importPaths(paths: string[]) {
    const api = ipc();
    if (!api || paths.length === 0) return;
    setImporting(true);
    try {
      let last: InstalledAgent | null = null;
      for (const p of paths) {
        try {
          last = await api.team.importLocalFolder(p);
        } catch {
          // skip bad folder
        }
      }
      await refresh();
      if (last) setSelectedId(last.id);
    } finally {
      setImporting(false);
    }
  }

  async function pickLocalFolder() {
    const api = ipc();
    if (!api) return;
    const dir = await api.fs.pickDirectory();
    if (dir) await importPaths([dir]);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files ?? []);
    const paths = files.map((f) => pathForDroppedFile(f)).filter((p): p is string => !!p);
    void importPaths(paths);
  }

  // 런타임 감지가 끝났고(runtimeChecked) 0개일 때만 배너 — 초기 깜빡임 방지.
  const showNoRuntime = runtimeChecked && runtimes.length === 0;
  const displayAgents = visibleAgents(agents);
  const selectedAgent = displayAgents.find((a) => a.id === selectedId) ?? null;

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div
        style={{ flex: 1, minWidth: 0, overflowY: "auto", position: "relative" }}
        onDragEnter={(e) => {
          e.preventDefault();
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={onDrop}
      >
        <section style={{ padding: "24px 32px" }}>
          {/* 헤더 + 액션 */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 8, flexWrap: "wrap" }}>
            <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13, flex: "1 1 200px", minWidth: 0 }}>
              {t("library.agents.subtitle")}
            </p>
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <button onClick={pickLocalFolder} disabled={importing} style={ghostBtn} title={t("library.agents.import_local_hint")}>
                <IconFolder size={13} />
                {importing ? t("import.importing") : t("library.agents.import_local")}
              </button>
              <button onClick={() => setImportOpen(true)} style={ghostBtn}>
                <IconSparkles size={13} />
                {t("library.agents.import_cloud")}
              </button>
              <Link href="/marketplace" style={{ ...ghostBtn, background: "var(--paper)", color: "var(--ink)", border: "1px solid var(--paper-edge)", boxShadow: "var(--neu-raised)", textDecoration: "none" }}>
                <IconPlus size={13} />
                {t("library.agents.add")}
              </Link>
            </div>
          </div>

          {showNoRuntime && (
            <div
              style={{
                marginBottom: 12,
                padding: "9px 12px",
                borderRadius: "var(--radius-md)",
                background: "rgba(240,171,140,0.16)",
                color: "var(--peach-ink)",
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ flex: 1 }}>{t("library.agents.no_runtime")}</span>
              <Link href="/settings" style={{ color: "var(--accent)", fontWeight: 700 }}>
                {t("sidebar.settings")} →
              </Link>
            </div>
          )}

          {/* 드래그 힌트 / 빈 상태 */}
          {displayAgents.length === 0 ? (
            <div
              style={{
                padding: 40,
                textAlign: "center",
                color: "var(--muted-deep)",
                border: `1.5px dashed ${dragOver ? "var(--accent)" : "var(--paper-edge)"}`,
                borderRadius: "var(--radius-md)",
                background: dragOver ? "var(--fill-1)" : "transparent",
                fontSize: 13,
                lineHeight: 1.7,
              }}
            >
              <IconFileUp size={22} style={{ color: "var(--muted-deep)", marginBottom: 6 }} />
              <div>{t("library.agents.empty")}</div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>
                {t("library.agents.drop_hint")}
              </div>
              <Link href="/apps" style={{ color: "var(--accent)", fontWeight: 600 }}>
                {t("sidebar.marketplace")} →
              </Link>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
              {displayAgents.map((a) => {
                const loc = pickLocalized(a, locale);
                const active = a.id === selectedId;
                const rt = a.runtimeLabel ? RUNTIME_META[a.runtimeLabel] : null;
                return (
                  <li key={a.id}>
                    <div
                      onClick={() => {
                        setSelectedId(a.id);
                        setPanelOpen(true);
                      }}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        padding: "8px 12px",
                        borderRadius: "var(--radius-md)",
                        background: active ? "var(--fill-1)" : "var(--paper)",
                        border: active ? "1px solid var(--accent)" : "1px solid var(--paper-edge)",
                        cursor: "pointer",
                      }}
                    >
                      <AgentAvatar name={loc.name} tone={a.tone} size={26} />
                      <div style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                          <span
                            style={{
                              fontFamily: "var(--font-head)",
                              fontSize: 13,
                              fontWeight: 600,
                              whiteSpace: "nowrap",
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                            }}
                          >
                            {loc.name}
                          </span>
                          {a.kind === "team" && (
                            <span style={{ ...miniBadge, background: "var(--fill-1)", color: "var(--accent)" }}>
                              <IconBuilding size={9} /> Team
                            </span>
                          )}
                          {rt && (
                            <span style={{ ...miniBadge, background: rt.bg, color: rt.fg }}>{rt.label}</span>
                          )}
                        </div>
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--muted-deep)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {loc.tagline}
                        </span>
                      </div>
                      <span style={{ fontSize: 10, color: "var(--muted)", flexShrink: 0 }}>
                        {a.localPath ? t("library.agents.local") : `Trust ${a.trustGrade}`}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          void uninstall(a.id, loc.name);
                        }}
                        aria-label={t("common.delete")}
                        title={t("common.delete")}
                        style={{ color: "var(--muted-deep)", padding: 4, background: "transparent", border: "none", cursor: "pointer", flexShrink: 0 }}
                      >
                        <IconTrash size={13} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 드래그 오버레이 */}
        {dragOver && displayAgents.length > 0 && (
          <div
            style={{
              position: "absolute",
              inset: 12,
              border: "2px dashed var(--accent)",
              borderRadius: "var(--radius-lg)",
              background: "rgba(168,217,155,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexDirection: "column",
              gap: 8,
              color: "var(--accent)",
              fontWeight: 700,
              fontSize: 14,
              pointerEvents: "none",
            }}
          >
            <IconFileUp size={28} />
            {t("library.agents.drop_now")}
          </div>
        )}
      </div>

      {panelOpen && (
        <AgentFilesPanel
          agentId={selectedId}
          agentName={selectedAgent ? pickLocalized(selectedAgent, locale).name : ""}
          width={panelWidth}
          onWidthChange={onPanelResize}
          onClose={() => setPanelOpen(false)}
        />
      )}

      <ImportAgentsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void refresh()}
      />
    </div>
  );
}

const ghostBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "7px 12px",
  fontSize: 12,
  fontWeight: 600,
  color: "var(--ink-soft)",
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  cursor: "pointer",
};

const miniBadge: React.CSSProperties = {
  fontSize: 9.5,
  padding: "1px 6px",
  borderRadius: 999,
  fontWeight: 700,
  display: "inline-flex",
  alignItems: "center",
  gap: 3,
  flexShrink: 0,
};
