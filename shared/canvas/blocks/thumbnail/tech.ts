import { list, loose, optionalText, text } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { INK, INK2, KINDS, MUTED, badgeOf, circle, docIcon, extOf, fileFields, fit, kindOf, nullable, optList, plural, rawLine, rect, shadow, shadowDefs, tile, tileCss, tw, txt, wholeNum, wrap } from "./_shared";
import { MONO, clipTokens, monoChars, monoLine, tokenize, type Theme, type Tok } from "./_code";

/** The technical files: an archive, source code, a Markdown note and a data file (CSV or JSON), each drawn from the lines the block supplies. */

// ---- archive_file -----------------------------------------------------------------------------------------------------------------------
export const archiveFile = defineAsset({
  type: "archive_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A zip or other archive as a preview tile: a zipper beside the names of a few files inside it and a +N more line.",
  useKo: "zip 등 압축 파일을 미리보기 타일로 보여줍니다: 지퍼 그림과 안에 든 파일 몇 개의 이름, 나머지 개수.",
  tags: ["zip", "archive", "compressed", "tar", "rar", "bundle", "압축", "압축 파일", "아카이브", "썸네일"],
  notes: "items are 3-5 names of files inside (with extensions, so each gets its colour); files is the total number inside (the +N more line is the rest); size is the archive's size.",
  fields: { ...fileFields, files: wholeNum, items: list(text(44), 1, 5) },
  sample: { name: "Brand-assets-2026.zip", files: 64, size: "142 MB", modified: "Oct 18", items: ["logo-primary.svg", "brand-guidelines.pdf", "photography/hero-01.jpg", "colour-palette.xlsx", "launch-film-final.mp4"] },
  render(b, { ko, uid }) {
    const tape = "#e6d3a3", teeth = "#8f5f12", more = b.files !== undefined ? b.files - b.items.length : 0;
    let s = `<defs>${shadowDefs(uid)}</defs>${rect(21, -4, 17, 210, tape)}${rect(42, -4, 17, 210, tape)}`;
    for (let i = 0, y = 40; y < 200; i++, y += 7.6) s += rect(i % 2 ? 40 : 31, y, 10, 4.6, teeth, { rx: 1.3 }) + rect(i % 2 ? 41 : 32, y + 0.8, 4, 1.2, "#d8a24a", { rx: 0.6 });
    s += rect(29, 10, 22, 26, "#c8901c", { rx: 6 }) + rect(33, 14, 14, 8, "#e8b24a", { rx: 3 }) + rect(34, 32, 12, 24, "#3a2d12", { rx: 5.5 }) + circle(40, 44, 3, "#e6d3a3");
    s += rect(74, 14, 312, 168, "#fff", { rx: 11, filter: shadow(uid) });
    b.items.forEach((name, i) => { const y = 24 + i * 27.5; s += docIcon(90, y + 5, KINDS[kindOf(name)].color) + txt(112, y + 15, fit(name, 11.5, 262), 11.5, { w: 650 }) + (i < b.items.length - 1 || more > 0 ? rect(90, y + 25.5, 280, 0.8, "#edf0ee") : ""); });
    if (more > 0) s += txt(112, 24 + b.items.length * 27.5 + 15, `+${more.toLocaleString(ko ? "ko-KR" : "en-US")}${ko ? "개 더" : " more"}`, 11, { fill: KINDS.archive.color, w: 800 });
    return tile({ label: badgeOf(b.name, "archive"), name: b.name, meta: [b.files ? plural(b.files, "file", "files", "개 파일", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `Archive ${b.name}${b.files ? `, ${b.files} files` : ""}${b.size ? `, ${b.size}` : ""}. Contains ${b.items.join(", ")}${b.files && b.files > b.items.length ? ` and ${b.files - b.items.length} more` : ""}.`,
  css: tileCss("archive_file", KINDS.archive.color),
});

// ---- code_file --------------------------------------------------------------------------------------------------------------------------
const CODE_THEME: Theme = { kw: { fill: "#c792ea" }, str: { fill: "#a5e075" }, num: { fill: "#f5a97f" }, com: { fill: "#6f8697", italic: true }, fn: { fill: "#82aaff" }, ty: { fill: "#ffcb6b" }, pun: { fill: "#8fa3b0" }, key: { fill: "#82aaff" }, id: { fill: "#d7dee3" }, hd: { fill: "#fff", bold: true } };
const LANGS: Record<string, string> = { typescript: "TS", javascript: "JS", python: "PY", ruby: "RB", rust: "RS", go: "GO", golang: "GO", java: "JAVA", kotlin: "KT", swift: "SWIFT", c: "C", cpp: "C++", "c++": "C++", "c#": "C#", csharp: "C#", php: "PHP", shell: "SH", bash: "SH", zsh: "SH", sql: "SQL", css: "CSS", html: "HTML", json: "JSON", yaml: "YAML", lua: "LUA", tsx: "TSX", jsx: "JSX" };
export const langLabel = (language: string | undefined, name: string) => LANGS[(language ?? "").toLowerCase()] ?? (extOf(name).length <= 4 && extOf(name) ? extOf(name).toUpperCase() : (language ?? "CODE").slice(0, 4).toUpperCase());

export const codeFile = defineAsset({
  type: "code_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A source file as a preview tile: syntax-coloured lines with line numbers on a dark editor.",
  useKo: "소스 코드 파일을 미리보기 타일로 보여줍니다: 줄 번호가 붙은 구문 색 코드가 어두운 편집기에 표시됩니다.",
  tags: ["code", "source", "script", "typescript", "python", "programming", "코드", "소스", "스크립트", "썸네일"],
  notes: "lines are the first 1-10 lines as written (indentation kept, about 55 characters visible); language is one word (TypeScript, Python, Go...); start is the first line number; total the file's length.",
  fields: { ...fileFields, language: optionalText(16), start: wholeNum, total: wholeNum, lines: list(rawLine(120), 1, 10) },
  sample: { name: "server.ts", language: "TypeScript", total: 214, size: "6.8 KB", modified: "2h ago", lines: ["import { createServer } from \"node:http\";", "import { route } from \"./router\";", "", "// Start the API on the configured port", "const port = Number(process.env.PORT ?? 8080);", "", "export async function main() {", "  const server = createServer(route);", "  server.listen(port, () => console.log(`up on :${port}`));", "}"] },
  render(b, { ko }) {
    const size = 9.4, max = monoChars(342, size), first = b.start ?? 1, lang = b.language ?? "";
    let s = rect(0, 0, 400, 195, "#14202a") + rect(0, 0, 400, 21, "#0e1923") + circle(14, 10.5, 3.2, "#ff5f57") + circle(25, 10.5, 3.2, "#febc2e") + circle(36, 10.5, 3.2, "#28c840");
    if (lang) s += txt(388, 13.8, fit(lang, 8.6, 160, true), 8.6, { fill: "#7d93a3", w: 700, anchor: "end" });
    s += rect(0, 21, 30, 180, "#111c26") + rect(0, 21 + 2 * 14.6 + 6.8 - 14.6 / 2 - 0.4, 400, 14.6, "#1c2c3a", { opacity: 0.9 });
    let code = "", nums = "";
    b.lines.forEach((line, i) => { const y = 38 + i * 14.6; nums += txt(24, y, String(first + i), 8.6, { fill: "#4e6272", w: 600, anchor: "end" }); code += monoLine(40, y, clipTokens(tokenize(line, lang), max), CODE_THEME, size); });
    s += `<g style="${MONO}">${nums}${code}</g>`;
    return tile({ label: langLabel(lang, b.name), name: b.name, meta: [lang || undefined, b.total ? plural(b.total, "line", "lines", "줄", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `${b.language ?? "Code"} file ${b.name}${b.total ? `, ${b.total} lines` : ""}${b.size ? `, ${b.size}` : ""}. Starts: ${b.lines.filter(l => l.trim()).slice(0, 2).map(l => l.trim()).join(" ")}`.slice(0, 390),
  css: tileCss("code_file", KINDS.code.color),
});

// ---- markdown_file ----------------------------------------------------------------------------------------------------------------------
export const markdownFile = defineAsset({
  type: "markdown_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A Markdown note as a preview tile, drawn rendered: heading, bullets, an inline code span and a quote.",
  useKo: "마크다운 노트를 미리보기 타일로 보여줍니다: 제목, 글머리표, 인라인 코드, 인용문이 렌더링된 모습.",
  tags: ["markdown", "md", "readme", "notes", "docs", "text", "마크다운", "리드미", "노트", "문서"],
  notes: "heading is the first # heading; bullets up to 4; code one short inline code span (a command); quote one sentence. Everything but the heading is optional.",
  fields: { ...fileFields, heading: text(60), bullets: optList(text(70), 0, 4), code: optionalText(40), quote: optionalText(120) },
  sample: { name: "README.md", size: "3.1 KB", modified: "Today", heading: "Getting started", bullets: ["Install the CLI and sign in", "Create a project from a template", "Deploy with a single command"], code: "npm run deploy --prod", quote: "Ship small, ship often, measure everything." },
  render(b) {
    const ix = 64, iw = 272;
    let s = rect(44, 12, 312, 330, "#fff", { rx: 4, stroke: "#e1e5e2" }), y = 40;
    for (const l of wrap(b.heading, 18.5, iw, 2, true)) { s += txt(ix, y, l, 18.5, { w: 800 }); y += 22; }
    s += rect(ix, y - 9, iw, 1, "#e1e5e2"); y += 16;
    for (const t of b.bullets ?? []) { s += circle(ix + 3.4, y - 4, 2.5, "#8a949b") + txt(ix + 14, y, fit(t, 11.6, iw - 15), 11.6, { fill: INK2, w: 560 }); y += 19; }
    if (b.code && y < 168) { const code = fit(b.code, 10.4, iw - 18), w = [...code].length * 10.4 * 0.6 + 18; s += rect(ix, y - 5, w, 21, "#eef1ef", { rx: 5, stroke: "#dde2df" }) + `<g style="${MONO}">${txt(ix + 9, y + 9.4, code, 10.4, { fill: "#c2255c", w: 600 })}</g>`; y += 34; } else y += 8;
    if (b.quote && y < 172) { const ls = wrap(b.quote, 11, iw - 14, 2); s += rect(ix, y - 10.5, 2.8, ls.length * 14.5 + 2, "#b9c2be", { rx: 1.4 }); ls.forEach((l, i) => { s += txt(ix + 12, y + i * 14.5, l, 11, { fill: MUTED, w: 500, italic: true }); }); }
    return tile({ label: "MD", name: b.name, meta: [b.size, b.modified], svg: s });
  },
  summary: b => `Markdown ${b.name}${b.size ? `, ${b.size}` : ""}. ${b.heading}${b.bullets?.length ? `: ${b.bullets.join("; ")}` : ""}${b.code ? `. Code: ${b.code}` : ""}.`,
  css: tileCss("markdown_file", KINDS.markdown.color),
});

// ---- data_file --------------------------------------------------------------------------------------------------------------------------
const FORMATS = ["csv", "tsv", "json", "jsonl", "yaml", "xml"] as [string, ...string[]];
const format = nullable(loose(FORMATS, { jsonlines: "jsonl", ndjson: "jsonl", yml: "yaml", table: "csv", text: "csv" }, "csv").optional());
const DATA_THEME: Theme = { kw: { fill: "#7048e8" }, str: { fill: "#118558" }, num: { fill: "#c2570a" }, com: { fill: "#9aa2a7", italic: true }, fn: { fill: "#2f5fd6" }, ty: { fill: "#7048e8" }, pun: { fill: "#9aa2a7" }, key: { fill: "#2f5fd6" }, id: { fill: INK }, hd: { fill: "#2438a8", bold: true } };

export const dataFile = defineAsset({
  type: "data_file", category: "thumbnail", width: "third", frame: "thumb",
  use: "A CSV, JSON or other data file as a preview tile: the first lines in monospace (CSV columns aligned, JSON coloured) with the row count.",
  useKo: "CSV·JSON 등 데이터 파일을 미리보기 타일로 보여줍니다: 첫 몇 줄이 고정폭 글꼴로 표시되고(CSV는 열 정렬, JSON은 색 구분) 행 수가 붙습니다.",
  tags: ["csv", "json", "data", "dataset", "yaml", "xml", "export", "데이터", "데이터셋", "csv 파일", "json 파일"],
  notes: "lines are the first 1-9 raw lines (a CSV header first); format is csv, tsv, json, jsonl, yaml or xml; rows is the number of records in the file.",
  fields: { ...fileFields, format, rows: wholeNum, lines: list(rawLine(100), 1, 9) },
  sample: { name: "customers-export.csv", format: "csv", rows: 12480, size: "1.8 MB", modified: "Oct 31", lines: ["id,name,plan,region,mrr", "1042,Northwind,Pro,EU,4200", "1043,Globex Corp,Team,US,1800", "1044,Initech,Team,US,1800", "1045,Umbrella Ltd,Enterprise,APAC,12600", "1046,Stark Industries,Enterprise,US,18900", "1047,Wayne Tech,Pro,US,4200"] },
  render(b, { ko }) {
    const fmt = b.format ?? "csv", size = 10, max = monoChars(326, size), columnar = fmt === "csv" || fmt === "tsv";
    let rows: Tok[][];
    if (columnar) {
      const cells = b.lines.map(l => (fmt === "csv" ? l.split(",") : l.trim().split(/\s{2,}/))), n = Math.max(...cells.map(c => c.length)), widths = Array.from({ length: n }, (_, c) => Math.min(16, Math.max(...cells.map(r => (r[c] ?? "").trim().length))));
      rows = cells.map((row, ri) => row.flatMap((cell, c) => {
        const raw = cell.trim(), v = [...raw].length > 16 ? `${[...raw].slice(0, 15).join("")}…` : raw, last = c >= row.length - 1, k = ri === 0 ? "hd" : /^[−-]?[\d.,]+%?$/.test(v) ? "num" : "id";
        return last ? [{ s: v, k } as Tok] : [{ s: v, k } as Tok, { s: ",", k: "pun" } as Tok, { s: " ".repeat(Math.max(0, widths[c] - [...v].length) + 1), k: "id" } as Tok];
      }));
    } else rows = b.lines.map(l => tokenize(l, fmt === "yaml" ? "yaml" : "json", fmt === "json" || fmt === "jsonl"));
    let s = rect(22, 14, 356, 330, "#fff", { rx: 8, stroke: "#d9dfdb" });
    if (columnar) s += rect(23, 15, 354, 20, "#eceffd");
    let code = ""; rows.forEach((toks, i) => { code += monoLine(36, 30 + i * 16.4, clipTokens(toks, max), DATA_THEME, size); });
    s += `<g style="${MONO}">${code}</g>`;
    if (b.rows) { const label = plural(b.rows, "row", "rows", "행", ko), w = tw(label, 9.5, true) + 16; s += rect(366 - w, 160, w, 20, KINDS.data.color, { rx: 10 }) + txt(366 - w / 2, 173.4, label, 9.5, { fill: "#fff", w: 800, anchor: "middle" }); }
    return tile({ label: fmt.toUpperCase(), name: b.name, meta: [b.rows ? plural(b.rows, "row", "rows", "행", ko) : undefined, b.size, b.modified], svg: s });
  },
  summary: b => `${(b.format ?? "csv").toUpperCase()} data file ${b.name}${b.rows ? `, ${b.rows} rows` : ""}${b.size ? `, ${b.size}` : ""}. First line: ${b.lines[0].trim()}`.slice(0, 390),
  css: tileCss("data_file", KINDS.data.color),
});

export const ASSETS: readonly AnyAsset[] = [archiveFile, codeFile, markdownFile, dataFile];
