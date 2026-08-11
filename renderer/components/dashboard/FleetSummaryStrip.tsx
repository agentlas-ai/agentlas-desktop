// 함대 요약 스트립 — 사장 관제탑 최상단. "나를 기다리는 것"과 "통제의 대가(stall)"를 1초 안에.
// 기획안 비평 5번: 차단형 승인 게이트는 일꾼을 멈추게 한다(stall). 그 누적 대기를 긴급성으로 표시한다.
// 데이터는 전부 실측 IPC: confirm.listPending(승인대기+가장 오래된 대기시각), onActiveChats(작업중),
// team.list(보유 일꾼 수), usage.snapshot(키 상태). 가짜 값 없음.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { deriveKeyStatus, type KeyHealth } from "@/lib/key-status";
import { navigate } from "@/lib/navigation";
import { visibleAgents } from "@/lib/agent-visibility";
import { loadViewData, readViewData, writeViewData } from "@/lib/view-data-cache";
import { IconBolt, IconCheck, IconShield } from "@/components/Icon";
import type { InstalledAgent, InstalledFirm, PendingConfirmation, UsageSnapshot } from "@/lib/types";

const POLL_MS = 10_000;
const DATA_MAX_AGE_MS = 15_000;

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
  const cachedPending = readViewData<PendingConfirmation[]>("dashboard.confirm.pending")?.value ?? [];
  const cachedTeam = readViewData<InstalledAgent[]>("dashboard.team")?.value ?? [];
  const cachedFirms = readViewData<InstalledFirm[]>("dashboard.firms")?.value ?? [];
  const cachedUsage = readViewData<UsageSnapshot>("dashboard.usage")?.value ?? null;
  const cachedFirmAgentIds = new Set(cachedFirms.flatMap((firm) => firm.orgChart.map((node) => node.agentId)));
  const [pending, setPending] = useState(cachedPending.length);
  const [oldestPending, setOldestPending] = useState<string | null>(() => cachedPending.map((item) => item.createdAt).filter(Boolean).sort()[0] ?? null);
  const [active, setActive] = useState(() => readViewData<string[]>("dashboard.active-chats")?.value?.length ?? 0);
  const [teamCount, setTeamCount] = useState<number | null>(cachedFirms.length > 0 ? cachedFirms.length : null);
  const [singleCount, setSingleCount] = useState(() => visibleAgents(cachedTeam).filter((agent) => !cachedFirmAgentIds.has(agent.id)).length);
  const [keyHealth, setKeyHealth] = useState<KeyHealth>(() => deriveKeyStatus(cachedUsage).health);

  const loadPending = useCallback(async (force = false) => {
    try {
      const api = ipc();
      if (!api) return;
      const list = await loadViewData("dashboard.confirm.pending", () => api.confirm.listPending(), { maxAgeMs: DATA_MAX_AGE_MS, force });
      setPending(list.length);
      const oldest = list
        .map((p) => p.createdAt)
        .filter(Boolean)
        .sort()[0];
      setOldestPending(oldest ?? null);
    } catch {
      /* 무시 */
    }
  }, []);
  const loadKey = useCallback(async (force = false) => {
    try {
      const api = ipc();
      if (!api) return;
      const snap = await loadViewData("dashboard.usage", () => api.usage.snapshot(), { maxAgeMs: DATA_MAX_AGE_MS, force });
      setKeyHealth(deriveKeyStatus(snap ?? null).health);
    } catch {
      /* 무시 */
    }
  }, []);

  // 폴링(10s)으로 도는 loadPending+loadKey만 useVisibleInterval로(탭 숨김 시 정지).
  useVisibleInterval(() => {
    void loadPending(true);
    void loadKey(true);
  }, POLL_MS);

  useEffect(() => {
    let alive = true;
    const loadOwned = async () => {
      try {
        const api = ipc();
        if (!api) return;
        const [a, f] = await Promise.all([
          loadViewData("dashboard.team", () => api.team.list(), { maxAgeMs: DATA_MAX_AGE_MS }),
          loadViewData("dashboard.firms", () => api.firms.list(), { maxAgeMs: DATA_MAX_AGE_MS }),
        ]);
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
    // 초기 1회 load는 유지(loadOwned는 마운트 1회만 — 폴링 대상 아님).
    void loadPending();
    void loadOwned();
    void loadKey();
    void ipc()?.invoke.activeChats().then((ids) => {
      if (!alive) return;
      writeViewData("dashboard.active-chats", ids);
      setActive(ids.length);
    }).catch(() => undefined);
    const off = ipcEvents()?.onActiveChats?.((ids) => {
      if (alive) {
        writeViewData("dashboard.active-chats", ids);
        setActive(ids.length);
      }
    });
    return () => {
      alive = false;
      off?.();
    };
  }, [loadPending, loadKey]);

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
