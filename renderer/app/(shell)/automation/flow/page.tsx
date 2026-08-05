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
import { layoutGraph, needsLayout } from "@shared/graph-layout";
import { validateWorkflow, type WorkflowIssue } from "@/lib/workflow-validate";
import { workflowNodeTypes, type NodeStrings, type WorkflowNodeData } from "@/components/automation/nodes";
import { NODE_ACCENT } from "@/components/automation/nodes/nodeShared";
import { NodePalette, type PaletteNodeSeed } from "@/components/automation/NodePalette";
import { NodeConfigPanel } from "@/components/automation/NodeConfigPanel";
import { RunHistoryPanel } from "@/components/automation/RunHistoryPanel";
import { AutomationSessionPanel } from "@/components/automation/AutomationSessionPanel";
import { IconBolt } from "@/components/Icon";
import { ConnectionsDialog } from "@/components/automation/ConnectionsDialog";

/** 좌/우 패널 접힘 상태 — 화면을 다시 열어도 사용자가 정한 레이아웃을 유지한다. */
const PANEL_STATE_KEY = "agentlas.automation.flow.panels";

/**
 * 캔버스를 맞추는 규칙 — **한 벌만 둔다.**
 * 세 곳(마운트·패널 토글·노드 추가)이 각자 옵션을 들고 있어, 마운트에서 하한을 걸어도
 * 뒤이은 호출이 하한 없이 덮어써 노드가 글자를 못 읽을 배율까지 줄어들었다(실사용 실측).
 * minZoom: 넓은 그래프는 다 보여주려 하지 말고, 읽을 수 있는 크기를 지키고 밀어서 본다.
 */
const FIT_VIEW = { padding: 0.16, maxZoom: 1, minZoom: 0.62 } as const;

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
  /** 시작 값을 받아야 하는 그래프에서 사람에게 값을 묻는 상태. */
  const [inputPrompt, setInputPrompt] = useState<{ label: string; value: string } | null>(null);
  /** 이 그래프가 쓰는 것들을 한 창에서 정리한다(공급자 묶음별). */
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  /** 켤 수 있는 상태인가. 버튼 이름이 이걸 그대로 말한다. */
  const [blockedByConnections, setBlockedByConnections] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // ★되돌아가는 연결(반복)의 상한은 **엣지에** 붙는다. 그런데 엣지를 고를 방법이 없어서,
  //   커널이 "되돌아가는 연결을 눌러 반복 횟수를 정하세요"라고 안내하는데 누를 것이 없었다.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // 좌(세션 대화)·우(노드 검사 + 실행 기록) 패널 접기. 캔버스가 좁은 화면에서 가장 먼저
  // 희생되던 문제를 사용자가 직접 해소할 수 있게 한다. 선택은 로컬에 남는다.
  // 세션 대화는 접힌 채로 시작한다. 1440px 창에서 좌 300 + 우 320을 늘 펴 두면
  // 이 화면의 주인공인 캔버스가 절반도 못 갖고, 그래프가 축소돼 노드 글자가 작아진다.
  // 대화는 할 말이 생겼을 때 여는 것이고, 접기 탭은 그대로 보인다.
  // 사용자가 한 번이라도 편 뒤에는 그 선택이 저장돼 유지된다.
  const [leftOpen, setLeftOpen] = useState(false);
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
  // 팔레트로 노드를 추가한 직후 한 번만 fitView — 커밋·측정이 끝난 뒤에 돈다.
  const pendingFitRef = useRef(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      try {
        fitView({ ...FIT_VIEW });
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
  /** 노드가 지금 무엇을 하는 중인가 — 실패가 아닌 상태 변화(C44). */
  const [nodeProgress, setNodeProgress] = useState<Record<string, string>>({});
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
  // 하단 검증 로그 패널(항목 6) — VS Code 터미널처럼 크기를 끌어서 조절한다.
  // ★기본은 접힘(카운트 줄만). 편집 중 문제가 생길 때마다 패널이 펴지며 캔버스를
  //   밀면, 드래그하던 좌표가 어긋난다(게이트 실측) — 펴는 것은 사람이 한다.
  const [logOpen, setLogOpen] = useState(false);
  const [logHeight, setLogHeight] = useState(150);
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
      eval: t("auto.node.eval"),
      subgraph: t("auto.node.subgraph"),
      code: t("auto.node.code"),
      subgraphUnset: t("auto.node.subgraphUnset"),
      producesLabel: t("auto.flow.produces"),
      consumesLabel: t("auto.flow.consumes"),
      failExit: locale === "en" ? "on failure" : "실패",
      failExitHint: locale === "en"
        ? "Taken only when this step fails — wire it to a step that handles the failure."
        : "이 단계가 실패했을 때만 가는 길입니다 — 실패를 처리할 단계로 이어 주세요.",
      cleanupExit: locale === "en" ? "cleanup" : "정리",
      cleanupExitHint: locale === "en"
        ? "Runs once at the end whether the step succeeded or failed — for tidying up."
        : "성공하든 실패하든 마지막에 한 번 도는 뒷정리 길입니다.",
    }),
    [t, locale],
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
      // 켜기가 막혀 있으면 버튼 이름이 그렇게 말해야 한다.
      // Zapier가 발행 버튼 라벨 자체를 상태로 바꾼다(Publish / Fix to Publish /
      // Update to Publish) — 눌러 보고 나서야 아는 것보다 낫다.
      void api.automations.connectionReport(id)
        .then((report) => setBlockedByConnections(report?.activation.canActivate === false))
        .catch(() => setBlockedByConnections(false));
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
        // ★되돌아가는 반복의 상한은 **엣지에** 붙어 있다. 여기서 안 들고 오면 저장할 때
        //   같이 사라지고, 잘 돌던 그래프가 그때부터 LOOP_BOUND_UNDECLARED로 거절된다
        //   (실측: 자연어로 만든 반복 그래프를 캔버스에서 열었다 저장하기만 해도 죽었다).
        data: typeof e.maxIterations === "number" ? { maxIterations: e.maxIterations } : undefined,
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
        data: {
          ...n.data,
          strings: nodeStrings,
          connectable: editing,
          // 노드 좌상단 AI 주석 CTA(항목 5) — 편집 모드에서만 살아 있다.
          onAiNote: editing
            ? () => setAiNote({
              nodeId: n.id,
              label: String((n.data as WorkflowNodeData).label ?? n.id),
              text: String(((n.data as WorkflowNodeData).config as { note?: unknown })?.note ?? ""),
            })
            : undefined,
        },
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
      // ★실패가 아닌 **상태 변화**를 받는다(커넥터 C44). 예전에는 nodeState만 건너와서,
      //   긴 노드가 도는 동안 화면이 "실행 중"에 멈춰 있었다 — 사람은 그걸 "멈췄다"로 읽는다.
      if (!ev.nodeId) return;
      const progress = ev.kind === "tool-use"
        ? (ev.tool?.name ?? ev.status ?? "")
        : ev.kind === "thinking"
          ? (ev.status ?? "")
          : ev.kind === "reasoning" && ev.reasoning?.phase === "start"
            ? "생각하는 중"
            : "";
      if (progress) {
        setNodeProgress((prev) => ({ ...prev, [ev.nodeId as string]: progress.slice(0, 60) }));
      }
      // 노드가 끝나면 그 노드의 진행 문구는 지운다 — 끝난 단계에 옛 문구가 남으면
      // 아직 그걸 하고 있는 것처럼 보인다.
      if (ev.nodeState && ev.nodeState !== "running") {
        setNodeProgress((prev) => {
          const next = { ...prev };
          delete next[ev.nodeId as string];
          return next;
        });
      }
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [automation]);

  // runStates가 바뀔 때마다 노드 data.runState 주입(캔버스가 테두리/펄스로 애니메이션).
  useEffect(() => {
    setRfNodes((nodes) => nodes.map((n) => ({
      ...n,
      data: { ...n.data, runState: runStates[n.id], progress: nodeProgress[n.id] },
    })));
  }, [runStates, nodeProgress, setRfNodes]);

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
      // ★실행 총계 상한(budget)은 캔버스가 만들지도 지우지도 않는다 — 그대로 들고 간다.
      //   엣지의 반복 상한과 같은 병인데 이쪽이 더 조용하다: 상한이 사라지면 실행이 거절되는
      //   게 아니라 **그냥 상한 없이 잘 돈다.** 아무도 알아채지 못한다.
      ...(seedGraph?.budget ? { budget: seedGraph.budget } : {}),
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
        // ★상한은 캔버스가 만들지도 지우지도 않는다 — 있으면 그대로 되돌려 놓는다.
        ...(typeof (e.data as { maxIterations?: unknown } | undefined)?.maxIterations === "number"
          ? { maxIterations: (e.data as { maxIterations: number }).maxIterations }
          : {}),
      })),
    };
    return validateWorkflow(graph, locale);
  }, [editing, rfNodes, rfEdges, locale]);
  useEffect(() => {
    if (!pendingFitRef.current) return;
    pendingFitRef.current = false;
    // 측정이 끝난 다음 프레임에 — 안 그러면 새 노드 크기를 모른 채 계산한다.
    const id = window.setTimeout(() => fitView({ ...FIT_VIEW, duration: 150 }), 30);
    return () => window.clearTimeout(id);
  }, [rfNodes.length, fitView]);

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

  /**
   * 되돌아가는 연결인가 — 트리거에서 오는 순서상 **뒤에서 앞으로** 가는 연결이다.
   * 커널이 반복으로 읽는 것과 같은 모양이고, 이것만 상한을 요구한다.
   */
  const backEdgeIds = useMemo(() => {
    // ★DFS 색칠 — 커널 findBackEdges·검증기와 같은 방식. 전위 번호 비교 휴리스틱은
    //   사이클 없는 다이아몬드를 반복으로 오인해, 반복도 아닌 연결에 상한을 물어본다.
    const adjacency = new Map<string, { to: string; edgeId: string }[]>();
    for (const e of rfEdges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      adjacency.get(e.source)!.push({ to: e.target, edgeId: e.id });
    }
    const color = new Map<string, "gray" | "black">();
    const back = new Set<string>();
    const visit = (id: string): void => {
      color.set(id, "gray");
      for (const out of adjacency.get(id) ?? []) {
        const c = color.get(out.to);
        if (c === "gray") back.add(out.edgeId);
        else if (c === undefined) visit(out.to);
      }
      color.set(id, "black");
    };
    // ★커널 findBackEdges와 **같은 시작점 규칙**: 들어오는 연결이 없는 노드부터 돈다.
    //   DFS 색칠에서 어느 엣지가 되돌아가는 연결이 되는지는 시작점에 달려 있다.
    //   순서가 다르면 화면은 A→B에 상한을 물어보고 커널은 B→A를 요구해, 저장은 통과하는데
    //   실행만 거절되고 상한을 넣을 자리는 없는 상태로 되돌아간다.
    const hasIncoming = new Set(rfEdges.map((e) => e.target));
    for (const n of rfNodes) if (!hasIncoming.has(n.id) && !color.has(n.id)) visit(n.id);
    for (const n of rfNodes) if (!color.has(n.id)) visit(n.id);
    return back;
  }, [rfEdges, rfNodes]);

  const selectedEdge = useMemo(
    () => (selectedEdgeId ? rfEdges.find((e) => e.id === selectedEdgeId) ?? null : null),
    [selectedEdgeId, rfEdges],
  );

  const setLoopBound = useCallback((value: number | null) => {
    if (!selectedEdgeId) return;
    setRfEdges((eds) => eds.map((e) => (e.id === selectedEdgeId
      ? { ...e, data: value == null ? undefined : { ...(e.data ?? {}), maxIterations: value } }
      : e)));
    setDirty(true);
  }, [selectedEdgeId]);

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
    // ★새 노드가 화면 밖(오른쪽 패널 아래)에 떨어지면 사람은 "안 생겼다"로 읽고,
    //   이어 그리려던 선은 패널에 먹힌다(게이트 실측). 놓자마자 보이게 당겨 온다.
    //   rAF는 React 커밋보다 먼저 돌 수 있어 — 노드 수 변화를 보는 효과가 맞춘다.
    pendingFitRef.current = true;
    setSelectedNodeId(nid);
    // ★놓았으면 팔레트를 닫는다. 팔레트와 설정 패널이 **같은 자리**를 쓰기 때문에,
    //   열어둔 채로 두면 방금 놓은 노드는 물론 다른 어느 노드를 눌러도 설정이 안 열린다
    //   — 사람은 "추가 → 방금 것 설정" 순서로 일하므로 편집이 그 자리에서 막힌다(실측).
    setPaletteOpen(false);
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
      // ★실행 총계 상한(budget)은 캔버스가 만들지도 지우지도 않는다 — 그대로 들고 간다.
      //   엣지의 반복 상한과 같은 병인데 이쪽이 더 조용하다: 상한이 사라지면 실행이 거절되는
      //   게 아니라 **그냥 상한 없이 잘 돈다.** 아무도 알아채지 못한다.
      ...(seedGraph?.budget ? { budget: seedGraph.budget } : {}),
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
        // ★상한은 캔버스가 만들지도 지우지도 않는다 — 있으면 그대로 되돌려 놓는다.
        ...(typeof (e.data as { maxIterations?: unknown } | undefined)?.maxIterations === "number"
          ? { maxIterations: (e.data as { maxIterations: number }).maxIterations }
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
    } catch (error) {
      // 켜기 게이트가 막았으면 **그 사유를 그대로** 보여주고 연결 창을 연다.
      // "상태를 바꾸지 못했습니다"만 남기면 사용자는 왜인지 영영 모른다(실사용 실측의 반복).
      const raw = error instanceof Error ? error.message : String(error ?? "");
      const notConnected = raw.includes("AUTOMATION_NOT_CONNECTED") || raw.includes("연결되지 않은");
      if (notConnected) {
        setMessage(raw.replace(/^Error:\s*/, "").replace(/^.*AUTOMATION_NOT_CONNECTED[^:]*:\s*/, ""));
        setConnectionsOpen(true);
        return;
      }
      setMessage(locale === "en" ? "Status did not change." : "상태를 바꾸지 못했습니다.");
    }
  }

  // ── 노드 AI 주석(항목 5) — 노드에서 바로 "이 단계만" 고쳐 달라고 말한다 ────
  const [aiNote, setAiNote] = useState<{ nodeId: string; label: string; text: string } | null>(null);

  /** 주석만 저장 — 노드 config.note에 남는다(AI가 다음에 이 단계를 지을 때 읽는 메모). */
  function saveAiNote() {
    if (!aiNote) return;
    setRfNodes((nodes) => nodes.map((n) => n.id === aiNote.nodeId
      ? { ...n, data: { ...n.data, config: { ...(n.data as WorkflowNodeData).config, note: aiNote.text } } }
      : n));
    setDirty(true);
    setAiNote(null);
  }

  /** 주석을 그 노드 한정 지시로 만들어 architect에 바로 보낸다 — 제안·승인 흐름은 기존과 동일. */
  async function aiSetNode() {
    if (!aiNote?.text.trim()) return;
    const scoped = locale === "en"
      ? `Change ONLY the step "${aiNote.label}" (node id ${aiNote.nodeId}). Do not touch other steps. Instruction: ${aiNote.text.trim()}`
      : `"${aiNote.label}" 단계(노드 id ${aiNote.nodeId})만 바꿔 주세요. 다른 단계는 건드리지 마세요. 지시: ${aiNote.text.trim()}`;
    setAiNote(null);
    setArchitectDraft(scoped);
    const api = ipc();
    if (!api || !automation) return;
    setArchitectBusy(true);
    setProposal(null);
    setMessage(locale === "en" ? "Working out what would change..." : "무엇이 바뀔지 알아보는 중입니다...");
    try {
      const result = await api.automations.requestGraphPatch(automation.id, scoped);
      if (!result.ok) { setMessage(`${result.reason} ${result.nextAction}`); return; }
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

  async function decideApproval(nodeId: string, decision: "approved" | "rejected" | "always") {
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
      if (decision === "always") {
        setMessage(locale === "en"
          ? "Always allowed. This step will not ask again."
          : "항상 허용했습니다. 이 단계는 다시 묻지 않습니다.");
      } else if (decision === "approved") {
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

  async function runNow(dryRun = false, inputValue?: string) {
    const api = ipc();
    if (!api || !automation) return;
    // 시작 값을 받아야 하는 그래프는 값을 받고 나서 실행한다. 예전에는 그냥 시작해서
    // 빈 값으로 돌았고, 사용자는 결과를 열어보고서야 값이 빠진 걸 알았다.
    if (!dryRun && inputValue === undefined) {
      const requirement = await api.automations.inputRequirement(automation.id).catch(() => null);
      if (requirement?.required) {
        setInputPrompt({ label: requirement.label, value: "" });
        setMessage("");
        return;
      }
    }
    setRunning(true);
    setMessage(
      dryRun
        ? (locale === "en"
          ? "Starting a simulation. Nothing will be sent outside."
          : "시뮬레이션을 시작합니다. 바깥으로 나가는 작업은 실행되지 않습니다.")
        : (locale === "en" ? "Starting background run..." : "백그라운드 실행을 시작하는 중입니다..."),
    );
    try {
      const requirement = inputValue !== undefined
        ? await api.automations.inputRequirement(automation.id).catch(() => null)
        : null;
      await api.automations.runNow(
        automation.id,
        dryRun
          ? { dryRun: true }
          : (requirement?.required && inputValue !== undefined
            ? { input: { [requirement.varName]: inputValue } }
            : undefined),
      );
      setInputPrompt(null);
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
            {/* 연결이 빠져 있으면 나머지가 다 무의미하다 — 시뮬레이션·실행보다 앞에 둔다. */}
            <button
              data-testid="open-connections"
              onClick={() => setConnectionsOpen(true)}
              className="titlebar-nodrag"
              style={pillBtn(false)}
              title={locale === "en"
                ? "See what this automation uses, and connect it — one account opens every tool on it."
                : "이 자동화가 쓰는 것을 보고 연결합니다. 계정 하나로 그 계정의 도구가 함께 열립니다."}
            >
              {locale === "en" ? "Connections" : "연결"}
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
            <button
              data-testid="toggle-enabled"
              onClick={() => void toggleEnabled()}
              className="titlebar-nodrag"
              style={pillBtn(automation.enabled)}
              title={!automation.enabled && blockedByConnections
                ? (locale === "en" ? "Connect what it uses first." : "쓰는 것을 먼저 연결해야 켜집니다.")
                : undefined}
            >
              {automation.enabled
                ? t("auto.action.disable")
                : blockedByConnections
                  ? (locale === "en" ? "Connect to turn on" : "연결해야 켜집니다")
                  : t("auto.action.enable")}
            </button>
          </>
        )}
      </header>

      {/* 알림·제안·결정 카드는 캔버스 **위에 뜬다**. 예전에는 캔버스 위쪽에 차곡차곡 쌓여서,
          카드가 하나 늘 때마다 그래프가 아래로 밀리고 좁아졌다 — 화면의 주인공이
          부수 메시지에 밀려 가장 작은 영역을 갖는 상태였다. */}
      {connectionsOpen ? (
        <ConnectionsDialog
          automationId={automation.id}
          locale={locale}
          onClose={() => setConnectionsOpen(false)}
        />
      ) : null}

      <div className="automation-flow-overlay-anchor">
      <div className="automation-flow-overlay">

      {(message || (editing && dirty)) ? (
        <div
          className="titlebar-nodrag"
          style={{
            order: 5,
            padding: "8px 12px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--accent-soft)",
            // 캔버스 위에 떠 있는 카드라 반투명이면 아래 글자가 비쳐 읽히지 않는다.
            background: "var(--paper)",
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
          style={{ display: "grid", gap: 8, order: 4 }}
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

      {/* 시작 값을 받아야 하는 그래프. 값을 받고 나서 실행한다 —
          묻지 않고 시작하면 빈 값으로 도는 것을 사용자가 결과에서야 알게 된다. */}
      {inputPrompt ? (
        <div
          data-testid="graph-input-prompt"
          style={{
            order: 1,
            padding: "12px 14px", borderRadius: 12,
            border: "1px solid var(--line)", background: "var(--paper)",
            display: "flex", flexDirection: "column", gap: 8,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{inputPrompt.label}</div>
          <input
            data-testid="graph-input-value"
            autoFocus
            value={inputPrompt.value}
            placeholder={locale === "en" ? "Type the value this run starts from" : "이번 실행이 시작할 값을 입력하세요"}
            onChange={(e) => setInputPrompt({ ...inputPrompt, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && inputPrompt.value.trim()) void runNow(false, inputPrompt.value.trim());
              if (e.key === "Escape") setInputPrompt(null);
            }}
            className="titlebar-nodrag"
            style={{
              padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)",
              background: "var(--paper-2)", color: "var(--ink)", fontSize: 13, outline: "none",
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button
              data-testid="graph-input-start"
              className="titlebar-nodrag"
              disabled={running || !inputPrompt.value.trim()}
              onClick={() => void runNow(false, inputPrompt.value.trim())}
              style={{ ...actionBtn, opacity: inputPrompt.value.trim() ? 1 : 0.5 }}
            >
              {locale === "en" ? "Start with this" : "이 값으로 실행"}
            </button>
            <button className="titlebar-nodrag" onClick={() => setInputPrompt(null)} style={pillBtn(false)}>
              {locale === "en" ? "Cancel" : "취소"}
            </button>
          </div>
        </div>
      ) : null}

      {/* 멈춘 이유와 지금 누를 행동. 승인 대기는 버튼까지 함께 준다 —
          사유만 보여주고 무엇을 하라는 말이 없는 실패 표면은 결함이다. */}
      {Object.entries(nodeFailures).map(([failedNodeId, failure]) => {
        const nodeLabel = rfNodes.find((n) => n.id === failedNodeId)?.data?.label ?? failedNodeId;
        const awaitingApproval = failure.code === "APPROVAL_REQUIRED";
        const evalStuck = failure.code === "EVAL_STUCK";
        return (
          <div
            key={failedNodeId}
            className="titlebar-nodrag"
            data-testid={`node-failure-${failedNodeId}`}
            style={{
              order: 2,
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
                {/* ★한 번 믿기로 한 단계는 매번 묻지 않는다. 이 결정은 그래프가 아니라
                    승인 기록에 남는다 — 그래프를 바꾸면 digest가 달라져 지금 멈춰 있는
                    바로 그 실행의 재개가 거부되기 때문이다. */}
                <button
                  className="titlebar-nodrag"
                  disabled={approvalBusy}
                  onClick={() => void decideApproval(failedNodeId, "always")}
                  style={pillBtn(false)}
                  title={t("auto.flow.approve_always_hint")}
                >
                  {t("auto.flow.approve_always")}
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
            {/* ★"기준이 틀렸을 수도"의 두 갈래: 채점표를 고치거나(캔버스에서),
                판정이 틀렸다고 교정한다. 교정은 그 노드의 이후 판정에 few-shot으로
                주입된다 — 사람의 채점 감각이 그래프에 쌓이는 자리(5건이면 유의미). */}
            {evalStuck ? (
              <div style={{ display: "flex", gap: 8, marginTop: 2 }}>
                <button
                  className="titlebar-nodrag"
                  onClick={() => {
                    void (async () => {
                      const api = ipc();
                      if (!api || !automation) return;
                      await api.automations.recordEvalCorrection(automation.id, failedNodeId, "pass");
                      setMessage(locale === "en"
                        ? "Recorded. Future judgments on this step will learn from this ruling."
                        : "기록했습니다. 이 단계의 다음 판정부터 이 교정을 배웁니다.");
                    })();
                  }}
                  style={pillBtn(false)}
                >
                  {t("auto.flow.eval_correct_pass")}
                </button>
              </div>
            ) : null}
            {/* 기계 코드는 사용자가 읽을 문장이 아니다. 지원에 붙여 넣을 때만 필요하므로
                기본은 접어 두고, 사유·행동이 카드의 주인공이 되게 한다. */}
            <details style={{ marginTop: 2 }}>
              <summary
                className="titlebar-nodrag"
                style={{ fontSize: 11, color: "var(--muted-deep)", cursor: "pointer", listStyle: "none" }}
              >
                {locale === "en" ? "Technical detail" : "기술 정보"}
              </summary>
              <div style={{ fontSize: 10, color: "var(--muted-deep)", fontFamily: "var(--font-mono)", marginTop: 4 }}>
                {failure.code}
              </div>
            </details>
          </div>
        );
      })}

      </div>
      </div>

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
            fitViewOptions={FIT_VIEW}
            minZoom={0.3}
            maxZoom={1.6}
            proOptions={{ hideAttribution: true }}
            nodesDraggable={editing}
            nodesConnectable={editing}
            elementsSelectable
            deleteKeyCode={editing ? ["Backspace", "Delete"] : null}
            onNodeClick={(_, node) => { setSelectedNodeId(node.id); setSelectedEdgeId(null); }}
            onEdgeClick={(_, e) => { setSelectedEdgeId(e.id); setSelectedNodeId(null); }}
            onPaneClick={() => { setSelectedNodeId(null); setSelectedEdgeId(null); }}
          >
            <Background color="var(--paper-edge)" gap={24} size={1} />
            <Controls showInteractive={false} />
            {/* 미니맵 삭제(실측 항목 6) — 자리만 차지하고 캔버스 우하단을 가렸다.
                검증 결과는 아래 로그 패널이 담당한다. */}
          </ReactFlow>
          {aiNote ? (
            <div className="automation-ai-note-pop titlebar-nodrag" role="dialog" aria-label="AI note">
              <div className="automation-ai-note-title">
                {locale === "en" ? `Tell AI about “${aiNote.label}”` : `“${aiNote.label}” 단계에 메모`}
              </div>
              <textarea
                autoFocus
                value={aiNote.text}
                onChange={(e) => setAiNote({ ...aiNote, text: e.target.value })}
                placeholder={locale === "en"
                  ? "e.g. keep it under 200 characters, always include a source link"
                  : "예: 200자 이내로, 출처 링크는 꼭 포함"}
              />
              <div className="automation-ai-note-actions">
                <button type="button" onClick={() => setAiNote(null)}>{locale === "en" ? "Close" : "닫기"}</button>
                <button type="button" onClick={saveAiNote} disabled={!aiNote.text.trim()}>
                  {locale === "en" ? "Save note" : "주석 저장"}
                </button>
                <button type="button" data-primary onClick={() => void aiSetNode()} disabled={!aiNote.text.trim() || architectBusy}>
                  {locale === "en" ? "Have AI set this step" : "AI로 바로 세팅"}
                </button>
              </div>
              <p>
                {locale === "en"
                  ? "Save keeps the note on the step for the AI to read. “Have AI set this step” proposes a change to this step only — nothing applies until you approve it."
                  : "주석 저장은 이 단계에 메모로 남습니다(AI가 읽는 메모). “AI로 바로 세팅”은 이 단계만 고치는 제안을 만들고, 승인 전에는 아무것도 바뀌지 않습니다."}
              </p>
            </div>
          ) : null}
          {/* ★검증 로그 패널 — 에러·경고를 상단 팝업이 아니라 VS Code 하단 패널처럼.
              위 팝업은 캔버스를 밀어내고, 읽기 전에 사라지고, 줄이 많으면 잘렸다. */}
          {editing && issues.length > 0 ? (
            <div className="automation-issue-log titlebar-nodrag" style={{ height: logOpen ? logHeight : 30 }}>
              <div
                className="automation-issue-log-grip"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = logHeight;
                  const move = (ev: MouseEvent) => {
                    setLogHeight(Math.min(420, Math.max(64, startH + (startY - ev.clientY))));
                    setLogOpen(true);
                  };
                  const up = () => {
                    window.removeEventListener("mousemove", move);
                    window.removeEventListener("mouseup", up);
                  };
                  window.addEventListener("mousemove", move);
                  window.addEventListener("mouseup", up);
                }}
              />
              <button type="button" className="automation-issue-log-head" onClick={() => setLogOpen((v) => !v)}>
                <span data-kind="error" style={{ visibility: errorCount > 0 ? "visible" : "hidden" }}>
                  {t("auto.validate.errors")} {errorCount}
                </span>
                <span data-kind="warning" style={{ visibility: warnCount > 0 ? "visible" : "hidden" }}>
                  {t("auto.validate.warnings")} {warnCount}
                </span>
                <em>{logOpen ? "▾" : "▴"}</em>
              </button>
              {logOpen ? (
                <ul className="automation-issue-log-list">
                  {issues.map((iss, i) => (
                    <li key={i} data-severity={iss.severity}>
                      {/* 줄을 누르면 그 노드가 선택된다 — 어디 문제인지 찾아 헤매지 않게. */}
                      <button
                        type="button"
                        onClick={() => { if (iss.nodeId) { setSelectedNodeId(iss.nodeId); setSelectedEdgeId(null); } }}
                      >
                        <b>{iss.severity === "error" ? (locale === "en" ? "ERROR" : "오류") : (locale === "en" ? "WARN" : "경고")}</b>
                        {iss.message}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
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
          ) : editing && selectedEdge ? (
            <LoopBoundPanel
              isBackEdge={backEdgeIds.has(selectedEdge.id)}
              value={(selectedEdge.data as { maxIterations?: number } | undefined)?.maxIterations ?? null}
              onChange={setLoopBound}
              onClose={() => setSelectedEdgeId(null)}
            />
          ) : editing && selectedNode ? (
            <NodeConfigPanel node={selectedNode} onPatch={patchSelected} onLabel={labelSelected} onDelete={deleteSelected} onClose={() => setSelectedNodeId(null)} timezone={automation?.timezone ?? null} automationId={automation?.id} />
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

/**
 * 되돌아가는 연결의 반복 상한을 정하는 자리.
 *
 * ★이게 없어서 생기던 일: 캔버스에서 반복(뒤로 가는 연결)을 그리면 저장은 되는데
 *   실행만 `LOOP_BOUND_UNDECLARED`로 거절됐고, 그 사유가 안내하는 "되돌아가는 연결을 눌러
 *   반복 횟수를 정하세요"는 존재하지 않는 화면을 가리켰다. 상한을 넣을 방법이 아예 없어서
 *   사람은 그 그래프를 영영 못 돌렸다.
 * 상한을 요구하는 이유는 따로 있다 — 자동화는 사람이 보지 않는 동안 돌기 때문에,
 *   멈출 지점이 없는 반복은 아무도 멈춰 줄 수 없다.
 */
function LoopBoundPanel({
  isBackEdge, value, onChange, onClose,
}: {
  isBackEdge: boolean;
  value: number | null;
  onChange: (v: number | null) => void;
  onClose: () => void;
}) {
  return (
    <div className="automation-node-panel" data-one-content-slot>
      <div className="automation-node-panel-head">
        <strong>{isBackEdge ? "되돌아가는 연결" : "연결"}</strong>
        <button type="button" className="ghost-btn" onClick={onClose}>닫기</button>
      </div>
      {isBackEdge ? (
        <>
          <p className="automation-node-panel-hint">
            앞 단계로 되돌아갑니다. 몇 바퀴까지 돌지 정해야 실행할 수 있어요 —
            자동화는 아무도 보고 있지 않을 때 돌기 때문입니다.
          </p>
          <label className="automation-field">
            <span>최대 반복 횟수</span>
            <input
              type="number" min={1} max={50}
              value={value ?? ""}
              placeholder="예: 3"
              onChange={(e) => {
                const n = Number(e.target.value);
                onChange(Number.isFinite(n) && n >= 1 && n <= 50 ? Math.round(n) : null);
              }}
            />
          </label>
          <div className="automation-chip-row">
            {[2, 3, 5].map((n) => (
              <button key={n} type="button" className={value === n ? "chip chip-on" : "chip"} onClick={() => onChange(n)}>
                {n}번
              </button>
            ))}
          </div>
        </>
      ) : (
        <p className="automation-node-panel-hint">
          앞에서 뒤로 가는 보통 연결입니다. 따로 정할 것이 없어요.
        </p>
      )}
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
