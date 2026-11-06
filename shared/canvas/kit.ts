/**
 * What every canvas block is drawn with: escaping, number and date formats, icons, axes and the shared palette. The base blocks (render.ts)
 * and the assets (blocks/) use the same ones, so a card of both reads as one design. Text is escaped here and nowhere else: an asset
 * never writes a string into markup without `esc` or `bold`.
 */
export function korean(value: number) {
  const a = Math.abs(value), sign = value < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(a >= 1e14 ? 0 : 1).replace(/\.0$/, "")}조원`;
  if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString("ko-KR")}억원`;
  if (a >= 1e4) return `${sign}${Math.round(a / 1e4).toLocaleString("ko-KR")}만원`;
  return `${sign}${Math.round(a).toLocaleString("ko-KR")}원`;
}

export const esc = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
// A pair marks bold; a marker left alone (text cut at its length limit) is dropped, never shown.
export const bold = (value: string) => esc(value).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*\*/g, "");
export const CURRENCY: Record<string, string> = { usd: "$", krw: "₩", eur: "€", jpy: "¥", gbp: "£", cny: "¥" };
export function scaled(value: number, symbol: string, digits?: number) {
  const a = Math.abs(value), sign = value < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}${symbol}${(a / 1e12).toFixed(digits ?? 2)}T`;
  if (a >= 1e9) return `${sign}${symbol}${(a / 1e9).toFixed(digits ?? 2)}B`;
  if (a >= 1e6) return `${sign}${symbol}${(a / 1e6).toFixed(digits ?? 1)}M`;
  if (a >= 1e4) return `${sign}${symbol}${Math.round(a).toLocaleString("en-US")}`;
  return `${sign}${symbol}${a.toLocaleString("en-US", { maximumFractionDigits: a < 10 ? 2 : 1, minimumFractionDigits: a < 10 && symbol ? 2 : 0 })}`;
}
/** A number with its unit, in the card's language (Korean amounts in won use 만·억·조). */
export function canvasFormat(value: number, unit: string, ko: boolean): string {
  if (unit === "krw" && ko) return korean(value);
  if (unit in CURRENCY) return scaled(value, CURRENCY[unit]);
  if (unit === "usd_per_share") return `${value < 0 ? "−" : ""}$${Math.abs(value).toFixed(2)}`;
  if (unit === "percent") return `${value < 0 ? "−" : ""}${Math.abs(value).toFixed(Math.abs(value) < 10 ? 1 : 0)}%`;
  if (unit === "x") return `${value.toFixed(1)}×`;
  if (unit === "bp") return `${value >= 0 ? "+" : "−"}${Math.abs(Math.round(value))}bp`;
  return scaled(value, "");
}
export const signed = (value: number, digits = 0) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}%`;
/** A short date ("Oct 1" / "10월 1일"). */
export function canvasDay(iso: string, ko: boolean): string { const d = new Date(`${iso}T00:00:00Z`); return ko ? `${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일` : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }); }
/** Rough rendered width of a label at 12.5px: Hangul and other wide characters take about twice a Latin letter. */
export const labelWidth = (value: string) => [...value].reduce((w, c) => w + (/[\u1100-\u11ff\u3000-\u9fff\uac00-\ud7a3\uff00-\uffef]/.test(c) ? 12.6 : 6.9), 0) + 20;
export const ICONS: Record<string, string> = {
  up: '<path d="M12 19V5M5 12l7-7 7 7"/>', down: '<path d="M12 5v14M19 12l-7 7-7-7"/>', clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  alert: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5M12 18h.01"/>', target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>', check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  doc: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>', news: '<path d="M4 5h13v14H6a2 2 0 0 1-2-2z"/><path d="M17 9h3v8a2 2 0 0 1-2 2"/><path d="M8 9h5M8 13h5"/>', bank: '<path d="M3 10h18L12 4z"/><path d="M5 10v8M9 10v8M15 10v8M19 10v8M3 20h18"/>',
};
export const icon = (name: string, size = 13, stroke = 2.2) => ICONS[name] ? `<svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>` : "";

export function niceAxis(lowValue: number, highValue: number, steps = 3) {
  const span = Math.max(highValue - lowValue, Math.abs(highValue) * 0.01 || 1);
  const rawLo = lowValue - span * 1.8, rawHi = highValue + span * 1.8, raw = (rawHi - rawLo) / steps, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).reduce((best, k) => (Math.abs(k - raw) < Math.abs(best - raw) ? k : best), mag);
  let lo = Math.floor(rawLo / step + 1e-9) * step, hi = lo + steps * step;
  while (hi < highValue + span * 0.4) { lo += step; hi += step; }
  return { lo, hi, step };
}
export const LINE_COLORS = ["#2f5fd6", "#0e9f6e", "#f08a24", "#d6336c"];
export const PALETTE = ["#101d24", "#2f5fd6", "#7aa2ff", "#f08a24", "#38d39f", "#d6336c", "#8a7420", "#5c6870", "#b9c3be", "#0e9f6e", "#a855f7", "#cfd6d2"];

/** A readable axis for [min, max]: about `steps` intervals on 1, 2, 2.5, 5 × 10ⁿ. Includes zero when the data is all on one side and close to it. */
export function niceScale(min: number, max: number, steps = 4): { min: number; max: number; step: number; ticks: number[] } {
  if (!(max > min)) { const pad = Math.abs(max) * 0.1 || 1; min -= pad; max += pad; }
  const raw = (max - min) / steps, mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(k => k >= raw - 1e-12) ?? 10 * mag;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step, ticks: number[] = [];
  for (let v = lo; v <= hi + step / 1e6; v += step) ticks.push(Math.abs(v) < step / 1e6 ? 0 : Number(v.toPrecision(12)));
  return { min: lo, max: hi, step, ticks };
}
/** Shortens a number for an axis or label: 1,200 → 1.2K, 3,400,000 → 3.4M. */
export function compact(value: number): string {
  const a = Math.abs(value), sign = value < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}${+(a / 1e12).toFixed(1)}T`; if (a >= 1e9) return `${sign}${+(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}${+(a / 1e6).toFixed(1)}M`; if (a >= 1e4) return `${sign}${+(a / 1e3).toFixed(0)}K`;
  return `${sign}${a.toLocaleString("en-US", { maximumFractionDigits: a < 10 ? 2 : 1 })}`;
}
/** Cuts a label to `max` characters with an ellipsis (a label in a drawing never runs past its place; the full text stays in the block). */
export function clip(value: string, max: number): string { const chars = [...value]; return chars.length > max ? `${chars.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…` : value; }
