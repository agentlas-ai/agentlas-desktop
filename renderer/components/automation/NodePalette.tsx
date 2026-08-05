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
import { GRAPH_BLOCK_UI } from "@shared/graph-vocabulary.generated";

/** 팔레트가 부모에 넘기는 노드 시드(부모가 id/position을 채워 그래프에 삽입). */
export type PaletteNodeSeed = Omit<WorkflowNode, "id" | "position">;

// ★흐름 섹션은 설계서(blocks.json → GRAPH_BLOCK_UI)에서 파생된다 — 손으로 쓴 두 번째
//   목록 금지. "출력 블록이 커널·설계서·캔버스엔 있는데 팔레트에만 빠져 놓을 수 없던"
//   사고(실측 2회: output, action)가 이 목록이 손으로 관리되던 병의 증상이었다.
//   아이콘·문구는 코드에 남는다(JSX·i18n은 JSON에 못 산다) — 대신 누락은 게이트가 잡는다.
const FLOW_ICONS: Record<string, React.ReactNode> = {
  condition: <IconRoute size={13} />,
  transform: <IconWand size={13} />,
  eval: <IconSparkles size={13} />,
  subgraph: <IconLayers size={13} />,
  output: <IconArrowUp size={13} />,
  code: <IconCode size={13} />,
};
const FLOW_ITEMS = (Object.entries(GRAPH_BLOCK_UI) as Array<[
  WorkflowNodeType, { section: string; placeable: boolean },
]>)
  .filter(([, ui]) => ui.section === "flow" && ui.placeable)
  .map(([kind]) => ({
    type: kind,
    // 파생 키의 실재는 게이트(test-graph-canvas-parity)가 검사한다 — 타입 유니온은
    // 전 종류의 키를 만들 수 있어 없는 키(triggerHint 등)까지 포함하므로 여기서 좁힌다.
    labelKey: `auto.node.${kind}` as never,
    hintKey: `auto.node.${kind}Hint` as never,
    icon: FLOW_ICONS[kind] ?? <IconWand size={13} />,
  }));

// ★예전의 `notify | file-write | hep-call` 선택지는 없앴다 — 그 값을 읽는 코드가 제품에
//   하나도 없었다. 대신 **일반 action 항목 하나**를 둔다: 무엇을 할지는 지시문(prompt)에
//   쓰고, 바깥을 바꾸는 노드답게 승인이 잠긴 채(ask) 놓인다.

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

      {/* ★흐름 블록(코드·판정·조건·반복)을 에이전트 목록 **위**에 둔다.
          에이전트는 수십 개까지 늘어나는 목록이고 흐름 블록은 고정 5개인데, 아래에
          있으면 "코드 단계 하나 넣기"에 에이전트 20개를 스크롤해 지나야 한다
          (실사용 실측 2026-08-06: 실제 앱에서 코드 항목이 화면에 아예 안 보였다). */}
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
        <Item
          icon={<IconArrowUp size={13} />}
          label={t("auto.node.action")}
          hint={t("auto.node.actionHint")}
          onClick={() => onAdd({
            type: "action" as WorkflowNodeType,
            // 바깥을 바꾸는 노드는 잠긴 채 태어난다 — 기본을 낮추는 것은 사람이 따로 결정할 일.
            config: { effect: "mutation", approval: "ask" },
            label: t("auto.node.action"),
          })}
        />
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
