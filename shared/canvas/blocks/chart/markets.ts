import { z } from "zod";
import { canvasDay, esc } from "../../kit";
import { list, num, optionalNum, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { GREEN, GREEN_D, GRID, RED, ZERO, axis, cap, change, cmp, css, frame, maxTickWidth, moveColor, nn, nullable, p, pctText, pointLabels, short, svg, tick, tw } from "./_cartesian";

const dayText = (iso: string, ko: boolean) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? canvasDay(iso, ko) : iso);

/** A deterministic month of daily candles for the sample (a price drifting up with ordinary noise); real answers supply their own. */
const SAMPLE_CANDLES = (() => {
  const moves = [0.4, -0.6, 1.1, 0.8, -0.3, 1.4, -1.2, 0.5, 0.9, -0.7, 1.6, 0.3, -0.9, -1.3, 0.6, 1.2, 0.7, -0.4, 1.9, 0.5, -0.8, 0.9, 1.3, -0.5, 0.4, 1.1, -1.6, 0.8, 1.5, 0.6];
  const out: { date: string; open: number; high: number; low: number; close: number; volume: number }[] = [];
  let price = 184.2, day = new Date(Date.UTC(2026, 9, 1));
  for (const [i, m] of moves.entries()) {
    while (day.getUTCDay() === 0 || day.getUTCDay() === 6) day = new Date(day.getTime() + 864e5);
    const open = +(price * (1 + ((i % 3) - 1) * 0.0015)).toFixed(2), close = +(open * (1 + m / 100)).toFixed(2);
    const high = +(Math.max(open, close) * (1 + 0.0035 + (i % 4) * 0.0012)).toFixed(2), low = +(Math.min(open, close) * (1 - 0.003 - (i % 5) * 0.001)).toFixed(2);
    out.push({ date: day.toISOString().slice(0, 10), open, high, low, close, volume: Math.round((2.1 + Math.abs(m) * 0.9 + (i % 4) * 0.25) * 1e6) });
    price = close; day = new Date(day.getTime() + 864e5);
  }
  return out;
})();

/* ---------------------------------------------------------- candlestick_chart */
export const candlestickChart = defineAsset({
  type: "candlestick_chart", category: "chart", width: "half",
  use: "Open-high-low-close candles of a traded price over time, with an optional volume strip underneath.",
  useKo: "거래 가격의 시가·고가·저가·종가를 봉 차트로 그리고, 아래에 거래량을 함께 보여 줍니다.",
  tags: ["candlestick", "ohlc", "price", "stock", "volume", "캔들", "봉 차트", "주가", "거래량"],
  notes: "candles 3-60 in date order (date, open, high, low, close, optional volume). Green when the close is at or above the open, red below. unit defaults to usd_per_share; the last close is tagged on the right axis.",
  fields: { candles: list(z.object({ date: text(12), open: num, high: num, low: num, close: num, volume: optionalNum }).strip(), 3, 60), unit: unit.default("usd_per_share"), caption: optionalText(120) },
  sample: { title: "Nimbus Cloud (NMBS), daily", unit: "usd_per_share", candles: SAMPLE_CANDLES, caption: "Up 11% over 30 sessions, with heavier volume on the biggest moves." },
  render(b, { ko }) {
    type C = { date: string; open: number; high: number; low: number; close: number; volume?: number };
    const cs = (b.candles as C[]).map(c => ({ ...c, high: Math.max(c.high, c.open, c.close, c.low), low: Math.min(c.low, c.open, c.close, c.high) })), n = cs.length, vol = cs.some(c => c.volume !== undefined && c.volume > 0);
    const W = 460, top = 10, priceH = 176, gap = vol ? 12 : 0, volH = vol ? 44 : 0, B = 24, H = top + priceH + gap + volH + B, L = 6;
    const scale = axis(Math.min(...cs.map(c => c.low)), Math.max(...cs.map(c => c.high))), lastText = short(cs[n - 1].close, b.unit, ko), R = Math.ceil(Math.max(maxTickWidth(scale, b.unit, ko), tw(lastText, 10.5) + 4)) + 14;
    const bandW = (W - L - R) / n, X = (i: number) => L + (i + 0.5) * bandW, Y = (v: number) => top + ((scale.max - v) / (scale.max - scale.min)) * priceH, bodyW = Math.max(2, Math.min(12, bandW * 0.62));
    const yLast = Y(cs[n - 1].close), grid = scale.ticks.map(t => `<line x1="${L}" x2="${W - R}" y1="${p(Y(t))}" y2="${p(Y(t))}" stroke="${GRID}"/>${Math.abs(Y(t) - yLast) < 13 ? "" : `<text x="${p(W - R + 6)}" y="${p(Y(t) + 3.8)}" class="a-ax">${esc(tick(t, b.unit, ko))}</text>`}`).join("");
    const candles = cs.map((c, i) => {
      const up = c.close >= c.open, color = up ? GREEN : RED, yo = Y(c.open), yc = Y(c.close), x = X(i);
      return `<g><title>${esc(dayText(c.date, ko))} O ${esc(short(c.open, b.unit, ko))} H ${esc(short(c.high, b.unit, ko))} L ${esc(short(c.low, b.unit, ko))} C ${esc(short(c.close, b.unit, ko))}</title><line x1="${p(x)}" x2="${p(x)}" y1="${p(Y(c.high))}" y2="${p(Y(c.low))}" stroke="${color}" stroke-width="1.4"/><rect x="${p(x - bodyW / 2)}" y="${p(Math.min(yo, yc))}" width="${p(bodyW)}" height="${p(Math.max(1.5, Math.abs(yc - yo)))}" rx="1" fill="${color}"/></g>`;
    }).join("");
    const lastUp = cs[n - 1].close >= (n > 1 ? cs[n - 2].close : cs[n - 1].open), tag = lastUp ? GREEN_D : RED, yl = Y(cs[n - 1].close);
    const last = `<line x1="${L}" x2="${W - R}" y1="${p(yl)}" y2="${p(yl)}" stroke="${tag}" stroke-width="1" stroke-dasharray="3 3"/><rect x="${p(W - R + 2)}" y="${p(yl - 9)}" width="${p(R - 4)}" height="18" rx="5" fill="${tag}"/><text x="${p(W - R + R / 2)}" y="${p(yl + 3.8)}" text-anchor="middle" class="a-tg">${esc(lastText)}</text>`;
    let strip = "";
    if (vol) {
      const vy = top + priceH + gap, vmax = Math.max(...cs.map(c => c.volume ?? 0), 1);
      strip = `<line x1="${L}" x2="${W - R}" y1="${vy + volH}" y2="${vy + volH}" stroke="${ZERO}"/>${cs.map((c, i) => (c.volume ? `<rect x="${p(X(i) - bodyW / 2)}" y="${p(vy + volH - (c.volume / vmax) * volH)}" width="${p(bodyW)}" height="${p((c.volume / vmax) * volH)}" rx="1" fill="${c.close >= c.open ? GREEN : RED}" fill-opacity=".5"/>` : "")).join("")}<text x="${p(W - R + 6)}" y="${vy + 10}" class="a-ax">${esc(cmp(vmax))}</text><text x="${p(W - R + 6)}" y="${vy + volH}" class="a-ax">0</text>`;
    }
    const labels = pointLabels(cs.map(c => dayText(c.date, ko)), X, W - R + 8, H - 6);
    return frame(b, svg(W, H, `${grid}${candles}${last}${strip}${labels}`));
  },
  summary: b => { const cs = b.candles as { date: string; open: number; high: number; low: number; close: number }[], f = cs[0], l = cs[cs.length - 1]; return cap(`${b.title ?? "Candlestick chart"}: ${cs.length} candles ${f.date}–${l.date}; opened ${short(f.open, b.unit, false)}, closed ${short(l.close, b.unit, false)} (${pctText(((l.close - f.open) / f.open) * 100)}), range ${short(Math.min(...cs.map(c => c.low)), b.unit, false)}–${short(Math.max(...cs.map(c => c.high)), b.unit, false)}.`); },
  css: css("candlestick_chart", "@ .a-tg{font-size:10.5px;font-weight:750;fill:#fff}"),
});

/* ------------------------------------------------------------- sparkline_rows */
const row = z.object({ label: text(30), sub: optionalText(24), values: list(nullable, 2, 40), value: optionalNum, change: optionalNum, unit: unit.optional(), lowerIsBetter: z.boolean().optional() }).strip();
export const sparklineRows = defineAsset({
  type: "sparkline_rows", category: "chart", width: "half",
  use: "A watchlist-style table: per row a label, a tiny trend line, the latest value and a change chip, for three to ten KPIs or tickers.",
  useKo: "행마다 이름, 작은 추세선, 최신 값, 변화율 칩을 보여 주는 워치리스트형 KPI 표(3~10행)입니다.",
  tags: ["sparkline", "watchlist", "kpi table", "mini chart", "tickers", "스파크라인", "워치리스트", "지표 표", "미니 차트"],
  notes: "rows 3-10, each with label, optional sub, values (2-40 points, oldest first), optional value and change (a percent; computed from the first and last point when left out) and a unit (default: the block's). lowerIsBetter (block or row) flips the colours for churn, cost, errors.",
  fields: { rows: list(row, 3, 10), unit: unit.default("count"), lowerIsBetter: z.boolean().optional(), caption: optionalText(120) },
  sample: {
    title: "Product KPIs, last 12 weeks", unit: "count",
    rows: [
      { label: "Weekly active users", sub: "WAU", values: [38200, 38900, 39400, 39100, 40300, 41200, 41800, 42500, 42100, 43600, 44500, 45200] },
      { label: "Recurring revenue", sub: "MRR", unit: "usd", values: [310000, 318000, 325000, 331000, 329000, 341000, 352000, 360000, 371000, 380000, 392000, 401000] },
      { label: "Trial conversion", sub: "Free to paid", unit: "percent", values: [6.1, 6.4, 6.2, 6.8, 7, 6.9, 7.3, 7.1, 7.6, 7.4, 7.9, 8.2] },
      { label: "Monthly churn", sub: "Logo churn", unit: "percent", lowerIsBetter: true, values: [2.4, 2.5, 2.3, 2.2, 2.3, 2.1, 2, 2.1, 1.9, 1.8, 1.9, 1.7] },
      { label: "Support tickets", sub: "Open per week", lowerIsBetter: true, values: [412, 398, 440, 421, 389, 402, 377, 365, 381, 352, 340, 329] },
      { label: "Net promoter score", sub: "NPS", values: [41, 42, 40, 43, 44, 43, 45, 46, 45, 47, 48, 48] },
    ],
  },
  render(b, { uid, ko }) {
    const cells = (b.rows as { label: string; sub?: string; values: (number | null)[]; value?: number; change?: number; unit?: string; lowerIsBetter?: boolean }[]).map((r, i) => {
      const v = r.values.filter(nn), first = v[0], last = v[v.length - 1], u = r.unit ?? b.unit, now = r.value ?? last, flip = r.lowerIsBetter ?? b.lowerIsBetter;
      const lo = Math.min(...v), hi = Math.max(...v), c = moveColor(first, last, flip), W = 92, H = 28;
      const pts = r.values.map((x, k) => (x === null ? null : [2 + (k * (W - 8)) / Math.max(1, r.values.length - 1), hi === lo ? H / 2 : 3 + ((hi - x) / (hi - lo)) * (H - 6)] as [number, number])).filter((q): q is [number, number] => q !== null);
      const d = pts.map((q, k) => `${k ? "L" : "M"}${p(q[0])},${p(q[1])}`).join(""), end = pts[pts.length - 1];
      const spark = `<svg viewBox="0 0 ${W} ${H}" width="100%" aria-hidden="true"><defs><linearGradient id="${uid}s${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c}" stop-opacity=".2"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></linearGradient></defs><path d="${d}L${p(end[0])},${H}L${p(pts[0][0])},${H}Z" fill="url(#${uid}s${i})"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${p(end[0])}" cy="${p(end[1])}" r="2.6" fill="${c}"/></svg>`;
      const chip = r.change !== undefined ? pctText(r.change) : change(first, last, u), tone = r.change !== undefined ? (r.change === 0 ? "n" : (r.change > 0) !== !!flip ? "g" : "r") : first === last ? "n" : (last > first) !== !!flip ? "g" : "r";
      return `<div class="a-lb"><b title="${esc(r.label)}">${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ""}</div><div class="a-sk">${spark}</div><div class="a-nw">${esc(short(now, u, ko))}</div><div><span class="a-ch a-${tone}">${esc(chip)}</span></div>`;
    }).join("");
    return frame(b, `<div class="a-sp">${cells}</div>`);
  },
  summary: b => cap(`${b.title ?? "Watchlist"}: ${(b.rows as { label: string; values: (number | null)[]; value?: number; unit?: string }[]).map(r => { const v = r.values.filter(nn); return `${r.label} ${short(r.value ?? v[v.length - 1], r.unit ?? b.unit, false)} (${change(v[0], v[v.length - 1], r.unit ?? b.unit)})`; }).join("; ")}.`),
  css: css("sparkline_rows", "@ .a-sp{display:grid;grid-template-columns:minmax(0,1fr) minmax(56px,92px) auto auto}@ .a-sp>div{display:flex;flex-direction:column;justify-content:center;padding:9px 7px;border-top:1px solid #eceeec}@ .a-sp>div:nth-child(4n+1){padding-left:0}@ .a-sp>div:nth-child(4n){padding-right:0}@ .a-sp>div:nth-child(-n+4){border-top:0}@ .a-lb{min-width:0}@ .a-lb b{display:block;font-size:13.5px;font-weight:700;color:#101d24;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@ .a-lb small{display:block;margin-top:1px;font-size:11.5px;font-weight:600;color:#9aa2a7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}@ .a-nw{font-size:14px;font-weight:780;text-align:right;white-space:nowrap}@ .a-ch{display:inline-block;min-width:62px;text-align:center;border-radius:12px;padding:3px 0;font-size:12px;font-weight:750;white-space:nowrap}@ .a-g{background:#e3f1eb;color:#118558}@ .a-r{background:#f8e6e8;color:#cf3545}@ .a-n{background:#eef0ee;color:#4a5860}@ .a-cap{margin:10px 0 0;font-size:13px;line-height:19px;color:#5c6870}", false),
});

export const ASSETS: readonly AnyAsset[] = [candlestickChart, sparklineRows];
