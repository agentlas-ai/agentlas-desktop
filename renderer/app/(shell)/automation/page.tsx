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

  async function refresh() {
    const api = ipc();
    if (!api) return;
    const [list, ag, fm] = await Promise.all([
      api.automations.list(),
      api.team.list(),
      api.firms.list(),
    ]);
    setItems(list);
    setAgents(visibleAgents(ag));
    setFirms(fm);
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function toggle(id: string, enabled: boolean) {
    const api = ipc();
    if (!api) return;
    await api.automations.toggle(id, enabled);
    await refresh();
  }

  async function remove(id: string) {
    const api = ipc();
    if (!api) return;
    if (!confirm(t("auto.confirm_delete"))) return;
    await api.automations.remove(id);
    await refresh();
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

      <section style={{ maxWidth: 880, margin: "24px auto", padding: "0 24px" }}>
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
          {t("auto.stub_note")}
        </div>

        {items.length === 0 ? (
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
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: 13,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {a.name}
                  </div>
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
