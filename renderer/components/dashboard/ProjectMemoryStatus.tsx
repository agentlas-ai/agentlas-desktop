// 대시보드 "프로젝트 기억 상태" 모듈 (Phase 4+ 실활용 포착 + 안 되면 되게).
//   PM소울 ✓ / 코드맵 ✓ / 사이트맵 ✗(없음→생성) — 로드 실패를 조용한 경고가 아니라
//   여기에 노출하고, 없으면 생성 액션을 건다. "최근 주입됨" 표시는 content-free 마커 기반.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import type { Project } from "@/lib/types";
import type { ProjectMemoryStatus as Status } from "@shared/project-memory";

const POLL_MS = 30_000;

type Row = { project: Project; status: Status | null };

function SourceLine({
  label,
  present,
  recentlyInjected,
  reason,
  canGenerate,
  busy,
  ko,
  onGenerate,
}: {
  label: string;
  present: boolean;
  recentlyInjected: boolean;
  reason: string | null;
  canGenerate: boolean;
  busy: boolean;
  ko: boolean;
  onGenerate: (() => void) | null;
}) {
  const mark = present ? (recentlyInjected ? "✓" : "◐") : "✗";
  const tone = present ? (recentlyInjected ? "var(--ok, #2e7d32)" : "var(--warn, #b8860b)") : "var(--danger, #c0392b)";
  return (
    <div className="dashboard-module-row" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ color: tone, fontWeight: 600, width: 14, textAlign: "center" }}>{mark}</span>
      <span style={{ flex: 1 }}>
        {label}
        {present && !recentlyInjected && (
          <span style={{ opacity: 0.65, fontSize: 12 }}> · {ko ? "있으나 최근 미주입" : "present, not recently used"}</span>
        )}
        {!present && reason && <span style={{ opacity: 0.65, fontSize: 12 }}> · {reason}</span>}
      </span>
      {!present && canGenerate && onGenerate && (
        <button type="button" disabled={busy} onClick={onGenerate} className="titlebar-nodrag" data-dashboard-action="true">
          {ko ? "생성" : "Generate"}
        </button>
      )}
    </div>
  );
}

export function ProjectMemoryStatus() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setRows([]);
      return;
    }
    try {
      const projects = (await api.projects.list()).filter((p) => p.folderPath);
      const next = await Promise.all(
        projects.map(async (project) => ({ project, status: await api.projects.memoryStatus(project.id) })),
      );
      setRows(next);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRows((cur) => cur ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), POLL_MS);

  const generate = useCallback(
    async (projectId: string, source: "code_map" | "sitemap") => {
      const api = ipc();
      if (!api) return;
      setBusy(`${projectId}:${source}`);
      try {
        await api.projects.generateMemory(projectId, source);
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (rows && rows.length === 0) {
    return (
      <div id="project-memory-status" className="dashboard-module">
        <div className="dashboard-module-head">
          <span>{ko ? "프로젝트 기억 상태" : "Project memory status"}</span>
        </div>
        <div className="dashboard-module-empty">
          {ko ? "작업 폴더가 연결된 프로젝트가 없어요." : "No project has a working folder yet."}
        </div>
      </div>
    );
  }

  return (
    <div id="project-memory-status" className="dashboard-module">
      <div className="dashboard-module-head">
        <span>{ko ? "프로젝트 기억 상태" : "Project memory status"}</span>
      </div>
      {error && (
        <div className="dashboard-module-empty" style={{ color: "var(--danger, #c0392b)" }}>
          {error}
        </div>
      )}
      {rows === null ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : (
        rows.map(({ project, status }) => (
          <div key={project.id} className="dashboard-module-row" style={{ display: "grid", gap: 6 }}>
            <div style={{ fontWeight: 600 }}>{project.name}</div>
            {!status || !status.identityVerified ? (
              <div style={{ opacity: 0.65, fontSize: 12 }}>
                {ko ? "폴더 접근이 아직 인가되지 않아 상태를 읽을 수 없어요." : "Folder access is not authorized, so status is unavailable."}
              </div>
            ) : (
              <div style={{ display: "grid", gap: 2 }}>
                <SourceLine
                  label={ko ? "PM 소울" : "PM soul"}
                  {...status.pmSoul}
                  busy={false}
                  ko={ko}
                  onGenerate={null}
                />
                <SourceLine
                  label={ko ? "코드맵" : "Code map"}
                  {...status.codeMap}
                  busy={busy === `${project.id}:code_map`}
                  ko={ko}
                  onGenerate={status.codeMap.canGenerate ? () => void generate(project.id, "code_map") : null}
                />
                <SourceLine
                  label={ko ? "사이트맵" : "Sitemap"}
                  {...status.sitemap}
                  busy={busy === `${project.id}:sitemap`}
                  ko={ko}
                  onGenerate={status.sitemap.canGenerate ? () => void generate(project.id, "sitemap") : null}
                />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}
