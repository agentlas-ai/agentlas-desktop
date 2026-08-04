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
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>({});
  const count = task.providers.reduce((sum, row) => sum + row.gaps.length, 0);
  const helpUrls = [...new Set(task.providers
    .map((row) => row.provider?.keyHelpUrl)
    .filter((url): url is string => !!url))];

  /** 한 묶음이 요구하는 것을 한 번에 저장한다 — 그러면 그 계정의 도구가 함께 열린다. */
  async function saveKeys() {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    try {
      for (const key of task.missing.envKeys) {
        const value = (values[key] ?? "").trim();
        if (value) await api.env.set(key, value);
      }
      setValues({});
      setKeyFormOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

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

      {/* 지금 누를 것. **한 묶음을 한 번에** 채운다 — 이게 이 창의 존재 이유다.
          연결 방식에 따라 다르게 다룬다:
           · api-key — 사용자가 그 서비스에서 만든 키를 붙여넣는다. n8n·Zapier도 이건 폼이다.
                       한 번 넣으면 그 계정의 도구가 **함께** 열린다.
           · oauth   — 브라우저에서 그 서비스에 로그인해야 한다. **폼으로 받지 않는다**
                       (MCP MUST NOT: 자격이 LLM 컨텍스트·중간 서버를 통과해선 안 된다). */}
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
        {task.missing.envKeys.length && task.authKind === "api-key" && !keyFormOpen ? (
          <button
            data-testid={`connections-signin-${task.group}`}
            onClick={() => setKeyFormOpen(true)}
            style={btn(true)}
          >
            {ko ? "한 번에 연결하기" : "Connect once"}
          </button>
        ) : null}
      </div>

      {/* 키 방식 — 한 묶음이 요구하는 것을 **한 번에** 받는다. */}
      {keyFormOpen && task.authKind === "api-key" ? (
        <div data-testid={`connections-keyform-${task.group}`} style={{ display: "grid", gap: 6 }}>
          {task.missing.envKeys.map((key) => (
            <label key={key} style={{ display: "grid", gap: 3 }}>
              <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{key}</span>
              <input
                data-testid={`connections-key-${key}`}
                type="password"
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                placeholder={ko ? "여기에 붙여넣기" : "Paste it here"}
                style={{
                  padding: "6px 8px", borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--paper-edge)", background: "var(--paper)",
                  color: "var(--ink)", fontSize: 12, outline: "none",
                }}
              />
            </label>
          ))}
          {helpUrls.length ? (
            <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
              {ko ? "키를 만드는 곳: " : "Create a key at: "}
              {helpUrls.map((url) => (
                <a key={url} href={url} style={{ color: "var(--ink-soft)" }}>{url}</a>
              ))}
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 6 }}>
            <button
              data-testid={`connections-key-save-${task.group}`}
              disabled={busy || task.missing.envKeys.some((key) => !(values[key] ?? "").trim())}
              onClick={() => void saveKeys()}
              style={btn(true)}
            >
              {busy ? (ko ? "저장하는 중…" : "Saving…") : (ko ? "저장하고 연결" : "Save and connect")}
            </button>
            <button onClick={() => setKeyFormOpen(false)} style={btn(false)}>
              {ko ? "취소" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}

      {/* OAuth — 아직 브라우저 로그인이 배선돼 있지 않다. **있는 척하지 않는다.**
          누르면 아무 일도 없는 버튼을 두는 것이 지금까지 이 제품이 겪은 결함의 형태였다. */}
      {task.missing.envKeys.length && task.authKind !== "api-key" ? (
        <div data-testid={`connections-oauth-${task.group}`} style={{ fontSize: 11, color: "var(--muted-deep)", display: "grid", gap: 3 }}>
          <span style={{ color: "var(--ink)" }}>
            {ko
              ? `${task.groupLabel} 로그인은 아직 이 앱에 연결돼 있지 않습니다.`
              : `Signing in to ${task.groupLabelEn} is not wired into this app yet.`}
          </span>
          <span>
            {ko
              ? "비밀번호는 어디에도 적지 마세요. 이 자동화는 그때까지 켜지지 않습니다."
              : "Do not type a password anywhere. This automation stays off until then."}
          </span>
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
