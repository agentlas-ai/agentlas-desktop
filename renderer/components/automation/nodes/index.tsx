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
  IconLayers,
  IconCode,
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
  progress?: string;
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
  eval: string;
  subgraph: string;
  code: string;
  codeLangLabel?: string;
  /** 부르는 자동화의 이름 — 없으면 아직 안 고른 것이다. */
  subgraphRef?: string;
  subgraphUnset: string;
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
      progress={d.progress}
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
      icon={isFirm ? <IconBuilding size={13}/> : <IconSparkles size={13} />}
      title={d.label || (isFirm ? d.strings.firm : isHub ? "Hub" : d.strings.agent)}
      subtitle={prompt || ref || summaryProduces(d)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      outcomeHandles
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
      progress={d.progress}
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
      icon={<IconRoute size={13}/>}
      title={d.label || (action ? `${d.strings.action}: ${action}` : d.strings.action)}
      subtitle={summaryProduces(d)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      outcomeHandles
    />
  );
}

export function OutputNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const catalog = cfgStr(d.config, "catalog");
  return (
    <NodeCard
      type="output"
      icon={<IconArrowUp size={13}/>}
      title={d.label || d.strings.output}
      subtitle={catalog}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      outcomeHandles
      hasOut={false}
    />
  );
}

export function EvalNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const subject = cfgStr(d.config, "subject");
  const criteria = cfgStr(d.config, "criteria");
  return (
    <NodeCard
      type="eval"
      icon={<IconSparkles size={13} />}
      title={d.label || d.strings.eval}
      // 무엇을 어떤 기준으로 보는지가 카드에 보여야 한다 — 안 보이면 "검증"이라는
      // 이름만 있고 무엇을 재는지는 열어봐야 안다.
      subtitle={subject && criteria ? `${subject} — ${criteria}` : (criteria || subject)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      branchHandles
    />
  );
}

export function SubgraphNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const ref = cfgStr(d.config, "graphRef");
  return (
    <NodeCard
      type="subgraph"
      icon={<IconLayers size={13}/>}
      title={d.label || d.strings.subgraph}
      // ★어느 자동화를 부르는지가 안 보이면, 캔버스만 보고는 무엇이 실행되는지 알 수 없다.
      subtitle={ref ? (d.strings.subgraphRef ?? ref) : d.strings.subgraphUnset}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      outcomeHandles
    />
  );
}

export function CodeNode({ data, selected }: NodeProps) {
  const d = data as WorkflowNodeData;
  const lang = cfgStr(d.config, "codeLang") || "python";
  const hasCode = !!cfgStr(d.config, "code");
  return (
    <NodeCard
      type="code"
      icon={<IconCode size={13}/>}
      title={d.label || d.strings.code}
      // 무슨 언어인지, 스크립트가 채워졌는지가 캔버스에서 보여야 한다.
      subtitle={hasCode ? `${lang}` : (d.codeLangLabel ? `${d.codeLangLabel}` : lang)}
      selected={selected}
      connectable={d.connectable}
      runState={d.runState}
      progress={d.progress}
      outcomeHandles
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
  // ★커널이 실행하는 종류는 전부 여기 있어야 한다. 빠지면 React Flow 가 그 노드를
  //   못 그리고, 사용자는 그래프에 구멍이 난 것을 본다.
  eval: EvalNode,
  subgraph: SubgraphNode,
  code: CodeNode,
};
