// The one usage meter (feature registry "usage-meter"). Every screen that shows AI usage draws it HERE: the sidebar, its popup, the
// dashboard rows, the key banner, the build screen, the room's limit line. The number is the percent USED and nothing else (decision: no credit count,
// no "remaining / allowance"). Words come from lib/usage-copy.ts. The root carries data-feature/data-impl so a screen test can prove that no second
// implementation draws usage text (scripts/test-r3-g2-g3-one-implementation.cjs and the V2 app test).
"use client";
import type { CSSProperties, ReactNode } from "react";
import { usageHeadLabel, usageMeterModel, type UsageTone } from "@/lib/usage-copy";

export const USAGE_METER_FEATURE = "usage-meter" as const;
export const USAGE_METER_IMPL = "usage-meter" as const;
/** The attributes every usage text carries; exported so the registry and the screen tests name the same pair. */
export const USAGE_METER_ATTRS = { "data-feature": USAGE_METER_FEATURE, "data-impl": USAGE_METER_IMPL } as const;

export type UsageMeterVariant =
  /** Sidebar: label + percent, window line, a thin bar. `collapsed` keeps only the bar. */
  | "sidebar"
  /** The popup under the sidebar: label + percent, a progress bar, the window/exhausted/extra lines as children. */
  | "popup"
  /** A dashboard row: bar + one text beside it. */
  | "row"
  /** One line of words: "AI usage 42%" (banner, credits row). */
  | "inline"
  /** Words only, no number: "hit a usage limit...", "Skipped: ..." (limit lines). */
  | "note";

const FILL: Record<UsageTone, string> = {
  unknown: "var(--muted-deep)",
  ok: "linear-gradient(90deg, #34C77B, #1FA463)",
  warn: "linear-gradient(90deg, #F5B544, #E0921A)",
  hot: "linear-gradient(90deg, #F2706A, #D9443B)",
};

export interface UsageMeterProps {
  variant: UsageMeterVariant;
  ko: boolean;
  /** The percent USED (lib/usage-copy usedPercentOf / a provider window's usedPercent). null = unknown (the words, never a count). Ignored by "note". */
  percent?: number | null;
  /** Replaces the head label ("AI usage"); a provider window's own name in a row. */
  label?: string;
  /** What names the window under the percent ("This week · resets Monday"), or the row's own text beside the bar ("42% · resets in 3h"). */
  detail?: string;
  /** Words for a "note" variant. */
  note?: string;
  collapsed?: boolean;
  /** Extra lines of the popup, drawn under the bar. */
  children?: ReactNode;
  className?: string;
  /** The class of the number beside a "row" bar (the dashboard's own column style). */
  numClassName?: string;
  style?: CSSProperties;
  title?: string;
  testId?: string;
}

function Bar({ model, ko, label, width, height = 4, flex = false }: { model: ReturnType<typeof usageMeterModel>; ko: boolean; label: string; width: number | string; height?: number; flex?: boolean }) {
  return (
    <span
      role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={model.percent ?? 0} aria-valuetext={model.valueText}
      data-tone={model.tone}
      style={{ display: "block", ...(flex ? { flex: 1, minWidth: 24 } : { width }), height, margin: typeof width === "number" ? "0 auto" : 0, borderRadius: 999, background: "var(--fill-2, rgba(0,0,0,0.08))", overflow: "hidden" }}
    >
      <span style={{ display: "block", width: `${model.fill}%`, height: "100%", borderRadius: 999, background: FILL[model.tone], transition: "width 400ms ease" }} />
    </span>
  );
}

export function UsageMeter(props: UsageMeterProps) {
  const { variant, ko, percent, detail, note, collapsed = false, children, className, numClassName, style, title, testId } = props;
  if (variant === "note") return <span {...USAGE_METER_ATTRS} data-variant="note" className={className} style={style} title={title} data-testid={testId}>{note}</span>;
  const model = usageMeterModel(percent, ko);
  const label = props.label ?? usageHeadLabel(ko);

  if (variant === "inline") {
    return <span {...USAGE_METER_ATTRS} data-variant="inline" data-tone={model.tone} className={className} style={style} title={title} data-testid={testId ?? "usage-meter"}>{label} · {detail ?? model.text}</span>;
  }
  if (variant === "row") {
    return (
      <div {...USAGE_METER_ATTRS} data-variant="row" data-tone={model.tone} className={className} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, ...style }} title={title} data-testid={testId ?? "usage-meter"}>
        <Bar model={model} ko={ko} label={label} width="100%" flex />
        <span className={numClassName} data-testid="usage-percent" data-warn={model.tone === "hot" || model.tone === "warn" ? "true" : "false"}>{detail ?? model.text}</span>
      </div>
    );
  }
  if (variant === "popup") {
    return (
      <div {...USAGE_METER_ATTRS} data-variant="popup" data-tone={model.tone} className={className} style={style} title={title} data-testid={testId ?? "usage-meter"}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
          <span style={{ color: "var(--muted-deep)" }}>{label}</span>
          <strong data-testid="usage-percent" style={{ fontVariantNumeric: "tabular-nums" }}>{model.text}</strong>
        </div>
        {model.percent !== null && <progress aria-label={label} max={100} value={model.percent} style={{ width: "100%", height: 6, accentColor: "var(--accent)" }} />}
        {children}
      </div>
    );
  }
  // sidebar
  return (
    <div {...USAGE_METER_ATTRS} data-variant="sidebar" data-tone={model.tone} className={className} title={title} data-testid={testId ?? "usage-meter"}
      style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", minWidth: 0, ...style }}>
      {!collapsed && (
        <span style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, fontSize: 10.5, lineHeight: 1 }}>
          <span style={{ color: "var(--muted-deep)" }}>{label}</span>
          <span data-testid="usage-percent" style={{ color: "var(--muted-deep)", fontVariantNumeric: "tabular-nums" }}>{model.text}</span>
        </span>
      )}
      {!collapsed && detail && <span data-testid="usage-line" style={{ fontSize: 10.5, lineHeight: 1.2, color: "var(--muted-deep)" }}>{detail}</span>}
      <Bar model={model} ko={ko} label={label} width={collapsed ? 24 : "100%"} />
    </div>
  );
}
