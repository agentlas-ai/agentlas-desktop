"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { chartRejectMessage, chartThemeConfig, quietDefaultTitles, sanitizeChartSpec } from "@/lib/chart-spec";
import {
  announceVisual,
  copyPngDataUrl,
  documentIsKorean,
  downloadDataUrl,
  readVisualTheme,
  requestVisualOpen,
  safeFileStem,
  useVisualChatScope,
  type VisualArtifact,
} from "@/lib/visual-artifacts";
import { useVisualThemeKey } from "./HtmlVisualBlock";
import styles from "./VisualBlock.module.css";
import { VisualMenu } from "./VisualMenu";

interface ChartView {
  toImageURL(type: "png" | "svg", scale?: number): Promise<string>;
  width(value: number): ChartView;
  finalize(): void;
  runAsync(): Promise<unknown>;
}

/** 어떤 로드도 하지 않는 로더 — 스펙 관문 뒤의 두 번째 겹(네트워크 0). */
const NO_NETWORK_LOADER = {
  load: () => Promise.reject(new Error("network disabled")),
  sanitize: () => Promise.reject(new Error("network disabled")),
  http: () => Promise.reject(new Error("network disabled")),
  file: () => Promise.reject(new Error("network disabled")),
};

/**
 * 선 차트의 범례 견본은 vega-lite 가 "선"으로 그려(채움 투명) 우리 둥근 사각 견본이 비어 보인다.
 * 실측 디자인은 선·점선 계열도 꽉 찬 사각이므로, 선 색 척도를 채움에도 걸어 준다.
 */
function solidLegendSwatches(spec: Record<string, unknown>): Record<string, unknown> {
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const group = node as Record<string, unknown>;
    if (Array.isArray(group.legends)) {
      for (const legend of group.legends as Array<Record<string, unknown>>) {
        if (typeof legend.stroke === "string" && legend.fill === undefined) legend.fill = legend.stroke;
        // 점선 계열도 견본은 꽉 찬 사각 — 점선 척도가 견본 테두리를 톱니로 만들지 않게.
        delete legend.strokeDash;
        const update = ((legend.encode as Record<string, Record<string, Record<string, unknown>>> | undefined)?.symbols?.update);
        if (update) {
          delete update.fill;
          delete update.strokeDash;
          update.opacity = { value: 1 };
          update.strokeWidth = { value: 0 };
        }
      }
    }
    if (Array.isArray(group.marks)) (group.marks as unknown[]).forEach(visit);
  };
  visit(spec);
  return spec;
}

function chartTitle(spec: Record<string, unknown>, ko: boolean): string {
  const title = spec.title;
  if (typeof title === "string" && title.trim()) return title.trim().slice(0, 120);
  if (title && typeof title === "object" && typeof (title as { text?: unknown }).text === "string") {
    return String((title as { text: string }).text).trim().slice(0, 120);
  }
  return ko ? "차트" : "Chart";
}

/**
 * ```chart / ```vega-lite 펜스를 대화 안의 살아 있는 차트로. 관문을 못 넘으면 원문 코드블록 +
 * 사람 말 사유 한 줄. JSON 이 아직 덜 온(스트리밍) 동안은 사유 없이 원문만 — Mermaid 와 같은 규칙.
 */
export function ChartBlock({
  code,
  blockId,
  fallback,
  size = "inline",
  presetSpec,
}: {
  code: string;
  blockId: string;
  fallback: ReactNode;
  size?: "inline" | "panel" | "thumb";
  /** 패널이 이미 관문을 통과한 스펙으로 다시 그릴 때. */
  presetSpec?: Record<string, unknown>;
}) {
  const chatId = useVisualChatScope();
  const ko = documentIsKorean();
  const themeKey = useVisualThemeKey();
  const checked = useMemo(() => (presetSpec ? sanitizeChartSpec(presetSpec) : sanitizeChartSpec(code)), [code, presetSpec]);
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<ChartView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const title = checked.ok ? chartTitle(checked.spec, ko) : "";

  useEffect(() => {
    if (!checked.ok) return undefined;
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let view: ChartView | null = null;
    let resize: ResizeObserver | null = null;
    setState("loading");
    void (async () => {
      try {
        const [vegaLite, vega, interpreter] = await Promise.all([
          import("vega-lite"),
          import("vega"),
          import("vega-interpreter"),
        ]);
        if (cancelled) return;
        const theme = chartThemeConfig(readVisualTheme());
        const userConfig = (checked.spec.config && typeof checked.spec.config === "object") ? checked.spec.config as Record<string, unknown> : {};
        // 모델 config 는 한 단계 깊이로 얹는다 — config.axis 하나가 우리 축 규칙 전체를 지우지 않게.
        const config: Record<string, unknown> = { ...theme };
        for (const [key, value] of Object.entries(userConfig)) {
          const base = theme[key];
          config[key] = base && typeof base === "object" && !Array.isArray(base) && value && typeof value === "object" && !Array.isArray(value)
            ? { ...(base as Record<string, unknown>), ...(value as Record<string, unknown>) }
            : value;
        }
        const spec: Record<string, unknown> = {
          width: "container",
          ...quietDefaultTitles(checked.spec),
          autosize: { type: "fit-x", contains: "padding", resize: true },
          config,
        };
        if (size === "panel" && spec.height === undefined) spec.height = 300;
        if (size === "thumb") {
          // 산출물 격자의 작은 미리보기 — 제목·범례 없이 모양만.
          spec.height = 84;
          delete spec.title;
          config.legend = { ...(config.legend as Record<string, unknown>), disable: true };
          config.axis = { ...(config.axis as Record<string, unknown>), labels: false, grid: false };
        }
        const mount = async (stackLegend: boolean) => {
          const legendConfig = stackLegend ? { ...config, legend: { ...(config.legend as Record<string, unknown>), columns: 1 } } : config;
          const compiled = solidLegendSwatches(vegaLite.compile({ ...spec, config: legendConfig } as never).spec as unknown as Record<string, unknown>);
          const runtime = vega.parse(compiled as never, undefined, { ast: true });
          host.replaceChildren();
          // View 는 이 지역 변수에만 — window 에 붙이지 않는다(CVE-2025-59840 완화).
          const next = new vega.View(runtime, {
            renderer: "svg",
            container: host,
            hover: true,
            expr: interpreter.expressionInterpreter,
            loader: NO_NETWORK_LOADER as never,
          }) as unknown as ChartView;
          await next.runAsync();
          return next;
        };
        view = await mount(false);
        if (cancelled) { view.finalize(); return; }
        // 가로 범례가 좁은 칸을 넘으면 라벨이 잘린다(실측: 오른쪽 패널을 연 One 칸) — 한 줄에 하나씩 쌓는다.
        const legendEl = host.querySelector(".role-legend");
        if (legendEl && legendEl.getBoundingClientRect().right > host.getBoundingClientRect().right + 1) {
          view.finalize();
          view = await mount(true);
          if (cancelled) { view.finalize(); return; }
        }
        viewRef.current = view;
        setState("ready");
        // Vega-Lite 의 "container" 폭은 창 크기 변화만 듣는다. 오른쪽 패널이 열려 대화 칸이 좁아지면
        // 차트가 옛 폭으로 남아 CSS 로 쪼그라들었다(실측 2026-09-29) — 칸 폭을 직접 따라간다.
        let lastWidth = host.clientWidth;
        resize = new ResizeObserver(() => {
          const next = host.clientWidth;
          if (!view || next < 40 || Math.abs(next - lastWidth) < 2) return;
          lastWidth = next;
          void view.width(next).runAsync().catch(() => undefined);
        });
        resize.observe(host);
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
      resize?.disconnect();
      view?.finalize();
      viewRef.current = null;
      host.replaceChildren();
    };
  }, [checked, size, themeKey]);

  const visual: VisualArtifact | null = useMemo(() => (checked.ok && chatId
    ? { id: `chart:${blockId}`, chatId, kind: "chart", title, spec: checked.spec }
    : null), [checked, chatId, blockId, title]);
  useEffect(() => {
    if (visual && state === "ready" && size === "inline") announceVisual(visual);
  }, [visual, state, size]);

  if (!checked.ok) {
    const quiet = checked.code === "invalid-json" || checked.code === "empty";
    return <>
      {fallback}
      {!quiet && <p className={styles.refusal} data-chart-refusal={checked.code}>{chartRejectMessage(checked.code, ko)}</p>}
    </>;
  }
  if (state === "error") {
    return <>
      {fallback}
      <p className={styles.refusal} data-chart-refusal="render-failed">{ko ? "이 차트를 그리지 못했어요. 원문을 그대로 보여 드려요." : "This chart could not be drawn; showing the source."}</p>
    </>;
  }
  const save = async (type: "png" | "svg") => {
    const view = viewRef.current;
    if (!view) return;
    try {
      const url = await view.toImageURL(type, type === "png" ? 2 : 1);
      downloadDataUrl(url, `${safeFileStem(title)}.${type}`);
    } catch {
      /* 내보내기 실패는 차트를 지우지 않는다 */
    }
  };
  return (
    <figure className={styles.visual} data-size={size} data-visual-kind="chart" data-render-status={state} aria-label={title}>
      {state === "ready" && size !== "thumb" && <VisualMenu ko={ko} label={ko ? "차트 메뉴" : "Chart menu"} items={[
        { key: "copy", label: ko ? "클립보드에 복사" : "Copy to clipboard", run: async () => {
          const view = viewRef.current;
          if (!view) return false;
          try { return await copyPngDataUrl(await view.toImageURL("png", 2)); } catch { return false; }
        } },
        { key: "download", label: ko ? "파일 다운로드 (PNG)" : "Download file (PNG)", run: () => void save("png") },
        { key: "download-svg", label: ko ? "SVG 로 다운로드" : "Download as SVG", run: () => void save("svg") },
        ...(visual && size === "inline" ? [{ key: "panel", label: ko ? "패널에서 열기" : "Open in panel", run: () => { requestVisualOpen(visual); } }] : []),
      ]} />}
      {state === "loading" && <div className={styles.loading} aria-hidden="true" />}
      <div ref={hostRef} className={styles.chartHost} data-chart-host="true" />
    </figure>
  );
}
