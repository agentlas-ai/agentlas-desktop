// 변환 노드(설계 §5 P2) — 노드 간 변수를 순수 함수로 reshape(extract/format/json/identity).
// 러너(run-graph.ts applyTransform)가 config.from/to/mode/template/pattern을 읽어 변수 백을 변형한다.
// 단일 입력/단일 출력이라 분기 핸들은 없다(condition만 분기).
"use client";
import type { NodeProps } from "@xyflow/react";
import { IconLayers } from "@/components/Icon";
import { NodeCard, cfgStr } from "./nodeShared";
import type { WorkflowNodeData } from "./index";

/** config.from/to/mode → "summary → digest (format)" 같은 요약. */
function transformSummary(config: Record<string, unknown>): string | undefined {
  const from = cfgStr(config, "from");
  const to = cfgStr(config, "to");
  const mode = cfgStr(config, "mode");
  if (from || to) {
    const arrow = `${from ? `{{${from}}}` : "?"} → ${to ? `{{${to}}}` : from ? `{{${from}}}` : "?"}`;
    return mode ? `${arrow} (${mode})` : arrow;
  }
  const produces = cfgStr(config, "produces");
  return produces ? `→ {{${produces}}}` : undefined;
}

export function TransformNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  return (
    <NodeCard
      type="transform"
      icon={<IconLayers size={13} />}
      title={d.label || d.strings.transform}
      subtitle={transformSummary(d.config)}
      selected={selected}
      onAiNote={typeof d.onAiNote === "function" ? (d.onAiNote as () => void) : undefined}
      aiHint={d.strings.aiNoteHint}
      connectable={d.connectable}
      runState={d.runState}
    />
  );
}
