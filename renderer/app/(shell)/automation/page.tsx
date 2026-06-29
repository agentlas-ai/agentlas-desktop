// 자동화 — 리스트. 영구 SQLite + 백그라운드 스케줄러(60초)로 실제 실행.
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import type { Automation, InstalledAgent, InstalledFirm } from "@/lib/types";
import { IconBolt, IconBuilding, IconPlus, IconTrash } from "@/components/Icon";

export default function AutomationListPage() {
  const { t, locale } = useT();
  const [items, setItems] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

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
      setAgents(visibleAgents(ag));
      setFirms(fm);
    } catch (err) {
      setMessage(locale === "en" ? `Automations could not be loaded. Existing schedules were not changed. ${String(err)}` : `자동화를 불러오지 못했습니다. 기존 예약은 그대로 둡니다. ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function toggle(id: string, enabled: boolean) {
    const api = ipc();
    if (!api) return;
    try {
      await api.automations.toggle(id, enabled);
      await refresh();
    } catch (err) {
      setMessage(locale === "en" ? `Status did not change. ${String(err)}` : `상태를 바꾸지 못했습니다. ${String(err)}`);
    }
  }

  async function remove(id: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("auto.confirm_delete"))) return;
    try {
      await api.automations.remove(id);
      await refresh();
    } catch (err) {
      setMessage(locale === "en" ? `Automation was not deleted. ${String(err)}` : `자동화를 삭제하지 못했습니다. ${String(err)}`);
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
        <div
          style={{
            padding: 12,
            background: "var(--fill-1)",
            border: "1px solid var(--accent-soft)",
            borderRadius: "var(--radius-md)",
            fontSize: 12,
            color: "var(--ink-soft)",
            marginBottom: 16,
          }}
        >
          {t("auto.runtime_note")}
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
            }}
          >
            {locale === "en" ? "Loading automations…" : "자동화를 불러오는 중입니다…"}
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
                    href={`/automation/detail?id=${encodeURIComponent(a.id)}`}
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
                    {a.scheduleHuman} ·{" "}
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      {targetLabel(a).icon}
                      {targetLabel(a).name}
                    </span>
                  </div>
                </div>
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
                  {a.enabled ? t("auto.on") : t("auto.off")}
                </button>
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
