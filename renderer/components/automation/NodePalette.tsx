// 노드 팔레트(설계 §4, P1) — 우측 드로어. 4섹션(흐름 제어 / 도구 / 트리거 / 액션)에 더해
// 에이전트·회사 섹션. 소스는 MCP_TOOL_CATALOG + listInstalledAgents/listFirms +
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
  IconCode,
} from "@/components/Icon";

/** 팔레트가 부모에 넘기는 노드 시드(부모가 id/position을 채워 그래프에 삽입). */
export type PaletteNodeSeed = Omit<WorkflowNode, "id" | "position">;

const FLOW_ITEMS = [
  { type: "condition" as WorkflowNodeType, labelKey: "auto.node.condition" as const, icon: <IconRoute size={13} /> },
  { type: "transform" as WorkflowNodeType, labelKey: "auto.node.transform" as const, icon: <IconLayers size={13} /> },
  // ★커널이 실행할 수 있는 종류는 팔레트에도 있어야 한다. 없으면 "만들었는데 놓을 수
  //   없는 기능"이 된다 — 도구 노드가 정확히 그 상태였고(놓아도 아무 일이 안 일어남),
  //   `eval`·`subgraph`는 아예 놓을 수조차 없었다.
  { type: "eval" as WorkflowNodeType, labelKey: "auto.node.eval" as const, hintKey: "auto.node.evalHint" as const, icon: <IconSparkles size={13} /> },
  { type: "subgraph" as WorkflowNodeType, labelKey: "auto.node.subgraph" as const, hintKey: "auto.node.subgraphHint" as const, icon: <IconLayers size={13} /> },
  // ★"바깥으로 내보내기"는 이 제품이 하는 일의 끝인데, 팔레트에 없어서 **놓을 수가 없었다**.
  //   커널·레지스트리·캔버스 렌더러는 다 아는데 만들 방법만 없던 세 번째 사례다.
  { type: "output" as WorkflowNodeType, labelKey: "auto.node.output" as const, hintKey: "auto.node.outputHint" as const, icon: <IconArrowUp size={13} /> },
  // ★코드 노드 — 정확한 계산·데이터 가공. 사람은 놓기만 하고 무엇을 계산할지 적으면 AI가 스크립트를 짠다.
  { type: "code" as WorkflowNodeType, labelKey: "auto.node.code" as const, hintKey: "auto.node.codeHint" as const, icon: <IconCode size={13} /> },
];

// ★`notify | file-write | hep-call`을 고르게 하던 목록을 없앴다 — 그 값을 **읽는 코드가
//   제품에 하나도 없었다.** action 노드는 적어 둔 지시문대로 돌 뿐이다. 고르게 해 두면
//   사람은 고른 대로 돌 거라고 믿는다. 무엇을 할지는 지시문에 쓴다.
const ACTION_ITEMS: Array<{ action: string; label: string }> = [];

export function NodePalette({ onAdd, onClose }: { onAdd: (seed: PaletteNodeSeed) => void; onClose: () => void }) {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [ag, fm, tl, hub] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.mcpTools.listCatalog(),
        api.marketplace.search("").catch(() => []),
      ]);
      setAgents(visibleAgents(ag));
      setFirms(fm);
      setTools(tl);
      setHubAgents(hub);
    })();
  }, []);

  const agentSeeds = useMemo(
    () => [
      ...firms.map((f) => ({ label: `${pickLocalized(f, locale).name} — CEO`, ref: f.id, targetType: "firm" as const, targetVersion: undefined })),
      ...agents.map((a) => ({ label: pickLocalized(a, locale).name, ref: a.id, targetType: "agent" as const, targetVersion: undefined })),
      ...hubAgents.filter((a) => a.callable === true && Boolean(a.packageHash)).map((a) => ({
        label: `${pickLocalized(a, locale).name} — Hub`,
        ref: a.slug,
        targetType: "hub" as const,
        targetVersion: a.packageHash,
      })),
    ],
    [agents, firms, hubAgents, locale],
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
            onClick={() => onAdd({
              type: "agent",
              config: {
                ref: a.ref,
                targetType: a.targetType,
                ...(a.targetVersion ? { targetVersion: a.targetVersion } : {}),
              },
              label: a.label,
            })}
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
            {...("hintKey" in it && it.hintKey ? { hint: t(it.hintKey) } : {})}
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

function Item({ icon, label, hint, onClick }: {
  icon: React.ReactNode; label: string; hint?: string; onClick: () => void;
}) {
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
      <span style={{ color: "var(--accent)", display: "inline-flex", flexShrink: 0, alignSelf: hint ? "flex-start" : "center", marginTop: hint ? 2 : 0 }}>{icon}</span>
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
        {/* 처음 보는 종류는 이름만으로 무엇인지 알 수 없다 — 한 줄로 말해 준다. */}
        {hint ? (
          <span style={{ fontSize: 10.5, color: "var(--muted-deep)", lineHeight: 1.35, whiteSpace: "normal" }}>
            {hint}
          </span>
        ) : null}
      </span>
    </button>
  );
}
