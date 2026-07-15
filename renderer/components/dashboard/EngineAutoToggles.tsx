// 엔진 자동 개입 토글 — 대시보드 "LLM 연결 · 사용량" 바로 아래 스위치 2개.
// Stormbreaker 자동은 opt-in, hep-network Workforce는 신규 설치에서 기본 ON이다.
// 근거(2026-07-12 실측): 단순 실작업에서 직접 실행 30s 완료 vs 스톰 라우트 6s 후 실행 0(hub_candidates 데드엔드).
// 컴포저의 Stormbreaker 칩·@멘션 고용·`stormbreaker`/`hep-network` 프리픽스 같은 명시 실행은 토글과 무관하게 항상 동작.
"use client";
import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";

interface ToggleState {
  stormbreakerAuto: boolean;
  networkAuto: boolean;
}

function Switch({ on }: { on: boolean }) {
  return (
    <span
      style={{
        width: 30,
        height: 17,
        borderRadius: 999,
        background: on ? "var(--accent)" : "var(--paper-edge)",
        position: "relative",
        transition: "background 0.12s",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: on ? 15 : 2,
          width: 13,
          height: 13,
          borderRadius: "50%",
          background: "white",
          transition: "left 0.12s",
          boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
        }}
      />
    </span>
  );
}

export function EngineAutoToggles() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [state, setState] = useState<ToggleState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void ipc()
      ?.hephaestus.getEngineToggles()
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  async function toggle(id: "stormbreaker" | "network", enabled: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const next = await ipc()?.hephaestus.setEngineToggle({ id, enabled });
      if (next) setState(next);
    } catch {
      // 비치명적 — 다음 로드 때 실제 상태로 복원된다.
    } finally {
      setBusy(false);
    }
  }

  const rows: Array<{
    id: "stormbreaker" | "network";
    on: boolean;
    title: string;
    subtitle: string;
  }> = [
    {
      id: "stormbreaker",
      on: state?.stormbreakerAuto === true,
      title: ko ? "Stormbreaker 자동 개입" : "Stormbreaker auto engage",
      subtitle: ko
        ? "켜면 일반 채팅에도 견고-실행 루프를 자동 적용. 꺼도 채팅의 Stormbreaker 버튼은 그대로 동작"
        : "Apply the robust-run loop to ordinary chats automatically. The explicit Stormbreaker chip always works",
    },
    {
      id: "network",
      on: state?.networkAuto === true,
      title: ko ? "hep-network 자동 개입" : "hep-network auto engage",
      subtitle: ko
        ? "켜면 요청에 맞는 Hub 에이전트를 자동으로 빌려 실행. 꺼도 @멘션 고용·추천 선택은 그대로 동작"
        : "Borrow matching Hub agents automatically. Explicit @-mention hires and picks always work",
    },
  ];

  return (
    <div className="dashboard-engine-usage" data-tour-id="dashboard.engine-toggles">
      <div className="dashboard-module-head" data-collapsed="false">
        <span>{ko ? "엔진 자동 개입" : "Engine auto engagement"}</span>
      </div>
      {rows.map((row) => (
        <button
          key={row.id}
          onClick={() => void toggle(row.id, !row.on)}
          disabled={state == null || busy}
          data-engine-toggle-id={row.id}
          data-on={row.on ? "true" : "false"}
          className="titlebar-nodrag"
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 10,
            padding: "8px 10px",
            borderRadius: 8,
            background: "transparent",
            border: "none",
            cursor: state == null ? "default" : "pointer",
            opacity: state == null ? 0.55 : 1,
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--fill-1)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
            <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>{row.title}</span>
            <span style={{ display: "block", marginTop: 2, fontSize: 11, lineHeight: 1.35, color: "var(--muted-deep)" }}>
              {row.subtitle}
            </span>
          </span>
          <Switch on={row.on} />
        </button>
      ))}
      <div style={{ padding: "2px 10px 6px", fontSize: 10.5, lineHeight: 1.4, color: "var(--muted-deep)" }}>
        {ko
          ? "신규 설치 기본값: Stormbreaker OFF · hep-network ON. 저장된 선택은 업데이트 후에도 유지됩니다."
          : "New-install defaults: Stormbreaker OFF · hep-network ON. Saved choices survive updates."}
      </div>
    </div>
  );
}
