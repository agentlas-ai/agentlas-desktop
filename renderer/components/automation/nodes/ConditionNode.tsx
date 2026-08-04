// 조건 노드(설계 §5 P2) — 이전 노드 출력을 분기한다. 우측에 true/false 두 소스 핸들을
// 두어, 러너(run-graph.ts)가 sourceHandle="true"/"false" 엣지로 하류를 선택하게 한다.
// 표시 요약은 {{var}} op value 형태(NodeConfigPanel이 config.var/op/value를 세팅).
"use client";
import type { NodeProps } from "@xyflow/react";
import { IconRoute } from "@/components/Icon";
import { NodeCard, cfgStr } from "./nodeShared";
import type { WorkflowNodeData } from "./index";

/** config.var/op/value → "{{amount}} > 100" 같은 사람이 읽는 요약. */
function conditionSummary(config: Record<string, unknown>): string | undefined {
  const v = cfgStr(config, "var");
  const op = cfgStr(config, "op");
  const value = config.value;
  if (v || op) {
    const parts = [v ? `{{${v}}}` : "", op ?? "", value != null ? String(value) : ""].filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  return cfgStr(config, "expr") || cfgStr(config, "prompt");
}

export function ConditionNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  return (
    <NodeCard
      type="condition"
      icon={<IconRoute size={13} />}
      title={d.label || d.strings.condition}
      subtitle={conditionSummary(d.config)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      branchHandles
    />
  );
}
