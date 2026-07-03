// 워크플로우 커스텀 노드 — React Flow nodeTypes 맵.
// 각 노드는 WorkflowNodeType별로 아이콘+라벨+요약을 렌더하는 최소 카드.
"use client";
import type { NodeProps } from "@xyflow/react";
import {
  IconBolt,
  IconBuilding,
  IconWand,
  IconRoute,
  IconArrowUp,
  IconSparkles,
} from "@/components/Icon";
import { NodeCard, ConnectServiceBadge, cfgStr } from "./nodeShared";
import { ConditionNode } from "./ConditionNode";
import { TransformNode } from "./TransformNode";

// React Flow는 node.data에 임의 payload를 넘긴다. 우리는 원본 WorkflowNode config +
// 표시용 label + 로케일 문자열을 담는다.
export interface WorkflowNodeData {
  label?: string;
  config: Record<string, unknown>;
  /** 로케일 의존 문자열(부모가 주입) — 노드 내부에서 useT를 쓰지 않기 위함. */
  strings: NodeStrings;
  /** 편집 모드면 핸들 drag-connect 허용(뷰어면 false). */
  connectable?: boolean;
  /** 라이브 실행 상태(설계 §5 P2) — 캔버스 오버레이가 주입. */
  runState?: string;
  [key: string]: unknown;
}

export interface NodeStrings {
  connectService: string;
  trigger: string;
  agent: string;
  firm: string;
  tool: string;
  action: string;
  output: string;
  condition: string;
  transform: string;
  producesLabel: string;
  consumesLabel: string;
}

function summaryProduces(data: WorkflowNodeData): string | undefined {
  const produces = cfgStr(data.config, "produces");
  const consumes = cfgStr(data.config, "consumes");
  const parts: string[] = [];
  if (consumes) parts.push(`${data.strings.consumesLabel} {{${consumes}}}`);
  if (produces) parts.push(`${data.strings.producesLabel} {{${produces}}}`);
  return parts.length ? parts.join(" · ") : undefined;
}

export function TriggerNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const schedule = cfgStr(d.config, "schedule");
  return (
    <NodeCard
      type="trigger"
      icon={<IconBolt size={13} />}
      title={d.label || d.strings.trigger}
      subtitle={schedule}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      hasIn={false}
    />
  );
}

export function AgentNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const isFirm = cfgStr(d.config, "targetType") === "firm";
  const isHub = cfgStr(d.config, "targetType") === "hub";
  const ref = cfgStr(d.config, "ref");
  const prompt = cfgStr(d.config, "prompt");
  return (
    <NodeCard
      type="agent"
      icon={isFirm ? <IconBuilding size={13} /> : <IconSparkles size={13} />}
      title={d.label || (isFirm ? d.strings.firm : isHub ? "Hub" : d.strings.agent)}
      subtitle={prompt || ref || summaryProduces(d)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
    />
  );
}

export function ToolNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const catalog = cfgStr(d.config, "catalog");
  const needsCredential = d.config.needsCredential === true;
  return (
    <NodeCard
      type="tool"
      icon={<IconWand size={13} />}
      title={d.label || (catalog ? `${d.strings.tool}: ${catalog}` : d.strings.tool)}
      subtitle={summaryProduces(d)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      badge={needsCredential ? <ConnectServiceBadge label={d.strings.connectService} /> : undefined}
    />
  );
}

export function ActionNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const action = cfgStr(d.config, "action");
  return (
    <NodeCard
      type="action"
      icon={<IconRoute size={13} />}
      title={d.label || (action ? `${d.strings.action}: ${action}` : d.strings.action)}
      subtitle={summaryProduces(d)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
    />
  );
}

export function OutputNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const catalog = cfgStr(d.config, "catalog");
  return (
    <NodeCard
      type="output"
      icon={<IconArrowUp size={13} />}
      title={d.label || d.strings.output}
      subtitle={catalog}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      hasOut={false}
    />
  );
}

/** React Flow nodeTypes 맵 — WorkflowNodeType → 컴포넌트. */
export const workflowNodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  tool: ToolNode,
  action: ActionNode,
  output: OutputNode,
  condition: ConditionNode,
  transform: TransformNode,
};
