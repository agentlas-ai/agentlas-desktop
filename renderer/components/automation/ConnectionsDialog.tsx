// 이 그래프가 연결돼야 하는 것 — **한 창에서, 공급자 묶음별로** 정리한다.
//
// 왜 묶는가: 구글 캘린더·시트·지메일은 **같은 구글 계정 하나**로 열린다.
// 조사한 어느 제품도 이 묶기를 하지 않는다. Power Automate는 커넥터마다
// "새 탭 → 사용자가 직접 닫기 → Refresh → 드롭다운에서 다시 선택" 4스텝을 반복시켜
// 커넥터 3개면 12스텝이 된다. 여기서는 한 묶음 = 한 번.
//
// 화면 규칙(근거 있는 것만):
//  · 카테고리 제목 → 공급자 목록 → 각각 연결 버튼. Cal.com "Connect your calendar" 패턴.
//  · 아직 안 골랐으면 후보를 보여주고 고르게 한다("캘린더"라고만 말한 경우).
//  · **부분 충족으로 통과시키지 않는다.** n8n은 3개 중 1개만 채워도 Continue가 열려
//    사용자가 반쯤 망가진 워크플로를 경고 없이 받는다 — 그걸 베끼지 않는다.
//  · 나중에 하기는 **있다**(Cal.com "I'll connect my calendar later"). 다만 그때는 못 켠다.
"use client";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { GraphConnectionReportShape, ProviderTask } from "@shared/graph-tool-binding";

export function ConnectionsDialog({ automationId, locale, onClose }: {
  automationId: string;
  locale: "ko" | "en";
  onClose: () => void;
}) {
  const ko = locale === "ko";
  const [report, setReport] = useState<GraphConnectionReportShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api) { setFailed(true); setLoading(false); return; }
    setLoading(true);
    try {
      setReport(await api.automations.connectionReport(automationId));
      setFailed(false);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [automationId]);

  useEffect(() => { void load(); }, [load]);

  const ready = report?.activation.canActivate === true;

  return (
    <div
      data-testid="connections-dialog"
      role="dialog"
      aria-modal="true"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 400, display: "flex",
        alignItems: "center", justifyContent: "center", padding: 24,
        background: "rgb(0 0 0 / 32%)",
      }}
    >
      <section
        className="titlebar-nodrag"
        style={{
          width: "min(560px, 100%)", maxHeight: "82vh", overflowY: "auto",
          background: "var(--paper)", border: "1px solid var(--paper-edge)",
          borderRadius: "var(--radius-md)", padding: 20, display: "grid", gap: 14,
          boxShadow: "0 24px 60px -24px rgb(0 0 0 / 45%)",
        }}
      >
        <header style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ink)" }}>
            {ko ? "이 자동화가 쓰는 것들" : "What this automation uses"}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ko
              ? "계정 하나를 연결하면 그 계정의 도구가 함께 열립니다."
              : "Connect one account and every tool on it opens together."}
          </div>
        </header>

        {loading ? (
          <div style={{ fontSize: 13, color: "var(--muted-deep)" }}>
            {ko ? "확인하는 중…" : "Checking…"}
          </div>
        ) : failed ? (
          <div style={{ display: "grid", gap: 4 }}>
            <div style={{ fontSize: 13, color: "var(--ink)" }}>
              {ko ? "연결 상태를 읽지 못했습니다." : "Could not read the connection state."}
            </div>
            <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
              {ko ? "잠시 뒤 다시 열어 주세요." : "Try opening this again in a moment."}
            </div>
          </div>
        ) : !report?.hasRequirements ? (
          <div data-testid="connections-none" style={{ fontSize: 13, color: "var(--ink)" }}>
            {ko
              ? "이 자동화는 바깥 서비스를 쓰지 않습니다. 연결할 것이 없습니다."
              : "This automation uses no outside service. Nothing to connect."}
          </div>
        ) : ready ? (
          <div data-testid="connections-ready" style={{ fontSize: 13, color: "var(--ink)" }}>
            {ko
              ? "필요한 것이 모두 연결돼 있습니다. 이제 켤 수 있습니다."
              : "Everything it needs is connected. You can turn it on."}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {(report?.tasks ?? []).map((task) => (
              <ProviderCard key={task.group} task={task} ko={ko} onChanged={() => void load()} />
            ))}
          </div>
        )}

        {!loading && !failed && report?.hasRequirements && !ready ? (
          <div
            data-testid="connections-blocked"
            style={{
              fontSize: 12, color: "var(--muted-deep)", borderTop: "var(--hairline)", paddingTop: 10,
            }}
          >
            {/* 못 켜는 이유를 그대로 말한다. 결정론 계산의 결과이므로 언제나 맞다. */}
            {report.activation.canActivate === false ? report.activation.reason : ""}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button data-testid="connections-close" onClick={onClose} style={btn(false)}>
            {/* Cal.com "I'll connect my calendar later" — 나중에 하기는 있어야 한다.
                다만 그때는 못 켠다는 사실이 위에 그대로 적혀 있다. */}
            {ready ? (ko ? "닫기" : "Close") : (ko ? "나중에 하기" : "I'll do this later")}
          </button>
        </div>
      </section>
    </div>
  );
}

function ProviderCard({ task, ko, onChanged }: {
  task: ProviderTask;
  ko: boolean;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const count = task.providers.reduce((sum, row) => sum + row.gaps.length, 0);

  async function installMissing(catalogId: string) {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    try {
      await api.mcpTools.install(catalogId);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid={`connections-group-${task.group}`}
      style={{
        border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-sm)",
        padding: 12, display: "grid", gap: 8, background: "var(--paper-2)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>
          {ko ? task.groupLabel : task.groupLabelEn}
        </div>
        {count > 1 ? (
          <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {/* 묶기의 값어치를 한 줄로 보여준다 — 한 번 연결하면 몇 개가 해결되는지. */}
            {ko ? `한 번 연결하면 ${count}곳이 함께 해결됩니다` : `One sign-in covers ${count} steps`}
          </div>
        ) : null}
      </div>

      {task.providers.map((row, index) => (
        <div key={row.provider?.id ?? `unset-${index}`} style={{ display: "grid", gap: 5 }}>
          {row.provider ? (
            <div style={{ fontSize: 12, color: "var(--ink)" }}>{ko ? row.provider.label : row.provider.labelEn}</div>
          ) : (
            <div style={{ display: "grid", gap: 5 }}>
              <div style={{ fontSize: 12, color: "var(--ink)" }}>
                {ko ? "어느 것을 쓸지 아직 정하지 않았습니다" : "Not decided yet"}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {row.candidates.map((candidate) => (
                  <span
                    key={candidate.id}
                    style={{
                      fontSize: 11, padding: "3px 8px", borderRadius: 999,
                      border: "1px solid var(--paper-edge)", color: "var(--muted-deep)",
                    }}
                  >
                    {ko ? candidate.label : candidate.labelEn}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
            {row.gaps.map((gap) => gap.nodeLabel).join(" · ")}
          </div>
        </div>
      ))}

      {/* 지금 누를 것. 값이 필요한 경우엔 이 창에서 비밀을 받지 않는다 —
          MCP 스펙의 MUST NOT("비밀은 폼으로 받지 말고 별도 경로로"). 설정 화면으로 보낸다. */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 2 }}>
        {task.missing.mcpCatalogIds.map((catalogId) => (
          <button
            key={catalogId}
            data-testid={`connections-install-${catalogId}`}
            disabled={busy}
            onClick={() => void installMissing(catalogId)}
            style={btn(true)}
          >
            {busy ? (ko ? "설치하는 중…" : "Installing…") : (ko ? `${catalogId} 설치` : `Install ${catalogId}`)}
          </button>
        ))}
        {task.missing.envKeys.length ? (
          <a
            href="/settings"
            data-testid={`connections-signin-${task.group}`}
            style={{ ...btn(true), textDecoration: "none", display: "inline-flex", alignItems: "center" }}
          >
            {ko ? "계정 연결하기" : "Connect account"}
          </a>
        ) : null}
      </div>
      {task.missing.envKeys.length ? (
        <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
          {ko
            ? "연결은 설정 화면에서 진행합니다. 비밀번호나 키를 이 창에 적지 않습니다."
            : "Sign-in happens in Settings. Never type a password or key into this window."}
        </div>
      ) : null}
    </div>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "6px 12px",
    borderRadius: "var(--radius-sm)",
    border: `1px solid ${primary ? "var(--ink)" : "var(--paper-edge)"}`,
    background: primary ? "var(--ink)" : "var(--paper)",
    color: primary ? "var(--paper)" : "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 12,
    cursor: "pointer",
  };
}
