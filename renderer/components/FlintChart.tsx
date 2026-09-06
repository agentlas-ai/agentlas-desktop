"use client";

import { useEffect, useRef, useState } from "react";
import type { FlintChartRenderInput } from "@/lib/flint-runtime";
import { renderFlintChart } from "@/lib/flint-runtime";

export function FlintChart({
  input,
  title,
}: {
  input: FlintChartRenderInput;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let handle: { destroy(): void } | null = null;
    const container = containerRef.current;
    if (!container) return undefined;
    container.replaceChildren();
    setStatus("loading");
    setError(null);
    void renderFlintChart(container, input)
      .then((nextHandle) => {
        if (!active) {
          nextHandle.destroy();
          return;
        }
        handle = nextHandle;
        setStatus("ready");
      })
      .catch((reason: unknown) => {
        if (!active) return;
        container.replaceChildren();
        setStatus("error");
        setError(reason instanceof Error ? reason.message : "Unknown renderer error");
      });
    return () => {
      active = false;
      handle?.destroy();
      handle = null;
      container.replaceChildren();
    };
  }, [input]);

  return (
    <div
      data-surface-renderer="flint-vega"
      data-render-status={status}
      aria-label={title}
      style={{
        minHeight: 180,
        border: "1px solid rgba(148, 163, 184, 0.28)",
        borderRadius: 14,
        padding: 12,
        background: "rgba(255,255,255,0.72)",
        overflow: "auto",
      }}
    >
      <div ref={containerRef} style={{ minHeight: 150 }} />
      {status === "loading" && <div style={{ color: "var(--info)", fontSize: 12 }}>Rendering chart…</div>}
      {status === "error" && (
        <div role="status" style={{ color: "var(--danger)", fontSize: 12 }}>
          Chart could not be rendered{error ? `: ${error}` : "."}
        </div>
      )}
    </div>
  );
}
