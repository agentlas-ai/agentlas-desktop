import { z } from "zod";
import { canvasDay, clip, esc } from "../../kit";

/**
 * What every table asset shares, so a card of them reads as one design: the semantic colours as "r,g,b" (a chip, dot or bar sets one inline
 * custom property `--c` and the css reads `rgb(var(--c))`), the marks (tick, cross, partial, Harvey ball), readers for the words models write,
 * and `css`, which scopes and minifies a stylesheet (an asset's css is limited to 1500 characters, so its rules are written short).
 * Nothing from a block reaches a style attribute except through these tables and computed numbers.
 */
export const RGB = { g: "17,133,88", r: "207,53,69", a: "183,121,31", b: "47,95,214", n: "90,104,112" } as const;
export type Hue = keyof typeof RGB;
export const hue = (h: Hue) => `style="--c:${RGB[h]}"`;
/** A small pill in a semantic colour; `raw` is escaped here. */
export const chip = (raw: string, h: Hue, extra = "") => `<span class="a-c${extra ? ` ${extra}` : ""}" ${hue(h)}>${esc(raw)}</span>`;
/** The chip every asset that has one shares (the colour comes from --c). */
export const CHIP = "& .a-c{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:middle;height:22px;padding:0 9px;border-radius:11px;font-size:12px;line-height:22px;font-weight:700;background:rgba(var(--c),.12);color:rgb(var(--c))}";

/** Scopes an asset's stylesheet (`&` is `.fpc .a-<type>`) and minifies it; keyframes and the gate's selector rule are held by writing every selector with `&`. */
export function css(type: string, ...parts: string[]): string {
  return parts.join("").replace(/\/\*[\s\S]*?\*\//g, "").replace(/&/g, `.fpc .a-${type}`).replace(/\s+/g, " ").replace(/ ?([{};,]) ?/g, "$1").replace(/;}/g, "}").trim();
}

/** A true/false written the way models write it: true, "yes", 1. Absent is false. */
export const flag = z.preprocess(v => v === true || v === 1 || (typeof v === "string" && /^(true|yes|y|1|on)$/i.test(v.trim())), z.boolean());
/** A switch that is on unless it is said to be off. */
export const on = z.preprocess(v => !(v === false || v === 0 || (typeof v === "string" && /^(false|no|n|0|off)$/i.test(v.trim()))), z.boolean());
/** A table cell: text cut to `max`, empty allowed (shown as a dash), true/false read as yes/no, a number as its digits. */
export const cell = (max: number) => z.preprocess(v => (v === true ? "yes" : v === false ? "no" : v === null || v === undefined ? "" : typeof v === "number" ? String(v) : v), z.string().transform(v => clip(v.replace(/\s+/g, " ").trim(), max)));
/** A list of cells that may be shorter or longer than the columns; the first `max` are kept. */
export const cells = (max: number, count: number) => z.preprocess(v => (v === null || v === undefined ? [] : Array.isArray(v) ? v.slice(0, count) : v), z.array(cell(max)));

export type Mark = "yes" | "no" | "half" | "dash" | "text";
/** What a cell says: a tick, a cross, "partly", a dash (nothing to say) or plain text. */
export function markOf(raw: string): Mark {
  const v = raw.trim().toLowerCase();
  if (/^(yes|y|true|✓|✔|✅|tick|checked?|included|supported|available|ok|on|예|있음|지원|포함|가능)$/.test(v)) return "yes";
  if (/^(no|n|false|✗|✘|✕|×|❌|cross|not included|unsupported|unavailable|off|아니오|없음|미지원|불가)$/.test(v)) return "no";
  if (/^(partial(?:ly)?|limited|half|~|◐|◑|beta|some|add-?on|부분|일부|제한)$/.test(v)) return "half";
  if (v === "" || /^[-–—]+$/.test(v) || v === "n/a" || v === "na") return "dash";
  return "text";
}
const svg = (inner: string, label: string, size = 18) => `<svg class="a-m" style="display:inline-block;vertical-align:middle;flex:none" width="${size}" height="${size}" viewBox="0 0 20 20" role="img" aria-label="${esc(label)}">${inner}</svg>`;
/** A tick, cross, half or dash drawn as a 18px mark; `label` is read by a screen reader. */
export function mark(kind: Exclude<Mark, "text">, label: string): string {
  if (kind === "yes") return svg('<circle cx="10" cy="10" r="10" fill="#e3f1eb"/><path d="M5.7 10.4l3 3 5.6-6.2" fill="none" stroke="#118558" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>', label);
  if (kind === "no") return svg('<circle cx="10" cy="10" r="10" fill="#eef0ee"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" fill="none" stroke="#8a959b" stroke-width="2" stroke-linecap="round"/>', label);
  if (kind === "half") return svg('<circle cx="10" cy="10" r="10" fill="#fbf1de"/><circle cx="10" cy="10" r="5.2" fill="none" stroke="#b7791f" stroke-width="1.8"/><path d="M10 4.8a5.2 5.2 0 0 0 0 10.4z" fill="#b7791f"/>', label);
  return svg('<path d="M6.5 10h7" fill="none" stroke="#c9d0cc" stroke-width="2" stroke-linecap="round"/>', label);
}
/** A Harvey ball: level 0 (empty) to 4 (full) in `color`. */
export function ball(level: number, label: string, color = "#2f5fd6", size = 20): string {
  const r = 7.5, pies = ["", "M10 10V2.5A7.5 7.5 0 0 1 17.5 10z", "M10 10V2.5A7.5 7.5 0 0 1 10 17.5z", "M10 10V2.5A7.5 7.5 0 1 1 2.5 10z"];
  const fill = level >= 4 ? `<circle cx="10" cy="10" r="${r}" fill="${color}"/>` : pies[level] ? `<path d="${pies[level]}" fill="${color}"/>` : "";
  return svg(`<circle cx="10" cy="10" r="${r}" fill="#fff" stroke="${color}" stroke-width="1.6"/>${fill}`, label, size);
}

/** FNV-1a of a string: the same name always gets the same colour. */
export const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); } return h >>> 0; };
const WIDE = /[ᄀ-ᇿ　-鿿가-힣＀-￯]/;
/** Initials for an avatar: two letters of a Latin name, the family-name character of a Korean or Chinese one. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (WIDE.test(words[0])) return [...words[0]][0];
  return (words.length > 1 ? [...words[0]][0] + [...words[words.length - 1]][0] : [...words[0]].slice(0, 2).join("")).toUpperCase();
}

/** A YYYY-MM-DD day as "Mon D, YYYY" / "YYYY년 M월 D일"; any other text is returned as written. */
export function longDay(value: string, ko: boolean): string {
  const d = /^\d{4}-\d{2}-\d{2}/.test(value) ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : null;
  if (!d || Number.isNaN(d.getTime())) return value;
  return ko ? `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일` : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
/** A YYYY-MM-DD day as "Mon D" / "M월 D일"; any other text is returned as written. */
export const shortDay = (value: string, ko: boolean) => (/^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(`${value.slice(0, 10)}T00:00:00Z`)) ? canvasDay(value.slice(0, 10), ko) : value);

/** A summary: plain text, whitespace collapsed, no markup characters, at most 400 characters. */
export const fit = (value: string, max = 400) => { const s = value.replace(/[<>]/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim(); return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s; };
/** The line under a table: one optional takeaway (inline, so no asset spends its css budget on it). */
export const cap = (raw?: string) => (raw ? `<p class="a-cap" style="margin:12px 0 0;font-size:13px;line-height:19px;color:var(--muted)">${esc(raw)}</p>` : "");
export const pct = (n: number, digits = 0) => `${n.toFixed(digits)}%`;
export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
