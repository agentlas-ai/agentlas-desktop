import { assetSummary } from "./blocks/core";
import { canvasFormat } from "./kit";
import { isBaseCanvasBlock, type CanvasAssetBlock, type CanvasBlock, type CanvasView } from "./schema";

/**
 * The card as plain text, one line per block: what a phone shows when the drawn card cannot be shown (the visual is over its size limit or
 * refused), and what a screen reader or a log reads. Asset blocks write their own summary (blocks/); the 12 figure blocks are summarised here.
 */
const join = (items: string[], max = 6) => items.slice(0, max).join("; ") + (items.length > max ? "; …" : "");
function figureSummary(b: CanvasBlock): string {
  const head = b.title ? `${b.title}: ` : "";
  switch (b.type) {
    case "kpis": return head + join(b.items.map(i => `${i.label} ${typeof i.value === "string" ? i.value : canvasFormat(i.value, i.unit, false)}`));
    case "bars": return head + join(b.rows.map(r => `${r.label} ${r.values.map(v => canvasFormat(v, b.unit, false)).join(" → ")}`));
    case "ranges": return head + join(b.items.map(i => `${i.label} ${canvasFormat(i.low, i.unit ?? b.unit, false)}–${canvasFormat(i.high, i.unit ?? b.unit, false)}`));
    case "chart": return head + (b.lines.length ? join(b.lines.map(l => `${l.label} ${l.points[0]?.date ?? ""} → ${l.points[l.points.length - 1]?.date ?? ""}`)) : "chart");
    case "leans": return head + join(b.rows.map(r => `${r.name}: ${r.direction}`));
    case "table": return head + b.columns.map(c => c.label).join(" | ") + ` (${b.rows.length} rows)`;
    case "heatmap": return head + `${b.rows.length} × ${b.columns.length} grid`;
    case "allocation": return head + join(b.items.map(i => `${i.label} ${Math.round(i.weight)}`));
    case "timeline": return head + join(b.items.map(i => `${i.date} ${i.label}`));
    case "checklist": return head + join(b.items.map(i => `${i.text} (${i.state})`));
    case "gauge": return `${b.label}: ${b.value}`;
    case "note": return `${head}${b.text}`;
  }
}
export function canvasSummaryLines(view: CanvasView): string[] {
  const lines = [view.title, ...view.blocks.map(b => (isBaseCanvasBlock(b) ? figureSummary(b) : assetSummary(b as CanvasAssetBlock)))].map(line => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  if (view.sources.length) lines.push(`Sources: ${view.sources.map(s => s.title).join("; ")}`);
  return lines.map(line => (line.length > 500 ? `${line.slice(0, 499)}…` : line)).slice(0, 20);
}
