// 대시보드 "자동화" 모듈 — 걸어둔 automations 리스트 + 켜짐/꺼짐 토글 + 다음 실행.
"use client";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { Automation } from "@/lib/types";

function relNext(iso: string | null, ko: boolean): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = t - Date.now();
  const pre = ko ? "다음 " : "in ";
  if (diff <= 0) return ko ? "곧" : "soon";
  const m = Math.round(diff / 60000);
  if (m < 60) return `${pre}${m}${ko ? "분 뒤" : "m"}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${pre}${h}${ko ? "시간 뒤" : "h"}`;
  return `${pre}${Math.round(h / 24)}${ko ? "일 뒤" : "d"}`;
}

export function DashboardAutomations() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [items, setItems] = useState<Automation[] | null>(null);

  useEffect(() => {
    const api = ipc();
    if (!api) {
      setItems([]);
      return;
    }
    void api.automations.list().then(setItems);
  }, []);

  async function toggle(a: Automation) {
    const api = ipc();
    if (!api) return;
    const next = await api.automations.toggle(a.id, !a.enabled);
    setItems((prev) => (prev ? prev.map((x) => (x.id === a.id ? next : x)) : prev));
  }

  const activeCount = items?.filter((a) => a.enabled).length ?? 0;

  return (
    <div style={{ background: "var(--paper-2)", border: "1px solid var(--paper-edge)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 13px", background: "var(--fill-1)", borderBottom: "1px solid var(--paper-edge)" }}>
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--ink)", flex: 1 }}>{ko ? "자동화" : "Automations"}</span>
        {items && items.length > 0 && (
          <span style={{ fontSize: 11, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
            {ko ? `${activeCount}개 활성` : `${activeCount} on`}
          </span>
        )}
      </div>
      {items === null ? (
        <div style={{ padding: "14px 13px", fontSize: 12, color: "var(--muted-deep)" }}>{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : items.length === 0 ? (
        <div style={{ padding: "14px 13px", fontSize: 12, color: "var(--muted-deep)" }}>
          {ko ? "등록된 자동화가 없어요." : "No automations yet."}
        </div>
      ) : (
        items.map((a) => (
          <div key={a.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "8px 13px", borderTop: "1px solid var(--paper-edge)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12.5, color: a.enabled ? "var(--ink)" : "var(--muted-deep)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {a.name}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
                {a.scheduleHuman}
                {a.enabled && a.nextRunAt ? ` · ${relNext(a.nextRunAt, ko)}` : ""}
              </div>
            </div>
            <button
              onClick={() => void toggle(a)}
              className="titlebar-nodrag"
              style={{
                fontSize: 10.5,
                fontWeight: 500,
                padding: "2px 9px",
                borderRadius: 8,
                cursor: "pointer",
                border: a.enabled ? "none" : "1px solid var(--paper-edge)",
                color: a.enabled ? "var(--accent)" : "var(--muted-deep)",
                background: a.enabled ? "var(--fill-1)" : "transparent",
              }}
            >
              {a.enabled ? (ko ? "켜짐" : "On") : ko ? "꺼짐" : "Off"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
