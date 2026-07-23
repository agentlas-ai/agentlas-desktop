"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  computeExperienceClusters,
  computeExperienceMapLayout,
  graphContentHash,
  labelModeForDistance,
  fnv1a,
  type ExperienceMapLabelMode,
} from "./experience-map-core.cjs";
import styles from "./OntologyAtlas.module.css";

export type OntologySceneNode = {
  id: string;
  label: string;
  color: string;
  size: number;
  source: "agent" | "local" | "hub";
  kind: string;
};

export type OntologySceneEdge = {
  id: string;
  from: string;
  to: string;
  kind: string;
  status: "active" | "historical" | "pending";
};

export type OntologySceneCluster = {
  id: string;
  label: string;
  count: number;
};

export type OntologyCameraCommand = {
  revision: number;
  type: "reset" | "zoom-in" | "zoom-out" | "focus" | "focus-cluster";
  nodeId?: string;
  clusterId?: string;
};

type SceneRuntime = {
  setReducedMotion: (reduced: boolean) => void;
  updateAppearance: (selectedId: string, focusedId: string | null) => void;
  runCommand: (command: OntologyCameraCommand) => void;
  dispose: () => void;
};

type SceneProps = {
  nodes: OntologySceneNode[];
  edges: OntologySceneEdge[];
  rootId: string;
  /** Localized cluster summary labels, computed once per graph snapshot upstream. */
  clusterLabels: Map<string, string>;
  selectedId: string;
  focusedId: string | null;
  reducedMotion: boolean;
  cameraCommand: OntologyCameraCommand;
  onHover: (nodeId: string | null) => void;
  onSelect: (nodeId: string, focusCamera: boolean) => void;
  onReady: () => void;
  onFallback: () => void;
};

const DARK_NODE = new THREE.Color("#26302d");
const LAYOUT_CACHE_PREFIX = "agentlas.experience-map-layout:";
/** Label caps keep the DOM overlay cheap even at the 400-node transport cap. */
const MAX_ALL_LABELS = 140;
const MAX_MAJOR_LABELS = 32;

function nodeRadius(size: number): number {
  return 0.24 + Math.min(30, Math.max(5, size)) / 30 * 0.58;
}

function createSoftMatcap(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for experience-map sphere material");
  const gradient = context.createRadialGradient(43, 34, 3, 66, 68, 82);
  gradient.addColorStop(0, "#ffffff");
  gradient.addColorStop(0.2, "#eef6f2");
  gradient.addColorStop(0.58, "#9aafa6");
  gradient.addColorStop(1, "#394843");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

type SceneLayout = {
  positions: Map<string, THREE.Vector3>;
  clusters: Array<{ id: string; label: string; count: number; centroid: THREE.Vector3; radius: number }>;
  clusterByNode: Map<string, string>;
  extent: number;
  depthSpan: number;
  cacheState: "hit" | "miss";
  clusterCount: number;
};

type StoredLayout = {
  hash: string;
  positions: Record<string, [number, number, number]>;
  clusterGeometry: Record<string, { centroid: [number, number, number]; radius: number }>;
  extent: number;
  depthSpan: number;
};

/**
 * Deterministic clustered layout with a per-agent coordinate cache: the same
 * graph snapshot always yields the same coordinates, and a revisit reuses the
 * previously converged coordinates from localStorage (keyed by content hash)
 * instead of recomputing the relaxation.
 */
function buildClusteredLayout(
  nodes: OntologySceneNode[],
  edges: OntologySceneEdge[],
  rootId: string,
  clusterLabels: Map<string, string>,
): SceneLayout {
  const coreNodes = nodes.map((node) => ({ id: node.id, kind: node.kind, label: node.label }));
  const coreEdges = edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, kind: edge.kind, status: edge.status }));
  const clustering = computeExperienceClusters(coreNodes, coreEdges, rootId);
  const hash = graphContentHash(coreNodes, coreEdges);
  const cacheKey = `${LAYOUT_CACHE_PREFIX}${fnv1a(rootId).toString(16)}`;

  let cacheState: "hit" | "miss" = "miss";
  let positionsById: Map<string, [number, number, number]> | null = null;
  let clusterGeometry: Map<string, { centroid: [number, number, number]; radius: number }> | null = null;
  let extent = 1;
  let depthSpan = 0;
  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (raw) {
      const stored = JSON.parse(raw) as StoredLayout;
      if (stored.hash === hash && stored.positions && nodes.every((node) => Array.isArray(stored.positions[node.id]))) {
        positionsById = new Map(Object.entries(stored.positions) as Array<[string, [number, number, number]]>);
        clusterGeometry = new Map(Object.entries(stored.clusterGeometry ?? {}));
        extent = stored.extent;
        depthSpan = stored.depthSpan;
        cacheState = "hit";
      }
    }
  } catch {
    positionsById = null;
  }

  if (!positionsById || !clusterGeometry) {
    const layout = computeExperienceMapLayout(coreNodes, coreEdges, clustering, rootId);
    positionsById = layout.positions as Map<string, [number, number, number]>;
    clusterGeometry = layout.clusterGeometry as Map<string, { centroid: [number, number, number]; radius: number }>;
    extent = layout.extent;
    depthSpan = layout.depthSpan;
    cacheState = "miss";
    try {
      const stored: StoredLayout = {
        hash,
        positions: Object.fromEntries(positionsById),
        clusterGeometry: Object.fromEntries(clusterGeometry),
        extent,
        depthSpan,
      };
      window.localStorage.setItem(cacheKey, JSON.stringify(stored));
    } catch {
      // Cache persistence is best-effort; the layout stays deterministic anyway.
    }
  }

  const positions = new Map<string, THREE.Vector3>();
  for (const node of nodes) {
    const point = positionsById.get(node.id) ?? [0, 0, 0];
    positions.set(node.id, new THREE.Vector3(point[0], point[1], point[2]));
  }
  for (const node of nodes) {
    extent = Math.max(extent, (positions.get(node.id)?.length() ?? 0) + nodeRadius(node.size));
  }

  const clusters = clustering.clusters
    .filter((cluster) => !cluster.isRoot)
    .map((cluster) => {
      const geometry = clusterGeometry!.get(cluster.id);
      const centroid = geometry
        ? new THREE.Vector3(geometry.centroid[0], geometry.centroid[1], geometry.centroid[2])
        : new THREE.Vector3();
      return {
        id: cluster.id,
        label: clusterLabels.get(cluster.id) ?? "",
        count: cluster.count,
        centroid,
        radius: geometry?.radius ?? 1.4,
      };
    });

  return {
    positions,
    clusters,
    clusterByNode: clustering.assignment as Map<string, string>,
    extent,
    depthSpan,
    cacheState,
    clusterCount: clusters.length,
  };
}

function appendEdgeCurve(coordinates: number[], start: THREE.Vector3, end: THREE.Vector3, edgeId: string) {
  const middle = start.clone().add(end).multiplyScalar(0.5);
  const direction = end.clone().sub(start);
  const perpendicular = direction.clone().cross(new THREE.Vector3(0, 1, 0));
  if (perpendicular.lengthSq() < 0.001) perpendicular.cross(new THREE.Vector3(1, 0, 0));
  const bend = (0.12 + Math.min(0.48, direction.length() * 0.028)) * ((fnv1a(edgeId) % 2 === 0) ? 1 : -1);
  middle.add(perpendicular.normalize().multiplyScalar(bend));
  let previous = start;
  for (let step = 1; step <= 6; step += 1) {
    const t = step / 6;
    const inverse = 1 - t;
    const current = new THREE.Vector3(
      inverse * inverse * start.x + 2 * inverse * t * middle.x + t * t * end.x,
      inverse * inverse * start.y + 2 * inverse * t * middle.y + t * t * end.y,
      inverse * inverse * start.z + 2 * inverse * t * middle.z + t * t * end.z,
    );
    coordinates.push(previous.x, previous.y, previous.z, current.x, current.y, current.z);
    previous = current;
  }
}

function createEdgeGeometry(
  edges: OntologySceneEdge[],
  positions: Map<string, THREE.Vector3>,
  include: (edge: OntologySceneEdge) => boolean,
) {
  const coordinates: number[] = [];
  for (const edge of edges) {
    if (!include(edge)) continue;
    const start = positions.get(edge.from);
    const end = positions.get(edge.to);
    if (!start || !end) continue;
    appendEdgeCurve(coordinates, start, end, edge.id);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(coordinates, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function parseInstance(intersections: THREE.Intersection[]): number | null {
  const hit = intersections[0];
  return hit && typeof hit.instanceId === "number" ? hit.instanceId : null;
}

export function OntologyAtlasScene3D(props: SceneProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const labelLayerRef = useRef<HTMLDivElement | null>(null);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const layout = useMemo(
    () => buildClusteredLayout(props.nodes, props.edges, props.rootId, props.clusterLabels),
    [props.clusterLabels, props.edges, props.nodes, props.rootId],
  );

  useEffect(() => {
    const root = rootRef.current;
    const tooltip = tooltipRef.current;
    const labelLayer = labelLayerRef.current;
    if (!root || !tooltip || !labelLayer || props.nodes.length === 0) {
      props.onFallback();
      return;
    }

    let disposed = false;
    let frameId = 0;
    let hoveredIndex: number | null = null;
    let interacting = false;
    let reducedMotion = props.reducedMotion;
    let cameraGoal: { position: THREE.Vector3; target: THREE.Vector3 } | null = null;
    let pointerDown: { x: number; y: number } | null = null;
    let currentLabelMode: ExperienceMapLabelMode | "" = "";
    let currentFocusedId: string | null = props.focusedId;
    const nodeIndex = new Map(props.nodes.map((node, index) => [node.id, index]));
    const initialRadius = Math.max(3.6, layout.extent);
    const largestNodeRadius = props.nodes.reduce((largest, node) => Math.max(largest, nodeRadius(node.size)), 0);

    const degreeById = new Map<string, number>();
    for (const edge of props.edges) {
      degreeById.set(edge.from, (degreeById.get(edge.from) ?? 0) + 1);
      degreeById.set(edge.to, (degreeById.get(edge.to) ?? 0) + 1);
    }
    const byLabelPriority = [...props.nodes]
      .sort((left, right) =>
        (degreeById.get(right.id) ?? 0) - (degreeById.get(left.id) ?? 0) || (left.id < right.id ? -1 : 1));
    const allLabelIds = new Set(byLabelPriority.slice(0, MAX_ALL_LABELS).map((node) => node.id));
    const majorLabelIds = new Set(
      byLabelPriority
        .filter((node) => node.id === props.rootId || (degreeById.get(node.id) ?? 0) >= 2)
        .slice(0, MAX_MAJOR_LABELS)
        .map((node) => node.id),
    );

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: props.nodes.length < 260,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      props.onFallback();
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.08;
    renderer.domElement.dataset.ontologyWebgl = "true";
    renderer.domElement.setAttribute("aria-hidden", "true");
    root.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color("#091013");
    scene.fog = new THREE.Fog("#091013", Math.max(24, layout.extent * 2.3), Math.max(54, layout.extent * 5.2));
    const camera = new THREE.PerspectiveCamera(42, 1, 0.1, Math.max(120, layout.extent * 12));
    camera.position.set(initialRadius * 1.12, initialRadius * 0.58, initialRadius * 2.38);

    scene.add(new THREE.AmbientLight("#ffffff", 1.28));
    const keyLight = new THREE.DirectionalLight("#eaf7f0", 2.4);
    keyLight.position.set(8, 12, 10);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight("#759a8b", 0.8);
    fillLight.position.set(-10, -5, -8);
    scene.add(fillLight);

    // Hairball avoidance: edges rest at a low opacity; only the hovered or
    // selected node's 1-hop edges are drawn bright, and cluster-crossing
    // edges always stay dimmer than intra-cluster ones.
    const intraCluster = (edge: OntologySceneEdge) =>
      layout.clusterByNode.get(edge.from) === layout.clusterByNode.get(edge.to);
    const intraEdgeGeometry = createEdgeGeometry(props.edges, layout.positions, (edge) => intraCluster(edge));
    const interEdgeGeometry = createEdgeGeometry(props.edges, layout.positions, (edge) => !intraCluster(edge));
    const intraEdgeMaterial = new THREE.LineBasicMaterial({ color: "#9bc8b3", transparent: true, opacity: 0.14, depthWrite: false });
    const interEdgeMaterial = new THREE.LineBasicMaterial({ color: "#52615b", transparent: true, opacity: 0.07, depthWrite: false });
    const highlightEdgeMaterial = new THREE.LineBasicMaterial({ color: "#cdeedd", transparent: true, opacity: 0.92, depthWrite: false });
    const highlightEdgeGeometry = new THREE.BufferGeometry();
    scene.add(new THREE.LineSegments(interEdgeGeometry, interEdgeMaterial));
    scene.add(new THREE.LineSegments(intraEdgeGeometry, intraEdgeMaterial));
    const highlightEdges = new THREE.LineSegments(highlightEdgeGeometry, highlightEdgeMaterial);
    highlightEdges.frustumCulled = false;
    scene.add(highlightEdges);

    // Translucent cluster hulls give each cluster a readable region tint.
    const hullGeometry = new THREE.SphereGeometry(1, 18, 12);
    const hullMaterial = new THREE.MeshBasicMaterial({
      color: "#3f5a50",
      transparent: true,
      opacity: 0.07,
      depthWrite: false,
      side: THREE.BackSide,
    });
    const hullMesh = new THREE.InstancedMesh(hullGeometry, hullMaterial, Math.max(1, layout.clusters.length));
    hullMesh.count = layout.clusters.length;
    hullMesh.frustumCulled = false;
    {
      const dummyHull = new THREE.Object3D();
      layout.clusters.forEach((cluster, index) => {
        dummyHull.position.copy(cluster.centroid);
        dummyHull.scale.setScalar(cluster.radius);
        dummyHull.updateMatrix();
        hullMesh.setMatrixAt(index, dummyHull.matrix);
      });
      hullMesh.instanceMatrix.needsUpdate = true;
    }
    scene.add(hullMesh);

    const nodeGeometry = new THREE.SphereGeometry(1, 24, 18);
    const nodeMatcap = createSoftMatcap();
    const nodeMaterial = new THREE.MeshMatcapMaterial({ color: "#ffffff", matcap: nodeMatcap });
    const nodeMesh = new THREE.InstancedMesh(nodeGeometry, nodeMaterial, props.nodes.length);
    nodeMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    nodeMesh.frustumCulled = false;
    scene.add(nodeMesh);

    const haloGeometry = new THREE.SphereGeometry(1, 20, 14);
    const selectedHaloMaterial = new THREE.MeshBasicMaterial({ color: "#bfe5d2", transparent: true, opacity: 0.16, depthWrite: false, side: THREE.BackSide });
    const hoverHaloMaterial = new THREE.MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0.24, depthWrite: false, side: THREE.BackSide });
    const selectedHalo = new THREE.Mesh(haloGeometry, selectedHaloMaterial);
    const hoverHalo = new THREE.Mesh(haloGeometry, hoverHaloMaterial);
    selectedHalo.visible = false;
    hoverHalo.visible = false;
    scene.add(selectedHalo, hoverHalo);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.075;
    controls.enablePan = false;
    controls.rotateSpeed = 0.48;
    controls.zoomSpeed = 0.62;
    controls.minDistance = 3.2;
    controls.maxDistance = Math.max(34, layout.extent * 4.2);
    controls.target.set(0, 0, 0);
    controls.update();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dummy = new THREE.Object3D();

    // ── DOM label overlay (Obsidian-style zoom-dependent density) ──────────
    const nodeLabelElements = new Map<string, HTMLDivElement>();
    for (const node of props.nodes) {
      if (!allLabelIds.has(node.id)) continue;
      const element = document.createElement("div");
      element.className = styles.nodeLabel3d;
      element.textContent = node.label;
      element.dataset.nodeId = node.id;
      element.style.opacity = "0";
      labelLayer.appendChild(element);
      nodeLabelElements.set(node.id, element);
    }
    const clusterLabelElements = new Map<string, HTMLButtonElement>();
    for (const cluster of layout.clusters) {
      if (!cluster.label) continue;
      const element = document.createElement("button");
      element.type = "button";
      element.className = styles.clusterLabel3d;
      element.dataset.clusterLabel = cluster.id;
      element.textContent = cluster.label;
      element.addEventListener("click", () => focusCluster(cluster.id));
      labelLayer.appendChild(element);
      clusterLabelElements.set(cluster.id, element);
    }

    const projected = new THREE.Vector3();
    const projectToScreen = (position: THREE.Vector3, width: number, height: number): { x: number; y: number; visible: boolean } => {
      projected.copy(position).project(camera);
      return {
        x: (projected.x * 0.5 + 0.5) * width,
        y: (-projected.y * 0.5 + 0.5) * height,
        visible: projected.z < 1 && projected.x > -1.15 && projected.x < 1.15 && projected.y > -1.15 && projected.y < 1.15,
      };
    };

    const updateLabels = () => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      const distance = camera.position.distanceTo(controls.target);
      const mode = labelModeForDistance(distance, layout.extent) as ExperienceMapLabelMode;
      if (mode !== currentLabelMode) {
        currentLabelMode = mode;
        root.dataset.labelMode = mode;
      }
      for (const [nodeId, element] of nodeLabelElements) {
        const show = mode === "all" ? true : mode === "major" ? majorLabelIds.has(nodeId) : false;
        const position = layout.positions.get(nodeId);
        if (!show || !position) {
          element.style.opacity = "0";
          continue;
        }
        const screen = projectToScreen(position, width, height);
        if (!screen.visible) {
          element.style.opacity = "0";
          continue;
        }
        const dimmed = currentFocusedId && nodeId !== currentFocusedId && !focusNeighborIds.has(nodeId);
        element.style.opacity = dimmed ? "0.22" : "1";
        element.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${(screen.y + 9).toFixed(1)}px, 0) translateX(-50%)`;
      }
      const showClusters = mode !== "all";
      for (const cluster of layout.clusters) {
        const element = clusterLabelElements.get(cluster.id);
        if (!element) continue;
        if (!showClusters) {
          element.style.opacity = "0";
          element.style.pointerEvents = "none";
          continue;
        }
        const top = cluster.centroid.clone();
        top.y += cluster.radius * 0.92;
        const screen = projectToScreen(top, width, height);
        if (!screen.visible) {
          element.style.opacity = "0";
          element.style.pointerEvents = "none";
          continue;
        }
        element.style.opacity = "1";
        element.style.pointerEvents = "auto";
        element.style.transform = `translate3d(${screen.x.toFixed(1)}px, ${screen.y.toFixed(1)}px, 0) translate(-50%, -100%)`;
      }
    };

    let focusNeighborIds = new Set<string>();

    const reportCamera = () => {
      root.dataset.cameraPosition = camera.position.toArray().map((value) => value.toFixed(4)).join(",");
      root.dataset.cameraQuaternion = camera.quaternion.toArray().map((value) => value.toFixed(5)).join(",");
      root.dataset.cameraTarget = controls.target.toArray().map((value) => value.toFixed(4)).join(",");
      root.dataset.cameraDistance = camera.position.distanceTo(controls.target).toFixed(4);
      root.dataset.cameraAnimating = String(Boolean(cameraGoal));
      root.dataset.cameraRevision = String(Number(root.dataset.cameraRevision ?? "0") + 1);
    };

    const renderFrame = () => {
      frameId = 0;
      if (disposed) return;
      let keepRendering = false;
      if (cameraGoal) {
        camera.position.lerp(cameraGoal.position, 0.16);
        controls.target.lerp(cameraGoal.target, 0.16);
        const settled = camera.position.distanceTo(cameraGoal.position) < 0.015
          && controls.target.distanceTo(cameraGoal.target) < 0.015;
        if (settled) {
          camera.position.copy(cameraGoal.position);
          controls.target.copy(cameraGoal.target);
          cameraGoal = null;
        } else {
          keepRendering = true;
        }
      }
      if (controls.update()) keepRendering = true;
      renderer.render(scene, camera);
      updateLabels();
      root.dataset.drawCalls = String(renderer.info.render.calls);
      reportCamera();
      if (keepRendering) frameId = window.requestAnimationFrame(renderFrame);
    };

    const scheduleRender = () => {
      if (!disposed && frameId === 0) frameId = window.requestAnimationFrame(renderFrame);
    };

    const redrawTarget = root.parentElement ?? root;
    const handleRedraw = () => scheduleRender();
    redrawTarget.addEventListener("agentlas:ontology-redraw", handleRedraw);

    const hideHover = () => {
      const changed = hoveredIndex !== null || !tooltip.hidden || hoverHalo.visible;
      tooltip.hidden = true;
      renderer.domElement.style.cursor = "";
      hoverHalo.visible = false;
      if (hoveredIndex !== null) {
        hoveredIndex = null;
        props.onHover(null);
      }
      if (changed) scheduleRender();
    };

    const pickNode = (event: PointerEvent | MouseEvent): number | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(
        ((event.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1,
        -((event.clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1,
      );
      raycaster.setFromCamera(pointer, camera);
      return parseInstance(raycaster.intersectObject(nodeMesh, false));
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (interacting) return;
      const index = pickNode(event);
      if (index === null) {
        hideHover();
        return;
      }
      const node = props.nodes[index];
      const position = layout.positions.get(node.id);
      if (!node || !position) return;
      const rect = renderer.domElement.getBoundingClientRect();
      tooltip.hidden = false;
      tooltip.textContent = node.label;
      tooltip.style.transform = `translate3d(${event.clientX - rect.left + 14}px, ${event.clientY - rect.top + 14}px, 0)`;
      renderer.domElement.style.cursor = "pointer";
      hoverHalo.visible = true;
      hoverHalo.position.copy(position);
      hoverHalo.scale.setScalar(nodeRadius(node.size) * 1.5);
      if (hoveredIndex !== index) {
        hoveredIndex = index;
        props.onHover(node.id);
      }
      scheduleRender();
    };

    const handlePointerDown = (event: PointerEvent) => {
      pointerDown = { x: event.clientX, y: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const down = pointerDown;
      pointerDown = null;
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const index = pickNode(event);
      if (index !== null) props.onSelect(props.nodes[index].id, false);
    };
    const handleDoubleClick = (event: MouseEvent) => {
      const index = pickNode(event);
      if (index !== null) props.onSelect(props.nodes[index].id, true);
    };
    const handleContextLost = (event: Event) => {
      event.preventDefault();
      props.onFallback();
    };
    const handleControlStart = () => {
      interacting = true;
      cameraGoal = null;
      hideHover();
    };
    const handleControlEnd = () => {
      interacting = false;
      scheduleRender();
    };
    const handleControlChange = () => scheduleRender();

    renderer.domElement.addEventListener("pointermove", handlePointerMove);
    renderer.domElement.addEventListener("pointerdown", handlePointerDown);
    renderer.domElement.addEventListener("pointerup", handlePointerUp);
    renderer.domElement.addEventListener("pointerleave", hideHover);
    renderer.domElement.addEventListener("dblclick", handleDoubleClick);
    renderer.domElement.addEventListener("webglcontextlost", handleContextLost);
    controls.addEventListener("start", handleControlStart);
    controls.addEventListener("end", handleControlEnd);
    controls.addEventListener("change", handleControlChange);

    const resize = () => {
      const width = Math.max(1, root.clientWidth);
      const height = Math.max(1, root.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      scheduleRender();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(root);
    resize();

    const rebuildHighlightEdges = (focusedId: string | null) => {
      const coordinates: number[] = [];
      if (focusedId) {
        for (const edge of props.edges) {
          if (edge.from !== focusedId && edge.to !== focusedId) continue;
          const start = layout.positions.get(edge.from);
          const end = layout.positions.get(edge.to);
          if (!start || !end) continue;
          appendEdgeCurve(coordinates, start, end, edge.id);
        }
      }
      highlightEdgeGeometry.setAttribute("position", new THREE.Float32BufferAttribute(coordinates, 3));
      highlightEdgeGeometry.computeBoundingSphere();
      highlightEdges.visible = coordinates.length > 0;
    };

    const updateAppearance = (selectedId: string, focusedId: string | null) => {
      currentFocusedId = focusedId;
      const neighbors = new Set<string>();
      if (focusedId) {
        neighbors.add(focusedId);
        for (const edge of props.edges) {
          if (edge.from === focusedId) neighbors.add(edge.to);
          if (edge.to === focusedId) neighbors.add(edge.from);
        }
      }
      focusNeighborIds = neighbors;
      props.nodes.forEach((node, index) => {
        const position = layout.positions.get(node.id) ?? new THREE.Vector3();
        const focusScale = node.id === focusedId ? 1.18 : node.id === selectedId ? 1.08 : 1;
        dummy.position.copy(position);
        dummy.scale.setScalar(nodeRadius(node.size) * focusScale);
        dummy.updateMatrix();
        nodeMesh.setMatrixAt(index, dummy.matrix);
        const color = new THREE.Color(node.color);
        if (focusedId && !neighbors.has(node.id)) color.lerp(DARK_NODE, 0.7);
        nodeMesh.setColorAt(index, color);
      });
      nodeMesh.instanceMatrix.needsUpdate = true;
      if (nodeMesh.instanceColor) nodeMesh.instanceColor.needsUpdate = true;
      if (!nodeMesh.boundingSphere) {
        nodeMesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), layout.extent + largestNodeRadius * 0.2);
      }
      // Focused view: rest edges recede further so the 1-hop highlight reads.
      intraEdgeMaterial.opacity = focusedId ? 0.06 : 0.14;
      interEdgeMaterial.opacity = focusedId ? 0.03 : 0.07;
      rebuildHighlightEdges(focusedId);
      const selectedNode = props.nodes[nodeIndex.get(selectedId) ?? -1];
      const selectedPosition = selectedNode ? layout.positions.get(selectedNode.id) : null;
      selectedHalo.visible = Boolean(selectedNode && selectedPosition);
      if (selectedNode && selectedPosition) {
        selectedHalo.position.copy(selectedPosition);
        selectedHalo.scale.setScalar(nodeRadius(selectedNode.size) * 1.42);
      }
      if (!focusedId || focusedId === selectedId) hoverHalo.visible = false;
      scheduleRender();
    };

    const setCamera = (position: THREE.Vector3, target: THREE.Vector3) => {
      hideHover();
      const distance = THREE.MathUtils.clamp(position.distanceTo(target), controls.minDistance, controls.maxDistance);
      const bounded = target.clone().add(position.sub(target).normalize().multiplyScalar(distance));
      if (reducedMotion) {
        camera.position.copy(bounded);
        controls.target.copy(target);
        cameraGoal = null;
        controls.update();
      } else {
        cameraGoal = { position: bounded, target };
      }
      scheduleRender();
    };

    const focusCluster = (clusterId: string) => {
      const cluster = layout.clusters.find((entry) => entry.id === clusterId);
      if (!cluster) return;
      const offset = camera.position.clone().sub(controls.target);
      const distance = Math.max(4.6, cluster.radius * 2.7);
      setCamera(
        cluster.centroid.clone().add(offset.normalize().multiplyScalar(distance)),
        cluster.centroid.clone(),
      );
      root.dataset.focusedCluster = clusterId;
    };

    const runCommand = (command: OntologyCameraCommand) => {
      const offset = camera.position.clone().sub(controls.target);
      if (command.type === "reset") {
        setCamera(
          new THREE.Vector3(initialRadius * 1.12, initialRadius * 0.58, initialRadius * 2.38),
          new THREE.Vector3(),
        );
        delete root.dataset.focusedCluster;
      } else if (command.type === "zoom-in") {
        setCamera(controls.target.clone().add(offset.multiplyScalar(0.76)), controls.target.clone());
      } else if (command.type === "zoom-out") {
        setCamera(controls.target.clone().add(offset.multiplyScalar(1.28)), controls.target.clone());
      } else if (command.type === "focus" && command.nodeId) {
        const target = layout.positions.get(command.nodeId);
        if (!target) return;
        setCamera(
          target.clone().add(offset.normalize().multiplyScalar(Math.max(5.2, Math.min(11, layout.extent * 0.72)))),
          target.clone(),
        );
      } else if (command.type === "focus-cluster" && command.clusterId) {
        focusCluster(command.clusterId);
      }
    };

    const dispose = () => {
      if (disposed) return;
      disposed = true;
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      redrawTarget.removeEventListener("agentlas:ontology-redraw", handleRedraw);
      controls.removeEventListener("start", handleControlStart);
      controls.removeEventListener("end", handleControlEnd);
      controls.removeEventListener("change", handleControlChange);
      controls.dispose();
      renderer.domElement.removeEventListener("pointermove", handlePointerMove);
      renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
      renderer.domElement.removeEventListener("pointerup", handlePointerUp);
      renderer.domElement.removeEventListener("pointerleave", hideHover);
      renderer.domElement.removeEventListener("dblclick", handleDoubleClick);
      renderer.domElement.removeEventListener("webglcontextlost", handleContextLost);
      intraEdgeGeometry.dispose();
      interEdgeGeometry.dispose();
      highlightEdgeGeometry.dispose();
      intraEdgeMaterial.dispose();
      interEdgeMaterial.dispose();
      highlightEdgeMaterial.dispose();
      hullGeometry.dispose();
      hullMaterial.dispose();
      nodeGeometry.dispose();
      nodeMatcap.dispose();
      nodeMaterial.dispose();
      haloGeometry.dispose();
      selectedHaloMaterial.dispose();
      hoverHaloMaterial.dispose();
      for (const element of nodeLabelElements.values()) element.remove();
      for (const element of clusterLabelElements.values()) element.remove();
      nodeLabelElements.clear();
      clusterLabelElements.clear();
      if (hoveredIndex !== null) props.onHover(null);
      renderer.forceContextLoss();
      renderer.dispose();
      renderer.domElement.remove();
      tooltip.hidden = true;
      scene.clear();
    };

    runtimeRef.current = {
      setReducedMotion: (reduced) => {
        reducedMotion = reduced;
        controls.enableDamping = !reduced;
      },
      updateAppearance,
      runCommand,
      dispose,
    };
    updateAppearance(props.selectedId, props.focusedId);
    scheduleRender();
    const readyFrame = window.requestAnimationFrame(() => {
      if (!disposed) props.onReady();
    });

    return () => {
      window.cancelAnimationFrame(readyFrame);
      if (runtimeRef.current?.dispose === dispose) runtimeRef.current = null;
      dispose();
    };
  }, [layout, props.edges, props.nodes, props.onFallback, props.onHover, props.onReady, props.onSelect]);

  useEffect(() => {
    runtimeRef.current?.setReducedMotion(props.reducedMotion);
  }, [props.reducedMotion]);

  useEffect(() => {
    runtimeRef.current?.updateAppearance(props.selectedId, props.focusedId);
  }, [props.focusedId, props.selectedId]);

  useEffect(() => {
    runtimeRef.current?.runCommand(props.cameraCommand);
  }, [props.cameraCommand]);

  return (
    <div
      ref={rootRef}
      className={styles.scene3d}
      data-testid="ontology-3d-scene"
      data-engine="three-webgl"
      data-camera-type="PerspectiveCamera"
      data-camera-revision="0"
      data-camera-animating="false"
      data-node-shape="sphere"
      data-node-count={props.nodes.length}
      data-spherical-node-instances={props.nodes.length}
      data-non-spherical-node-instances="0"
      data-edge-count={props.edges.length}
      data-cluster-count={layout.clusterCount}
      data-label-mode="cluster"
      data-layout-cache={layout.cacheState}
      data-depth-span={layout.depthSpan.toFixed(4)}
      data-scene-radius={layout.extent.toFixed(4)}
    >
      <div ref={labelLayerRef} className={styles.labelLayer3d} data-testid="experience-map-labels" />
      <div ref={tooltipRef} className={styles.hoverLabel3d} data-testid="ontology-node-hover-label" hidden aria-hidden="true" />
    </div>
  );
}
