// 함대 요약 스트립 — 사장 관제탑 최상단. "나를 기다리는 것"과 "통제의 대가(stall)"를 1초 안에.
// 기획안 비평 5번: 차단형 승인 게이트는 일꾼을 멈추게 한다(stall). 그 누적 대기를 긴급성으로 표시한다.
// 데이터는 전부 실측 IPC: confirm.listPending(승인대기+가장 오래된 대기시각), onActiveChats(작업중),
// team.list(보유 일꾼 수), usage.snapshot(키 상태). 가짜 값 없음.
"use client";
import { useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { deriveKeyStatus, type KeyHealth } from "@/lib/key-status";
import { navigate } from "@/lib/navigation";
import { visibleAgents } from "@/lib/agent-visibility";
import { IconBolt, IconCheck, IconShield } from "@/components/Icon";

const POLL_MS = 10_000;

function stallText(oldestIso: string | null, ko: boolean): string {
  if (!oldestIso) return "";
  const t = new Date(oldestIso).getTime();
  if (!Number.isFinite(t)) return "";
  const hours = (Date.now() - t) / 3_600_000;
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return ko ? `멈춤 ${mins}분` : `stalled ${mins}m`;
  }
  return ko ? `멈춤 ${hours.toFixed(1)}h` : `stalled ${hours.toFixed(1)}h`;
}

export function FleetSummaryStrip() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [pending, setPending] = useState(0);
  const [oldestPending, setOldestPending] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [teamCount, setTeamCount] = useState<number | null>(null);
  const [singleCount, setSingleCount] = useState(0);
  const [keyHealth, setKeyHealth] = useState<KeyHealth>("unknown");

  useEffect(() => {
    let alive = true;
    const loadPending = async () => {
      try {
        const list = (await ipc()?.confirm.listPending()) ?? [];
        if (!alive) return;
        setPending(list.length);
        const oldest = list
          .map((p) => p.createdAt)
          .filter(Boolean)
          .sort()[0];
        setOldestPending(oldest ?? null);
      } catch {
        /* 무시 */
      }
    };
    const loadOwned = async () => {
      try {
        const api = ipc();
        if (!api) return;
        const [a, f] = await Promise.all([api.team.list(), api.firms.list()]);
        if (!alive) return;
        // 멀티(에이전트팀) = 회사(firm) 수, 싱글 = 회사 조직도에 속하지 않은 개별 에이전트.
        const firmAgentIds = new Set<string>();
        for (const firm of f) for (const node of firm.orgChart) firmAgentIds.add(node.agentId);
        const singles = visibleAgents(a).filter((x) => !firmAgentIds.has(x.id));
        setTeamCount(f.length);
        setSingleCount(singles.length);
      } catch {
        /* 무시 */
      }
    };
    const loadKey = async () => {
      try {
        const snap = await ipc()?.usage.snapshot();
        if (alive) setKeyHealth(deriveKeyStatus(snap ?? null).health);
      } catch {
        /* 무시 */
      }
    };
    void loadPending();
    void loadOwned();
    void loadKey();
    const t = setInterval(() => {
      void loadPending();
      void loadKey();
    }, POLL_MS);
    const off = ipcEvents()?.onActiveChats?.((ids) => {
      if (alive) setActive(ids.length);
    });
    return () => {
      alive = false;
      clearInterval(t);
      off?.();
    };
  }, []);

  const stall = pending > 0 ? stallText(oldestPending, ko) : "";

  return (
    <div className="fleet-strip" role="status">
      <span className="fleet-stat" data-tone="active">
        <span className="fleet-dot" data-tone="active" />
        {active} {ko ? "작업중" : "working"}
      </span>
      <button
        className="fleet-stat fleet-stat-button"
        data-tone={pending > 0 ? "warn" : "muted"}
        onClick={() => {
          const el = document.getElementById("approval-inbox");
          if (el) {
            el.scrollIntoView({ behavior: "smooth", block: "center" });
            return;
          }
          navigate("/dashboard#approval-inbox");
        }}
        title={ko ? "승인 대기 항목으로 이동" : "Go to pending approvals"}
      >
        <IconShield size={12} />
        {pending} {ko ? "승인대기" : "awaiting approval"}
        {stall ? ` · ${stall}` : ""}
      </button>
      {teamCount != null && (
        <span className="fleet-stat" data-tone="muted">
          {ko
            ? `에이전트팀 ${teamCount} · 싱글 에이전트 ${singleCount}`
            : `${teamCount} teams · ${singleCount} single agents`}
        </span>
      )}
      <span className="fleet-stat fleet-stat-key" data-health={keyHealth}>
        {keyHealth === "error" ? (
          <IconShield size={12} />
        ) : keyHealth === "ok" ? (
          <IconCheck size={12} />
        ) : (
          <IconBolt size={12} />
        )}
        {keyHealth === "ok"
          ? ko ? "키 정상" : "keys ok"
          : keyHealth === "error"
            ? ko ? "키 연결 끊김" : "keys down"
            : keyHealth === "warning"
              ? ko ? "사용량 임박" : "near limit"
              : ko ? "키 상태 확인 중" : "checking keys"}
      </span>
    </div>
  );
}
