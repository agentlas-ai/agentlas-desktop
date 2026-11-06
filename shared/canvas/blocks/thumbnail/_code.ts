import { esc } from "../../kit";
import { r1 } from "./_shared";

/** A tiny deterministic highlighter for the code and data thumbnails: comments, strings, numbers, keywords, calls and type names. No dependency, no guessing beyond the line. */
export type TokKind = "kw" | "str" | "num" | "com" | "fn" | "ty" | "pun" | "key" | "id" | "hd";
export interface Tok { s: string; k: TokKind }
export interface Look { fill: string; italic?: boolean; bold?: boolean }
export type Theme = Record<TokKind, Look>;

const HASH = new Set(["python", "py", "ruby", "rb", "shell", "bash", "sh", "zsh", "yaml", "yml", "toml", "r", "perl", "dockerfile", "makefile", "ini", "conf"]);
const DASH = new Set(["sql", "lua", "haskell", "hs"]);
const KW = new Set(("const let var function return if else for while do import from export default class new async await try catch finally throw switch case break continue typeof instanceof interface type extends implements public private protected static readonly void enum namespace in of as yield delete "
  + "def lambda pass is not and or None True False self with raise except elif del global assert fn pub use mod impl struct match mut trait where loop go func package defer chan select range null true false undefined this super nil end then begin local "
  + "SELECT FROM WHERE JOIN LEFT INNER ON GROUP BY ORDER LIMIT AS INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE AND OR NOT NULL IN IS HAVING UNION DISTINCT").split(" "));

const pattern = (comment: string) => new RegExp(String.raw`(${comment}|/\*.*?(?:\*/|$))|("(?:[^"\\]|\\.)*(?:"|$)|'(?:[^'\\]|\\.)*(?:'|$)|\x60(?:[^\x60\\]|\\.)*(?:\x60|$))|(\b\d[\d_.]*\b)|([A-Za-z_$][\w$]*)|(\s+)|(.)`, "g");
const RE = { slash: pattern("//.*"), hash: pattern("#.*"), dash: pattern("--.*") };

/** One line as tokens. `keys` marks a string that is followed by a colon (a JSON key). */
export function tokenize(line: string, lang = "", keys = false): Tok[] {
  const l = lang.toLowerCase(), re = HASH.has(l) ? RE.hash : DASH.has(l) ? RE.dash : RE.slash, out: Tok[] = [];
  re.lastIndex = 0;
  for (const m of line.matchAll(re)) {
    const s = m[0];
    if (m[1] !== undefined) out.push({ s, k: "com" });
    else if (m[2] !== undefined) out.push({ s, k: "str" });
    else if (m[3] !== undefined) out.push({ s, k: "num" });
    else if (m[4] !== undefined) out.push({ s, k: KW.has(s) ? "kw" : /^\s*\(/.test(line.slice((m.index ?? 0) + s.length)) ? "fn" : /^[A-Z][A-Za-z0-9]+$/.test(s) ? "ty" : "id" });
    else out.push({ s, k: m[5] !== undefined ? "id" : "pun" });
  }
  if (keys) for (let i = 0; i < out.length; i++) if (out[i].k === "str" && /^\s*:/.test(out.slice(i + 1).map(t => t.s).join(""))) out[i].k = "key";
  return out;
}

/** The tokens cut to `max` characters (an ellipsis closes a cut line). */
export function clipTokens(tokens: Tok[], max: number): Tok[] {
  const out: Tok[] = []; let n = 0;
  for (const t of tokens) {
    const len = [...t.s].length;
    if (n + len <= max) { out.push(t); n += len; continue; }
    const keep = Math.max(0, max - n - 1);
    if (keep > 0) out.push({ s: [...t.s].slice(0, keep).join(""), k: t.k });
    out.push({ s: "…", k: "com" });
    return out;
  }
  return out;
}

/** One monospaced SVG line: a <text> of coloured tspans (spaces become no-break spaces so SVG keeps them). Wrap the lines in a <g> that sets the mono font. */
export function monoLine(x: number, y: number, tokens: Tok[], theme: Theme, size: number): string {
  const spans = tokens.map(t => {
    const look = theme[t.k];
    return `<tspan fill="${look.fill}"${look.italic ? ' font-style="italic"' : ""}${look.bold ? ' font-weight="800"' : ""}>${esc(t.s.replace(/ /g, NBSP))}</tspan>`;
  }).join("");
  return `<text x="${r1(x)}" y="${r1(y)}" font-size="${size}" font-weight="500">${spans}</text>`;
}
const NBSP = String.fromCharCode(160);
export const MONO = "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
/** How many monospaced characters fit `width` at `size` (0.62em each: the widest of the common mono faces). */
export const monoChars = (width: number, size: number) => Math.max(8, Math.floor(width / (size * 0.62)));
