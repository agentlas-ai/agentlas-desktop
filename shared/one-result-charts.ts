import { isChartFenceLanguage, sanitizeChartSpec } from './chart-spec';
import type { OneResultChart } from './one-harness';

/** Uses the renderer's fence grammar and common chart gate. No remote data. */
export function oneResultCharts(markdown: string): OneResultChart[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const charts: OneResultChart[] = [];
  for (let i = 0; i < lines.length && charts.length < 32; i++) {
    const fence = lines[i].match(/^ {0,3}(`{3,}|~{3,})([\w+.-]*)(?:[ \t]+([^`]*?))?\s*$/);
    if (!fence) continue;
    const body: string[] = [];
    let complete = false;
    for (i++; i < lines.length; i++) {
      const close = lines[i].match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence[1][0] && close[1].length >= fence[1].length) { complete = true; break; }
      body.push(lines[i]);
    }
    if (!complete || !isChartFenceLanguage(fence[2])) continue;
    const checked = sanitizeChartSpec(body.join('\n'));
    if (!checked.ok) continue;
    const blockId = 'chart:' + charts.length;
    const series: OneResultChart['series'] = [];
    const visit = (node: Record<string, unknown>, inheritedRows: Record<string, unknown>[] = [], inheritedColor: string | null = null): void => {
      const data = node.data as { values?: unknown } | undefined;
      const rows = Array.isArray(data?.values) ? data.values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))) : inheritedRows;
      const encoding = node.encoding as { color?: { field?: unknown } } | undefined;
      const color = typeof encoding?.color?.field === 'string' ? encoding.color.field : inheritedColor;
      const children = ['layer', 'hconcat', 'vconcat', 'concat'].flatMap(key => Array.isArray(node[key]) ? node[key] as Record<string, unknown>[] : []);
      if (children.length) { children.forEach(child => visit(child, rows, color)); return; }
      const counts = new Map<string, number>();
      for (const row of rows) {
        const label = color ? String(row[color] ?? '') : 'Data';
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
      for (const [label, pointCount] of counts) {
        if (series.length < 128) series.push({ seriesId: blockId + ':series:' + series.length, label: label.slice(0, 200), pointCount });
      }
    };
    visit(checked.spec);
    const title = typeof checked.spec.title === 'string' ? checked.spec.title : 'Chart ' + (charts.length + 1);
    charts.push({ blockId, title: title.slice(0, 200), spec: checked.spec, series });
  }
  return charts;
}
