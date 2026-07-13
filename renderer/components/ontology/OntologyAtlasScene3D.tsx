"use client";

import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import styles from "./OntologyAtlas.module.css";

export type OntologySceneNode = {
  id: string;
  label: string;
  color: string;
  size: number;
  source: "agent" | "local" | "hub";
};

export type OntologySceneEdge = {
  id: string;
  from: string;
  to: string;
  status: "active" | "historical" | "pending";
};

export type OntologyCameraCommand = {
  revision: number;
  type: "reset" | "zoom-in" | "zoom-out" | "focus";
  nodeId?: string;
};

type SceneLayout = {
  positions: Map<string, THREE.Vector3>;
  extent: number;
  depthSpan: number;
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
  selectedId: string;
  focusedId: string | null;
  reducedMotion: boolean;
  cameraCommand: OntologyCameraCommand;
  onHover: (nodeId: string | null) => void;
  onSelect: (nodeId: string, focusCamera: boolean) => void;
  onReady: () => void;
  onFallback: () => void;
};

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DARK_NODE = new THREE.Color("#26302d");

function hashUnit(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 0xffffffff;
}

function nodeRadius(size: number): number {
  return 0.24 + Math.min(30, Math.max(5, size)) / 30 * 0.58;
}

function createSoftMatcap(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("2D canvas unavailable for ontology sphere material");
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

function buildSphericalLayout(nodes: OntologySceneNode[], edges: OntologySceneEdge[], rootId: string): SceneLayout {
  const ids = new Set(nodes.map((node) => node.id));
  const adjacency = new Map<string, Set<string>>(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    adjacency.get(edge.from)?.add(edge.to);
    adjacency.get(edge.to)?.add(edge.from);
  }

  const depth = new Map<string, number>();
  const queue: string[] = [];
  if (ids.has(rootId)) {
    depth.set(rootId, 0);
    queue.push(rootId);
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const currentDepth = depth.get(current) ?? 0;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (depth.has(neighbor)) continue;
      depth.set(neighbor, currentDepth + 1);
      queue.push(neighbor);
    }
  }

  const deepestConnected = Math.max(1, ...depth.values());
  const orphanDepth = deepestConnected + 1;
  const shells = new Map<number, OntologySceneNode[]>();
  for (const node of nodes) {
    if (node.id === rootId) continue;
    const shellDepth = depth.get(node.id) ?? orphanDepth;
    const shell = shells.get(shellDepth) ?? [];
    shell.push(node);
    shells.set(shellDepth, shell);
  }

  const positions = new Map<string, THREE.Vector3>();
  if (ids.has(rootId)) positions.set(rootId, new THREE.Vector3());
  let extent = 1;
  for (const [shellDepth, unsorted] of [...shells.entries()].sort(([left], [right]) => left - right)) {
    const shell = [...unsorted].sort((left, right) => left.id.localeCompare(right.id));
    const radius = 2.7 + shellDepth * 2.25 + Math.min(3.7, Math.sqrt(shell.length) * 0.19);
    shell.forEach((node, index) => {
      const vertical = 1 - 2 * ((index + 0.5) / shell.length);
      const radial = Math.sqrt(Math.max(0, 1 - vertical * vertical));
      const theta = GOLDEN_ANGLE * index + hashUnit(node.id) * 1.4;
      let x = Math.cos(theta) * radial * radius;
      const y = vertical * radius * 0.8;
      const z = Math.sin(theta) * radial * radius;
      if (node.source === "hub") x = Math.abs(x) + shellDepth * 0.45;
      if (node.source === "local") x = -Math.abs(x) - shellDepth * 0.3;
      const point = new THREE.Vector3(x, y, z);
      positions.set(node.id, point);
      extent = Math.max(extent, point.length() + nodeRadius(node.size));
    });
  }
  if (nodes.length === 1 && !positions.has(nodes[0].id)) positions.set(nodes[0].id, new THREE.Vector3());
  const zCoordinates = [...positions.values()].map((position) => position.z);
  const depthSpan = zCoordinates.length > 1 ? Math.max(...zCoordinates) - Math.min(...zCoordinates) : 0;
  return { positions, extent, depthSpan };
}

function createEdgeGeometry(edges: OntologySceneEdge[], positions: Map<string, THREE.Vector3>, active: boolean) {
  const coordinates: number[] = [];
  for (const edge of edges) {
    if ((edge.status === "active") !== active) continue;
    const start = positions.get(edge.from);
    const end = positions.get(edge.to);
    if (!start || !end) continue;
    const middle = start.clone().add(end).multiplyScalar(0.5);
    const direction = end.clone().sub(start);
    const perpendicular = direction.clone().cross(new THREE.Vector3(0, 1, 0));
    if (perpendicular.lengthSq() < 0.001) perpendicular.cross(new THREE.Vector3(1, 0, 0));
    const bend = (0.12 + Math.min(0.48, direction.length() * 0.028)) * (hashUnit(edge.id) > 0.5 ? 1 : -1);
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
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const layout = useMemo(() => buildSphericalLayout(props.nodes, props.edges, props.rootId), [props.edges, props.nodes, props.rootId]);

  useEffect(() => {
    const root = rootRef.current;
    const tooltip = tooltipRef.current;
    if (!root || !tooltip || props.nodes.length === 0) {
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
    const nodeIndex = new Map(props.nodes.map((node, index) => [node.id, index]));
    const initialRadius = Math.max(3.6, layout.extent);
    const largestNodeRadius = props.nodes.reduce((largest, node) => Math.max(largest, nodeRadius(node.size)), 0);

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

    const activeEdgeGeometry = createEdgeGeometry(props.edges, layout.positions, true);
    const secondaryEdgeGeometry = createEdgeGeometry(props.edges, layout.positions, false);
    const activeEdgeMaterial = new THREE.LineBasicMaterial({ color: "#9bc8b3", transparent: true, opacity: 0.48, depthWrite: false });
    const secondaryEdgeMaterial = new THREE.LineBasicMaterial({ color: "#52615b", transparent: true, opacity: 0.2, depthWrite: false });
    scene.add(new THREE.LineSegments(secondaryEdgeGeometry, secondaryEdgeMaterial));
    scene.add(new THREE.LineSegments(activeEdgeGeometry, activeEdgeMaterial));

    const nodeGeometry = new THREE.SphereGeometry(1, 24, 18);
    const nodeMatcap = createSoftMatcap();
    const nodeMaterial = new THREE.MeshMatcapMaterial({
      color: "#ffffff",
      matcap: nodeMatcap,
    });
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
    controls.minDistance = 4.2;
    controls.maxDistance = Math.max(34, layout.extent * 4.2);
    controls.target.set(0, 0, 0);
    controls.update();

    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const dummy = new THREE.Object3D();

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

    const updateAppearance = (selectedId: string, focusedId: string | null) => {
      const neighbors = new Set<string>();
      if (focusedId) {
        neighbors.add(focusedId);
        for (const edge of props.edges) {
          if (edge.from === focusedId) neighbors.add(edge.to);
          if (edge.to === focusedId) neighbors.add(edge.from);
        }
      }
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

    const runCommand = (command: OntologyCameraCommand) => {
      const offset = camera.position.clone().sub(controls.target);
      if (command.type === "reset") {
        setCamera(
          new THREE.Vector3(initialRadius * 1.12, initialRadius * 0.58, initialRadius * 2.38),
          new THREE.Vector3(),
        );
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
      activeEdgeGeometry.dispose();
      secondaryEdgeGeometry.dispose();
      activeEdgeMaterial.dispose();
      secondaryEdgeMaterial.dispose();
      nodeGeometry.dispose();
      nodeMatcap.dispose();
      nodeMaterial.dispose();
      haloGeometry.dispose();
      selectedHaloMaterial.dispose();
      hoverHaloMaterial.dispose();
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
      data-depth-span={layout.depthSpan.toFixed(4)}
      data-scene-radius={layout.extent.toFixed(4)}
    >
      <div ref={tooltipRef} className={styles.hoverLabel3d} data-testid="ontology-node-hover-label" hidden aria-hidden="true" />
    </div>
  );
}
