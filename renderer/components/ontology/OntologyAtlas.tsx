"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";

import type {
  AgentOntologyHubProjection,
  ExperienceOntologyGraphEdge,
  ExperienceOntologyGraphNode,
  ExperienceOntologyGraphSnapshot,
  ExperienceOntologySummary,
} from "@shared/types";

import styles from "./OntologyAtlas.module.css";
import type { OntologyCameraCommand, OntologySceneEdge, OntologySceneNode } from "./OntologyAtlasScene3D";

const OntologyScene3D = dynamic(
  () => import("./OntologyAtlasScene3D").then((module) => module.OntologyAtlasScene3D),
  { ssr: false },
);

type Locale = "ko" | "en";
type Scope = "all" | "local" | "hub";
type EngineState = "loading" | "ready" | "fallback";

type AtlasNodeKind = ExperienceOntologyGraphNode["kind"] | "hub-release" | "hub-operational" | "hub-taste";
type AtlasNodeSource = "agent" | "local" | "hub";

type AtlasNode = {
  id: string;
  kind: AtlasNodeKind;
  label: string;
  detail: string;
  ref: string | null;
  status: string;
  source: AtlasNodeSource;
  packId: string | null;
};

type AtlasEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  status: "active" | "historical" | "pending";
  source: "local" | "hub";
};

const MAX_RENDERED_NODES = 400;
const MAX_RENDERED_EDGES = 800;

const GRAPH_COLORS = {
  agent: { color: "#f3f0e6", border: "#91b8a6" },
  pack: { color: "#78b99c", border: "#d5f0e3" },
  release: { color: "#6d8178", border: "#a8bbb2" },
  item: { color: "#9bceba", border: "#d8eee4" },
  task: { color: "#93aac5", border: "#cfd9e5" },
  environment: { color: "#7d8984", border: "#adb7b3" },
  mcp: { color: "#bf9d73", border: "#e7d3b8" },
  evidence: { color: "#d4d8cd", border: "#ffffff" },
  taste: { color: "#dcad68", border: "#f2d5a8" },
  hub: { color: "#91b7cf", border: "#d2e4ed" },
  candidate: { color: "#686f6c", border: "#a2aaa6" },
} as const;

function shortRef(value: string | null | undefined): string {
  const clean = value?.trim() ?? "";
  if (!clean) return "";
  if (clean.length <= 18) return clean;
  return `${clean.slice(0, 8)}…${clean.slice(-6)}`;
}

function safeNodeLabel(node: ExperienceOntologyGraphNode, locale: Locale): string {
  const suffix = shortRef(node.ref ?? node.id);
  const named = node.safeLabel?.trim();
  const ko = locale === "ko";
  const genericLabels = new Set([
    "agent",
    "experience pack",
    "base release",
    "experience release",
    "promoted experience",
    "private candidate",
    "task",
    "environment",
    "mcp requirement",
    "evidence receipt",
    "taste draft",
    "taste axis",
  ]);
  if (named && !genericLabels.has(named.toLocaleLowerCase("en-US"))) return named;
  switch (node.kind) {
    case "agent": return ko ? "에이전트 코어" : "Agent core";
    case "pack": return `${ko ? "경험 칩" : "Experience chip"} · ${suffix}`;
    case "release": return `${ko ? "릴리스" : "Release"} · ${suffix}`;
    case "experience-item": return `${ko ? "실행 경험" : "Experience"} · ${suffix}`;
    case "task": return `${ko ? "태스크" : "Task"} · ${suffix}`;
    case "environment": return ko ? "실행 환경" : "Environment";
    case "mcp": return `${ko ? "도구" : "Tool"} · ${suffix}`;
    case "evidence": return `${ko ? "검증 근거" : "Evidence"} · ${suffix}`;
    case "taste-draft": return `${ko ? "취향 후보" : "Taste draft"} · ${suffix}`;
    case "taste-axis": return `${ko ? "취향 축" : "Taste axis"} · ${suffix}`;
  }
}

function nodeDetail(node: ExperienceOntologyGraphNode, locale: Locale): string {
  const ko = locale === "ko";
  if (node.source === "private-candidate") return ko ? "로컬 비공개 후보 · 원문 미표시" : "Private local candidate · source hidden";
  if (node.source === "taste-draft") return ko ? "사람 근거 대기 · 성공 점수 아님" : "Awaiting human evidence · not a success score";
  if (node.kind === "release") return node.status === "historical"
    ? (ko ? "이전 버전 · 현재 실행에 미적용" : "Previous version · not active")
    : (ko ? "정확한 기반 릴리스에 고정" : "Pinned to the exact base release");
  if (node.kind === "evidence") return ko ? "검증 영수증으로 역추적 가능" : "Traceable to a verification receipt";
  if (node.kind === "mcp") return ko ? "이 경험이 요구하거나 지원하는 MCP" : "MCP required or supported by this experience";
  if (node.kind === "task") return ko ? "범용 태스크 분류" : "Canonical task classification";
  if (node.kind === "agent") return ko ? "이 에이전트가 소유한 실제 관계" : "Actual relations owned by this agent";
  return ko ? "로컬 관계 원장에서 파생" : "Derived from the local relation ledger";
}

function atlasTone(node: Pick<AtlasNode, "kind" | "status" | "source">) {
  if (node.source === "hub") return GRAPH_COLORS.hub;
  if (node.status === "candidate") return GRAPH_COLORS.candidate;
  if (node.kind === "agent") return GRAPH_COLORS.agent;
  if (node.kind === "pack") return GRAPH_COLORS.pack;
  if (node.kind === "release") return GRAPH_COLORS.release;
  if (node.kind === "experience-item") return GRAPH_COLORS.item;
  if (node.kind === "task") return GRAPH_COLORS.task;
  if (node.kind === "environment") return GRAPH_COLORS.environment;
  if (node.kind === "mcp") return GRAPH_COLORS.mcp;
  if (node.kind === "evidence") return GRAPH_COLORS.evidence;
  if (node.kind === "taste-draft" || node.kind === "taste-axis" || node.kind === "hub-taste") return GRAPH_COLORS.taste;
  return GRAPH_COLORS.release;
}

function nodeSize(node: AtlasNode, degree: number): number {
  const base = node.kind === "agent" ? 24
    : node.kind === "pack" || node.kind === "hub-release" ? 15
      : node.kind === "hub-operational" || node.kind === "hub-taste" ? 12.5
        : node.kind === "experience-item" || node.kind === "taste-draft" ? 9.5
          : node.kind === "mcp" ? 9
            : 6.5;
  return Math.min(30, base + Math.log2(Math.max(1, degree + 1)) * 1.55);
}

function edgeLabel(kind: string, locale: Locale): string {
  const ko = locale === "ko";
  const labels: Record<string, [string, string]> = {
    agent_has_pack: ["소유", "owns"],
    has_release: ["릴리스", "release"],
    exact_base_binding: ["정확한 기반", "exact base"],
    contains: ["포함", "contains"],
    contains_candidate: ["후보", "candidate"],
    applies_to_task: ["적용", "applies"],
    applies_in_environment: ["환경", "environment"],
    requires_mcp: ["필수 MCP", "requires MCP"],
    supports_mcp: ["지원 MCP", "supports MCP"],
    alternative_mcp: ["대체 MCP", "MCP fallback"],
    supported_by: ["근거", "evidence"],
    supersedes: ["업데이트", "supersedes"],
    similar_by_tag: ["유사", "similar"],
    agent_has_taste_draft: ["취향 관찰", "taste observation"],
    classified_as_taste_axis: ["취향 축", "taste axis"],
    hub_exact_release: ["Hub 릴리스", "Hub release"],
    hub_attached_chip: ["장착됨", "attached"],
  };
  const pair = labels[kind];
  return pair ? pair[ko ? 0 : 1] : kind.replaceAll("_", " ");
}

function mergeAtlas(
  snapshot: ExperienceOntologyGraphSnapshot | null,
  summary: ExperienceOntologySummary | null,
  hub: AgentOntologyHubProjection | null,
  agentName: string,
  locale: Locale,
): { nodes: AtlasNode[]; edges: AtlasEdge[]; rootId: string; capped: boolean; omittedNodeCount: number; omittedEdgeCount: number } {
  const root = snapshot?.nodes.find((node) => node.kind === "agent");
  const rootId = root?.id ?? `agent:${snapshot?.agentId ?? "selected"}`;
  const nodes: AtlasNode[] = (snapshot?.nodes ?? []).map((node) => ({
    id: node.id,
    kind: node.kind,
    label: node.kind === "agent" ? agentName : safeNodeLabel(node, locale),
    detail: nodeDetail(node, locale),
    ref: node.ref ?? null,
    status: node.status,
    source: node.kind === "agent" ? "agent" : "local",
    packId: node.packId ?? null,
  }));
  if (!nodes.some((node) => node.id === rootId)) {
    nodes.unshift({
      id: rootId,
      kind: "agent",
      label: agentName,
      detail: locale === "ko" ? "선택한 에이전트" : "Selected agent",
      ref: snapshot?.agentId ?? null,
      status: "active",
      source: "agent",
      packId: null,
    });
  }
  const edges: AtlasEdge[] = (snapshot?.edges ?? []).map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    status: edge.status,
    source: "local",
  }));

  const projection = hub?.projection;
  if (hub?.binding && projection) {
    const releaseId = `hub-release:${hub.binding.agentReleaseId}`;
    nodes.push({
      id: releaseId,
      kind: "hub-release",
      label: `${locale === "ko" ? "Hub 에이전트 릴리스" : "Hub agent release"} · ${shortRef(hub.binding.agentReleaseId)}`,
      detail: locale === "ko" ? "Hub가 확인한 정확한 에이전트 버전" : "Exact agent version confirmed by Hub",
      ref: hub.binding.agentReleaseId,
      status: projection.state,
      source: "hub",
      packId: null,
    });
    edges.push({ id: `hub-edge:${rootId}:${releaseId}`, from: rootId, to: releaseId, kind: "hub_exact_release", status: "active", source: "hub" });
    for (const chip of projection.operationalChips) {
      const id = `hub-chip:${chip.chipId}:${chip.releaseId}`;
      nodes.push({ id, kind: "hub-operational", label: chip.displayName, detail: chip.summary, ref: chip.releaseId, status: chip.verification, source: "hub", packId: null });
      edges.push({ id: `hub-edge:${releaseId}:${id}`, from: releaseId, to: id, kind: "hub_attached_chip", status: "active", source: "hub" });
    }
    for (const chip of projection.tasteChips) {
      const id = `hub-chip:${chip.chipId}:${chip.releaseId}`;
      nodes.push({ id, kind: "hub-taste", label: chip.displayName, detail: chip.summary, ref: chip.releaseId, status: chip.verification, source: "hub", packId: null });
      edges.push({ id: `hub-edge:${releaseId}:${id}`, from: releaseId, to: id, kind: "hub_attached_chip", status: "active", source: "hub" });
    }
  }

  // The graph contains no fabricated zero-count entities. Intake blocks are a
  // status metric, not a node. Keep the value available on the root inspector.
  if (summary && nodes.length === 1) nodes[0].detail = locale === "ko"
    ? `아직 관계가 없습니다 · 차단 ${summary.autoIntake.blocked}`
    : `No relations yet · blocked ${summary.autoIntake.blocked}`;
  if (nodes.length <= MAX_RENDERED_NODES && edges.length <= MAX_RENDERED_EDGES) {
    return { nodes, edges, rootId, capped: false, omittedNodeCount: 0, omittedEdgeCount: 0 };
  }

  const priority = (node: AtlasNode): number => {
    if (node.kind === "agent") return 0;
    if (node.kind === "hub-release" || node.kind === "pack") return 1;
    if (node.kind === "hub-operational" || node.kind === "hub-taste" || node.kind === "mcp" || node.kind === "release") return 2;
    if (node.kind === "experience-item" || node.kind === "taste-draft") return 3;
    if (node.kind === "task" || node.kind === "taste-axis") return 4;
    return 5;
  };
  const boundedNodes = [...nodes]
    .sort((left, right) => priority(left) - priority(right) || left.id.localeCompare(right.id))
    .slice(0, MAX_RENDERED_NODES);
  const keptIds = new Set(boundedNodes.map((node) => node.id));
  const connectableEdges = edges.filter((edge) => keptIds.has(edge.from) && keptIds.has(edge.to));
  const boundedEdges = [...connectableEdges]
    .sort((left, right) => {
      const statusRank = (status: AtlasEdge["status"]) => status === "active" ? 0 : status === "pending" ? 1 : 2;
      return statusRank(left.status) - statusRank(right.status) || left.id.localeCompare(right.id);
    })
    .slice(0, MAX_RENDERED_EDGES);
  return {
    nodes: boundedNodes,
    edges: boundedEdges,
    rootId,
    capped: true,
    omittedNodeCount: Math.max(0, nodes.length - boundedNodes.length),
    omittedEdgeCount: Math.max(0, edges.length - boundedEdges.length),
  };
}

export function OntologyAtlas({
  summary,
  graphSnapshot,
  hub,
  agentName,
  locale,
  graphLoading = false,
  graphError = false,
}: {
  summary: ExperienceOntologySummary | null;
  graphSnapshot: ExperienceOntologyGraphSnapshot | null;
  hub: AgentOntologyHubProjection | null;
  agentName: string;
  locale: Locale;
  graphLoading?: boolean;
  graphError?: boolean;
}) {
  const [scope, setScope] = useState<Scope>("all");
  const [engineState, setEngineState] = useState<EngineState>("loading");
  const [selectedId, setSelectedId] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [relationsOpen, setRelationsOpen] = useState(false);
  const [engineRevision, setEngineRevision] = useState(0);
  const [cameraCommand, setCameraCommand] = useState<OntologyCameraCommand>({ revision: 0, type: "reset" });
  const ko = locale === "ko";

  const atlas = useMemo(
    () => mergeAtlas(graphSnapshot, summary, hub, agentName, locale),
    [agentName, graphSnapshot, hub, locale, summary],
  );
  const visible = useMemo(() => {
    const nodes = atlas.nodes.filter((node) => scope === "all" || node.source === "agent" || node.source === scope);
    const ids = new Set(nodes.map((node) => node.id));
    return { nodes, edges: atlas.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) };
  }, [atlas, scope]);
  const nodeById = useMemo(() => new Map(visible.nodes.map((node) => [node.id, node])), [visible.nodes]);
  const inspected = nodeById.get(hoveredId ?? selectedId) ?? nodeById.get(atlas.rootId) ?? visible.nodes[0] ?? null;
  const inspectedNeighbors = useMemo(() => {
    if (!inspected) return [];
    const ids = new Set<string>();
    for (const edge of visible.edges) {
      if (edge.from === inspected.id) ids.add(edge.to);
      if (edge.to === inspected.id) ids.add(edge.from);
    }
    return [...ids].map((id) => nodeById.get(id)).filter((node): node is AtlasNode => Boolean(node)).slice(0, 8);
  }, [inspected, nodeById, visible.edges]);
  const hasHub = atlas.nodes.some((node) => node.source === "hub");
  const degreeById = useMemo(() => {
    const degrees = new Map<string, number>();
    for (const edge of visible.edges) {
      degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
      degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
    }
    return degrees;
  }, [visible.edges]);
  const sceneNodes = useMemo<OntologySceneNode[]>(() => visible.nodes.map((node) => ({
    id: node.id,
    label: node.label,
    color: atlasTone(node).color,
    size: nodeSize(node, degreeById.get(node.id) ?? 0),
    source: node.source,
  })), [degreeById, visible.nodes]);
  const sceneEdges = useMemo<OntologySceneEdge[]>(() => visible.edges.map((edge) => ({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    status: edge.status,
  })), [visible.edges]);
  const focusedId = hoveredId ?? (selectedId === atlas.rootId ? null : selectedId);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(query.matches);
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);

  useEffect(() => {
    if (!nodeById.has(selectedId)) setSelectedId(nodeById.has(atlas.rootId) ? atlas.rootId : visible.nodes[0]?.id ?? "");
  }, [atlas.rootId, nodeById, selectedId, visible.nodes]);

  const selectNode = useCallback((nodeId: string, focusCamera = true) => {
    setSelectedId(nodeId);
    if (focusCamera) setCameraCommand((current) => ({ revision: current.revision + 1, type: "focus", nodeId }));
  }, []);

  useEffect(() => {
    setHoveredId(null);
    setEngineState(visible.nodes.length > 0 ? "loading" : "fallback");
  }, [engineRevision, scope, visible.nodes]);

  const resetCamera = () => {
    setCameraCommand((current) => ({ revision: current.revision + 1, type: "reset" }));
  };
  const zoom = (direction: "in" | "out") => {
    setCameraCommand((current) => ({ revision: current.revision + 1, type: direction === "in" ? "zoom-in" : "zoom-out" }));
  };
  const handleSceneReady = useCallback(() => setEngineState("ready"), []);
  const handleSceneFallback = useCallback(() => setEngineState("fallback"), []);
  const handleSceneHover = useCallback((nodeId: string | null) => setHoveredId(nodeId), []);
  const tone = inspected ? atlasTone(inspected) : GRAPH_COLORS.agent;
  const relationCount = visible.edges.length;
  const nodeCount = visible.nodes.length;

  return (
    <section className={styles.atlas} data-testid="agent-ontology-graph" aria-label={ko ? "에이전트 온톨로지 관계지도" : "Agent ontology relation map"}>
      <div className={styles.shell} data-engine-state={engineState} data-scope={scope} data-empty={relationCount === 0} data-data-state={graphLoading ? "loading" : graphError ? "error" : "ready"}>
        <div
          className={styles.engine}
          role="img"
          aria-label={ko ? "회전·확대할 수 있는 3D 온톨로지 관계지도. 노드 찾기 메뉴와 관계 목록으로 키보드 탐색할 수 있습니다." : "Rotatable and zoomable 3D ontology map. Use the node picker and relation list for keyboard navigation."}
        >
          {engineState !== "fallback" && (
            <OntologyScene3D
              key={`${engineRevision}:${scope}`}
              nodes={sceneNodes}
              edges={sceneEdges}
              rootId={atlas.rootId}
              selectedId={selectedId}
              focusedId={focusedId}
              reducedMotion={reducedMotion}
              cameraCommand={cameraCommand}
              onHover={handleSceneHover}
              onSelect={selectNode}
              onReady={handleSceneReady}
              onFallback={handleSceneFallback}
            />
          )}
        </div>

        <div className={styles.topRail}>
          <div className={styles.brandPlate}>
            <span className={styles.pulse} aria-hidden="true" />
            <div style={{ minWidth: 0 }}>
              <div className={styles.eyebrow}>{ko ? "온톨로지 아틀라스" : "Ontology Atlas"}</div>
              <div className={styles.metric}>{nodeCount} NODE · {relationCount} RELATION{graphSnapshot?.truncated || atlas.capped ? " · CAPPED" : ""}</div>
            </div>
          </div>
          <div className={styles.toolPlate} role="toolbar" aria-label={ko ? "관계지도 도구" : "Relation map tools"}>
            <button type="button" className={styles.toolButton} onClick={() => zoom("out")} aria-label={ko ? "축소" : "Zoom out"} title={ko ? "축소" : "Zoom out"}>−</button>
            <button type="button" className={styles.toolButton} onClick={resetCamera} aria-label={ko ? "전체 맞춤" : "Fit graph"} title={ko ? "전체 맞춤" : "Fit graph"}>◎</button>
            <button type="button" className={styles.toolButton} onClick={() => zoom("in")} aria-label={ko ? "확대" : "Zoom in"} title={ko ? "확대" : "Zoom in"}>+</button>
            <span className={styles.divider} aria-hidden="true" />
            {(["all", "local", "hub"] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={styles.scopeButton}
                data-active={scope === value}
                aria-pressed={scope === value}
                disabled={value === "hub" && !hasHub}
                onClick={() => setScope(value)}
              >
                {value === "all" ? (ko ? "전체" : "All") : value === "local" ? (ko ? "로컬" : "Local") : "Hub"}
              </button>
            ))}
            <span className={styles.divider} aria-hidden="true" />
            <label>
              <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>{ko ? "노드 찾기" : "Find node"}</span>
              <select
                className={styles.nodeSelect}
                value={selectedId}
                onChange={(event) => selectNode(event.target.value)}
                aria-label={ko ? "노드 찾기" : "Find node"}
              >
                {visible.nodes.map((node) => <option key={node.id} value={node.id}>{node.label}</option>)}
              </select>
            </label>
          </div>
        </div>

        {inspected && (
          <aside
            className={styles.inspector}
            data-testid="ontology-node-inspector"
            style={{ "--node-color": tone.color, "--node-border": tone.border, "--node-radius": "999px" } as React.CSSProperties}
          >
            <div className={styles.inspectorHead}>
              <span className={styles.nodeMark} aria-hidden="true" />
              <div style={{ minWidth: 0 }}>
                <h3 className={styles.nodeTitle}>{inspected.label}</h3>
                <div className={styles.nodeMeta}>{inspected.kind.replaceAll("-", " ")}{inspected.source === "hub" ? " · HUB" : ""}</div>
              </div>
              <span className={styles.nodeState}>{inspected.status}</span>
            </div>
            <p className={styles.nodeDetail}>{inspected.detail}</p>
            {inspectedNeighbors.length > 0 && (
              <div className={styles.neighborRail} aria-label={ko ? "직접 연결" : "Direct neighbors"}>
                {inspectedNeighbors.map((node) => (
                  <button key={node.id} type="button" className={styles.neighborButton} onClick={() => selectNode(node.id)}>{node.label}</button>
                ))}
              </div>
            )}
          </aside>
        )}

        <div className={styles.bottomRail} aria-label={ko ? "관계선 범례" : "Relation legend"}>
          <div className={styles.legend}>
            <span className={styles.legendItem}><i className={styles.legendLine} aria-hidden="true" />{ko ? "현재 관계" : "active"}</span>
            <span className={styles.legendItem}><i className={styles.legendLinePending} aria-hidden="true" />{ko ? "대기·이전" : "pending / prior"}</span>
            <span className={styles.legendItem}><i className={styles.nodeMark} aria-hidden="true" style={{ "--node-color": GRAPH_COLORS.pack.color, "--node-border": GRAPH_COLORS.pack.border, "--node-radius": "999px", marginTop: 0 } as React.CSSProperties} />{ko ? "모든 노드" : "all nodes"}</span>
          </div>
          <span className={styles.engineBadge}>{engineState === "ready" ? "THREE · 3D" : engineState.toUpperCase()}</span>
        </div>

        {engineState === "fallback" && (
          <div className={styles.fallback} role="status">
            <div className={styles.fallbackHead}>
              <strong>{ko ? "GPU 지도를 사용할 수 없어 관계 목록으로 표시합니다." : "GPU map unavailable; showing the relation list."}</strong>
              <button type="button" className={styles.fallbackRetry} onClick={() => setEngineRevision((revision) => revision + 1)}>
                {ko ? "GPU 다시 시도" : "Retry GPU"}
              </button>
            </div>
            <div className={styles.fallbackGrid}>
              {visible.nodes.map((node) => (
                <button key={node.id} type="button" className={styles.fallbackNode} onClick={() => selectNode(node.id, false)}>
                  <strong style={{ display: "block", fontSize: 10.5 }}>{node.label}</strong>
                  <span style={{ color: "#82908b", fontSize: 8.5 }}>{node.kind} · {node.status}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {(graphLoading || graphError) && (
          <div className={styles.dataState} role="status" data-kind={graphError ? "error" : "loading"}>
            <span className={styles.dataStateMark} aria-hidden="true" />
            <strong>{graphError
              ? (ko ? "관계지도를 불러오지 못했습니다." : "The relation map could not be loaded.")
              : (ko ? "관계 원장을 불러오는 중" : "Loading relation ledger")}</strong>
            <span>{graphError
              ? (ko ? "에이전트 통계와 로컬 경험은 아래에서 계속 볼 수 있습니다." : "Agent stats and local experience remain available below.")
              : (ko ? "로컬 원문은 지도에 복사하지 않습니다." : "Local source text is never copied into the map.")}</span>
          </div>
        )}
      </div>

      <details className={styles.relationList} data-testid="ontology-relation-list" open={relationsOpen} onToggle={(event) => setRelationsOpen(event.currentTarget.open)}>
        <summary className={styles.relationSummary}>{ko ? `관계 원장 ${relationCount}개` : `${relationCount} ledger relations`}</summary>
        {relationsOpen && <div className={styles.relationRows}>
          {visible.edges.map((edge) => (
            <div key={edge.id} className={styles.relationRow}>
              <button type="button" onClick={() => selectNode(edge.from)} style={{ overflow: "hidden", border: 0, background: "transparent", color: "inherit", textAlign: "left", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>{nodeById.get(edge.from)?.label ?? shortRef(edge.from)}</button>
              <span className={styles.relationKind}>{edgeLabel(edge.kind, locale)}</span>
              <button type="button" onClick={() => selectNode(edge.to)} style={{ overflow: "hidden", border: 0, background: "transparent", color: "inherit", textAlign: "left", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer" }}>{nodeById.get(edge.to)?.label ?? shortRef(edge.to)}</button>
            </div>
          ))}
        </div>}
      </details>
    </section>
  );
}
