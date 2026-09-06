"use client";

import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { layoutOneMemoryMap, type OneMemoryMapPlacedNode } from "@/lib/one-memory-map-layout";
import type { OneMemoryMapSnapshot } from "@shared/one-memory-map";
import styles from "./OneMemoryMap.module.css";

interface Props {
  snapshot: OneMemoryMapSnapshot;
  locale: "ko" | "en";
}

interface Size { width: number; height: number }

const COPY = {
  ko: {
    kind: "종류",
    project: "프로젝트",
    scope: "범위",
    relations: "연결",
    evidence: "근거",
    shared: "One shared",
    keyboard: "방향키로 기억을 탐색하고 Esc 키로 선택을 해제할 수 있습니다.",
  },
  en: {
    kind: "Kind",
    project: "Project",
    scope: "Scope",
    relations: "Links",
    evidence: "Evidence",
    shared: "One shared",
    keyboard: "Use the arrow keys to explore memories and Escape to clear selection.",
  },
} as const;

function useElementSize(ref: React.RefObject<HTMLElement | null>): Size {
  const [size, setSize] = useState<Size>({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) => current.width === rect.width && current.height === rect.height
        ? current
        : { width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function drawRoundedCell(
  context: CanvasRenderingContext2D,
  node: OneMemoryMapPlacedNode,
  fill: string,
): void {
  const left = node.cx - node.size / 2;
  const top = node.cy - node.size / 2;
  context.beginPath();
  context.roundRect(left, top, node.size, node.size, Math.max(1, node.size * 0.16));
  context.fillStyle = fill;
  context.fill();
}

function memoryGray(density: number): string {
  const gray = Math.round(243 - Math.pow(Math.max(0, Math.min(1, density)), 1.28) * 136);
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function clusterCenters(nodes: OneMemoryMapPlacedNode[]): Map<string, { x: number; y: number }> {
  const sums = new Map<string, { x: number; y: number; count: number }>();
  for (const node of nodes) {
    const value = sums.get(node.clusterKey) ?? { x: 0, y: 0, count: 0 };
    value.x += node.cx;
    value.y += node.cy;
    value.count += 1;
    sums.set(node.clusterKey, value);
  }
  return new Map([...sums.entries()].map(([key, value]) => [key, {
    x: value.x / value.count,
    y: value.y / value.count,
  }]));
}

function OneMemoryMapComponent({ snapshot, locale }: Props) {
  const copy = COPY[locale];
  const rootRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const size = useElementSize(rootRef);
  const layout = useMemo(
    () => layoutOneMemoryMap(snapshot, size.width, size.height),
    [size.height, size.width, snapshot],
  );
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  const activeId = pinnedId ?? hoveredId;
  const nodesById = useMemo(() => new Map(layout.nodes.map((node) => [node.id, node])), [layout.nodes]);
  const activeNode = activeId ? nodesById.get(activeId) ?? null : null;

  const hitBuckets = useMemo(() => {
    const bucketSize = 18;
    const buckets = new Map<string, OneMemoryMapPlacedNode[]>();
    for (const node of layout.nodes) {
      const key = `${Math.floor(node.cx / bucketSize)}:${Math.floor(node.cy / bucketSize)}`;
      const bucket = buckets.get(key) ?? [];
      bucket.push(node);
      buckets.set(key, bucket);
    }
    return { bucketSize, buckets };
  }, [layout.nodes]);

  useEffect(() => {
    if (pinnedId && !nodesById.has(pinnedId)) setPinnedId(null);
    if (hoveredId && !nodesById.has(hoveredId)) setHoveredId(null);
  }, [hoveredId, nodesById, pinnedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || size.width <= 0 || size.height <= 0) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.max(1, Math.floor(size.width * dpr));
    canvas.height = Math.max(1, Math.floor(size.height * dpr));
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = "var(--paper)";
    context.fillRect(0, 0, size.width, size.height);

    const centers = clusterCenters(layout.nodes);
    const clusterLinks = new Map<string, { from: string; to: string; count: number }>();
    for (const edge of snapshot.edges) {
      const from = nodesById.get(edge.from);
      const to = nodesById.get(edge.to);
      if (!from || !to || from.clusterKey === to.clusterKey) continue;
      const key = from.clusterKey < to.clusterKey
        ? `${from.clusterKey}\u0000${to.clusterKey}`
        : `${to.clusterKey}\u0000${from.clusterKey}`;
      const value = clusterLinks.get(key) ?? {
        from: from.clusterKey < to.clusterKey ? from.clusterKey : to.clusterKey,
        to: from.clusterKey < to.clusterKey ? to.clusterKey : from.clusterKey,
        count: 0,
      };
      value.count += 1;
      clusterLinks.set(key, value);
    }
    context.lineCap = "round";
    for (const link of [...clusterLinks.values()]
      .filter((value) => value.count >= 2)
      .sort((a, b) => b.count - a.count)
      .slice(0, 14)) {
      const from = centers.get(link.from);
      const to = centers.get(link.to);
      if (!from || !to) continue;
      const strength = Math.min(1, link.count / 5) * (1 - layout.fieldBlend * 0.62);
      context.beginPath();
      context.moveTo(from.x, from.y);
      const midpointX = (from.x + to.x) / 2;
      const midpointY = (from.y + to.y) / 2 - Math.min(18, Math.abs(to.x - from.x) * 0.04);
      context.quadraticCurveTo(midpointX, midpointY, to.x, to.y);
      context.strokeStyle = `rgba(86, 90, 93, ${0.025 + strength * 0.045})`;
      context.lineWidth = 0.7 + strength * 0.45;
      context.stroke();
    }

    if (activeNode) {
      for (const edge of snapshot.edges) {
        if (edge.from !== activeNode.id && edge.to !== activeNode.id) continue;
        const other = nodesById.get(edge.from === activeNode.id ? edge.to : edge.from);
        if (!other) continue;
        context.beginPath();
        context.moveTo(activeNode.cx, activeNode.cy);
        context.lineTo(other.cx, other.cy);
        context.strokeStyle = edge.relation === "contradicts"
          ? "rgba(31, 33, 35, 0.58)"
          : edge.relation === "supersedes"
            ? "rgba(55, 58, 60, 0.46)"
            : "rgba(74, 77, 80, 0.30)";
        context.lineWidth = edge.relation === "similar_to" ? 0.8 : 1.15;
        context.stroke();
      }
    }

    for (const node of layout.nodes) {
      drawRoundedCell(context, node, node.id === activeId ? "var(--black)" : memoryGray(node.density));
    }
  }, [activeId, activeNode, layout, nodesById, size.height, size.width, snapshot.edges]);

  const nodeAtPointer = (event: PointerEvent<HTMLCanvasElement>): OneMemoryMapPlacedNode | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const column = Math.floor(x / hitBuckets.bucketSize);
    const row = Math.floor(y / hitBuckets.bucketSize);
    let nearest: OneMemoryMapPlacedNode | null = null;
    let nearestDistance = Infinity;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = hitBuckets.buckets.get(`${column + dx}:${row + dy}`) ?? [];
        for (const node of bucket) {
          const distance = Math.hypot(node.cx - x, node.cy - y);
          if (distance <= Math.max(5, node.size * 0.78) && distance < nearestDistance) {
            nearest = node;
            nearestDistance = distance;
          }
        }
      }
    }
    return nearest;
  };

  const handlePointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    const node = nodeAtPointer(event);
    setHoveredId((current) => current === node?.id ? current : node?.id ?? null);
    event.currentTarget.style.cursor = node ? "pointer" : "default";
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setPinnedId(null);
      setHoveredId(null);
      return;
    }
    const ordered = [...layout.nodes].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
    if (ordered.length === 0) return;
    const current = activeId ? ordered.findIndex((node) => node.id === activeId) : -1;
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = ordered[(current + delta + ordered.length) % ordered.length];
    setPinnedId(next.id);
    setHoveredId(null);
  };

  const tooltipStyle = activeNode ? {
    left: Math.max(12, Math.min(size.width - 228, activeNode.cx + (activeNode.cx > size.width * 0.68 ? -222 : 14))),
    top: Math.max(58, Math.min(size.height - 154, activeNode.cy - 34)),
  } : undefined;

  return (
    <section ref={rootRef} className={styles.map} aria-label={locale === "ko" ? "메모리 맵" : "Memory map"}>
      <canvas
        ref={canvasRef}
        className={styles.canvas}
        role="img"
        tabIndex={0}
        aria-label={`One. ${copy.keyboard}`}
        aria-describedby={activeNode ? "one-memory-map-tooltip" : undefined}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoveredId(null)}
        onClick={() => {
          if (!hoveredId) return;
          setPinnedId((current) => current === hoveredId ? null : hoveredId);
        }}
        onKeyDown={handleKeyDown}
      />

      {activeNode && tooltipStyle && (
        <div id="one-memory-map-tooltip" className={styles.tooltip} style={tooltipStyle} role="status" aria-live="polite">
          <dl>
            <div><dt>{copy.kind}</dt><dd>{activeNode.kind}</dd></div>
            <div><dt>{copy.project}</dt><dd>{activeNode.projectSlug ?? copy.shared}</dd></div>
            <div><dt>{copy.scope}</dt><dd>One / {activeNode.scope}</dd></div>
            <div><dt>{copy.relations}</dt><dd>{activeNode.relationCount}</dd></div>
            <div><dt>{copy.evidence}</dt><dd>{activeNode.evidenceCount}</dd></div>
          </dl>
        </div>
      )}
      <p className={styles.srOnly}>{copy.keyboard}</p>
    </section>
  );
}

export const OneMemoryMap = memo(OneMemoryMapComponent);
