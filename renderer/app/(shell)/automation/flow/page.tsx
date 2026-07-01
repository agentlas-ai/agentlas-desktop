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
import { IconBolt } from "@/components/Icon";

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
      { id: "n0", type: "trigger", position: { x: 0, y: 120 }, config: { schedule: a.scheduleHuman }, label: "Trigger" },
      {
        id: "n1",
        type: "agent",
        position: { x: 280, y: 120 },
        config: { ref: a.targetId, targetType: a.targetType, prompt: a.promptTemplate },
        label: a.targetType === "firm" ? "Firm" : "Agent",
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
  const seq = useRef(0);

  const [rfNodes, setRfNodes, onNodesChangeBase] = useNodesState<Node<WorkflowNodeData>>([]);
  const [rfEdges, setRfEdges, onEdgesChangeBase] = useEdgesState<Edge>([]);
  // 노드 id → 라이브 실행 상태(설계 §5 P2). 라이브 채널 이벤트 + latestRun 하이드레이트로 채움.
  const [runStates, setRunStates] = useState<Record<string, WorkflowNodeRunState>>({});
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
    } catch (err) {
      setError(locale === "en" ? `Automation could not be loaded. Nothing changed. ${String(err)}` : `자동화를 불러오지 못했습니다. 바뀐 내용은 없습니다. ${String(err)}`);
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
    } catch (err) {
      setMessage(`${t("auto.flow.save_failed")} ${String(err)}`);
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
    } catch (err) {
      setMessage(locale === "en" ? `Status did not change. ${String(err)}` : `상태를 바꾸지 못했습니다. ${String(err)}`);
    }
  }

  async function runNow() {
    const api = ipc();
    if (!api || !automation) return;
    setRunning(true);
    setMessage("");
    try {
      await api.automations.runNow(automation.id);
      setMessage(locale === "en" ? "Run started in the background." : "백그라운드에서 실행을 시작했습니다.");
    } catch (err) {
      setMessage(locale === "en" ? `Run did not start. ${String(err)}` : `실행을 시작하지 못했습니다. ${String(err)}`);
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
            <button onClick={() => void runNow()} disabled={running} className="titlebar-nodrag" style={{ ...actionBtn, color: running ? "var(--muted-deep)" : "var(--ink)" }}>
              {running ? t("auto.flow.running") : t("auto.flow.run_now")}
            </button>
            <button onClick={() => void toggleEnabled()} className="titlebar-nodrag" style={pillBtn(automation.enabled)}>
              {automation.enabled ? t("auto.on") : t("auto.flow.activate")}
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

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {isSynthesized && !editing ? (
            <div
              style={{
                position: "absolute",
                top: 12,
                left: 12,
                zIndex: 5,
                padding: "5px 10px",
                borderRadius: 999,
                fontSize: 11,
                background: "var(--paper)",
                border: "1px dashed var(--paper-edge)",
                color: "var(--muted-deep)",
              }}
            >
              {t("auto.flow.synthesized")}
            </div>
          ) : null}
          <ReactFlow
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
            <Background color="var(--paper-edge)" gap={20} />
            <Controls showInteractive={false} />
            <MiniMap
              pannable
              zoomable
              nodeColor={(n) => NODE_ACCENT[n.type ?? "agent"] ?? "var(--muted-deep)"}
              style={{ background: "var(--paper)", border: "1px solid var(--paper-edge)" }}
            />
          </ReactFlow>
        </div>

        {editing && paletteOpen ? (
          <NodePalette onAdd={addPaletteNode} onClose={() => setPaletteOpen(false)} />
        ) : editing && selectedNode ? (
          <NodeConfigPanel
            node={selectedNode}
            onPatch={patchSelected}
            onLabel={labelSelected}
            onDelete={deleteSelected}
            onClose={() => setSelectedNodeId(null)}
          />
        ) : selectedNode ? (
          <NodeInspector node={selectedNode} onClose={() => setSelectedNodeId(null)} t={t} />
        ) : null}
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
