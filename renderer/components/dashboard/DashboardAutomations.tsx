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
    <div className="dashboard-module">
      <div className="dashboard-module-head">
        <span>{ko ? "자동화" : "Automations"}</span>
        {items && items.length > 0 && (
          <span className="dashboard-module-meta">
            {ko ? `${activeCount}개 활성` : `${activeCount} on`}
          </span>
        )}
      </div>
      {items === null ? (
        <div className="dashboard-module-empty">{ko ? "불러오는 중…" : "Loading…"}</div>
      ) : items.length === 0 ? (
        <div className="dashboard-module-empty">
          {ko ? "등록된 자동화가 없어요." : "No automations yet."}
        </div>
      ) : (
        items.map((a) => (
          <div key={a.id} className="dashboard-module-row">
            <div className="dashboard-row-copy" data-disabled={a.enabled ? "false" : "true"}>
              <div>
                {a.name}
              </div>
              <div>
                {a.scheduleHuman}
                {a.enabled && a.nextRunAt ? ` · ${relNext(a.nextRunAt, ko)}` : ""}
              </div>
            </div>
            <button
              onClick={() => void toggle(a)}
              className="titlebar-nodrag"
              data-toggle-state={a.enabled ? "on" : "off"}
            >
              {a.enabled ? (ko ? "켜짐" : "On") : ko ? "꺼짐" : "Off"}
            </button>
          </div>
        ))
      )}
    </div>
  );
}
