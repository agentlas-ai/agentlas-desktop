// 자동화 — 리스트. 영구 SQLite + 백그라운드 스케줄러(60초)로 실제 실행.
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { humanSchedule } from "@shared/graph-blueprint";
import type { Automation, InstalledAgent, InstalledFirm, RuntimeSelection } from "@/lib/types";
import { IconBolt, IconBuilding, IconPlus, IconTrash } from "@/components/Icon";
import { DescribeAutomation } from "@/components/automation/DescribeAutomation";
import { LoadingEstimate } from "@/components/LoadingEstimate";

function runtimeSelectionLabel(selection: RuntimeSelection | null | undefined, locale: string): string {
  if (!selection) return locale === "en" ? "follows active runtime" : "활성 런타임 따라가기";
  const kindLabels: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    antigravity: "Antigravity",
    kimi: "Kimi",
    grok: "Grok",
    cursor: "Cursor",
    byok: "BYOK",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
    acp: "ACP",
    agentlas: "Agentlas",
  };
  const kind = kindLabels[selection.kind] ?? selection.kind;
  const model = selection.model?.trim();
  return model ? `${kind} · ${model}` : kind;
}

export default function AutomationListPage() {
  const { t, locale } = useT();
  const router = useRouter();
  const [items, setItems] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  /* Hub에서 받기 — 올리는 길과 받는 길이 둘 다 메인 프로세스에만 있었다. */
  const [hubSlug, setHubSlug] = useState("");
  const [installing, setInstalling] = useState(false);
  /* ★결정을 기다리는 자동화를 목록에서 알아볼 수 없었다(실렌더 2026-08-09).
     이 목록이 첫 화면인데, 승인 대기로 멈춘 그래프가 정상인 것과 똑같이 보여서
     사용자는 [지금 실행]을 눌렀고 — 그것은 같은 자리에서 또 멈춘다. */
  const [waiting, setWaiting] = useState<Record<string, string>>({});

  async function refresh() {
    const api = ipc();
    setLoading(true);
    setMessage("");
    if (!api) {
      setLoading(false);
      setMessage(locale === "en" ? "Automations are only available in the desktop app." : "자동화는 데스크톱 앱에서만 사용할 수 있습니다.");
      return;
    }
    try {
      const [list, ag, fm] = await Promise.all([
        api.automations.list(),
        api.team.list(),
        api.firms.list(),
      ]);
      setItems(list);
      // 라벨 해석은 전체 목록으로 — 오케스트레이터 등 시스템 에이전트를 타깃으로 한 자동화가
      // "(삭제된 에이전트)"로 잘못 표시되던 버그(visibleAgents는 픽커용 필터).
      setAgents(ag);
      setFirms(fm);
      // 각 자동화의 마지막 실행에서 "사람이 결정해야 끝나는 실패"만 추린다.
      // 실패해도 목록은 그대로 뜬다 — 배지가 없다고 목록을 못 보면 더 나쁘다.
      // (승인 대기 배지는 승인 게이트 폐지(2026-08-10)로 제거 — EVAL_STUCK 은 승인이
      //  아니라 사람의 판정 교정이 필요한 상태라 남는다.)
      void Promise.all(list.map(async (automation) => {
        const snap = await api.automations.latestRun(automation.id).catch(() => null);
        const failure = Object.values(snap?.nodeFailures ?? {})
          .find((f) => f?.code === "EVAL_STUCK");
        return failure ? ([automation.id, failure.code] as const) : null;
      })).then((rows) => {
        setWaiting(Object.fromEntries(rows.filter(Boolean) as (readonly [string, string])[]));
      }).catch(() => undefined);
    } catch {
      setMessage(locale === "en" ? "Automations could not be loaded. Existing schedules were not changed." : "자동화를 불러오지 못했습니다. 기존 예약은 그대로 둡니다.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function installFromHub() {
    const api = ipc();
    if (!api || !hubSlug.trim() || installing) return;
    setInstalling(true);
    setMessage(locale === "en" ? "Fetching it from the Hub…" : "Hub에서 받는 중입니다…");
    try {
      const res = await api.automations.installGraphFromHub(hubSlug.trim());
      if (!res.ok) { setMessage(res.reason); return; }
      setHubSlug("");
      await refresh();
      // 받아온 것은 꺼진 채로 들어온다 — 그 사실을 말해 주지 않으면 안 도는 이유를 모른다.
      setMessage(locale === "en"
        ? `Installed "${res.name}". It is switched off — look it over, then turn it on.`
        : `"${res.name}"을(를) 받았습니다. 꺼진 상태이니 살펴본 뒤 켜 주세요.`);
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : (locale === "en" ? "Could not install it." : "받지 못했습니다."));
    } finally {
      setInstalling(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    const api = ipc();
    if (!api) return;
    // ★누르면 먼저 반응한다 — 켜기 게이트(연결 검사)가 도는 몇 초 동안 버튼이
    //   그대로면 사람은 "안 눌렸나?" 하고 다시 누른다(플로우 화면에서 고친 병의
    //   목록 화면 쌍둥이, 실측 2026-08-06).
    setMessage(enabled
      ? (locale === "en" ? "Turning it on — checking what it needs…" : "켜는 중입니다 — 필요한 연결을 확인합니다…")
      : (locale === "en" ? "Turning it off…" : "끄는 중입니다…"));
    try {
      await api.automations.toggle(id, enabled);
      setMessage("");
      await refresh();
    } catch (error) {
      // 거절에는 사유가 실려 온다 — 버리지 않는다(runNow와 같은 규칙).
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : "";
      setMessage(reason || (locale === "en" ? "Status did not change." : "상태를 바꾸지 못했습니다."));
    }
  }

  // "지금 실행" — 스케줄 무관 즉시 1회 테스트 실행을 발사하고, 캔버스로 이동해 라이브로 지켜본다.
  // 실행 완료를 여기서 기다리지 않는다(수 분 걸릴 수 있음) — 진행/실패는 캔버스 오버레이가 보여준다.
  function runNow(id: string) {
    const api = ipc();
    if (!api) return;
    setMessage(locale === "en" ? "Starting the run. Opening the live flow..." : "실행을 시작하고 라이브 플로우를 엽니다...");
    api.automations.runNow(id).catch((error: unknown) => {
      // ★거절에는 언제나 사유가 실려 온다 — 그것을 버리고 "시작하지 못했습니다"만
      //   말하면, 무엇을 고쳐야 하는지 아는 쪽은 제품인데 모르는 쪽은 사람이 된다.
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : "";
      setMessage(reason || (locale === "en" ? "Test run did not start." : "테스트 실행을 시작하지 못했습니다."));
    });
    router.push(`/automation/flow?id=${encodeURIComponent(id)}`);
  }

  async function remove(id: string) {
    const api = ipc();
    if (!api) return;
    const automation = items.find((item) => item.id === id);
    const name = automation?.name ?? (locale === "en" ? "this automation" : "이 자동화");
    const message =
      locale === "en"
        ? `Delete '${name}'?\n\nThis also deletes its session transcript.`
        : `'${name}' 자동화를 삭제할까요?\n\n이 자동화의 세션 대화도 같이 삭제됩니다.`;
    if (!confirm(message)) return;
    try {
      await api.automations.remove(id);
      window.dispatchEvent(new CustomEvent("agentlas:automation-changed", { detail: { id } }));
      await refresh();
    } catch {
      setMessage(locale === "en" ? "Automation was not deleted." : "자동화를 삭제하지 못했습니다.");
    }
  }

  function targetLabel(a: Automation): { icon: React.ReactNode; name: string } {
    if (a.targetType === "firm") {
      const f = firms.find((x) => x.id === a.targetId);
      return {
        icon: <IconBuilding size={11} style={{ color: "var(--accent)" }} />,
        name: f ? pickLocalized(f, locale).name : locale === "en" ? "(removed firm)" : "(삭제된 회사)",
      };
    }
    if (a.targetType === "hub") {
      return {
        icon: <IconBolt size={11} style={{ color: "var(--accent)" }} />,
        name: `Hub · ${a.targetId}`,
      };
    }
    const ag = agents.find((x) => x.id === a.targetId);
    return {
      icon: <IconBolt size={11} style={{ color: "var(--muted-deep)" }} />,
      name: ag ? pickLocalized(ag, locale).name : locale === "en" ? "(removed agent)" : "(삭제된 에이전트)",
    };
  }

  return (
    <div style={{ flex: 1, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, flex: 1 }}>
          {t("auto.title")}
        </h1>
        <Link
          href="/automation/new"
          className="titlebar-nodrag"
          data-tour-id="automation.new"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
            textDecoration: "none",
          }}
        >
          <IconPlus size={14} />
          {t("auto.new")}
        </Link>
      </header>

      <section style={{ maxWidth: 880, margin: "24px auto", padding: "0 24px" }} data-tour-id="automation.list">
        {/* 말로 설명해 만드는 입구를 목록 맨 위에 둔다 — 폼을 채우는 것보다 먼저 보여야
            "무엇을 만들 수 있는지" 모르는 사람이 시작할 수 있다. */}
        <DescribeAutomation locale={locale} onCreated={() => void refresh()} />

        {/* ★Hub에서 받기. 올리기·받기 둘 다 메인 프로세스에는 처음부터 있었는데
            누를 자리가 없어 앱에서는 존재하지 않는 기능이었다. */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "12px 0 4px" }}>
          <input
            value={hubSlug}
            onChange={(e) => setHubSlug(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void installFromHub(); }}
            placeholder={locale === "en" ? "Install a graph from the Hub — paste its name" : "Hub에서 그래프 받기 — 이름을 붙여 넣으세요"}
            style={{
              flex: 1, padding: "9px 12px", borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)", background: "var(--paper)", color: "var(--ink)",
              fontSize: 13, outline: "none",
            }}
          />
          <button
            onClick={() => void installFromHub()}
            disabled={installing || !hubSlug.trim()}
            style={{
              padding: "9px 14px", borderRadius: "var(--radius-md)", border: "1px solid var(--paper-edge)",
              background: "var(--paper)", color: "var(--ink)", fontSize: 13,
              opacity: installing || !hubSlug.trim() ? 0.55 : 1,
            }}
          >
            {installing ? (locale === "en" ? "Fetching…" : "받는 중…") : (locale === "en" ? "Install" : "받기")}
          </button>
        </div>
        {message ? (
          <div
            style={{
              padding: 16,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
              color: "var(--ink-soft)",
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {message}
          </div>
        ) : loading ? (
          <div
            style={{
              padding: 16,
              borderRadius: "var(--radius-md)",
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
              color: "var(--muted-deep)",
              fontSize: 13,
              display: "grid",
              gap: 6,
            }}
          >
            <span>{locale === "en" ? "Loading automations…" : "자동화를 불러오는 중입니다…"}</span>
            <LoadingEstimate locale={locale} operationKey="desktop-automation-list" expectedSeconds={[1, 20]} />
          </div>
        ) : items.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--muted-deep)",
              border: "1px dashed var(--paper-edge)",
              borderRadius: "var(--radius-md)",
            }}
          >
            {t("auto.empty")}
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
            {items.map((a) => (
              <li
                key={a.id}
                style={{
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                  borderRadius: "var(--radius-md)",
                  padding: "12px 16px",
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <IconBolt size={16} style={{ color: a.enabled ? "var(--accent)" : "var(--muted)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={`/automation/flow?id=${encodeURIComponent(a.id)}`}
                    className="titlebar-nodrag"
                    style={{
                      display: "block",
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      color: "var(--ink)",
                      textDecoration: "none",
                    }}
                  >
                    {a.name}
                  </Link>
                  <div style={{ fontSize: 11, color: "var(--muted-deep)", overflowWrap: "anywhere" }}>
                    {/* ★크론 원문(`daily-09:00`)을 그대로 보여주던 자리 — 캔버스 헤더는
                        이미 humanSchedule 로 사람 말을 하는데 목록만 안 쓰고 있었다
                        (실렌더 2026-08-09). 목록이 첫 화면이라 여기가 더 중요하다. */}
                    {humanSchedule(a.scheduleHuman, locale)} ·{" "}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {targetLabel(a).icon}
                      {targetLabel(a).name}
                    </span>
                    <span
                      data-testid={`automation-runtime-${a.id}`}
                      style={{ color: "var(--ink-soft)" }}
                    >
                      · {locale === "en" ? "runs on" : "실행 모델"} {runtimeSelectionLabel(a.runtimeSelection, locale)}
                    </span>
                  </div>
                </div>
                {/* 기다리는 결정이 있으면 그것이 이 행의 주 행동이다 — 켜기/끄기·실행보다 앞. */}
                {waiting[a.id] ? (
                  <button
                    onClick={() => router.push(`/automation/flow?id=${encodeURIComponent(a.id)}`)}
                    className="titlebar-nodrag"
                    data-testid={`automation-waiting-${a.id}`}
                    title={locale === "en"
                      ? "This run stopped for a decision. Open it to decide — running again stops at the same place."
                      : "이 실행은 결정을 기다리다 멈췄습니다. 열어서 결정하세요 — 다시 실행하면 같은 자리에서 또 멈춥니다."}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      border: "1px solid var(--accent)",
                      background: "var(--accent)",
                      color: "var(--white)",
                    }}
                  >
                    {locale === "en" ? "Needs your call" : "내가 정해야 함"}
                  </button>
                ) : null}
                <button
                  onClick={() => void toggle(a.id, !a.enabled)}
                  style={{
                    padding: "4px 10px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: 600,
                    border: "1px solid var(--paper-edge)",
                    background: a.enabled ? "var(--fill-1)" : "var(--paper-2)",
                    color: a.enabled ? "var(--accent)" : "var(--muted-deep)",
                  }}
                >
                  {a.enabled ? t("auto.action.disable") : t("auto.action.enable")}
                </button>
                {/* 결정을 기다리는 동안에는 실행을 권하지 않는다 — 눌러 봐야 같은 자리에서
                    또 멈춘다. 그 자리는 위의 [승인 대기]가 대신한다. */}
                {waiting[a.id] ? null : (
                <button
                  onClick={() => runNow(a.id)}
                  className="titlebar-nodrag"
                  title={t("auto.list.run_hint")}
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--accent)",
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper-2)",
                  }}
                >
                  {t("auto.list.run")}
                </button>
                )}
                <Link
                  href={`/automation/new?id=${encodeURIComponent(a.id)}`}
                  className="titlebar-nodrag"
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink-soft)",
                    padding: "4px 10px",
                    borderRadius: 999,
                    border: "1px solid var(--paper-edge)",
                    textDecoration: "none",
                  }}
                >
                  {t("auto.list.edit")}
                </Link>
                <button
                  onClick={() => void remove(a.id)}
                  aria-label={t("common.delete")}
                  title={t("common.delete")}
                  style={{ color: "var(--muted-deep)", padding: 4 }}
                >
                  <IconTrash size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
