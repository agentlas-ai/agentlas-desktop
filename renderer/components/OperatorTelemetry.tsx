"use client";
// 운영 텔레메트리(G21): 모델 호출 장부의 읽기 전용 집계. 소유자가 컨텍스트 상세에서 아이콘을 눌러 연 경우에만 읽는다.
// 모델 호출 없음. 모르는 값은 "—", 0으로 쓰지 않는다. 비용은 소유자가 입력한 단가가 있는 호출만 합산하고 나머지는 따로 센다.
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { Locale } from "@/lib/i18n";

interface Summary {
  calls: number; attempts: number; failed: number; truncated: boolean;
  callsByRole: Record<string, number>;
  retries: { callsWithRetry: number; extraAttempts: number };
  cache: { hitRatio: number | null; measuredAttempts: number };
  compactions: number;
  cost: { byCurrency: Record<string, number>; priced: number; unknown: number; subscription: number; local: number };
}

const dash = "—";

export function OperatorTelemetry({ chatId, locale }: { chatId: string | null; locale: Locale }) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    if (!chatId) return;
    void ipc()?.harness?.call("telemetry.summary", { chatId }).then((result) => {
      if (!live) return;
      if (result?.status === "ok") setSummary(result.data as Summary); else setFailed(true);
    }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [chatId]);
  const ko = locale === "ko";
  if (failed || !summary) return <div style={{ padding: "6px 8px", fontSize: 10.5, color: "var(--muted)" }}>{dash}</div>;
  const money = Object.entries(summary.cost.byCurrency).map(([cur, amount]) => `${amount.toFixed(amount < 1 ? 4 : 2)} ${cur}`).join(" · ");
  const rows: Array<[string, string]> = [
    [ko ? "호출/시도" : "Calls/attempts", summary.attempts ? `${summary.calls}/${summary.attempts}` : dash],
    [ko ? "재시도" : "Retries", summary.attempts ? String(summary.retries.extraAttempts) : dash],
    [ko ? "역할" : "Roles", Object.entries(summary.callsByRole).map(([r, n]) => `${r} ${n}`).join(" · ") || dash],
    [ko ? "캐시 적중" : "Cache hit", summary.cache.hitRatio === null ? dash : `${Math.round(summary.cache.hitRatio * 100)}%`],
    [ko ? "압축" : "Compactions", String(summary.compactions)],
    [ko ? "비용" : "Cost", summary.cost.priced ? money : dash],
    [ko ? "비용 미상" : "Cost unknown", summary.cost.unknown ? String(summary.cost.unknown) : dash],
    [ko ? "구독/로컬" : "Sub/local", `${summary.cost.subscription}/${summary.cost.local}`],
  ];
  return (
    <div data-operator-telemetry="true" style={{ display: "grid", gap: 3, padding: "6px 8px", borderRadius: 6, background: "var(--fill-1)" }}>
      {rows.map(([label, value]) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, fontSize: 10.5, padding: "2px 4px" }}>
          <span style={{ color: "var(--ink-soft)" }}>{label}</span>
          <span style={{ color: value === dash ? "var(--muted)" : "var(--ink)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
        </div>
      ))}
      {summary.truncated && <span style={{ fontSize: 10, color: "var(--muted)", padding: "0 4px" }}>{ko ? "일부만 집계" : "partial"}</span>}
    </div>
  );
}
