import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, optionalText, text } from "../../fields";

/**
 * What every thumbnail is drawn with. A thumbnail is a 4:3 tile: the top 65% is a miniature of the content drawn as SVG on a 400x195 stage
 * (the model's own fields, never an icon), the bottom strip is HTML (type badge, file name, small meta) sized in cqw so the tile reads at
 * 300px or at 900px. Text inside the stage is placed with the metrics below because SVG text does not wrap or clip on its own.
 */
export const W = 400, H = 195;
export const INK = "#101d24", INK2 = "#34424a", MUTED = "#5c6870", FAINT = "#9aa2a7", LINE = "#e3e6e3", SURFACE = "#f7f8f7";
export const r1 = (n: number) => Math.round(n * 10) / 10;

// ---- kinds: the colour and short label of each file type ---------------------------------------------------------------------------------
export type Kind = "pdf" | "word" | "sheet" | "slides" | "image" | "video" | "audio" | "archive" | "code" | "markdown" | "data" | "folder" | "link" | "file";
export const KIND_LIST = ["pdf", "word", "sheet", "slides", "image", "video", "audio", "archive", "code", "markdown", "data", "folder", "link", "file"] as [Kind, ...Kind[]];
export const KINDS: Record<Kind, { label: string; color: string }> = {
  pdf: { label: "PDF", color: "#d93a2f" }, word: { label: "DOC", color: "#2f5fd6" }, sheet: { label: "XLS", color: "#118558" }, slides: { label: "PPT", color: "#e0701a" },
  image: { label: "IMG", color: "#d6336c" }, video: { label: "VID", color: "#7048e8" }, audio: { label: "AUD", color: "#0f9d8a" }, archive: { label: "ZIP", color: "#a8741a" },
  code: { label: "CODE", color: "#0b7285" }, markdown: { label: "MD", color: "#495057" }, data: { label: "DATA", color: "#3b5bdb" }, folder: { label: "DIR", color: "#d9930d" },
  link: { label: "LINK", color: "#1c7ed6" }, file: { label: "FILE", color: "#6b7780" },
};
const EXT: Record<string, Kind> = {};
const add = (kind: Kind, exts: string) => exts.split(" ").forEach(e => { EXT[e] = kind; });
add("pdf", "pdf"); add("word", "doc docx odt rtf pages"); add("sheet", "xls xlsx xlsm ods numbers"); add("slides", "ppt pptx odp key");
add("image", "png jpg jpeg gif webp heic svg bmp tiff raw psd fig"); add("video", "mp4 mov mkv avi webm m4v"); add("audio", "mp3 wav flac m4a aac ogg aiff");
add("archive", "zip rar 7z tar gz tgz bz2 dmg"); add("code", "ts tsx js jsx mjs py rb go rs java kt swift c h cpp cs php sh sql css html vue lua");
add("markdown", "md markdown mdx"); add("data", "csv tsv json jsonl xml yaml yml toml parquet");
export const extOf = (name: string) => (name.match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase();
/** The kind of a file: a stated kind first, then the extension of its name. */
export const kindOf = (name: string, hint?: string): Kind => (hint && Object.hasOwn(KINDS, hint) ? (hint as Kind) : EXT[extOf(name)] ?? "file");
/** The badge word of a file: its own extension when that is a short one of the kind ("DOCX"), the kind's word otherwise. */
export function badgeOf(name: string, kind: Kind): string { const e = extOf(name); return e && EXT[e] === kind && e.length <= 4 ? e.toUpperCase() : KINDS[kind].label; }
/** A kind written the way models write it ("xlsx", "photo", "presentation") read as one of ours. */
export const kindField = nullable(loose(KIND_LIST, {
  doc: "word", docx: "word", document: "word", text: "word", xls: "sheet", xlsx: "sheet", spreadsheet: "sheet", excel: "sheet", ppt: "slides", pptx: "slides", presentation: "slides", deck: "slides", slide: "slides",
  photo: "image", picture: "image", img: "image", png: "image", jpg: "image", movie: "video", music: "audio", sound: "audio", zip: "archive", compressed: "archive", script: "code", source: "code",
  md: "markdown", csv: "data", json: "data", dataset: "data", dir: "folder", directory: "folder", url: "link", web: "link", other: "file", unknown: "file",
}, "file").optional());

/** A field a model may send as null or "" for "none": read as absent. */
export function nullable<T extends z.ZodTypeAny>(schema: T) { return z.preprocess(v => (v === null || v === "" ? undefined : v), schema); }
/** A bounded optional list (null or missing is no list). */
export const optList = <T extends z.ZodTypeAny>(item: T, min: number, max: number) => nullable(list(item, min, max).optional());
/** The fields every file thumbnail has: the name the strip shows and the two small facts beside it. */
export const fileFields = { name: text(80), size: optionalText(14), modified: optionalText(24) };
// ---- fields -----------------------------------------------------------------------------------------------------------------------------
/** A line of code or data: its indentation and inner spacing kept (the card's `text` collapses them), tabs as two spaces, cut at `max`. A blank line is allowed. */
export const rawLine = (max: number) => z.preprocess(v => (typeof v === "number" ? String(v) : v), z.string().transform(v => { const s = v.replace(/\t/g, "  ").replace(/[\r\n]+/g, " ").replace(/\s+$/, ""); return s.length > max ? `${s.slice(0, max - 1)}…` : s; }));
/** A yes/no read the way models write it (true, "true", "yes", 1); absent stays absent. */
export const flag = z.preprocess(v => (v === null ? undefined : typeof v === "string" ? /^(?:true|yes|y|1|done|on)$/i.test(v.trim()) : v === 1 ? true : v), z.boolean().optional());
/** A whole count read from "14", 14 or "1,204 pages": at least `min`. */
export const wholeNum = z.preprocess(v => (v === null || v === "" ? undefined : typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : v), z.number().finite().transform(n => Math.max(0, Math.round(n))).optional());

// ---- text metrics (SVG text neither wraps nor clips) --------------------------------------------------------------------------------------
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힣＀-￯]/;
const EMOJI = /\p{Extended_Pictographic}/u;
/** Rough rendered width of `s` at `size`: Hangul and Han take a full em, Latin letters about half. Errs a little wide so text never leaves its place. */
export function tw(s: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of s) {
    if (WIDE.test(ch) || EMOJI.test(ch)) w += 1.02;
    else if (ch === " ") w += 0.3;
    else if (/[ijl.,;:'|!`]/.test(ch)) w += 0.31;
    else if (/[frt()[\]{}\-/"I]/.test(ch)) w += 0.4;
    else if (/[mwMW@%]/.test(ch)) w += 0.9;
    else if (/[A-Z0-9#&$]/.test(ch)) w += 0.64;
    else w += 0.55;
  }
  return w * size * (bold ? 1.07 : 1);
}
/** `s` cut with an ellipsis to fit `maxW`. */
export function fit(s: string, size: number, maxW: number, bold = false): string {
  if (tw(s, size, bold) <= maxW) return s;
  const e = tw("…", size, bold); let w = 0, out = "";
  for (const ch of s) { const c = tw(ch, size, bold); if (w + c + e > maxW) break; out += ch; w += c; }
  return `${out.trimEnd()}…`;
}
/** `s` broken into at most `maxLines` lines of at most `maxW`; the last line ends with an ellipsis when text is left over. */
export function wrap(s: string, size: number, maxW: number, maxLines: number, bold = false): string[] {
  const units = s.match(/\s+|[^\sᄀ-ᇿ⺀-鿿가-힣＀-￯]+|[ᄀ-ᇿ⺀-鿿가-힣＀-￯]/g) ?? [];
  const out: string[] = []; let cur = "", i = 0;
  while (i < units.length) {
    const u = units[i];
    if (/^\s+$/.test(u)) { if (cur) cur += " "; i++; continue; }
    if (tw(cur + u, size, bold) <= maxW) { cur += u; i++; continue; }
    if (!cur) { out.push(fit(u, size, maxW, bold)); i++; } else { out.push(cur.trimEnd()); cur = ""; }
    if (out.length === maxLines) {
      const rest = units.slice(i).join("").trim();
      if (rest) out[maxLines - 1] = fit(`${out[maxLines - 1]} ${rest}`, size, maxW, bold);
      return out;
    }
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

// ---- deterministic variation ---------------------------------------------------------------------------------------------------------------
export function hash(s: string): number { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0) ?? 0; h = Math.imul(h, 16777619); } return h >>> 0; }
/** A seeded generator (mulberry32): the same name always draws the same picture. */
export function rng(seed: number): () => number {
  let a = seed >>> 0 || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export const AVATARS = ["#2f5fd6", "#118558", "#e0701a", "#d6336c", "#7048e8", "#0b7285"];
export const avatarColor = (name: string) => AVATARS[hash(name) % AVATARS.length];
/** Up to two letters standing for a name (Latin: first and last word; Korean: the given name). */
export function initials(name: string): string {
  const s = name.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  if (!s) return "?";
  if (WIDE.test(s)) { const c = [...s].filter(ch => !/\s/.test(ch)); return (c.length >= 3 ? c.slice(-2) : c).join(""); }
  const words = s.split(/\s+/).filter(Boolean), first = [...words[0]][0] ?? "?", last = words.length > 1 ? [...words[words.length - 1]][0] : "";
  return `${first}${last}`.toUpperCase();
}

// ---- SVG pieces ------------------------------------------------------------------------------------------------------------------------------
interface TextOpts { fill?: string; w?: number; anchor?: "start" | "middle" | "end"; opacity?: number; ls?: number; italic?: boolean }
export const txt = (x: number, y: number, s: string, size: number, o: TextOpts = {}) =>
  `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}" font-weight="${o.w ?? 600}" fill="${o.fill ?? INK}"${o.anchor && o.anchor !== "start" ? ` text-anchor="${o.anchor}"` : ""}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ""}${o.ls ? ` letter-spacing="${o.ls}"` : ""}${o.italic ? ' font-style="italic"' : ""}>${esc(s)}</text>`;
interface RectOpts { rx?: number; stroke?: string; sw?: number; opacity?: number; filter?: string }
export const rect = (x: number, y: number, w: number, h: number, fill: string, o: RectOpts = {}) =>
  `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}"${o.rx ? ` rx="${o.rx}"` : ""}${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : ""}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ""}${o.filter ? ` filter="url(#${o.filter})"` : ""}/>`;
export const circle = (x: number, y: number, rad: number, fill: string, o: { stroke?: string; sw?: number; opacity?: number } = {}) =>
  `<circle cx="${r1(x)}" cy="${r1(y)}" r="${r1(rad)}" fill="${fill}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.sw ?? 1}"` : ""}${o.opacity !== undefined ? ` opacity="${o.opacity}"` : ""}/>`;
/** A soft drop shadow for paper and cards (an id prefixed with the block's uid). */
export const shadowDefs = (uid: string, dy = 2.5, blur = 3.2, alpha = 0.16) => `<filter id="${uid}-sh" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="${dy}" stdDeviation="${blur}" flood-color="#101d24" flood-opacity="${alpha}"/></filter>`;
export const shadow = (uid: string) => `${uid}-sh`;
/** Placeholder text lines (grey bars) where the block supplied none: the page still reads as a page. */
export function skeleton(x: number, y: number, w: number, n: number, step: number, seed: number, fill = "#d8dedb", h = 4.2): string {
  const rand = rng(seed); let out = "";
  for (let i = 0; i < n; i++) out += rect(x, y + i * step, i === n - 1 ? w * (0.4 + rand() * 0.3) : w * (0.82 + rand() * 0.18), h, fill, { rx: h / 2 });
  return out;
}
/** A tiny document glyph (a folded corner) in a kind's colour: the file marker of the lists in the archive and folder thumbnails. */
export const docIcon = (x: number, y: number, color: string) => `<path d="M${r1(x)} ${r1(y)}h7.5l4 4v10.5H${r1(x)}Z" fill="${color}"/><path d="M${r1(x + 7.5)} ${r1(y)}v4h4" fill="#fff" opacity=".6"/>`;
const GLYPHS: Record<string, string> = {
  pin: '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6 19.8 19.8 0 0 1-3.1-8.7A2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 6L2 7"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.3-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.8c2 .6 3.4 2.3 3.8 5.2"/>',
};
/** A 24-unit line icon drawn at `size`, its top-left corner at (x, y). */
export const glyph = (name: string, x: number, y: number, size: number, color: string, sw = 2.2) => `<g transform="translate(${r1(x)} ${r1(y)}) scale(${r1(size / 24)})" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name] ?? ""}</g>`;
/** A clip path for the stage area a drawing must stay inside. */
export const clipDef = (id: string, x: number, y: number, w: number, h: number, rx = 0) => `<clipPath id="${id}"><rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}"${rx ? ` rx="${rx}"` : ""}/></clipPath>`;

// ---- words and meta ----------------------------------------------------------------------------------------------------------------------------
export const plural = (n: number, one: string, many: string, ko: string, isKo: boolean) => (isKo ? `${n.toLocaleString("ko-KR")}${ko}` : `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`);
export const joinMeta = (parts: (string | undefined | null | false)[]) => parts.filter((p): p is string => !!p).join(" · ");

// ---- the tile ----------------------------------------------------------------------------------------------------------------------------------
export interface TileOptions { label: string; name: string; meta: (string | undefined | null | false)[]; svg: string; align?: string }
/** The tile: the stage (SVG) over the strip (badge, name, meta). Every thumbnail is built by this, so three side by side read as one set. */
export function tile(o: TileOptions): string {
  const meta = joinMeta(o.meta);
  return `<div class="a-t"><div class="a-pv"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="${o.align ?? "xMidYMid slice"}" aria-hidden="true" focusable="false">${o.svg}</svg></div><div class="a-ft"><div class="a-nm"><span class="a-bd">${esc(o.label)}</span><span class="a-fn">${esc(o.name)}</span></div>${meta ? `<div class="a-mt">${esc(meta)}</div>` : ""}</div></div>`;
}
/** The styles every tile shares, scoped to the asset's own class and coloured by its kind (about 850 characters of the 1500 allowed). */
export function tileCss(type: string, color: string, extra = ""): string {
  const p = `.fpc .a-${type}`;
  return `${p}{max-width:380px}${p} .a-t{position:absolute;inset:0;display:grid;grid-template-rows:65% 35%;background:#fff}${p} .a-pv{position:relative;overflow:hidden;background:var(--surface);border-bottom:1px solid var(--line)}${p} .a-pv svg{display:block;width:100%;height:100%}${p} .a-ft{display:flex;flex-direction:column;justify-content:center;gap:1.2cqw;min-width:0;padding:0 4.2cqw}${p} .a-nm{display:flex;align-items:center;gap:2.2cqw;min-width:0}${p} .a-bd{flex:none;padding:.5cqw 1.8cqw;border-radius:1.1cqw;background:${color};color:#fff;font-size:2.7cqw;font-weight:800;letter-spacing:.05em;line-height:1.5}${p} .a-fn,${p} .a-mt{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}${p} .a-fn{font-size:4.5cqw;font-weight:700;line-height:1.3}${p} .a-mt{font-size:3.3cqw;font-weight:600;color:var(--muted);line-height:1.35}${extra}`;
}
