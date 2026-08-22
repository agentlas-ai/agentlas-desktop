// 자동화 상세 — 메타데이터 + 토글 + 삭제.
"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { Automation, InstalledAgent, InstalledFirm } from "@/lib/types";
import { IconBolt, IconBuilding, IconTrash } from "@/components/Icon";
import { RunHistoryPanel } from "@/components/automation/RunHistoryPanel";
import { LoadingEstimate } from "@/components/LoadingEstimate";

export default function AutomationDetailWrapper() {
  return (
    <Suspense fallback={null}>
      <AutomationDetailPage />
    </Suspense>
  );
}

function AutomationDetailPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const router = useRouter();
  const { t, locale } = useT();
  const [automation, setAutomation] = useState<Automation | null>(null);
  const [target, setTarget] = useState<{ kind: "agent" | "firm"; name: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    const api = ipc();
    setLoading(true);
    setError("");
    if (!api || !id) {
      setError(locale === "en" ? "Automation could not be opened. Nothing changed." : "자동화를 열 수 없습니다. 바뀐 내용은 없습니다.");
      setLoading(false);
      return;
    }
    try {
      const all = await api.automations.list();
      const found = all.find((a) => a.id === id);
      if (!found) {
        router.replace("/automation");
        return;
      }
      setAutomation(found);
      if (found.targetType === "hub") {
        setTarget({
          kind: "agent",
          name: `Hub · ${found.targetId}`,
        });
      } else if (found.targetType === "firm") {
        const firm = await api.firms.get(found.targetId);
        setTarget({
          kind: "firm",
          name: firm ? pickLocalized(firm, locale).name : locale === "en" ? "(removed firm)" : "(삭제된 회사)",
        });
      } else {
        // 전체 목록에서 해석 — 시스템 에이전트 타깃이 "(삭제된 에이전트)"로 표시되던 버그.
        const agents: InstalledAgent[] = await api.team.list();
        const a = agents.find((x) => x.id === found.targetId);
        setTarget({
          kind: "agent",
          name: a ? pickLocalized(a, locale).name : locale === "en" ? "(removed agent)" : "(삭제된 에이전트)",
        });
      }
    } catch {
      setError(locale === "en" ? "Automation could not be loaded. Nothing changed." : "자동화를 불러오지 못했습니다. 바뀐 내용은 없습니다.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, [id]);

  async function toggle() {
    const api = ipc();
    if (!api || !automation) return;
    try {
      const next = await api.automations.toggle(automation.id, !automation.enabled);
      setAutomation(next);
      setError("");
    } catch {
      setError(locale === "en" ? "Status did not change." : "상태를 바꾸지 못했습니다.");
    }
  }

  async function remove() {
    const api = ipc();
    if (!api || !automation) return;
    const message =
      locale === "en"
        ? `Delete '${automation.name}'?\n\nThis also deletes its session transcript.`
        : `'${automation.name}' 자동화를 삭제할까요?\n\n이 자동화의 세션 대화도 같이 삭제됩니다.`;
    if (!confirm(message)) return;
    try {
      await api.automations.remove(automation.id);
      window.dispatchEvent(new CustomEvent("agentlas:automation-changed", { detail: { id: automation.id } }));
      router.replace("/automation");
    } catch {
      setError(locale === "en" ? "Automation was not deleted." : "자동화를 삭제하지 못했습니다.");
    }
  }

  if (loading || error || !automation) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <section style={{ maxWidth: 640, margin: "24px auto", padding: "0 24px" }}>
          <div style={{ ...noticeBox, display: "grid", gap: 6 }}>
            <span>{loading
              ? locale === "en" ? "Loading automation…" : "자동화를 불러오는 중입니다…"
              : error || (locale === "en" ? "Automation could not be opened." : "자동화를 열 수 없습니다.")}</span>
            {loading && <LoadingEstimate locale={locale} operationKey="desktop-automation-detail" expectedSeconds={[1, 20]} />}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          minHeight: 56,
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <IconBolt size={18} style={{ color: automation.enabled ? "var(--accent)" : "var(--muted)" }} />
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, flex: 1 }}>
          {automation.name}
        </h1>
        <Link
          href={`/automation/flow?id=${encodeURIComponent(automation.id)}`}
          className="titlebar-nodrag"
          style={{
            padding: "6px 14px",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--ink)",
            boxShadow: "var(--neu-raised)",
            textDecoration: "none",
          }}
        >
          {t("auto.flow.view")}
        </Link>
        <button
          onClick={() => void toggle()}
          className="titlebar-nodrag"
          style={{
            padding: "6px 14px",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--paper-edge)",
            background: automation.enabled ? "var(--fill-1)" : "var(--paper-2)",
            color: automation.enabled ? "var(--accent)" : "var(--muted-deep)",
          }}
        >
          {automation.enabled ? t("auto.action.disable") : t("auto.action.enable")}
        </button>
        <button
          onClick={() => void remove()}
          className="titlebar-nodrag"
          aria-label={t("common.delete")}
          style={{ color: "var(--muted-deep)", padding: 6 }}
        >
          <IconTrash size={16} />
        </button>
      </header>

      <section
        className="titlebar-nodrag"
        data-tour-id="automation.status"
        style={{ maxWidth: 640, margin: "24px auto", padding: "0 24px", display: "flex", flexDirection: "column", gap: 16 }}
      >
        <Row label={t("auto.detail.schedule")} value={automation.scheduleHuman} />
        <Row
          label={
            automation.targetType === "hub"
              ? "Hub"
              : target?.kind === "firm"
                ? t("auto.detail.firm_label")
                : t("auto.detail.agent_label")
          }
          value={
            <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
              {target?.kind === "firm" ? (
                <IconBuilding size={14} style={{ color: "var(--accent)" }} />
              ) : (
                <IconBolt size={14} style={{ color: "var(--muted-deep)" }} />
              )}
              {target?.name ?? "…"}
            </span>
          }
        />
        <Row
          label={locale === "en" ? "Run tool" : "실행 도구"}
          value={toolModeLabel(automation.toolMode, locale)}
        />
        <Row
          label={locale === "en" ? "Hub usage" : "Hub 사용"}
          value={hubModeLabel(automation.hubMode, locale)}
        />
        {automation.targetType === "hub" && (
          // 반복 자동화가 어느 버전으로 도는지는 결과의 재현성을 좌우한다. latest면 작성자가
          // 재게시하는 순간 같은 자동화가 다른 지시문으로 돈다 — 그 사실을 숨기지 않는다.
          <Row
            label={locale === "en" ? "Agent version" : "에이전트 버전"}
            value={
              automation.targetVersion ? (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <span
                    style={{
                      padding: "2px 7px",
                      borderRadius: 999,
                      border: "1px solid var(--paper-edge)",
                      background: "var(--fill-1)",
                      fontSize: 11,
                      fontWeight: 700,
                    }}
                  >
                    {locale === "en" ? "pinned" : "고정됨"}
                  </span>
                  <code style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                    {automation.targetVersion.slice(0, 12)}
                  </code>
                </span>
              ) : (
                <span style={{ color: "var(--muted-deep)" }}>
                  {locale === "en"
                    ? "latest — the author can change this agent's behavior without notice"
                    : "latest — 작성자가 재게시하면 동작이 예고 없이 바뀝니다"}
                </span>
              )
            }
          />
        )}
        <Row label={t("auto.detail.last_run")} value={automation.lastRunAt ?? t("auto.detail.never")} />
        <RunHistoryPanel automation={automation} locale={locale} compact />
        <Row
          label={t("auto.detail.prompt")}
          value={
            <pre
              style={{
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
                fontFamily: "var(--font-body)",
                fontSize: 13,
                background: "var(--paper)",
                border: "1px solid var(--paper-edge)",
                borderRadius: "var(--radius-md)",
                padding: 12,
                margin: 0,
              }}
            >
              {automation.promptTemplate}
            </pre>
          }
        />
        <p
          style={{
            fontSize: 11,
            color: "var(--muted-deep)",
            marginTop: 16,
            background: "var(--fill-1)",
            border: "1px solid var(--accent-soft)",
            padding: 10,
            borderRadius: "var(--radius-md)",
          }}
        >
          {t("auto.detail.runtime_note")}
        </p>
      </section>
    </div>
  );
}

const noticeBox: React.CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: 16,
  fontSize: 13,
  lineHeight: 1.5,
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--muted-deep)",
          textTransform: "uppercase",
          letterSpacing: 0.6,
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: "var(--ink)" }}>{value}</div>
    </div>
  );
}

function toolModeLabel(mode: Automation["toolMode"], locale: "ko" | "en") {
  if (mode === "browser") return locale === "en" ? "Browser plugin" : "브라우저 플러그인";
  if (mode === "computer-use") return locale === "en" ? "Computer Use" : "컴퓨터 유즈";
  return locale === "en" ? "Auto" : "자동 선택";
}

function hubModeLabel(mode: Automation["hubMode"], locale: "ko" | "en") {
  if (mode === "hub-first") return locale === "en" ? "Hub first" : "Hub 우선";
  if (mode === "local-only") return locale === "en" ? "Local only" : "로컬만";
  return locale === "en" ? "Local first, Hub when resolved" : "로컬 우선, 필요성이 확인되면 Hub";
}
