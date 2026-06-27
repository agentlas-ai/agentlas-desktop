// 대시보드 "활동" 모듈 — 지금 실행 중(activeChats) + 최근 채팅(chats.listRecent).
// 실행 중인 채팅엔 라이브 점등, 클릭하면 해당 채팅으로 이동.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type { Chat } from "@/lib/types";

const POLL_MS = 8000;

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
  const [recent, setRecent] = useState<Chat[]>([]);
  const [active, setActive] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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

  useEffect(() => {
    const api = ipc();
    if (!api) {
      setLoaded(true);
      return;
    }
    void api.chats.listRecent(8).then((c) => {
      setRecent(c);
      setLoaded(true);
    });
    void loadActive();
    timer.current = setInterval(() => void loadActive(), POLL_MS);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [loadActive]);

  const runningCount = recent.filter((c) => active.has(c.id)).length;

  return (
    <div className="dashboard-module dashboard-activity-module">
      <div className="dashboard-module-head">
        <span>{ko ? "활동" : "Activity"}</span>
        {runningCount > 0 && (
          <span className="dashboard-running-pill">
            <LiveDot />
            {ko ? `${runningCount}개 실행 중` : `${runningCount} running`}
          </span>
        )}
      </div>
      {!loaded ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : recent.length === 0 ? (
        <div className="dashboard-module-empty">
          {ko ? "아직 대화가 없어요. 새 채팅으로 일을 시작하세요." : "No chats yet. Start one to get going."}
        </div>
      ) : (
        recent.map((c) => {
          const running = active.has(c.id);
          return (
            <button
              key={c.id}
              onClick={() => navigate(`/chat?id=${c.id}`)}
              className="dashboard-activity-row"
            >
              {running ? <LiveDot /> : <span className="dashboard-muted-dot" />}
              <span>
                {c.title || (ko ? "새 채팅" : "New chat")}
              </span>
              <span>
                {running ? (ko ? "실행 중" : "running") : relTime(c.updatedAt, ko)}
              </span>
            </button>
          );
        })
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
