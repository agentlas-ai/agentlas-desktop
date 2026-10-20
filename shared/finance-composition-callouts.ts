/**
 * Leader-line labels for composition donuts. Each slice keeps its colour and gets a line out to a label beside the chart instead of
 * a legend underneath. Everything here is plain arithmetic in the chart's own pixel space (origin at the plot's top-left corner), so
 * the stored Vega-Lite spec carries finished coordinates and needs no expression, and every host draws the same picture.
 */
export const COMPOSITION_CALLOUT_GEOMETRY = {
  /** Plot size in pixels; the donut sits in the middle. */
  width: 464, height: 212, padding: 4,
  outer: 68, inner: 42,
  /** Gap between the ring and the first pixel of a leader line. */
  edgeGap: 3,
  /** Radius where the radial stub ends and the line turns horizontal. */
  elbowRadius: 82,
  /** Distance from the centre to where the horizontal run ends, and to the label column. */
  shelfX: 88, columnX: 100,
  /** Space between the end of the line and the first glyph. */
  labelGap: 4,
  /** Longest label in pixels; longer text is cut with an ellipsis. Wide enough for a share and a six-digit code with its market suffix (18.42% 005930.KS). */
  labelLimit: 128,
  /** Smallest vertical step between two labels of one column, and the floor when a column is crowded. */
  rowGap: 16, rowGapMin: 12,
  /** Distance kept between a label's centre line and the plot's top or bottom edge. */
  margin: 10,
} as const;

export type CompositionCalloutGeometry = { readonly [K in keyof typeof COMPOSITION_CALLOUT_GEOMETRY]: number };

export interface CompositionCalloutLine { readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
export interface CompositionCallout {
  /** Slice start and end in radians, clockwise from twelve o'clock. */
  readonly start: number; readonly end: number;
  readonly side: 'left' | 'right';
  /** Radial stub, then a horizontal run, then (only when the label had to move) a short slanted link to the label column. */
  readonly lines: readonly CompositionCalloutLine[];
  /** Where the label text starts (right column) or ends (left column). */
  readonly label: { readonly x: number; readonly y: number };
}

const TAU = Math.PI * 2;
const pixel = (value: number) => Math.round(value * 100) / 100;
const radian = (value: number) => Math.round(value * 1e6) / 1e6;

/** Keeps labels in order, at least `gap` apart and inside [top, bottom], moving each as little as a simple sweep allows. */
function spread(wanted: readonly number[], top: number, bottom: number, gap: number): number[] {
  const y = wanted.map(value => Math.min(bottom, Math.max(top, value)));
  for (let k = 1; k < y.length; k++) y[k] = Math.max(y[k], y[k - 1] + gap);
  if (y.length && y[y.length - 1] > bottom) {
    y[y.length - 1] = bottom;
    for (let k = y.length - 2; k >= 0; k--) y[k] = Math.min(y[k], y[k + 1] - gap);
  }
  return y;
}

/** Shares must be finite, non-negative and sum to one; the caller has already checked that. */
export function compositionCalloutLayout(shares: readonly number[], geometry: CompositionCalloutGeometry = COMPOSITION_CALLOUT_GEOMETRY): readonly CompositionCallout[] {
  const g = geometry, cx = g.width / 2, cy = g.height / 2;
  let cumulative = 0;
  const slices = shares.map((share, index) => {
    const start = Math.min(cumulative, 1) * TAU;
    cumulative += share;
    const end = (index === shares.length - 1 ? 1 : Math.min(cumulative, 1)) * TAU;
    const mid = (start + end) / 2;
    return { index, start, end, sin: Math.sin(mid), cos: Math.cos(mid), side: (Math.sin(mid) >= 0 ? 1 : -1) as 1 | -1, elbowY: cy - g.elbowRadius * Math.cos(mid), y: 0 };
  });
  for (const side of [1, -1] as const) {
    const column = slices.filter(slice => slice.side === side).sort((a, b) => a.elbowY - b.elbowY || a.index - b.index);
    const top = g.margin, bottom = g.height - g.margin;
    const gap = column.length > 1 ? Math.min(g.rowGap, Math.max(g.rowGapMin, (bottom - top) / (column.length - 1))) : 0;
    spread(column.map(slice => slice.elbowY), top, bottom, gap).forEach((y, k) => { column[k].y = y; });
  }
  return slices.map(slice => {
    const s = slice.side, edge = g.outer + g.edgeGap;
    const start = { x: cx + edge * slice.sin, y: cy - edge * slice.cos };
    const elbow = { x: cx + g.elbowRadius * slice.sin, y: slice.elbowY };
    const shelf = { x: cx + s * g.shelfX, y: slice.elbowY };
    const column = { x: cx + s * g.columnX, y: slice.y };
    const lines: CompositionCalloutLine[] = [{ x1: start.x, y1: start.y, x2: elbow.x, y2: elbow.y }];
    if (Math.abs(slice.y - slice.elbowY) < .5) lines.push({ x1: elbow.x, y1: elbow.y, x2: column.x, y2: elbow.y });
    else lines.push({ x1: elbow.x, y1: elbow.y, x2: shelf.x, y2: shelf.y }, { x1: shelf.x, y1: shelf.y, x2: column.x, y2: column.y });
    return {
      start: radian(slice.start), end: radian(slice.end), side: s > 0 ? 'right' : 'left',
      lines: lines.map(line => ({ x1: pixel(line.x1), y1: pixel(line.y1), x2: pixel(line.x2), y2: pixel(line.y2) })),
      label: { x: pixel(column.x + s * g.labelGap), y: pixel(column.y) },
    };
  });
}
