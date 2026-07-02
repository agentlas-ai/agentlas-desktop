// 자동화 상세 — 메타데이터 + 토글 + 삭제.
"use client";
import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type { Automation, InstalledAgent, InstalledFirm } from "@/lib/types";
import { IconBolt, IconBuilding, IconTrash } from "@/components/Icon";

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
      if (found.targetType === "firm") {
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
    } catch (err) {
      setError(locale === "en" ? `Automation could not be loaded. Nothing changed. ${String(err)}` : `자동화를 불러오지 못했습니다. 바뀐 내용은 없습니다. ${String(err)}`);
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
    } catch (err) {
      setError(locale === "en" ? `Status did not change. ${String(err)}` : `상태를 바꾸지 못했습니다. ${String(err)}`);
    }
  }

  async function remove() {
    const api = ipc();
    if (!api || !automation) return;
    if (!confirm(t("auto.confirm_delete"))) return;
    try {
      await api.automations.remove(automation.id);
      router.replace("/automation");
    } catch (err) {
      setError(locale === "en" ? `Automation was not deleted. ${String(err)}` : `자동화를 삭제하지 못했습니다. ${String(err)}`);
    }
  }

  if (loading || error || !automation) {
    return (
      <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
        <section style={{ maxWidth: 640, margin: "24px auto", padding: "0 24px" }}>
          <div style={noticeBox}>
            {loading
              ? locale === "en" ? "Loading automation…" : "자동화를 불러오는 중입니다…"
              : error || (locale === "en" ? "Automation could not be opened." : "자동화를 열 수 없습니다.")}
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
          {automation.enabled ? t("auto.on") : t("auto.off")}
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
          label={target?.kind === "firm" ? t("auto.detail.firm_label") : t("auto.detail.agent_label")}
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
        <Row label={t("auto.detail.last_run")} value={automation.lastRunAt ?? t("auto.detail.never")} />
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
