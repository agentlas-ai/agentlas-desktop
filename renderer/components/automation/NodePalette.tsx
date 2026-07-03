// 노드 팔레트(설계 §4, P1) — 우측 드로어. 4섹션(흐름 제어 / 도구 / 트리거 / 액션)에 더해
// 에이전트·회사 섹션. 소스는 MCP_TOOL_CATALOG + listInstalledAgents/listFirms/agentGroups +
// surface action enum. 항목을 클릭하면 부모가 캔버스에 노드를 추가한다(결정적 배치).
"use client";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT, pickLocalized } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
import type {
  WorkflowNode,
  WorkflowNodeType,
  InstalledAgent,
  InstalledFirm,
  AgentGroup,
  McpToolCatalogEntry,
  MarketplaceListing,
} from "@/lib/types";
import {
  IconBolt,
  IconBuilding,
  IconWand,
  IconRoute,
  IconLayers,
  IconArrowUp,
  IconSparkles,
} from "@/components/Icon";

/** 팔레트가 부모에 넘기는 노드 시드(부모가 id/position을 채워 그래프에 삽입). */
export type PaletteNodeSeed = Omit<WorkflowNode, "id" | "position">;

const FLOW_ITEMS = [
  { type: "condition" as WorkflowNodeType, labelKey: "auto.node.condition" as const, icon: <IconRoute size={13} /> },
  { type: "transform" as WorkflowNodeType, labelKey: "auto.node.transform" as const, icon: <IconLayers size={13} /> },
];

const ACTION_ITEMS: Array<{ action: string; label: string }> = [
  { action: "notify", label: "notify" },
  { action: "file-write", label: "file-write" },
  { action: "hep-call", label: "hep-call" },
];

export function NodePalette({ onAdd, onClose }: { onAdd: (seed: PaletteNodeSeed) => void; onClose: () => void }) {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [ag, fm, gr, tl, hub] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.agentGroups.list(),
        api.mcpTools.listCatalog(),
        api.marketplace.search("").catch(() => []),
      ]);
      setAgents(visibleAgents(ag));
      setFirms(fm);
      setGroups(gr);
      setTools(tl);
      setHubAgents(hub);
    })();
  }, []);

  const agentSeeds = useMemo(
    () => [
      ...firms.map((f) => ({ label: `${pickLocalized(f, locale).name} — CEO`, ref: f.id, targetType: "firm" as const })),
      ...agents.map((a) => ({ label: pickLocalized(a, locale).name, ref: a.id, targetType: "agent" as const })),
      ...groups.map((g) => ({ label: g.name, ref: g.id, targetType: "agent" as const })),
      ...hubAgents.map((a) => ({ label: `${pickLocalized(a, locale).name} — Hub`, ref: a.slug, targetType: "hub" as const })),
    ],
    [agents, firms, groups, hubAgents, locale],
  );

  return (
    <aside
      className="titlebar-nodrag"
      style={{
        width: 260,
        flexShrink: 0,
        borderLeft: "var(--hairline)",
        background: "var(--paper)",
        overflowY: "auto",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <strong style={{ fontSize: 13, flex: 1 }}>{t("auto.flow.palette")}</strong>
        <button onClick={onClose} style={{ fontSize: 18, lineHeight: 1, color: "var(--muted-deep)", padding: "0 4px" }} aria-label={t("common.close")}>
          ×
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--muted-deep)", margin: 0, lineHeight: 1.5 }}>{t("auto.palette.hint")}</p>

      <Section title={t("auto.palette.section.triggers")}>
        <Item
          icon={<IconBolt size={13} />}
          label={t("auto.node.trigger")}
          onClick={() => onAdd({ type: "trigger", config: { schedule: "daily-09:00" }, label: t("auto.node.trigger") })}
        />
      </Section>

      <Section title={t("auto.palette.section.agents")}>
        {agentSeeds.map((a) => (
          <Item
            key={`${a.targetType}:${a.ref}`}
            icon={a.targetType === "firm" ? <IconBuilding size={13} /> : <IconSparkles size={13} />}
            label={a.label}
            onClick={() => onAdd({ type: "agent", config: { ref: a.ref, targetType: a.targetType }, label: a.label })}
          />
        ))}
      </Section>

      <Section title={t("auto.palette.section.tools")}>
        {tools.map((tool) => (
          <Item
            key={tool.id}
            icon={<IconWand size={13} />}
            label={locale === "ko" ? tool.name : tool.nameEn}
            onClick={() =>
              onAdd({
                type: "tool",
                config: {
                  catalog: tool.id,
                  needsCredential: (tool.envRequirements ?? []).some((e) => e.required),
                },
                label: `${t("auto.node.tool")}: ${tool.id}`,
              })
            }
          />
        ))}
      </Section>

      <Section title={t("auto.palette.section.actions")}>
        {ACTION_ITEMS.map((a) => (
          <Item
            key={a.action}
            icon={<IconArrowUp size={13} />}
            label={a.label}
            onClick={() => onAdd({ type: "action", config: { action: a.action }, label: `${t("auto.node.action")}: ${a.action}` })}
          />
        ))}
      </Section>

      <Section title={t("auto.palette.section.flow")}>
        {FLOW_ITEMS.map((it) => (
          <Item
            key={it.type}
            icon={it.icon}
            label={t(it.labelKey)}
            onClick={() => onAdd({ type: it.type, config: {}, label: t(it.labelKey) })}
          />
        ))}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          fontFamily: "var(--font-mono)",
          textTransform: "uppercase",
          letterSpacing: 0.6,
          color: "var(--muted-deep)",
          marginBottom: 6,
        }}
      >
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{children}</div>
    </div>
  );
}

function Item({ icon, label, onClick }: { icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "7px 9px",
        borderRadius: "var(--radius-sm)",
        border: "1px solid var(--paper-edge)",
        background: "var(--paper-2)",
        color: "var(--ink)",
        fontSize: 12,
        textAlign: "left",
        width: "100%",
        cursor: "pointer",
      }}
    >
      <span style={{ color: "var(--accent)", display: "inline-flex", flexShrink: 0 }}>{icon}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
    </button>
  );
}
