import { loose } from "../../fields";
import { esc } from "../../kit";

/**
 * Helpers for the motion stills of scene.ts, social.ts and data.ts: the colour worlds ("ground"), a stage that places text boxes by
 * percent of a fixed-ratio frame (so cqw type and SVG geometry stay aligned at every width), text-size steps chosen in code from the
 * text's length, a width estimate that clips labels drawn inside SVG, and a small icon set built from SVG primitives.
 */

// ---------- colour worlds ----------
export interface Ground {
  dark: boolean;
  /** three stops of the base gradient, dark corner first */
  bg: [string, string, string];
  fg: string;
  /** the bright accent and a second accent */
  hi: string;
  hi2: string;
  /** light to deep accent gradient for solid shapes (nodes, chips) that carry `on` text */
  grad: [string, string];
  /** text colour on a hi / hi2 fill */
  on: string;
  /** five colours the mesh glows are drawn with */
  mesh: [string, string, string, string, string];
  /** eight bar / marker hues */
  hues: string[];
}
export const GROUNDS: Record<string, Ground> = {
  ink: { dark: true, bg: ["#070b16", "#0f1730", "#1c2a58"], fg: "#f4f7ff", hi: "#5eead4", hi2: "#7aa2ff", grad: ["#5eead4", "#7aa2ff"], on: "#06121a", mesh: ["#2f5fd6", "#7c3aed", "#0ea5a4", "#f08a24", "#d6336c"], hues: ["#5eead4", "#7aa2ff", "#fbbf24", "#f472b6", "#a78bfa", "#86efac", "#fb923c", "#67e8f9"] },
  blue: { dark: true, bg: ["#0b1a66", "#2447c4", "#5f8fff"], fg: "#ffffff", hi: "#ffd84d", hi2: "#bcd4ff", grad: ["#ffe580", "#ffb21f"], on: "#0b1b55", mesh: ["#ff7ab6", "#ffd84d", "#22d3ee", "#7c3aed", "#2f5fd6"], hues: ["#ffd84d", "#8ef0e0", "#ffb3d1", "#c4b5fd", "#ffffff", "#93c5fd", "#fdba74", "#86efac"] },
  green: { dark: true, bg: ["#022c22", "#0a6e4d", "#1fa97a"], fg: "#ffffff", hi: "#d9f99d", hi2: "#6ee7b7", grad: ["#ecfcc2", "#a3e635"], on: "#022c22", mesh: ["#d9f99d", "#14b8a6", "#0ea5e9", "#facc15", "#065f46"], hues: ["#d9f99d", "#6ee7b7", "#fde68a", "#a5f3fc", "#ffffff", "#fdba74", "#f9a8d4", "#bef264"] },
  violet: { dark: true, bg: ["#1a0845", "#5b21d6", "#a06bff"], fg: "#ffffff", hi: "#ffd166", hi2: "#ff8fcf", grad: ["#ffe596", "#ffa94d"], on: "#1a0845", mesh: ["#ff8fcf", "#38bdf8", "#ffd166", "#7c3aed", "#312e81"], hues: ["#ffd166", "#ff8fcf", "#7dd3fc", "#c4b5fd", "#ffffff", "#86efac", "#fdba74", "#f0abfc"] },
  sunset: { dark: true, bg: ["#4d0a3a", "#d8402f", "#ff9a3d"], fg: "#ffffff", hi: "#fff1b8", hi2: "#ff5c93", grad: ["#fff8dc", "#ffd27a"], on: "#4a0a2f", mesh: ["#ffd27a", "#ff5c93", "#7c3aed", "#ff7a1a", "#9d174d"], hues: ["#fff1b8", "#ff5c93", "#ffd27a", "#c4b5fd", "#ffffff", "#7dd3fc", "#fda4af", "#fdba74"] },
  paper: { dark: false, bg: ["#f6f0e4", "#fbf8f1", "#efe8d8"], fg: "#14202a", hi: "#f0551f", hi2: "#2f5fd6", grad: ["#ff8a57", "#e8461a"], on: "#ffffff", mesh: ["#ffb199", "#a5c4ff", "#ffe08a", "#b8f0d4", "#e3c2ff"], hues: ["#f0551f", "#2f5fd6", "#0e9f6e", "#d6336c", "#7c3aed", "#f5a524", "#0891b2", "#475569"] },
};
export const GROUND_NAMES: [string, ...string[]] = ["ink", "blue", "green", "violet", "sunset", "paper"];
/** The `ground` field every asset here carries: a word in any case, a synonym, or anything else falls back to the asset's own default. */
export const groundField = (fallback: string) => loose(GROUND_NAMES, { dark: "ink", black: "ink", night: "ink", navy: "blue", indigo: "blue", teal: "green", emerald: "green", purple: "violet", lavender: "violet", orange: "sunset", warm: "sunset", red: "sunset", pink: "sunset", light: "paper", white: "paper", cream: "paper", beige: "paper" }, fallback).default(fallback);
export const groundOf = (name: unknown, fallback = "ink"): Ground => GROUNDS[String(name)] ?? GROUNDS[fallback];

export const rgba = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
export const bgOf = (g: Ground, angle = 150) => `linear-gradient(${angle}deg,${g.bg[0]},${g.bg[1]} 55%,${g.bg[2]})`;
/** Soft light for the deco SVG: a radial gradient fading to transparent (no filters anywhere). */
export const glowDef = (id: string, color: string, o = 0.9) => `<radialGradient id="${id}"><stop offset="0" stop-color="${color}" stop-opacity="${o}"/><stop offset=".55" stop-color="${color}" stop-opacity="${(o * 0.38).toFixed(3)}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient>`;
export const lineDef = (id: string, a: string, b: string, x2 = 1, y2 = 1) => `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>`;

// ---------- numbers ----------
export const n2 = (v: number) => +v.toFixed(2);
export const hash = (s: string) => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0)!; h = Math.imul(h, 16777619); } return h >>> 0; };
export const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ---------- text measure ----------
const WIDE = /[ᄀ-ᇿ　-鿿가-힣＀-￯]/;
/** Rough width of a string in em (Hangul and CJK about one em, Latin about .56). */
export const em = (s: string, weight = 700) => [...s].reduce((w, c) => w + (WIDE.test(c) ? 1.02 : c === " " ? 0.28 : /[ijl.,:;'!|]/.test(c) ? 0.3 : /[mwMW@]/.test(c) ? 0.92 : /[A-Z0-9]/.test(c) ? 0.66 : 0.55) + (weight >= 700 ? 0.02 : 0), 0);
/** Cuts a label so it is at most `maxW` wide at font size `size` (same unit), ending in an ellipsis. */
export function fitText(s: string, maxW: number, size: number, weight = 700): string {
  if (em(s, weight) * size <= maxW) return s;
  const chars = [...s];
  while (chars.length > 1 && em(chars.join("") + "…", weight) * size > maxW) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}
/** The largest size (<= max) at which `s` fits on one line of width `maxW`, not below `min`. */
export const fitSize = (s: string, maxW: number, max: number, min: number, weight = 700) => clamp(maxW / Math.max(0.5, em(s, weight)), min, max);
/** A type size from the text's length: steps are [up to n weighted characters, size]; Hangul and CJK count 1.8. */
export function sizeFor(s: string, steps: readonly (readonly [number, number])[]): number {
  const len = [...s].reduce((a, c) => a + (WIDE.test(c) ? 1.8 : 1), 0);
  for (const [max, size] of steps) if (len <= max) return size;
  return steps[steps.length - 1][1];
}

// ---------- the stage: text placed by percent of a fixed-ratio frame ----------
export interface BlockOpt { x: number; y: number; w: number; h?: number; bottom?: boolean; mid?: boolean; align?: "center" | "right"; delay?: number; cls?: string }
export interface ParaOpt { size: number; weight?: number; color?: string; lines?: number; lh?: number; ls?: number; op?: number; mt?: number; cls?: string; upper?: boolean }
/** `vw` x `vh` are the frame's own drawing units (160x90, 100x100 ...); every position below is in those units, every type size in cqw. */
export function stage(vw: number, vh: number) {
  const px = (x: number) => n2((x / vw) * 100), py = (y: number) => n2((y / vh) * 100);
  return {
    vw, vh, px, py,
    /** an SVG layer for the whole frame, ids already prefixed by the caller */
    svg: (inner: string, cls = "a-d") => `<svg class="${cls}" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid slice" aria-hidden="true">${inner}</svg>`,
    /** a positioned box of paragraphs; `html` is already escaped */
    block(o: BlockOpt, html: string) {
      const st = [`left:${px(o.x)}%`, o.bottom ? `bottom:${py(vh - o.y)}%` : `top:${py(o.y)}%`, `width:${px(o.w)}%`, o.h !== undefined ? `height:${py(o.h)}%` : "", o.mid ? "display:flex;flex-direction:column;justify-content:center" : "", o.align ? `text-align:${o.align}` : "", o.delay !== undefined ? `animation-delay:${o.delay}s` : ""].filter(Boolean).join(";");
      return `<div class="a-t a-in${o.cls ? ` ${o.cls}` : ""}" style="${st}">${html}</div>`;
    },
  };
}
export function para(html: string, o: ParaOpt): string {
  const st = [`font-size:${n2(o.size)}cqw`, `line-height:${Math.max(1.12, o.lh ?? 1.15)}`, `font-weight:${o.weight ?? 700}`, o.color ? `color:${o.color}` : "", `--n:${o.lines ?? 2}`, o.ls !== undefined ? `letter-spacing:${o.ls}em` : "", o.op !== undefined ? `opacity:${o.op}` : "", o.mt ? `margin-top:${o.mt}cqw` : "", o.upper ? "text-transform:uppercase" : ""].filter(Boolean).join(";");
  return `<div class="a-c${o.lines === 1 ? " a-1" : ""}${o.cls ? ` ${o.cls}` : ""}" style="${st}">${html}</div>`;
}

/**
 * The css every asset here shares, written for one type (the gate holds every selector under `.fpc .a-<type>`): the frame without its
 * border, the SVG layer, positioned text with a line clamp, and the entrance (its `to` is the still itself, so the final state is the still).
 */
export function baseCss(type: string, ...extra: string[]): string {
  const s = `.fpc .a-${type}`;
  return `${s}{border:0}${s} .a-s{position:absolute;inset:0;overflow:hidden}${s} .a-d{position:absolute;inset:0;width:100%;height:100%}${s} .a-t{position:absolute;margin:0}${s} .a-c{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--n,2);overflow:hidden;text-wrap:balance}${s} .a-1{display:block;white-space:nowrap;text-overflow:ellipsis}${s} .a-in{transform-box:fill-box;transform-origin:center;animation:a-${type}-x .8s cubic-bezier(.2,.8,.2,1) both}@keyframes a-${type}-x{from{opacity:0;transform:translateY(8%) scale(.94)}}${extra.join("")}`;
}
/** The frame wrapper every asset here returns inside the shared figure. */
export const scene = (g: Ground, inner: string, angle = 150) => `<div class="a-s" style="background:${bgOf(g, angle)};color:${g.fg}">${inner}</div>`;
/** An entrance delay in seconds, stepped. */
export const dly = (i: number, base = 0.08, step = 0.09) => n2(base + i * step);

// ---------- icons: stroke glyphs on a 24x24 grid, drawn from SVG primitives ----------
export const GLYPHS: Record<string, string> = {
  bolt: '<path d="M13 2.5 5 13.5h6l-1 8 8-11h-6z"/>',
  shield: '<path d="M12 3 5 5.8v5.7c0 4.4 3 7.7 7 9.5 4-1.8 7-5.1 7-9.5V5.8z"/><path d="m8.8 12 2.4 2.4 4.2-4.6"/>',
  chart: '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
  chat: '<path d="M4 5.5h16v10.5h-8.5L7 20v-4H4z"/><path d="M8 10h8M8 13h5"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><ellipse cx="12" cy="12" rx="4" ry="9"/>',
  lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/><path d="M12 15v2"/>',
  heart: '<path d="M12 20S4 15 4 9.5A4.4 4.4 0 0 1 12 7a4.4 4.4 0 0 1 8 2.5C20 15 12 20 12 20z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  cloud: '<path d="M7 18.5a4.2 4.2 0 0 1-.6-8.3 5.6 5.6 0 0 1 10.8 1.2A3.6 3.6 0 0 1 17 18.5z"/>',
  mail: '<rect x="3" y="5.5" width="18" height="13" rx="2.4"/><path d="m3.5 8 8.5 6 8.5-6"/>',
  bell: '<path d="M6 16.5v-5a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.3-6.2 7.5-6.2s7.5 2.2 7.5 6.2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.2l3.2 2"/>',
  bulb: '<path d="M9.5 18h5M10.2 21h3.6"/><path d="M12 3a6 6 0 0 0-3.6 10.8c.7.5 1.1 1.3 1.1 2.2h5c0-.9.4-1.7 1.1-2.2A6 6 0 0 0 12 3z"/>',
  rocket: '<path d="M12 3c3 2 5 5.5 5 9.3L15 15H9l-2-2.7C7 8.5 9 5 12 3z"/><circle cx="12" cy="10" r="1.7"/><path d="m7.2 13-3 3 3.3.7M16.8 13l3 3-3.3.7M10 18l2 3 2-3"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.8L16.2 9.5"/>',
  code: '<path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5M13.4 5.5l-2.8 13"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5.5 5.5"/>',
  leaf: '<path d="M5 19C5 10.5 10 5 19.5 5 19.5 14 14 19 5 19z"/><path d="M5 19 13 11"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.3"/>',
};
export const GLYPH_NAMES = Object.keys(GLYPHS) as [string, ...string[]];
export const GLYPH_SYNONYMS: Record<string, string> = { lightning: "bolt", flash: "bolt", speed: "bolt", fast: "bolt", power: "bolt", security: "shield", safe: "shield", privacy: "shield", protect: "shield", analytics: "chart", graph: "chart", growth: "chart", stats: "chart", message: "chat", comment: "chat", support: "chat", talk: "chat", world: "globe", web: "globe", global: "globe", language: "globe", secure: "lock", password: "lock", like: "heart", love: "heart", health: "heart", favorite: "star", quality: "star", rating: "star", storage: "cloud", sync: "cloud", email: "mail", inbox: "mail", alert: "bell", notification: "bell", people: "user", team: "user", person: "user", account: "user", time: "clock", schedule: "clock", idea: "bulb", insight: "bulb", launch: "rocket", ship: "rocket", done: "check", ok: "check", api: "code", dev: "code", developer: "code", find: "search", discover: "search", eco: "leaf", green: "leaf", goal: "target", focus: "target", aim: "target" };
export const glyphField = (fallback = "star") => loose(GLYPH_NAMES, GLYPH_SYNONYMS, fallback);
/** A glyph drawn at (cx, cy) with the given size (the glyph's 24-unit box scaled to `size`), stroked in `color`. */
export const glyphAt = (name: string, cx: number, cy: number, size: number, color: string, sw = 2) =>
  `<g transform="translate(${n2(cx - size / 2)} ${n2(cy - size / 2)}) scale(${n2(size / 24)})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name] ?? GLYPHS.star}</g>`;

export { esc };
