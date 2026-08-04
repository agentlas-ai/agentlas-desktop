// 자동화 플로우 — 챗이 만든 자동화를 노드 그래프로 렌더. P1: 읽기 전용 뷰어에서 편집 가능
// 캔버스로 승격. 편집 모드는 drag-move / drag-connect / 팔레트 추가 / config 편집 / 노드·엣지
// 삭제를 지원하고, updateGraph로 저장한다(설계 §4, P1). null-graph 자동화는 2노드 합성 그래프를
// 즉석에서 만들어 편집 시작점으로 제공한다.
//
// React Flow는 client-only이고 이 앱은 Next.js static export(file://)이므로 "use client" 필수.
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ipc, ipcEvents } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { Automation, WorkflowGraph, WorkflowNode, WorkflowNodeRunState } from "@/lib/types";
import { layoutGraph, needsLayout } from "@/lib/workflow-layout";
import { validateWorkflow, type WorkflowIssue } from "@/lib/workflow-validate";
import { workflowNodeTypes, type NodeStrings, type WorkflowNodeData } from "@/components/automation/nodes";
import { NODE_ACCENT } from "@/components/automation/nodes/nodeShared";
import { NodePalette, type PaletteNodeSeed } from "@/components/automation/NodePalette";
import { NodeConfigPanel } from "@/components/automation/NodeConfigPanel";
import { RunHistoryPanel } from "@/components/automation/RunHistoryPanel";
import { AutomationSessionPanel } from "@/components/automation/AutomationSessionPanel";
import { IconBolt } from "@/components/Icon";

/** 좌/우 패널 접힘 상태 — 화면을 다시 열어도 사용자가 정한 레이아웃을 유지한다. */
const PANEL_STATE_KEY = "agentlas.automation.flow.panels";

export default function AutomationFlowWrapper() {
  return (
    <Suspense fallback={null}>
      <ReactFlowProvider>
        <AutomationFlowPage />
      </ReactFlowProvider>
    </Suspense>
  );
}

/** graph_json이 null인 레거시 자동화용 2노드 그래프 즉석 합성(백엔드 synthesizeLegacyGraph 미러). */
function synthesizeLegacyGraph(a: Automation): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      {
        id: "n0",
        type: "trigger",
        position: { x: 0, y: 120 },
        // scheduleSpec을 반드시 같이 실어야 한다. 폼으로 만든 자동화는 graph_json이 null이라
        // 여기서 시드되는데, cron/once/manual/interval 스케줄의 scheduleHuman 토큰은 "spec"이라
        // specFromLegacyToken이 복원하지 못한다(NodeConfigPanel §112). 그러면 ScheduleBuilder가
        // value=null로 마운트해 daily-09:00 기본값을 즉시 방출하고, 트리거 노드를 클릭만 해도
        // "*/30 9-18 * * 1-5" 같은 스케줄이 저장 시 하루 1회 09:00으로 조용히 덮어써졌다.
        config: { schedule: a.scheduleHuman, ...(a.scheduleSpec ? { scheduleSpec: a.scheduleSpec } : {}) },
        label: "Trigger",
      },
      {
        id: "n1",
        type: "agent",
        position: { x: 280, y: 120 },
        config: {
          ref: a.targetId,
          targetType: a.targetType,
          prompt: a.promptTemplate,
          ...(a.targetType === "hub" && a.targetVersion ? { targetVersion: a.targetVersion } : {}),
        },
        label: a.targetType === "firm" ? "Firm" : a.targetType === "hub" ? "Hub Agent" : "Agent",
      },
    ],
    edges: [{ id: "e0-1", source: "n0", target: "n1" }],
  };
}

function AutomationFlowPage() {
  const searchParams = useSearchParams();
  const id = searchParams.get("id") ?? "";
  const router = useRouter();
  const { t, locale } = useT();

  const [automation, setAutomation] = useState<Automation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 좌(세션 대화)·우(노드 검사 + 실행 기록) 패널 접기. 캔버스가 좁은 화면에서 가장 먼저
  // 희생되던 문제를 사용자가 직접 해소할 수 있게 한다. 선택은 로컬에 남는다.
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(PANEL_STATE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { left?: boolean; right?: boolean };
      if (typeof saved.left === "boolean") setLeftOpen(saved.left);
      if (typeof saved.right === "boolean") setRightOpen(saved.right);
    } catch {
      // 저장된 값이 깨졌으면 기본값(둘 다 열림)으로 둔다.
    }
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_STATE_KEY, JSON.stringify({ left: leftOpen, right: rightOpen }));
    } catch {
      // 저장 실패는 이 화면의 동작을 막지 않는다.
    }
  }, [leftOpen, rightOpen]);

  // 패널을 접었는데 그래프가 원래 자리에 그대로 있으면 넓어진 캔버스가 빈 여백으로 보인다.
  // 폭이 바뀐 다음 프레임에 다시 맞춘다.
  const { fitView } = useReactFlow();
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        fitView({ padding: 0.3, maxZoom: 1 });
      } catch {
        // 캔버스가 아직 준비되지 않았으면 다음 상호작용에서 맞춰진다.
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [fitView, leftOpen, rightOpen]);

  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<Node<WorkflowNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  // 노드 id → 라이브 실행 상태(설계 §5 P2). 라이브 채널 이벤트 + latestRun 하이드레이트로 채움.
  const [runStates, setRunStates] = useState<Record<string, WorkflowNodeRunState>>({});
  // 왜 멈췄고 지금 무엇을 누르면 되는지. 상태 단어만 있는 화면은 사용자에게 아무 말도 못 한다.
  const [nodeFailures, setNodeFailures] = useState<
    Record<string, { code: string; reason: string; nextAction: string }>
  >({});
  const [approvalBusy, setApprovalBusy] = useState(false);
  // 자연어로 그래프를 고치는 제안 — 적용 전까지는 저장된 그래프를 건드리지 않는다.
  const [architectDraft, setArchitectDraft] = useState("");
  const [architectBusy, setArchitectBusy] = useState(false);
  const [proposal, setProposal] = useState<{
    patch: { ops: unknown[]; rationale?: string };
    risks: string[];
    summary: { added: string[]; removed: string[]; changed: string[] };
    needsApproval: boolean;
    rationale?: string;
  } | null>(null);
  const runStatesRef = useRef<Record<string, WorkflowNodeRunState>>({});
  runStatesRef.current = runStates;

  const nodeStrings: NodeStrings = useMemo(
    () => ({
      connectService: t("auto.flow.connect_service"),
      trigger: t("auto.node.trigger"),
      agent: t("auto.node.agent"),
      firm: t("auto.node.firm"),
      tool: t("auto.node.tool"),
      action: t("auto.node.action"),
      output: t("auto.node.output"),
      condition: t("auto.node.condition"),
      transform: t("auto.node.transform"),
      producesLabel: t("auto.flow.produces"),
      consumesLabel: t("auto.flow.consumes"),
    }),
    [t],
  );

  const load = useCallback(async () => {
    const api = ipc();
    setLoading(true);
    setError("");
    if (!api || !id) {
      setError(locale === "en" ? "Automation could not be opened. Nothing changed." : "자동화를 열 수 없습니다. 바뀐 내용은 없습니다.");
      setLoading(false);
      return;
    }
    try {
      const found = await api.automations.get(id);
      if (!found) {
        router.replace("/automation");
        return;
      }
      setAutomation(found);
    } catch {
      setError(locale === "en" ? "Automation could not be loaded. Nothing changed." : "자동화를 불러오지 못했습니다. 바뀐 내용은 없습니다.");
    } finally {
      setLoading(false);
    }
  }, [id, locale, router]);

  useEffect(() => {
    void load();
  }, [load]);

  const isSynthesized = !!automation && !automation.graph;

  // 저장 그래프 or 합성 그래프 → 필요 시 결정적 재배치. 편집 상태는 rfNodes/rfEdges가 소유하므로
  // 이 그래프는 "초기 시드"로만 쓴다(automation이 새로 로드될 때만 하이드레이트).
  const seedGraph: WorkflowGraph | null = useMemo(() => {
    if (!automation) return null;
    const g = automation.graph ?? synthesizeLegacyGraph(automation);
    if (needsLayout(g)) return { ...g, nodes: layoutGraph(g) };
    return g;
  }, [automation]);

  // automation 로드/변경 시 캔버스 시드.
  useEffect(() => {
    if (!seedGraph) return;
    seq.current = seedGraph.nodes.length;
    setRfNodes(
      seedGraph.nodes.map((n) => ({
        id: n.id,
        type: n.type,
        position: n.position ?? { x: 0, y: 0 },
        data: {
          label: n.label,
          config: n.config,
          strings: nodeStrings,
          connectable: editing,
          runState: runStatesRef.current[n.id],
        },
        draggable: editing,
        selectable: true,
      })),
    );
    setRfEdges(
      seedGraph.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle, // 네이티브 핸들 복원 — 저장 시 진실원본으로 다시 읽힌다
        label: e.sourceHandle,
        animated: false,
        style: { stroke: "var(--muted-deep)", strokeWidth: 1.4 },
        labelStyle: { fontFamily: "var(--font-mono)", fontSize: 10, fill: "var(--muted-deep)" },
        labelBgStyle: { fill: "var(--paper)" },
      })),
    );
    setDirty(false);
    // seedGraph만 의존(nodeStrings/editing 변화는 아래 별도 effect로 반영).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedGraph]);

  // editing/locale 토글 시 노드 data.connectable + draggable 갱신(그래프 구조는 유지).
  useEffect(() => {
    setRfNodes((nodes) =>
      nodes.map((n) => ({
        ...n,
        draggable: editing,
        data: { ...n.data, strings: nodeStrings, connectable: editing },
      })),
    );
  }, [editing, nodeStrings, setRfNodes]);

  // 라이브 실행 오버레이(설계 §5 P2) — 자동화별 라이브 채널을 구독해 per-node 상태를 받고,
  // 초기엔 latestRun 스냅샷으로 하이드레이트(새로고침 후에도 마지막 실행 상태 복원).
  useEffect(() => {
    if (!automation) return;
    const api = ipc();
    const events = ipcEvents();
    let cancelled = false;
    // 초기 하이드레이트.
    void api?.automations.latestRun(automation.id).then((snap) => {
      if (!cancelled && snap && snap.nodeStates) setRunStates(snap.nodeStates);
      if (!cancelled) setNodeFailures(snap?.nodeFailures ?? {});
    });
    if (!events) return;
    const channel = api?.automations.liveRunChannel(automation.id);
    if (!channel) return;
    const off = events.on(channel, (ev) => {
      if (ev.nodeId && ev.nodeState) {
        setRunStates((prev) => ({ ...prev, [ev.nodeId as string]: ev.nodeState as WorkflowNodeRunState }));
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [automation]);

  // runStates가 바뀔 때마다 노드 data.runState 주입(캔버스가 테두리/펄스로 애니메이션).
  useEffect(() => {
    setRfNodes((nodes) => nodes.map((n) => ({ ...n, data: { ...n.data, runState: runStates[n.id] } })));
  }, [runStates, setRfNodes]);

  // 실행 중 노드로 향하는 엣지를 애니메이션(러너가 흐르는 wire를 시각화).
  useEffect(() => {
    setRfEdges((edges) =>
      edges.map((e) => {
        const targetRunning = runStates[e.target] === "running";
        const sourceDone = runStates[e.source] === "done";
        const active = targetRunning || (sourceDone && runStates[e.target] === "running");
        return {
          ...e,
          animated: targetRunning,
          style: {
            ...e.style,
            stroke: active ? "var(--accent)" : "var(--muted-deep)",
            strokeWidth: active ? 2 : 1.4,
          },
        };
      }),
    );
  }, [runStates, setRfEdges]);

  const onNodesChange = useCallback(
    (changes: NodeChange<Node<WorkflowNodeData>>[]) => {
      onNodesChangeBase(changes);
      if (editing && changes.some((c) => c.type === "position" || c.type === "remove")) setDirty(true);
    },
    [onNodesChangeBase, editing],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      onEdgesChangeBase(changes);
      if (editing && changes.some((c) => c.type === "remove")) setDirty(true);
    },
    [onEdgesChangeBase, editing],
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!editing) return;
      setRfEdges((eds) =>
        addEdge(
          {
            ...conn,
            id: `e-${conn.source}-${conn.target}-${Date.now()}`,
            // condition 노드의 true/false 핸들에서 그으면 라벨도 동기화(표시용). 진실원본은
            // 네이티브 sourceHandle 필드(...conn에 포함)이며 저장 시 그걸 우선 읽는다.
            ...(conn.sourceHandle ? { label: conn.sourceHandle } : {}),
            style: { stroke: "var(--muted-deep)", strokeWidth: 1.4 },
          },
          eds,
        ),
      );
      setDirty(true);
    },
    [editing, setRfEdges],
  );

  // 편집 중 라이브 검증(설계 §5 P2 workflow-validate) — dangling/변수-매치 이슈를 표면화.
  const issues: WorkflowIssue[] = useMemo(() => {
    if (!editing) return [];
    const graph: WorkflowGraph = {
      version: 1,
      nodes: rfNodes.map((n) => ({
        id: n.id,
        type: (n.type as WorkflowNode["type"]) ?? "agent",
        position: n.position,
        config: n.data.config ?? {},
        label: n.data.label,
      })),
      edges: rfEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // 조건 분기는 React Flow 네이티브 sourceHandle 필드가 진실원본(새로 그린 엣지). 없으면
        // 라벨로 폴백(과거에 로드된 엣지). 둘 다 없으면 무조건 엣지.
        ...(e.sourceHandle
          ? { sourceHandle: e.sourceHandle }
          : typeof e.label === "string" && e.label
            ? { sourceHandle: e.label }
            : {}),
      })),
    };
    return validateWorkflow(graph);
  }, [editing, rfNodes, rfEdges]);
  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warnCount = issues.filter((i) => i.severity === "warning").length;

  const selectedNode: WorkflowNode | null = useMemo(() => {
    if (!selectedNodeId) return null;
    const rf = rfNodes.find((n) => n.id === selectedNodeId);
    if (!rf) return null;
    return {
      id: rf.id,
      type: (rf.type as WorkflowNode["type"]) ?? "agent",
      position: rf.position,
      config: rf.data.config,
      label: rf.data.label,
    };
  }, [selectedNodeId, rfNodes]);

  function addPaletteNode(seed: PaletteNodeSeed) {
    const nid = `n${seq.current++}-${Date.now()}`;
    // 결정적 배치: 기존 노드 오른쪽 끝 + 한 칸, y는 계단형으로 흩뿌려 겹침 방지.
    const maxX = rfNodes.reduce((m, n) => Math.max(m, n.position.x), 0);
    const y = 120 + (rfNodes.length % 3) * 90;
    setRfNodes((nodes) => [
      ...nodes,
      {
        id: nid,
        type: seed.type,
        position: { x: maxX + 280, y },
        data: { label: seed.label, config: seed.config, strings: nodeStrings, connectable: true },
        draggable: true,
        selectable: true,
      },
    ]);
    setSelectedNodeId(nid);
    setDirty(true);
  }

  function patchSelected(patch: Record<string, unknown>) {
    if (!selectedNodeId) return;
    setRfNodes((nodes) =>
      nodes.map((n) =>
        n.id === selectedNodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, ...patch } } } : n,
      ),
    );
    setDirty(true);
  }

  function labelSelected(label: string) {
    if (!selectedNodeId) return;
    setRfNodes((nodes) => nodes.map((n) => (n.id === selectedNodeId ? { ...n, data: { ...n.data, label } } : n)));
    setDirty(true);
  }

  function deleteSelected() {
    if (!selectedNodeId) return;
    setRfNodes((nodes) => nodes.filter((n) => n.id !== selectedNodeId));
    setRfEdges((eds) => eds.filter((e) => e.source !== selectedNodeId && e.target !== selectedNodeId));
    setSelectedNodeId(null);
    setDirty(true);
  }

  /** 현재 캔버스(rfNodes/rfEdges) → WorkflowGraph 직렬화. */
  function toGraph(): WorkflowGraph {
    return {
      version: 1,
      nodes: rfNodes.map((n) => ({
        id: n.id,
        type: (n.type as WorkflowNode["type"]) ?? "agent",
        position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
        config: n.data.config ?? {},
        label: n.data.label,
      })),
      edges: rfEdges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        // 조건 분기는 React Flow 네이티브 sourceHandle 필드가 진실원본(새로 그린 엣지). 없으면
        // 라벨로 폴백(과거에 로드된 엣지). 둘 다 없으면 무조건 엣지.
        ...(e.sourceHandle
          ? { sourceHandle: e.sourceHandle }
          : typeof e.label === "string" && e.label
            ? { sourceHandle: e.label }
            : {}),
      })),
    };
  }

  function autoLayoutCanvas() {
    const graph = toGraph();
    const laidOut = layoutGraph(graph);
    const positions = new Map(laidOut.map((n) => [n.id, n.position] as const));
    setRfNodes((nodes) =>
      nodes.map((n) => ({
        ...n,
        position: positions.get(n.id) ?? n.position,
      })),
    );
    setDirty(true);
  }

  async function save() {
    const api = ipc();
    if (!api || !automation) return;
    setSaving(true);
    setMessage("");
    try {
      const next = await api.automations.updateGraph(automation.id, toGraph());
      setAutomation(next);
      setDirty(false);
      setMessage(t("auto.flow.saved"));
    } catch {
      setMessage(t("auto.flow.save_failed"));
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    const api = ipc();
    if (!api || !automation) return;
    try {
      const next = await api.automations.toggle(automation.id, !automation.enabled);
      setAutomation((cur) => (cur ? { ...cur, enabled: next.enabled, nextRunAt: next.nextRunAt } : next));
    } catch {
      setMessage(locale === "en" ? "Status did not change." : "상태를 바꾸지 못했습니다.");
    }
  }

  async function requestGraphChange() {
    const api = ipc();
    if (!api || !automation) return;
    const sentence = architectDraft.trim();
    if (!sentence) return;
    setArchitectBusy(true);
    setProposal(null);
    setMessage(locale === "en" ? "Working out what would change..." : "무엇이 바뀔지 알아보는 중입니다...");
    try {
      const result = await api.automations.requestGraphPatch(automation.id, sentence);
      if (!result.ok) {
        // 실패는 사유와 다음 행동을 그대로 보여준다 — 코드만 남기지 않는다.
        setMessage(`${result.reason} ${result.nextAction}`);
        return;
      }
      setProposal(result);
      setMessage(locale === "en"
        ? "Nothing has changed yet. Review it and apply."
        : "아직 아무것도 바뀌지 않았습니다. 내용을 확인하고 적용하세요.");
    } catch {
      setMessage(locale === "en" ? "The change could not be worked out." : "변경 내용을 만들지 못했습니다.");
    } finally {
      setArchitectBusy(false);
    }
  }

  async function applyProposal() {
    const api = ipc();
    if (!api || !automation || !proposal) return;
    setArchitectBusy(true);
    try {
      const result = await api.automations.applyGraphPatch(automation.id, proposal.patch);
      if (!result.ok) {
        setMessage(`${result.reason ?? ""} ${result.nextAction ?? ""}`.trim() || (locale === "en" ? "Not applied." : "적용하지 못했습니다."));
        return;
      }
      setProposal(null);
      setArchitectDraft("");
      setMessage(locale === "en" ? "Applied." : "적용했습니다.");
      await load();
    } catch {
      setMessage(locale === "en" ? "Not applied." : "적용하지 못했습니다.");
    } finally {
      setArchitectBusy(false);
    }
  }

  async function decideApproval(nodeId: string, decision: "approved" | "rejected") {
    const api = ipc();
    if (!api || !automation) return;
    setApprovalBusy(true);
    try {
      const result = await api.automations.decideNodeApproval(automation.id, nodeId, decision);
      if (!result?.ok) {
        // 승인할 실행이 없으면 승인한 척하지 않는다.
        setMessage(locale === "en"
          ? "There is no run waiting on this step right now."
          : "지금 이 단계에서 기다리고 있는 실행이 없습니다.");
        return;
      }
      setNodeFailures((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
      if (decision === "approved") {
        setMessage(locale === "en"
          ? "Approved. Run it again to continue from this step."
          : "승인했습니다. 다시 실행하면 이 단계부터 이어집니다.");
      } else {
        setMessage(locale === "en"
          ? "Recorded. This step will not run until you approve it."
          : "기록했습니다. 승인하기 전까지 이 단계는 실행되지 않습니다.");
      }
    } catch {
      setMessage(locale === "en" ? "The decision was not saved." : "결정을 저장하지 못했습니다.");
    } finally {
      setApprovalBusy(false);
    }
  }

  async function runNow(dryRun = false) {
    const api = ipc();
    if (!api || !automation) return;
    setRunning(true);
    setMessage(
      dryRun
        ? (locale === "en"
          ? "Starting a simulation. Nothing will be sent outside."
          : "시뮬레이션을 시작합니다. 바깥으로 나가는 작업은 실행되지 않습니다.")
        : (locale === "en" ? "Starting background run..." : "백그라운드 실행을 시작하는 중입니다..."),
    );
    try {
      await api.automations.runNow(automation.id, dryRun ? { dryRun: true } : undefined);
      setMessage(
        dryRun
          ? (locale === "en"
            ? "Simulation started. Steps that change something outside are skipped and listed instead."
            : "시뮬레이션을 시작했습니다. 바깥을 바꾸는 단계는 실행하지 않고 목록으로 보여줍니다.")
          : (locale === "en" ? "Run started. Watch node status and history on the right." : "실행을 시작했습니다. 오른쪽에서 노드 상태와 기록을 확인하세요."),
      );
      const snap = await api.automations.latestRun(automation.id);
      if (snap?.nodeStates) setRunStates(snap.nodeStates);
      setNodeFailures(snap?.nodeFailures ?? {});
    } catch {
      setMessage(locale === "en" ? "Run did not start." : "실행을 시작하지 못했습니다.");
    } finally {
      setRunning(false);
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
    <div style={{ flex: 1, display: "flex", flexDirection: "column", background: "var(--paper-2)", minHeight: 0 }}>
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {automation.name}
          </h1>
          <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{automation.scheduleHuman}</div>
        </div>

        {editing ? (
          <>
            <button onClick={() => setPaletteOpen((v) => !v)} className="titlebar-nodrag" style={pillBtn(paletteOpen)}>
              {t("auto.flow.add_node")}
            </button>
            <button onClick={autoLayoutCanvas} className="titlebar-nodrag" style={pillBtn(false)}>
              {locale === "en" ? "Auto layout" : "자동 정렬"}
            </button>
            <button
              onClick={() => void save()}
              disabled={saving || !dirty || errorCount > 0}
              title={errorCount > 0 ? t("auto.validate.blocked") : undefined}
              className="titlebar-nodrag"
              style={{ ...actionBtn, opacity: saving || !dirty || errorCount > 0 ? 0.55 : 1 }}
            >
              {t("auto.flow.save")}
            </button>
            <button onClick={() => { setEditing(false); setPaletteOpen(false); void load(); }} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("common.cancel")}
            </button>
          </>
        ) : (
          <>
            <button onClick={() => router.push(`/automation/new?id=${encodeURIComponent(automation.id)}`)} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("auto.flow.edit_meta")}
            </button>
            <button onClick={() => setEditing(true)} className="titlebar-nodrag" style={pillBtn(false)}>
              {t("auto.flow.edit")}
            </button>
            <button
              onClick={() => void runNow(true)}
              disabled={running}
              className="titlebar-nodrag"
              style={pillBtn(false)}
              title={locale === "en"
                ? "Run without sending anything outside, then see what a real run would have done."
                : "바깥으로 아무것도 내보내지 않고 돌려본 뒤, 실전이었으면 무엇이 일어났을지 봅니다."}
            >
              {t("auto.flow.simulate")}
            </button>
            <button onClick={() => void runNow()} disabled={running} className="titlebar-nodrag" style={{ ...actionBtn, color: running ? "var(--muted-deep)" : "var(--ink)" }}>
              {running ? t("auto.flow.running") : t("auto.flow.run_now")}
            </button>
            <button onClick={() => void toggleEnabled()} className="titlebar-nodrag" style={pillBtn(automation.enabled)}>
              {automation.enabled ? t("auto.action.disable") : t("auto.action.enable")}
            </button>
          </>
        )}
      </header>

      {(message || (editing && dirty)) ? (
        <div
          className="titlebar-nodrag"
          style={{
            margin: "12px 32px 0",
            padding: "8px 12px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--accent-soft)",
            background: "var(--fill-1)",
            color: "var(--ink-soft)",
            fontSize: 12,
          }}
        >
          {message || t("auto.flow.unsaved")}
        </div>
      ) : null}

      {/* 자연어로 고치기 — 제안은 보여주기만 하고, 적용은 사람이 누른 뒤에만. */}
      {!editing ? (
        <div
          className="titlebar-nodrag"
          style={{ margin: "12px 32px 0", display: "grid", gap: 8 }}
        >
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={architectDraft}
              onChange={(e) => setArchitectDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void requestGraphChange();
                }
              }}
              placeholder={t("auto.flow.architect_placeholder")}
              disabled={architectBusy}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--paper-edge)",
                background: "var(--paper)",
                fontSize: 13,
                outline: "none",
              }}
            />
            <button
              className="titlebar-nodrag"
              disabled={architectBusy || !architectDraft.trim()}
              onClick={() => void requestGraphChange()}
              style={pillBtn(false)}
            >
              {t("auto.flow.architect_ask")}
            </button>
          </div>
          {proposal ? (
            <div
              data-testid="graph-patch-proposal"
              style={{
                padding: "12px 14px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--accent-soft)",
                background: "var(--paper)",
                fontSize: 12,
                display: "grid",
                gap: 8,
              }}
            >
              <div style={{ fontWeight: 600 }}>{t("auto.flow.architect_preview")}</div>
              {proposal.rationale ? (
                <div style={{ color: "var(--ink-soft)" }}>{proposal.rationale}</div>
              ) : null}
              {proposal.summary.added.length > 0 ? (
                <div>{t("auto.flow.architect_added")}: {proposal.summary.added.join(", ")}</div>
              ) : null}
              {proposal.summary.removed.length > 0 ? (
                <div>{t("auto.flow.architect_removed")}: {proposal.summary.removed.join(", ")}</div>
              ) : null}
              {proposal.summary.changed.length > 0 ? (
                <div>{t("auto.flow.architect_changed")}: {proposal.summary.changed.join(", ")}</div>
              ) : null}
              {proposal.risks.length > 0 ? (
                <div style={{ color: "var(--ink)" }}>
                  {t("auto.flow.architect_check")}: {proposal.risks.map((risk) => t(`auto.flow.risk_${risk}` as never)).join(", ")}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  className="titlebar-nodrag"
                  disabled={architectBusy}
                  onClick={() => void applyProposal()}
                  style={actionBtn}
                >
                  {t("auto.flow.architect_apply")}
                </button>
                <button
                  className="titlebar-nodrag"
                  disabled={architectBusy}
                  onClick={() => setProposal(null)}
                  style={pillBtn(false)}
                >
                  {t("auto.flow.architect_discard")}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* 멈춘 이유와 지금 누를 행동. 승인 대기는 버튼까지 함께 준다 —
          사유만 보여주고 무엇을 하라는 말이 없는 실패 표면은 결함이다. */}
      {Object.entries(nodeFailures).map(([failedNodeId, failure]) => {
        const nodeLabel = rfNodes.find((n) => n.id === failedNodeId)?.data?.label ?? failedNodeId;
        const awaitingApproval = failure.code === "APPROVAL_REQUIRED";
        return (
          <div
            key={failedNodeId}
            className="titlebar-nodrag"
            data-testid={`node-failure-${failedNodeId}`}
            style={{
              margin: "12px 32px 0",
              padding: "12px 14px",
              borderRadius: "var(--radius-md)",
              border: `1px solid ${awaitingApproval ? "var(--accent-soft)" : "var(--paper-edge)"}`,
              background: "var(--paper)",
              fontSize: 12,
              color: "var(--ink)",
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ fontWeight: 600 }}>{String(nodeLabel)}</div>
            <div style={{ color: "var(--ink-soft)", lineHeight: 1.6 }}>{failure.reason}</div>
            <div style={{ color: "var(--muted-deep)", lineHeight: 1.6 }}>{failure.nextAction}</div>
            {awaitingApproval ? (
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  className="titlebar-nodrag"
                  disabled={approvalBusy}
                  onClick={() => void decideApproval(failedNodeId, "approved")}
                  style={actionBtn}
                >
                  {t("auto.flow.approve_and_continue")}
                </button>
                <button
                  className="titlebar-nodrag"
                  disabled={approvalBusy}
                  onClick={() => void decideApproval(failedNodeId, "rejected")}
                  style={pillBtn(false)}
                >
                  {t("auto.flow.approve_reject")}
                </button>
              </div>
            ) : null}
            <div style={{ fontSize: 10, color: "var(--muted-deep)", fontFamily: "var(--font-mono)" }}>
              {failure.code}
            </div>
          </div>
        );
      })}

      {editing && issues.length > 0 ? (
        <div
          className="titlebar-nodrag"
          style={{
            margin: "12px 32px 0",
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            border: `1px solid ${errorCount > 0 ? "var(--danger, #d64545)" : "var(--accent-soft)"}`,
            background: "var(--paper)",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, color: errorCount > 0 ? "var(--danger, #d64545)" : "var(--ink)" }}>
            {errorCount > 0
              ? `${t("auto.validate.errors")}: ${errorCount}${warnCount > 0 ? ` · ${t("auto.validate.warnings")}: ${warnCount}` : ""}`
              : `${t("auto.validate.warnings")}: ${warnCount}`}
          </div>
          <ul style={{ margin: 0, paddingLeft: 16, display: "flex", flexDirection: "column", gap: 3, color: "var(--ink-soft)" }}>
            {issues.slice(0, 6).map((iss, i) => (
              <li key={i} style={{ color: iss.severity === "error" ? "var(--danger, #d64545)" : "var(--muted-deep)" }}>
                {iss.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="automation-flow-workspace">
        {leftOpen ? (
          <AutomationSessionPanel
            automationId={automation.id}
            locale={locale}
            toolMode={automation.toolMode}
            hubMode={automation.hubMode}
            executionPermission={automation.executionPermission}
            onCollapse={() => setLeftOpen(false)}
          />
        ) : (
          <button
            type="button"
            className="automation-panel-tab titlebar-nodrag"
            data-side="left"
            onClick={() => setLeftOpen(true)}
            aria-label={locale === "en" ? "Show session" : "세션 대화 펼치기"}
          >
            <span>⟩</span>
            <em>{locale === "en" ? "Session" : "세션 대화"}</em>
          </button>
        )}
        <div className="automation-flow-canvas">
          {isSynthesized && !editing ? (
            <div
              className="automation-flow-origin-note"
            >
              {t("auto.flow.synthesized")}
            </div>
          ) : null}
          <ReactFlow
            className="automation-flow-react"
            nodes={rfNodes}
            edges={rfEdges}
            nodeTypes={workflowNodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            fitView
            fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
            minZoom={0.3}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={editing}
            nodesConnectable={editing}
            elementsSelectable
            deleteKeyCode={editing ? ["Backspace", "Delete"] : null}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
          >
            <Background color="var(--paper-edge)" gap={24} size={1} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => NODE_ACCENT[n.type ?? "agent"] ?? "var(--muted-deep)"}
              style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)" }}
            />
          </ReactFlow>
        </div>

        {!rightOpen ? (
          <button
            type="button"
            className="automation-panel-tab titlebar-nodrag"
            data-side="right"
            onClick={() => setRightOpen(true)}
            aria-label={locale === "en" ? "Show details" : "상세 패널 펼치기"}
          >
            <span>⟨</span>
            <em>{locale === "en" ? "Details" : "상세"}</em>
          </button>
        ) : (
        <aside className="automation-inspector-column">
          <div className="automation-inspector-bar">
            <span>{locale === "en" ? "Details" : "상세"}</span>
            <button
              type="button"
              onClick={() => setRightOpen(false)}
              aria-label={locale === "en" ? "Collapse details" : "상세 패널 접기"}
              title={locale === "en" ? "Collapse details" : "상세 패널 접기"}
            >
              ⟩
            </button>
          </div>
          {editing && paletteOpen ? (
            <NodePalette onAdd={addPaletteNode} onClose={() => setPaletteOpen(false)} />
          ) : editing && selectedNode ? (
            <NodeConfigPanel node={selectedNode} onPatch={patchSelected} onLabel={labelSelected} onDelete={deleteSelected} onClose={() => setSelectedNodeId(null)} timezone={automation?.timezone ?? null} />
          ) : selectedNode ? (
            <NodeInspector node={selectedNode} onClose={() => setSelectedNodeId(null)} t={t} />
          ) : (
            <div className="automation-node-empty" data-one-content-slot />
          )}
          <RunHistoryPanel automation={automation} locale={locale} compact />
        </aside>
        )}
      </div>
    </div>
  );
}

type TFn = ReturnType<typeof useT>["t"];

function NodeInspector({ node, onClose, t }: { node: WorkflowNode; onClose: () => void; t: TFn }) {
  const entries = Object.entries(node.config ?? {});
  return (
    <aside
      className="titlebar-nodrag"
      style={{
        width: 300,
        flexShrink: 0,
        borderLeft: "var(--hairline)",
        background: "var(--paper)",
        overflowY: "auto",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: NODE_ACCENT[node.type] ?? "var(--muted-deep)",
            flex: 1,
          }}
        >
          {node.type}
        </span>
        <button onClick={onClose} aria-label={t("common.close")} style={{ color: "var(--muted-deep)", padding: 2 }}>
          ×
        </button>
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)", marginBottom: 16 }}>{node.label || node.type}</div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("auto.flow.no_config")}</div>
      ) : (
        <dl style={{ margin: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt
                style={{
                  fontSize: 10,
                  fontFamily: "var(--font-mono)",
                  textTransform: "uppercase",
                  letterSpacing: 0.6,
                  color: "var(--muted-deep)",
                  marginBottom: 4,
                }}
              >
                {key}
              </dt>
              <dd style={{ margin: 0 }}>
                <pre
                  style={{
                    whiteSpace: "pre-wrap",
                    overflowWrap: "anywhere",
                    fontFamily: typeof value === "string" ? "var(--font-body)" : "var(--font-mono)",
                    fontSize: 12,
                    background: "var(--paper-2)",
                    border: "1px solid var(--paper-edge)",
                    borderRadius: "var(--radius-sm)",
                    padding: 8,
                    margin: 0,
                    color: "var(--ink)",
                  }}
                >
                  {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
                </pre>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </aside>
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

const actionBtn: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: "var(--radius-md)",
  fontSize: 12.5,
  fontWeight: 600,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  boxShadow: "var(--neu-raised)",
  cursor: "pointer",
};

function pillBtn(active: boolean): React.CSSProperties {
  return {
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 600,
    border: "1px solid var(--paper-edge)",
    background: active ? "var(--fill-1)" : "var(--paper-2)",
    color: active ? "var(--accent)" : "var(--muted-deep)",
    cursor: "pointer",
  };
}
