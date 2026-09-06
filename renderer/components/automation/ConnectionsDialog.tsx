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
//
// 교체(원터치)에 관한 규칙 — 이 창이 **못 채운 것만** 보여주던 때는 이미 연결된 것을
// 다른 걸로 바꿀 자리가 아예 없었다(노드를 하나씩 열어야 했다). 그래서 준비된 것까지
// 전부 보여주고, 각각 옆에 "같은 일을 할 수 있는 다른 것"을 둔다.
// 다만 **할 수 없는 것으로는 안 바꿔준다** — 검사는 main에서 한다(여기서 막는 게 아니라).
"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { pickLocalized } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import type {
  GraphAgentBinding,
  GraphBinding,
  GraphConnectionReportShape,
  ProviderTask,
} from "@shared/graph-tool-binding";

export function ConnectionsDialog({ automationId, locale, onClose }: {
  automationId: string;
  locale: "ko" | "en";
  onClose: () => void;
}) {
  const ko = locale === "ko";
  const [report, setReport] = useState<GraphConnectionReportShape | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  /** 교체가 거절당했을 때 그 이유를 그대로 띄운다. 조용히 아무 일도 없는 것이 제일 나쁘다. */
  const [refusal, setRefusal] = useState<{ reason: string; nextAction: string } | null>(null);
  /** 방금 무엇이 무엇으로 바뀌었는지. 눌렀는데 아무 말이 없으면 사람은 안 바뀐 줄 안다. */
  const [swapped, setSwapped] = useState<string | null>(null);

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

  /** 교체의 답을 한 곳에서 받는다 — 성공이면 새 상태로 갈아끼우고, 거절이면 사유를 띄운다. */
  const applySwap = useCallback((outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["automations"]["swapProvider"]>>) => {
    if (outcome?.ok) {
      setReport(outcome.report);
      setRefusal(null);
      const first = outcome.changed[0];
      setSwapped(first ? `${first.nodeLabel} → ${first.to}` : null);
      return;
    }
    setSwapped(null);
    setRefusal(outcome ? { reason: outcome.reason, nextAction: outcome.nextAction } : null);
  }, []);

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
          width: "var(--popup-3-width)", maxHeight: "82vh", overflowY: "auto",
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
          <div style={{ fontSize: 13, color: "var(--muted-deep)", display: "grid", gap: 5 }}>
            <span>{ko ? "확인하는 중…" : "Checking…"}</span>
            <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-automation-connections" expectedSeconds={[2, 15]} />
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
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {ready ? (
              <div data-testid="connections-ready" style={{ fontSize: 13, color: "var(--ink)" }}>
                {ko
                  ? "필요한 것이 모두 연결돼 있습니다. 이제 켤 수 있습니다."
                  : "Everything it needs is connected. You can turn it on."}
              </div>
            ) : (
              (report?.tasks ?? []).map((task) => (
                <ProviderCard key={task.group} task={task} ko={ko} onChanged={() => void load()} />
              ))
            )}

            {/* 쓰는 것 전부 — 준비된 것도 여기 있어야 바꿀 수 있다. */}
            {(report?.bindings ?? []).length ? (
              <SwapSection
                automationId={automationId}
                bindings={report?.bindings ?? []}
                ko={ko}
                onOutcome={applySwap}
              />
            ) : null}

            {(report?.agents ?? []).length ? (
              <AgentSwapSection
                automationId={automationId}
                agents={report?.agents ?? []}
                ko={ko}
                locale={locale}
                onOutcome={applySwap}
              />
            ) : null}

            {swapped ? (
              <div data-testid="connections-swapped" style={{ fontSize: 12, color: "var(--ink)" }}>
                {ko ? `바꿨습니다 — ${swapped}` : `Changed — ${swapped}`}
              </div>
            ) : null}
            {refusal ? (
              <div data-testid="connections-swap-refused" style={{ display: "grid", gap: 3 }}>
                <span style={{ fontSize: 12, color: "var(--ink)" }}>{refusal.reason}</span>
                <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{refusal.nextAction}</span>
              </div>
            ) : null}
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

/**
 * 이 그래프가 쓰는 것 전부 + **한 번에 바꾸기**.
 * 같은 capability를 쓰는 단계가 여럿이면 함께 바뀐다 — 그게 원터치의 뜻이다.
 */
function SwapSection({ automationId, bindings, ko, onOutcome }: {
  automationId: string;
  bindings: GraphBinding[];
  ko: boolean;
  onOutcome: (outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["automations"]["swapProvider"]>>) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [openFor, setOpenFor] = useState<string | null>(null);

  // 같은 (하는 일 · 지금 쓰는 것) 조합은 한 줄로 접는다 — 단계 3개가 같은 캘린더를 쓰면
  // 줄 3개가 아니라 "3단계"라고 말하는 게 맞다. 바꿀 때도 한 번에 바뀐다.
  const rows = useMemo(() => {
    const map = new Map<string, { key: string; binding: GraphBinding; nodes: string[] }>();
    for (const binding of bindings) {
      const key = `${binding.capability}::${binding.provider?.id ?? ""}`;
      const found = map.get(key);
      if (found) found.nodes.push(binding.nodeLabel);
      else map.set(key, { key, binding, nodes: [binding.nodeLabel] });
    }
    return [...map.values()];
  }, [bindings]);

  async function swap(row: { binding: GraphBinding }, toProvider: string) {
    const api = ipc();
    if (!api) return;
    setBusy(toProvider);
    try {
      onOutcome(await api.automations.swapProvider(automationId, {
        capability: row.binding.capability,
        fromProvider: row.binding.provider?.id ?? null,
        toProvider,
      }));
      setOpenFor(null);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-testid="connections-swap" style={{ display: "grid", gap: 8, borderTop: "var(--hairline)", paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
        {ko ? "쓰는 도구 바꾸기" : "Change a tool"}
      </div>
      {rows.map((row) => {
        const task = ko ? row.binding.capabilityLabel : row.binding.capabilityLabelEn;
        const using = row.binding.provider
          ? (ko ? row.binding.provider.label : row.binding.provider.labelEn)
          : (ko ? "아직 안 정함" : "not decided");
        // 하는 일과 서비스 이름이 같으면("웹 검색" / "웹 검색") 두 번 말하지 않는다.
        const detail = [using === task ? null : using,
          row.binding.status === "ready" ? (ko ? "연결됨" : "connected") : null,
          row.nodes.length > 1 ? (ko ? `${row.nodes.length}단계` : `${row.nodes.length} steps`) : null,
        ].filter(Boolean).join(" · ");
        return (
        <div key={row.key} style={{ display: "grid", gap: 4 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 12, color: "var(--ink)" }}>{task}</span>
            <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{detail}</span>
            {row.binding.alternatives.length ? (
              <button
                data-testid={`connections-swap-open-${row.binding.capability}`}
                onClick={() => setOpenFor(openFor === row.key ? null : row.key)}
                style={{
                  border: "none", background: "none", padding: 0, cursor: "pointer",
                  fontSize: 11, color: "var(--ink-soft)", textDecoration: "underline",
                }}
              >
                {ko ? "다른 걸로 바꾸기" : "Use something else"}
              </button>
            ) : null}
          </div>
          {openFor === row.key ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {row.binding.alternatives.map((candidate) => (
                <button
                  key={candidate.id}
                  data-testid={`connections-swap-to-${candidate.id}`}
                  disabled={busy !== null}
                  onClick={() => void swap(row, candidate.id)}
                  style={btn(false)}
                >
                  {busy === candidate.id
                    ? (ko ? "바꾸는 중…" : "Changing…")
                    : (ko ? candidate.label : candidate.labelEn)}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        );
      })}
      {/* 바꾸면 그 계정에서 고른 것(캘린더 하나·채널 하나)은 남길 수 없다. 미리 말한다.
          다만 바꿀 수 있는 게 하나도 없으면 이 주의는 소음이다. */}
      {rows.some((row) => row.binding.alternatives.length) ? (
        <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
          {ko
            ? "바꾸면 그 서비스에서 골라 둔 항목(캘린더·채널 등)은 다시 골라야 합니다."
            : "After a change you'll pick the specific calendar or channel again."}
        </div>
      ) : null}
    </div>
  );
}

/** 부르는 에이전트 바꾸기. Hub는 **바로 부를 수 있는 것**만 후보에 넣는다. */
function AgentSwapSection({ automationId, agents, ko, locale, onOutcome }: {
  automationId: string;
  agents: GraphAgentBinding[];
  ko: boolean;
  locale: "ko" | "en";
  onOutcome: (outcome: Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["automations"]["swapAgent"]>>) => void;
}) {
  const [roster, setRoster] = useState<Array<{ ref: string; label: string; targetType: "agent" | "firm" | "hub"; targetVersion: string | null }>>([]);
  const [busy, setBusy] = useState(false);
  /**
   * "이 단계에 맞는 것 찾기"의 결과 (커넥터 C23).
   * ★찾아서 **보여주기만** 한다 — 붙이는 것은 사람이 누른다. 제품이 알아서 붙이면
   * 사용자는 자기 그래프에 누가 들어왔는지 모른다.
   */
  const [found, setFound] = useState<Record<string, Array<{ ref: string; label: string; targetVersion: string }>>>({});
  const [finding, setFinding] = useState<string | null>(null);
  const [noMatch, setNoMatch] = useState<string | null>(null);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [installed, firms, hub] = await Promise.all([
        api.team.list().catch(() => []),
        api.firms.list().catch(() => []),
        api.marketplace.search("").catch(() => []),
      ]);
      const rows: Array<{ ref: string; label: string; targetType: "agent" | "firm" | "hub"; targetVersion: string | null }> = [];
      for (const firm of firms) {
        rows.push({ ref: firm.id, label: `${pickLocalized(firm, locale).name} — CEO`, targetType: "firm", targetVersion: null });
      }
      for (const agent of visibleAgents(installed)) {
        rows.push({ ref: agent.id, label: pickLocalized(agent, locale).name, targetType: "agent", targetVersion: null });
      }
      // ★릴리스가 못 박히지 않은 Hub 에이전트는 후보에 넣지 않는다. main이 어차피 거절하지만,
      //   고를 수 있게 보여 놓고 누르면 거절하는 건 화면이 거짓말을 한 것이다.
      for (const listing of hub) {
        if (listing.callable !== true || !listing.packageHash) continue;
        rows.push({
          ref: listing.slug,
          label: `${pickLocalized(listing, locale).name} — Hub`,
          targetType: "hub",
          targetVersion: listing.packageHash,
        });
      }
      setRoster(rows);
    })();
  }, [locale]);

  /** 노드의 지시문을 그대로 질의로 써서 Hub에서 찾는다 — 사람이 다시 타이핑하지 않는다. */
  async function recommend(agent: GraphAgentBinding) {
    const api = ipc();
    if (!api) return;
    setFinding(agent.nodeId);
    setNoMatch(null);
    try {
      const hits = await api.marketplace.search(agent.recommendQuery).catch(() => []);
      const rows = hits
        // ★릴리스가 못 박히지 않은 것은 후보에 넣지 않는다 — 보여주고 거절하면 화면이 거짓말한 것이다.
        .filter((listing) => listing.callable === true && Boolean(listing.packageHash))
        .slice(0, 5)
        .map((listing) => ({
          ref: listing.slug,
          label: pickLocalized(listing, locale).name,
          targetVersion: listing.packageHash as string,
        }));
      setFound((prev) => ({ ...prev, [agent.nodeId]: rows }));
      if (!rows.length) setNoMatch(agent.nodeId);
    } finally {
      setFinding(null);
    }
  }

  async function attach(nodeId: string, row: { ref: string; label: string; targetVersion: string }) {
    const api = ipc();
    if (!api) return;
    setBusy(true);
    try {
      onOutcome(await api.automations.swapAgent(automationId, {
        nodeId, ref: row.ref, targetType: "hub", targetVersion: row.targetVersion, label: row.label,
      }));
      setFound((prev) => ({ ...prev, [nodeId]: [] }));
    } finally {
      setBusy(false);
    }
  }

  async function swap(nodeId: string, ref: string) {
    const api = ipc();
    const pick = roster.find((row) => row.ref === ref);
    if (!api || !pick) return;
    setBusy(true);
    try {
      onOutcome(await api.automations.swapAgent(automationId, {
        nodeId,
        ref: pick.ref,
        targetType: pick.targetType,
        targetVersion: pick.targetVersion,
        label: pick.label,
      }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div data-testid="connections-agents" style={{ display: "grid", gap: 8, borderTop: "var(--hairline)", paddingTop: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
        {ko ? "부르는 에이전트 바꾸기" : "Change an agent"}
      </div>
      {agents.map((agent) => (
        <label key={agent.nodeId} style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>{agent.nodeLabel}</span>
          <select
            data-testid={`connections-agent-${agent.nodeId}`}
            disabled={busy || !roster.length}
            value={agent.ref ?? ""}
            onChange={(e) => void swap(agent.nodeId, e.target.value)}
            style={{
              padding: "6px 8px", borderRadius: "var(--radius-sm)",
              border: "1px solid var(--paper-edge)", background: "var(--paper)",
              color: "var(--ink)", fontSize: 12,
            }}
          >
            <option value="">{ko ? "— 아직 안 정함" : "— not decided"}</option>
            {roster.map((row) => (
              <option key={`${row.targetType}:${row.ref}`} value={row.ref}>{row.label}</option>
            ))}
          </select>

          {/* ★찾아서 보여주기만 한다. 붙이는 것은 사람이 누른다(커넥터 C23). */}
          {agent.recommendQuery ? (
            <button
              data-testid={`connections-recommend-${agent.nodeId}`}
              disabled={finding !== null || busy}
              onClick={() => void recommend(agent)}
              style={{
                // ★밑줄 링크였을 때 아무도 못 찾았다(실측 항목 8) — 진짜 버튼으로.
                border: "1px solid var(--info)", background: "var(--paper)", cursor: "pointer",
                padding: "6px 12px", borderRadius: "var(--radius-sm)",
                fontSize: 12, fontWeight: 700, color: "var(--info)",
                justifySelf: "start",
              }}
            >
              {finding === agent.nodeId
                ? (ko ? "찾는 중…" : "Searching…")
                : (ko ? "이 단계에 맞는 것 찾기" : "Find one for this step")}
            </button>
          ) : null}

          {(found[agent.nodeId] ?? []).length ? (
            <div data-testid={`connections-found-${agent.nodeId}`} style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                {ko ? "찾은 것 — 쓰려면 누르세요" : "Found — click to use"}
              </span>
              {(found[agent.nodeId] ?? []).map((row) => (
                <button
                  key={row.ref}
                  data-testid={`connections-attach-${row.ref}`}
                  disabled={busy}
                  onClick={() => void attach(agent.nodeId, row)}
                  style={{ ...btn(false), textAlign: "left" }}
                >
                  {row.label}
                </button>
              ))}
            </div>
          ) : noMatch === agent.nodeId ? (
            <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
              {/* 없으면 없다고 말한다. 빈 목록을 조용히 두면 눌러도 아무 일이 없는 것처럼 보인다. */}
              {ko
                ? "이 단계에 맞는 것을 못 찾았습니다. 지시문을 조금 더 구체적으로 적으면 잘 찾습니다."
                : "Nothing matched this step. A more specific instruction finds more."}
            </span>
          ) : null}
        </label>
      ))}
      {!roster.length ? (
        <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>
          {ko ? "고를 수 있는 에이전트를 아직 읽지 못했습니다." : "The list of agents could not be read yet."}
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
