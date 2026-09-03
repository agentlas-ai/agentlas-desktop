// Manuscript document model.
//
// A Science manuscript is stored as Markdown plus an ordered binding list
// (figure / table / citation / supplement / claim → exact artifact version,
// source figure, or citation id). This module turns that Markdown into a
// structured, numbered document that every renderer (HTML preview, LaTeX,
// DOCX, PDF) consumes. Renderers never re-parse Markdown themselves, so the
// numbering of figures, tables, equations, and references is identical across
// outputs — a journal reviewer reading the PDF and an author editing the DOCX
// see the same "Figure 3".
//
// Dialect (a strict, documented subset of GFM plus placeholders):
//   #..#### headings                  paragraphs, `---` rules
//   - / * / 1. lists (nested by 2+ spaces)   > blockquotes     ``` fenced code
//   | GFM tables |                     $$ display math $$ {#eq:label}
//   $inline math$                       **bold** *italic* `code` [text](url)
//   {{figure:<locator> | Caption}}      {{table:<locator> | Caption}}
//   {{cite:<locator>}}  or  [@locator]  or  [@a; @b]
//   {{ref:fig:<locator>}} {{ref:tab:<locator>}} {{ref:eq:<label>}} {{ref:sec:<slug>}}
//   Keywords: a; b; c  (line directly under the Abstract heading block)
//
// Anything outside the dialect is kept as literal text — nothing is silently
// dropped, and every anomaly is reported in `warnings` so the Research Director
// can fix the source instead of shipping a broken paper.

export type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "emphasis"; children: InlineNode[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: InlineNode[] }
  | { kind: "math"; tex: string }
  | { kind: "cite"; locators: string[]; ordinals: number[] }
  | { kind: "ref"; target: "fig" | "tab" | "eq" | "sec"; key: string; number: string | null }
  | { kind: "break" };

export interface ListItem { children: BlockNode[] }

export type BlockNode =
  | { kind: "heading"; level: 1 | 2 | 3 | 4; children: InlineNode[]; slug: string; number: string | null; role: SectionRole }
  | { kind: "paragraph"; children: InlineNode[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "blockquote"; children: BlockNode[] }
  | { kind: "code"; language: string | null; text: string }
  | { kind: "rule" }
  | { kind: "table"; caption: InlineNode[] | null; align: Array<"left" | "center" | "right" | null>; header: InlineNode[][]; rows: InlineNode[][][]; number: number | null; key: string | null }
  | { kind: "math"; tex: string; label: string | null; number: number | null }
  | { kind: "figure"; locator: string; number: number; caption: InlineNode[] }
  | { kind: "bound-table"; locator: string; number: number; caption: InlineNode[] };

export type SectionRole = "abstract" | "introduction" | "related-work" | "methods" | "theory" | "results" | "discussion" | "limitations" | "conclusion" | "references" | "acknowledgements" | "supplement" | "other";

export interface ManuscriptFigureRef { locator: string; number: number; caption: InlineNode[] }
export interface ManuscriptTableRef { locator: string | null; number: number; caption: InlineNode[] | null; bound: boolean; rowCount: number | null }
export interface ManuscriptEquationRef { label: string; number: number }
export interface ManuscriptCitationRef { locator: string; ordinal: number }

export interface ManuscriptWarning { code: string; message: string; line: number | null }

export interface ManuscriptDocument {
  title: string;
  abstract: BlockNode[];
  keywords: string[];
  body: BlockNode[];
  figures: ManuscriptFigureRef[];
  tables: ManuscriptTableRef[];
  equations: ManuscriptEquationRef[];
  citations: ManuscriptCitationRef[];
  headings: Array<{ level: number; text: string; slug: string; number: string | null; role: SectionRole }>;
  wordCount: number;
  warnings: ManuscriptWarning[];
}

export interface ParseManuscriptOptions {
  /** Locators that have a `figure` binding. Unknown figure placeholders become warnings. */
  figureLocators?: Iterable<string>;
  /** Locators that have a `table` binding. */
  tableLocators?: Iterable<string>;
  /** Locators that have a `citation` binding. Unknown citation locators still get numbered but are flagged. */
  citationLocators?: Iterable<string>;
  /** Number headings (1, 1.1, …) — journals differ; default true for LaTeX/DOCX, HTML preview follows the same. */
  numberHeadings?: boolean;
}

const HEADING_RE = /^(#{1,4})\s+(.+?)\s*#*\s*$/;
const RULE_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_RE = /^(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/;
const ORDERED_RE = /^(\s*)(\d{1,3})[.)]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const PLACEHOLDER_BLOCK_RE = /^\{\{\s*(figure|table)\s*:\s*([^|}]+?)\s*(?:\|\s*(.*?))?\s*\}\}\s*$/;
const TABLE_CAPTION_RE = /^(?:Table|표)\s*[:.]\s*(.+?)\s*(?:\{#tab:([A-Za-z0-9_-]+)\})?\s*$/i;
const DISPLAY_MATH_OPEN_RE = /^\$\$\s*(.*)$/;
const EQ_LABEL_RE = /\{#eq:([A-Za-z0-9_-]+)\}\s*$/;
const KEYWORDS_RE = /^(?:keywords|key words|키워드)\s*[:：]\s*(.+)$/i;

const SECTION_ROLE_PATTERNS: Array<[SectionRole, RegExp]> = [
  ["abstract", /^(abstract|summary|초록|요약)$/i],
  ["introduction", /^(introduction|background|서론|배경)$/i],
  ["related-work", /^(related work|prior work|literature review|선행\s*연구|문헌\s*검토)$/i],
  ["methods", /^(methods?|materials and methods|methodology|experimental|연구\s*방법|방법)$/i],
  ["theory", /^(theory|theoretical framework|model|이론|이론적\s*배경|모형)$/i],
  ["results", /^(results?|findings|결과)$/i],
  ["discussion", /^(discussion|results and discussion|논의|고찰)$/i],
  ["limitations", /^(limitations?|threats to validity|한계|연구의\s*한계)$/i],
  ["conclusion", /^(conclusions?|concluding remarks|결론)$/i],
  ["references", /^(references|bibliography|참고문헌|literature cited)$/i],
  ["acknowledgements", /^(acknowledg(e)?ments?|감사의\s*글)$/i],
  ["supplement", /^(supplementary( materials?| information)?|appendix|부록)/i],
];

export function sectionRole(text: string): SectionRole {
  const plain = text.replace(/[*_`]/g, "").trim();
  for (const [role, pattern] of SECTION_ROLE_PATTERNS) if (pattern.test(plain)) return role;
  return "other";
}

export function slugify(text: string): string {
  const slug = text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "");
  return slug || "section";
}

export function inlineToPlainText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text": return node.text;
      case "code": return node.text;
      case "math": return node.tex;
      case "strong":
      case "emphasis":
      case "link": return inlineToPlainText(node.children);
      case "cite": return node.ordinals.length ? `[${node.ordinals.join(", ")}]` : `[${node.locators.join("; ")}]`;
      case "ref": return node.number ?? node.key;
      case "break": return " ";
      default: return "";
    }
  }).join("");
}

interface ParseState {
  figures: Map<string, ManuscriptFigureRef>;
  tables: ManuscriptTableRef[];
  tableKeys: Map<string, number>;
  equations: Map<string, ManuscriptEquationRef>;
  citations: Map<string, ManuscriptCitationRef>;
  headingNumbers: Map<string, string>;
  knownFigures: Set<string>;
  knownTables: Set<string>;
  knownCitations: Set<string>;
  warnings: ManuscriptWarning[];
  pendingRefs: Array<{ node: Extract<InlineNode, { kind: "ref" }> }>;
  numberHeadings: boolean;
  counters: number[];
}

function warn(state: ParseState, code: string, message: string, line: number | null): void {
  state.warnings.push({ code, message, line });
}

/** Parses inline markup. Citations and references are resolved in a second pass so forward references work. */
export function parseInline(source: string, state: ParseState, line: number | null): InlineNode[] {
  const nodes: InlineNode[] = [];
  let text = "";
  const flush = () => { if (text) { nodes.push({ kind: "text", text }); text = ""; } };
  let i = 0;
  const length = source.length;
  while (i < length) {
    const rest = source.slice(i);
    // Placeholders: {{cite:a; b}} {{ref:fig:x}}
    const placeholder = /^\{\{\s*(cite|ref)\s*:\s*([^}]+?)\s*\}\}/.exec(rest);
    if (placeholder) {
      flush();
      if (placeholder[1] === "cite") nodes.push(makeCite(placeholder[2].split(/[;,]/).map((item) => item.trim()).filter(Boolean), state, line));
      else nodes.push(makeRef(placeholder[2], state, line));
      i += placeholder[0].length;
      continue;
    }
    // Pandoc-style citation: [@key] or [@a; @b]
    const pandocCite = /^\[(@[^\]]+)\]/.exec(rest);
    if (pandocCite && /^@/.test(pandocCite[1])) {
      flush();
      nodes.push(makeCite(pandocCite[1].split(/;/).map((item) => item.trim().replace(/^@/, "")).filter(Boolean), state, line));
      i += pandocCite[0].length;
      continue;
    }
    const char = source[i];
    if (char === "\\" && i + 1 < length && "\\`*_{}[]()#+-.!$|".includes(source[i + 1])) { text += source[i + 1]; i += 2; continue; }
    if (char === "`") {
      const close = source.indexOf("`", i + 1);
      if (close > i) { flush(); nodes.push({ kind: "code", text: source.slice(i + 1, close) }); i = close + 1; continue; }
    }
    if (char === "$" && source[i + 1] !== "$") {
      const close = findInlineMathClose(source, i + 1);
      if (close > i + 1) { flush(); nodes.push({ kind: "math", tex: source.slice(i + 1, close).trim() }); i = close + 1; continue; }
    }
    if (rest.startsWith("**") || rest.startsWith("__")) {
      const marker = rest.slice(0, 2);
      const close = source.indexOf(marker, i + 2);
      if (close > i + 2) { flush(); nodes.push({ kind: "strong", children: parseInline(source.slice(i + 2, close), state, line) }); i = close + 2; continue; }
    }
    if ((char === "*" || char === "_") && source[i + 1] !== char && source[i + 1] !== " ") {
      const close = findEmphasisClose(source, i + 1, char);
      if (close > i + 1) { flush(); nodes.push({ kind: "emphasis", children: parseInline(source.slice(i + 1, close), state, line) }); i = close + 1; continue; }
    }
    if (char === "[") {
      const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (link) {
        flush();
        if (/^figure:/.test(link[2])) {
          // Shorthand ![caption](figure:loc) handled in blocks; inline link form is a reference.
          nodes.push(makeRef(`fig:${link[2].slice("figure:".length)}`, state, line));
        } else {
          nodes.push({ kind: "link", href: link[2], children: parseInline(link[1], state, line) });
        }
        i += link[0].length;
        continue;
      }
    }
    if (rest.startsWith("  \n") || rest.startsWith("<br>")) { flush(); nodes.push({ kind: "break" }); i += rest.startsWith("<br>") ? 4 : 3; continue; }
    text += char;
    i += 1;
  }
  flush();
  return nodes;
}

function findInlineMathClose(source: string, from: number): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === "$") return index;
    if (source[index] === "\n") return -1;
  }
  return -1;
}

function findEmphasisClose(source: string, from: number, marker: string): number {
  for (let index = from; index < source.length; index += 1) {
    if (source[index] === "\\") { index += 1; continue; }
    if (source[index] === marker && source[index - 1] !== " " && source[index + 1] !== marker) return index;
  }
  return -1;
}

function makeCite(locators: string[], state: ParseState, line: number | null): InlineNode {
  const ordinals: number[] = [];
  for (const locator of locators) {
    let entry = state.citations.get(locator);
    if (!entry) {
      entry = { locator, ordinal: state.citations.size + 1 };
      state.citations.set(locator, entry);
      if (!state.knownCitations.has(locator)) warn(state, "citation-unbound", `Citation "${locator}" has no citation binding; it will render as an unresolved reference.`, line);
    }
    ordinals.push(entry.ordinal);
  }
  return { kind: "cite", locators, ordinals };
}

function makeRef(raw: string, state: ParseState, line: number | null): InlineNode {
  const match = /^(fig|figure|tab|table|eq|equation|sec|section)\s*:\s*(.+)$/i.exec(raw.trim());
  if (!match) {
    warn(state, "ref-malformed", `Reference "${raw}" must look like fig:<locator>, tab:<locator>, eq:<label>, or sec:<slug>.`, line);
    return { kind: "text", text: `{{ref:${raw}}}` };
  }
  const target = match[1].toLowerCase().startsWith("fig") ? "fig" : match[1].toLowerCase().startsWith("tab") ? "tab" : match[1].toLowerCase().startsWith("eq") ? "eq" : "sec";
  const node: Extract<InlineNode, { kind: "ref" }> = { kind: "ref", target, key: match[2].trim(), number: null };
  state.pendingRefs.push({ node });
  return node;
}

function headingNumber(state: ParseState, level: number): string | null {
  if (!state.numberHeadings || level === 1) return null;
  const depth = level - 2; // ## → depth 0 → "1"
  state.counters.length = Math.max(state.counters.length, depth + 1);
  for (let index = depth + 1; index < state.counters.length; index += 1) state.counters[index] = 0;
  state.counters[depth] = (state.counters[depth] ?? 0) + 1;
  return state.counters.slice(0, depth + 1).map((value) => value || 1).join(".");
}

interface Line { text: string; number: number }

function splitLines(markdown: string): Line[] {
  return markdown.replace(/\r\n?/g, "\n").split("\n").map((text, index) => ({ text, number: index + 1 }));
}

function parseTableRow(row: string): string[] {
  const trimmed = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index];
    if (char === "\\" && trimmed[index + 1] === "|") { cell += "|"; index += 1; continue; }
    if (char === "|") { cells.push(cell.trim()); cell = ""; continue; }
    cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function tableAlignment(separator: string): Array<"left" | "center" | "right" | null> {
  return parseTableRow(separator).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

/** Parses a block sequence. `lines` are consumed until `stop` says otherwise (used for list items and quotes). */
function parseBlocks(lines: Line[], state: ParseState, inQuote = false): BlockNode[] {
  const blocks: BlockNode[] = [];
  let index = 0;
  let pendingTableCaption = null as { caption: InlineNode[]; key: string | null } | null;
  const takeParagraph = (): void => {
    const buffer: Line[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (!line.text.trim() || HEADING_RE.test(line.text) || FENCE_RE.test(line.text) || RULE_RE.test(line.text) || BULLET_RE.test(line.text) || ORDERED_RE.test(line.text)
        || QUOTE_RE.test(line.text) || PLACEHOLDER_BLOCK_RE.test(line.text) || DISPLAY_MATH_OPEN_RE.test(line.text) || (line.text.includes("|") && index + 1 < lines.length && TABLE_SEP_RE.test(lines[index + 1].text))) break;
      buffer.push(line);
      index += 1;
    }
    if (!buffer.length) return;
    const text = buffer.map((line) => line.text.trim()).join("\n");
    const captionMatch = TABLE_CAPTION_RE.exec(text);
    let lookahead = index;
    while (lookahead < lines.length && !lines[lookahead].text.trim()) lookahead += 1;
    if (captionMatch && lookahead + 1 < lines.length && lines[lookahead].text.includes("|") && TABLE_SEP_RE.test(lines[lookahead + 1].text)) {
      pendingTableCaption = { caption: parseInline(captionMatch[1], state, buffer[0].number), key: captionMatch[2] ?? null };
      return;
    }
    blocks.push({ kind: "paragraph", children: parseInline(text.replace(/\n/g, " "), state, buffer[0].number) });
  };

  while (index < lines.length) {
    const line = lines[index];
    const text = line.text;
    if (!text.trim()) { index += 1; continue; }

    const fence = FENCE_RE.exec(text);
    if (fence) {
      const marker = fence[1];
      const language = fence[2] || null;
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].text.trim().startsWith(marker)) { body.push(lines[index].text); index += 1; }
      if (index >= lines.length) warn(state, "code-fence-unclosed", "Fenced code block is not closed.", line.number);
      index += 1;
      blocks.push({ kind: "code", language, text: body.join("\n") });
      continue;
    }

    const heading = HEADING_RE.exec(text);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4;
      const children = parseInline(heading[2], state, line.number);
      const plain = inlineToPlainText(children);
      const role = sectionRole(plain);
      const number = role === "abstract" || role === "references" || role === "acknowledgements" ? null : headingNumber(state, level);
      const slug = slugify(plain);
      if (number) state.headingNumbers.set(slug, number);
      blocks.push({ kind: "heading", level, children, slug, number, role });
      index += 1;
      continue;
    }

    if (RULE_RE.test(text)) { blocks.push({ kind: "rule" }); index += 1; continue; }

    const displayMath = DISPLAY_MATH_OPEN_RE.exec(text);
    if (displayMath) {
      const body: string[] = [];
      let first = displayMath[1];
      let closed = false;
      let label: string | null = null;
      const closeOnFirst = /(.*?)\$\$\s*(\{#eq:[A-Za-z0-9_-]+\})?\s*$/.exec(first);
      if (closeOnFirst && first.includes("$$")) {
        body.push(closeOnFirst[1]);
        label = closeOnFirst[2] ? closeOnFirst[2].slice(5, -1) : null;
        closed = true;
        index += 1;
      } else {
        if (first.trim()) body.push(first);
        index += 1;
        while (index < lines.length) {
          const current = lines[index].text;
          const close = /^(.*?)\$\$\s*(\{#eq:[A-Za-z0-9_-]+\})?\s*$/.exec(current);
          if (close) { if (close[1].trim()) body.push(close[1]); label = close[2] ? close[2].slice(5, -1) : null; closed = true; index += 1; break; }
          body.push(current);
          index += 1;
        }
      }
      if (!closed) warn(state, "math-unclosed", "Display math block ($$) is not closed.", line.number);
      let tex = body.join("\n").trim();
      const trailingLabel = EQ_LABEL_RE.exec(tex);
      if (trailingLabel) { label = trailingLabel[1]; tex = tex.replace(EQ_LABEL_RE, "").trim(); }
      let number: number | null = null;
      if (label) {
        if (state.equations.has(label)) warn(state, "equation-duplicate-label", `Equation label "${label}" is used more than once.`, line.number);
        number = state.equations.size + 1;
        state.equations.set(label, { label, number });
      }
      blocks.push({ kind: "math", tex, label, number });
      continue;
    }

    const placeholder = PLACEHOLDER_BLOCK_RE.exec(text);
    if (placeholder) {
      const locator = placeholder[2].trim();
      const caption = parseInline(placeholder[3] ?? "", state, line.number);
      if (placeholder[1] === "figure") {
        if (state.figures.has(locator)) warn(state, "figure-duplicate", `Figure placeholder "${locator}" appears more than once; only the first occurrence is numbered.`, line.number);
        const existing = state.figures.get(locator);
        const number = existing ? existing.number : state.figures.size + 1;
        if (!existing) state.figures.set(locator, { locator, number, caption });
        if (!state.knownFigures.has(locator)) warn(state, "figure-unbound", `Figure placeholder "${locator}" has no figure binding.`, line.number);
        blocks.push({ kind: "figure", locator, number, caption });
      } else {
        if (!state.knownTables.has(locator)) warn(state, "table-unbound", `Table placeholder "${locator}" has no table binding.`, line.number);
        const number = state.tables.length + 1;
        state.tables.push({ locator, number, caption, bound: true, rowCount: null });
        state.tableKeys.set(locator, number);
        blocks.push({ kind: "bound-table", locator, number, caption });
      }
      index += 1;
      continue;
    }

    const imageShorthand = /^!\[([^\]]*)\]\(figure:([^)\s]+)\)\s*$/.exec(text);
    if (imageShorthand) {
      const locator = imageShorthand[2].trim();
      const caption = parseInline(imageShorthand[1], state, line.number);
      const existing = state.figures.get(locator);
      const number = existing ? existing.number : state.figures.size + 1;
      if (!existing) state.figures.set(locator, { locator, number, caption });
      if (!state.knownFigures.has(locator)) warn(state, "figure-unbound", `Figure placeholder "${locator}" has no figure binding.`, line.number);
      blocks.push({ kind: "figure", locator, number, caption });
      index += 1;
      continue;
    }

    if (text.includes("|") && index + 1 < lines.length && TABLE_SEP_RE.test(lines[index + 1].text)) {
      const header = parseTableRow(text).map((cell) => parseInline(cell, state, line.number));
      const align = tableAlignment(lines[index + 1].text);
      index += 2;
      const rows: InlineNode[][][] = [];
      while (index < lines.length && lines[index].text.includes("|") && lines[index].text.trim()) {
        const cells = parseTableRow(lines[index].text);
        while (cells.length < header.length) cells.push("");
        rows.push(cells.slice(0, header.length).map((cell) => parseInline(cell, state, lines[index].number)));
        index += 1;
      }
      const caption = pendingTableCaption;
      pendingTableCaption = null;
      const number = state.tables.length + 1;
      const key = caption?.key ?? null;
      state.tables.push({ locator: key, number, caption: caption?.caption ?? null, bound: false, rowCount: rows.length });
      if (key) state.tableKeys.set(key, number);
      blocks.push({ kind: "table", caption: caption?.caption ?? null, align, header, rows, number, key });
      continue;
    }

    if (QUOTE_RE.test(text) && !inQuote) {
      const inner: Line[] = [];
      while (index < lines.length && QUOTE_RE.test(lines[index].text)) { inner.push({ text: QUOTE_RE.exec(lines[index].text)![1], number: lines[index].number }); index += 1; }
      blocks.push({ kind: "blockquote", children: parseBlocks(inner, state, true) });
      continue;
    }

    const bullet = BULLET_RE.exec(text);
    const ordered = ORDERED_RE.exec(text);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const baseIndent = (bullet ? bullet[1] : ordered![1]).length;
      const start = ordered ? Number(ordered[2]) : 1;
      const items: ListItem[] = [];
      while (index < lines.length) {
        const current = lines[index].text;
        const itemMatch = isOrdered ? ORDERED_RE.exec(current) : BULLET_RE.exec(current);
        if (!itemMatch || itemMatch[1].length !== baseIndent) break;
        const firstText = isOrdered ? itemMatch[3] : itemMatch[2];
        const itemLines: Line[] = [{ text: firstText, number: lines[index].number }];
        index += 1;
        while (index < lines.length) {
          const continuation = lines[index].text;
          if (!continuation.trim()) {
            // Blank line inside an item is allowed only if the next line is indented deeper.
            if (index + 1 < lines.length && /^\s{2,}\S/.test(lines[index + 1].text) && leadingSpaces(lines[index + 1].text) > baseIndent) { itemLines.push({ text: "", number: lines[index].number }); index += 1; continue; }
            break;
          }
          if (leadingSpaces(continuation) > baseIndent) { itemLines.push({ text: continuation.slice(Math.min(leadingSpaces(continuation), baseIndent + 2)), number: lines[index].number }); index += 1; continue; }
          break;
        }
        items.push({ children: parseBlocks(itemLines, state, inQuote) });
      }
      blocks.push({ kind: "list", ordered: isOrdered, start, items });
      continue;
    }

    takeParagraph();
    if (index < lines.length && lines[index] === line) { // defensive: nothing consumed
      blocks.push({ kind: "paragraph", children: parseInline(text.trim(), state, line.number) });
      index += 1;
    }
  }
  if (pendingTableCaption) {
    blocks.push({ kind: "paragraph", children: pendingTableCaption.caption });
  }
  return blocks;
}

function leadingSpaces(text: string): number { return text.length - text.trimStart().length; }

function countWords(blocks: BlockNode[]): number {
  let count = 0;
  const visitInline = (nodes: InlineNode[]) => { count += (inlineToPlainText(nodes).match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length; };
  const visit = (items: BlockNode[]) => {
    for (const block of items) {
      switch (block.kind) {
        case "heading": case "paragraph": visitInline(block.children); break;
        case "list": for (const item of block.items) visit(item.children); break;
        case "blockquote": visit(block.children); break;
        case "table": for (const row of [block.header, ...block.rows]) for (const cell of row) visitInline(cell); break;
        case "figure": case "bound-table": visitInline(block.caption); break;
        default: break;
      }
    }
  };
  visit(blocks);
  return count;
}

export function parseManuscript(markdown: string, options: ParseManuscriptOptions = {}): ManuscriptDocument {
  const state: ParseState = {
    figures: new Map(), tables: [], tableKeys: new Map(), equations: new Map(), citations: new Map(), headingNumbers: new Map(),
    knownFigures: new Set(options.figureLocators ?? []), knownTables: new Set(options.tableLocators ?? []), knownCitations: new Set(options.citationLocators ?? []),
    warnings: [], pendingRefs: [], numberHeadings: options.numberHeadings !== false, counters: [],
  };
  const lines = splitLines(markdown);
  const blocks = parseBlocks(lines, state);

  // Split off title (first level-1 heading), abstract section, and keywords line.
  let title = "";
  const body: BlockNode[] = [];
  const abstract: BlockNode[] = [];
  const keywords: string[] = [];
  let mode: "body" | "abstract" = "body";
  for (const block of blocks) {
    // A manuscript may start directly with `# Abstract` because the durable
    // record already carries its title. Never promote a recognised section
    // heading to the document title; doing so would emit `\title{Abstract}`
    // and drop the abstract environment from the LaTeX submission.
    if (block.kind === "heading" && block.level === 1 && block.role === "other" && !title && !body.length && !abstract.length) { title = inlineToPlainText(block.children); continue; }
    if (block.kind === "heading" && block.role === "abstract") { mode = "abstract"; continue; }
    if (block.kind === "heading" && mode === "abstract") mode = "body";
    if (mode === "abstract") {
      if (block.kind === "paragraph") {
        const plain = inlineToPlainText(block.children);
        const keywordMatch = KEYWORDS_RE.exec(plain);
        if (keywordMatch) { keywords.push(...keywordMatch[1].split(/[;,、]/).map((item) => item.trim()).filter(Boolean)); continue; }
      }
      abstract.push(block);
      continue;
    }
    body.push(block);
  }
  // Resolve references now that every figure/table/equation/heading number is known.
  for (const { node } of state.pendingRefs) {
    if (node.target === "fig") {
      const figure = state.figures.get(node.key);
      if (figure) node.number = String(figure.number);
      else warn(state, "ref-unresolved", `Figure reference "${node.key}" does not match any figure placeholder.`, null);
    } else if (node.target === "tab") {
      const number = state.tableKeys.get(node.key);
      if (number) node.number = String(number);
      else warn(state, "ref-unresolved", `Table reference "${node.key}" does not match any table placeholder or {#tab:} label.`, null);
    } else if (node.target === "eq") {
      const equation = state.equations.get(node.key);
      if (equation) node.number = String(equation.number);
      else warn(state, "ref-unresolved", `Equation reference "${node.key}" does not match any {#eq:} label.`, null);
    } else {
      const number = state.headingNumbers.get(node.key);
      if (number) node.number = number;
      else warn(state, "ref-unresolved", `Section reference "${node.key}" does not match any numbered heading slug.`, null);
    }
  }
  for (const locator of state.knownFigures) if (!state.figures.has(locator)) warn(state, "figure-binding-unplaced", `Figure binding "${locator}" is never placed in the text; add {{figure:${locator} | caption}}.`, null);
  for (const locator of state.knownTables) if (!state.tableKeys.has(locator)) warn(state, "table-binding-unplaced", `Table binding "${locator}" is never placed in the text; add {{table:${locator} | caption}}.`, null);
  for (const locator of state.knownCitations) if (!state.citations.has(locator)) warn(state, "citation-binding-uncited", `Citation binding "${locator}" is never cited in the text.`, null);

  const headings = [...abstract, ...body].filter((block): block is Extract<BlockNode, { kind: "heading" }> => block.kind === "heading")
    .map((block) => ({ level: block.level, text: inlineToPlainText(block.children), slug: block.slug, number: block.number, role: block.role }));
  return {
    title,
    abstract,
    keywords,
    body,
    figures: [...state.figures.values()].sort((left, right) => left.number - right.number),
    tables: state.tables,
    equations: [...state.equations.values()],
    citations: [...state.citations.values()].sort((left, right) => left.ordinal - right.ordinal),
    headings,
    wordCount: countWords([...abstract, ...body]),
    warnings: state.warnings,
  };
}
