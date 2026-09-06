// BYOC 키/구독 상태 표시 — 세 화면(Build·Agent·Workspace) 공통.
// 기획안 비평 5번(통제의 대가): 키 사망은 가장 흔한 실패인데 화면에서 미설계였다. 이 컴포넌트가
// usage.snapshot() 실측에서 상태를 도출해 정상은 헤더 pill, 한도임박/오류는 배너로 책임진다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useVisibleInterval } from "@/lib/useVisibleInterval";
import { useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import { deriveKeyStatus, type KeyStatus } from "@/lib/key-status";
import { IconBolt, IconShield, IconCheck } from "@/components/Icon";

const REFRESH_MS = 60_000;

export function KeyStatusBanner({
  mode = "banner",
  relevantProvider,
  problemsInBanner = false,
  compact = false,
}: {
  mode?: "banner" | "pill";
  relevantProvider?: string | null;
  /** Build shows one full warning banner; do not repeat the same warning in its header pill. */
  problemsInBanner?: boolean;
  compact?: boolean;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const snap = await ipc()?.usage.snapshot();
      setStatus(deriveKeyStatus(snap ?? null));
    } catch {
      setStatus({ health: "unknown", affected: [], connected: 0 });
    }
  }, []);

  // 초기 1회 load는 유지, 주기 폴링(60s)은 탭 보일 때만 — useVisibleInterval이 hidden 시 정지.
  useEffect(() => {
    void load();
  }, [load]);
  useVisibleInterval(() => void load(), REFRESH_MS);

  if (!status || status.health === "unknown") return null;

  const providerNeedle = relevantProvider?.trim().toLowerCase() ?? "";
  const relevantAffected = providerNeedle
    ? status.affected.filter((label) => {
        const candidate = label.toLowerCase();
        return candidate.includes(providerNeedle) || providerNeedle.includes(candidate);
      })
    : status.affected;
  // A warning about a different engine must not interrupt the selected Build.
  // deriveKeyStatus only reports error when every provider is dead, so errors
  // remain globally relevant even when a specific engine label was supplied.
  if (status.health === "warning" && providerNeedle && relevantAffected.length === 0) return null;
  const affected = relevantAffected.join(", ");

  if (mode === "pill") {
    if (problemsInBanner && status.health !== "ok") return null;
    // 정상일 때만 헤더 pill 노출(군더더기 최소화). 경고/오류는 배너 모드가 책임진다.
    if (status.health !== "ok") {
      return (
        <span className="key-status-pill" data-health={status.health} title={affected}>
          <IconShield size={12} />
          {status.health === "error"
            ? ko ? "키 연결 끊김" : "Keys down"
            : ko ? "사용량 한도 임박" : "Usage near limit"}
        </span>
      );
    }
    return (
      <span className="key-status-pill" data-health="ok">
        <IconCheck size={12} />
        {ko ? "구독 키 정상" : "Keys healthy"}
      </span>
    );
  }

  // banner 모드: 정상이면 아무것도 안 띄운다(조용한 정상).
  if (status.health === "ok") return null;

  const isError = status.health === "error";
  const noticeKey = `${status.health}:${affected}`;
  if (compact) {
    if (dismissed === noticeKey) return null;
    const summary = isError
      ? (ko ? "키 연결을 확인하세요." : "Check your key connection.")
      : (ko ? "사용량 한도에 근접했습니다." : "Approaching usage limit.");
    const detail = [summary, affected].filter(Boolean).join(" · ");
    return (
      <div role="status" style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, padding: "4px 12px", background: "var(--paper)", color: "var(--ink-soft)", fontSize: 11, lineHeight: "20px" }}>
        <span title={detail} style={{ minWidth: 0, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{detail}</span>
        <button type="button" onClick={() => navigate("/dashboard")} style={{ flexShrink: 0, border: 0, background: "transparent", color: "inherit", padding: "2px 4px", font: "inherit", cursor: "pointer" }}>
          {ko ? "사용량 확인" : "Check usage"}
        </button>
        <button type="button" aria-label={ko ? "사용량 알림 닫기" : "Dismiss usage notice"} onClick={() => setDismissed(noticeKey)} style={{ flexShrink: 0, border: 0, background: "transparent", color: "inherit", width: 28, height: 28, padding: 0, fontSize: 16, cursor: "pointer" }}>×</button>
      </div>
    );
  }
  return (
    <div className="key-status-banner" data-health={status.health} role="status">
      {isError ? <IconShield size={15} /> : <IconBolt size={15} />}
      <div className="key-status-banner-copy">
        <strong>
          {isError
            ? ko ? "BYOC 키 연결이 끊겼습니다 — 모든 에이전트가 멈춥니다." : "BYOC keys disconnected — all workers stall."
            : ko ? "사용량 한도에 근접했습니다." : "Approaching usage limit."}
        </strong>
        <span>
          {affected
            ? ko ? `영향: ${affected}` : `Affected: ${affected}`
            : ko ? "엔진 연결 상태를 확인하세요." : "Check engine connection."}
          {" · "}
          {ko
            ? "내 구독/키로만 구동됩니다."
            : "Runs only on your own subscription/keys."}
        </span>
      </div>
      <button
        type="button"
        className="titlebar-nodrag"
        onClick={() => navigate("/dashboard")} // 엔진 연결·사용량·키는 대시보드가 관리(세팅 아님)
        style={{
          marginLeft: "auto",
          flexShrink: 0,
          border: "1px solid var(--paper-edge)",
          borderRadius: 8,
          background: "var(--paper)",
          color: "var(--ink)",
          padding: "6px 9px",
          fontSize: 11,
          fontWeight: 800,
        }}
      >
        {isError ? (ko ? "키 열기" : "Open keys") : ko ? "사용량 확인" : "Check usage"}
      </button>
    </div>
  );
}
