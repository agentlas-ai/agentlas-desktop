// 대시보드 작업 활동 — canonical ProjectTask만 표시한다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { CanonicalTask } from "@/lib/types";

const POLL_MS = 8000;
const PAGE_SIZE = 5;

function relTime(iso: string, ko: boolean): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const m = Math.round(diff / 60000);
  if (m < 1) return ko ? "방금" : "now";
  if (m < 60) return `${m}${ko ? "분 전" : "m"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}${ko ? "시간 전" : "h"}`;
  return `${Math.round(h / 24)}${ko ? "일 전" : "d"}`;
}

export function DashboardActivity() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [recent, setRecent] = useState<CanonicalTask[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");

  const loadActive = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const ids = await api.invoke.activeChats();
      setActive(new Set(ids));
    } catch {
      // ignore
    }
  }, []);

  // 최근 대화는 마운트 1회가 아니라 폴링마다 다시 읽는다 — 새 채팅/이름변경/완료가
  // 대시보드를 다시 열지 않아도 반영되도록(첫 메시지 후에야 목록에 뜨는 fix와 짝).
  const loadRecent = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoaded(true);
      return;
    }
    try {
      const rows = await api.tasks.list({ limit: 25 });
      setRecent(rows.filter((task) => Boolean(task.projectId && task.originChatId)));
      setError("");
    } catch {
      // 폴링 중 일시 오류는 기존 목록을 비우지 않는다(깜빡임 방지).
      setError(ko ? "최근 대화를 불러오지 못했습니다. 데이터는 바뀌지 않았습니다." : "Recent chats could not be loaded. Nothing changed.");
    } finally {
      setLoaded(true);
    }
  }, [ko]);

  // 초기 1회 load는 유지, 주기 폴링(8s)은 탭 보일 때만 — useVisibleInterval이 hidden 시 정지.
  useEffect(() => {
    void loadRecent();
    void loadActive();
  }, [loadActive, loadRecent]);
  useVisibleInterval(() => {
    void loadActive();
    void loadRecent();
  }, POLL_MS);

  const runningCount = recent.filter((task) => task.originChatId && active.has(task.originChatId)).length;
  const pageCount = Math.max(1, Math.ceil(recent.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const visibleRecent = recent.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE);

  return (
    <div className="dashboard-module dashboard-activity-module">
      <div className="dashboard-module-head">
        <span>{ko ? "최근 작업" : "Recent tasks"}</span>
        {runningCount > 0 && (
          <span className="dashboard-running-pill">
            <LiveDot />
            {ko ? `${runningCount}개 실행 중` : `${runningCount} running`}
          </span>
        )}
      </div>
      {!loaded ? (
        <div className="dashboard-module-empty">{ko ? "최근 작업을 불러오는 중…" : "Loading recent tasks…"}</div>
      ) : error ? (
        <div className="dashboard-module-empty">{error}</div>
      ) : recent.length === 0 ? (
        <div className="dashboard-module-empty">
          {ko ? "아직 프로젝트 작업이 없습니다." : "No project tasks yet."}
        </div>
      ) : (
        <>
          {visibleRecent.map((c) => {
            const running = Boolean(c.originChatId && active.has(c.originChatId));
            return (
              <button
                key={c.id}
                onClick={() => c.originChatId && navigate(`/workspace/task?id=${encodeURIComponent(c.originChatId)}&task=${encodeURIComponent(c.id)}&projectId=${encodeURIComponent(c.projectId ?? "")}`)}
                className="dashboard-activity-row"
              >
                {running ? <LiveDot /> : <span className="dashboard-muted-dot" />}
                <span>
                  {c.title || (ko ? "새 작업" : "New task")}
                </span>
                <span>
                  {running ? (ko ? "실행 중" : "running") : relTime(c.updatedAt, ko)}
                </span>
              </button>
            );
          })}
          {pageCount > 1 && (
            <div className="dashboard-activity-pager">
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={currentPage === 0}
                aria-label={ko ? "이전 최근 작업" : "Previous recent tasks"}
              >
                ‹
              </button>
              <span>{currentPage + 1} / {pageCount}</span>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                disabled={currentPage >= pageCount - 1}
                aria-label={ko ? "다음 최근 작업" : "Next recent tasks"}
              >
                ›
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function LiveDot() {
  return (
    <span className="dashboard-live-dot">
      <span />
    </span>
  );
}
